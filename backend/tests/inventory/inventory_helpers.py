"""Datos de prueba de inventory. Ficticios; los productos se insertan por SQL porque inventory
no usa el código de catalog."""

from datetime import timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, insert, text
from sqlalchemy.orm import Session

from valmont.modules.inventory.adapters.persistence import (
    SqlMovementRepository,
    SqlProductPolicies,
    SqlReservationRepository,
    SqlStockRepository,
    StockReservationRow,
)
from valmont.modules.inventory.application import (
    ConsumeReservations,
    ReleaseReservations,
    ReserveStock,
)

LEAD_TIME_DAYS = 21


def add_product(session: Session, order_policy: str = "stock") -> UUID:
    """Producto mínimo en app.products (con su categoría)."""
    category_id, product_id, tag = uuid4(), uuid4(), uuid4().hex[:8]
    session.execute(
        text("INSERT INTO app.categories (id, slug, name) VALUES (:id, :slug, 'Inventario')"),
        {"id": category_id, "slug": f"inventario-{tag}"},
    )
    session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id,"
            " price_cents, order_policy, lead_time_days) VALUES (:id, :sku, :slug,"
            " 'Reloj de prueba', 'Reloj ficticio.', :category_id, 100000, :policy, :lead)"
        ),
        {
            "id": product_id,
            "sku": f"TST-INV-{tag}",
            "slug": f"inventario-{tag}",
            "category_id": category_id,
            "policy": order_policy,
            "lead": None if order_policy == "stock" else LEAD_TIME_DAYS,
        },
    )
    return product_id


def add_reservation(
    session: Session, product_id: UUID, quantity: int, status: str = "active", minutes: int = 30
) -> None:
    """Reserva que vence dentro de `minutes` minutos (en el pasado si es negativo)."""
    session.execute(
        insert(StockReservationRow).values(
            id=uuid4(),
            product_id=product_id,
            order_id=uuid4(),
            quantity=quantity,
            status=status,
            expires_at=func.now() + timedelta(minutes=minutes),
        )
    )


def reserve_stock(session: Session) -> ReserveStock:
    return ReserveStock(
        SqlProductPolicies(session), SqlStockRepository(session), SqlReservationRepository(session)
    )


def consume_reservations(session: Session) -> ConsumeReservations:
    return ConsumeReservations(
        SqlStockRepository(session),
        SqlReservationRepository(session),
        SqlMovementRepository(session),
    )


def release_reservations(session: Session) -> ReleaseReservations:
    return ReleaseReservations(SqlReservationRepository(session))
