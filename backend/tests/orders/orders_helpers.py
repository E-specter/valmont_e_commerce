"""Constructores de datos ficticios del dominio de orders (T-072). Sin BD."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from valmont.modules.orders.domain import (
    DeliveryDetails,
    DeliveryMethod,
    Fulfillment,
    OrderLine,
)

NOW = datetime(2026, 12, 1, 15, 0, tzinfo=UTC)  # 10:00 en Lima


def shipping_delivery(**overrides: str | None) -> DeliveryDetails:
    fields: dict[str, str | None] = {
        "recipient_name": "Ana Pérez",
        "phone": "+51987654321",
        "department": "Lima",
        "province": "Lima",
        "district": "Miraflores",
        "address_line": "Av. Larco 1234, piso 5",
        "reference": "Frente al parque",
    }
    fields.update(overrides)
    return DeliveryDetails(DeliveryMethod.SHIPPING, **fields)  # type: ignore[arg-type]


def pickup_delivery(**overrides: str | None) -> DeliveryDetails:
    fields: dict[str, str | None] = {"recipient_name": "Ana Pérez", "phone": "987654321"}
    fields.update(overrides)
    return DeliveryDetails(DeliveryMethod.PICKUP, **fields)  # type: ignore[arg-type]


def make_line(
    *,
    quantity: int = 1,
    list_price: int = 100_000,
    unit_price: int | None = None,
    fulfillment: Fulfillment = Fulfillment.STOCK,
    lead_time_days: int | None = None,
    promotion_id: UUID | None = None,
    sku: str = "TST-ORD-0001",
    name: str = "Reloj de prueba",
) -> OrderLine:
    unit = list_price if unit_price is None else unit_price
    return OrderLine(
        product_id=uuid4(),
        sku=sku,
        name=name,
        quantity=quantity,
        list_price=list_price,
        unit_price=unit,
        discount_amount=list_price - unit,
        promotion_id=promotion_id,
        fulfillment=fulfillment,
        lead_time_days=lead_time_days,
    )
