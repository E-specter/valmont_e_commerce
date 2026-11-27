"""Concurrencia de `CancelMyOrder` (T-076; CA-ORDERS-15, 20 y 21; SPEC §4 R4, R7, R10 y R16): dos
conexiones reales, cada una en su transacción, contra valmont_test, con cart, inventory y orders
reales. Gana quien bloquea primero la fila del pedido; el otro espera, ve el estado ya confirmado y
no repite ni contradice nada: nunca hay stock descontado en un pedido cancelado, ni un pedido pagado
con las reservas liberadas, ni dos filas de historial o dos liberaciones por una cancelación.

El puerto de payments (`ConfirmOrderPayment`) llega con T-077; hasta entonces el pago se simula con
lo mismo que hará R16: `SqlOrderRepository.get(lock=True)` filtrado por dueño, y solo si sigue
`pendiente_pago`, `ConsumeReservations` real y `apply(paid=True)`. Los datos se confirman, así que
cada prueba borra lo suyo (la auditoría es en memoria: `app.audit_log` no admite DELETE). Reutiliza
`race` de cart: la primera transacción no confirma hasta que la segunda espera un bloqueo, así que
la carrera ocurre siempre y no solo con suerte. Datos ficticios."""

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import TIMEOUT, in_transaction, race
from tests.inventory.inventory_helpers import consume_reservations
from tests.orders.orders_create_helpers import Calls, FakeAudit
from tests.orders.orders_db_helpers import change
from tests.orders.orders_helpers import shipping_delivery
from tests.orders.test_create_order_concurrency import World, create_order, key
from valmont.modules.inventory.adapters.persistence import SqlReservationRepository
from valmont.modules.inventory.application import ReleaseReservations
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.application import CancelMyOrder, ExpireOverdueOrders
from valmont.modules.orders.domain import (
    ActorKind,
    NotCancellable,
    Order,
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
    made = World(db_engine)
    yield made
    with Session(db_engine) as session, session.begin():  # los movimientos `venta` del pago
        session.execute(
            text("DELETE FROM app.stock_movements WHERE product_id = ANY(:p)"),
            {"p": made.products},
        )
    made.cleanup()


@dataclass
class CountingRelease:
    """Libera de verdad (inventory real) y cuenta a qué pedidos."""

    inner: ReleaseReservations
    released: list[UUID] = field(default_factory=list)

    def __call__(self, order_id: UUID) -> None:
        self.released.append(order_id)
        self.inner(order_id)


@dataclass
class Result:
    """Lo que una transacción devolvió y lo que hizo por el camino."""

    outcome: Order | Exception | str
    released: list[UUID]
    audit: FakeAudit


def use_cases(
    session: Session,
) -> tuple[CancelMyOrder, ExpireOverdueOrders, CountingRelease, FakeAudit]:
    orders, clock = SqlOrderRepository(session), SqlClock(session)
    release = CountingRelease(ReleaseReservations(SqlReservationRepository(session)))
    audit = FakeAudit(Calls())
    expire = ExpireOverdueOrders(orders, release, audit, clock)  # type: ignore[arg-type]
    return CancelMyOrder(orders, expire, release, audit, clock), expire, release, audit  # type: ignore[arg-type]


def cancel(user: UUID, order_id: UUID) -> Callable[[Session], Result]:
    def work(session: Session) -> Result:
        use_case, _, release, audit = use_cases(session)
        try:
            outcome: Order | Exception = use_case(user, order_id)
        except NotCancellable as error:  # el error de negocio se devuelve; un 500 se propaga
            outcome = error
        return Result(outcome, release.released, audit)

    return work


def read_expiring(user: UUID, order_id: UUID) -> Callable[[Session], Result]:
    """Lo que hace una lectura propia del pedido (R7): materializa el vencimiento."""

    def work(session: Session) -> Result:
        _, expire, release, audit = use_cases(session)
        expired = expire(user_id=user, order_ids=[order_id])
        return Result(EXPIRED if expired else "none", release.released, audit)

    return work


def pay(user: UUID, order_id: UUID) -> Callable[[Session], str]:
    """El pago de R16 con lo que ya existe: bloquea el pedido propio y solo si sigue pendiente
    consume las reservas y lo marca `pagado`. Devuelve el estado con que se encontró o `pagado`."""

    def work(session: Session) -> str:
        orders = SqlOrderRepository(session)
        order = orders.get(order_id, user_id=user, lock=True)
        assert order is not None
        if order.status != PENDING:
            return f"not_payable:{order.status.value}"
        now = SqlClock(session).now()
        consume_reservations(session)(order_id, now)  # antes del cambio de estado (R16)
        orders.apply(
            order_id,
            change(PENDING, PAID, kind=ActorKind.CUSTOMER, actor_id=user, at=now),
            paid=True,
        )
        return "paid"

    return work


def placed(world: World, engine: Engine, *lines: tuple[UUID, int]) -> tuple[UUID, UUID]:
    """(cliente, pedido) confirmados: pedido real con sus reservas, vigente."""
    user = world.user(*lines)
    with Session(engine) as session, session.begin():
        created = create_order(session)(user, key(), shipping_delivery())
    return user, created.order.id


def overdue(engine: Engine, order_id: UUID) -> None:
    with Session(engine) as session, session.begin():
        session.execute(
            text(
                "UPDATE app.orders SET created_at = now() - interval '2 hours',"
                " expires_at = now() - interval '1 minute' WHERE id = :id"
            ),
            {"id": order_id},
        )


def state(engine: Engine, order_id: UUID) -> dict[str, object]:
    with Session(engine) as session:
        row = session.execute(
            text("SELECT status, paid_at, refunded_amount FROM app.orders WHERE id = :id"),
            {"id": order_id},
        ).one()
        history = session.execute(
            text(
                "SELECT to_status, actor_kind FROM app.order_status_history"
                " WHERE order_id = :id ORDER BY id"
            ),
            {"id": order_id},
        ).all()
        reservations = session.scalars(
            text("SELECT status FROM app.stock_reservations WHERE order_id = :id"),
            {"id": order_id},
        ).all()
        sold = session.scalar(
            text(
                "SELECT count(*) FROM app.stock_movements WHERE order_id = :id AND kind = 'venta'"
            ),
            {"id": order_id},
        )
    return {
        "status": row.status,
        "paid_at": row.paid_at,
        "refunded_amount": row.refunded_amount,
        "history": [tuple(h) for h in history],
        "reservations": sorted(reservations),
        "sales": sold,
    }


# --------------------------------------------------------------------------------------------
# CA-ORDERS-15: cancelación contra pago
def test_a_payment_that_holds_the_row_wins_and_the_cancellation_is_not_cancellable(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    paid, cancelled = race(db_engine, pay(user, order_id), cancel(user, order_id))

    assert paid == "paid"
    assert isinstance(cancelled.outcome, NotCancellable) and cancelled.outcome.status == PAID
    assert cancelled.released == [] and cancelled.audit.entries == []  # no liberó nada
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["paid_at"] is not None
    assert final["reservations"] == ["consumed", "consumed"]  # nunca pagado con reservas liberadas
    assert final["history"] == [("pendiente_pago", "customer"), ("pagado", "customer")]
    assert (world.on_hand(a), world.on_hand(b)) == (3, 4)  # el pago descontó una sola vez
    assert final["sales"] == 2


def test_a_cancellation_that_holds_the_row_wins_and_the_payment_finds_it_cancelled(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    cancelled, paid = race(db_engine, cancel(user, order_id), pay(user, order_id))

    assert isinstance(cancelled.outcome, Order) and cancelled.outcome.status == CANCELLED
    assert cancelled.released == [order_id] and len(cancelled.audit.entries) == 1
    assert paid == "not_payable:cancelado"  # el pago esperó, vio `cancelado` y no consumió
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and final["paid_at"] is None
    assert final["refunded_amount"] is None
    assert final["reservations"] == ["released", "released"]
    assert final["history"] == [("pendiente_pago", "customer"), ("cancelado", "customer")]
    assert (world.on_hand(a), world.on_hand(b)) == (5, 5)  # nunca stock descontado si se canceló
    assert final["sales"] == 0
    assert (world.active_reservations(a), world.active_reservations(b)) == (0, 0)


def test_the_loser_of_a_payment_race_leaves_the_stock_free_to_buy_again(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=1)
    user, order_id = placed(world, db_engine, (product, 1))

    race(db_engine, cancel(user, order_id), pay(user, order_id))

    other = world.user((product, 1))
    with Session(db_engine) as session, session.begin():
        bought = create_order(session)(other, key(), shipping_delivery())
    assert bought.created and world.active_reservations(product) == 1


def test_cancellations_and_payments_of_the_same_orders_never_deadlock_or_contradict_each_other(
    world: World, db_engine: Engine
) -> None:
    # Pedidos que comparten productos, cada uno con su pago y su cancelación en marcha a la vez:
    # pedido -> reservas -> stock (R4) sin interbloqueo; cada pedido acaba en un único estado.
    a, b = world.product(on_hand=30), world.product(on_hand=30)
    orders = [
        placed(world, db_engine, *lines)
        for lines in [((a, 1), (b, 1)), ((b, 1), (a, 1)), ((a, 2), (b, 2)), ((b, 3), (a, 1))]
    ]
    start = threading.Barrier(len(orders) * 2)

    def go(work: Callable[[Session], object]) -> Callable[[Session], object]:
        def waiting(session: Session) -> object:
            start.wait(TIMEOUT)
            return work(session)

        return waiting

    with ThreadPoolExecutor(len(orders) * 2) as pool:
        futures = [
            pool.submit(in_transaction, db_engine, go(fn(user, order_id)))
            for user, order_id in orders
            for fn in (cancel, pay)
        ]
        [f.result(TIMEOUT) for f in futures]  # un interbloqueo o un 500 sería un error aquí

    sold = {a: 0, b: 0}
    for (_, order_id), quantities in zip(
        orders, [{a: 1, b: 1}, {a: 1, b: 1}, {a: 2, b: 2}, {a: 1, b: 3}], strict=True
    ):
        final = state(db_engine, order_id)
        if final["status"] == "pagado":
            assert set(final["reservations"]) == {"consumed"}, final
            assert final["sales"] == 2 and final["paid_at"] is not None
            for product, quantity in quantities.items():
                sold[product] += quantity
        else:
            assert final["status"] == "cancelado", final
            assert set(final["reservations"]) == {"released"}, final
            assert final["sales"] == 0 and final["paid_at"] is None
        assert [h[0] for h in final["history"]] in (
            ["pendiente_pago", "pagado"],
            ["pendiente_pago", "cancelado"],
        )  # CA-ORDERS-20: una sola fila de cambio
    assert (world.on_hand(a), world.on_hand(b)) == (30 - sold[a], 30 - sold[b])
    assert world.active_reservations(a) == world.active_reservations(b) == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-20: dos cancelaciones simultáneas, un solo historial
def test_two_cancellations_with_the_row_held_leave_one_history_one_release_one_audit(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))

    first, second = race(db_engine, cancel(user, order_id), cancel(user, order_id))

    for result in (first, second):  # las dos responden "cancelado": idempotente
        assert isinstance(result.outcome, Order) and result.outcome.status == CANCELLED
    assert first.released == [order_id] and len(first.audit.entries) == 1
    assert second.released == [] and second.audit.entries == []  # la segunda no repite nada
    final = state(db_engine, order_id)
    assert final["history"] == [("pendiente_pago", "customer"), ("cancelado", "customer")]
    assert final["reservations"] == ["released"]
    assert world.active_reservations(product) == 0 and world.on_hand(product) == 5


def test_many_simultaneous_cancellations_leave_a_single_history_row_and_a_single_release(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=9)
    user, order_id = placed(world, db_engine, (product, 3))
    workers = 5
    start = threading.Barrier(workers)

    def racing(session: Session) -> Result:
        start.wait(TIMEOUT)
        return cancel(user, order_id)(session)

    with ThreadPoolExecutor(workers) as pool:
        results = [
            f.result(TIMEOUT)
            for f in [pool.submit(in_transaction, db_engine, racing) for _ in range(workers)]
        ]

    assert all(isinstance(r.outcome, Order) and r.outcome.status == CANCELLED for r in results)
    assert sum(len(r.released) for r in results) == 1  # exactamente una liberación
    assert sum(len(r.audit.entries) for r in results) == 1  # exactamente una auditoría
    final = state(db_engine, order_id)
    assert final["history"] == [("pendiente_pago", "customer"), ("cancelado", "customer")]
    assert world.active_reservations(product) == 0


# --------------------------------------------------------------------------------------------
# R7: cancelación contra la caducidad por lectura
def test_a_read_that_expires_the_order_first_makes_the_cancellation_not_cancellable(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    overdue(db_engine, order_id)

    read, cancelled = race(db_engine, read_expiring(user, order_id), cancel(user, order_id))

    assert read.outcome == EXPIRED and read.released == [order_id]
    assert isinstance(cancelled.outcome, NotCancellable) and cancelled.outcome.status == EXPIRED
    assert cancelled.released == [] and cancelled.audit.entries == []
    final = state(db_engine, order_id)
    assert final["status"] == "expirado"  # nunca `cancelado` ni las dos cosas a la vez
    assert final["history"] == [("pendiente_pago", "customer"), ("expirado", "system")]
    assert final["reservations"] == ["released"]
    assert world.active_reservations(product) == 0 and world.on_hand(product) == 5
