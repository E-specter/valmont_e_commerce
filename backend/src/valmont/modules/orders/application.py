from collections.abc import Collection
from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol
from uuid import UUID, uuid4

from valmont.modules.audit.application import AuditEntry, AuditRecorder
from valmont.modules.cart.application import EmptySelection, PrepareCheckout, RemoveCheckedOutItems
from valmont.modules.inventory.application import OrderLine as ReserveLine
from valmont.modules.inventory.application import ReserveStock
from valmont.modules.orders.domain import (
    MAX_PENDING_ORDERS,
    DeliveryDetails,
    DeliveryMethod,
    Fulfillment,
    Order,
    OrderLine,
    OrderStatus,
    PickupUnavailable,
    StatusChange,
    TooManyPendingOrders,
    build_order,
)

# Puertos y datos de lectura de orders (SPEC §6, §7; T-073) y casos de uso (T-074+).


class Clock(Protocol):
    def now(self) -> datetime:
        """Hora de la BD (UTC con zona): la de inicio de la transacción."""
        ...


@dataclass(frozen=True)
class OrderSummary:
    id: UUID
    number: int
    user_id: UUID
    status: OrderStatus
    total_amount: int
    item_count: int  # suma de cantidades
    created_at: datetime
    expires_at: datetime
    estimated_delivery_on: date | None
    recipient_name: str
    district: str | None


@dataclass(frozen=True)
class OrderPage:
    items: tuple[OrderSummary, ...]
    total: int
    page: int
    page_size: int


@dataclass(frozen=True)
class AdminOrderQuery:
    status: OrderStatus | None
    q: str | None
    created_from: date | None  # fechas de America/Lima, ambas incluidas (R17)
    created_to: date | None
    page: int
    page_size: int


class OrderRepository(Protocol):
    def add(self, order: Order) -> Order:
        """Inserta pedido, líneas, entrega e historial inicial y asigna `number`.
        Lanza IdempotencyConflict si choca (user_id, idempotency_key). Sin commit."""
        ...

    def find_by_key(self, user_id: UUID, key: str) -> Order | None: ...

    def count_pending(self, user_id: UUID, now: datetime) -> int: ...

    def get(
        self, order_id: UUID, *, user_id: UUID | None = None, lock: bool = False
    ) -> Order | None: ...

    def list_for_user(
        self, user_id: UUID, *, status: OrderStatus | None, page: int, page_size: int
    ) -> OrderPage: ...

    def list_all(self, query: AdminOrderQuery) -> OrderPage: ...

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
        """Con la fila ya bloqueada por quien llama: compara `change.from_status` (si no
        coincide, InvalidTransition), cambia el estado e inserta el historial."""
        ...

    def expire_overdue(
        self,
        now: datetime,
        *,
        user_id: UUID | None = None,
        order_ids: Collection[UUID] | None = None,
        limit: int = 200,
    ) -> list[Order]:
        """Pasa a `expirado` los vencidos (FOR UPDATE SKIP LOCKED, por id) y devuelve los
        que cambió, con su historial `system`."""
        ...


@dataclass(frozen=True)
class PickupStore:
    name: str
    address: str
    hours: str


class PickupStoreProvider(Protocol):
    def get(self) -> PickupStore | None:
        """None si falta algún dato de la boutique (H-1, H-5)."""
        ...


@dataclass(frozen=True)
class CreatedOrder:
    order: Order
    created: bool  # False si repite la clave (200)


class CreateOrder:
    """UC-ORDERS-01 (R2…R6, R8, R9, R11). Sin commit: lo confirma o deshace la transacción."""

    def __init__(
        self,
        orders: OrderRepository,
        prepare: PrepareCheckout,
        remove: RemoveCheckedOutItems,
        reserve: ReserveStock,
        pickup_store: PickupStoreProvider,
        clock: Clock,
        audit: AuditRecorder,
    ) -> None:
        self._orders = orders
        self._prepare = prepare
        self._remove = remove
        self._reserve = reserve
        self._pickup_store = pickup_store
        self._clock = clock
        self._audit = audit

    def __call__(
        self, user_id: UUID, idempotency_key: str, delivery: DeliveryDetails
    ) -> CreatedOrder:
        now = self._clock.now()  # el mismo para el pedido y las reservas (R6)
        if existing := self._orders.find_by_key(user_id, idempotency_key):
            return CreatedOrder(existing, False)
        if delivery.delivery_method == DeliveryMethod.PICKUP and self._pickup_store.get() is None:
            raise PickupUnavailable
        try:
            checkout = self._prepare(user_id)  # bloquea el carrito (R4)
        except EmptySelection:
            # Otra solicitud con la misma clave pudo confirmar mientras esperaba el bloqueo (R8).
            if existing := self._orders.find_by_key(user_id, idempotency_key):
                return CreatedOrder(existing, False)
            raise
        if self._orders.count_pending(user_id, now) >= MAX_PENDING_ORDERS:
            raise TooManyPendingOrders
        order_id = uuid4()
        reserved = self._reserve(
            order_id, [ReserveLine(line.product_id, line.quantity) for line in checkout.lines], now
        )
        stocked = {r.product_id for r in reserved.reservations}
        lead_times = {r.product_id: r.lead_time_days for r in reserved.on_request}
        lines = [
            OrderLine(
                product_id=line.product_id,
                sku=line.sku,
                name=line.name,
                quantity=line.quantity,
                list_price=line.list_price,
                unit_price=line.price,
                discount_amount=line.discount_amount,
                promotion_id=line.promotion_id,
                fulfillment=Fulfillment.STOCK
                if line.product_id in stocked
                else Fulfillment.MADE_TO_ORDER,
                lead_time_days=None
                if line.product_id in stocked
                else lead_times.get(line.product_id) or line.lead_time_days,
            )
            for line in checkout.lines
        ]
        order = self._orders.add(
            build_order(order_id, user_id, idempotency_key, lines, delivery, now)
        )
        self._remove(user_id, [line.product_id for line in order.lines])
        self._audit.record(
            AuditEntry(
                "orders.created",
                "order",
                str(order.id),
                user_id,
                "customer",
                after={
                    "status": order.status.value,
                    "number": order.number,
                    "total_amount": order.total_amount,
                    "line_count": len(order.lines),
                },
            )
        )
        return CreatedOrder(order, True)
