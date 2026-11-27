"""Concurrencia de `ConfirmOrderPayment` REAL (T-077; CA-ORDERS-15 completo, 20 y 24; SPEC §4 R4,
R7, R16; riesgos R-1, R-3 y R-12): dos o más conexiones reales, cada una en su transacción, contra
valmont_test, con cart, inventory y orders reales. En T-076 el pago se simuló; aquí es el caso de
uso. Gana quien bloquea primero la fila del pedido; el otro espera, ve el estado ya confirmado y no
repite ni contradice nada: nunca hay stock descontado en un pedido cancelado o caducado, ni un
pedido pagado con las reservas liberadas, ni dos descuentos, ni dos filas de historial. Sin
interbloqueos ni errores 500 con pedidos que comparten productos en distinto orden.

Reutiliza `race` de cart (la primera transacción no confirma hasta que la segunda espera un
bloqueo). La caducidad por lectura salta las filas bloqueadas (SKIP LOCKED): cuando es ella la
segunda no espera, así que esos casos se coordinan con eventos en vez de `race`. Los datos se
confirman: cada prueba borra lo suyo. Datos ficticios."""

import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import TIMEOUT, in_transaction, race
from tests.orders.orders_helpers import shipping_delivery
from tests.orders.orders_payment_helpers import (
    committed_world,
    confirm,
    db_now,
    movements,
    set_expiry,
)
from tests.orders.test_cancel_order_concurrency import (
    Result,
    cancel,
    overdue,
    placed,
    read_expiring,
    state,
)
from tests.orders.test_create_order_concurrency import World, create_order, key
from valmont.modules.orders.application import PaymentOutcome
from valmont.modules.orders.domain import (
    NotCancellable,
    OrderNotFound,
    OrderNotPayable,
    OrderStatus,
)

pytestmark = pytest.mark.integration

PENDING, PAID, CANCELLED, EXPIRED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
)


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    yield from committed_world(db_engine)


def pay_and_hold(
    engine: Engine, user: UUID, order_id: UUID, during: Callable[[], object]
) -> tuple[Result, object]:
    """El pago trabaja y NO confirma hasta que `during` (otra transacción) termina: sirve cuando la
    segunda no espera el bloqueo (la lectura que caduca salta la fila bloqueada)."""
    done, may_commit = threading.Event(), threading.Event()

    def run(session: Session) -> Result:
        result = confirm(user, order_id)(session)
        done.set()
        assert may_commit.wait(TIMEOUT)
        return result

    with ThreadPoolExecutor(1) as pool:
        paying = pool.submit(in_transaction, engine, run)
        try:
            assert done.wait(TIMEOUT)
            other = during()
        finally:
            may_commit.set()
        return paying.result(TIMEOUT), other


def facts_consistent(final: dict[str, object]) -> None:
    """Un pedido nunca queda a medias: estado, reservas, ventas, `paid_at` e historial coinciden."""
    if final["status"] == "pagado":
        assert final["paid_at"] is not None and final["sales"] == len(final["reservations"])
        assert set(final["reservations"]) <= {"consumed"}, final
        assert [h[0] for h in final["history"]] == ["pendiente_pago", "pagado"], final
    elif final["status"] == "cancelado":
        assert final["paid_at"] is None and final["sales"] == 0, final
        assert set(final["reservations"]) <= {"released"}, final
        assert [h[0] for h in final["history"]] == ["pendiente_pago", "cancelado"], final
    elif final["status"] == "expirado":
        assert final["paid_at"] is None and final["sales"] == 0, final
        assert set(final["reservations"]) <= {"released"}, final
        assert [h[0] for h in final["history"]] == ["pendiente_pago", "expirado"], final
    else:
        pytest.fail(f"estado final inesperado: {final}")


# --------------------------------------------------------------------------------------------
# CA-ORDERS-15: pago contra cancelación (con ConfirmOrderPayment real)
def test_a_payment_that_holds_the_row_wins_and_the_cancellation_is_not_cancellable(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    paid, cancelled = race(db_engine, confirm(user, order_id), cancel(user, order_id))

    assert paid.outcome == PaymentOutcome.PAID and paid.released == []
    assert isinstance(cancelled.outcome, NotCancellable) and cancelled.outcome.status == PAID
    assert cancelled.released == [] and cancelled.audit.entries == []  # no liberó nada
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["paid_at"] is not None
    assert final["reservations"] == ["consumed", "consumed"]  # nunca pagado con reservas liberadas
    assert final["history"] == [("pendiente_pago", "customer"), ("pagado", "customer")]
    assert (world.on_hand(a), world.on_hand(b)) == (3, 4)  # el pago descontó una sola vez
    assert final["sales"] == 2 and len(paid.audit.entries) == 1


def test_a_cancellation_that_holds_the_row_wins_and_the_payment_is_not_payable(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    cancelled, paid = race(db_engine, cancel(user, order_id), confirm(user, order_id))

    assert cancelled.outcome.status == CANCELLED  # type: ignore[union-attr]
    assert cancelled.released == [order_id] and len(cancelled.audit.entries) == 1
    assert isinstance(paid.outcome, OrderNotPayable) and paid.outcome.status == CANCELLED
    assert paid.released == [] and paid.audit.entries == []  # el pago esperó, vio `cancelado`
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and final["paid_at"] is None
    assert final["refunded_amount"] is None and final["reservations"] == ["released", "released"]
    assert final["history"] == [("pendiente_pago", "customer"), ("cancelado", "customer")]
    assert (world.on_hand(a), world.on_hand(b)) == (5, 5)  # nunca stock descontado si se canceló
    assert final["sales"] == 0 and movements(db_engine, order_id) == []
    assert (world.active_reservations(a), world.active_reservations(b)) == (0, 0)


def test_the_stock_freed_by_the_cancellation_that_won_can_be_bought_again(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=1)
    user, order_id = placed(world, db_engine, (product, 1))

    race(db_engine, cancel(user, order_id), confirm(user, order_id))

    other = world.user((product, 1))
    with Session(db_engine) as session, session.begin():
        bought = create_order(session)(other, key(), shipping_delivery())
    assert bought.created and world.active_reservations(product) == 1


@pytest.mark.parametrize("repetition", range(3))
def test_a_payment_and_a_cancellation_started_together_leave_exactly_one_winner(
    world: World, db_engine: Engine, repetition: int
) -> None:
    # Sin ordenar quién va primero: el reloj de los hilos decide; el resultado final es único.
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    start = threading.Barrier(2)

    def go(work: Callable[[Session], Result]) -> Callable[[Session], Result]:
        def waiting(session: Session) -> Result:
            start.wait(TIMEOUT)
            return work(session)

        return waiting

    with ThreadPoolExecutor(2) as pool:
        pay_f = pool.submit(in_transaction, db_engine, go(confirm(user, order_id)))
        cancel_f = pool.submit(in_transaction, db_engine, go(cancel(user, order_id)))
        paid, cancelled = pay_f.result(TIMEOUT), cancel_f.result(TIMEOUT)

    final = state(db_engine, order_id)
    facts_consistent(final)
    if final["status"] == "pagado":
        assert paid.outcome == PaymentOutcome.PAID
        assert isinstance(cancelled.outcome, NotCancellable) and world.on_hand(product) == 3
    else:
        assert final["status"] == "cancelado" and isinstance(paid.outcome, OrderNotPayable)
        assert world.on_hand(product) == 5
    assert world.active_reservations(product) == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-15 / R16: dos pagos simultáneos, un solo descuento
def test_two_payments_with_the_row_held_discount_once_and_the_second_is_already_paid(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    first, second = race(db_engine, confirm(user, order_id), confirm(user, order_id))

    assert first.outcome == PaymentOutcome.PAID and len(first.audit.entries) == 1
    assert second.outcome == PaymentOutcome.ALREADY_PAID  # esperó, vio `pagado`, sin efectos
    assert second.audit.entries == [] and second.released == []
    final = state(db_engine, order_id)
    assert final["history"] == [("pendiente_pago", "customer"), ("pagado", "customer")]
    assert final["reservations"] == ["consumed", "consumed"] and final["sales"] == 2
    assert (world.on_hand(a), world.on_hand(b)) == (3, 4)


def test_many_simultaneous_payments_discount_once_and_keep_one_history_row(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=9)
    user, order_id = placed(world, db_engine, (product, 3))
    workers = 6
    start = threading.Barrier(workers)

    def racing(session: Session) -> Result:
        start.wait(TIMEOUT)
        return confirm(user, order_id)(session)

    with ThreadPoolExecutor(workers) as pool:
        results = [
            f.result(TIMEOUT)
            for f in [pool.submit(in_transaction, db_engine, racing) for _ in range(workers)]
        ]

    outcomes = sorted(str(r.outcome) for r in results)
    assert outcomes == ["already_paid"] * (workers - 1) + ["paid"]
    assert sum(len(r.audit.entries) for r in results) == 1  # una sola auditoría
    final = state(db_engine, order_id)
    assert final["history"] == [("pendiente_pago", "customer"), ("pagado", "customer")]
    assert final["sales"] == 1 and world.on_hand(product) == 6  # 9 - 3, una vez


def test_the_same_order_paid_by_its_owner_and_attempted_by_a_stranger_changes_only_for_the_owner(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    owner, order_id = placed(world, db_engine, (product, 2))
    stranger = world.user((product, 1))

    # El extraño no espera el bloqueo (el filtro de dueño no ve la fila): 404 inmediato.
    paid, attempt = pay_and_hold(
        db_engine,
        owner,
        order_id,
        lambda: in_transaction(db_engine, confirm(stranger, order_id)),
    )

    assert paid.outcome == PaymentOutcome.PAID  # type: ignore[attr-defined]
    assert isinstance(attempt.outcome, OrderNotFound) and attempt.audit.entries == []  # type: ignore[attr-defined]
    assert world.on_hand(product) == 3


# --------------------------------------------------------------------------------------------
# CA-ORDERS-15 / R7: pago contra la caducidad por lectura
def test_a_read_that_expires_the_order_first_makes_the_payment_not_payable(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))
    overdue(db_engine, order_id)

    read, paid = race(db_engine, read_expiring(user, order_id), confirm(user, order_id))

    assert read.outcome == EXPIRED and read.released == [order_id]
    assert isinstance(paid.outcome, OrderNotPayable) and paid.outcome.status == EXPIRED
    assert paid.released == [] and paid.audit.entries == []  # no repite la liberación
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["paid_at"] is None
    assert final["history"] == [("pendiente_pago", "customer"), ("expirado", "system")]
    assert final["reservations"] == ["released", "released"] and final["sales"] == 0
    assert (world.on_hand(a), world.on_hand(b)) == (5, 5)  # nunca cobrado ni descontado
    assert (world.active_reservations(a), world.active_reservations(b)) == (0, 0)


def test_a_payment_that_holds_an_overdue_order_expires_it_and_the_skipping_read_changes_nothing(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    overdue(db_engine, order_id)

    paid, read = pay_and_hold(
        db_engine,
        user,
        order_id,
        lambda: in_transaction(db_engine, read_expiring(user, order_id)),
    )

    assert paid.outcome == PaymentOutcome.EXPIRED and paid.released == [order_id]  # type: ignore[union-attr]
    assert read.outcome == "none" and read.released == []  # type: ignore[attr-defined]  # SKIP LOCKED
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["paid_at"] is None
    assert final["history"] == [("pendiente_pago", "customer"), ("expirado", "system")]
    assert final["reservations"] == ["released"] and final["sales"] == 0
    assert world.on_hand(product) == 5 and world.active_reservations(product) == 0


def test_a_payment_that_started_before_the_limit_wins_over_a_read_after_the_limit(
    world: World, db_engine: Engine
) -> None:
    # Borde de R-3: el pago empezó vigente y mantiene la fila; cuando pasa el límite entra una
    # lectura que caduca: salta la fila bloqueada. Estado final único y `on_hand` correcto.
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))

    limit = db_now(db_engine) + timedelta(seconds=3)
    set_expiry(db_engine, order_id, limit)

    def read_after_the_limit() -> Result:
        while db_now(db_engine) <= limit:
            time.sleep(0.1)
        return in_transaction(db_engine, read_expiring(user, order_id))

    paid, read = pay_and_hold(db_engine, user, order_id, read_after_the_limit)

    assert paid.outcome == PaymentOutcome.PAID  # type: ignore[union-attr]
    assert read.outcome == "none" and read.released == []  # type: ignore[attr-defined]
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["paid_at"] is not None
    assert final["reservations"] == ["consumed"] and final["sales"] == 1
    assert final["history"] == [("pendiente_pago", "customer"), ("pagado", "customer")]
    assert world.on_hand(product) == 3 and world.active_reservations(product) == 0


def test_a_payment_that_waits_for_the_row_past_the_limit_ends_in_one_coherent_state(
    world: World, db_engine: Engine
) -> None:
    # R-3 (aceptado): `now()` es el inicio de la transacción; un pago que empieza antes del
    # vencimiento y espera un bloqueo puede confirmarse después. El resultado puede ser `pagado`
    # o `expirado`, pero nunca algo a medias: INVENTORY-R11 protege el stock.
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))

    limit = db_now(db_engine) + timedelta(seconds=2)
    set_expiry(db_engine, order_id, limit)
    holding, locked = threading.Event(), threading.Event()

    def hold(session: Session) -> None:
        session.execute(
            text("SELECT 1 FROM app.orders WHERE id = :id FOR UPDATE"), {"id": order_id}
        )
        holding.set()
        assert locked.wait(TIMEOUT)

    with ThreadPoolExecutor(2) as pool:
        holder = pool.submit(in_transaction, db_engine, hold)
        assert holding.wait(TIMEOUT)
        paying = pool.submit(in_transaction, db_engine, confirm(user, order_id))
        while db_now(db_engine) <= limit + timedelta(seconds=0.5):
            time.sleep(0.1)
        locked.set()
        holder.result(TIMEOUT)
        result = paying.result(TIMEOUT)

    final = state(db_engine, order_id)
    facts_consistent(final)
    assert final["status"] in ("pagado", "expirado")
    if final["status"] == "pagado":
        assert result.outcome == PaymentOutcome.PAID and world.on_hand(product) == 3
    else:
        assert result.outcome == PaymentOutcome.EXPIRED and world.on_hand(product) == 5
    assert world.active_reservations(product) == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-24: sin interbloqueos con pedidos que comparten productos
def test_payments_of_two_orders_with_the_same_products_in_opposite_order_do_not_deadlock(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=20), world.product(on_hand=20)
    first_user, first = placed(world, db_engine, (a, 1), (b, 2))
    second_user, second = placed(world, db_engine, (b, 3), (a, 4))
    start = threading.Barrier(2)

    def go(user: UUID, order_id: UUID) -> Callable[[Session], Result]:
        def waiting(session: Session) -> Result:
            start.wait(TIMEOUT)
            return confirm(user, order_id)(session)

        return waiting

    with ThreadPoolExecutor(2) as pool:
        futures = [
            pool.submit(in_transaction, db_engine, go(first_user, first)),
            pool.submit(in_transaction, db_engine, go(second_user, second)),
        ]
        results = [f.result(TIMEOUT) for f in futures]  # un interbloqueo o un 500 sería un error

    assert [r.outcome for r in results] == [PaymentOutcome.PAID, PaymentOutcome.PAID]
    assert (world.on_hand(a), world.on_hand(b)) == (20 - 1 - 4, 20 - 2 - 3)
    assert state(db_engine, first)["sales"] == state(db_engine, second)["sales"] == 2


def test_a_payment_an_expiry_a_cancellation_and_a_new_purchase_on_the_same_products_never_deadlock(
    world: World, db_engine: Engine
) -> None:
    # CA-24: pedidos que comparten productos, con pagos, caducidades por lectura, cancelaciones y
    # compras nuevas a la vez (en órdenes de línea distintos): R4 sin interbloqueo ni 500.
    a, b = world.product(on_hand=60), world.product(on_hand=60)
    quantities = {
        "pay_1": ((a, 1), (b, 1)),
        "pay_2": ((b, 2), (a, 1)),
        "pay_overdue": ((a, 2), (b, 2)),
        "read_overdue": ((b, 1), (a, 3)),
        "cancel": ((a, 1), (b, 3)),
        "both": ((b, 2), (a, 2)),
    }
    orders = {name: placed(world, db_engine, *lines) for name, lines in quantities.items()}
    overdue(db_engine, orders["pay_overdue"][1])
    overdue(db_engine, orders["read_overdue"][1])
    buyers = [world.user((a, 1), (b, 1)), world.user((b, 1), (a, 1))]
    jobs: list[Callable[[Session], object]] = [
        confirm(*orders["pay_1"]),
        confirm(*orders["pay_2"]),
        confirm(*orders["pay_overdue"]),
        read_expiring(*orders["read_overdue"]),
        confirm(*orders["read_overdue"]),
        cancel(*orders["cancel"]),
        confirm(*orders["both"]),
        cancel(*orders["both"]),
        *[
            lambda s, u=u: create_order(s)(u, key(), shipping_delivery())  # type: ignore[misc]
            for u in buyers
        ],
    ]
    start = threading.Barrier(len(jobs))

    def go(work: Callable[[Session], object]) -> Callable[[Session], object]:
        def waiting(session: Session) -> object:
            start.wait(TIMEOUT)
            return work(session)

        return waiting

    with ThreadPoolExecutor(len(jobs)) as pool:
        futures = [pool.submit(in_transaction, db_engine, go(job)) for job in jobs]
        [f.result(TIMEOUT) for f in futures]  # un interbloqueo o un 500 sería un error aquí

    sold = {a: 0, b: 0}
    finals = {name: state(db_engine, order_id) for name, (_, order_id) in orders.items()}
    for name, final in finals.items():
        facts_consistent(final)
        if final["status"] == "pagado":
            for product, quantity in quantities[name]:
                sold[product] += quantity
    assert finals["pay_1"]["status"] == finals["pay_2"]["status"] == "pagado"
    assert finals["pay_overdue"]["status"] == finals["read_overdue"]["status"] == "expirado"
    assert finals["cancel"]["status"] == "cancelado"
    assert finals["both"]["status"] in ("pagado", "cancelado")
    assert (world.on_hand(a), world.on_hand(b)) == (60 - sold[a], 60 - sold[b])
    # Solo siguen reservadas las unidades de las dos compras nuevas.
    assert world.active_reservations(a) == world.active_reservations(b) == 2


def test_the_loser_of_a_payment_race_never_leaves_a_sale_movement_behind(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    overdue(db_engine, order_id)

    race(db_engine, read_expiring(user, order_id), confirm(user, order_id))

    assert movements(db_engine, order_id) == [] and world.on_hand(product) == 5
