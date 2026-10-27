"""Repositorios y vista de inventory contra la BD de pruebas. Datos ficticios."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, func, insert, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from valmont.modules.inventory.adapters.persistence import (
    InventoryItemRow,
    InventorySettingsRow,
    SqlAvailabilityReader,
    SqlMovementRepository,
    SqlSettingsRepository,
    SqlStockRepository,
    StockMovementRow,
    StockReservationRow,
)
from valmont.modules.inventory.domain import (
    Availability,
    AvailabilityStatus,
    InventorySettings,
    MovementKind,
    StockItem,
    StockMovement,
    availability_status,
)

pytestmark = pytest.mark.integration

IN_STOCK = AvailabilityStatus.IN_STOCK
LOW_STOCK = AvailabilityStatus.LOW_STOCK
OUT_OF_STOCK = AvailabilityStatus.OUT_OF_STOCK
ON_REQUEST = AvailabilityStatus.ON_REQUEST
LEAD_TIME_DAYS = 21


def add_product(session: Session, order_policy: str = "stock") -> UUID:
    """Producto mínimo en app.products, por SQL: inventory no usa el código de catalog."""
    category_id, product_id, tag = uuid4(), uuid4(), uuid4().hex[:8]
    session.execute(
        text("INSERT INTO app.categories (id, slug, name) VALUES (:id, :slug, 'Inventario')"),
        {"id": category_id, "slug": f"inventario-{tag}"},
    )
    session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id,"
            " price_cents, order_policy, lead_time_days) VALUES (:id, :sku, :slug,"
            " 'Reloj de prueba', 'Reloj ficticio.', :category_id, 100000, :policy, :lead)"
        ),
        {
            "id": product_id,
            "sku": f"TST-INV-{tag}",
            "slug": f"inventario-{tag}",
            "category_id": category_id,
            "policy": order_policy,
            "lead": None if order_policy == "stock" else LEAD_TIME_DAYS,
        },
    )
    return product_id


def add_reservation(
    session: Session, product_id: UUID, quantity: int, status: str = "active", minutes: int = 30
) -> None:
    """Reserva que vence dentro de `minutes` minutos (en el pasado si es negativo)."""
    session.execute(
        insert(StockReservationRow).values(
            id=uuid4(),
            product_id=product_id,
            order_id=uuid4(),
            quantity=quantity,
            status=status,
            expires_at=func.now() + timedelta(minutes=minutes),
        )
    )


# CA-INVENTORY-05: (política, on_hand o None sin fila, reservas (cantidad, estado, minutos),
# umbral) → (disponible, estado).
@pytest.mark.parametrize(
    ("policy", "on_hand", "reservations", "threshold", "available", "status"),
    [
        ("stock", None, [], 2, 0, OUT_OF_STOCK),
        ("backorder", None, [], 2, 0, ON_REQUEST),
        ("made_to_order", None, [], 2, 0, ON_REQUEST),
        ("made_to_order", 5, [], 2, 5, ON_REQUEST),
        ("stock", 3, [], 2, 3, IN_STOCK),
        ("stock", 2, [], 2, 2, LOW_STOCK),
        ("stock", 1, [], 2, 1, LOW_STOCK),
        ("stock", 0, [], 2, 0, OUT_OF_STOCK),
        ("backorder", 3, [], 2, 3, IN_STOCK),
        ("backorder", 1, [], 2, 1, LOW_STOCK),
        ("backorder", 0, [], 2, 0, ON_REQUEST),
        ("stock", 3, [(1, "active", 30)], 2, 2, LOW_STOCK),
        ("stock", 3, [(1, "active", 30), (2, "active", 5)], 2, 0, OUT_OF_STOCK),
        ("backorder", 2, [(2, "active", 30)], 2, 0, ON_REQUEST),
        ("stock", 3, [(2, "active", -1)], 2, 3, IN_STOCK),  # vencida: no cuenta (R1)
        ("stock", 3, [(2, "consumed", 30), (2, "released", 30)], 2, 3, IN_STOCK),
        ("stock", 3, [], 5, 3, LOW_STOCK),  # umbral modificado (D-027)
        ("stock", 2, [], 1, 2, IN_STOCK),
        ("backorder", 4, [(1, "active", 30), (1, "active", -5)], 1, 3, IN_STOCK),
    ],
)
def test_view_applies_inventory_r1_and_r2(
    db_session: Session,
    policy: str,
    on_hand: int | None,
    reservations: list[tuple[int, str, int]],
    threshold: int,
    available: int,
    status: AvailabilityStatus,
) -> None:
    product_id = add_product(db_session, policy)
    if on_hand is not None:
        db_session.execute(insert(InventoryItemRow).values(product_id=product_id, on_hand=on_hand))
    for quantity, reservation_status, minutes in reservations:
        add_reservation(db_session, product_id, quantity, reservation_status, minutes)
    SqlSettingsRepository(db_session).update(InventorySettings(threshold))

    row = SqlAvailabilityReader(db_session).get(product_id)

    lead_time = None if policy == "stock" else LEAD_TIME_DAYS
    assert row == Availability(product_id, available, status, lead_time)
    assert availability_status(policy, available, threshold) is status  # la vista = el dominio


def test_view_has_no_row_for_an_unknown_product(db_session: Session) -> None:
    assert SqlAvailabilityReader(db_session).get(uuid4()) is None


def test_settings_start_with_the_default_threshold(db_session: Session) -> None:
    assert SqlSettingsRepository(db_session).get() == InventorySettings(2)


def test_settings_update_and_lock(db_session: Session) -> None:
    settings = SqlSettingsRepository(db_session)

    settings.update(InventorySettings(4))

    assert settings.get(lock=True) == InventorySettings(4)


def test_lock_creates_the_missing_row_with_zero_on_hand(db_session: Session) -> None:
    product_id = add_product(db_session)
    stock = SqlStockRepository(db_session)

    assert stock.lock(product_id) == StockItem(product_id, 0)
    assert stock.lock(product_id) == StockItem(product_id, 0)  # la segunda vez, ya existe


def test_lock_returns_none_without_creating_a_row_for_an_unknown_product(
    db_session: Session,
) -> None:
    product_id = uuid4()

    assert SqlStockRepository(db_session).lock(product_id) is None
    assert db_session.get(InventoryItemRow, product_id) is None


@contextmanager
def captured(session: Session) -> Iterator[list[tuple[str, Any]]]:
    """Las sentencias SQL (con sus parámetros) que la sesión envía dentro del bloque."""
    connection = session.connection()
    statements: list[tuple[str, Any]] = []

    def capture(*args: Any) -> None:
        _conn, _cursor, statement, parameters, *_ = args
        statements.append((statement, parameters))

    event.listen(connection, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(connection, "before_cursor_execute", capture)


def test_lock_inserts_without_races_and_then_locks_the_row(db_session: Session) -> None:
    with captured(db_session) as statements:
        SqlStockRepository(db_session).lock(add_product(db_session))

    create, lock = (statement for statement, _ in statements[-2:])
    assert "ON CONFLICT (product_id) DO NOTHING" in create
    assert lock.rstrip().endswith("FOR UPDATE")


def test_view_sums_reservations_through_their_index(db_session: Session) -> None:
    product_id = add_product(db_session)
    add_reservation(db_session, product_id, 1)
    db_session.execute(text("SET LOCAL enable_seqscan = off"))
    with captured(db_session) as statements:
        SqlAvailabilityReader(db_session).get(product_id)

    [(statement, parameters)] = statements
    connection = db_session.connection()
    plan = connection.exec_driver_sql(f"EXPLAIN {statement}", parameters).scalars().all()
    assert any("ix_stock_reservations_product_id_status_expires_at" in line for line in plan)


def test_update_saves_on_hand(db_session: Session) -> None:
    product_id = add_product(db_session)
    stock = SqlStockRepository(db_session)
    stock.lock(product_id)

    stock.update(StockItem(product_id, 7))

    assert stock.lock(product_id) == StockItem(product_id, 7)
    assert SqlAvailabilityReader(db_session).get(product_id) == Availability(
        product_id, 7, IN_STOCK, None
    )


def test_movements_are_added_and_listed_newest_first(db_session: Session) -> None:
    product_id = add_product(db_session)
    actor = uuid4()
    movements = SqlMovementRepository(db_session)
    first = movements.add(StockMovement(product_id, MovementKind.ENTRADA, 5, 5, actor_id=actor))
    second = movements.add(StockMovement(product_id, MovementKind.MERMA, -1, 4, "Rotura"))
    third = movements.add(
        StockMovement(product_id, MovementKind.VENTA, -2, 2, order_id=(order := uuid4()))
    )

    assert first.id is not None and first.created_at is not None
    assert [m.id for m in (first, second, third)] == sorted(m.id for m in (first, second, third))
    assert movements.list_recent(product_id, 2) == [third, second]
    assert movements.list_recent(product_id, 50) == [third, second, first]
    assert third.order_id == order
    assert movements.list_recent(uuid4(), 50) == []


# Cada CHECK de la SPEC §6 rechaza lo que el dominio rechaza.
@pytest.mark.parametrize(
    ("table", "values", "constraint"),
    [
        (InventoryItemRow, {"on_hand": -1}, "ck_inventory_items_on_hand"),
        (
            StockReservationRow,
            {"quantity": 0, "status": "active"},
            "ck_stock_reservations_quantity",
        ),
        (
            StockReservationRow,
            {"quantity": 1, "status": "expired"},
            "ck_stock_reservations_status",
        ),
        (
            StockMovementRow,
            {"kind": "robo", "quantity_delta": 1, "on_hand_after": 1},
            "ck_stock_movements_kind",
        ),
        (
            StockMovementRow,
            {"kind": "entrada", "quantity_delta": 0, "on_hand_after": 1},
            "ck_stock_movements_quantity_delta",
        ),
        (
            StockMovementRow,
            {"kind": "entrada", "quantity_delta": 1, "on_hand_after": -1},
            "ck_stock_movements_on_hand_after",
        ),
        (
            StockMovementRow,
            {"kind": "merma", "quantity_delta": -1, "on_hand_after": 0},
            "ck_stock_movements_note_required",
        ),
        (
            StockMovementRow,
            {"kind": "ajuste_inventario", "quantity_delta": 2, "on_hand_after": 2},
            "ck_stock_movements_note_required",
        ),
    ],
)
def test_table_checks_reject_invalid_rows(
    db_session: Session, table: type, values: dict[str, Any], constraint: str
) -> None:
    values = {**values, "product_id": add_product(db_session)}
    if table is StockReservationRow:
        values |= {"id": uuid4(), "order_id": uuid4(), "expires_at": func.now()}

    with pytest.raises(IntegrityError) as exc:
        db_session.execute(insert(table).values(**values))

    assert exc.value.orig.diag.constraint_name == constraint  # type: ignore[union-attr]


@pytest.mark.parametrize(
    ("statement", "constraint"),
    [
        (
            "UPDATE app.inventory_settings SET low_stock_threshold = 0",
            "ck_inventory_settings_low_stock_threshold",
        ),
        ("INSERT INTO app.inventory_settings (id) VALUES (2)", "ck_inventory_settings_single_row"),
        ("INSERT INTO app.inventory_settings (id) VALUES (1)", "pk_inventory_settings"),
    ],
)
def test_settings_stay_a_single_valid_row(
    db_session: Session, statement: str, constraint: str
) -> None:
    with pytest.raises(IntegrityError) as exc:
        db_session.execute(text(statement))

    assert exc.value.orig.diag.constraint_name == constraint  # type: ignore[union-attr]


def test_movement_and_stock_foreign_keys_require_an_existing_product(
    db_session: Session,
) -> None:
    with pytest.raises(IntegrityError) as exc:
        db_session.execute(insert(InventoryItemRow).values(product_id=uuid4()))

    assert exc.value.orig.diag.constraint_name == (  # type: ignore[union-attr]
        "fk_inventory_items_product_id_products"
    )


def test_settings_row_is_unique(db_session: Session) -> None:
    assert db_session.scalars(select(InventorySettingsRow.id)).all() == [1]
