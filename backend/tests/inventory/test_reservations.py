"""ReserveStock, ConsumeReservations y ReleaseReservations contra la BD (una conexión; la
concurrencia está en test_concurrency.py). Datos ficticios."""

from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from tests.inventory.inventory_helpers import (
    LEAD_TIME_DAYS,
    add_product,
    add_reservation,
    consume_reservations,
    release_reservations,
    reserve_stock,
)
from valmont.modules.inventory.adapters.persistence import (
    InventoryItemRow,
    SqlAvailabilityReader,
    SqlMovementRepository,
    SqlReservationRepository,
)
from valmont.modules.inventory.domain import (
    InsufficientStock,
    MovementKind,
    OnRequestLine,
    OrderLine,
    Reservation,
    ReservationExpired,
    ReservationStatus,
    StockMovement,
)

pytestmark = pytest.mark.integration


def product(session: Session, on_hand: int | None, policy: str = "stock") -> UUID:
    product_id = add_product(session, policy)
    if on_hand is not None:
        session.execute(insert(InventoryItemRow).values(product_id=product_id, on_hand=on_hand))
    return product_id


def db_now(session: Session) -> datetime:
    # El reloj de la vista: now() de la transacción.
    return session.scalars(select(func.now())).one()


def available(session: Session, product_id: UUID) -> int:
    row = SqlAvailabilityReader(session).get(product_id)
    assert row is not None
    return row.available


def on_hand(session: Session, product_id: UUID) -> int | None:
    return session.scalar(select(InventoryItemRow.on_hand).filter_by(product_id=product_id))


def statuses(session: Session, order_id: UUID) -> list[ReservationStatus]:
    return [r.status for r in SqlReservationRepository(session).for_order(order_id)]


def test_reserve_creates_an_active_reservation_per_line_that_expires_in_30_minutes(
    db_session: Session,
) -> None:
    a, b = product(db_session, 3), product(db_session, 2, "backorder")
    order_id, now = uuid4(), db_now(db_session)

    result = reserve_stock(db_session)(order_id, [OrderLine(a, 2), OrderLine(b, 2)], now)

    expires_at = now + timedelta(minutes=30)
    assert [(r.product_id, r.quantity, r.expires_at) for r in result.reservations] == [
        (a, 2, expires_at),
        (b, 2, expires_at),
    ]
    assert result.on_request == []
    stored = SqlReservationRepository(db_session).for_order(order_id)
    assert sorted(stored, key=lambda r: r.id) == sorted(result.reservations, key=lambda r: r.id)
    assert (available(db_session, a), available(db_session, b)) == (1, 0)


def test_on_request_lines_do_not_reserve_in_a_mixed_order(db_session: Session) -> None:
    # CA-INVENTORY-03 (RN-16, INVENTORY-R10).
    a = product(db_session, 1)
    short_backorder = product(db_session, 1, "backorder")
    made = product(db_session, 5, "made_to_order")
    unstocked_made = product(db_session, None, "made_to_order")
    order_id = uuid4()
    lines = [
        OrderLine(made, 1),
        OrderLine(short_backorder, 2),
        OrderLine(a, 1),
        OrderLine(unstocked_made, 1),
    ]

    result = reserve_stock(db_session)(order_id, lines, db_now(db_session))

    assert [(r.product_id, r.quantity) for r in result.reservations] == [(a, 1)]
    assert result.on_request == [
        OnRequestLine(made, 1, LEAD_TIME_DAYS),
        OnRequestLine(short_backorder, 2, LEAD_TIME_DAYS),
        OnRequestLine(unstocked_made, 1, LEAD_TIME_DAYS),
    ]
    assert available(db_session, made) == 5
    assert on_hand(db_session, unstocked_made) is None  # made_to_order ni se bloquea


def test_reserve_is_all_or_nothing(db_session: Session) -> None:
    a, empty, missing_row = (
        product(db_session, 1),
        product(db_session, 0),
        product(db_session, None),
    )
    order_id = uuid4()
    lines = [OrderLine(a, 1), OrderLine(empty, 1), OrderLine(missing_row, 1)]

    with pytest.raises(InsufficientStock) as exc:
        reserve_stock(db_session)(order_id, lines, db_now(db_session))

    assert exc.value.product_ids == (empty, missing_row)
    assert statuses(db_session, order_id) == []
    assert available(db_session, a) == 1


def test_an_expired_reservation_does_not_count(db_session: Session) -> None:
    # CA-INVENTORY-02: vence sola, sin procesos en segundo plano (R1).
    a = product(db_session, 1)
    add_reservation(db_session, a, 1, minutes=-1)

    result = reserve_stock(db_session)(uuid4(), [OrderLine(a, 1)], db_now(db_session))

    assert len(result.reservations) == 1


def test_an_unknown_product_is_a_programming_error(db_session: Session) -> None:
    with pytest.raises(LookupError):
        reserve_stock(db_session)(uuid4(), [OrderLine(uuid4(), 1)], db_now(db_session))


def reserve(session: Session, *lines: tuple[UUID, int], minutes_ago: int = 0) -> UUID:
    order_id = uuid4()
    now = db_now(session) - timedelta(minutes=minutes_ago)
    reserve_stock(session)(order_id, [OrderLine(*line) for line in lines], now)
    return order_id


def test_consume_sells_the_reserved_units(db_session: Session) -> None:
    # CA-INVENTORY-04.
    a, b = product(db_session, 3), product(db_session, 2, "backorder")
    order_id = reserve(db_session, (a, 2), (b, 1))

    consume_reservations(db_session)(order_id, db_now(db_session))

    assert (on_hand(db_session, a), on_hand(db_session, b)) == (1, 1)
    assert (available(db_session, a), available(db_session, b)) == (1, 1)
    assert statuses(db_session, order_id) == [ReservationStatus.CONSUMED] * 2
    [sale] = SqlMovementRepository(db_session).list_recent(a, 50)
    assert sale == StockMovement(
        a, MovementKind.VENTA, -2, 1, order_id=order_id, id=sale.id, created_at=sale.created_at
    )


def test_consume_is_idempotent(db_session: Session) -> None:
    a = product(db_session, 3)
    order_id = reserve(db_session, (a, 2))
    consume = consume_reservations(db_session)
    consume(order_id, db_now(db_session))

    consume(order_id, db_now(db_session))

    assert on_hand(db_session, a) == 1
    assert len(SqlMovementRepository(db_session).list_recent(a, 50)) == 1


def test_consume_of_an_order_without_reservations_does_nothing(db_session: Session) -> None:
    made = product(db_session, None, "made_to_order")
    order_id = reserve(db_session, (made, 1))

    consume_reservations(db_session)(order_id, db_now(db_session))

    assert SqlMovementRepository(db_session).list_recent(made, 50) == []


def test_consume_of_an_expired_reservation_fails_without_changes(db_session: Session) -> None:
    # INVENTORY-R8: reservada hace 31 minutos, venció hace 1.
    a, b = product(db_session, 3), product(db_session, 3)
    order_id = reserve(db_session, (a, 1), (b, 1), minutes_ago=31)

    with pytest.raises(ReservationExpired):
        consume_reservations(db_session)(order_id, db_now(db_session))

    assert (on_hand(db_session, a), on_hand(db_session, b)) == (3, 3)
    assert statuses(db_session, order_id) == [ReservationStatus.ACTIVE] * 2
    assert SqlMovementRepository(db_session).list_recent(a, 50) == []


def test_consume_at_the_expiry_edge_loses_to_the_order_that_reserved_validly(
    db_session: Session,
) -> None:
    # B-1 / INVENTORY-R11, la secuencia de la sonda de QA con on_hand 1: X reserva cuando la
    # reserva de O ya venció (T0+30m+1s) y O paga con un reloj un segundo antes del límite. Al
    # reloj efectivo (la creación de X) la reserva de O ya venció: falla por R8.
    a = product(db_session, 1)
    o, x, t0 = uuid4(), uuid4(), db_now(db_session)
    reserve_stock(db_session)(o, [OrderLine(a, 1)], t0)
    reserve_stock(db_session)(x, [OrderLine(a, 1)], t0 + timedelta(minutes=30, seconds=1))

    with pytest.raises(ReservationExpired):
        consume_reservations(db_session)(o, t0 + timedelta(minutes=29, seconds=59))

    assert on_hand(db_session, a) == 1
    assert SqlMovementRepository(db_session).list_recent(a, 50) == []
    assert statuses(db_session, o) == [ReservationStatus.ACTIVE]
    consume_reservations(db_session)(x, t0 + timedelta(minutes=30, seconds=2))
    assert on_hand(db_session, a) == 0
    assert statuses(db_session, x) == [ReservationStatus.CONSUMED]


def test_a_valid_order_is_not_beaten_by_two_others_at_the_edge(db_session: Session) -> None:
    # P7 de QA (reloj efectivo de R11), on_hand 2. Para Z la reserva de Y ya venció; O, que es
    # vigente, paga con un reloj 1 s antes del límite de Y. Con `now`, Y + O + Z = 3 > 2 y O
    # perdería; al reloj efectivo (la creación de Z) Y no cuenta y O se vende.
    a = product(db_session, 2)
    y, o, z, t0 = uuid4(), uuid4(), uuid4(), db_now(db_session)
    edge = t0 + timedelta(minutes=29, seconds=59)
    reserve_stock(db_session)(y, [OrderLine(a, 1)], t0)
    reserve_stock(db_session)(o, [OrderLine(a, 1)], t0 + timedelta(minutes=10))
    late = reserve_stock(db_session)(z, [OrderLine(a, 1)], t0 + timedelta(minutes=30, seconds=1))
    assert len(late.reservations) == 1

    consume_reservations(db_session)(o, edge)

    assert on_hand(db_session, a) == 1
    sales = SqlMovementRepository(db_session).list_recent(a, 50)
    assert [(m.kind, m.quantity_delta, m.order_id) for m in sales] == [(MovementKind.VENTA, -1, o)]
    assert statuses(db_session, o) == [ReservationStatus.CONSUMED]
    assert statuses(db_session, z) == [ReservationStatus.ACTIVE]

    # Y, que sí venció al reloj efectivo, ya no se puede cobrar (R8) y no cambia nada.
    with pytest.raises(ReservationExpired):
        consume_reservations(db_session)(y, edge)

    assert on_hand(db_session, a) == 1
    assert len(SqlMovementRepository(db_session).list_recent(a, 50)) == 1
    assert statuses(db_session, y) == [ReservationStatus.ACTIVE]


def test_release_frees_the_stock_and_is_idempotent(db_session: Session) -> None:
    a = product(db_session, 1)
    order_id = reserve(db_session, (a, 1))
    assert available(db_session, a) == 0
    release = release_reservations(db_session)

    release(order_id)
    release(order_id)

    assert statuses(db_session, order_id) == [ReservationStatus.RELEASED]
    assert available(db_session, a) == 1
    with pytest.raises(ReservationExpired):  # liberada: ya no se puede cobrar (I-6)
        consume_reservations(db_session)(order_id, db_now(db_session))


def test_release_does_not_touch_consumed_reservations(db_session: Session) -> None:
    a = product(db_session, 2)
    order_id = reserve(db_session, (a, 1))
    consume_reservations(db_session)(order_id, db_now(db_session))

    release_reservations(db_session)(order_id)

    assert statuses(db_session, order_id) == [ReservationStatus.CONSUMED]
    assert on_hand(db_session, a) == 1


def test_reservations_round_trip(db_session: Session) -> None:
    a = product(db_session, 1)
    reservation = Reservation(uuid4(), a, uuid4(), 1, db_now(db_session))
    repo = SqlReservationRepository(db_session)

    repo.add(reservation)

    assert repo.for_order(reservation.order_id, lock=True) == [reservation]
    assert repo.active_totals([a], db_now(db_session) - timedelta(seconds=1)) == {a: 1}
    assert repo.active_totals([a], db_now(db_session)) == {}  # vence justo ahora: no cuenta
    assert repo.latest_expiry([a]) == reservation.expires_at  # activa, aunque ya venció

    released_later = Reservation(
        uuid4(),
        a,
        uuid4(),
        1,
        reservation.expires_at + timedelta(hours=1),
        ReservationStatus.RELEASED,
    )
    repo.add(released_later)

    assert repo.latest_expiry([a]) == reservation.expires_at  # solo cuentan las activas
    assert repo.latest_expiry([uuid4()]) is None
