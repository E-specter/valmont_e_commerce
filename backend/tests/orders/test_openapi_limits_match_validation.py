"""El `maxLength` que el OpenAPI de `POST /api/v1/orders` declara para cada campo de la entrega
coincide EXACTAMENTE con el límite que aplica la validación real (T-018e; ORDERS-R13). Se lee el
tope del OpenAPI de la app; con N caracteres la solicitud pasa y con N+1 da el mismo 422 con el
campo de siempre. Si el OpenAPI prometiera otro límite, estas pruebas fallan. Datos ficticios."""

from typing import Any

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import PICKUP, SHIPPING, OrderShop, place, quick
from valmont.modules.orders.domain import OrderStatus

pytestmark = pytest.mark.integration

shop = helpers.shop

FIELDS = [
    ("ShippingIn", SHIPPING, "recipient_name"),
    ("ShippingIn", SHIPPING, "phone"),
    ("ShippingIn", SHIPPING, "department"),
    ("ShippingIn", SHIPPING, "province"),
    ("ShippingIn", SHIPPING, "district"),
    ("ShippingIn", SHIPPING, "address_line"),
    ("ShippingIn", SHIPPING, "reference"),
    ("PickupIn", PICKUP, "recipient_name"),
    ("PickupIn", PICKUP, "phone"),
]


def declared_limit(shop: OrderShop, schema: str, field: str) -> int:
    node = shop.app.openapi()["components"]["schemas"][schema]["properties"][field]
    limits = [n["maxLength"] for n in (node, *node.get("anyOf", [])) if "maxLength" in n]
    assert len(limits) == 1, (schema, field, node)
    return limits[0]


def text_of(field: str, length: int) -> str:
    # El teléfono es "+" y dígitos; el resto, letras (sin espacios: no se recortan).
    return "+" + "9" * (length - 1) if field == "phone" else "a" * length


@pytest.mark.parametrize(
    ("schema", "base", "field"), FIELDS, ids=[f"{s}.{f}" for s, _, f in FIELDS]
)
def test_a_value_of_the_declared_length_passes_and_one_more_is_the_usual_422(
    shop: OrderShop, schema: str, base: dict[str, Any], field: str
) -> None:
    limit = declared_limit(shop, schema, field)
    user, _ = quick(shop)

    ok = place(shop, user, delivery=base | {field: text_of(field, limit)})
    too_long = place(shop, user, delivery=base | {field: text_of(field, limit + 1)})

    assert ok.status_code == 201, (field, limit, ok.text)
    assert too_long.status_code == 422, (field, limit, too_long.text)
    error = too_long.json()["error"]
    assert error["code"] == "validation_error"
    assert any(d["loc"][-1] == field for d in error["details"]), error["details"]
    assert all(set(d) == {"loc", "type", "msg"} for d in error["details"])  # sin eco del valor


def test_the_status_filter_limit_equals_the_number_of_statuses(shop: OrderShop) -> None:
    [param] = [
        p
        for p in shop.app.openapi()["paths"]["/api/v1/orders"]["get"]["parameters"]
        if p["name"] == "status"
    ]
    limits = [
        n["maxItems"]
        for n in (param["schema"], *param["schema"].get("anyOf", []))
        if "maxItems" in n
    ]

    assert limits == [len(OrderStatus)]


def test_a_delivery_text_over_the_declared_limit_that_fits_once_normalised_is_accepted(
    shop: OrderShop,
) -> None:
    limit = declared_limit(shop, "ShippingIn", "recipient_name")
    user, _ = quick(shop)
    spaced = "  ".join(["a" * 41, "b" * 38])  # 80 al colapsar, 81 sin colapsar

    response = place(shop, user, delivery=SHIPPING | {"recipient_name": spaced})

    assert len(spaced) > limit
    assert response.status_code == 201, response.text
    assert response.json()["delivery"]["recipient_name"] == " ".join(["a" * 41, "b" * 38])
