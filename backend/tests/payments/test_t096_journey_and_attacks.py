"""T-096: recorrido completo por HTTP y ataques de la auditoría final de seguridad de payments.

Recorrido: carrito (HTTP) → pedido → cada resultado de D-043 → `GET` de intentos → preparación →
envío → entrega, y pago seguido de cancelación del administrador con reembolso. Ataques (RNF02,
ASVS nivel 1): IDOR con UUID en varias formas, tokens manipulados, importe e identidad fuera del
cuerpo, `card_last4` hostil, enumeración por tiempo, cuerpo grande y la ronda de datos de tarjeta
(CA-07) en query, cabeceras y cookies. App real contra valmont_test en la transacción de la
fixture `shop`, que se deshace al terminar. Datos de tarjeta ficticios."""

import json
import logging
import statistics
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.utils import base64url_encode
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed
from tests.identity.identity_helpers import (
    OTHER_KEY,
    claims_for,
    hs256_signed_with_public_key,
    make_token,
)
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import admin_of
from tests.orders.orders_http_helpers import (
    SHIPPING,
    OrderShop,
    audit_rows,
    on_hand,
    order_row,
    place,
)
from tests.orders.orders_transition_helpers import history_of, moved, transition
from tests.payments.get_order_payments_helpers import get_attempts
from tests.payments.pay_order_helpers import (
    attempt_rows,
    pay,
    pay_path,
    placed_order,
    reservation_states,
    rolling_back_shop,
    sales,
    status_of,
)
from tests.payments.payments_db_helpers import new_key

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop

FAKE_NUMBER = "4539870012345678"  # ficticio, distinto de cualquier id o importe de la prueba
FAKE_CVV = "846"
LAST4 = "5678"


def auth(user: UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(str(user))}"}


def code_of(response: Any) -> str:
    return response.json()["error"]["code"]


# --------------------------------------------------------------------------------------------
# Recorrido completo por HTTP


def test_full_journey_cart_order_every_result_get_prepare_ship_deliver(shop: OrderShop) -> None:
    user = shop.user()
    admin = admin_of(shop)
    a = add_listed(shop.session, price=250_000, on_hand=5)
    b = add_listed(shop.session, price=120_000, on_hand=3)
    for product, quantity in ((a, 2), (b, 1)):
        added = shop.client.post(
            "/api/v1/cart/items",
            headers=auth(user),
            json={"product_id": str(product), "quantity": quantity},
        )
        assert added.status_code in (200, 201), added.text

    created = place(shop, user, delivery=SHIPPING)
    assert created.status_code == 201, created.text
    order_id, total = created.json()["id"], created.json()["total"]["amount"]
    assert total >= 2 * 250_000 + 120_000
    assert on_hand(shop.session, a) == 5 and on_hand(shop.session, b) == 3  # solo reservado
    assert reservation_states(shop.session, order_id) == ["active", "active"]

    empty = get_attempts(shop, user, order_id).json()
    assert (empty["can_pay"], empty["attempts_left"], empty["attempts"]) == (True, 5, [])

    codes = []
    for last4 in ("0002", "9995", "0069"):
        rejected = pay(shop, user, order_id, last4)
        assert rejected.status_code == 201 and rejected.json()["status"] == "rejected"
        assert rejected.json()["amount"] == {"amount": total, "currency": "PEN"}
        codes.append(rejected.json()["failure_code"])
    assert codes == ["card_declined", "insufficient_funds", "expired_card"]
    assert (
        status_of(shop.session, order_id) == "pendiente_pago"
        and sales(shop.session, order_id) == []
    )

    key = new_key()
    down = pay(shop, user, order_id, "0119", key=key)
    assert down.status_code == 503 and code_of(down) == "payment_gateway_unavailable"
    approved = pay(shop, user, order_id, "4242", key=key)  # misma clave tras el 503
    assert approved.status_code == 201, approved.text
    assert approved.json()["status"] == "approved" and approved.json()["failure_code"] is None
    assert approved.json()["amount"] == {"amount": total, "currency": "PEN"}
    assert pay(shop, user, order_id, "4242", key=key).json()["id"] == approved.json()["id"]

    listed = get_attempts(shop, user, order_id).json()
    assert listed["can_pay"] is False and listed["attempts_left"] == 2
    # Todas las solicitudes comparten la transacción de la prueba (mismo `created_at`): el orden
    # entre ellas lo decide el id (R15); el orden por tiempo real ya lo prueba T-095.
    assert sorted(str(x["failure_code"]) for x in listed["attempts"]) == [
        "None",
        "card_declined",
        "expired_card",
        "insufficient_funds",
    ]
    assert on_hand(shop.session, a) == 3 and on_hand(shop.session, b) == 2
    assert sorted(sales(shop.session, order_id)) == [("venta", -2), ("venta", -1)]
    assert reservation_states(shop.session, order_id) == ["consumed", "consumed"]
    assert order_row(shop.session, order_id)["paid_at"] is not None

    entries = audit_rows(shop.session, action="payments.attempt_recorded", actor_id=user)
    assert [e["after"]["status"] for e in entries] == ["rejected"] * 3 + ["approved"]
    assert all(set(e["after"]) == {"order_id", "status", "failure_code", "amount"} for e in entries)
    assert all(e["after"]["amount"] == total for e in entries)
    assert len(audit_rows(shop.session, action="orders.status_changed", entity_id=order_id)) == 1

    for step in ("en_preparacion", "enviado", "entregado"):
        moved(shop, admin, order_id, step)
    history = [(h[1], h[2]) for h in history_of(shop.session, order_id)]
    assert history == [
        ("pendiente_pago", "customer"),
        ("pagado", "customer"),
        ("en_preparacion", "admin"),
        ("enviado", "admin"),
        ("entregado", "admin"),
    ]
    assert status_of(shop.session, order_id) == "entregado"
    again = pay(shop, user, order_id, "4242")
    assert again.status_code == 409 and code_of(again) == "order_already_paid"
    assert len(attempt_rows(shop.session, order_id)) == 4  # nada nuevo tras la entrega
    assert on_hand(shop.session, a) == 3 and on_hand(shop.session, b) == 2
    assert get_attempts(shop, user, order_id).json()["can_pay"] is False


def test_paid_then_cancelled_by_the_admin_is_refunded_and_the_attempt_stays(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, 2)
    admin = admin_of(shop)
    assert pay(shop, p.user, p.order_id, "4242").status_code == 201
    before = attempt_rows(shop.session, p.order_id)

    cancelled = transition(shop, admin, p.order_id, "cancelado")

    assert cancelled.status_code == 200, cancelled.text
    row = order_row(shop.session, p.order_id)
    assert row["status"] == "cancelado" and row["refunded_amount"] == row["total_amount"] == p.total
    assert attempt_rows(shop.session, p.order_id) == before  # inmutable (R14)
    assert on_hand(shop.session, p.product) == 3  # el stock vendido no se repone solo
    retry = pay(shop, p.user, p.order_id, "4242")
    assert retry.status_code == 409 and retry.json()["error"]["details"] == {"status": "cancelado"}
    listed = get_attempts(shop, p.user, p.order_id).json()
    assert listed["can_pay"] is False and [x["status"] for x in listed["attempts"]] == ["approved"]


# --------------------------------------------------------------------------------------------
# IDOR: el pedido ajeno en todas las formas de UUID que acepta FastAPI


def uuid_forms(order_id: UUID) -> list[str]:
    return [
        str(order_id).upper(),
        order_id.hex,
        order_id.hex.upper(),
        "{" + str(order_id) + "}",
        "urn:uuid:" + str(order_id),
        str(order_id) + "%20",
        " " + str(order_id),
    ]


def test_a_stranger_never_reaches_a_foreign_order_with_any_uuid_form(shop: OrderShop) -> None:
    p = placed_order(shop)
    stranger = shop.user()
    missing = get_attempts(shop, stranger, uuid4())
    for form in uuid_forms(p.order_id):
        for response in (
            pay(shop, stranger, form, "4242"),
            pay(shop, stranger, form, "0002"),
            shop.client.get(pay_path(form), headers=auth(stranger)),
        ):
            assert response.status_code in (404, 422), (form, response.text)
            if response.status_code == 404:
                assert response.json() == missing.json(), form
    assert attempt_rows(shop.session, p.order_id) == []
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


def test_the_owner_gets_the_same_order_whatever_the_uuid_form(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()
    first = pay(shop, p.user, p.order_id.hex.upper(), "4242", key=key)
    assert first.status_code == 201 and first.json()["order_id"] == str(p.order_id)
    again = pay(shop, p.user, "{" + str(p.order_id) + "}", "4242", key=key)
    assert again.status_code in (200, 422)  # nunca un segundo cobro por otra forma del id
    assert len(attempt_rows(shop.session, p.order_id)) == 1


# --------------------------------------------------------------------------------------------
# Tokens manipulados


def alg_none(sub: object) -> str:
    header = base64url_encode(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    body = base64url_encode(json.dumps(claims_for(str(sub))).encode())
    return f"{header.decode()}.{body.decode()}."


def tampered_tokens(owner: UUID) -> dict[str, str]:
    past = int((datetime.now(UTC) - timedelta(minutes=5)).timestamp())
    good = make_token(str(owner))
    header, body, signature = good.split(".")
    forged_body = base64url_encode(json.dumps(claims_for(str(uuid4()))).encode()).decode()
    return {
        "alg-none": alg_none(owner),
        "hs256-con-clave-publica": hs256_signed_with_public_key(str(owner)),
        "otra-clave": make_token(str(owner), key=OTHER_KEY),
        "clave-nueva-mismo-kid": make_token(
            str(owner), key=ec.generate_private_key(ec.SECP256R1())
        ),
        "kid-desconocido": make_token(str(owner), kid="otro"),
        "caducado": make_token(str(owner), exp=past),
        "aud-ajena": make_token(str(owner), aud="otra-app"),
        "iss-ajeno": make_token(str(owner), iss="https://evil.test/auth/v1"),
        "sin-sub": make_token(None),
        "sub-no-uuid": make_token("admin"),
        "cuerpo-cambiado": f"{header}.{forged_body}.{signature}",
        "firma-vacia": f"{header}.{body}.",
    }


@pytest.mark.parametrize("name", list(tampered_tokens(UUID(int=1))))
def test_a_tampered_token_is_401_on_both_routes_with_no_effect(shop: OrderShop, name: str) -> None:
    p = placed_order(shop)
    token = tampered_tokens(p.user)[name]
    headers = {"Authorization": f"Bearer {token}"}

    posted = pay(shop, None, p.order_id, "4242", headers=headers)
    read = shop.client.get(pay_path(p.order_id), headers=headers)

    assert posted.status_code == 401 and read.status_code == 401, (posted.text, read.text)
    assert attempt_rows(shop.session, p.order_id) == []
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


# --------------------------------------------------------------------------------------------
# Importe, identidad y resultado fuera del cuerpo: se ignoran


def test_amount_user_or_result_in_query_or_headers_never_change_the_charge(shop: OrderShop) -> None:
    p = placed_order(shop)
    stranger = shop.user()
    params = {
        "amount": "1",
        "total": "1",
        "currency": "USD",
        "user_id": str(stranger),
        "status": "approved",
        "card_last4": "0002",
    }
    headers = {
        "X-Amount": "1",
        "X-Total": "1",
        "X-User-Id": str(stranger),
        "X-Forwarded-User": str(stranger),
        "X-Payment-Result": "approved",
        "X-HTTP-Method-Override": "DELETE",
    }
    response = shop.client.post(
        pay_path(p.order_id),
        params=params,
        headers=auth(p.user) | headers | {"Idempotency-Key": new_key()},
        json={"card_last4": "4242"},
    )

    assert response.status_code == 201, response.text
    assert response.json()["amount"] == {"amount": p.total, "currency": "PEN"}
    assert response.json()["status"] == "approved"  # decidió el cuerpo, no la query
    [row] = attempt_rows(shop.session, p.order_id)
    assert row["user_id"] == p.user and row["amount"] == p.total


# --------------------------------------------------------------------------------------------
# `card_last4` hostil


@pytest.mark.parametrize(
    "value",
    [
        "٤٢٤٢",  # dígitos arábigo-índicos
        "４２４２",  # dígitos de ancho completo
        "৪২৪২",  # dígitos bengalíes
        "4242\n",
        "\n4242",
        " 4242",
        "42\x0042",
        "+424",
        "-424",
        "4.24",
        "4e10",
        "4242" + "​",
        "' OR 1=1 --",
        "<scr",
        "0x42",
    ],
)
def test_a_hostile_card_last4_is_422_without_echo_and_with_no_effect(
    shop: OrderShop, value: str
) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, value)

    assert response.status_code == 422, (value, response.text)
    assert value not in response.text and json.dumps(value)[1:-1] not in response.text
    assert attempt_rows(shop.session, p.order_id) == []


# --------------------------------------------------------------------------------------------
# Enumeración por tiempo y por forma: ajeno e inexistente se distinguen igual de poco


def test_foreign_and_missing_orders_are_not_distinguishable_by_time(shop: OrderShop) -> None:
    p = placed_order(shop)
    stranger = shop.user()

    def median_ms(order_id: object, method: str) -> float:
        samples = []
        for _ in range(25):
            start = time.perf_counter()
            if method == "get":
                response = shop.client.get(pay_path(order_id), headers=auth(stranger))
            else:
                response = pay(shop, stranger, order_id, "4242")
            samples.append((time.perf_counter() - start) * 1000)
            assert response.status_code == 404
        return statistics.median(samples)

    for method in ("get", "post"):
        median_ms(uuid4(), method)  # calentamiento
        foreign, missing = median_ms(p.order_id, method), median_ms(uuid4(), method)
        assert abs(foreign - missing) < max(10.0, 0.5 * min(foreign, missing)), (
            method,
            foreign,
            missing,
        )


# --------------------------------------------------------------------------------------------
# Tamaño del cuerpo (R-4: sin límite transversal todavía)


def test_a_huge_body_is_rejected_without_echo_or_500(shop: OrderShop) -> None:
    p = placed_order(shop)
    junk = "9" * 2_000_000
    huge_extra = json.dumps({"card_last4": "4242", "card_number": junk}).encode()
    huge_value = json.dumps({"card_last4": junk}).encode()

    for content in (huge_extra, huge_value):
        response = pay(shop, p.user, p.order_id, content=content)
        assert response.status_code == 422, response.text[:200]
        assert len(response.content) < 2_000 and junk[:64] not in response.text
    assert attempt_rows(shop.session, p.order_id) == []


def test_deeply_nested_json_is_a_4xx_not_a_500(shop: OrderShop) -> None:
    p = placed_order(shop)
    nested = ("[" * 50_000 + "]" * 50_000).encode()

    response = pay(shop, p.user, p.order_id, content=nested)

    assert 400 <= response.status_code < 500, response.status_code


# --------------------------------------------------------------------------------------------
# Ronda de datos de tarjeta (CA-07, RN-11): número y CVV por cualquier vía


def every_app_table_text(shop: OrderShop) -> str:
    tables = shop.session.scalars(
        text(
            "SELECT quote_ident(table_name) FROM information_schema.tables"
            " WHERE table_schema = 'app' AND table_type = 'BASE TABLE'"
        )
    ).all()
    return "\n".join(
        str(shop.session.scalars(text(f"SELECT t::text FROM app.{name} t")).all())  # noqa: S608
        for name in tables
    )


def test_the_card_number_and_cvv_sent_by_any_route_never_land_anywhere(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    p = placed_order(shop)
    q = placed_order(shop)
    card = {"card_number": FAKE_NUMBER, "cvv": FAKE_CVV, "pan": FAKE_NUMBER, "cvc": FAKE_CVV}
    sneaky_headers = {
        "X-Card-Number": FAKE_NUMBER,
        "X-CVV": FAKE_CVV,
        "Referer": f"https://shop.test/pay?card={FAKE_NUMBER}&cvv={FAKE_CVV}",
        "User-Agent": f"agent {FAKE_NUMBER}",
        "Cookie": f"card={FAKE_NUMBER}; cvv={FAKE_CVV}",
    }
    responses = [
        pay(shop, p.user, p.order_id, body={"card_last4": LAST4} | card),  # 422
        pay(shop, p.user, p.order_id, FAKE_NUMBER),  # 422
        pay(shop, p.user, p.order_id, body={"card_last4": [FAKE_NUMBER, FAKE_CVV]}),  # 422
        shop.client.post(
            pay_path(p.order_id),
            params=card,
            headers=auth(p.user) | sneaky_headers | {"Idempotency-Key": new_key()},
            json={"card_last4": LAST4},
        ),
        shop.client.get(pay_path(p.order_id), params=card, headers=auth(p.user) | sneaky_headers),
        pay(shop, q.user, q.order_id, "0119", headers=sneaky_headers),  # 503
        pay(shop, None, q.order_id, body=card),  # 401
        pay(shop, shop.user(), q.order_id, "4242", headers=sneaky_headers),  # 404
    ]

    statuses = [r.status_code for r in responses]
    assert statuses[:3] == [422, 422, 422] and statuses[5:] == [503, 401, 404], statuses
    for response in responses:
        assert FAKE_NUMBER not in response.text and FAKE_CVV not in response.text
        assert FAKE_NUMBER not in str(response.headers)
    stored = every_app_table_text(shop)
    assert FAKE_NUMBER not in stored and FAKE_CVV + '"' not in stored
    assert FAKE_NUMBER not in str(audit_rows(shop.session))
    # Solo los registros del servidor: el cliente de pruebas (httpx) registra su propia URL.
    log = "\n".join(
        r.getMessage() + str(r.exc_info or "")
        for r in caplog.records
        if not r.name.startswith("httpx")
    )
    assert "payments/orders" in log
    assert FAKE_NUMBER not in log and f"cvv={FAKE_CVV}" not in log and "Traceback" not in log


def test_an_unexpected_error_carrying_card_data_is_a_bare_500(shop: OrderShop, caplog: Any) -> None:
    from valmont.modules.payments.adapters.http import get_payment_gateway

    class Leaky:
        name = "leaky"

        def authorize(self, charge: Any) -> Any:
            raise RuntimeError(f"tarjeta {FAKE_NUMBER} cvv {FAKE_CVV} {charge}")

    shop.override(get_payment_gateway, lambda: Leaky())
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, LAST4)

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "internal_error",
            "message": "Error interno del servidor.",
            "details": None,
        }
    }
    assert FAKE_NUMBER not in response.text and "Traceback" not in response.text
    assert attempt_rows(shop.session, p.order_id) == [] and sales(shop.session, p.order_id) == []
