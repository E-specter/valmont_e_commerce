"""Concurrencia de `TransitionOrder` (T-079; CA-ORDERS-15, 19, 20 y 24; SPEC §4 R4, R7, R10, R15 y
R16): dos o más conexiones reales, cada una en su transacción, contra valmont_test, con cart,
inventory y orders reales, y con `ConfirmOrderPayment` y `CancelMyOrder` reales. Gana quien bloquea
primero la fila del pedido; el otro espera, ve el estado ya confirmado y no repite ni contradice
nada: nunca hay dos reembolsos, dos filas de historial o dos auditorías por una transición, nunca un
pedido cancelado sin reembolso con stock descontado, ni un pedido pagado y cancelado con reservas
liberadas. Reutiliza `race` de cart (la primera transacción no confirma hasta que la segunda espera
un bloqueo). Los datos se confirman: cada prueba borra lo suyo. Datos ficticios."""

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import TIMEOUT, in_transaction, race
from tests.orders.orders_create_helpers import Calls, FakeAudit
from tests.orders.orders_payment_helpers import committed_world, confirm
from tests.orders.test_cancel_order_concurrency import (
    CountingRelease,
    Result,
    cancel,
    overdue,
    placed,
    read_expiring,
    state,
)
from tests.orders.test_create_order_concurrency import World
from valmont.modules.inventory.adapters.persistence import SqlReservationRepository
from valmont.modules.inventory.application import ReleaseReservations
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.application import (
    Actor,
    ExpireOverdueOrders,
    PaymentOutcome,
    TransitionOrder,
)
from valmont.modules.orders.domain import (
    ActorKind,
    InvalidTransition,
    Order,
    OrderNotFound,
    OrderNotPayable,
    OrderStatus,
)

pytestmark = pytest.mark.integration

PENDING, PAID, PREPARING, CANCELLED, EXPIRED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PREPARING,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
)
NOTE = "Motivo interno de la prueba"


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    yield from committed_world(db_engine)


def move(
    admin: UUID, order_id: UUID, to: OrderStatus, **options: str | None
) -> Callable[[Session], Result]:
    """Una transición del administrador con los adaptadores reales. Devuelve el error de negocio
    (`InvalidTransition`, `OrderNotFound`) en vez de lanzarlo; un interbloqueo o un 500, no."""

    def work(session: Session) -> Result:
        orders, clock = SqlOrderRepository(session), SqlClock(session)
        release = CountingRelease(ReleaseReservations(SqlReservationRepository(session)))
        audit = FakeAudit(Calls())
        expire = ExpireOverdueOrders(orders, release, audit, clock)  # type: ignore[arg-type]
        use_case = TransitionOrder(orders, expire, release, audit, clock)  # type: ignore[arg-type]
        try:
            outcome: Order | Exception = use_case(
                Actor(admin, ActorKind.ADMIN), order_id, to, **options
            )
        except (InvalidTransition, OrderNotFound) as error:
            outcome = error
        return Result(outcome, release.released, audit)

    return work


def cancel_by(admin: UUID, order_id: UUID) -> Callable[[Session], Result]:
    return move(admin, order_id, CANCELLED, note=NOTE)


def paid(world: World, engine: Engine, *lines: tuple[UUID, int]) -> tuple[UUID, UUID]:
    """(cliente, pedido) pagado con `ConfirmOrderPayment` real y confirmado."""
    user, order_id = placed(world, engine, *lines)
    result = in_transaction(engine, confirm(user, order_id))
    assert result.outcome == PaymentOutcome.PAID
    return user, order_id


def total_of(engine: Engine, order_id: UUID) -> int:
    with Session(engine) as session:
        return session.scalar(
            text("SELECT total_amount FROM app.orders WHERE id = :id"), {"id": order_id}
        )


def admin_rows(engine: Engine, order_id: UUID) -> list[tuple[str, str, UUID | None]]:
    """(to_status, actor_kind, actor_id) de las filas del historial hechas por un administrador."""
    with Session(engine) as session:
        rows = session.execute(
            text(
                "SELECT to_status, actor_kind, actor_id FROM app.order_status_history"
                " WHERE order_id = :id AND actor_kind = 'admin' ORDER BY id"
            ),
            {"id": order_id},
        ).all()
    return [tuple(r) for r in rows]  # type: ignore[misc]


def money_is_consistent(final: dict[str, object], total: int) -> None:
    """Un pedido cancelado por el administrador nunca queda a medias: o no se cobró (sin reembolso,
    reservas liberadas, sin venta) o se cobró y se reembolsó el total (reservas consumidas)."""
    assert final["status"] == "cancelado", final
    if final["paid_at"] is None:
        assert final["refunded_amount"] is None and final["sales"] == 0, final
        assert set(final["reservations"]) <= {"released"}, final  # type: ignore[call-overload]
    else:
        assert final["refunded_amount"] == total, final
        assert final["sales"] == len(final["reservations"]), final  # type: ignore[arg-type]
        assert set(final["reservations"]) <= {"consumed"}, final  # type: ignore[call-overload]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-18 y 20: dos administradores con la misma transición
def test_two_admins_with_the_same_transition_one_wins_and_the_other_sees_the_new_state(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = paid(world, db_engine, (product, 2))
    first_admin, second_admin = uuid4(), uuid4()

    first, second = race(
        db_engine,
        move(first_admin, order_id, PREPARING),
        move(second_admin, order_id, PREPARING),
    )

    assert isinstance(first.outcome, Order) and first.outcome.status == PREPARING
    assert isinstance(second.outcome, InvalidTransition)  # esperó, vio `en_preparacion` y falló
    assert (second.outcome.from_status, second.outcome.to_status) == (PREPARING, PREPARING)
    assert len(first.audit.entries) == 1 and second.audit.entries == []
    assert admin_rows(db_engine, order_id) == [("en_preparacion", "admin", first_admin)]
    assert state(db_engine, order_id)["status"] == "en_preparacion"


def test_two_admins_cancelling_the_same_paid_order_refund_once_and_leave_one_history_row(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    _, order_id = paid(world, db_engine, (a, 2), (b, 1))
    total = total_of(db_engine, order_id)
    stock = (world.on_hand(a), world.on_hand(b))
    first_admin, second_admin = uuid4(), uuid4()

    first, second = race(
        db_engine, cancel_by(first_admin, order_id), cancel_by(second_admin, order_id)
    )

    assert isinstance(first.outcome, Order) and first.outcome.refunded_amount == total
    assert isinstance(second.outcome, InvalidTransition)
    assert second.outcome.from_status == CANCELLED and second.outcome.allowed == frozenset()
    assert len(first.audit.entries) == 1 and second.audit.entries == []  # una sola auditoría
    assert first.audit.entries[0].after == {"status": "cancelado", "refunded_amount": total}
    assert admin_rows(db_engine, order_id) == [("cancelado", "admin", first_admin)]
    final = state(db_engine, order_id)
    assert final["refunded_amount"] == total  # un solo reembolso, el total
    assert final["reservations"] == ["consumed", "consumed"]
    assert (world.on_hand(a), world.on_hand(b)) == stock  # R15: nadie repone el stock


def test_many_admins_cancelling_at_once_refund_once_and_audit_once(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=9)
    _, order_id = paid(world, db_engine, (product, 3))
    total, workers = total_of(db_engine, order_id), 5
    admins = [uuid4() for _ in range(workers)]
    start = threading.Barrier(workers)

    def racing(admin: UUID) -> Callable[[Session], Result]:
        def work(session: Session) -> Result:
            start.wait(TIMEOUT)
            return cancel_by(admin, order_id)(session)

        return work

    with ThreadPoolExecutor(workers) as pool:
        results = [
            f.result(TIMEOUT)
            for f in [pool.submit(in_transaction, db_engine, racing(a)) for a in admins]
        ]

    winners = [r for r in results if isinstance(r.outcome, Order)]
    losers = [r for r in results if isinstance(r.outcome, InvalidTransition)]
    assert len(winners) == 1 and len(losers) == workers - 1
    assert sum(len(r.audit.entries) for r in results) == 1
    assert len(admin_rows(db_engine, order_id)) == 1  # una sola fila de historial
    final = state(db_engine, order_id)
    assert final["refunded_amount"] == total and final["status"] == "cancelado"
    assert world.on_hand(product) == 6  # 9 - 3 de la venta; la cancelación no lo repone


def test_a_cancellation_that_waits_for_a_preparation_still_refunds_once(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = paid(world, db_engine, (product, 1))
    total, preparer, canceller = total_of(db_engine, order_id), uuid4(), uuid4()

    prepared, cancelled = race(
        db_engine, move(preparer, order_id, PREPARING), cancel_by(canceller, order_id)
    )

    assert prepared.outcome.status == PREPARING  # type: ignore[union-attr]
    assert cancelled.outcome.status == CANCELLED  # type: ignore[union-attr]  # en_preparacion → cancelado
    assert admin_rows(db_engine, order_id) == [
        ("en_preparacion", "admin", preparer),
        ("cancelado", "admin", canceller),
    ]
    assert state(db_engine, order_id)["refunded_amount"] == total


def test_a_preparation_that_waits_for_a_cancellation_is_invalid_and_nothing_is_prepared(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = paid(world, db_engine, (product, 1))
    total, canceller, preparer = total_of(db_engine, order_id), uuid4(), uuid4()

    cancelled, prepared = race(
        db_engine, cancel_by(canceller, order_id), move(preparer, order_id, PREPARING)
    )

    assert cancelled.outcome.status == CANCELLED  # type: ignore[union-attr]
    assert isinstance(prepared.outcome, InvalidTransition)
    assert prepared.outcome.from_status == CANCELLED and prepared.audit.entries == []
    assert admin_rows(db_engine, order_id) == [("cancelado", "admin", canceller)]
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and final["refunded_amount"] == total


def test_an_unknown_order_is_reported_without_blocking_or_writing(
    world: World, db_engine: Engine
) -> None:
    result = in_transaction(db_engine, cancel_by(uuid4(), uuid4()))

    assert isinstance(result.outcome, OrderNotFound)
    assert result.released == [] and result.audit.entries == []


# --------------------------------------------------------------------------------------------
# CA-ORDERS-15: el administrador contra el pago del cliente (ConfirmOrderPayment real)
def test_an_admin_cancellation_that_holds_the_row_wins_and_the_payment_is_not_payable(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))
    admin = uuid4()

    cancelled, payment = race(db_engine, cancel_by(admin, order_id), confirm(user, order_id))

    assert isinstance(cancelled.outcome, Order) and cancelled.outcome.status == CANCELLED
    assert cancelled.outcome.refunded_amount is None  # no se había cobrado: sin reembolso
    assert cancelled.released == [order_id] and len(cancelled.audit.entries) == 1
    assert isinstance(payment.outcome, OrderNotPayable) and payment.outcome.status == CANCELLED
    assert payment.released == [] and payment.audit.entries == []  # el pago no consumió nada
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and final["paid_at"] is None
    assert final["refunded_amount"] is None and final["sales"] == 0
    assert final["reservations"] == ["released", "released"]
    assert (world.on_hand(a), world.on_hand(b)) == (5, 5)  # nunca stock descontado si se canceló
    assert (world.active_reservations(a), world.active_reservations(b)) == (0, 0)
    assert admin_rows(db_engine, order_id) == [("cancelado", "admin", admin)]


def test_a_payment_that_holds_the_row_wins_and_the_admin_cancellation_refunds_the_total(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))
    total, admin = total_of(db_engine, order_id), uuid4()

    payment, cancelled = race(db_engine, confirm(user, order_id), cancel_by(admin, order_id))

    assert payment.outcome == PaymentOutcome.PAID
    assert isinstance(cancelled.outcome, Order) and cancelled.outcome.status == CANCELLED
    assert cancelled.outcome.refunded_amount == total  # esperó, vio `pagado`: reembolsa el total
    assert cancelled.audit.entries[0].before == {"status": "pagado"}
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and final["paid_at"] is not None
    assert final["refunded_amount"] == total
    assert final["reservations"] == ["consumed", "consumed"]  # nunca pagado con reservas liberadas
    assert final["sales"] == 2
    assert (world.on_hand(a), world.on_hand(b)) == (3, 4)  # el pago descontó; cancelar NO repone
    assert admin_rows(db_engine, order_id) == [("cancelado", "admin", admin)]


def test_payments_and_admin_cancellations_that_share_products_never_deadlock_or_contradict(
    world: World, db_engine: Engine
) -> None:
    # Pedidos que comparten productos en distinto orden, cada uno con su pago y su cancelación del
    # administrador en marcha a la vez (R4: pedido → reservas → stock, sin interbloqueo).
    a, b = world.product(on_hand=40), world.product(on_hand=40)
    shapes = [((a, 1), (b, 1)), ((b, 1), (a, 1)), ((a, 2), (b, 2)), ((b, 3), (a, 1))]
    orders = [placed(world, db_engine, *lines) for lines in shapes]
    totals = {order_id: total_of(db_engine, order_id) for _, order_id in orders}
    start = threading.Barrier(len(orders) * 2)

    def go(work: Callable[[Session], object]) -> Callable[[Session], object]:
        def waiting(session: Session) -> object:
            start.wait(TIMEOUT)
            return work(session)

        return waiting

    with ThreadPoolExecutor(len(orders) * 2) as pool:
        futures = [
            pool.submit(in_transaction, db_engine, go(work))
            for user, order_id in orders
            for work in (confirm(user, order_id), cancel_by(uuid4(), order_id))
        ]
        [f.result(TIMEOUT) for f in futures]  # un interbloqueo o un 500 sería un error aquí

    sold = {a: 0, b: 0}
    for (_, order_id), lines in zip(orders, shapes, strict=True):
        final = state(db_engine, order_id)
        money_is_consistent(final, totals[order_id])
        if final["paid_at"] is not None:
            for product, quantity in lines:
                sold[product] += quantity
        assert len(admin_rows(db_engine, order_id)) == 1  # una sola cancelación del administrador
    assert (world.on_hand(a), world.on_hand(b)) == (40 - sold[a], 40 - sold[b])
    assert world.active_reservations(a) == world.active_reservations(b) == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-15: el administrador contra la cancelación del cliente (T-076)
def test_an_admin_cancellation_that_holds_the_row_wins_and_the_customer_one_is_idempotent(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    admin = uuid4()

    by_admin, by_customer = race(db_engine, cancel_by(admin, order_id), cancel(user, order_id))

    assert isinstance(by_admin.outcome, Order) and by_admin.outcome.status == CANCELLED
    assert isinstance(by_customer.outcome, Order) and by_customer.outcome.status == CANCELLED
    assert by_customer.released == [] and by_customer.audit.entries == []  # no repite nada
    final = state(db_engine, order_id)
    assert [h for h in final["history"] if h[0] == "cancelado"] == [("cancelado", "admin")]
    assert final["refunded_amount"] is None and final["reservations"] == ["released"]
    assert by_admin.released == [order_id]  # una sola liberación
    assert world.active_reservations(product) == 0 and world.on_hand(product) == 5


def test_a_customer_cancellation_that_holds_the_row_wins_and_the_admin_one_is_invalid(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))

    by_customer, by_admin = race(db_engine, cancel(user, order_id), cancel_by(uuid4(), order_id))

    assert isinstance(by_customer.outcome, Order) and by_customer.released == [order_id]
    assert isinstance(by_admin.outcome, InvalidTransition)
    assert by_admin.outcome.from_status == CANCELLED
    assert by_admin.released == [] and by_admin.audit.entries == []
    final = state(db_engine, order_id)
    assert [h for h in final["history"] if h[0] == "cancelado"] == [("cancelado", "customer")]
    assert admin_rows(db_engine, order_id) == []  # el administrador no dejó ninguna fila
    assert final["refunded_amount"] is None and final["reservations"] == ["released"]
    assert world.active_reservations(product) == 0 and world.on_hand(product) == 5


# --------------------------------------------------------------------------------------------
# R7: el administrador contra la caducidad por lectura
def test_a_read_that_expires_the_order_first_makes_the_admin_transition_invalid(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    overdue(db_engine, order_id)

    read, cancelled = race(db_engine, read_expiring(user, order_id), cancel_by(uuid4(), order_id))

    assert read.outcome == EXPIRED and read.released == [order_id]
    assert isinstance(cancelled.outcome, InvalidTransition)
    assert cancelled.outcome.from_status == EXPIRED
    assert cancelled.released == [] and cancelled.audit.entries == []
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["refunded_amount"] is None
    assert final["reservations"] == ["released"]
    assert admin_rows(db_engine, order_id) == []
    assert world.active_reservations(product) == 0 and world.on_hand(product) == 5
