"""Casos de uso de reservas y de administración con fakes en memoria: qué se escribe y qué no."""

from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from valmont.modules.audit.application import AuditEntry
from valmont.modules.inventory.application import (
    Actor,
    ChangeThreshold,
    ConsumeReservations,
    RecordMovement,
    ReleaseReservations,
)
from valmont.modules.inventory.domain import (
    Availability,
    AvailabilityStatus,
    InsufficientStock,
    InventorySettings,
    MovementKind,
    NoChange,
    ProductNotFound,
    Reservation,
    ReservationExpired,
    ReservationStatus,
    StockItem,
    StockMovement,
    StockReserved,
)

T0 = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
A, B = sorted(uuid4() for _ in range(2))


class FakeStock:
    def __init__(self, on_hand: dict[UUID, int]) -> None:
        self.on_hand = on_hand
        self.locked: list[UUID] = []
        self.updates: list[StockItem] = []

    def lock(self, product_id: UUID) -> StockItem | None:
        self.locked.append(product_id)
        if product_id not in self.on_hand:
            return None  # producto inexistente
        return StockItem(product_id, self.on_hand[product_id])

    def update(self, item: StockItem) -> None:
        self.updates.append(item)
        self.on_hand[item.product_id] = item.on_hand


class FakeReservations:
    def __init__(self, *reservations: Reservation) -> None:
        self.rows = {r.id: r for r in reservations}
        self.closed: list[tuple[set[UUID], ReservationStatus]] = []

    def add(self, reservation: Reservation) -> None:
        self.rows[reservation.id] = reservation

    def active_totals(self, product_ids: Collection[UUID], now: datetime) -> dict[UUID, int]:
        totals: dict[UUID, int] = {}
        for r in self.rows.values():
            if r.product_id in product_ids and r.status == "active" and r.expires_at > now:
                totals[r.product_id] = totals.get(r.product_id, 0) + r.quantity
        return totals

    def for_order(self, order_id: UUID, lock: bool = False) -> list[Reservation]:
        rows = [r for r in self.rows.values() if r.order_id == order_id]
        return sorted(rows, key=lambda r: (r.product_id, r.id))

    def latest_expiry(self, product_ids: Collection[UUID]) -> datetime | None:
        rows = [r for r in self.rows.values() if r.product_id in product_ids]
        return max((r.expires_at for r in rows if r.status == "active"), default=None)

    def close(self, reservation_ids: Collection[UUID], status: ReservationStatus) -> None:
        self.closed.append((set(reservation_ids), status))
        for reservation_id in reservation_ids:
            r = self.rows[reservation_id]
            self.rows[reservation_id] = Reservation(
                r.id, r.product_id, r.order_id, r.quantity, r.expires_at, status
            )


class FakeMovements:
    def __init__(self) -> None:
        self.added: list[StockMovement] = []

    def add(self, movement: StockMovement) -> StockMovement:
        self.added.append(movement)
        return movement

    def list_recent(self, product_id: UUID, limit: int) -> list[StockMovement]:
        raise NotImplementedError


def reserved(
    product_id: UUID, order_id: UUID, *, at: datetime = T0, quantity: int = 1
) -> Reservation:
    """Reserva hecha en `at`: vence 30 minutos después."""
    return Reservation(uuid4(), product_id, order_id, quantity, at + timedelta(minutes=30))


def test_consume_at_the_expiry_edge_loses_without_writing() -> None:
    # B-1 / INVENTORY-R11: la reserva de O venció para quien reservó X (T0+30m+1s), pero no
    # para el reloj de quien paga O (T0+30m−1s). Con el reloj efectivo (la creación de X) ya
    # venció (R8); sin él, on_hand 1 no cubriría las dos. En ambos casos pierde O.
    o, x = uuid4(), uuid4()
    stock = FakeStock({A: 1})
    reservations = FakeReservations(
        reserved(A, o), reserved(A, x, at=T0 + timedelta(minutes=30, seconds=1))
    )
    movements = FakeMovements()

    with pytest.raises(ReservationExpired):
        ConsumeReservations(stock, reservations, movements)(
            o, T0 + timedelta(minutes=29, seconds=59)
        )

    assert (stock.updates, movements.added, reservations.closed) == ([], [], [])


EDGE = T0 + timedelta(minutes=29, seconds=59)  # reloj de quien paga, 1 s antes del límite
LATE = T0 + timedelta(minutes=30, seconds=1)  # creación de Z, 1 s después


def test_consume_judges_its_reservations_with_the_effective_clock() -> None:
    # Reloj efectivo, R8: Z se creó en T0+30m+1s, así que a ese reloj la reserva de Y ya venció
    # aunque `now` diga otra cosa. Con stock de sobra, R11 sola no lo detectaría.
    y = uuid4()
    stock = FakeStock({A: 5})
    reservations = FakeReservations(reserved(A, y), reserved(A, uuid4(), at=LATE))
    movements = FakeMovements()

    with pytest.raises(ReservationExpired):
        ConsumeReservations(stock, reservations, movements)(y, EDGE)

    assert (stock.updates, movements.added, reservations.closed) == ([], [], [])


def test_consume_counts_live_reservations_with_the_effective_clock() -> None:
    # P7 de QA: con `now`, la reserva vencida de Y aún contaría (Y + O + Z = 3 > 2) y O, que es
    # vigente, perdería. Con el reloj efectivo Y ya no cuenta: O + Z = 2 y O se vende.
    o = uuid4()
    y_reservation, z_reservation = reserved(A, uuid4()), reserved(A, uuid4(), at=LATE)
    o_reservation = reserved(A, o, at=T0 + timedelta(minutes=10))
    stock = FakeStock({A: 2})
    reservations = FakeReservations(y_reservation, o_reservation, z_reservation)
    movements = FakeMovements()

    ConsumeReservations(stock, reservations, movements)(o, EDGE)

    assert stock.on_hand == {A: 1}
    assert [(m.quantity_delta, m.on_hand_after) for m in movements.added] == [(-1, 1)]
    assert reservations.closed == [({o_reservation.id}, ReservationStatus.CONSUMED)]
    assert reservations.rows[z_reservation.id].status == ReservationStatus.ACTIVE


def test_consume_fails_if_stock_does_not_cover_every_live_reservation() -> None:
    # R11 como red de seguridad: dos reservas vigentes al reloj efectivo y on_hand 1 (un estado
    # que solo dejaría un desfase de relojes). Ni se vende ni se escribe nada.
    o = uuid4()
    stock = FakeStock({A: 1})
    reservations = FakeReservations(
        reserved(A, o, at=T0 + timedelta(minutes=10)),
        reserved(A, uuid4(), at=T0 + timedelta(minutes=15)),
    )
    movements = FakeMovements()

    with pytest.raises(ReservationExpired):
        ConsumeReservations(stock, reservations, movements)(o, T0 + timedelta(minutes=20))

    assert (stock.updates, movements.added, reservations.closed) == ([], [], [])


def test_consume_locks_each_product_once_in_order_and_closes_exactly_its_ids() -> None:
    # M-1: se cierran los ids consumidos, no "las activas del pedido".
    order, other = uuid4(), uuid4()
    mine = [reserved(B, order), reserved(A, order), reserved(B, order, quantity=2)]
    stock = FakeStock({A: 5, B: 5})
    reservations = FakeReservations(*mine, reserved(A, other))
    movements = FakeMovements()

    ConsumeReservations(stock, reservations, movements)(order, T0)

    assert stock.locked == [A, B]
    assert reservations.closed == [({r.id for r in mine}, ReservationStatus.CONSUMED)]
    assert stock.on_hand == {A: 4, B: 2}
    # Un movimiento por reserva; on_hand_after encadena las dos ventas de B (5 → … → 2).
    assert sorted((m.product_id, m.quantity_delta) for m in movements.added) == sorted(
        [(A, -1), (B, -1), (B, -2)]
    )
    b_after = [m.on_hand_after for m in movements.added if m.product_id == B]
    assert b_after in ([4, 2], [3, 2])
    assert [m.on_hand_after for m in movements.added if m.product_id == A] == [4]
    assert {m.kind for m in movements.added} == {MovementKind.VENTA}
    assert {m.order_id for m in movements.added} == {order}
    assert [r.status for r in reservations.for_order(other)] == [ReservationStatus.ACTIVE]


def test_consume_without_active_reservations_writes_nothing() -> None:
    stock, reservations, movements = FakeStock({}), FakeReservations(), FakeMovements()

    ConsumeReservations(stock, reservations, movements)(uuid4(), T0)

    assert (stock.locked, movements.added, reservations.closed) == ([], [], [])


def test_release_closes_exactly_the_active_ids_once() -> None:
    order, other = uuid4(), uuid4()
    mine = [reserved(A, order), reserved(B, order)]
    reservations = FakeReservations(*mine, reserved(A, other))
    release = ReleaseReservations(reservations)

    release(order)
    release(order)  # idempotente: ya no quedan activas, no se cierra nada más

    assert reservations.closed == [({r.id for r in mine}, ReservationStatus.RELEASED)]
    assert [r.status for r in reservations.for_order(other)] == [ReservationStatus.ACTIVE]


# --- Administración (T-043): RecordMovement y ChangeThreshold ---

ADMIN = Actor(uuid4(), "admin")


class FakeAvailability:
    """Lo reservado vigente de cada producto. Falla si se lee antes de bloquear su stock: lo
    reservado tiene que ser el de bajo el bloqueo (R6, O1)."""

    def __init__(self, stock: FakeStock, reserved: dict[UUID, int]) -> None:
        self.stock = stock
        self.reserved = reserved

    def get(self, product_id: UUID) -> Availability | None:
        assert product_id in self.stock.locked, "lo reservado se leyó antes del bloqueo"
        available = self.stock.on_hand[product_id] - self.reserved.get(product_id, 0)
        return Availability(product_id, available, AvailabilityStatus.IN_STOCK, None)


class FakeAudit:
    def __init__(self) -> None:
        self.entries: list[AuditEntry] = []

    def record(self, entry: AuditEntry) -> None:
        self.entries.append(entry)


def record_movement(
    on_hand: dict[UUID, int], reserved: dict[UUID, int]
) -> tuple[RecordMovement, FakeStock, FakeMovements, FakeAudit]:
    stock, movements, audit = FakeStock(on_hand), FakeMovements(), FakeAudit()
    use_case = RecordMovement(stock, FakeAvailability(stock, reserved), movements, audit)
    return use_case, stock, movements, audit


def test_record_movement_updates_stock_and_audits_with_the_actor() -> None:
    record, stock, movements, audit = record_movement({A: 5}, {A: 2})

    movement = record(A, MovementKind.MERMA, 2, "  Rotura ", ADMIN)

    assert movement == StockMovement(A, MovementKind.MERMA, -2, 3, "Rotura", ADMIN.user_id)
    assert stock.updates == [StockItem(A, 3)]
    assert movements.added == [movement]
    # INVENTORY-R7: before/after de on_hand y el motivo, con el actor del token.
    assert audit.entries == [
        AuditEntry(
            "inventory.stock_adjusted",
            "product",
            str(A),
            ADMIN.user_id,
            "admin",
            before={"on_hand": 5},
            after={"on_hand": 3, "kind": "merma"},
        )
    ]


@pytest.mark.parametrize(
    ("kind", "quantity", "error", "details"),
    [
        (MovementKind.MERMA, 4, StockReserved, (5, 2)),  # 1 < 2 reservadas
        (MovementKind.AJUSTE_INVENTARIO, 1, StockReserved, (5, 2)),
        (MovementKind.MERMA, 6, InsufficientStock, (5, 2)),  # bajo 0 gana a bajo lo reservado
    ],
)
def test_record_movement_checks_r6_with_the_reservations_read_under_the_lock(
    kind: MovementKind, quantity: int, error: type[Exception], details: tuple[int, int]
) -> None:
    record, stock, movements, audit = record_movement({A: 5}, {A: 2})

    with pytest.raises(error) as raised:
        record(A, kind, quantity, "Recuento", ADMIN)

    assert (raised.value.on_hand, raised.value.reserved) == details  # type: ignore[attr-defined]
    assert stock.locked == [A]
    assert (stock.updates, movements.added, audit.entries) == ([], [], [])


def test_record_movement_with_a_count_equal_to_on_hand_writes_nothing() -> None:
    record, stock, movements, audit = record_movement({A: 5}, {})

    with pytest.raises(NoChange):
        record(A, MovementKind.AJUSTE_INVENTARIO, 5, "Recuento", ADMIN)

    assert (stock.updates, movements.added, audit.entries) == ([], [], [])


def test_record_movement_on_an_unknown_product_is_not_found() -> None:
    record, stock, movements, audit = record_movement({}, {})

    with pytest.raises(ProductNotFound):
        record(A, MovementKind.ENTRADA, 1, None, ADMIN)

    assert (stock.updates, movements.added, audit.entries) == ([], [], [])


class FakeSettings:
    def __init__(self, threshold: int) -> None:
        self.current = InventorySettings(threshold)
        self.locked = False
        self.updates: list[InventorySettings] = []

    def get(self, lock: bool = False) -> InventorySettings:
        self.locked = self.locked or lock
        return self.current

    def update(self, settings: InventorySettings) -> None:
        assert self.locked, "el umbral se escribe sin haber bloqueado la fila"
        self.updates.append(settings)
        self.current = settings


def test_change_threshold_updates_and_audits_it() -> None:
    settings, audit = FakeSettings(2), FakeAudit()

    result = ChangeThreshold(settings, audit)(5, ADMIN)

    assert result == InventorySettings(5)
    assert settings.updates == [InventorySettings(5)]
    assert audit.entries == [
        AuditEntry(
            "inventory.threshold_changed",
            "inventory_settings",
            "1",
            ADMIN.user_id,
            "admin",
            before={"low_stock_threshold": 2},
            after={"low_stock_threshold": 5},
        )
    ]


def test_same_threshold_is_neither_written_nor_audited() -> None:
    settings, audit = FakeSettings(3), FakeAudit()

    assert ChangeThreshold(settings, audit)(3, ADMIN) == InventorySettings(3)

    assert (settings.updates, audit.entries) == ([], [])
