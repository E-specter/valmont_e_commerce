"""`Idempotency-Key` de `POST /api/v1/payments/orders/{id}/attempts` solo UUID (T-018c, D-047 D-H1;
payments R3 y E-P5). Contra PostgreSQL en la transacción de la fixture `shop`. Una clave que no es
UUID es 422 sin intento, sin cambio del pedido y sin auditoría, y el valor no vuelve en el cuerpo
ni se escribe en los logs. Datos ficticios."""

import logging
from typing import Any

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import OrderShop
from tests.payments.pay_order_helpers import (
    DECLINED,
    any_audit_since,
    attempt_rows,
    pay,
    placed_order,
    rolling_back_shop,
    status_of,
)
from tests.shared.idempotency_key_helpers import BAD_KEYS, PAN, VALID_UUID

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop
UPPER = VALID_UUID.upper()
DASHED_PAN = "-".join(PAN[i : i + 4] for i in range(0, 16, 4))


def send(shop: OrderShop, p: Any, value: str) -> Any:
    """Envía el valor tal cual (también el vacío, que `pay(key="")` sustituiría por uno nuevo)."""
    headers = {"Idempotency-Key": value}
    return pay(shop, p.user, p.order_id, "4242", key=None, headers=headers)


# --------------------------------------------------------------------------------------------
# Un UUID pasa y la repetición sigue siendo idempotente


@pytest.mark.parametrize("value", [VALID_UUID, UPPER], ids=["minusculas", "mayusculas"])
def test_a_uuid_key_records_the_attempt_in_any_capitalisation(shop: OrderShop, value: str) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242", key=value)

    assert response.status_code == 201, response.text
    [row] = attempt_rows(shop.session, p.order_id)
    assert row["idempotency_key"] == VALID_UUID  # la clave canónica, en minúsculas


def test_repeating_a_uuid_key_returns_the_same_attempt_as_before(shop: OrderShop) -> None:
    p = placed_order(shop)

    first = pay(shop, p.user, p.order_id, "4242", key=VALID_UUID)
    again = pay(shop, p.user, p.order_id, "4242", key=VALID_UUID)

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json() == first.json()
    assert len(attempt_rows(shop.session, p.order_id)) == 1


def test_the_same_key_in_another_capitalisation_returns_the_same_attempt(shop: OrderShop) -> None:
    p = placed_order(shop)

    first = pay(shop, p.user, p.order_id, DECLINED, key=UPPER)
    again = pay(shop, p.user, p.order_id, DECLINED, key=VALID_UUID)

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"]
    assert len(attempt_rows(shop.session, p.order_id)) == 1


def test_a_generated_uuid4_works_as_the_payment_page_will_send_it(shop: OrderShop) -> None:
    p = placed_order(shop)

    assert pay(shop, p.user, p.order_id, "4242", key="").status_code == 201  # new_key() = uuid4


# --------------------------------------------------------------------------------------------
# Lo que no es un UUID: 422, sin efectos y sin eco del valor


@pytest.mark.parametrize("value", BAD_KEYS.values(), ids=BAD_KEYS.keys())
def test_a_key_that_is_not_a_uuid_is_422_on_the_header_and_has_no_effect(
    shop: OrderShop, value: str
) -> None:
    p = placed_order(shop)
    audit_before = any_audit_since(shop.session, p.user)

    response = send(shop, p, value)

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(
        [str(part).lower() for part in d["loc"]] == ["header", "idempotency-key"]
        for d in error["details"]
    ), error
    assert attempt_rows(shop.session, p.order_id) == []
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert any_audit_since(shop.session, p.user) == audit_before


@pytest.mark.parametrize(
    "value",
    [v for v in BAD_KEYS.values() if v.strip()],
    ids=[k for k, v in BAD_KEYS.items() if v.strip()],
)
def test_the_rejected_key_is_neither_in_the_body_nor_in_the_logs(
    shop: OrderShop, caplog: pytest.LogCaptureFixture, value: str
) -> None:
    p = placed_order(shop)
    caplog.set_level(logging.DEBUG)

    response = send(shop, p, value)

    assert response.status_code == 422
    for text in (response.text, caplog.text):
        assert value.strip() not in text
        assert value.strip()[:12] not in text


def test_a_card_number_cannot_be_used_as_the_key(shop: OrderShop) -> None:
    p = placed_order(shop)

    plain = send(shop, p, PAN)
    dashed = send(shop, p, DASHED_PAN)

    assert plain.status_code == dashed.status_code == 422
    assert attempt_rows(shop.session, p.order_id) == []


def test_the_header_is_still_required(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242", key=None)

    assert response.status_code == 422, response.text
    assert attempt_rows(shop.session, p.order_id) == []
