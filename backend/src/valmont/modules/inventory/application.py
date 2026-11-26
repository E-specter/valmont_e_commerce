from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol
from uuid import UUID, uuid4

# AuditEntry forma parte de la firma del puerto público de audit (modules.md §3, excepción 2).
from valmont.modules.audit.application import AuditEntry, AuditRecorder
from valmont.modules.inventory.domain import (
    MADE_TO_ORDER,
    RESERVATION_MINUTES,
    Availability,
    InsufficientStock,  # noqa: F401 (reexportada: orders la captura, modules.md §3 excepción 7)
    InventorySettings,
    MovementKind,
    OnRequestLine,
    OrderLine,
    ProductNotFound,
    ProductPolicy,
    Reservation,
    ReservationExpired,
    ReservationStatus,
    StockItem,
    StockMovement,
    StockPage,
    StockQuery,
    StockView,
    admin_movement,
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

    def latest_expiry(self, product_ids: Collection[UUID]) -> datetime | None:
        """El mayor expires_at de las reservas activas (de cualquier pedido, vencidas o no) de
        esos productos; None si no hay ninguna."""
        ...

    def close(self, reservation_ids: Collection[UUID], status: ReservationStatus) -> None:
        """Pasa exactamente esas reservas a `status`; quien llama ya las tiene bloqueadas."""
        ...


class ProductPolicies(Protocol):
    def get(self, product_ids: Collection[UUID]) -> dict[UUID, ProductPolicy]:
        """order_policy y lead_time_days de los productos que existen."""
        ...


class StockReader(Protocol):
    """Lectura del admin (UC-INVENTORY-02): todos los productos de catalog, borradores
    incluidos, tengan o no fila de stock."""

    def list_all(self, query: StockQuery) -> StockPage:
        """Filtrados por `q` (SKU o nombre) y `status`, por sku ascendente y paginados."""
        ...

    def get(self, product_id: UUID) -> StockView | None:
        """None si el producto no existe."""
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
    """UC-INVENTORY-05: al pagar, convierte las reservas del pedido en ventas (R8, R11)."""

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
        # Primero las reservas del pedido, en el mismo orden que ReleaseReservations (R12), y
        # después todo el stock implicado en orden de product_id, como ReserveStock (R4).
        reservations = self._reservations.for_order(order_id, lock=True)
        # Comprobación temprana con `now`: el reloj efectivo nunca es anterior, así que lo que
        # falla aquí fallaría igual después.
        early = to_consume(reservations, now)
        if not early:
            return
        product_ids = sorted({r.product_id for r in early})
        on_hand = {p: _lock(self._stock, p).on_hand for p in product_ids}
        # Reloj efectivo (R11), leído después de los bloqueos: nunca anterior a la creación de
        # la última reserva activa de estos productos, aunque esta transacción esperara.
        latest = self._reservations.latest_expiry(product_ids)
        reserved_window = timedelta(minutes=RESERVATION_MINUTES)
        effective = now if latest is None else max(now, latest - reserved_window)
        consumed = to_consume(reservations, effective)  # R8 con el reloj efectivo
        # INVENTORY-R11: con el stock bloqueado y antes de escribir, on_hand debe cubrir todas
        # las reservas vigentes, propias incluidas. Si no, otra transacción dio por vencida una
        # de las nuestras y reservó esas unidades: pierde este pedido, que paga en el límite.
        totals = self._reservations.active_totals(product_ids, effective)
        if any(on_hand[p] < totals.get(p, 0) for p in product_ids):
            raise ReservationExpired
        for reservation in sorted(consumed, key=lambda r: r.product_id):
            on_hand[reservation.product_id] -= reservation.quantity
            after = StockItem(reservation.product_id, on_hand[reservation.product_id])
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
        self._reservations.close([r.id for r in consumed], ReservationStatus.CONSUMED)


class ReleaseReservations:
    """UC-INVENTORY-06: al cancelar o vencer el pedido; idempotente."""

    def __init__(self, reservations: ReservationRepository) -> None:
        self._reservations = reservations

    def __call__(self, order_id: UUID) -> None:
        # Bloquea en el mismo orden que ConsumeReservations (R12): sin interbloqueo entre ambos.
        reservations = self._reservations.for_order(order_id, lock=True)
        active = [r.id for r in reservations if r.status == ReservationStatus.ACTIVE]
        if active:
            self._reservations.close(active, ReservationStatus.RELEASED)


# Casos de uso del admin (UC-INVENTORY-01 y 03). Corren en la transacción de la solicitud, con
# la auditoría dentro (AUDIT-R1).


@dataclass(frozen=True)
class Actor:
    """Quién hace la operación: sale del token, nunca del cuerpo (SPEC §9). Nulo = sistema
    (AUDIT-R5), p. ej. las semillas de desarrollo."""

    user_id: UUID | None
    role: str | None


class RecordMovement:
    """UC-INVENTORY-01: entrada, ajuste, merma o devolución (INVENTORY-R5, R6, R7, R9)."""

    def __init__(
        self,
        stock: StockRepository,
        availability: AvailabilityReader,
        movements: MovementRepository,
        audit: AuditRecorder,
    ) -> None:
        self._stock = stock
        self._availability = availability
        self._movements = movements
        self._audit = audit

    def __call__(
        self, product_id: UUID, kind: MovementKind, quantity: int, note: str | None, actor: Actor
    ) -> StockMovement:
        if (item := self._stock.lock(product_id)) is None:
            raise ProductNotFound
        # Lo reservado, después del bloqueo: con la fila bloqueada nadie reserva este producto
        # (R4), así que no cambia hasta el commit (R6, I-4). La vista tiene una fila por producto.
        if (view := self._availability.get(product_id)) is None:
            raise ProductNotFound
        reserved = item.on_hand - view.available
        movement = admin_movement(item, reserved, kind, quantity, note, actor.user_id)
        self._stock.update(StockItem(product_id, movement.on_hand_after))
        saved = self._movements.add(movement)
        self._audit.record(
            AuditEntry(
                "inventory.stock_adjusted",
                "product",
                str(product_id),
                actor.user_id,
                actor.role,
                before={"on_hand": item.on_hand},
                after={"on_hand": movement.on_hand_after, "kind": kind.value},
            )
        )
        return saved


class ChangeThreshold:
    """UC-INVENTORY-03: umbral de "Últimas unidades" (INVENTORY-R3, R7)."""

    def __init__(self, settings: SettingsRepository, audit: AuditRecorder) -> None:
        self._settings = settings
        self._audit = audit

    def __call__(self, threshold: int, actor: Actor) -> InventorySettings:
        current = self._settings.get(lock=True)
        updated = InventorySettings(threshold)
        if updated != current:  # el mismo valor: 200 sin escribir ni auditar (SPEC §7)
            self._settings.update(updated)
            self._audit.record(
                AuditEntry(
                    "inventory.threshold_changed",
                    "inventory_settings",
                    "1",  # fila única (SPEC §6)
                    actor.user_id,
                    actor.role,
                    before={"low_stock_threshold": current.low_stock_threshold},
                    after={"low_stock_threshold": updated.low_stock_threshold},
                )
            )
        return updated
