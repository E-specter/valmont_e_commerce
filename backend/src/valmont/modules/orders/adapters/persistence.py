from collections.abc import Collection
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
    insert,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.orders.application import AdminOrderQuery, OrderPage, OrderSummary
from valmont.modules.orders.domain import (
    _LIMA,
    ActorKind,
    Delivery,
    DeliveryDetails,
    DeliveryMethod,
    Fulfillment,
    IdempotencyConflict,
    InvalidTransition,
    Order,
    OrderLine,
    OrderStatus,
    StatusChange,
)
from valmont.shared.db import Base

# SPEC orders §6. Solo las escribe orders; app.profiles y app.products son de identity y catalog y
# aquí solo se referencian con FK (modules.md §3, excepción 6).

_STATUSES = ", ".join(f"'{status.value}'" for status in OrderStatus)
_PAID = "'pagado','en_preparacion','enviado','listo_para_recojo','entregado'"
_IDEMPOTENCY_UNIQUE = "uq_orders_user_id_idempotency_key"


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class OrderRow(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint(f"status IN ({_STATUSES})", name="status"),
        CheckConstraint(
            "char_length(idempotency_key) BETWEEN 16 AND 64", name="idempotency_key_length"
        ),
        CheckConstraint("subtotal_amount > 0", name="subtotal_positive"),
        CheckConstraint("shipping_amount >= 0", name="shipping_non_negative"),
        CheckConstraint("total_amount = subtotal_amount + shipping_amount", name="total_sum"),
        CheckConstraint("expires_at > created_at", name="expires_after_created"),
        CheckConstraint(f"status NOT IN ({_PAID}) OR paid_at IS NOT NULL", name="paid_at_set"),
        CheckConstraint("(refunded_amount IS NULL) = (refunded_at IS NULL)", name="refund_pair"),
        CheckConstraint(
            "refunded_amount IS NULL OR (status = 'cancelado' AND refunded_amount = total_amount)",
            name="refund_total",
        ),
        UniqueConstraint("order_number", name="uq_orders_order_number"),
        UniqueConstraint("user_id", "idempotency_key", name=_IDEMPOTENCY_UNIQUE),
        Index("ix_orders_user_id_created_at", "user_id", text("created_at DESC"), text("id DESC")),
        Index("ix_orders_status_created_at", "status", text("created_at DESC")),
        Index(
            "ix_orders_expires_at_pending",
            "expires_at",
            postgresql_where=text("status = 'pendiente_pago'"),
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    order_number: Mapped[int] = mapped_column(BigInteger, Identity(always=True))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("app.profiles.user_id", ondelete="RESTRICT"))
    status: Mapped[str] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(Text)
    subtotal_amount: Mapped[int] = mapped_column(BigInteger)
    shipping_amount: Mapped[int] = mapped_column(BigInteger, server_default="0")
    total_amount: Mapped[int] = mapped_column(BigInteger)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    estimated_delivery_on: Mapped[date | None] = mapped_column(Date)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_amount: Mapped[int | None] = mapped_column(BigInteger)
    refunded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class OrderLineRow(Base):
    __tablename__ = "order_lines"
    __table_args__ = (
        CheckConstraint("position >= 1", name="position"),
        CheckConstraint("quantity BETWEEN 1 AND 100", name="quantity"),
        CheckConstraint("list_price_amount > 0", name="list_price"),
        CheckConstraint("unit_price_amount > 0", name="unit_price"),
        CheckConstraint("discount_amount >= 0", name="discount"),
        CheckConstraint(
            "discount_amount = list_price_amount - unit_price_amount", name="discount_sum"
        ),
        CheckConstraint("line_total_amount = unit_price_amount * quantity", name="line_total"),
        CheckConstraint("fulfillment IN ('stock','made_to_order')", name="fulfillment"),
        CheckConstraint("lead_time_days IS NULL OR lead_time_days > 0", name="lead_time"),
        UniqueConstraint("order_id", "product_id", name="uq_order_lines_order_id_product_id"),
        UniqueConstraint("order_id", "position", name="uq_order_lines_order_id_position"),
        Index("ix_order_lines_product_id", "product_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    order_id: Mapped[UUID] = mapped_column(ForeignKey("app.orders.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(SmallInteger)
    product_id: Mapped[UUID] = mapped_column(ForeignKey("app.products.id", ondelete="RESTRICT"))
    sku: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(SmallInteger)
    list_price_amount: Mapped[int] = mapped_column(BigInteger)
    unit_price_amount: Mapped[int] = mapped_column(BigInteger)
    discount_amount: Mapped[int] = mapped_column(BigInteger)
    line_total_amount: Mapped[int] = mapped_column(BigInteger)
    promotion_id: Mapped[UUID | None]  # sin FK: dato histórico (RN-04)
    fulfillment: Mapped[str] = mapped_column(Text)
    lead_time_days: Mapped[int | None] = mapped_column(Integer)


class DeliveryRow(Base):
    __tablename__ = "deliveries"
    __table_args__ = (
        CheckConstraint("delivery_method IN ('shipping','pickup')", name="method"),
        CheckConstraint(
            "delivery_method <> 'shipping' OR (department IS NOT NULL AND province IS NOT NULL "
            "AND district IS NOT NULL AND address_line IS NOT NULL)",
            name="shipping_location",
        ),
        CheckConstraint(
            "delivery_method <> 'pickup' OR (department IS NULL AND province IS NULL "
            "AND district IS NULL AND address_line IS NULL AND reference IS NULL "
            "AND carrier IS NULL AND tracking_code IS NULL AND shipped_at IS NULL)",
            name="pickup_clean",
        ),
    )

    order_id: Mapped[UUID] = mapped_column(
        ForeignKey("app.orders.id", ondelete="CASCADE"), primary_key=True
    )
    delivery_method: Mapped[str] = mapped_column(Text)
    recipient_name: Mapped[str] = mapped_column(Text)
    phone: Mapped[str] = mapped_column(Text)
    department: Mapped[str | None] = mapped_column(Text)
    province: Mapped[str | None] = mapped_column(Text)
    district: Mapped[str | None] = mapped_column(Text)
    address_line: Mapped[str | None] = mapped_column(Text)
    reference: Mapped[str | None] = mapped_column(Text)
    carrier: Mapped[str | None] = mapped_column(Text)
    tracking_code: Mapped[str | None] = mapped_column(Text)
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OrderStatusHistoryRow(Base):
    """Solo inserción (también en la BD: valmont_app no tiene UPDATE ni DELETE)."""

    __tablename__ = "order_status_history"
    __table_args__ = (
        CheckConstraint(f"from_status IS NULL OR from_status IN ({_STATUSES})", name="from_status"),
        CheckConstraint(f"to_status IN ({_STATUSES})", name="to_status"),
        CheckConstraint("actor_kind IN ('customer','admin','system')", name="actor_kind"),
        CheckConstraint("from_status IS NOT NULL OR to_status = 'pendiente_pago'", name="initial"),
        CheckConstraint("(actor_kind = 'system') = (actor_id IS NULL)", name="actor"),
        Index("ix_order_status_history_order_id_id", "order_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    order_id: Mapped[UUID] = mapped_column(ForeignKey("app.orders.id", ondelete="CASCADE"))
    from_status: Mapped[str | None] = mapped_column(Text)
    to_status: Mapped[str] = mapped_column(Text)
    actor_kind: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[UUID | None]
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()


def _history_values(order_id: UUID, change: StatusChange) -> dict[str, Any]:
    return {
        "order_id": order_id,
        "from_status": change.from_status.value if change.from_status else None,
        "to_status": change.to_status.value,
        "actor_kind": change.actor_kind.value,
        "actor_id": change.actor_id,
        "note": change.note,
        "created_at": change.at,
    }


def _delivery(row: DeliveryRow) -> DeliveryDetails:
    """`Delivery` solo si hay datos de envío; si no, `DeliveryDetails` (igual que el de `add`)."""
    common: dict[str, Any] = {
        "delivery_method": DeliveryMethod(row.delivery_method),
        "recipient_name": row.recipient_name,
        "phone": row.phone,
        "department": row.department,
        "province": row.province,
        "district": row.district,
        "address_line": row.address_line,
        "reference": row.reference,
    }
    if row.carrier is None and row.tracking_code is None and row.shipped_at is None:
        return DeliveryDetails(**common)
    return Delivery(
        **common, carrier=row.carrier, tracking_code=row.tracking_code, shipped_at=row.shipped_at
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _lima_midnight(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=_LIMA).astimezone(UTC)


class SqlClock:
    def __init__(self, session: Session) -> None:
        self._session = session

    def now(self) -> datetime:
        return self._session.execute(select(func.now())).scalar_one()


class SqlOrderRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    # --- Escritura ---

    def add(self, order: Order) -> Order:
        d = order.delivery
        try:
            number = self._session.execute(
                insert(OrderRow)
                .values(
                    id=order.id,
                    user_id=order.user_id,
                    status=order.status.value,
                    idempotency_key=order.idempotency_key,
                    subtotal_amount=order.subtotal_amount,
                    shipping_amount=order.shipping_amount,
                    total_amount=order.total_amount,
                    expires_at=order.expires_at,
                    estimated_delivery_on=order.estimated_delivery_on,
                    paid_at=order.paid_at,
                    refunded_amount=order.refunded_amount,
                    refunded_at=order.refunded_at,
                    created_at=order.created_at,
                    updated_at=order.created_at,
                )
                .returning(OrderRow.order_number)
            ).scalar_one()
        except IntegrityError as exc:
            if _IDEMPOTENCY_UNIQUE in str(exc.orig):
                raise IdempotencyConflict() from exc
            raise
        self._session.execute(
            insert(OrderLineRow),
            [
                {
                    "id": uuid4(),
                    "order_id": order.id,
                    "position": position,
                    "product_id": line.product_id,
                    "sku": line.sku,
                    "name": line.name,
                    "quantity": line.quantity,
                    "list_price_amount": line.list_price,
                    "unit_price_amount": line.unit_price,
                    "discount_amount": line.discount_amount,
                    "line_total_amount": line.line_total,
                    "promotion_id": line.promotion_id,
                    "fulfillment": line.fulfillment.value,
                    "lead_time_days": line.lead_time_days,
                }
                for position, line in enumerate(order.lines, start=1)
            ],
        )
        self._session.execute(
            insert(DeliveryRow).values(
                order_id=order.id,
                delivery_method=d.delivery_method.value,
                recipient_name=d.recipient_name,
                phone=d.phone,
                department=d.department,
                province=d.province,
                district=d.district,
                address_line=d.address_line,
                reference=d.reference,
            )
        )
        if order.history:
            self._session.execute(
                insert(OrderStatusHistoryRow),
                [_history_values(order.id, change) for change in order.history],
            )
        return replace(order, number=number)

    def apply(
        self,
        order_id: UUID,
        change: StatusChange,
        *,
        paid: bool = False,
        refund_amount: int | None = None,
        carrier: str | None = None,
        tracking_code: str | None = None,
    ) -> Order:
        if change.from_status is None:
            raise ValueError("Un cambio de estado necesita from_status")
        values: dict[str, Any] = {"status": change.to_status.value, "updated_at": func.now()}
        if paid:
            values["paid_at"] = change.at
        if refund_amount is not None:
            values.update(refunded_amount=refund_amount, refunded_at=change.at)
        # Comparar y cambiar en una sola sentencia: la fila ya está bloqueada por quien llama.
        updated = self._session.execute(
            update(OrderRow)
            .where(OrderRow.id == order_id, OrderRow.status == change.from_status.value)
            .values(**values)
        )
        if updated.rowcount != 1:
            raise InvalidTransition(change.from_status, change.to_status, frozenset())
        if change.to_status == OrderStatus.SHIPPED:
            # shipped_at siempre; transportista y seguimiento solo si llegan (SPEC §5).
            shipped: dict[str, Any] = {"shipped_at": change.at}
            if carrier is not None:
                shipped["carrier"] = carrier
            if tracking_code is not None:
                shipped["tracking_code"] = tracking_code
            self._session.execute(
                update(DeliveryRow).where(DeliveryRow.order_id == order_id).values(**shipped)
            )
        self._session.execute(
            insert(OrderStatusHistoryRow).values(_history_values(order_id, change))
        )
        order = self.get(order_id)
        assert order is not None
        return order

    def expire_overdue(
        self,
        now: datetime,
        *,
        user_id: UUID | None = None,
        order_ids: Collection[UUID] | None = None,
        limit: int = 200,
    ) -> list[Order]:
        if order_ids is not None and not order_ids:
            return []
        pick = select(OrderRow.id).where(
            OrderRow.status == OrderStatus.PENDING_PAYMENT.value, OrderRow.expires_at <= now
        )
        if user_id is not None:
            pick = pick.where(OrderRow.user_id == user_id)
        if order_ids is not None:
            pick = pick.where(OrderRow.id.in_(order_ids))
        # Las filas que otra transacción tiene bloqueadas (un pago o una cancelación) se saltan.
        ids = (
            self._session.execute(
                pick.order_by(OrderRow.id).limit(limit).with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        if not ids:
            return []
        self._session.execute(
            update(OrderRow)
            .where(OrderRow.id.in_(ids))
            .values(status=OrderStatus.EXPIRED.value, updated_at=func.now())
        )
        self._session.execute(
            insert(OrderStatusHistoryRow),
            [
                _history_values(
                    order_id,
                    StatusChange(
                        OrderStatus.PENDING_PAYMENT,
                        OrderStatus.EXPIRED,
                        ActorKind.SYSTEM,
                        None,
                        None,
                        now,
                    ),
                )
                for order_id in ids
            ],
        )
        return [order for order_id in ids if (order := self.get(order_id)) is not None]

    # --- Lectura ---

    def find_by_key(self, user_id: UUID, key: str) -> Order | None:
        order_id = self._session.execute(
            select(OrderRow.id).where(OrderRow.user_id == user_id, OrderRow.idempotency_key == key)
        ).scalar_one_or_none()
        return None if order_id is None else self.get(order_id)

    def count_pending(self, user_id: UUID, now: datetime) -> int:
        return self._session.execute(
            select(func.count())
            .select_from(OrderRow)
            .where(
                OrderRow.user_id == user_id,
                OrderRow.status == OrderStatus.PENDING_PAYMENT.value,
                OrderRow.expires_at > now,
            )
        ).scalar_one()

    def get(
        self, order_id: UUID, *, user_id: UUID | None = None, lock: bool = False
    ) -> Order | None:
        stmt = select(OrderRow).where(OrderRow.id == order_id)
        if user_id is not None:
            stmt = stmt.where(OrderRow.user_id == user_id)
        if lock:
            stmt = stmt.with_for_update()
        # populate_existing: tras `apply` (UPDATE por Core) la fila en sesión puede estar vieja.
        row = self._session.execute(
            stmt.execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if row is None:
            return None
        lines = self._session.execute(
            select(OrderLineRow)
            .where(OrderLineRow.order_id == order_id)
            .order_by(OrderLineRow.position)
        ).scalars()
        delivery = self._session.execute(
            select(DeliveryRow).where(DeliveryRow.order_id == order_id)
        ).scalar_one()
        history = self._session.execute(
            select(OrderStatusHistoryRow)
            .where(OrderStatusHistoryRow.order_id == order_id)
            .order_by(OrderStatusHistoryRow.id)
        ).scalars()
        return Order(
            id=row.id,
            number=row.order_number,
            user_id=row.user_id,
            status=OrderStatus(row.status),
            lines=tuple(
                OrderLine(
                    product_id=line.product_id,
                    sku=line.sku,
                    name=line.name,
                    quantity=line.quantity,
                    list_price=line.list_price_amount,
                    unit_price=line.unit_price_amount,
                    discount_amount=line.discount_amount,
                    promotion_id=line.promotion_id,
                    fulfillment=Fulfillment(line.fulfillment),
                    lead_time_days=line.lead_time_days,
                )
                for line in lines
            ),
            delivery=_delivery(delivery),
            shipping_amount=row.shipping_amount,
            created_at=row.created_at,
            expires_at=row.expires_at,
            estimated_delivery_on=row.estimated_delivery_on,
            paid_at=row.paid_at,
            refunded_amount=row.refunded_amount,
            refunded_at=row.refunded_at,
            history=tuple(
                StatusChange(
                    from_status=OrderStatus(h.from_status) if h.from_status else None,
                    to_status=OrderStatus(h.to_status),
                    actor_kind=ActorKind(h.actor_kind),
                    actor_id=h.actor_id,
                    note=h.note,
                    at=h.created_at,
                )
                for h in history
            ),
            idempotency_key=row.idempotency_key,
        )

    def list_for_user(
        self,
        user_id: UUID,
        *,
        statuses: Collection[OrderStatus] | None,
        page: int,
        page_size: int,
    ) -> OrderPage:
        conditions = [OrderRow.user_id == user_id]
        if statuses is not None:
            conditions.append(OrderRow.status.in_([s.value for s in statuses]))
        return self._page(conditions, page, page_size)

    def list_all(self, query: AdminOrderQuery) -> OrderPage:
        conditions = []
        if query.status is not None:
            conditions.append(OrderRow.status == query.status.value)
        if query.created_from is not None:
            conditions.append(OrderRow.created_at >= _lima_midnight(query.created_from))
        if query.created_to is not None:
            conditions.append(
                OrderRow.created_at < _lima_midnight(query.created_to + timedelta(days=1))
            )
        term = (query.q or "").strip()
        if term:
            matches = [DeliveryRow.recipient_name.ilike(f"%{_escape_like(term)}%", escape="\\")]
            digits = term.upper().removeprefix("VAL-")
            # bigint: un número mayor no puede existir; no se consulta (sin error de la BD).
            if digits.isascii() and digits.isdigit() and int(digits) <= 2**63 - 1:
                matches.append(OrderRow.order_number == int(digits))
            conditions.append(or_(*matches))
        return self._page(conditions, query.page, query.page_size)

    def _page(self, conditions: list[Any], page: int, page_size: int) -> OrderPage:
        item_count = (
            select(func.coalesce(func.sum(OrderLineRow.quantity), 0))
            .where(OrderLineRow.order_id == OrderRow.id)
            .scalar_subquery()
        )
        total = self._session.execute(
            select(func.count())
            .select_from(OrderRow)
            .join(DeliveryRow, DeliveryRow.order_id == OrderRow.id)
            .where(*conditions)
        ).scalar_one()
        rows = self._session.execute(
            select(OrderRow, DeliveryRow.recipient_name, DeliveryRow.district, item_count)
            .join(DeliveryRow, DeliveryRow.order_id == OrderRow.id)
            .where(*conditions)
            .order_by(OrderRow.created_at.desc(), OrderRow.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()
        return OrderPage(
            items=tuple(
                OrderSummary(
                    id=row.id,
                    number=row.order_number,
                    user_id=row.user_id,
                    status=OrderStatus(row.status),
                    total_amount=row.total_amount,
                    item_count=int(count),
                    created_at=row.created_at,
                    expires_at=row.expires_at,
                    estimated_delivery_on=row.estimated_delivery_on,
                    recipient_name=recipient,
                    district=district,
                )
                for row, recipient, district, count in rows
            ),
            total=total,
            page=page,
            page_size=page_size,
        )
