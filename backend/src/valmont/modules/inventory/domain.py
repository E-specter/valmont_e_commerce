import unicodedata
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

NOTE_MAX = 500  # INVENTORY-R5

# order_policy de catalog (D-023). Inventory no importa el dominio de catalog (modules.md §3).
MADE_TO_ORDER = "made_to_order"
BACKORDER = "backorder"


class InvalidMovement(ValueError):
    """Movimiento mal formado (422)."""


class InsufficientStock(Exception):
    """El movimiento dejaría on_hand por debajo de 0 (409 insufficient_stock, INVENTORY-R6)."""


class StockReserved(Exception):
    """El movimiento dejaría on_hand por debajo de lo reservado (409 stock_reserved, R6)."""


class AvailabilityStatus(StrEnum):  # D-023
    IN_STOCK = "in_stock"
    LOW_STOCK = "low_stock"
    OUT_OF_STOCK = "out_of_stock"
    ON_REQUEST = "on_request"


class MovementKind(StrEnum):  # INVENTORY-R5 (D-027)
    ENTRADA = "entrada"
    AJUSTE_INVENTARIO = "ajuste_inventario"
    MERMA = "merma"
    DEVOLUCION = "devolucion"
    VENTA = "venta"  # solo el sistema, al consumir reservas


_NOTE_REQUIRED = (MovementKind.AJUSTE_INVENTARIO, MovementKind.MERMA)


def availability_status(order_policy: str, available: int, threshold: int) -> AvailabilityStatus:
    """INVENTORY-R2. La vista app.product_availability (migración 0005) repite esta regla."""
    if order_policy == MADE_TO_ORDER:
        return AvailabilityStatus.ON_REQUEST
    if available > threshold:
        return AvailabilityStatus.IN_STOCK
    if available >= 1:
        return AvailabilityStatus.LOW_STOCK
    if order_policy == BACKORDER:
        return AvailabilityStatus.ON_REQUEST
    return AvailabilityStatus.OUT_OF_STOCK


@dataclass(frozen=True)
class Availability:
    """Una fila de la vista app.product_availability."""

    product_id: UUID
    available: int
    status: AvailabilityStatus
    lead_time_days: int | None


@dataclass(frozen=True)
class InventorySettings:
    low_stock_threshold: int = 2  # INVENTORY-R3 (D-027)

    def __post_init__(self) -> None:
        if self.low_stock_threshold < 1:
            raise ValueError("El umbral de últimas unidades debe ser al menos 1.")


@dataclass(frozen=True)
class StockItem:
    product_id: UUID
    on_hand: int = 0

    def __post_init__(self) -> None:
        if self.on_hand < 0:
            raise ValueError("on_hand no puede ser negativo (RN-06).")


def _check_note(kind: MovementKind, note: str | None) -> None:
    if note is None:
        if kind in _NOTE_REQUIRED:
            raise InvalidMovement("El ajuste de inventario y la merma exigen una nota.")
        return
    if not 1 <= len(note) <= NOTE_MAX:
        raise InvalidMovement(f"La nota debe tener entre 1 y {NOTE_MAX} caracteres.")
    # Cc: \x00 rompe un text de PostgreSQL. Cs: un sustituto suelto no se codifica en UTF-8.
    if any(unicodedata.category(c) in ("Cc", "Cs") and c != "\n" for c in note):
        raise InvalidMovement("La nota contiene caracteres de control no permitidos.")


@dataclass(frozen=True)
class StockMovement:
    """Mismos invariantes que los CHECK de app.stock_movements (SPEC §6)."""

    product_id: UUID
    kind: MovementKind
    quantity_delta: int
    on_hand_after: int
    note: str | None = None
    actor_id: UUID | None = None
    order_id: UUID | None = None
    id: int | None = None  # los asigna la BD al insertar
    created_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.quantity_delta == 0:
            raise InvalidMovement("El movimiento no cambia el stock.")
        if self.on_hand_after < 0:
            raise InvalidMovement("on_hand_after no puede ser negativo.")
        _check_note(self.kind, self.note)


def admin_movement(
    stock: StockItem,
    reserved: int,
    kind: MovementKind,
    quantity: int,
    note: str | None = None,
    actor_id: UUID | None = None,
) -> StockMovement:
    """Movimiento del admin (INVENTORY-R5) que cumple INVENTORY-R6.

    `stock` es la fila bloqueada y `reserved`, lo reservado vigente bajo ese bloqueo. Para
    `ajuste_inventario`, `quantity` es la cantidad contada; para el resto, las unidades.
    """
    if kind == MovementKind.VENTA:
        raise InvalidMovement("La venta la registra el sistema al consumir reservas.")
    counted = kind == MovementKind.AJUSTE_INVENTARIO
    if quantity < 0 or (quantity == 0 and not counted):
        raise InvalidMovement("La cantidad debe ser positiva (o ≥ 0 si es un recuento).")
    if note is not None:
        note = note.replace("\r\n", "\n").strip() or None
    _check_note(kind, note)
    if counted:
        on_hand_after = quantity
    else:
        on_hand_after = stock.on_hand + (-quantity if kind == MovementKind.MERMA else quantity)
    if on_hand_after < 0:
        raise InsufficientStock
    if on_hand_after < reserved:
        raise StockReserved
    return StockMovement(
        stock.product_id, kind, on_hand_after - stock.on_hand, on_hand_after, note, actor_id
    )
