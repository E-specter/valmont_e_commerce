"""Concurrencia de cart (CA-CART-02, R1; la base de CA-CART-14): dos conexiones reales, cada una en
su transacción y en su hilo, contra valmont_test. Los datos se confirman, así que cada prueba borra
al final lo suyo (el perfil arrastra su carrito y sus líneas por CASCADE)."""

import queue
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_product, add_profile, carts_of, lines_of
from valmont.modules.cart.adapters.persistence import SqlCartRepository
from valmont.modules.cart.domain import Cart

pytestmark = pytest.mark.integration

TIMEOUT = 10  # s; ninguna espera de estas pruebas debería acercarse
NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)


def in_transaction[T](engine: Engine, work: Callable[[Session], T]) -> T:
    """Una transacción en una conexión propia: commit si `work` termina, rollback si falla."""
    with Session(engine) as session, session.begin():
        return work(session)


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Callable[[], tuple[UUID, list[UUID]]]]:
    """Confirma un perfil y dos productos; al final borra lo suyo."""
    made: list[tuple[UUID, list[UUID]]] = []

    def create() -> tuple[UUID, list[UUID]]:
        with Session(db_engine) as session, session.begin():
            user = add_profile(session)
            products = [add_product(session) for _ in range(2)]
        made.append((user, products))
        return user, products

    yield create
    with Session(db_engine) as session, session.begin():
        for user, products in made:
            session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})
            categories = session.scalars(
                text("SELECT category_id FROM app.products WHERE id = ANY(:ids)"),
                {"ids": products},
            ).all()
            session.execute(
                text("DELETE FROM app.products WHERE id = ANY(:ids)"), {"ids": products}
            )
            session.execute(
                text("DELETE FROM app.categories WHERE id = ANY(:ids)"), {"ids": list(categories)}
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
    pytest.fail(f"La transacción {backend_pid} nunca llegó a esperar un bloqueo.")


def race[A, B](
    engine: Engine,
    first: Callable[[Session], A],
    second: Callable[[Session], B],
) -> tuple[A, B]:
    """`first` trabaja y no confirma hasta que `second` está esperando un bloqueo: la carrera
    ocurre siempre. `second` confirma el último."""
    first_done, first_may_commit = threading.Event(), threading.Event()
    second_pid: queue.Queue[int] = queue.Queue()

    def run_first(session: Session) -> A:
        result = first(session)
        first_done.set()
        assert first_may_commit.wait(TIMEOUT)
        return result

    def run_second(session: Session) -> B:
        second_pid.put(session.scalars(text("SELECT pg_backend_pid()")).one())
        return second(session)

    with ThreadPoolExecutor(2) as pool:
        try:
            one = pool.submit(in_transaction, engine, run_first)
            assert first_done.wait(TIMEOUT)
            two = pool.submit(in_transaction, engine, run_second)
            wait_until_blocked(engine, second_pid.get(timeout=TIMEOUT))
        finally:
            first_may_commit.set()
        return one.result(TIMEOUT), two.result(TIMEOUT)  # sin error: el segundo espera y sigue


def test_two_connections_creating_the_cart_of_the_same_user_end_with_one_cart(
    db_engine: Engine, committed: Callable[[], tuple[UUID, list[UUID]]]
) -> None:
    # CA-CART-02 / RN-02: ambas intentan el INSERT; la segunda espera, ON CONFLICT no falla.
    user, _ = committed()

    first, second = race(
        db_engine,
        lambda s: SqlCartRepository(s).lock_for_user(user),
        lambda s: SqlCartRepository(s).lock_for_user(user),
    )

    assert first.id == second.id
    with Session(db_engine) as session:
        assert carts_of(session, user) == [first.id]


def test_the_cart_lock_serialises_two_writers_and_no_update_is_lost(
    db_engine: Engine, committed: Callable[[], tuple[UUID, list[UUID]]]
) -> None:
    # R1: la segunda lock_for_user espera el commit de la primera y ve su línea; las dos quedan.
    user, (a, b) = committed()
    with Session(db_engine) as session, session.begin():
        SqlCartRepository(session).lock_for_user(user)  # el carrito ya existe

    def add(product: UUID) -> Callable[[Session], Cart]:
        def work(session: Session) -> Cart:
            repo = SqlCartRepository(session)
            cart = repo.lock_for_user(user).add(product, 2, NOW)
            repo.save(cart)
            return cart

        return work

    _, second = race(db_engine, add(a), add(b))

    assert {item.product_id for item in second.items} == {
        a,
        b,
    }  # la segunda vio la línea de la primera
    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {a: (2, True), b: (2, True)}


def test_two_adds_of_the_same_product_sum_instead_of_colliding(
    db_engine: Engine, committed: Callable[[], tuple[UUID, list[UUID]]]
) -> None:
    # CA-CART-02: dos POST concurrentes del mismo producto suman una vez por solicitud, sin error
    # de unicidad ni carrito duplicado.
    user, (product, _) = committed()

    def add(session: Session) -> None:
        repo = SqlCartRepository(session)
        repo.save(repo.lock_for_user(user).add(product, 1, NOW))

    race(db_engine, add, add)

    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {product: (2, True)}
