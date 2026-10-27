from collections.abc import Collection
from dataclasses import asdict, replace
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ColumnElement,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Row,
    Select,
    SmallInteger,
    Text,
    Uuid,
    column,
    func,
    insert,
    or_,
    select,
    table,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.inventory.domain import (
    Availability,
    AvailabilityStatus,
    InventorySettings,
    MovementKind,
    ProductPolicy,
    Reservation,
    ReservationStatus,
    StockItem,
    StockMovement,
    StockPage,
    StockQuery,
    StockView,
)
from valmont.shared.db import Base

# Tablas de la SPEC inventory §6. Solo las escribe inventory.

# app.products es de catalog: aquí solo se referencia su id (FK) y se leen, sin escribirlas, las
# columnas que permite modules.md §3, excepción (4).
_PRODUCT_ID = "app.products.id"
_products = table(
    "products",
    column("id", Uuid),
    column("sku", Text),
    column("name", Text),
    column("status", Text),
    column("order_policy", Text),
    column("lead_time_days", Integer),
    schema="app",
)

# Contrato de lectura para catalog (SPEC §6, migración 0005). Fuera de Base.metadata: es una
# vista, y autogenerate la tomaría por una tabla que falta.
_availability = table(
    "product_availability",
    column("product_id", Uuid),
    column("available", Integer),
    column("status", Text),
    column("lead_time_days", Integer),
    schema="app",
)


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


def _product_fk() -> Mapped[UUID]:
    return mapped_column(ForeignKey(_PRODUCT_ID, ondelete="RESTRICT"))


class InventoryItemRow(Base):
    __tablename__ = "inventory_items"
    __table_args__ = (CheckConstraint("on_hand >= 0", name="on_hand"),)

    product_id: Mapped[UUID] = mapped_column(
        ForeignKey(_PRODUCT_ID, ondelete="RESTRICT"), primary_key=True
    )
    on_hand: Mapped[int] = mapped_column(server_default=text("0"))
    updated_at: Mapped[datetime] = _now()


class StockReservationRow(Base):
    __tablename__ = "stock_reservations"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity"),
        CheckConstraint("status IN ('active', 'consumed', 'released')", name="status"),
        Index(
            "ix_stock_reservations_product_id_status_expires_at",
            "product_id",
            "status",
            "expires_at",
        ),
        Index("ix_stock_reservations_order_id", "order_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    product_id: Mapped[UUID] = _product_fk()
    order_id: Mapped[UUID]  # FK a app.orders cuando exista (STATUS, discrepancias)
    quantity: Mapped[int]
    status: Mapped[str] = mapped_column(Text, server_default="active")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class StockMovementRow(Base):
    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('entrada', 'ajuste_inventario', 'merma', 'devolucion', 'venta')",
            name="kind",
        ),
        CheckConstraint("quantity_delta <> 0", name="quantity_delta"),
        CheckConstraint("on_hand_after >= 0", name="on_hand_after"),
        CheckConstraint(
            "kind NOT IN ('ajuste_inventario', 'merma') OR note IS NOT NULL", name="note_required"
        ),
        Index("ix_stock_movements_product_id_created_at", "product_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    product_id: Mapped[UUID] = _product_fk()
    kind: Mapped[str] = mapped_column(Text)
    quantity_delta: Mapped[int]
    on_hand_after: Mapped[int]
    note: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[UUID | None]
    order_id: Mapped[UUID | None]
    created_at: Mapped[datetime] = _now()


class InventorySettingsRow(Base):
    """Una sola fila (id = 1), insertada por la migración 0005."""

    __tablename__ = "inventory_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        CheckConstraint("low_stock_threshold >= 1", name="low_stock_threshold"),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    low_stock_threshold: Mapped[int] = mapped_column(server_default=text("2"))  # D-027
    updated_at: Mapped[datetime] = _now()


def _movement(row: StockMovementRow) -> StockMovement:
    return StockMovement(
        product_id=row.product_id,
        kind=MovementKind(row.kind),
        quantity_delta=row.quantity_delta,
        on_hand_after=row.on_hand_after,
        note=row.note,
        actor_id=row.actor_id,
        order_id=row.order_id,
        id=row.id,
        created_at=row.created_at,
    )


class SqlStockRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def lock(self, product_id: UUID) -> StockItem | None:
        # Crea la fila sin carreras (ON CONFLICT espera a quien la esté creando) y después la
        # bloquea. Se inserta desde products: si el producto no existe no se viola la FK (que
        # abortaría la transacción) y el SELECT devuelve None.
        create = (
            pg_insert(InventoryItemRow)
            .from_select(["product_id"], select(_products.c.id).where(_products.c.id == product_id))
            .on_conflict_do_nothing(index_elements=["product_id"])
        )
        self._session.execute(create)
        stmt = select(InventoryItemRow.on_hand).filter_by(product_id=product_id).with_for_update()
        on_hand = self._session.scalar(stmt)
        return None if on_hand is None else StockItem(product_id, on_hand)

    def update(self, item: StockItem) -> None:
        stmt = (
            update(InventoryItemRow)
            .filter_by(product_id=item.product_id)
            .values(on_hand=item.on_hand, updated_at=func.now())
        )
        self._session.execute(stmt.execution_options(synchronize_session=False))


class SqlMovementRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, movement: StockMovement) -> StockMovement:
        values = {k: v for k, v in asdict(movement).items() if k not in ("id", "created_at")}
        stmt = (
            insert(StockMovementRow)
            .values(**values)
            .returning(StockMovementRow.id, StockMovementRow.created_at)
        )
        movement_id, created_at = self._session.execute(stmt).one()
        return replace(movement, id=movement_id, created_at=created_at)

    def list_recent(self, product_id: UUID, limit: int) -> list[StockMovement]:
        stmt = (
            select(StockMovementRow)
            .filter_by(product_id=product_id)
            .order_by(StockMovementRow.created_at.desc(), StockMovementRow.id.desc())
            .limit(limit)
        )
        return [_movement(row) for row in self._session.scalars(stmt)]


class SqlSettingsRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, lock: bool = False) -> InventorySettings:
        stmt = select(InventorySettingsRow.low_stock_threshold).filter_by(id=1)
        if lock:
            stmt = stmt.with_for_update()
        return InventorySettings(self._session.scalars(stmt).one())

    def update(self, settings: InventorySettings) -> None:
        stmt = (
            update(InventorySettingsRow)
            .filter_by(id=1)
            .values(low_stock_threshold=settings.low_stock_threshold, updated_at=func.now())
        )
        self._session.execute(stmt.execution_options(synchronize_session=False))


def _reservation(row: StockReservationRow) -> Reservation:
    return Reservation(
        id=row.id,
        product_id=row.product_id,
        order_id=row.order_id,
        quantity=row.quantity,
        expires_at=row.expires_at,
        status=ReservationStatus(row.status),
    )


class SqlReservationRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, reservation: Reservation) -> None:
        self._session.execute(insert(StockReservationRow).values(**asdict(reservation)))

    def active_totals(self, product_ids: Collection[UUID], now: datetime) -> dict[UUID, int]:
        # Una sola sentencia para todos los productos, ya bloqueados por quien llama (R4).
        stmt = (
            select(StockReservationRow.product_id, func.sum(StockReservationRow.quantity))
            .where(
                StockReservationRow.product_id.in_(product_ids),
                StockReservationRow.status == ReservationStatus.ACTIVE,
                StockReservationRow.expires_at > now,
            )
            .group_by(StockReservationRow.product_id)
        )
        return {product_id: int(total) for product_id, total in self._session.execute(stmt)}

    def for_order(self, order_id: UUID, lock: bool = False) -> list[Reservation]:
        stmt = (
            select(StockReservationRow)
            .filter_by(order_id=order_id)
            .order_by(StockReservationRow.product_id, StockReservationRow.id)
        )
        if lock:
            stmt = stmt.with_for_update()
        stmt = stmt.execution_options(populate_existing=True)
        return [_reservation(row) for row in self._session.scalars(stmt)]

    def latest_expiry(self, product_ids: Collection[UUID]) -> datetime | None:
        stmt = select(func.max(StockReservationRow.expires_at)).where(
            StockReservationRow.product_id.in_(product_ids),
            StockReservationRow.status == ReservationStatus.ACTIVE,
        )
        return self._session.scalar(stmt)

    def close(self, reservation_ids: Collection[UUID], status: ReservationStatus) -> None:
        stmt = (
            update(StockReservationRow)
            .where(StockReservationRow.id.in_(reservation_ids))
            .values(status=status)
        )
        self._session.execute(stmt.execution_options(synchronize_session=False))


class SqlProductPolicies:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, product_ids: Collection[UUID]) -> dict[UUID, ProductPolicy]:
        p = _products.c
        stmt = select(p.id, p.order_policy, p.lead_time_days).where(p.id.in_(product_ids))
        return {
            row.id: ProductPolicy(row.order_policy, row.lead_time_days)
            for row in self._session.execute(stmt)
        }


class SqlAvailabilityReader:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, product_id: UUID) -> Availability | None:
        stmt = select(_availability).where(_availability.c.product_id == product_id)
        row = self._session.execute(stmt).one_or_none()
        if row is None:
            return None
        return Availability(
            row.product_id, row.available, AvailabilityStatus(row.status), row.lead_time_days
        )


_LIKE_ESCAPE = "/"


def _matches(column: ColumnElement[Any], value: str) -> ColumnElement[bool]:
    """Coincidencia parcial sin tildes ni mayúsculas (SPEC §7), con la misma app.f_unaccent que
    la búsqueda de catalog. %, _ y el escape del texto son literales; viaja como parámetro."""
    for char in (_LIKE_ESCAPE, "%", "_"):  # el escape, el primero
        value = value.replace(char, _LIKE_ESCAPE + char)
    pattern = func.app.f_unaccent(f"%{value}%")
    return func.app.f_unaccent(column).ilike(pattern, escape=_LIKE_ESCAPE)


def _stock_select() -> Select[Any]:
    # Todos los productos, con o sin fila de stock (SPEC §7); lo reservado y el estado salen de
    # la vista, con el mismo reloj (now() de la BD) y el mismo umbral que ve catalog.
    p = _products.c
    return (
        select(
            p.id.label("product_id"),
            p.sku,
            p.name,
            p.status.label("product_status"),
            func.coalesce(InventoryItemRow.on_hand, 0).label("on_hand"),
            _availability.c.available,
            _availability.c.status,
        )
        .select_from(_products)
        .join(_availability, _availability.c.product_id == p.id)
        .outerjoin(InventoryItemRow, InventoryItemRow.product_id == p.id)
    )


def _stock_view(row: Row[Any]) -> StockView:
    return StockView(
        product_id=row.product_id,
        sku=row.sku,
        name=row.name,
        product_status=row.product_status,
        on_hand=row.on_hand,
        reserved=row.on_hand - row.available,  # la vista: available = on_hand − reservas (R1)
        available=row.available,
        status=AvailabilityStatus(row.status),
    )


class SqlStockReader:
    def __init__(self, session: Session) -> None:
        self._session = session

    def list_all(self, query: StockQuery) -> StockPage:
        conditions: list[ColumnElement[bool]] = []
        if query.status is not None:
            conditions.append(_availability.c.status == query.status)
        if query.q is not None:
            conditions.append(
                or_(_matches(_products.c.sku, query.q), _matches(_products.c.name, query.q))
            )
        rows = _stock_select().where(*conditions)
        total = self._session.scalar(select(func.count()).select_from(rows.subquery()))
        page = (
            rows.order_by(_products.c.sku)  # único: paginación estable
            .limit(query.page_size)
            .offset((query.page - 1) * query.page_size)
        )
        return StockPage([_stock_view(row) for row in self._session.execute(page)], total or 0)

    def get(self, product_id: UUID) -> StockView | None:
        stmt = _stock_select().where(_products.c.id == product_id)
        row = self._session.execute(stmt).one_or_none()
        return None if row is None else _stock_view(row)
