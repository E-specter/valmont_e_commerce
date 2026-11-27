"""`Idempotency-Key` de `POST /api/v1/orders` solo UUID (T-018c, D-047 D-H1; ORDERS-R8). Contra
PostgreSQL en la transacción de la prueba. Una clave que no es UUID es 422 sin ningún efecto, y el
valor enviado no vuelve en el cuerpo ni se escribe en los logs. Datos ficticios."""

import logging
from typing import Any

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import OrderShop, audit_rows, effects, order_row, place, quick
from tests.shared.idempotency_key_helpers import BAD_KEYS, PAN, VALID_UUID

pytestmark = pytest.mark.integration

shop = helpers.shop
UPPER = VALID_UUID.upper()
DASHED_PAN = "-".join(PAN[i : i + 4] for i in range(0, 16, 4))


def send(shop: OrderShop, user: Any, value: str) -> Any:
    """Envía el valor tal cual (también el vacío, que `place(key="")` sustituiría por uno nuevo)."""
    return place(shop, user, key=None, headers={"Idempotency-Key": value})


# --------------------------------------------------------------------------------------------
# Un UUID pasa y la repetición sigue siendo idempotente


@pytest.mark.parametrize("value", [VALID_UUID, UPPER], ids=["minusculas", "mayusculas"])
def test_a_uuid_key_creates_the_order_in_any_capitalisation(shop: OrderShop, value: str) -> None:
    user, _ = quick(shop)

    response = place(shop, user, key=value)

    assert response.status_code == 201, response.text
    # Normalizada a minúsculas: lo que se guarda es la clave canónica.
    assert order_row(shop.session, response.json()["id"])["idempotency_key"] == VALID_UUID


def test_repeating_a_uuid_key_returns_the_same_order_as_before(shop: OrderShop) -> None:
    user, product = quick(shop)

    first = place(shop, user, key=VALID_UUID)
    after_first = effects(shop.session, user, product)
    again = place(shop, user, key=VALID_UUID)

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json() == first.json()
    assert effects(shop.session, user, product) == after_first  # la repetición no compra


def test_the_same_key_in_another_capitalisation_returns_the_same_order(shop: OrderShop) -> None:
    user, product = quick(shop)

    first = place(shop, user, key=UPPER)
    after_first = effects(shop.session, user, product)
    again = place(shop, user, key=VALID_UUID)

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"]
    assert effects(shop.session, user, product) == after_first


def test_a_generated_uuid4_works_as_the_checkout_will_send_it(shop: OrderShop) -> None:
    user, _ = quick(shop)

    assert place(shop, user, key=helpers.fresh_key()).status_code == 201


# --------------------------------------------------------------------------------------------
# Lo que no es un UUID: 422, sin efectos y sin eco del valor


@pytest.mark.parametrize("value", BAD_KEYS.values(), ids=BAD_KEYS.keys())
def test_a_key_that_is_not_a_uuid_is_422_on_the_header_and_has_no_effect(
    shop: OrderShop, value: str
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)
    audit_before = audit_rows(shop.session, actor_id=user)

    response = send(shop, user, value)

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(
        [str(p).lower() for p in d["loc"]] == ["header", "idempotency-key"]
        for d in error["details"]
    ), error
    assert effects(shop.session, user, product) == before  # ni pedido, ni reserva, ni auditoría
    assert audit_rows(shop.session, actor_id=user) == audit_before


@pytest.mark.parametrize(
    "value",
    [v for v in BAD_KEYS.values() if v.strip()],
    ids=[k for k, v in BAD_KEYS.items() if v.strip()],
)
def test_the_rejected_key_is_neither_in_the_body_nor_in_the_logs(
    shop: OrderShop, caplog: pytest.LogCaptureFixture, value: str
) -> None:
    user, _ = quick(shop)
    caplog.set_level(logging.DEBUG)

    response = send(shop, user, value)

    assert response.status_code == 422
    for text in (response.text, caplog.text):
        assert value.strip() not in text
        assert value.strip()[:12] not in text


def test_a_card_number_cannot_be_used_as_the_key(shop: OrderShop) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    plain = send(shop, user, PAN)
    dashed = send(shop, user, DASHED_PAN)

    assert plain.status_code == dashed.status_code == 422
    assert effects(shop.session, user, product) == before


def test_the_header_is_still_required(shop: OrderShop) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, key=None)

    assert response.status_code == 422, response.text
    assert effects(shop.session, user, product) == before
