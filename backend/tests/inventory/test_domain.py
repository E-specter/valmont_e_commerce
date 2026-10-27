from uuid import uuid4

import pytest

from valmont.modules.inventory.domain import (
    NOTE_MAX,
    AvailabilityStatus,
    InsufficientStock,
    InvalidMovement,
    InventorySettings,
    MovementKind,
    StockItem,
    StockMovement,
    StockReserved,
    admin_movement,
    availability_status,
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
