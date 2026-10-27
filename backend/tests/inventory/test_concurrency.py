"""Concurrencia real contra valmont_test: cada transacción en su propia conexión, en hilos
(CA-INVENTORY-02 y 06). Los datos se confirman, así que cada prueba borra al final lo suyo."""

import queue
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, delete, insert, select, text
from sqlalchemy.orm import Session

from tests.inventory.inventory_helpers import add_product, consume_reservations, reserve_stock
from valmont.modules.inventory.adapters.persistence import (
    InventoryItemRow,
    SqlProductPolicies,
    SqlReservationRepository,
    SqlStockRepository,
    StockMovementRow,
    StockReservationRow,
)
from valmont.modules.inventory.application import ReservedOrder, ReserveStock
from valmont.modules.inventory.domain import (
    InsufficientStock,
    OrderLine,
    ReservationExpired,
    StockItem,
)

pytestmark = pytest.mark.integration

TIMEOUT = 10  # s; ninguna espera de estas pruebas debería acercarse


def in_transaction[T](engine: Engine, work: Callable[[Session], T]) -> T:
    """Una transacción en una conexión propia: commit si `work` termina, rollback si falla."""
    with Session(engine) as session, session.begin():
        return work(session)


@pytest.fixture
def stocked(db_engine: Engine) -> Iterator[Callable[[int], UUID]]:
    """Crea y confirma productos con su on_hand; al final borra todo lo que cuelga de ellos."""
    created: list[UUID] = []

    def create(on_hand: int) -> UUID:
        with Session(db_engine) as session, session.begin():
            product_id = add_product(session)
            session.execute(insert(InventoryItemRow).values(product_id=product_id, on_hand=on_hand))
        created.append(product_id)
        return product_id

    yield create
    with Session(db_engine) as session, session.begin():
        for row in (StockMovementRow, StockReservationRow, InventoryItemRow):
            session.execute(delete(row).where(row.product_id.in_(created)))
        categories = session.scalars(
            text("DELETE FROM app.products WHERE id = ANY(:ids) RETURNING category_id"),
            {"ids": created},
        ).all()
        session.execute(
            text("DELETE FROM app.categories WHERE id = ANY(:ids)"), {"ids": categories}
        )


def wait_until_blocked(engine: Engine, backend_pid: int) -> None:
    """Espera a que la conexión `backend_pid` esté esperando un bloqueo de otra transacción."""
    query = text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid")
    deadline = time.monotonic() + TIMEOUT
    with engine.connect() as connection:
        while time.monotonic() < deadline:
            waiting = connection.scalar(query, {"pid": backend_pid})
            connection.rollback()  # pg_stat_activity se congela dentro de una transacción
            if waiting == "Lock":
                return
            time.sleep(0.02)
    pytest.fail("La segunda transacción nunca esperó el bloqueo de la primera.")


def active_reservations(engine: Engine, product_id: UUID) -> int:
    with Session(engine) as session:
        stmt = select(StockReservationRow.quantity).filter_by(
            product_id=product_id, status="active"
        )
        return len(session.scalars(stmt).all())


def test_two_orders_for_the_last_unit_reserve_exactly_once(
    db_engine: Engine, stocked: Callable[[int], UUID]
) -> None:
    # CA-INVENTORY-02 / RN-06. La primera reserva y no confirma hasta que la segunda está
    # esperando su bloqueo: así la carrera ocurre siempre, no solo con suerte.
    product_id = stocked(1)
    line = [OrderLine(product_id, 1)]
    first_reserved, first_may_commit = threading.Event(), threading.Event()
    second_pid: queue.Queue[int] = queue.Queue()

    def first(session: Session) -> ReservedOrder:
        result = reserve_stock(session)(uuid4(), line, datetime.now(UTC))
        first_reserved.set()
        assert first_may_commit.wait(TIMEOUT)
        return result

    def second(session: Session) -> ReservedOrder:
        second_pid.put(session.scalars(text("SELECT pg_backend_pid()")).one())
        return reserve_stock(session)(uuid4(), line, datetime.now(UTC))

    with ThreadPoolExecutor(2) as pool:
        try:
            winner = pool.submit(in_transaction, db_engine, first)
            assert first_reserved.wait(TIMEOUT)
            loser = pool.submit(in_transaction, db_engine, second)
            wait_until_blocked(db_engine, second_pid.get(timeout=TIMEOUT))
        finally:
            first_may_commit.set()
        assert len(winner.result(TIMEOUT).reservations) == 1
        with pytest.raises(InsufficientStock) as exc:
            loser.result(TIMEOUT)

    assert exc.value.product_ids == (product_id,)
    assert active_reservations(db_engine, product_id) == 1


class PausingStock(SqlStockRepository):
    """Tras su primer bloqueo espera (hasta 1 s) a que la otra transacción tenga el suyo. Con
    bloqueos sin ordenar, cada una tendría un producto y pediría el de la otra: interbloqueo.
    Ordenados, la segunda espera el primer producto y nunca llega a la barrera."""

    def __init__(self, session: Session, barrier: threading.Barrier) -> None:
        super().__init__(session)
        self._barrier: threading.Barrier | None = barrier

    def lock(self, product_id: UUID) -> StockItem | None:
        item = super().lock(product_id)
        if self._barrier is not None:
            with suppress(threading.BrokenBarrierError):
                self._barrier.wait(timeout=1)
            self._barrier = None
        return item


def test_orders_with_the_same_products_in_reverse_order_do_not_deadlock(
    db_engine: Engine, stocked: Callable[[int], UUID]
) -> None:
    # CA-INVENTORY-06 (INVENTORY-R4: bloqueos ordenados por product_id).
    a, b = stocked(2), stocked(2)
    barrier = threading.Barrier(2)

    def reserve(*products: UUID) -> Callable[[Session], ReservedOrder]:
        def work(session: Session) -> ReservedOrder:
            use_case = ReserveStock(
                SqlProductPolicies(session),
                PausingStock(session, barrier),
                SqlReservationRepository(session),
            )
            lines = [OrderLine(p, 1) for p in products]
            return use_case(uuid4(), lines, datetime.now(UTC))

        return work

    with ThreadPoolExecutor(2) as pool:
        orders = [
            pool.submit(in_transaction, db_engine, reserve(a, b)),
            pool.submit(in_transaction, db_engine, reserve(b, a)),
        ]
        results = [order.result(TIMEOUT) for order in orders]

    assert [len(result.reservations) for result in results] == [2, 2]
    assert (active_reservations(db_engine, a), active_reservations(db_engine, b)) == (2, 2)


def test_an_expired_reservation_stops_counting_and_its_unit_can_be_sold_again(
    db_engine: Engine, stocked: Callable[[int], UUID]
) -> None:
    # CA-INVENTORY-02 y 04: cada paso en su propia conexión, confirmado. La reserva de `late`
    # se hizo hace 31 minutos y nadie la liberó.
    product_id = stocked(1)
    line = [OrderLine(product_id, 1)]
    late, on_time, now = uuid4(), uuid4(), datetime.now(UTC)
    in_transaction(db_engine, lambda s: reserve_stock(s)(late, line, now - timedelta(minutes=31)))

    result = in_transaction(db_engine, lambda s: reserve_stock(s)(on_time, line, now))

    assert len(result.reservations) == 1
    with pytest.raises(ReservationExpired):
        in_transaction(db_engine, lambda s: consume_reservations(s)(late, now))
    in_transaction(db_engine, lambda s: consume_reservations(s)(on_time, now))
    with Session(db_engine) as session:
        assert session.get(InventoryItemRow, product_id).on_hand == 0  # type: ignore[union-attr]
