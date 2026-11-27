"""Caducidad por lectura con dos conexiones reales (T-075; CA-ORDERS-13 y 15 en lo que toca a la
lectura; SPEC §4 R4 y R7): una fila que otra transacción tiene bloqueada (un pago o una cancelación)
se salta, la lectura no espera y no libera ni audita lo que no cambió; al soltarse, la siguiente
lectura la materializa una sola vez. Casos de uso reales sobre `SqlOrderRepository`; el reloj es
fijo (los pedidos nacen en `BASE`) y la liberación y la auditoría son registros en memoria, porque
`app.audit_log` es de solo inserción y estos datos se confirman. Cada espera lleva `lock_timeout`:
si el código esperase, la prueba fallaría en segundos en vez de colgarse. Ficticios."""

from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.orders import test_repository_concurrency as concurrency
from tests.orders.orders_create_helpers import Calls, FakeAudit
from tests.orders.orders_db_helpers import change, history_of, status_in_db
from tests.orders.test_my_orders_usecases import Release
from tests.orders.test_repository_concurrency import LOCK_TIMEOUT, OVERDUE, Factory
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.application import ExpireOverdueOrders, GetMyOrder, ListMyOrders
from valmont.modules.orders.domain import ActorKind, OrderNotFound, OrderStatus

pytestmark = pytest.mark.integration

committed = (
    concurrency.committed
)  # fixture compartida con las pruebas de concurrencia del repositorio
PENDING, PAID, CANCELLED = OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderStatus.CANCELLED


@dataclass
class FixedClock:
    at: datetime

    def now(self) -> datetime:
        return self.at


@dataclass
class Reader:
    """Casos de uso de lectura sobre una sesión, con liberación y auditoría en memoria."""

    expire: ExpireOverdueOrders
    get: GetMyOrder
    list: ListMyOrders
    release: Release
    audit: FakeAudit


def reader(session: Session) -> Reader:
    calls = Calls()
    repository = SqlOrderRepository(session)
    release, audit = Release(calls), FakeAudit(calls)
    expire = ExpireOverdueOrders(repository, release, audit, FixedClock(OVERDUE))  # type: ignore[arg-type]
    return Reader(
        expire,
        GetMyOrder(repository, expire),
        ListMyOrders(repository, expire),
        release,
        audit,
    )


def rows_of(engine: Engine, order_id: object) -> tuple[str, int]:
    with Session(engine) as session:
        return status_in_db(session, order_id), len(history_of(session, order_id))


def test_get_my_order_does_not_wait_for_a_locked_row_and_expires_it_on_the_next_read(
    db_engine: Engine, committed: Factory
) -> None:
    (order,) = committed()
    with Session(db_engine) as holder, holder.begin():
        assert SqlOrderRepository(holder).get(order.id, lock=True) is not None
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            during = reader(session)

            seen = during.get(order.user_id, order.id)

        assert seen.status == PENDING  # el estado confirmado: no esperó ni cambió nada
        assert during.release.released == [] and during.audit.entries == []
        assert rows_of(db_engine, order.id) == ("pendiente_pago", 1)

    with Session(db_engine) as session, session.begin():
        after = reader(session)
        seen = after.get(order.user_id, order.id)

    assert seen.status == OrderStatus.EXPIRED
    assert after.release.released == [order.id] and len(after.audit.entries) == 1
    assert rows_of(db_engine, order.id) == ("expirado", 2)


def test_the_list_does_not_wait_for_a_locked_row_either(
    db_engine: Engine, committed: Factory
) -> None:
    locked, free = committed(2)
    with Session(db_engine) as holder, holder.begin():
        assert SqlOrderRepository(holder).get(locked.id, lock=True) is not None
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            during = reader(session)

            page_locked = during.list(locked.user_id, statuses=None, page=1, page_size=20)
            page_free = during.list(free.user_id, statuses=None, page=1, page_size=20)

    assert [(s.id, s.status) for s in page_locked.items] == [(locked.id, PENDING)]
    assert [(s.id, s.status) for s in page_free.items] == [(free.id, OrderStatus.EXPIRED)]
    assert during.release.released == [free.id]
    assert rows_of(db_engine, locked.id) == ("pendiente_pago", 1)
    assert rows_of(db_engine, free.id) == ("expirado", 2)


def test_a_cancellation_that_holds_the_row_wins_over_the_expiry_by_reading(
    db_engine: Engine, committed: Factory
) -> None:
    (order,) = committed()
    holder = Session(db_engine)
    holder.begin()
    try:
        repository = SqlOrderRepository(holder)
        repository.get(order.id, lock=True)
        repository.apply(
            order.id, change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id)
        )
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            during = reader(session)
            seen = during.get(order.user_id, order.id)
        holder.commit()
    finally:
        holder.close()

    with Session(db_engine) as session, session.begin():
        after = reader(session)
        final = after.get(order.user_id, order.id)

    assert seen.status == PENDING  # lo confirmado mientras la cancelación no confirma
    assert final.status == CANCELLED  # la cancelación ganó: nunca `expirado`
    for who in (during, after):
        assert who.release.released == [] and who.audit.entries == []
    assert rows_of(db_engine, order.id) == ("cancelado", 2)  # creación + cancelación


def test_a_payment_that_holds_the_row_wins_over_the_expiry_by_reading(
    db_engine: Engine, committed: Factory
) -> None:
    (order,) = committed()
    holder = Session(db_engine)
    holder.begin()
    try:
        repository = SqlOrderRepository(holder)
        repository.get(order.id, lock=True)
        repository.apply(
            order.id,
            change(PENDING, PAID, kind=ActorKind.CUSTOMER, actor_id=order.user_id),
            paid=True,
        )
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            during = reader(session)
            during.get(order.user_id, order.id)
        holder.commit()
    finally:
        holder.close()

    with Session(db_engine) as session, session.begin():
        after = reader(session)
        final = after.get(order.user_id, order.id)

    assert final.status == PAID and final.paid_at is not None
    assert during.release.released == after.release.released == []
    assert rows_of(db_engine, order.id) == ("pagado", 2)


def test_two_simultaneous_reads_expire_each_order_once(
    db_engine: Engine, committed: Factory
) -> None:
    (order,) = committed()
    holder = Session(db_engine)
    holder.begin()
    try:
        first = reader(holder)
        first.get(order.user_id, order.id)  # materializa y NO confirma: fila bloqueada
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            second = reader(session)
            second.get(order.user_id, order.id)  # la salta: ni espera ni repite
        holder.commit()
    finally:
        holder.close()

    assert first.release.released == [order.id] and len(first.audit.entries) == 1
    assert second.release.released == [] and second.audit.entries == []
    assert rows_of(db_engine, order.id) == ("expirado", 2)  # un solo historial `system`
    with Session(db_engine) as session:
        system = [h for h in history_of(session, order.id) if h[2] == "system"]
        assert len(system) == 1


def test_a_read_of_a_locked_order_of_someone_else_still_answers_not_found(
    db_engine: Engine, committed: Factory
) -> None:
    (order,) = committed()
    with Session(db_engine) as holder, holder.begin():
        SqlOrderRepository(holder).get(order.id, lock=True)
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            with pytest.raises(OrderNotFound):
                reader(session).get(uuid4(), order.id)

    with Session(db_engine) as session:
        assert (
            session.scalar(text("SELECT status FROM app.orders WHERE id = :id"), {"id": order.id})
            == "pendiente_pago"
        )
