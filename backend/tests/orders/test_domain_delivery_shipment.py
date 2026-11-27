"""`Delivery` (SPEC §5, R-11 ruta A de T-075): la entrega leída de la BD, con transportista,
seguimiento y fecha de envío. Un `Delivery` es un `DeliveryDetails`; en `pickup` ninguno de los tres
datos de envío existe. Sin BD."""

import dataclasses
from datetime import UTC, datetime
from uuid import uuid4

import pytest

from tests.orders.orders_helpers import make_line, pickup_delivery, shipping_delivery
from valmont.modules.orders.domain import (
    Delivery,
    DeliveryDetails,
    DeliveryInvalid,
    DeliveryMethod,
    Order,
    build_order,
)

SHIPPED_AT = datetime(2026, 12, 2, 14, 30, tzinfo=UTC)
SHIPMENT = {"carrier": "Olva", "tracking_code": "OL-123", "shipped_at": SHIPPED_AT}
PERSON = {"recipient_name": "Ana Pérez", "phone": "+51987654321"}
PLACE = {
    "department": "Lima",
    "province": "Lima",
    "district": "Miraflores",
    "address_line": "Av. Larco 1234, piso 5",
}


def shipping(**extra: object) -> Delivery:
    return Delivery(DeliveryMethod.SHIPPING, **PERSON, **PLACE, **extra)  # type: ignore[arg-type]


def pickup(**extra: object) -> Delivery:
    return Delivery(DeliveryMethod.PICKUP, **PERSON, **extra)  # type: ignore[arg-type]


def test_a_delivery_is_a_delivery_details_so_order_accepts_it() -> None:
    delivery = shipping(**SHIPMENT)

    assert isinstance(delivery, DeliveryDetails)
    order = build_order(
        uuid4(), uuid4(), "clave-de-prueba-0001", [make_line()], delivery, SHIPPED_AT
    )
    assert isinstance(order, Order) and order.delivery is delivery


def test_a_shipping_delivery_keeps_the_three_shipment_fields() -> None:
    delivery = shipping(**SHIPMENT)

    assert (delivery.carrier, delivery.tracking_code, delivery.shipped_at) == (
        "Olva",
        "OL-123",
        SHIPPED_AT,
    )


def test_the_three_shipment_fields_default_to_none() -> None:
    for delivery in (shipping(), pickup()):
        assert (delivery.carrier, delivery.tracking_code, delivery.shipped_at) == (None, None, None)


@pytest.mark.parametrize(
    "extra",
    [{"carrier": "Olva"}, {"tracking_code": "OL-123"}, {"shipped_at": SHIPPED_AT}, SHIPMENT],
    ids=["only carrier", "only tracking", "only shipped_at", "all three"],
)
def test_shipping_accepts_any_combination_of_shipment_fields(extra: dict[str, object]) -> None:
    delivery = shipping(**extra)

    for name, value in extra.items():
        assert getattr(delivery, name) == value


@pytest.mark.parametrize(
    ("name", "value"),
    [("carrier", "Olva"), ("tracking_code", "OL-123"), ("shipped_at", SHIPPED_AT)],
)
def test_pickup_with_any_shipment_field_is_invalid(name: str, value: object) -> None:
    with pytest.raises(DeliveryInvalid) as error:
        pickup(**{name: value})

    assert error.value.field == name
    assert isinstance(error.value, ValueError)


def test_pickup_with_all_the_shipment_fields_is_invalid() -> None:
    with pytest.raises(DeliveryInvalid):
        pickup(**SHIPMENT)


def test_a_delivery_still_applies_the_rules_of_delivery_details() -> None:
    with pytest.raises(DeliveryInvalid) as error:
        Delivery(DeliveryMethod.SHIPPING, **PERSON)  # sin dirección

    assert error.value.field in PLACE
    with pytest.raises(DeliveryInvalid) as error:
        Delivery(DeliveryMethod.PICKUP, **PERSON, district="Miraflores")
    assert error.value.field == "district"


def test_a_delivery_normalizes_like_delivery_details() -> None:
    delivery = Delivery(
        DeliveryMethod.SHIPPING,
        recipient_name="  Ana   Pérez ",
        phone=" +51 987 654 321 ",
        **{**PLACE, "district": " Santiago  de   Surco "},
    )

    assert delivery.recipient_name == "Ana Pérez"
    assert delivery.phone == "+51987654321"
    assert delivery.district == "Santiago de Surco"


def test_a_delivery_is_immutable() -> None:
    delivery = shipping(**SHIPMENT)

    with pytest.raises(dataclasses.FrozenInstanceError):
        delivery.carrier = "Shalom"  # type: ignore[misc]


def test_a_built_order_still_carries_a_plain_delivery_details() -> None:
    # `build_order` y T-074 no cambian: el pedido nuevo lleva el `DeliveryDetails` de la entrada.
    for plain in (shipping_delivery(), pickup_delivery()):
        order = build_order(
            uuid4(), uuid4(), "clave-de-prueba-0001", [make_line()], plain, SHIPPED_AT
        )
        assert order.delivery is plain
