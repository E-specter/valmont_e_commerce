"""Límites de entrada de la administración de orders (T-085; SPEC §7, R13): `carrier` y
`tracking_code` se recortan y miden 1–60, sin caracteres de control; `note` rechaza sustitutos
sueltos; el filtro por fecha admite 2000-01-01…2100-12-31. Datos ficticios."""

from typing import Any

import pytest
from pydantic import ValidationError

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import ADMIN_PATH, admin_of
from tests.orders.orders_http_helpers import OrderShop
from tests.orders.orders_read_helpers import headers
from tests.orders.orders_transition_helpers import (
    delivery_columns,
    fingerprint,
    moved,
    paid,
    post_transition,
)
from valmont.modules.orders.adapters.admin_http import TransitionIn

shop = helpers.shop


def _ready(shop: OrderShop) -> tuple[Any, str]:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    moved(shop, admin, order_id, "en_preparacion")
    return admin, order_id


# --- carrier y tracking_code: recorte y 1–60 (unidad sobre el esquema público del cuerpo) ---


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
@pytest.mark.parametrize("value", ["   ", "\t", "\u00a0 "])
def test_a_blank_carrier_or_tracking_is_rejected_by_the_body_schema(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        TransitionIn.model_validate({"to": "enviado", field: value})


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
def test_carrier_and_tracking_are_trimmed_and_bounded_by_the_body_schema(field: str) -> None:
    assert (
        getattr(TransitionIn.model_validate({"to": "enviado", field: "  Olva  "}), field) == "Olva"
    )
    ok = "x" * 60
    assert getattr(TransitionIn.model_validate({"to": "enviado", field: f" {ok} "}), field) == ok
    with pytest.raises(ValidationError):
        TransitionIn.model_validate({"to": "enviado", field: "x" * 61})


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
@pytest.mark.parametrize("value", ["a\x00b", "a\x07b", "a\ud800b", "a\x1fb", "a\nb", "a\r\nb"])
def test_controls_and_lone_surrogates_in_carrier_or_tracking_are_rejected_by_the_schema(
    field: str, value: str
) -> None:
    with pytest.raises(ValidationError):
        TransitionIn.model_validate({"to": "enviado", field: value})


@pytest.mark.parametrize("value", ["\ud800", "Motivo \udfff interno", "a\x00b"])
def test_a_lone_surrogate_or_nul_in_the_note_is_rejected_by_the_body_schema(value: str) -> None:
    with pytest.raises(ValidationError):
        TransitionIn.model_validate({"to": "cancelado", "note": value})


def test_the_note_keeps_its_newlines() -> None:
    body = TransitionIn.model_validate({"to": "cancelado", "note": "Línea 1\nLínea 2"})
    assert body.note == "Línea 1\nLínea 2"


# --- Por HTTP: 422 en el formato común, sin cambios, y recorte al guardar ---

HTTP = pytest.mark.integration


@HTTP
@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
@pytest.mark.parametrize("value", ["   ", ""])
def test_a_blank_carrier_or_tracking_is_422_over_http_and_nothing_moves(
    shop: OrderShop, field: str, value: str
) -> None:
    admin, order_id = _ready(shop)
    before = fingerprint(shop.session, order_id)

    response = post_transition(shop, admin, order_id, {"to": "enviado", field: value})

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert response.json()["error"]["details"][0]["loc"][-1] == field
    assert fingerprint(shop.session, order_id) == before


@HTTP
def test_a_padded_carrier_and_tracking_are_stored_trimmed(shop: OrderShop) -> None:
    admin, order_id = _ready(shop)

    response = post_transition(
        shop, admin, order_id, {"to": "enviado", "carrier": "  Olva  ", "tracking_code": " OL-1 "}
    )

    assert response.status_code == 200, response.text
    carrier, tracking, _ = delivery_columns(shop.session, order_id)
    assert (carrier, tracking) == ("Olva", "OL-1")


# --- Filtro por fecha: 2000-01-01…2100-12-31 ---


@HTTP
@pytest.mark.parametrize("name", ["created_from", "created_to"])
@pytest.mark.parametrize("day", ["1999-12-31", "2101-01-01"])
def test_a_filter_date_outside_the_range_is_422(shop: OrderShop, name: str, day: str) -> None:
    response = shop.client.get(ADMIN_PATH, headers=headers(admin_of(shop)), params={name: day})

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert response.json()["error"]["details"][0]["loc"][-1] == name


@HTTP
@pytest.mark.parametrize("name", ["created_from", "created_to"])
@pytest.mark.parametrize("day", ["2000-01-01", "2100-12-31"])
def test_a_filter_date_on_the_range_edges_is_200(shop: OrderShop, name: str, day: str) -> None:
    response = shop.client.get(ADMIN_PATH, headers=headers(admin_of(shop)), params={name: day})

    assert response.status_code == 200, response.text
    assert "items" in response.json()


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
@HTTP
def test_a_newline_in_carrier_or_tracking_is_422_over_http_and_nothing_moves(
    shop: OrderShop, field: str
) -> None:
    admin, order_id = _ready(shop)
    before = fingerprint(shop.session, order_id)

    response = post_transition(shop, admin, order_id, {"to": "enviado", field: "Olva\nExpress"})

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert response.json()["error"]["details"][0]["loc"][-1] == field
    assert fingerprint(shop.session, order_id) == before


@HTTP
def test_a_note_with_a_newline_is_still_accepted_over_http(shop: OrderShop) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)

    response = post_transition(
        shop, admin, order_id, {"to": "cancelado", "note": "Línea 1\nLínea 2"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelado"
