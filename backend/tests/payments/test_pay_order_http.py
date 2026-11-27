"""`POST /api/v1/payments/orders/{order_id}/attempts` con la app real contra PostgreSQL (T-094;
CA-PAYMENTS-01, 02, 04, 05, 06, 13, 14 y 16 parte HTTP; SPEC §3 UC-01, §4 R1 a R6, R13, R15 y §7).

Cart, inventory, audit, orders y payments reales; solo la pasarela es la simulada de la app (o un
espía que la envuelve). Cada prueba corre en la transacción de la fixture `shop` de orders y se
deshace al terminar; una respuesta 2xx libera el SAVEPOINT de la solicitud (queda visible) y un 4xx
o 5xx lo deshace, así que "sin efectos" se comprueba mirando la BD tras la respuesta. Que la
transacción real se confirme se prueba en `test_pay_order_commit.py`. Datos ficticios."""

from uuid import UUID

import pytest
from sqlalchemy import text

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import admin_of
from tests.orders.orders_db_helpers import history_of
from tests.orders.orders_http_helpers import OrderShop, on_hand, order_row, reservations
from tests.orders.orders_read_helpers import make_overdue, read_order, set_status
from tests.orders.orders_transition_helpers import moved
from tests.payments.pay_order_helpers import (
    ATTEMPT_KEYS,
    DOWN,
    PAID_STATES,
    REJECTIONS,
    SpyGateway,
    another_order,
    any_audit_since,
    attempt_rows,
    expire_reservations_only,
    pay,
    payment_audit,
    placed_order,
    reservation_states,
    rolling_back_shop,
    sales,
    spy,
    status_of,
)
from tests.payments.payments_db_helpers import new_key
from valmont.main import create_app

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop

WATCH_PRICE = 1_500_000_000  # dos unidades: 3 000 000 000 céntimos, por encima de 2³¹


def error_of(response: object) -> dict[str, object]:
    return response.json()["error"]  # type: ignore[attr-defined]


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-01: pago aprobado


def test_an_approved_payment_is_201_with_exactly_the_contract_fields(shop: OrderShop) -> None:
    p = placed_order(shop, quantity=2)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == ATTEMPT_KEYS
    assert (body["status"], body["failure_code"], body["card_last4"]) == ("approved", None, "4242")
    assert body["order_id"] == str(p.order_id)
    assert str(UUID(body["id"])) == body["id"]
    assert body["amount"] == {"amount": p.total, "currency": "PEN"}
    assert body["created_at"].endswith("Z") or body["created_at"].endswith("+00:00")


def test_the_response_never_exposes_the_owner_the_gateway_or_the_key(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()

    response = pay(shop, p.user, p.order_id, "4242", key=key)

    text_ = response.text
    assert str(p.user) not in text_ and key not in text_
    assert "gateway" not in text_ and "simulated" not in text_ and "user_id" not in text_


def test_an_approved_payment_leaves_the_order_paid_with_the_stock_discounted_once(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    assert on_hand(shop.session, p.product) == 5

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    row = order_row(shop.session, p.order_id)
    assert row["status"] == "pagado" and row["paid_at"] is not None
    assert on_hand(shop.session, p.product) == 3  # bajó en lo reservado, una sola vez
    assert sales(shop.session, p.order_id) == [("venta", -2)]
    assert reservation_states(shop.session, p.order_id) == ["consumed"]
    [attempt] = attempt_rows(shop.session, p.order_id)
    assert attempt["id"] == UUID(response.json()["id"])
    assert (attempt["status"], attempt["amount"], attempt["card_last4"]) == (
        "approved",
        p.total,
        "4242",
    )
    assert attempt["failure_code"] is None and attempt["user_id"] == p.user


def test_the_amount_is_the_order_total_even_above_two_to_the_31(shop: OrderShop) -> None:
    p = placed_order(shop, quantity=2, price=WATCH_PRICE)
    assert p.total == 2 * WATCH_PRICE

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    assert response.json()["amount"] == {"amount": 3_000_000_000, "currency": "PEN"}
    [attempt] = attempt_rows(shop.session, p.order_id)
    assert attempt["amount"] == 3_000_000_000


def test_the_order_detail_shows_it_paid_after_the_payment(shop: OrderShop) -> None:
    p = placed_order(shop)

    pay(shop, p.user, p.order_id, "4242")

    detail = read_order(shop, p.user, p.order_id)
    assert detail["status"] == "pagado" and detail["paid_at"] is not None
    assert detail["can_cancel"] is False


def test_a_made_to_order_only_order_is_paid_without_consuming_stock(shop: OrderShop) -> None:
    p = placed_order(shop, price=250_000, policy="made_to_order", on_hand=None)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    assert status_of(shop.session, p.order_id) == "pagado"
    assert sales(shop.session, p.order_id) == []


def test_the_order_history_gets_one_customer_paid_step(shop: OrderShop) -> None:
    p = placed_order(shop)

    pay(shop, p.user, p.order_id, "4242")

    steps = [(r[0], r[1], r[2]) for r in history_of(shop.session, p.order_id)]
    assert steps == [(None, "pendiente_pago", "customer"), ("pendiente_pago", "pagado", "customer")]


@pytest.mark.parametrize("last4", ["4242", "0000", "1234", "9999", "0001", "7391"])
def test_every_card_that_is_not_special_is_approved(shop: OrderShop, last4: str) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, last4)

    assert response.status_code == 201 and response.json()["status"] == "approved"
    assert response.json()["card_last4"] == last4


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-02: rechazos (D-043)


@pytest.mark.parametrize(("last4", "code"), REJECTIONS, ids=[c for _, c in REJECTIONS])
def test_a_rejected_card_is_a_201_rejected_with_its_code_and_the_order_stays_pending(
    shop: OrderShop, last4: str, code: str
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)

    response = pay(shop, p.user, p.order_id, last4)

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == ATTEMPT_KEYS
    assert (body["status"], body["failure_code"], body["card_last4"]) == ("rejected", code, last4)
    assert body["amount"] == {"amount": p.total, "currency": "PEN"}
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert order_row(shop.session, p.order_id)["paid_at"] is None
    assert reservation_states(shop.session, p.order_id) == ["active"]
    assert on_hand(shop.session, p.product) == 5 and sales(shop.session, p.order_id) == []
    [attempt] = attempt_rows(shop.session, p.order_id)
    assert (attempt["status"], attempt["failure_code"], attempt["amount"]) == (
        "rejected",
        code,
        p.total,
    )


@pytest.mark.parametrize(("last4", "code"), REJECTIONS, ids=[c for _, c in REJECTIONS])
def test_a_rejection_is_audited_once_and_the_order_gets_no_paid_step(
    shop: OrderShop, last4: str, code: str
) -> None:
    p = placed_order(shop)

    pay(shop, p.user, p.order_id, last4)

    [entry] = payment_audit(shop.session, p.user)
    assert entry["after"]["status"] == "rejected" and entry["after"]["failure_code"] == code
    steps = [r[1] for r in history_of(shop.session, p.order_id)]
    assert steps == ["pendiente_pago"]


def test_after_a_rejection_a_new_key_with_an_approved_card_pays_the_same_order(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, quantity=1, on_hand=5)
    first = pay(shop, p.user, p.order_id, "0002")
    assert first.json()["status"] == "rejected"

    second = pay(shop, p.user, p.order_id, "4242")

    assert second.status_code == 201 and second.json()["status"] == "approved"
    assert second.json()["id"] != first.json()["id"]
    assert [a["status"] for a in attempt_rows(shop.session, p.order_id)].count("approved") == 1
    assert len(attempt_rows(shop.session, p.order_id)) == 2
    assert on_hand(shop.session, p.product) == 4 and status_of(shop.session, p.order_id) == "pagado"


def test_the_gateway_down_is_503_with_no_attempt_no_audit_and_the_order_intact(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    audits_before = any_audit_since(shop.session, p.user)

    response = pay(shop, p.user, p.order_id, DOWN)

    assert response.status_code == 503, response.text
    assert error_of(response)["code"] == "payment_gateway_unavailable"
    assert attempt_rows(shop.session, p.order_id) == []
    assert any_audit_since(shop.session, p.user) == audits_before
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert reservation_states(shop.session, p.order_id) == ["active"]
    assert on_hand(shop.session, p.product) == 5 and sales(shop.session, p.order_id) == []


def test_after_a_503_the_same_key_with_another_card_works(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()
    assert pay(shop, p.user, p.order_id, DOWN, key=key).status_code == 503

    retry = pay(shop, p.user, p.order_id, "4242", key=key)

    assert retry.status_code == 201 and retry.json()["status"] == "approved"
    assert len(attempt_rows(shop.session, p.order_id)) == 1


def test_a_503_does_not_count_for_the_rejection_limit(shop: OrderShop) -> None:
    p = placed_order(shop)
    for _ in range(6):
        assert pay(shop, p.user, p.order_id, DOWN).status_code == 503

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"


def test_the_gateway_only_gets_the_charge_with_the_server_amount(shop: OrderShop) -> None:
    gateway: SpyGateway = spy(shop)
    p = placed_order(shop, quantity=3, price=120_000)

    response = pay(shop, p.user, p.order_id, "4242")

    [charge] = gateway.charges
    assert charge.amount == p.total == 360_000
    assert str(charge.reference) == response.json()["id"]
    assert charge.method.card_last4 == "4242"


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-04: pedidos ya pagados


@pytest.mark.parametrize("status", PAID_STATES)
def test_an_order_already_paid_or_beyond_is_409_order_already_paid_with_no_new_attempt(
    shop: OrderShop, status: str
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    set_status(shop.session, p.order_id, status)
    stock = on_hand(shop.session, p.product)
    audits_before = any_audit_since(shop.session, p.user)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409, response.text
    assert error_of(response)["code"] == "order_already_paid"
    assert attempt_rows(shop.session, p.order_id) == []
    assert on_hand(shop.session, p.product) == stock
    assert sales(shop.session, p.order_id) == []
    assert any_audit_since(shop.session, p.user) == audits_before


def test_paying_twice_with_different_keys_never_charges_twice(shop: OrderShop) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    assert pay(shop, p.user, p.order_id, "4242").status_code == 201

    second = pay(shop, p.user, p.order_id, "4242")

    assert second.status_code == 409 and error_of(second)["code"] == "order_already_paid"
    assert [a["status"] for a in attempt_rows(shop.session, p.order_id)] == ["approved"]
    assert on_hand(shop.session, p.product) == 3 and len(sales(shop.session, p.order_id)) == 1
    assert len(payment_audit(shop.session, p.user)) == 1


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-05: pedidos que ya no se pueden pagar


@pytest.mark.parametrize("status", ["cancelado", "expirado"])
def test_a_cancelled_or_expired_order_is_409_order_not_payable_with_its_status(
    shop: OrderShop, status: str
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    set_status(shop.session, p.order_id, status)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409, response.text
    assert error_of(response)["code"] == "order_not_payable"
    assert error_of(response)["details"] == {"status": status}
    assert attempt_rows(shop.session, p.order_id) == []
    assert sales(shop.session, p.order_id) == [] and on_hand(shop.session, p.product) == 5


def test_a_pending_order_past_its_expiry_is_409_not_payable_expirado(shop: OrderShop) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    make_overdue(shop.session, p.order_id)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409, response.text
    assert error_of(response)["code"] == "order_not_payable"
    assert error_of(response)["details"] == {"status": "expirado"}
    assert attempt_rows(shop.session, p.order_id) == []
    assert order_row(shop.session, p.order_id)["paid_at"] is None
    assert sales(shop.session, p.order_id) == [] and on_hand(shop.session, p.product) == 5
    assert len(payment_audit(shop.session, p.user)) == 0


def test_the_expiry_boundary_expires_at_equal_to_now_is_overdue(shop: OrderShop) -> None:
    p = placed_order(shop)
    make_overdue(shop.session, p.order_id, seconds_over=0)  # expires_at == now: vencido

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409 and error_of(response)["details"] == {"status": "expirado"}


def test_an_order_with_a_few_seconds_left_is_still_payable(shop: OrderShop) -> None:
    p = placed_order(shop)
    make_overdue(shop.session, p.order_id, seconds_over=-5)  # vigente 5 s más

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"


def test_a_foreign_and_a_missing_order_give_the_same_404(shop: OrderShop) -> None:
    owner = placed_order(shop)
    stranger = shop.user()

    foreign = pay(shop, stranger, owner.order_id, "4242")
    missing = pay(shop, stranger, UUID(int=0xFEED), "4242")

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert error_of(foreign)["code"] == "not_found"
    assert str(owner.order_id) not in foreign.text
    assert attempt_rows(shop.session, owner.order_id) == []
    assert status_of(shop.session, owner.order_id) == "pendiente_pago"


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-06: el pedido vence durante el pago


def test_an_order_whose_reservation_expired_is_a_201_rejected_order_expired(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    expire_reservations_only(shop.session, p.order_id)  # el pedido aún figura vigente al leerlo

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["status"], body["failure_code"]) == ("rejected", "order_expired")
    assert body["amount"] == {"amount": p.total, "currency": "PEN"}
    assert status_of(shop.session, p.order_id) == "expirado"
    assert reservation_states(shop.session, p.order_id) == ["released"]
    assert sales(shop.session, p.order_id) == [] and on_hand(shop.session, p.product) == 5
    assert order_row(shop.session, p.order_id)["paid_at"] is None
    [attempt] = attempt_rows(shop.session, p.order_id)
    assert (attempt["status"], attempt["failure_code"]) == ("rejected", "order_expired")


def test_order_expired_is_audited_as_a_rejected_attempt_next_to_the_order_expiry(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    expire_reservations_only(shop.session, p.order_id)

    pay(shop, p.user, p.order_id, "4242")

    [entry] = payment_audit(shop.session, p.user)
    assert entry["after"]["status"] == "rejected"
    assert entry["after"]["failure_code"] == "order_expired"
    steps = [r[1] for r in history_of(shop.session, p.order_id)]
    assert steps == ["pendiente_pago", "expirado"]


def test_after_order_expired_a_new_payment_is_409_not_payable(shop: OrderShop) -> None:
    p = placed_order(shop)
    expire_reservations_only(shop.session, p.order_id)
    assert pay(shop, p.user, p.order_id, "4242").status_code == 201

    again = pay(shop, p.user, p.order_id, "4242")

    assert again.status_code == 409 and error_of(again)["details"] == {"status": "expirado"}
    assert len(attempt_rows(shop.session, p.order_id)) == 1


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-13: auditoría


def test_an_approved_attempt_is_audited_with_the_customer_and_without_card_data(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242")

    [entry] = payment_audit(shop.session, p.user)
    assert entry["entity_type"] == "payment_attempt"
    assert entry["entity_id"] == response.json()["id"]
    assert (entry["actor_id"], entry["actor_role"]) == (p.user, "customer")
    assert entry["before"] is None
    assert entry["after"] == {
        "order_id": str(p.order_id),
        "status": "approved",
        "failure_code": None,
        "amount": p.total,
    }
    assert "card_last4" not in str(entry)


def test_an_approved_payment_also_leaves_the_orders_status_changed_entry(shop: OrderShop) -> None:
    p = placed_order(shop)

    pay(shop, p.user, p.order_id, "4242")

    rows = shop.session.execute(
        text(
            "SELECT action, after FROM app.audit_log WHERE actor_id = :u"
            " AND action = 'orders.status_changed'"
        ),
        {"u": p.user},
    ).all()
    assert any(r.after == {"status": "pagado"} for r in rows)


def test_a_repetition_a_409_and_a_503_leave_no_payment_audit(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()
    assert pay(shop, p.user, p.order_id, "4242", key=key).status_code == 201
    assert len(payment_audit(shop.session, p.user)) == 1

    repeated = pay(shop, p.user, p.order_id, "4242", key=key)
    conflict = pay(shop, p.user, p.order_id, "4242")
    q = placed_order(shop)
    down = pay(shop, q.user, q.order_id, DOWN)

    assert (repeated.status_code, conflict.status_code, down.status_code) == (200, 409, 503)
    assert len(payment_audit(shop.session, p.user)) == 1
    assert len(payment_audit(shop.session, q.user)) == 0


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-14: reembolso (RF05.05) sin ruta propia en payments


def test_an_admin_cancelling_a_paid_order_refunds_it_and_leaves_the_attempt_untouched(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, quantity=2, on_hand=5)
    paid = pay(shop, p.user, p.order_id, "4242").json()
    before = attempt_rows(shop.session, p.order_id)
    admin = admin_of(shop)

    cancelled = moved(shop, admin, p.order_id, "cancelado", note="Devolución")

    assert cancelled["status"] == "cancelado"
    row = order_row(shop.session, p.order_id)
    assert row["refunded_amount"] == row["total_amount"] == p.total
    assert attempt_rows(shop.session, p.order_id) == before  # inmutable
    assert before[0]["status"] == "approved" and str(before[0]["id"]) == paid["id"]


def test_payments_has_no_refund_or_admin_route() -> None:
    paths = create_app().openapi()["paths"]

    mine = [path for path in paths if path.startswith("/api/v1/payments")]
    assert mine, "payments debe publicar su ruta"
    assert not [p for p in mine if any(w in p.lower() for w in ("refund", "reembolso", "admin"))]
    for path in mine:
        assert set(paths[path]) <= {"get", "post"}  # nunca put, patch ni delete


# --------------------------------------------------------------------------------------------
# Caso: tres pedidos sin pagar y se paga el segundo


def test_a_customer_with_three_unpaid_orders_pays_the_second_one_only(shop: OrderShop) -> None:
    first = placed_order(shop, quantity=1, price=100_000)
    second_id = another_order(shop, first.user, price=200_000)
    third_id = another_order(shop, first.user, price=300_000)

    response = pay(shop, first.user, second_id, "4242")

    assert response.status_code == 201, response.text
    assert response.json()["amount"] == {"amount": 200_000, "currency": "PEN"}
    assert status_of(shop.session, second_id) == "pagado"
    assert status_of(shop.session, first.order_id) == "pendiente_pago"
    assert status_of(shop.session, third_id) == "pendiente_pago"
    assert reservations(shop.session, first.order_id)[0]["status"] == "active"


def test_reservations_of_a_rejected_attempt_stay_active_for_the_remaining_window(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    before = reservations(shop.session, p.order_id)

    pay(shop, p.user, p.order_id, "0002")

    assert reservations(shop.session, p.order_id) == before
