from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol
from uuid import UUID, uuid4

from valmont.modules.inventory.domain import (
    MADE_TO_ORDER,
    RESERVATION_MINUTES,
    Availability,
    InventorySettings,
    MovementKind,
    OnRequestLine,
    OrderLine,
    ProductPolicy,
    Reservation,
    ReservationStatus,
    StockItem,
    StockMovement,
    plan_reservations,
    to_consume,
)

# Puertos y casos de uso internos para orders (UC-INVENTORY-04…06). No hacen commit: corren en
# la transacción de quien los llama, que la confirma o la deshace entera (todo o nada).


class StockRepository(Protocol):
    def lock(self, product_id: UUID) -> StockItem | None:
        """Bloquea la fila de stock (FOR UPDATE) hasta el fin de la transacción, creándola con
        on_hand 0 si falta (INVENTORY-R4). None si el producto no existe."""
        ...

    def update(self, item: StockItem) -> None:
        """Guarda on_hand; solo con la fila bloqueada por lock()."""
        ...


class MovementRepository(Protocol):
    def add(self, movement: StockMovement) -> StockMovement:
        """Inserta el movimiento y lo devuelve con id y created_at."""
        ...

    def list_recent(self, product_id: UUID, limit: int) -> list[StockMovement]:
        """Los últimos `limit` movimientos del producto, del más reciente al más antiguo."""
        ...


class SettingsRepository(Protocol):
    def get(self, lock: bool = False) -> InventorySettings:
        """La fila única de ajustes; lock=True la bloquea (FOR UPDATE) para cambiarla."""
        ...

    def update(self, settings: InventorySettings) -> None: ...


class AvailabilityReader(Protocol):
    def get(self, product_id: UUID) -> Availability | None:
        """La fila de app.product_availability; None si el producto no existe."""
        ...


class ReservationRepository(Protocol):
    def add(self, reservation: Reservation) -> None: ...

    def active_totals(self, product_ids: Collection[UUID], now: datetime) -> dict[UUID, int]:
        """Unidades en reservas activas no vencidas por producto (R1); sin entrada = 0."""
        ...

    def for_order(self, order_id: UUID, lock: bool = False) -> list[Reservation]:
        """Todas las reservas del pedido; lock=True las bloquea (FOR UPDATE)."""
        ...

    def close_active(self, order_id: UUID, status: ReservationStatus) -> None:
        """Pasa las reservas activas del pedido (vencidas o no) a `status`."""
        ...


class ProductPolicies(Protocol):
    def get(self, product_ids: Collection[UUID]) -> dict[UUID, ProductPolicy]:
        """order_policy y lead_time_days de los productos que existen."""
        ...


def _lock(stock: StockRepository, product_id: UUID) -> StockItem:
    item = stock.lock(product_id)
    if item is None:
        raise LookupError(f"Producto inexistente: {product_id}")
    return item


@dataclass(frozen=True)
class ReservedOrder:
    reservations: list[Reservation]
    on_request: list[OnRequestLine]


class ReserveStock:
    """UC-INVENTORY-04: reserva las líneas de un pedido (INVENTORY-R4, R10)."""

    def __init__(
        self, policies: ProductPolicies, stock: StockRepository, reservations: ReservationRepository
    ) -> None:
        self._policies = policies
        self._stock = stock
        self._reservations = reservations

    def __call__(self, order_id: UUID, lines: list[OrderLine], now: datetime) -> ReservedOrder:
        product_ids = {line.product_id for line in lines}
        policies = self._policies.get(product_ids)
        # Orders valida los productos con catalog antes de llegar aquí: uno inexistente es un
        # error de programación, no un caso de negocio.
        if missing := product_ids - policies.keys():
            raise LookupError(f"Productos inexistentes: {sorted(map(str, missing))}")
        stocked = sorted(p for p in product_ids if policies[p].order_policy != MADE_TO_ORDER)
        # En orden de product_id: sin interbloqueos (R4).
        on_hand = {p: _lock(self._stock, p).on_hand for p in stocked}
        reserved = self._reservations.active_totals(stocked, now)
        available = {p: on_hand[p] - reserved.get(p, 0) for p in stocked}
        to_reserve, on_request = plan_reservations(lines, policies, available)
        expires_at = now + timedelta(minutes=RESERVATION_MINUTES)
        reservations = [
            Reservation(uuid4(), line.product_id, order_id, line.quantity, expires_at)
            for line in to_reserve
        ]
        for reservation in reservations:
            self._reservations.add(reservation)
        return ReservedOrder(reservations, on_request)


class ConsumeReservations:
    """UC-INVENTORY-05: al pagar, convierte las reservas del pedido en ventas (R8)."""

    def __init__(
        self,
        stock: StockRepository,
        reservations: ReservationRepository,
        movements: MovementRepository,
    ) -> None:
        self._stock = stock
        self._reservations = reservations
        self._movements = movements

    def __call__(self, order_id: UUID, now: datetime) -> None:
        # Primero las reservas del pedido (frente a un Release simultáneo) y después el stock
        # en orden de product_id, como ReserveStock.
        consumed = to_consume(self._reservations.for_order(order_id, lock=True), now)
        for reservation in sorted(consumed, key=lambda r: r.product_id):
            item = _lock(self._stock, reservation.product_id)
            # StockItem rechaza un on_hand negativo: nunca se vende lo que no hay (RN-06).
            after = StockItem(item.product_id, item.on_hand - reservation.quantity)
            self._stock.update(after)
            self._movements.add(
                StockMovement(
                    after.product_id,
                    MovementKind.VENTA,
                    -reservation.quantity,
                    after.on_hand,
                    order_id=order_id,
                )
            )
        if consumed:
            self._reservations.close_active(order_id, ReservationStatus.CONSUMED)


class ReleaseReservations:
    """UC-INVENTORY-06: al cancelar o vencer el pedido; idempotente."""

    def __init__(self, reservations: ReservationRepository) -> None:
        self._reservations = reservations

    def __call__(self, order_id: UUID) -> None:
        self._reservations.close_active(order_id, ReservationStatus.RELEASED)
