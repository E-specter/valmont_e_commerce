"""Concurrencia del repositorio de orders (CA-ORDERS-13, ORDERS-R4, R7 y R8): dos conexiones
reales, cada una en su transacción, contra valmont_test. Los datos se confirman, así que cada
prueba borra al final lo suyo (los pedidos arrastran líneas, entrega e historial por CASCADE; luego
perfiles, productos y categorías).

Las esperas llevan `lock_timeout`: si el código no se salta o no espera como debe, la prueba
falla en segundos en vez de colgarse."""

from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_product, add_profile
from tests.cart.test_concurrency import race
from tests.orders.orders_db_helpers import BASE, change, history_of, status_in_db
from tests.orders.orders_helpers import make_line, shipping_delivery
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.domain import (
    ActorKind,
    IdempotencyConflict,
    InvalidTransition,
    Order,
    OrderStatus,
    build_order,
)

pytestmark = pytest.mark.integration

PENDING, PAID, CANCELLED = OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderStatus.CANCELLED
OVERDUE = BASE + timedelta(minutes=31)
LOCK_TIMEOUT = text("SET LOCAL lock_timeout = '3s'")

Factory = Callable[..., list[Order]]


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Factory]:
    """Confirma `count` pedidos pendientes (cada uno con su cliente y su producto), o con
    `user_id`/`key` dados; al final borra lo suyo."""
    users: list[UUID] = []
    products: list[UUID] = []
    orders: list[UUID] = []

    def create(
        count: int = 1, *, user_id: UUID | None = None, key: str | None = None, add: bool = True
    ) -> list[Order]:
        made: list[Order] = []
        with Session(db_engine) as session, session.begin():
            repository = SqlOrderRepository(session)
            for _ in range(count):
                user = user_id or add_profile(session)
                product = add_product(session)
                users.append(user)
                products.append(product)
                line = replace(make_line(), product_id=product)
                order = build_order(
                    uuid4(),
                    user,
                    key or f"key-{uuid4().hex}",
                    [line],
                    shipping_delivery(),
                    BASE,
                )
                made.append(repository.add(order) if add else order)
                orders.append(order.id)
        return made

    yield create
    with Session(db_engine) as session, session.begin():
        categories = session.scalars(
            text("SELECT category_id FROM app.products WHERE id = ANY(:ids)"), {"ids": products}
        ).all()
        session.execute(text("DELETE FROM app.orders WHERE id = ANY(:ids)"), {"ids": orders})
        session.execute(text("DELETE FROM app.profiles WHERE user_id = ANY(:ids)"), {"ids": users})
        session.execute(text("DELETE FROM app.products WHERE id = ANY(:ids)"), {"ids": products})
        session.execute(
            text("DELETE FROM app.categories WHERE id = ANY(:ids)"), {"ids": list(categories)}
        )


# ---------------------------------------------------------------------------------------------
# get(lock=True): FOR UPDATE (ORDERS-R4).
def test_a_second_connection_waits_for_the_row_lock_and_then_reads_the_new_state(
    db_engine: Engine, committed: Factory
) -> None:
    # `race` falla si la segunda conexión nunca llega a esperar un bloqueo: así `lock=True` es de
    # verdad FOR UPDATE y no una lectura normal.
    (order,) = committed()

    def first(session: Session) -> OrderStatus:
        repository = SqlOrderRepository(session)
        locked = repository.get(order.id, lock=True)
        assert locked is not None
        repository.apply(
            order.id,
            change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id),
        )
        return locked.status

    def second(session: Session) -> OrderStatus:
        seen = SqlOrderRepository(session).get(order.id, lock=True)
        assert seen is not None
        return seen.status

    before, after = race(db_engine, first, second)

    assert before == PENDING
    assert after == CANCELLED  # la espera terminó con el commit de la primera y ve su cambio


def test_get_with_lock_and_a_foreign_owner_does_not_lock_the_row(
    db_engine: Engine, committed: Factory
) -> None:
    (order,) = committed()

    with Session(db_engine) as intruder, intruder.begin():
        assert SqlOrderRepository(intruder).get(order.id, user_id=uuid4(), lock=True) is None
        # Sin bloqueo ajeno: la fila sigue disponible para el dueño.
        with Session(db_engine) as owner, owner.begin():
            owner.execute(LOCK_TIMEOUT)
            assert SqlOrderRepository(owner).get(order.id, user_id=order.user_id, lock=True)


def test_a_plain_get_does_not_wait_for_a_locked_row(db_engine: Engine, committed: Factory) -> None:
    (order,) = committed()

    with Session(db_engine) as holder, holder.begin():
        assert SqlOrderRepository(holder).get(order.id, lock=True) is not None
        with Session(db_engine) as reader, reader.begin():
            reader.execute(LOCK_TIMEOUT)
            read = SqlOrderRepository(reader).get(order.id)

    assert read is not None and read.status == PENDING


def test_the_second_writer_that_locked_first_finds_the_state_changed_and_apply_refuses(
    db_engine: Engine, committed: Factory
) -> None:
    # El protocolo de R4: bloquear, comparar y cambiar. Quien espera ve el estado nuevo y su
    # `apply` con el estado esperado antiguo lanza InvalidTransition sin escribir nada.
    (order,) = committed()

    def cancel(session: Session) -> str:
        repository = SqlOrderRepository(session)
        repository.get(order.id, lock=True)
        repository.apply(
            order.id,
            change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id),
        )
        return "cancelled"

    def pay(session: Session) -> str:
        repository = SqlOrderRepository(session)
        seen = repository.get(order.id, lock=True)
        assert seen is not None and seen.status == CANCELLED
        try:
            repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
        except InvalidTransition:
            return "refused"
        return "applied"

    assert race(db_engine, cancel, pay) == ("cancelled", "refused")

    with Session(db_engine) as session:
        assert status_in_db(session, order.id) == "cancelado"
        assert len(history_of(session, order.id)) == 2  # creación + cancelación; ni rastro del pago
        assert (
            session.scalar(text("SELECT paid_at FROM app.orders WHERE id = :id"), {"id": order.id})
            is None
        )


# ---------------------------------------------------------------------------------------------
# expire_overdue con SKIP LOCKED (R7, CA-ORDERS-13).
def test_expire_overdue_skips_a_row_locked_by_another_connection_without_waiting(
    db_engine: Engine, committed: Factory
) -> None:
    # "Un pago o una cancelación que ya tenga la fila bloqueada gana; el vencimiento se salta
    # esa fila." Sin SKIP LOCKED la segunda conexión esperaría y lock_timeout la haría fallar.
    locked, free = committed(2)
    holder = Session(db_engine)
    holder.begin()
    try:
        assert SqlOrderRepository(holder).get(locked.id, lock=True) is not None

        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            expired = SqlOrderRepository(session).expire_overdue(
                OVERDUE, order_ids=[locked.id, free.id]
            )
    finally:
        holder.rollback()
        holder.close()

    assert [o.id for o in expired] == [free.id]
    with Session(db_engine) as session:
        assert status_in_db(session, free.id) == "expirado"
        assert status_in_db(session, locked.id) == "pendiente_pago"  # intacta
        assert len(history_of(session, locked.id)) == 1  # sin historial `system` ajeno
        assert history_of(session, free.id)[-1][:4] == (
            "pendiente_pago",
            "expirado",
            "system",
            None,
        )


def test_a_skipped_row_is_expired_by_the_next_read(db_engine: Engine, committed: Factory) -> None:
    (order,) = committed()
    with Session(db_engine) as holder, holder.begin():
        SqlOrderRepository(holder).get(order.id, lock=True)
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            assert SqlOrderRepository(session).expire_overdue(OVERDUE, order_ids=[order.id]) == []

    with Session(db_engine) as session, session.begin():
        expired = SqlOrderRepository(session).expire_overdue(OVERDUE, order_ids=[order.id])

    assert [o.id for o in expired] == [order.id]


def test_a_cancellation_that_won_the_lock_is_not_overwritten_by_the_expiry(
    db_engine: Engine, committed: Factory
) -> None:
    # La cancelación tiene la fila: el vencimiento se salta y, al confirmar, el pedido queda
    # cancelado; una lectura posterior no lo convierte en expirado.
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
            during = SqlOrderRepository(session).expire_overdue(OVERDUE, order_ids=[order.id])
        holder.commit()
    finally:
        holder.close()

    with Session(db_engine) as session, session.begin():
        after = SqlOrderRepository(session).expire_overdue(OVERDUE, order_ids=[order.id])
        assert status_in_db(session, order.id) == "cancelado"

    assert during == [] and after == []


def test_two_simultaneous_expirations_do_not_duplicate_the_history(
    db_engine: Engine, committed: Factory
) -> None:
    # Dos lecturas a la vez de pedidos vencidos: gana una sola por fila; la otra se la salta.
    orders = committed(3)
    ids = [o.id for o in orders]

    def expire(session: Session) -> list[UUID]:
        return [o.id for o in SqlOrderRepository(session).expire_overdue(OVERDUE, order_ids=ids)]

    holder = Session(db_engine)
    holder.begin()
    try:
        first = expire(holder)  # materializa las tres y NO confirma: filas bloqueadas
        with Session(db_engine) as session, session.begin():
            session.execute(LOCK_TIMEOUT)
            second = expire(session)  # las salta: no espera ni las repite
        holder.commit()
    finally:
        holder.close()

    assert sorted(first) == sorted(ids)
    assert second == []
    with Session(db_engine) as session:
        for order_id in ids:
            assert len(history_of(session, order_id)) == 2


# ---------------------------------------------------------------------------------------------
# add: la carrera sobre la misma clave (R8).
def test_two_connections_adding_the_same_key_end_with_one_order_and_a_clean_conflict(
    db_engine: Engine, committed: Factory
) -> None:
    # La segunda espera al INSERT de la primera; al confirmar esta, salta el UNIQUE y el
    # repositorio lo traduce a IdempotencyConflict (nunca un error de BD sin traducir).
    (seed,) = committed(1, add=False)
    key = f"clave-concurrente-{uuid4().hex}"
    user = seed.user_id
    product = seed.lines[0].product_id

    def candidate() -> Order:
        line = replace(make_line(), product_id=product)
        return build_order(uuid4(), user, key, [line], shipping_delivery(), BASE)

    winner, loser = candidate(), candidate()

    def first(session: Session) -> str:
        SqlOrderRepository(session).add(winner)
        return "added"

    def second(session: Session) -> str:
        try:
            with session.begin_nested():
                SqlOrderRepository(session).add(loser)
        except IdempotencyConflict:
            return "conflict"
        return "added"

    try:
        assert race(db_engine, first, second) == ("added", "conflict")
        with Session(db_engine) as session:
            found = SqlOrderRepository(session).find_by_key(user, key)
            assert found is not None and found.id == winner.id
            assert (
                session.scalar(
                    text("SELECT count(*) FROM app.orders WHERE id = :id"), {"id": loser.id}
                )
                == 0
            )
    finally:
        with Session(db_engine) as session, session.begin():
            session.execute(text("DELETE FROM app.orders WHERE user_id = :u"), {"u": user})
