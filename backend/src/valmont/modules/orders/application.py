from collections.abc import Collection
from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol
from uuid import UUID

from valmont.modules.orders.domain import Order, OrderStatus, StatusChange

# Puertos y datos de lectura de orders (SPEC §6, §7; T-073). Los casos de uso llegan en T-074+.


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
