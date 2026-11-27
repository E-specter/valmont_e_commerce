"""Seguridad de `POST /api/v1/payments/orders/{id}/attempts` (T-094; CA-PAYMENTS-07 y 08; SPEC §4
R7 y R8, §7 "Detalles que cierran" y §9): validación del cuerpo sin eco, ningún dato de tarjeta en
respuestas, logs, auditoría ni tablas, identidad solo de la sesión, aislamiento entre clientes,
rutas inexistentes de administración y `Cache-Control: no-store`.

La app real contra PostgreSQL en la transacción de la fixture `shop` de orders. Los valores de
tarjeta son ficticios y distintivos (no se parecen a ningún id ni importe de las pruebas)."""

import logging
import re
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import make_token
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import OrderShop, on_hand
from tests.payments.pay_order_helpers import (
    DOWN,
    another_order,
    attempt_rows,
    pay,
    pay_path,
    placed_order,
    rolling_back_shop,
    sales,
    spy,
    status_of,
)
from tests.payments.payments_db_helpers import new_key
from valmont.modules.identity.domain import Role
from valmont.modules.payments.adapters.http import get_payment_gateway

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop

FAKE_NUMBER = "4929118877665544"  # 16 dígitos ficticios, sin relación con los datos de prueba
FAKE_CVV = "913"
FAKE_EXPIRY = "11/29"
FAKE_HOLDER = "Zacarias Quispe Prueba"
LAST4 = "7391"
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def code_of(response: Any) -> str:
    return response.json()["error"]["code"]


def nothing_happened(shop: OrderShop, p: Any, gateway: Any | None = None) -> None:
    """La solicitud fue rechazada sin ningún efecto: ni intento, ni pago, ni stock."""
    assert attempt_rows(shop.session, p.order_id) == []
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert sales(shop.session, p.order_id) == []
    if gateway is not None:
        assert gateway.charges == []


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-07: el cuerpo es un esquema cerrado de un solo campo


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("card_number", FAKE_NUMBER),
        ("cvv", FAKE_CVV),
        ("cvc", FAKE_CVV),
        ("expiry", FAKE_EXPIRY),
        ("holder", FAKE_HOLDER),
        ("cardholder", FAKE_HOLDER),
        ("amount", 1),
        ("amount", {"amount": 1, "currency": "PEN"}),
        ("total", 1),
        ("user_id", "00000000-0000-4000-8000-000000000001"),
        ("order_id", "00000000-0000-4000-8000-000000000002"),
        ("status", "approved"),
        ("result", "approved"),
        ("failure_code", "card_declined"),
        ("gateway", "simulated"),
        ("scenario", "approved"),
        ("currency", "USD"),
        ("payment_token", "tok_prueba_no_real"),
    ],
)
def test_any_extra_field_in_the_body_is_422_naming_the_field_without_echoing_it(
    shop: OrderShop, field: str, value: Any
) -> None:
    gateway = spy(shop)
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, body={"card_last4": "4242", field: value})

    assert response.status_code == 422, response.text
    assert code_of(response) == "validation_error"
    [issue] = response.json()["error"]["details"]
    assert issue["loc"] == ["body", field] and issue["type"] == "extra_forbidden"
    if isinstance(value, str) and len(value) >= 4:
        assert value not in response.text
    nothing_happened(shop, p, gateway)


def test_a_full_card_form_in_the_body_is_422_and_none_of_the_values_comes_back(
    shop: OrderShop,
) -> None:
    gateway = spy(shop)
    p = placed_order(shop)
    form = {
        "card_number": FAKE_NUMBER,
        "cvv": FAKE_CVV,
        "expiry": FAKE_EXPIRY,
        "holder": FAKE_HOLDER,
    }

    response = pay(shop, p.user, p.order_id, body=form)

    assert response.status_code == 422
    for value in form.values():
        assert value not in response.text
    nothing_happened(shop, p, gateway)


@pytest.mark.parametrize(
    "value",
    [
        FAKE_NUMBER,
        "424",
        "42424",
        "abcd",
        "42a2",
        " 4242",
        "4242 ",
        "42 42",
        "4242\n",
        "\n4242",
        "4242\r\n",
        "4242\x00",
        "٤٢٤٢",  # dígitos árabe-índicos: \d de otros motores los aceptaría
        "４２４２",  # dígitos de ancho completo
        "-424",
        "+424",
        "4.24",
        "4e23",
        "0x42",
        "",
        "4242'; DROP TABLE app.orders; --",
        "{{4242}}",
    ],
)
def test_a_malformed_card_last4_is_422_and_the_value_is_not_echoed(
    shop: OrderShop, value: str
) -> None:
    gateway = spy(shop)
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, value)

    assert response.status_code == 422, response.text
    assert code_of(response) == "validation_error"
    assert [i["loc"] for i in response.json()["error"]["details"]] == [["body", "card_last4"]]
    if len(value.strip()) >= 4:
        assert value.strip() not in response.text
    nothing_happened(shop, p, gateway)


@pytest.mark.parametrize(
    "body",
    [{}, {"card_last4": None}, {"card_last4": 4242}, {"card_last4": ["4242"]}, {"card_last4": {}}],
    ids=["vacío", "nulo", "número", "lista", "objeto"],
)
def test_a_missing_null_or_non_string_card_last4_is_422(shop: OrderShop, body: Any) -> None:
    gateway = spy(shop)
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, body=body)

    assert response.status_code == 422, response.text
    assert code_of(response) == "validation_error"
    nothing_happened(shop, p, gateway)


@pytest.mark.parametrize("body", [[], "4242", 4242, None, [{"card_last4": "4242"}]])
def test_a_body_that_is_not_an_object_is_422(shop: OrderShop, body: Any) -> None:
    gateway = spy(shop)
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, body=body)

    assert response.status_code == 422, response.text
    nothing_happened(shop, p, gateway)


@pytest.mark.parametrize("raw", [b"", b"no es json", b'{"card_last4": "4242"', b"\xff\xfe"])
def test_an_empty_or_broken_json_body_is_422_with_no_effect(shop: OrderShop, raw: bytes) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, content=raw)

    assert response.status_code == 422, response.text
    nothing_happened(shop, p)


def test_a_validation_error_exposes_only_loc_type_and_msg(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, FAKE_NUMBER)

    [issue] = response.json()["error"]["details"]
    assert set(issue) == {"loc", "type", "msg"}
    assert FAKE_NUMBER not in response.text and "input" not in issue


def test_a_malformed_order_id_in_the_path_is_422(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, "no-es-un-uuid", "4242")

    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["loc"] == ["path", "order_id"]
    nothing_happened(shop, p)


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-07: ningún dato de tarjeta en ningún sitio


def test_no_table_of_the_schema_has_a_column_for_card_data(db_session: Session) -> None:
    sensitive = (
        "card_number",
        "cardnumber",
        "pan",
        "cvv",
        "cvc",
        "cvv2",
        "expiry",
        "expiry_date",
        "expiration",
        "expiration_date",
        "exp_month",
        "exp_year",
        "holder",
        "holder_name",
        "cardholder",
        "cardholder_name",
        "card_holder",
        "payment_token",
    )
    found = db_session.execute(
        text(
            "SELECT table_name, column_name FROM information_schema.columns"
            " WHERE table_schema = 'app' AND lower(column_name) = ANY(:names)"
        ),
        {"names": list(sensitive)},
    ).all()
    assert found == []


def test_the_attempts_table_has_only_last4_as_card_data(shop: OrderShop) -> None:
    columns = set(
        shop.session.scalars(
            text(
                "SELECT column_name FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'payment_attempts'"
            )
        )
    )
    assert columns == {
        "id",
        "order_id",
        "user_id",
        "idempotency_key",
        "status",
        "amount",
        "failure_code",
        "card_last4",
        "gateway",
        "created_at",
    }


def test_rejected_card_data_reaches_no_table_audit_or_response(shop: OrderShop) -> None:
    p = placed_order(shop)
    form = {
        "card_last4": "4242",
        "card_number": FAKE_NUMBER,
        "cvv": FAKE_CVV,
        "holder": FAKE_HOLDER,
    }
    rejected = pay(shop, p.user, p.order_id, body=form)
    ok = pay(shop, p.user, p.order_id, "4242")

    dumps = [
        row[0]
        for row in shop.session.execute(
            text(
                "SELECT row_to_json(a)::text FROM app.payment_attempts a WHERE a.user_id = :u"
                " UNION ALL SELECT row_to_json(l)::text FROM app.audit_log l"
                " WHERE l.actor_id = :u"
            ),
            {"u": p.user},
        )
    ]
    assert rejected.status_code == 422 and ok.status_code == 201
    everything = " ".join([rejected.text, ok.text, *dumps])
    for secret in (FAKE_NUMBER, FAKE_CVV, FAKE_HOLDER):
        assert secret not in everything


def test_the_attempt_row_holds_only_the_last_four_digits(shop: OrderShop) -> None:
    p = placed_order(shop)
    pay(shop, p.user, p.order_id, LAST4)

    [row] = attempt_rows(shop.session, p.order_id)

    assert row["card_last4"] == LAST4 and len(row["card_last4"]) == 4
    assert FAKE_NUMBER not in str(row)


def test_nothing_of_the_request_reaches_the_logs_at_debug_level(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    p = placed_order(shop)
    q = placed_order(shop)
    form = {
        "card_last4": "4242",
        "card_number": FAKE_NUMBER,
        "cvv": FAKE_CVV,
        "holder": FAKE_HOLDER,
    }
    key = new_key()

    pay(shop, p.user, p.order_id, body=form)  # 422 con el formulario completo
    pay(shop, p.user, p.order_id, FAKE_NUMBER)  # 422 con un número largo
    pay(shop, p.user, p.order_id, LAST4, key=key)  # 201
    pay(shop, p.user, p.order_id, LAST4, key=key)  # 200 (repetición)
    pay(shop, p.user, p.order_id, LAST4)  # 409 (ya pagado)
    pay(shop, q.user, q.order_id, DOWN)  # 503
    pay(shop, q.user, UUID(int=0xBEEF), LAST4)  # 404

    log = caplog.text
    assert "payments/orders" in log, "la prueba debe ver los registros de las solicitudes"
    for secret in (FAKE_NUMBER, FAKE_CVV, FAKE_HOLDER, "card_number", "cvv", '"card_last4"'):
        assert secret not in log, secret
    scrubbed = UUID_RE.sub("", log).replace(key, "")
    assert not re.search(rf"(?<![\w.]){LAST4}(?![\w.])", scrubbed)
    assert "Traceback" not in log


def test_an_unexpected_failure_is_a_500_without_trace_or_data_and_changes_nothing(
    shop: OrderShop,
) -> None:
    class Exploding:
        name = "boom"

        def authorize(self, charge: Any) -> Any:
            raise RuntimeError("detalle interno que no debe salir")

    shop.override(get_payment_gateway, lambda: Exploding())
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert "detalle interno" not in response.text and "Traceback" not in response.text
    assert "RuntimeError" not in response.text
    nothing_happened(shop, p)


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-08: sesión, identidad y aislamiento


def test_without_a_token_it_is_401(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, None, p.order_id, "4242")

    assert response.status_code == 401 and code_of(response) == "unauthenticated"
    nothing_happened(shop, p)


@pytest.mark.parametrize(
    "authorization",
    ["Bearer no-es-un-jwt", "Bearer ", "Basic abc", "token", f"Bearer {make_token('x')[:-4]}abcd"],
    ids=["basura", "vacío", "basic", "sin-esquema", "firma-rota"],
)
def test_an_invalid_token_is_401(shop: OrderShop, authorization: str) -> None:
    p = placed_order(shop)

    response = pay(shop, None, p.order_id, "4242", headers={"Authorization": authorization})

    assert response.status_code == 401, response.text
    nothing_happened(shop, p)


def test_a_missing_token_is_401_even_with_an_invalid_body_and_no_key(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, None, p.order_id, key=None, body={"card_number": FAKE_NUMBER})

    assert response.status_code == 401
    assert FAKE_NUMBER not in response.text


def test_a_token_for_a_user_without_profile_cannot_pay_anything(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, UUID(int=0xC0FFEE), p.order_id, "4242")

    assert response.status_code in (401, 403, 404)
    nothing_happened(shop, p)


def test_another_customer_gets_404_on_my_order_and_cannot_change_it(shop: OrderShop) -> None:
    gateway = spy(shop)
    owner = placed_order(shop, quantity=2, on_hand=5)
    stranger = shop.user()

    response = pay(shop, stranger, owner.order_id, "4242")

    assert response.status_code == 404 and code_of(response) == "not_found"
    nothing_happened(shop, owner, gateway)
    assert on_hand(shop.session, owner.product) == 5
    assert pay(shop, owner.user, owner.order_id, "4242").status_code == 201  # el dueño sí puede


def test_a_stranger_paying_with_a_rejected_card_also_gets_404_not_a_rejection(
    shop: OrderShop,
) -> None:
    owner = placed_order(shop)
    stranger = shop.user()

    for last4 in ("0002", "9995", "0069", DOWN, "4242"):
        response = pay(shop, stranger, owner.order_id, last4)
        assert response.status_code == 404, (last4, response.text)
    nothing_happened(shop, owner)


def test_a_stranger_cannot_use_the_owner_idempotency_key(shop: OrderShop) -> None:
    owner = placed_order(shop)
    stranger = placed_order(shop)
    key = new_key()
    original = pay(shop, owner.user, owner.order_id, "0002", key=key).json()

    # Con la misma clave sobre el pedido AJENO: 404; sobre el propio: su propio intento.
    foreign = pay(shop, stranger.user, owner.order_id, "4242", key=key)
    own = pay(shop, stranger.user, stranger.order_id, "4242", key=key)

    assert foreign.status_code == 404 and original["id"] not in foreign.text
    assert own.status_code == 201 and own.json()["id"] != original["id"]


def test_an_admin_cannot_pay_a_customer_order(shop: OrderShop) -> None:
    owner = placed_order(shop)
    admin = shop.user(Role.ADMIN)

    response = pay(shop, admin, owner.order_id, "4242")

    assert response.status_code == 404
    nothing_happened(shop, owner)


@pytest.mark.parametrize(
    "spoof",
    [
        {"X-User-Id": "{owner}"},
        {"X-Forwarded-User": "{owner}"},
        {"X-Customer-Id": "{owner}"},
        {"X-Role": "admin"},
        {"X-Forwarded-For": "127.0.0.1"},
    ],
)
def test_untrusted_headers_never_decide_the_identity(
    shop: OrderShop, spoof: dict[str, str]
) -> None:
    owner = placed_order(shop)
    stranger = shop.user()
    sent = {k: v.replace("{owner}", str(owner.user)) for k, v in spoof.items()}

    response = pay(shop, stranger, owner.order_id, "4242", headers=sent)

    assert response.status_code == 404
    nothing_happened(shop, owner)


def test_a_user_id_query_parameter_does_not_change_the_owner(shop: OrderShop) -> None:
    owner = placed_order(shop)
    stranger = shop.user()
    headers = {
        "Idempotency-Key": new_key(),
        "Authorization": f"Bearer {make_token(str(stranger))}",
    }

    response = shop.client.post(
        pay_path(owner.order_id),
        headers=headers,
        json={"card_last4": "4242"},
        params={"user_id": str(owner.user), "amount": "1"},
    )

    assert response.status_code == 404
    nothing_happened(shop, owner)


def test_the_attempts_of_one_customer_are_never_in_the_response_of_another(shop: OrderShop) -> None:
    one, two = placed_order(shop), placed_order(shop)
    first = pay(shop, one.user, one.order_id, "4242")

    second = pay(shop, two.user, two.order_id, "4242")

    assert str(one.order_id) not in second.text and first.json()["id"] not in second.text
    assert str(one.user) not in second.text


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("get", "/admin/orders/{order}/attempts"),
        ("post", "/admin/orders/{order}/attempts"),
        ("post", "/orders/{order}/refund"),
        ("post", "/orders/{order}/refunds"),
        ("post", "/refunds"),
        ("get", "/attempts"),
        ("post", "/attempts"),
        ("delete", "/orders/{order}/attempts/{order}"),
        ("put", "/orders/{order}/attempts/{order}"),
        ("patch", "/orders/{order}/attempts/{order}"),
    ],
)
@pytest.mark.parametrize("role", [Role.CUSTOMER, Role.ADMIN])
def test_there_is_no_admin_refund_or_edit_route_in_payments(
    shop: OrderShop, method: str, suffix: str, role: Role
) -> None:
    p = placed_order(shop)
    user = shop.user(role)
    path = "/api/v1/payments" + suffix.replace("{order}", str(p.order_id))

    response = getattr(shop.client, method)(
        path, headers={"Authorization": f"Bearer {make_token(str(user))}"}
    )

    assert response.status_code in (404, 405, 422), (path, response.status_code)
    nothing_happened(shop, p)


@pytest.mark.parametrize("method", ["put", "patch", "delete"])
def test_an_attempt_collection_cannot_be_replaced_edited_or_deleted(
    shop: OrderShop, method: str
) -> None:
    p = placed_order(shop)
    pay(shop, p.user, p.order_id, "0002")

    response = getattr(shop.client, method)(
        pay_path(p.order_id), headers={"Authorization": f"Bearer {make_token(str(p.user))}"}
    )

    assert response.status_code == 405
    assert len(attempt_rows(shop.session, p.order_id)) == 1


def test_paying_one_order_does_not_touch_another_order_of_the_same_customer(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, price=100_000)
    other = another_order(shop, p.user, price=200_000)

    pay(shop, p.user, p.order_id, "4242")

    assert status_of(shop.session, other) == "pendiente_pago"
    assert attempt_rows(shop.session, other) == []
    assert status_of(shop.session, p.order_id) == "pagado"


def test_a_paid_status_set_by_the_client_cannot_be_forged_through_the_body(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, body={"card_last4": "0002", "status": "approved"})

    assert response.status_code == 422
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert pay(shop, p.user, p.order_id, "4242").status_code == 201


# --------------------------------------------------------------------------------------------
# Cache-Control: no-store (R7, §7)


def test_the_success_and_business_responses_carry_no_store(shop: OrderShop) -> None:
    owner = placed_order(shop)
    other = placed_order(shop)
    stranger = shop.user()
    key = new_key()
    responses = {
        201: pay(shop, owner.user, owner.order_id, "4242", key=key),
        200: pay(shop, owner.user, owner.order_id, "4242", key=key),
        409: pay(shop, owner.user, owner.order_id, "4242"),
        404: pay(shop, stranger, owner.order_id, "4242"),
        503: pay(shop, other.user, other.order_id, DOWN),
    }

    for status, response in responses.items():
        assert response.status_code == status, response.text
        assert response.headers["cache-control"] == "no-store", status
    rejected = pay(shop, other.user, other.order_id, "0002")
    assert rejected.status_code == 201 and rejected.headers["cache-control"] == "no-store"
