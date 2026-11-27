"""T-018a y T-018b contra PostgreSQL: cabeceras en orders y payments, 413 sin efectos y el log de un
error de restricción real sin el `DETAIL` (R-10). Datos ficticios; nada persiste (SAVEPOINT de la
fixture `shop`, tabla temporal en una conexión sin pool)."""

import io
import logging
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from tests.identity.identity_helpers import make_token, use_test_auth
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import PATH, OrderShop, effects, place, quick
from tests.payments.pay_order_helpers import attempt_rows, pay, placed_order, rolling_back_shop
from tests.shared.hardening_helpers import HEX32, NO_STORE, assert_hardened
from valmont.main import create_app
from valmont.shared.hardening import MAX_BODY_BYTES
from valmont.shared.logs import configure_logging

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop

LEAKED = "valor-unico-b7e41c9a"  # lo que PostgreSQL pondría en `DETAIL: Key (code)=(...)`
CONSTRAINT = "uq_hardening_probe_code"


def auth_of(shop: OrderShop, user: object) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(str(user))}"}


# --- orders ---


def test_orders_201_409_401_404_422_and_503_are_all_hardened(
    shop: OrderShop, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, _ = quick(shop)

    created = place(shop, user)
    empty = place(shop, user)  # el carrito ya no tiene líneas seleccionadas
    anonymous = place(shop, None)
    invalid = place(shop, user, delivery={"delivery_method": "teletransporte"})
    unknown = shop.client.get(f"{PATH}/{uuid4()}", headers=auth_of(shop, user))
    listing = shop.client.get(PATH, headers=auth_of(shop, user))
    use_test_auth(monkeypatch, jwks=None)
    down = place(shop, user)

    expected = [
        (created, 201),
        (empty, 409),
        (anonymous, 401),
        (invalid, 422),
        (unknown, 404),
        (listing, 200),
        (down, 503),
    ]
    for response, status in expected:
        assert response.status_code == status, (status, response.text)
        assert_hardened(response)


def test_an_oversized_order_body_is_413_with_headers_and_creates_nothing(shop: OrderShop) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)
    headers = auth_of(shop, user) | {
        "Idempotency-Key": str(uuid4()),
        "Content-Type": "application/json",
    }
    big = b'{"delivery": {"reference": "' + b"x" * (MAX_BODY_BYTES + 1) + b'"}}'

    declared = shop.client.post(PATH, headers=headers, content=big)
    chunks = (big[i : i + 8192] for i in range(0, len(big), 8192))
    streamed = shop.client.post(PATH, headers=headers, content=chunks)

    for response in (declared, streamed):
        assert response.status_code == 413, response.text
        assert response.json()["error"]["code"] == "payload_too_large"
        assert_hardened(response)
        assert HEX32.fullmatch(response.headers["x-request-id"])
    assert effects(shop.session, user, product) == before


# --- payments ---


def test_payments_keep_their_own_no_store_once_and_every_status_is_hardened(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)

    approved = pay(shop, p.user, p.order_id, "4242")
    again = pay(shop, p.user, p.order_id, "4242")  # clave nueva: el pedido ya está pagado
    anonymous = pay(shop, None, p.order_id, "4242")
    unknown = pay(shop, p.user, uuid4(), "4242")
    invalid = pay(shop, p.user, p.order_id, body={"card_last4": "no-son-digitos"})
    listing = shop.client.get(
        f"/api/v1/payments/orders/{p.order_id}/attempts", headers=auth_of(shop, p.user)
    )

    expected = [
        (approved, 201),
        (again, 409),
        (anonymous, 401),
        (unknown, 404),
        (invalid, 422),
        (listing, 200),
    ]
    for response, status in expected:
        assert response.status_code == status, (status, response.text)
        assert_hardened(response)
        assert response.headers.get_list("cache-control") == [NO_STORE]  # sin duplicar


def test_a_payment_body_over_the_limit_is_413_and_makes_no_attempt(shop: OrderShop) -> None:
    p = placed_order(shop)
    headers = auth_of(shop, p.user) | {
        "Idempotency-Key": str(uuid4()),
        "Content-Type": "application/json",
    }

    response = shop.client.post(
        f"/api/v1/payments/orders/{p.order_id}/attempts",
        headers=headers,
        content=b'{"card_last4": "' + b"1" * (MAX_BODY_BYTES + 1) + b'"}',
    )

    assert response.status_code == 413
    assert_hardened(response)
    assert attempt_rows(shop.session, p.order_id) == []


# --- T-018b, prueba 3: un IntegrityError real no deja valores en el log ---


@pytest.fixture
def probe_app(db_engine: Engine, valmont_log: io.StringIO) -> FastAPI:
    """Una app cuya ruta provoca una `UniqueViolation` real en una conexión sin pool."""
    engine = create_engine(db_engine.url, hide_parameters=True, poolclass=NullPool)
    configure_logging("DEBUG")  # el nivel con el que `sqlalchemy.engine` volcaría SQL y valores
    app = create_app()

    @app.get("/api/v1/test/duplicate")
    def duplicate() -> None:
        with Session(engine) as session, session.begin():
            session.execute(
                text(
                    f"CREATE TEMP TABLE hardening_probe (code text CONSTRAINT {CONSTRAINT} UNIQUE)"
                )
            )
            for _ in range(2):
                session.execute(
                    text("INSERT INTO hardening_probe (code) VALUES (:value)"), {"value": LEAKED}
                )

    return app


def test_a_real_unique_violation_logs_sqlstate_and_constraint_but_never_the_values(
    probe_app: FastAPI, valmont_log: io.StringIO
) -> None:
    client = TestClient(probe_app, raise_server_exceptions=False)

    response = client.get("/api/v1/test/duplicate")

    output = valmont_log.getvalue()
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert LEAKED not in response.text
    assert "Error no controlado" in output
    assert "sqlstate=23505" in output
    assert f"constraint={CONSTRAINT}" in output
    assert LEAKED not in output
    assert "DETAIL:  Key" not in output
    assert f"=({LEAKED}" not in output
    assert "sqlalchemy.engine" not in output  # DEBUG no vuelca SQL ni parámetros
    assert logging.getLogger("sqlalchemy.engine").getEffectiveLevel() == logging.WARNING


def test_the_response_of_the_database_error_is_hardened_and_traceless(
    probe_app: FastAPI,
) -> None:
    client = TestClient(probe_app, raise_server_exceptions=False)

    response = client.get("/api/v1/test/duplicate")

    assert_hardened(response)
    assert "Traceback" not in response.text and "psycopg" not in response.text
