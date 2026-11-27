"""Concurrencia del repositorio de payments (CA-PAYMENTS-10, la parte de la BD; PAYMENTS-R3, R4 y
R10): dos conexiones reales, cada una en su transacción, contra valmont_test. Los datos se
confirman: la fixture `committed_orders` borra al final lo suyo.

`race` (de cart) deja a la primera conexión con su INSERT sin confirmar hasta que la segunda está
esperando un bloqueo: la carrera ocurre siempre, no por suerte de tiempos. Si el código no espera
como debe, la prueba falla en segundos (las esperas llevan tiempo máximo) en vez de colgarse."""

import queue
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import TIMEOUT, in_transaction, race, wait_until_blocked
from tests.payments.payments_db_helpers import Factory, attempts_in_db, make_attempt, new_key
from valmont.modules.payments.adapters.persistence import SqlPaymentAttemptRepository
from valmont.modules.payments.domain import FailureCode, OrderAlreadyPaid, PaymentAttempt

pytestmark = pytest.mark.integration

DECLINED = FailureCode.CARD_DECLINED
Outcome = PaymentAttempt | str | None


def add(session: Session, attempt: PaymentAttempt) -> Outcome:
    """Lo que devuelve `add`, o 'paid' si el pedido ya tenía un aprobado."""
    try:
        return SqlPaymentAttemptRepository(session).add(attempt)
    except OrderAlreadyPaid:
        return "paid"


def race_with_rollback(
    engine: Engine, first_attempt: PaymentAttempt, second_attempt: PaymentAttempt
) -> Outcome:
    """La primera conexión inserta y **no confirma**; cuando la segunda está esperando su
    bloqueo, la primera hace rollback. Devuelve lo que la segunda obtuvo de `add`."""
    holder = Session(engine)
    pids: queue.Queue[int] = queue.Queue()

    def second(session: Session) -> Outcome:
        pids.put(session.scalars(text("SELECT pg_backend_pid()")).one())
        return add(session, second_attempt)

    try:
        SqlPaymentAttemptRepository(holder).add(first_attempt)
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(in_transaction, engine, second)
            try:
                wait_until_blocked(engine, pids.get(timeout=TIMEOUT))
            finally:
                holder.rollback()
            return future.result(TIMEOUT)
    finally:
        holder.close()


def run_together(engine: Engine, attempts: list[PaymentAttempt]) -> list[Outcome]:
    """Cada intento en su conexión y su hilo; todos lanzan el INSERT a la vez (barrera)."""
    barrier = threading.Barrier(len(attempts), timeout=TIMEOUT)

    def insert(attempt: PaymentAttempt) -> Outcome:
        def work(session: Session) -> Outcome:
            barrier.wait()
            return add(session, attempt)

        return in_transaction(engine, work)

    with ThreadPoolExecutor(len(attempts)) as pool:
        futures = [pool.submit(insert, attempt) for attempt in attempts]
        return [future.result(TIMEOUT) for future in futures]


# ---------------------------------------------------------------------------------------------
# Misma clave a la vez (R3): una fila, la segunda recibe None.
def test_two_connections_inserting_the_same_key_leave_one_row_and_one_none(
    db_engine: Engine, committed_orders: Factory
) -> None:
    ((user, order),) = committed_orders(1)
    key = new_key()
    first_attempt = make_attempt(order, user, key=key)
    second_attempt = make_attempt(order, user, key=key)

    first, second = race(
        db_engine, lambda s: add(s, first_attempt), lambda s: add(s, second_attempt)
    )

    assert isinstance(first, PaymentAttempt) and first.id == first_attempt.id
    assert second is None  # esperó al commit de la primera y ON CONFLICT DO NOTHING no insertó
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, user_id=user) == 1
        assert attempts_in_db(session, id=first_attempt.id) == 1
        assert attempts_in_db(session, id=second_attempt.id) == 0


def test_the_second_connection_with_the_same_key_after_a_rollback_inserts_its_own(
    db_engine: Engine, committed_orders: Factory
) -> None:
    # Si la primera no confirma, la segunda no pierde su intento: la clave quedó libre.
    ((user, order),) = committed_orders(1)
    key = new_key()
    first_attempt = make_attempt(order, user, key=key, failure_code=DECLINED)
    second_attempt = make_attempt(order, user, key=key)

    second = race_with_rollback(db_engine, first_attempt, second_attempt)

    assert isinstance(second, PaymentAttempt) and second.id == second_attempt.id
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, user_id=user) == 1
        assert attempts_in_db(session, id=second_attempt.id) == 1
        assert attempts_in_db(session, id=first_attempt.id) == 0


def test_simultaneous_inserts_of_the_same_key_leave_one_row(
    db_engine: Engine, committed_orders: Factory
) -> None:
    ((user, order),) = committed_orders(1)
    key = new_key()
    attempts = [make_attempt(order, user, key=key, failure_code=DECLINED) for _ in range(2)]

    results = run_together(db_engine, attempts)

    assert sorted(r is None for r in results) == [False, True]  # una insertó, la otra recibió None
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, user_id=user) == 1


# ---------------------------------------------------------------------------------------------
# Dos `approved` para el mismo pedido (R4, CA-10): exactamente uno gana.
def test_two_connections_approving_the_same_order_with_different_keys_one_wins(
    db_engine: Engine, committed_orders: Factory
) -> None:
    ((user, order),) = committed_orders(1)
    winner = make_attempt(order, user)
    loser = make_attempt(order, user)

    first, second = race(db_engine, lambda s: add(s, winner), lambda s: add(s, loser))

    assert isinstance(first, PaymentAttempt) and first.id == winner.id
    assert second == "paid"  # esperó al commit de la primera y el índice parcial lo rechazó
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, order_id=order, status="approved") == 1
        assert attempts_in_db(session, id=winner.id) == 1
        assert attempts_in_db(session, id=loser.id) == 0


def test_when_the_first_approval_rolls_back_the_second_one_wins(
    db_engine: Engine, committed_orders: Factory
) -> None:
    # Sin commit de la primera, el pedido no queda cobrado: el segundo aprobado entra.
    ((user, order),) = committed_orders(1)
    first_attempt = make_attempt(order, user)
    second_attempt = make_attempt(order, user)

    second = race_with_rollback(db_engine, first_attempt, second_attempt)

    assert isinstance(second, PaymentAttempt) and second.id == second_attempt.id
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, order_id=order, status="approved") == 1
        assert attempts_in_db(session, id=second_attempt.id) == 1


def test_simultaneous_approvals_without_orchestration_leave_exactly_one(
    db_engine: Engine, committed_orders: Factory
) -> None:
    # Varias rondas con una barrera: ambas lanzan el INSERT a la vez, sin orden forzado.
    for _ in range(5):
        ((user, order),) = committed_orders(1)

        results = run_together(db_engine, [make_attempt(order, user), make_attempt(order, user)])

        assert sorted(r == "paid" for r in results) == [False, True]
        assert sum(isinstance(r, PaymentAttempt) for r in results) == 1
        with Session(db_engine) as session, session.begin():
            assert attempts_in_db(session, order_id=order, status="approved") == 1
            assert attempts_in_db(session, order_id=order) == 1


# ---------------------------------------------------------------------------------------------
# Lo que no debe bloquearse ni perderse.
def test_two_connections_inserting_rejected_attempts_for_one_order_both_fit(
    db_engine: Engine, committed_orders: Factory
) -> None:
    # El índice parcial solo cubre `approved`: dos rechazos distintos no se esperan (R9).
    ((user, order),) = committed_orders(1)
    attempts = [make_attempt(order, user, failure_code=DECLINED) for _ in range(2)]

    results = run_together(db_engine, attempts)

    assert all(isinstance(r, PaymentAttempt) for r in results)
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, order_id=order, status="rejected") == 2


def test_an_approval_and_a_rejection_for_one_order_at_once_both_fit(
    db_engine: Engine, committed_orders: Factory
) -> None:
    ((user, order),) = committed_orders(1)
    attempts = [make_attempt(order, user), make_attempt(order, user, failure_code=DECLINED)]

    results = run_together(db_engine, attempts)

    assert all(isinstance(r, PaymentAttempt) for r in results)
    with Session(db_engine) as session, session.begin():
        assert attempts_in_db(session, order_id=order) == 2


def test_approvals_for_two_different_orders_do_not_block_each_other(
    db_engine: Engine, committed_orders: Factory
) -> None:
    (user_a, order_a), (user_b, order_b) = committed_orders(2)

    results = run_together(
        db_engine, [make_attempt(order_a, user_a), make_attempt(order_b, user_b)]
    )

    assert all(isinstance(r, PaymentAttempt) for r in results)
