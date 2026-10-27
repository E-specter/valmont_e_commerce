import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

NOTE_MAX = 500  # INVENTORY-R5
ON_HAND_MAX = 2**31 - 1  # on_hand es integer (SPEC §6): un valor mayor sería un 500 de la BD
PAGE_SIZE_DEFAULT = 24  # listado del admin, como el de catalog (SPEC §7)
PAGE_SIZE_MAX = 48

# order_policy de catalog (D-023). Inventory no importa el dominio de catalog (modules.md §3).
MADE_TO_ORDER = "made_to_order"
BACKORDER = "backorder"


class InvalidMovement(ValueError):
    """Movimiento mal formado (422). `field`: el campo de la solicitud que lo causa, si lo hay."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.field = field


class NoChange(InvalidMovement):
    """El movimiento no cambia on_hand: un recuento igual al stock (422 no_change, R9)."""


class ProductNotFound(Exception):
    """El producto no existe en catalog (404)."""


class InsufficientStock(Exception):
    """Sin stock suficiente: un movimiento dejaría on_hand bajo 0 (409 insufficient_stock,
    INVENTORY-R6, con on_hand y lo reservado) o un pedido no se puede reservar
    (UC-INVENTORY-04, con sus productos; ahí on_hand y reserved son None, no datos)."""

    def __init__(
        self,
        product_ids: tuple[UUID, ...] = (),
        on_hand: int | None = None,
        reserved: int | None = None,
    ) -> None:
        super().__init__(product_ids)
        self.product_ids = product_ids
        self.on_hand = on_hand
        self.reserved = reserved


class ReservationExpired(Exception):
    """Alguna reserva del pedido ya no lo respalda: venció o se liberó (INVENTORY-R8), o ya no
    está cubierta por el stock (INVENTORY-R11)."""


class StockReserved(Exception):
    """El movimiento dejaría on_hand por debajo de lo reservado (409 stock_reserved, R6)."""

    def __init__(self, on_hand: int, reserved: int) -> None:
        super().__init__(on_hand, reserved)
        self.on_hand = on_hand
        self.reserved = reserved


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


class ReservationStatus(StrEnum):
    ACTIVE = "active"
    CONSUMED = "consumed"
    RELEASED = "released"


RESERVATION_MINUTES = 30  # RN-06, D-017

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
class StockView:
    """Stock de un producto para el admin (UC-INVENTORY-02). Sin fila de stock, on_hand 0."""

    product_id: UUID
    sku: str
    name: str
    product_status: str  # estado en catalog: draft | published
    on_hand: int
    reserved: int  # reservas activas no vencidas (R1)
    available: int
    status: AvailabilityStatus


@dataclass(frozen=True)
class StockQuery:
    """Listado del admin: `q` en el SKU o el nombre, `status` (R2) y la página."""

    q: str | None = None
    status: AvailabilityStatus | None = None
    page: int = 1
    page_size: int = PAGE_SIZE_DEFAULT


@dataclass(frozen=True)
class StockPage:
    items: list[StockView]
    total: int


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


def has_control_chars(text: str, allowed: str = "") -> bool:
    # Cc: \x00 rompe un text de PostgreSQL. Cs: un sustituto suelto no se codifica en UTF-8.
    return any(unicodedata.category(c) in ("Cc", "Cs") and c not in allowed for c in text)


def _invalid_note(message: str) -> InvalidMovement:
    return InvalidMovement(message, "note")


def _check_note(kind: MovementKind, note: str | None) -> None:
    if note is None:
        if kind in _NOTE_REQUIRED:
            raise _invalid_note("El ajuste de inventario y la merma exigen una nota.")
        return
    if not 1 <= len(note) <= NOTE_MAX:
        raise _invalid_note(f"La nota debe tener entre 1 y {NOTE_MAX} caracteres.")
    if has_control_chars(note, allowed="\n"):
        raise _invalid_note("La nota contiene caracteres de control no permitidos.")


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
            raise NoChange("El movimiento no cambia el stock.")
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
        raise InvalidMovement("La venta la registra el sistema al consumir reservas.", "kind")
    counted = kind == MovementKind.AJUSTE_INVENTARIO
    if quantity < 0 or (quantity == 0 and not counted):
        message = "La cantidad debe ser positiva (o ≥ 0 si es un recuento)."
        raise InvalidMovement(message, "quantity")
    if note is not None:
        note = note.replace("\r\n", "\n")
        # Antes de recortar: un \t o un \r en los extremos no desaparece sin un 422 (SPEC §7).
        if has_control_chars(note, allowed="\n"):
            raise _invalid_note("La nota contiene caracteres de control no permitidos.")
        note = note.strip() or None
    _check_note(kind, note)
    if counted:
        on_hand_after = quantity
    else:
        on_hand_after = stock.on_hand + (-quantity if kind == MovementKind.MERMA else quantity)
    if on_hand_after > ON_HAND_MAX:
        raise InvalidMovement(f"El stock no puede superar {ON_HAND_MAX} unidades.", "quantity")
    if on_hand_after < 0:
        raise InsufficientStock(on_hand=stock.on_hand, reserved=reserved)
    if on_hand_after < reserved:
        raise StockReserved(stock.on_hand, reserved)
    # Un recuento igual a on_hand da delta 0: StockMovement lanza NoChange (R9).
    return StockMovement(
        stock.product_id, kind, on_hand_after - stock.on_hand, on_hand_after, note, actor_id
    )


def _check_quantity(quantity: int) -> None:
    if quantity <= 0:
        raise ValueError("La cantidad debe ser positiva.")


@dataclass(frozen=True)
class OrderLine:
    product_id: UUID
    quantity: int

    def __post_init__(self) -> None:
        _check_quantity(self.quantity)


@dataclass(frozen=True)
class ProductPolicy:
    """order_policy y lead_time_days de un producto de catalog (D-023)."""

    order_policy: str
    lead_time_days: int | None = None


@dataclass(frozen=True)
class OnRequestLine:
    """Línea que va bajo pedido, sin reserva (RN-16, INVENTORY-R10)."""

    product_id: UUID
    quantity: int
    lead_time_days: int | None


@dataclass(frozen=True)
class Reservation:
    id: UUID
    product_id: UUID
    order_id: UUID
    quantity: int
    expires_at: datetime
    status: ReservationStatus = ReservationStatus.ACTIVE

    def __post_init__(self) -> None:
        _check_quantity(self.quantity)


def plan_reservations(
    lines: list[OrderLine], policies: Mapping[UUID, ProductPolicy], available: Mapping[UUID, int]
) -> tuple[list[OrderLine], list[OnRequestLine]]:
    """INVENTORY-R10 para un pedido: (líneas que reservan, líneas bajo pedido).

    `available` es el disponible (R1) de cada producto bloqueado; sin entrada = 0. Las líneas
    del mismo producto se descuentan en orden. Todo o nada (R4): si alguna línea `stock` no
    alcanza, InsufficientStock con cada producto que falta, una vez y en orden de aparición.
    """
    left = dict(available)
    reserve: list[OrderLine] = []
    on_request: list[OnRequestLine] = []
    short: dict[UUID, None] = {}
    for line in lines:
        policy = policies[line.product_id]
        stocked = left.get(line.product_id, 0)
        if policy.order_policy != MADE_TO_ORDER and stocked >= line.quantity:
            left[line.product_id] = stocked - line.quantity
            reserve.append(line)
        elif policy.order_policy in (MADE_TO_ORDER, BACKORDER):
            on_request.append(OnRequestLine(line.product_id, line.quantity, policy.lead_time_days))
        else:
            short[line.product_id] = None
    if short:
        raise InsufficientStock(tuple(short))
    return reserve, on_request


def to_consume(reservations: list[Reservation], now: datetime) -> list[Reservation]:
    """Las reservas activas del pedido que hay que consumir (UC-INVENTORY-05).

    Ninguna (solo líneas bajo pedido) o ya consumidas: lista vacía (idempotente). Si alguna
    activa venció (INVENTORY-R8) o se liberó, ReservationExpired y no se toca nada.
    """
    active = [r for r in reservations if r.status == ReservationStatus.ACTIVE]
    released = any(r.status == ReservationStatus.RELEASED for r in reservations)
    if released or any(r.expires_at <= now for r in active):
        raise ReservationExpired
    return active
