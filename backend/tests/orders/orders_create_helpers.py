"""Falsos y constructores de `CreateOrder` (T-074): repositorio, carrito, inventario, reloj,
boutique y auditoría en memoria, sin BD. Todos escriben en un registro común (`calls`) para
comprobar el orden del flujo de UC-ORDERS-01 y que un error no deja efectos. Datos ficticios."""

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from tests.orders.orders_helpers import shipping_delivery
from valmont.modules.audit.domain import AuditEntry
from valmont.modules.cart.application import CheckoutCart, CheckoutLine
from valmont.modules.inventory.application import ReservedOrder
from valmont.modules.inventory.domain import OnRequestLine, Reservation
from valmont.modules.inventory.domain import OrderLine as StockLine
from valmont.modules.orders.application import CreateOrder, PickupStore
from valmont.modules.orders.domain import (
    DeliveryDetails,
    IdempotencyConflict,
    Order,
)

NOW = datetime(2026, 12, 1, 15, 0, tzinfo=UTC)  # 10:00 en Lima
KEY = "clave-de-prueba-0001"
STORE = PickupStore("Boutique Valmont Miraflores", "Av. Larco 1234, Miraflores", "L-S 10:00-19:00")

SUMMARY_KEYS = {
    "id",
    "number",
    "status",
    "total",
    "item_count",
    "created_at",
    "expires_at",
    "estimated_delivery_on",
}
DETAIL_KEYS = SUMMARY_KEYS | {
    "paid_at",
    "expires_in_seconds",
    "subtotal",
    "shipping",
    "lines",
    "delivery",
    "refund",
    "history",
    "can_cancel",
}
LINE_KEYS = {
    "product_id",
    "sku",
    "name",
    "quantity",
    "list_price",
    "unit_price",
    "discount_amount",
    "line_total",
    "fulfillment",
    "lead_time_days",
    "image",
}


def checkout_line(**overrides: Any) -> CheckoutLine:
    fields: dict[str, Any] = {
        "product_id": uuid4(),
        "sku": "TST-CRE-0001",
        "name": "Reloj de prueba",
        "quantity": 1,
        "list_price": 100_000,
        "price": 100_000,
        "discount_amount": 0,
        "promotion_id": None,
        "availability_status": "in_stock",
        "lead_time_days": None,
    }
    return CheckoutLine(**(fields | overrides))


def checkout_of(*lines: CheckoutLine) -> CheckoutCart:
    return CheckoutCart(lines=tuple(lines), total=sum(ln.price * ln.quantity for ln in lines))


class Calls(list[str]):
    """Registro común de las llamadas a los falsos, en orden."""


@dataclass
class FakeOrders:
    calls: Calls
    stored: dict[tuple[UUID, str], Order] = field(default_factory=dict)
    pending: int = 0
    conflict: bool = False
    next_number: int = 123
    added: list[Order] = field(default_factory=list)
    count_args: list[tuple[UUID, datetime]] = field(default_factory=list)
    find_args: list[tuple[UUID, str]] = field(default_factory=list)

    def find_by_key(self, user_id: UUID, key: str) -> Order | None:
        self.calls.append("find")
        self.find_args.append((user_id, key))
        return self.stored.get((user_id, key))

    def count_pending(self, user_id: UUID, now: datetime) -> int:
        self.calls.append("count")
        self.count_args.append((user_id, now))
        return self.pending

    def add(self, order: Order) -> Order:
        self.calls.append("add")
        if self.conflict:
            raise IdempotencyConflict
        saved = replace(order, number=self.next_number)
        self.added.append(saved)
        self.stored[(order.user_id, order.idempotency_key)] = saved
        return saved


@dataclass
class FakePrepare:
    calls: Calls
    result: CheckoutCart | None = None
    error: Exception | None = None
    on_error: Callable[[], None] | None = None  # efecto de "otra solicitud confirmó entretanto"
    args: list[UUID] = field(default_factory=list)

    def __call__(self, user_id: UUID) -> CheckoutCart:
        self.calls.append("prepare")
        self.args.append(user_id)
        if self.error is not None:
            if self.on_error is not None:
                self.on_error()
            raise self.error
        assert self.result is not None
        return self.result


@dataclass
class FakeRemove:
    calls: Calls
    args: list[tuple[UUID, list[UUID]]] = field(default_factory=list)

    def __call__(self, user_id: UUID, product_ids: Any) -> None:
        self.calls.append("remove")
        self.args.append((user_id, list(product_ids)))


@dataclass
class FakeReserve:
    """Reserva todo salvo los productos de `on_request` (producto → plazo). `error` simula a
    inventory fallando (InsufficientStock, LookupError...)."""

    calls: Calls
    on_request: dict[UUID, int | None] = field(default_factory=dict)
    error: Exception | None = None
    args: list[tuple[UUID, list[StockLine], datetime]] = field(default_factory=list)

    def __call__(self, order_id: UUID, lines: list[StockLine], now: datetime) -> ReservedOrder:
        self.calls.append("reserve")
        self.args.append((order_id, list(lines), now))
        if self.error is not None:
            raise self.error
        expires_at = now + timedelta(minutes=30)
        return ReservedOrder(
            reservations=[
                Reservation(uuid4(), ln.product_id, order_id, ln.quantity, expires_at)
                for ln in lines
                if ln.product_id not in self.on_request
            ],
            on_request=[
                OnRequestLine(ln.product_id, ln.quantity, self.on_request[ln.product_id])
                for ln in lines
                if ln.product_id in self.on_request
            ],
        )


@dataclass
class FakeClock:
    """Cada llamada devuelve un instante distinto: si el caso de uso lee la hora dos veces, el
    pedido y las reservas no coinciden y las pruebas lo ven (un único `now`, ORDERS-R6)."""

    calls: Calls
    ticks: int = 0

    def now(self) -> datetime:
        self.calls.append("clock")
        self.ticks += 1
        return NOW + timedelta(seconds=self.ticks - 1)


@dataclass
class FakeStore:
    calls: Calls
    store: PickupStore | None = STORE

    def get(self) -> PickupStore | None:
        self.calls.append("store")
        return self.store


@dataclass
class FakeAudit:
    calls: Calls
    entries: list[AuditEntry] = field(default_factory=list)

    def record(self, entry: AuditEntry) -> None:
        self.calls.append("audit")
        self.entries.append(entry)


@dataclass
class Harness:
    calls: Calls
    orders: FakeOrders
    prepare: FakePrepare
    remove: FakeRemove
    reserve: FakeReserve
    clock: FakeClock
    store: FakeStore
    audit: FakeAudit
    use_case: CreateOrder

    def effects(self) -> list[str]:
        """Llamadas que escriben algo: reservar, guardar, vaciar el carrito, auditar."""
        return [c for c in self.calls if c in ("reserve", "add", "remove", "audit")]


def harness(*lines: CheckoutLine, store: PickupStore | None = STORE) -> Harness:
    calls = Calls()
    orders = FakeOrders(calls)
    prepare = FakePrepare(calls, result=checkout_of(*lines) if lines else None)
    remove = FakeRemove(calls)
    reserve = FakeReserve(calls)
    clock = FakeClock(calls)
    pickup = FakeStore(calls, store)
    audit = FakeAudit(calls)
    use_case = CreateOrder(orders, prepare, remove, reserve, pickup, clock, audit)  # type: ignore[arg-type]
    return Harness(calls, orders, prepare, remove, reserve, clock, pickup, audit, use_case)


def run(h: Harness, user: UUID, key: str = KEY, delivery: DeliveryDetails | None = None) -> Any:
    return h.use_case(user, key, delivery or shipping_delivery())
