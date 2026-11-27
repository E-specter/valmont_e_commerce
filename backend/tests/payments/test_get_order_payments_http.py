"""`GET /api/v1/payments/orders/{order_id}/attempts` con la app real contra PostgreSQL (T-095;
CA-PAYMENTS-08 parte GET, 09, 11 y 16; SPEC §3 UC-02, §4 R8, R9, R15, §7 "Listar", D-043).
Todo en la transacción de la fixture `shop` (SAVEPOINT por solicitud, como en T-094). Cubre: la
forma exacta de la salida, `can_pay` y `attempts_left` en cada estado, el orden de los intentos, el
aislamiento entre clientes (P-6: ni el administrador ve pedidos ajenos), `Cache-Control: no-store`,
el vencimiento perezoso y que `card_last4` no llega a los logs. Datos ficticios."""

import logging
import re
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest

from tests.identity.identity_helpers import make_token
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import OrderShop, audit_rows, parse_utc
from tests.orders.orders_read_helpers import ALL_STATUSES, db_now, make_overdue, set_status
from tests.payments.get_order_payments_helpers import OUT_KEYS, get_attempts
from tests.payments.pay_order_helpers import (
    ATTEMPT_KEYS,
    DECLINED,
    EXPIRED_CARD,
    NO_FUNDS,
    another_order,
    any_audit_since,
    attempt_rows,
    pay,
    placed_order,
    reservation_states,
    rolling_back_shop,
    status_of,
)
from tests.payments.payments_db_helpers import insert_attempt_row, new_key, rejected_row
from valmont.modules.identity.domain import Role

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop

LAST4 = "7391"
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
MISSING = UUID(int=0xBEEF)


def ok(response: Any) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    return response.json()


def reject_n(shop: OrderShop, p: Any, count: int, last4: str = DECLINED) -> None:
    for _ in range(count):
        assert pay(shop, p.user, p.order_id, last4).status_code == 201


# --------------------------------------------------------------------------------------------
# Autenticación y entradas


def test_without_a_token_it_is_401_in_the_common_error_format(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = get_attempts(shop, None, p.order_id)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_an_invalid_token_is_401(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = get_attempts(
        shop, None, p.order_id, headers={"Authorization": "Bearer no-es-un-token"}
    )

    assert response.status_code == 401


def test_a_malformed_order_id_is_422(shop: OrderShop) -> None:
    user = shop.user()

    response = get_attempts(shop, user, "no-es-un-uuid")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_the_only_other_verbs_are_not_a_way_to_read_or_change_attempts(
    shop: OrderShop, method: str
) -> None:
    # POST existe (pagar) y exige cuerpo y cabecera; el resto no existe: nada modifica un intento.
    p = placed_order(shop)

    response = getattr(shop.client, method)(
        f"/api/v1/payments/orders/{p.order_id}/attempts",
        headers={"Authorization": f"Bearer {make_token(str(p.user))}"},
    )

    assert response.status_code in (405, 422)
    assert attempt_rows(shop.session, p.order_id) == []


# --------------------------------------------------------------------------------------------
# Forma de la salida (SPEC §7, R15, D-043)


def test_a_pending_order_without_attempts_is_200_with_an_empty_list_and_all_attempts_left(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)

    response = get_attempts(shop, p.user, p.order_id)

    assert ok(response) == {
        "order_id": str(p.order_id),
        "can_pay": True,
        "attempts_left": 5,
        "attempts": [],
    }
    assert set(response.json()) == OUT_KEYS


def test_the_attempt_has_exactly_the_contract_fields_with_money_and_last4(shop: OrderShop) -> None:
    p = placed_order(shop, price=250_000)
    created = pay(shop, p.user, p.order_id, EXPIRED_CARD)
    assert created.status_code == 201

    body = ok(get_attempts(shop, p.user, p.order_id))

    [attempt] = body["attempts"]
    assert set(attempt) == ATTEMPT_KEYS
    assert attempt["amount"] == {"amount": p.total, "currency": "PEN"}
    assert isinstance(attempt["amount"]["amount"], int)
    assert attempt["card_last4"] == EXPIRED_CARD and attempt["order_id"] == str(p.order_id)
    assert (attempt["status"], attempt["failure_code"]) == ("rejected", "expired_card")
    assert attempt == created.json()  # el GET devuelve el mismo intento que el POST
    assert parse_utc(attempt["created_at"]).utcoffset() == timedelta(0)


def test_an_approved_attempt_is_listed_and_the_order_can_no_longer_be_paid(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    approved = pay(shop, p.user, p.order_id, "4242").json()

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["can_pay"] is False and body["attempts_left"] == 5
    [attempt] = body["attempts"]
    assert (attempt["id"], attempt["status"], attempt["failure_code"]) == (
        approved["id"],
        "approved",
        None,
    )
    assert attempt["card_last4"] == "4242"


def test_the_response_never_exposes_gateway_user_key_or_full_card_data(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()
    pay(shop, p.user, p.order_id, DECLINED, key=key)
    pay(shop, p.user, p.order_id, "4242")

    response = get_attempts(shop, p.user, p.order_id)

    text = response.text
    for internal in ("user_id", "gateway", "simulated", "idempotency", key, str(p.user)):
        assert internal not in text, internal
    assert not re.search(r"\d{13,19}", UUID_RE.sub("", text))  # ningún número de tarjeta
    for item in response.json()["attempts"]:
        assert not set(item) & {"user_id", "gateway", "idempotency_key", "cvv", "card_number"}


def test_the_attempts_of_another_order_of_the_same_customer_are_not_mixed(shop: OrderShop) -> None:
    p = placed_order(shop)
    second = another_order(shop, p.user)
    pay(shop, p.user, p.order_id, DECLINED)
    pay(shop, p.user, second, NO_FUNDS)
    pay(shop, p.user, second, NO_FUNDS)

    first_view, second_view = (ok(get_attempts(shop, p.user, o)) for o in (p.order_id, second))

    assert [a["order_id"] for a in first_view["attempts"]] == [str(p.order_id)]
    assert {a["order_id"] for a in second_view["attempts"]} == {str(second)}
    assert (first_view["attempts_left"], second_view["attempts_left"]) == (4, 3)


def test_reading_changes_nothing_and_is_repeatable(shop: OrderShop) -> None:
    p = placed_order(shop)
    pay(shop, p.user, p.order_id, DECLINED)
    rows, audit = attempt_rows(shop.session, p.order_id), any_audit_since(shop.session, p.user)

    first = ok(get_attempts(shop, p.user, p.order_id))
    second = ok(get_attempts(shop, p.user, p.order_id))

    assert first == second
    assert attempt_rows(shop.session, p.order_id) == rows
    assert any_audit_since(shop.session, p.user) == audit
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


# --------------------------------------------------------------------------------------------
# Orden de los intentos (el más reciente primero: created_at desc, id desc)


def test_attempts_are_listed_most_recent_first(shop: OrderShop) -> None:
    p = placed_order(shop)
    base = db_now(shop.session)
    ids = [
        rejected_row(shop.session, p.order_id, p.user, created_at=base - timedelta(minutes=m))["id"]
        for m in (5, 1, 3)  # insertados desordenados
    ]

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert [a["id"] for a in body["attempts"]] == [str(ids[1]), str(ids[2]), str(ids[0])]
    stamps = [parse_utc(a["created_at"]) for a in body["attempts"]]
    assert stamps == sorted(stamps, reverse=True)


def test_ties_on_created_at_are_broken_by_id_descending(shop: OrderShop) -> None:
    p = placed_order(shop)
    moment = db_now(shop.session) - timedelta(minutes=2)
    for n in (2, 3, 1):
        rejected_row(shop.session, p.order_id, p.user, created_at=moment, id=UUID(int=n))

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert [a["id"] for a in body["attempts"]] == [str(UUID(int=n)) for n in (3, 2, 1)]


def test_a_rejection_followed_by_an_approval_lists_the_approval_first(shop: OrderShop) -> None:
    p = placed_order(shop)
    base = db_now(shop.session)
    rejected_row(shop.session, p.order_id, p.user, created_at=base - timedelta(minutes=4))
    approved = insert_attempt_row(
        shop.session, p.order_id, p.user, created_at=base - timedelta(minutes=1)
    )

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert [a["status"] for a in body["attempts"]] == ["approved", "rejected"]
    assert body["attempts"][0]["id"] == str(approved["id"])


# --------------------------------------------------------------------------------------------
# can_pay y attempts_left (CA-PAYMENTS-09)


@pytest.mark.parametrize(("count", "left", "can_pay"), [(0, 5, True), (4, 1, True), (5, 0, False)])
def test_can_pay_and_attempts_left_after_0_4_and_5_real_rejections(
    shop: OrderShop, count: int, left: int, can_pay: bool
) -> None:
    p = placed_order(shop)
    reject_n(shop, p, count)

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert (body["can_pay"], body["attempts_left"]) == (can_pay, left)
    assert len(body["attempts"]) == count


def test_after_the_limit_the_next_payment_is_409_and_the_list_does_not_grow(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    reject_n(shop, p, 5)

    blocked = pay(shop, p.user, p.order_id, "4242")
    body = ok(get_attempts(shop, p.user, p.order_id))

    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "too_many_attempts"
    assert len(body["attempts"]) == 5 and body["can_pay"] is False


def test_each_gateway_rejection_code_counts_towards_the_limit(shop: OrderShop) -> None:
    p = placed_order(shop)
    for last4 in (DECLINED, NO_FUNDS, EXPIRED_CARD):
        assert pay(shop, p.user, p.order_id, last4).status_code == 201

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["attempts_left"] == 2 and body["can_pay"] is True
    assert {a["failure_code"] for a in body["attempts"]} == {
        "card_declined",
        "insufficient_funds",
        "expired_card",
    }


def test_order_expired_attempts_do_not_count_towards_the_limit(shop: OrderShop) -> None:
    p = placed_order(shop)
    for _ in range(5):
        rejected_row(shop.session, p.order_id, p.user, "order_expired")
    rejected_row(shop.session, p.order_id, p.user, "card_declined")

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["attempts_left"] == 4 and body["can_pay"] is True
    assert len(body["attempts"]) == 6  # se listan, pero no cuentan


def test_five_order_expired_alone_leave_every_attempt_available(shop: OrderShop) -> None:
    p = placed_order(shop)
    for _ in range(5):
        rejected_row(shop.session, p.order_id, p.user, "order_expired")

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert (body["attempts_left"], body["can_pay"]) == (5, True)


@pytest.mark.parametrize("status", ALL_STATUSES)
@pytest.mark.parametrize("rejected", [0, 4, 5])
def test_can_pay_in_every_order_status_with_0_4_and_5_rejections(
    shop: OrderShop, status: str, rejected: int
) -> None:
    p = placed_order(shop)
    for _ in range(rejected):
        rejected_row(shop.session, p.order_id, p.user)
    set_status(shop.session, p.order_id, status)

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["attempts_left"] == 5 - rejected
    assert body["can_pay"] is (status == "pendiente_pago" and rejected < 5)


def test_a_cancelled_order_is_readable_but_cannot_be_paid(shop: OrderShop) -> None:
    p = placed_order(shop)
    reject_n(shop, p, 1)
    cancelled = shop.client.post(
        f"/api/v1/orders/{p.order_id}/cancel",
        headers={"Authorization": f"Bearer {make_token(str(p.user))}"},
    )
    assert cancelled.status_code == 200, cancelled.text

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["can_pay"] is False and len(body["attempts"]) == 1


# --------------------------------------------------------------------------------------------
# Aislamiento (R8, RN-10, P-6): 404 indistinguible


def test_a_stranger_and_a_missing_order_get_the_same_404_byte_for_byte(shop: OrderShop) -> None:
    owner = placed_order(shop)
    reject_n(shop, owner, 2)
    stranger = shop.user()

    foreign = get_attempts(shop, stranger, owner.order_id)
    missing = get_attempts(shop, stranger, MISSING)

    assert foreign.status_code == missing.status_code == 404
    assert foreign.content == missing.content
    assert foreign.json()["error"]["code"] == "not_found"
    assert foreign.headers["content-type"] == missing.headers["content-type"]
    assert foreign.headers.get("cache-control") == missing.headers.get("cache-control")
    assert str(owner.order_id) not in foreign.text and "7391" not in foreign.text


def test_the_stranger_does_not_see_the_owners_attempts_and_the_owner_still_does(
    shop: OrderShop,
) -> None:
    owner = placed_order(shop)
    reject_n(shop, owner, 2)
    stranger = placed_order(shop)

    own = ok(get_attempts(shop, stranger.user, stranger.order_id))
    theirs = ok(get_attempts(shop, owner.user, owner.order_id))

    assert own["attempts"] == [] and own["attempts_left"] == 5
    assert len(theirs["attempts"]) == 2 and theirs["attempts_left"] == 3


@pytest.mark.parametrize(
    "headers",
    [
        {"X-User-Id": "{owner}"},
        {"X-User": "{owner}"},
        {"X-Forwarded-User": "{owner}"},
        {"user_id": "{owner}"},
        {"X-Customer-Id": "{owner}"},
    ],
)
def test_a_user_id_in_a_header_is_ignored(shop: OrderShop, headers: dict[str, str]) -> None:
    owner = placed_order(shop)
    stranger = shop.user()
    forged = {k: v.format(owner=owner.user) for k, v in headers.items()}

    response = get_attempts(shop, stranger, owner.order_id, headers=forged)

    assert response.status_code == 404


@pytest.mark.parametrize("name", ["user_id", "customer_id", "owner", "as_user"])
def test_a_user_id_in_the_query_is_ignored_for_a_stranger_and_for_the_owner(
    shop: OrderShop, name: str
) -> None:
    owner = placed_order(shop)
    reject_n(shop, owner, 1)
    stranger = shop.user()

    as_stranger = get_attempts(shop, stranger, owner.order_id, params={name: str(owner.user)})
    as_owner = get_attempts(shop, owner.user, owner.order_id, params={name: str(stranger)})

    assert as_stranger.status_code == 404
    assert len(ok(as_owner)["attempts"]) == 1  # sigue siendo el dueño por la sesión


def test_an_administrator_does_not_see_a_customers_attempts_either(shop: OrderShop) -> None:
    owner = placed_order(shop)
    reject_n(shop, owner, 1)
    admin = shop.user(Role.ADMIN)

    response = get_attempts(shop, admin, owner.order_id)
    missing = get_attempts(shop, admin, MISSING)

    assert response.status_code == 404 and response.content == missing.content
    assert owner.order_id.hex not in response.text


def test_a_stranger_reading_does_not_expire_the_owners_overdue_order(shop: OrderShop) -> None:
    owner = placed_order(shop)
    make_overdue(shop.session, owner.order_id)
    stranger = shop.user()

    response = get_attempts(shop, stranger, owner.order_id)

    assert response.status_code == 404
    assert status_of(shop.session, owner.order_id) == "pendiente_pago"  # sin caducar lo ajeno
    assert reservation_states(shop.session, owner.order_id) == ["active"]
    assert audit_rows(shop.session, action="orders.status_changed") == []


# --------------------------------------------------------------------------------------------
# Cache-Control: no-store


def test_the_200_and_the_404_carry_no_store(shop: OrderShop) -> None:
    p = placed_order(shop)

    found = get_attempts(shop, p.user, p.order_id)
    missing = get_attempts(shop, p.user, MISSING)
    foreign = get_attempts(shop, shop.user(), p.order_id)

    for response, status in ((found, 200), (missing, 404), (foreign, 404)):
        assert response.status_code == status
        assert response.headers.get("cache-control") == "no-store"


# --------------------------------------------------------------------------------------------
# Vencimiento perezoso (R7 de orders, CA-PAYMENTS-11)


def test_an_overdue_order_read_by_its_owner_is_expired_and_cannot_be_paid(shop: OrderShop) -> None:
    p = placed_order(shop)
    reject_n(shop, p, 2)
    make_overdue(shop.session, p.order_id)

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["can_pay"] is False and body["attempts_left"] == 3
    assert len(body["attempts"]) == 2
    assert status_of(shop.session, p.order_id) == "expirado"
    assert reservation_states(shop.session, p.order_id) == ["released"]


def test_after_the_lazy_expiry_paying_is_409_expired_and_the_read_stays_200(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    make_overdue(shop.session, p.order_id)
    assert ok(get_attempts(shop, p.user, p.order_id))["can_pay"] is False

    blocked = pay(shop, p.user, p.order_id, "4242")
    again = ok(get_attempts(shop, p.user, p.order_id))

    assert blocked.status_code == 409
    assert blocked.json()["error"]["details"] == {"status": "expirado"}
    assert again["can_pay"] is False and again["attempts"] == []


def test_a_still_valid_order_one_second_before_expiry_can_be_paid(shop: OrderShop) -> None:
    p = placed_order(shop)
    make_overdue(shop.session, p.order_id, seconds_over=-30)  # vence dentro de 30 s

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["can_pay"] is True
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


def test_an_order_expired_attempt_is_listed_and_the_order_is_not_payable(shop: OrderShop) -> None:
    p = placed_order(shop)
    rejected_row(shop.session, p.order_id, p.user, "order_expired")
    set_status(shop.session, p.order_id, "expirado")

    body = ok(get_attempts(shop, p.user, p.order_id))

    assert body["can_pay"] is False and body["attempts_left"] == 5
    assert [a["failure_code"] for a in body["attempts"]] == ["order_expired"]


# --------------------------------------------------------------------------------------------
# Registros (R7 de payments, R-10): `card_last4` no llega a los logs de la aplicación


def test_card_last4_never_reaches_the_application_logs(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    p = placed_order(shop)
    pay(shop, p.user, p.order_id, LAST4)
    caplog.set_level(logging.DEBUG)

    get_attempts(shop, p.user, p.order_id)
    get_attempts(shop, shop.user(), p.order_id)  # 404
    get_attempts(shop, None, p.order_id)  # 401

    log = caplog.text
    assert "payments/orders" in log, "la prueba debe ver los registros de las solicitudes"
    assert not re.search(rf"(?<![\w.]){LAST4}(?![\w.])", UUID_RE.sub("", log))
    assert "card_last4" not in log
