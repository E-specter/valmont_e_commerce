"""orders: bidi e invisibles en el texto de entrada, por HTTP con PostgreSQL (T-018d, D-047 D-H2).

Entrega del cliente (`POST /orders`: destinatario y dirección) y administración
(`POST /orders/admin/{id}/transitions`: nota, `carrier`, `tracking_code`). Un valor con un carácter
oculto es 422 `validation_error` con el `loc` del campo, sin escribir nada y sin devolver el valor.
Datos ficticios."""

from typing import Any

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import admin_of
from tests.orders.orders_http_helpers import PICKUP, SHIPPING, OrderShop, effects, place, quick
from tests.orders.orders_transition_helpers import fingerprint, moved, paid, post_transition
from tests.orders.test_create_order_http import assert_422_in_delivery

pytestmark = pytest.mark.integration

shop = helpers.shop
MARK = "Marcador"
HIDDEN = ["‮", "⁧", "​", "‍", "﻿", "­", "⁠", "‏"]
FILLERS = ["ㅤ", "⠀", "ﾠ", "ᅟ", "͏"]


def assert_no_echo(response: Any, char: str) -> None:
    assert MARK not in response.text
    assert char not in response.text
    assert f"\\u{ord(char):04x}" not in response.text.lower()


# --- Entrega (cliente) ---


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize(
    "field", ["recipient_name", "address_line", "reference", "department", "province", "district"]
)
def test_a_hidden_char_in_a_shipping_text_is_422_on_that_field_and_creates_nothing(
    shop: OrderShop, field: str, char: str
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=SHIPPING | {field: f"Lima {MARK}{char}"})

    assert_422_in_delivery(response, field)
    assert_no_echo(response, char)
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("char", ["‮", "​"])
def test_a_hidden_char_in_the_pickup_recipient_is_422(shop: OrderShop, char: str) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=PICKUP | {"recipient_name": f"Ana{char}Torres"})

    assert_422_in_delivery(response, "recipient_name")
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("char", ["‮", "​"])
def test_a_hidden_char_in_the_phone_is_422(shop: OrderShop, char: str) -> None:
    user, product = quick(shop)

    response = place(shop, user, delivery=SHIPPING | {"phone": f"98765432{char}1"})

    assert_422_in_delivery(response, "phone")
    assert effects(shop.session, user, product)["orders"] == 0


@pytest.mark.parametrize("char", ["‮", "​"])
def test_a_hidden_char_at_the_edges_is_422(shop: OrderShop, char: str) -> None:
    user, _ = quick(shop)

    for name in (f"{char}Ana Torres", f"Ana Torres{char}"):
        response = place(shop, user, delivery=SHIPPING | {"recipient_name": name})
        assert_422_in_delivery(response, "recipient_name")


@pytest.mark.parametrize("filler", FILLERS, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize("field", ["recipient_name", "address_line", "district"])
def test_a_required_text_made_only_of_a_filler_is_422(
    shop: OrderShop, field: str, filler: str
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=SHIPPING | {field: filler * 5})

    assert_422_in_delivery(response, field)
    assert effects(shop.session, user, product) == before


def test_a_zwj_compound_emoji_in_the_recipient_is_422(shop: OrderShop) -> None:
    user, _ = quick(shop)

    response = place(shop, user, delivery=SHIPPING | {"recipient_name": "Ana \U0001f469‍\U0001f4bb"})

    assert_422_in_delivery(response, "recipient_name")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("recipient_name", "José Núñez"),
        ("recipient_name", "李小龍 Ana"),
        ("recipient_name", "O’Brien – Ana é"),
        ("address_line", "Calle 5 de Mayo #123, Lima"),
        ("address_line", "Av. Peña — piso 4 \U0001f600"),
        ("reference", "Frente al parque “Central”"),
    ],
)
def test_legitimate_delivery_text_is_still_accepted_and_stored(
    shop: OrderShop, field: str, value: str
) -> None:
    user, _ = quick(shop)

    response = place(shop, user, delivery=SHIPPING | {field: value})

    assert response.status_code == 201, response.text
    assert response.json()["delivery"][field] == value


# --- Administración: transición ---


def _ready(shop: OrderShop) -> tuple[Any, str]:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    moved(shop, admin, order_id, "en_preparacion")
    return admin, order_id


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
def test_a_hidden_char_in_carrier_or_tracking_is_422_and_nothing_moves(
    shop: OrderShop, field: str, char: str
) -> None:
    admin, order_id = _ready(shop)
    before = fingerprint(shop.session, order_id)

    response = post_transition(
        shop, admin, order_id, {"to": "enviado", field: f"Olva {MARK}{char}Express"}
    )

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"][0]["loc"][-1] == field
    assert_no_echo(response, char)
    assert fingerprint(shop.session, order_id) == before


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
def test_a_hidden_char_in_the_cancellation_note_is_422_and_nothing_moves(
    shop: OrderShop, char: str
) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    before = fingerprint(shop.session, order_id)

    response = post_transition(
        shop, admin, order_id, {"to": "cancelado", "note": f"Línea 1\nMotivo {MARK}{char}"}
    )

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"][0]["loc"][-1] == "note"
    assert_no_echo(response, char)
    assert fingerprint(shop.session, order_id) == before


@pytest.mark.parametrize("filler", FILLERS, ids=lambda c: f"U+{ord(c):04X}")
def test_a_filler_in_carrier_is_422_even_though_a_visible_part_is_not_required(
    shop: OrderShop, filler: str
) -> None:
    admin, order_id = _ready(shop)
    before = fingerprint(shop.session, order_id)

    response = post_transition(shop, admin, order_id, {"to": "enviado", "carrier": filler})

    assert response.status_code == 422, response.text
    assert fingerprint(shop.session, order_id) == before


def test_the_note_keeps_its_newline_and_legitimate_text_is_accepted(shop: OrderShop) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)

    response = post_transition(
        shop, admin, order_id, {"to": "cancelado", "note": "Cliente: José Núñez\nPedido duplicado"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelado"


def test_legitimate_carrier_and_tracking_are_accepted(shop: OrderShop) -> None:
    admin, order_id = _ready(shop)

    response = post_transition(
        shop,
        admin,
        order_id,
        {"to": "enviado", "carrier": "Olva Courier – Perú", "tracking_code": "OL-1"},
    )

    assert response.status_code == 200, response.text


@pytest.mark.parametrize("field", ["recipient_name", "address_line"])
@pytest.mark.parametrize("value", ["\ue000\ue000", "\u0378\u0378"])
def test_a_required_text_without_any_visible_char_that_is_not_unsafe_is_422(
    shop: OrderShop, field: str, value: str
) -> None:
    # Uso privado (Co) y sin asignar (Cn): no son Cf ni relleno, pero no se ven.
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=SHIPPING | {field: value})

    assert_422_in_delivery(response, field)
    assert effects(shop.session, user, product) == before
