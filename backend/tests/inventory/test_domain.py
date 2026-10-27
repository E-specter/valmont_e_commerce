from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from valmont.modules.inventory.domain import (
    NOTE_MAX,
    AvailabilityStatus,
    InsufficientStock,
    InvalidMovement,
    InventorySettings,
    MovementKind,
    OnRequestLine,
    OrderLine,
    ProductPolicy,
    Reservation,
    ReservationExpired,
    ReservationStatus,
    StockItem,
    StockMovement,
    StockReserved,
    admin_movement,
    availability_status,
    plan_reservations,
    to_consume,
)

IN_STOCK = AvailabilityStatus.IN_STOCK
LOW_STOCK = AvailabilityStatus.LOW_STOCK
OUT_OF_STOCK = AvailabilityStatus.OUT_OF_STOCK
ON_REQUEST = AvailabilityStatus.ON_REQUEST


@pytest.mark.parametrize(
    ("policy", "available", "threshold", "expected"),
    [
        ("made_to_order", 10, 2, ON_REQUEST),
        ("made_to_order", 0, 2, ON_REQUEST),
        ("stock", 3, 2, IN_STOCK),
        ("stock", 2, 2, LOW_STOCK),
        ("stock", 1, 2, LOW_STOCK),
        ("stock", 0, 2, OUT_OF_STOCK),
        ("backorder", 3, 2, IN_STOCK),
        ("backorder", 1, 2, LOW_STOCK),
        ("backorder", 0, 2, ON_REQUEST),
        ("stock", 3, 5, LOW_STOCK),  # umbral modificado (D-027)
        ("stock", 2, 1, IN_STOCK),
        ("stock", 1, 1, LOW_STOCK),
    ],
)
def test_availability_status_follows_inventory_r2(
    policy: str, available: int, threshold: int, expected: AvailabilityStatus
) -> None:
    assert availability_status(policy, available, threshold) is expected


def test_stock_item_never_negative() -> None:
    with pytest.raises(ValueError):
        StockItem(uuid4(), -1)


@pytest.mark.parametrize("threshold", [0, -1])
def test_threshold_is_at_least_one(threshold: int) -> None:
    with pytest.raises(ValueError):
        InventorySettings(threshold)


STOCK = StockItem(uuid4(), 5)


@pytest.mark.parametrize(
    ("kind", "quantity", "delta", "after"),
    [
        (MovementKind.ENTRADA, 3, 3, 8),
        (MovementKind.DEVOLUCION, 1, 1, 6),
        (MovementKind.MERMA, 2, -2, 3),
        (MovementKind.AJUSTE_INVENTARIO, 2, -3, 2),  # cantidad contada; el delta lo calcula
        (MovementKind.AJUSTE_INVENTARIO, 9, 4, 9),
        (MovementKind.AJUSTE_INVENTARIO, 0, -5, 0),
    ],
)
def test_admin_movement_computes_delta_and_on_hand(
    kind: MovementKind, quantity: int, delta: int, after: int
) -> None:
    actor = uuid4()

    movement = admin_movement(STOCK, 0, kind, quantity, "Recuento de prueba", actor)

    assert movement == StockMovement(
        STOCK.product_id, kind, delta, after, "Recuento de prueba", actor_id=actor
    )


@pytest.mark.parametrize("kind", [MovementKind.AJUSTE_INVENTARIO, MovementKind.MERMA])
@pytest.mark.parametrize("note", [None, "", "   "])
def test_adjustment_and_shrinkage_require_a_note(kind: MovementKind, note: str | None) -> None:
    with pytest.raises(InvalidMovement):
        admin_movement(STOCK, 0, kind, 1, note)


@pytest.mark.parametrize("kind", [MovementKind.ENTRADA, MovementKind.DEVOLUCION])
def test_entry_and_return_take_an_optional_note(kind: MovementKind) -> None:
    assert admin_movement(STOCK, 0, kind, 1, "  ").note is None


def test_note_is_trimmed_and_limited() -> None:
    assert admin_movement(STOCK, 0, MovementKind.MERMA, 1, "  Golpe \r\n en vitrina ").note == (
        "Golpe \n en vitrina"
    )
    admin_movement(STOCK, 0, MovementKind.MERMA, 1, "x" * NOTE_MAX)
    with pytest.raises(InvalidMovement):
        admin_movement(STOCK, 0, MovementKind.MERMA, 1, "x" * (NOTE_MAX + 1))


@pytest.mark.parametrize("note", ["con \x00 nulo", "con \t tabulador", "sustituto \ud800"])
def test_note_rejects_control_characters(note: str) -> None:
    with pytest.raises(InvalidMovement):
        admin_movement(STOCK, 0, MovementKind.ENTRADA, 1, note)


@pytest.mark.parametrize(
    ("kind", "quantity"),
    [
        (MovementKind.ENTRADA, 0),
        (MovementKind.ENTRADA, -1),
        (MovementKind.MERMA, 0),
        (MovementKind.DEVOLUCION, -2),
        (MovementKind.AJUSTE_INVENTARIO, -1),
    ],
)
def test_quantity_must_be_positive_or_a_count(kind: MovementKind, quantity: int) -> None:
    with pytest.raises(InvalidMovement):
        admin_movement(STOCK, 0, kind, quantity, "nota")


def test_sale_is_only_recorded_by_the_system() -> None:
    with pytest.raises(InvalidMovement):
        admin_movement(STOCK, 0, MovementKind.VENTA, 1)


def test_adjustment_to_the_same_count_changes_nothing() -> None:
    # quantity_delta <> 0 (SPEC §6): un recuento igual a on_hand no es un movimiento.
    with pytest.raises(InvalidMovement):
        admin_movement(STOCK, 0, MovementKind.AJUSTE_INVENTARIO, 5, "Recuento")


@pytest.mark.parametrize("reserved", [0, 2])
def test_movement_never_leaves_on_hand_negative(reserved: int) -> None:
    # Bajo 0 gana a "bajo lo reservado": insufficient_stock (INVENTORY-R6).
    with pytest.raises(InsufficientStock):
        admin_movement(STOCK, reserved, MovementKind.MERMA, 6, "Rotura")


@pytest.mark.parametrize(
    ("kind", "quantity"), [(MovementKind.MERMA, 3), (MovementKind.AJUSTE_INVENTARIO, 1)]
)
def test_movement_never_leaves_on_hand_below_reserved(kind: MovementKind, quantity: int) -> None:
    with pytest.raises(StockReserved):
        admin_movement(STOCK, 3, kind, quantity, "Recuento")


def test_movement_may_leave_on_hand_equal_to_reserved() -> None:
    assert admin_movement(STOCK, 3, MovementKind.MERMA, 2, "Rotura").on_hand_after == 3


@pytest.mark.parametrize(
    "changes",
    [
        {"quantity_delta": 0},
        {"on_hand_after": -1},
        {"kind": MovementKind.MERMA, "note": None},
        {"note": "x" * (NOTE_MAX + 1)},
    ],
)
def test_stock_movement_mirrors_the_table_checks(changes: dict[str, object]) -> None:
    fields: dict[str, object] = {
        "product_id": uuid4(),
        "kind": MovementKind.VENTA,
        "quantity_delta": -1,
        "on_hand_after": 4,
        **changes,
    }
    with pytest.raises(InvalidMovement):
        StockMovement(**fields)  # type: ignore[arg-type]


A, B, C = sorted(uuid4() for _ in range(3))
NOW = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
POLICIES = {
    A: ProductPolicy("stock"),
    B: ProductPolicy("backorder", lead_time_days=21),
    C: ProductPolicy("made_to_order", lead_time_days=45),
}


@pytest.mark.parametrize(
    ("lines", "available", "reserve", "on_request"),
    [
        ([(A, 2)], {A: 2}, [(A, 2)], []),
        ([(B, 2)], {B: 2}, [(B, 2)], []),  # backorder con disponible: reserva (R10)
        ([(B, 3)], {B: 2}, [], [(B, 3, 21)]),  # sin bastante: la línea entera bajo pedido
        ([(C, 1)], {}, [], [(C, 1, 45)]),  # made_to_order nunca reserva (RN-16)
        ([(A, 1), (B, 5), (C, 2)], {A: 1, B: 0}, [(A, 1)], [(B, 5, 21), (C, 2, 45)]),
        ([(A, 1), (A, 1)], {A: 2}, [(A, 1), (A, 1)], []),  # líneas repetidas se acumulan
        ([(B, 1), (B, 1)], {B: 1}, [(B, 1)], [(B, 1, 21)]),
    ],
)
def test_plan_reservations_follows_inventory_r10(
    lines: list[tuple[UUID, int]],
    available: dict[UUID, int],
    reserve: list[tuple[UUID, int]],
    on_request: list[tuple[UUID, int, int]],
) -> None:
    planned = plan_reservations([OrderLine(*line) for line in lines], POLICIES, available)

    assert planned == (
        [OrderLine(*line) for line in reserve],
        [OnRequestLine(*line) for line in on_request],
    )


@pytest.mark.parametrize(
    ("lines", "available", "short"),
    [
        ([(A, 3)], {A: 2}, (A,)),
        ([(A, 1)], {}, (A,)),  # sin fila de stock: disponible 0
        ([(A, 1), (A, 2)], {A: 2}, (A,)),
        ([(A, 1), (B, 9), (C, 1)], {A: 0, B: 0}, (A,)),  # todo o nada (R4)
    ],
)
def test_plan_reservations_fails_whole_with_the_short_products(
    lines: list[tuple[UUID, int]], available: dict[UUID, int], short: tuple[UUID, ...]
) -> None:
    with pytest.raises(InsufficientStock) as exc:
        plan_reservations([OrderLine(*line) for line in lines], POLICIES, available)

    assert exc.value.product_ids == short


def test_plan_reservations_lists_every_short_product_once() -> None:
    other = uuid4()
    policies = {**POLICIES, other: ProductPolicy("stock")}
    lines = [OrderLine(other, 1), OrderLine(A, 5), OrderLine(other, 1)]

    with pytest.raises(InsufficientStock) as exc:
        plan_reservations(lines, policies, {A: 1})

    assert exc.value.product_ids == (other, A)


@pytest.mark.parametrize("quantity", [0, -1])
def test_order_line_and_reservation_quantities_are_positive(quantity: int) -> None:
    with pytest.raises(ValueError):
        OrderLine(A, quantity)
    with pytest.raises(ValueError):
        Reservation(uuid4(), A, uuid4(), quantity, NOW)


def reservation(status: ReservationStatus, minutes: int = 30) -> Reservation:
    return Reservation(uuid4(), A, uuid4(), 1, NOW + timedelta(minutes=minutes), status)


def test_to_consume_returns_the_active_reservations() -> None:
    active = [reservation(ReservationStatus.ACTIVE), reservation(ReservationStatus.ACTIVE, 1)]

    assert to_consume(active, NOW) == active


@pytest.mark.parametrize(
    "reservations",
    [[], [reservation(ReservationStatus.CONSUMED), reservation(ReservationStatus.CONSUMED)]],
)
def test_to_consume_is_idempotent(reservations: list[Reservation]) -> None:
    # Sin reservas (solo líneas bajo pedido) o ya consumidas: nada que hacer.
    assert to_consume(reservations, NOW) == []


@pytest.mark.parametrize(
    "reservations",
    [
        [reservation(ReservationStatus.ACTIVE), reservation(ReservationStatus.ACTIVE, 0)],
        [reservation(ReservationStatus.ACTIVE, -5)],
        [reservation(ReservationStatus.RELEASED)],  # liberada: ya no respalda el pedido
    ],
)
def test_to_consume_fails_if_any_reservation_is_no_longer_valid(
    reservations: list[Reservation],
) -> None:
    with pytest.raises(ReservationExpired):
        to_consume(reservations, NOW)
