"""Repositorio SQL de orders (T-073): `add`, lectura completa, `find_by_key`, `count_pending`,
`get`, `apply` y `SqlClock` contra la BD de pruebas. CA-ORDERS-20 (historial), la parte de
repositorio de CA-ORDERS-08 (UNIQUE → IdempotencyConflict) y CA-ORDERS-23 (importes sin pérdida).
Datos ficticios; la transacción de cada prueba se deshace.

Los efectos se comprueban con SQL directo además de con el propio repositorio, para que una
lectura y una escritura equivocadas del mismo modo no se tapen entre sí."""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import (
    BASE,
    change,
    history_of,
    new_order,
    pickup_order,
    real_line,
    rows,
    scalar,
    status_in_db,
    stored_order,
)
from tests.orders.orders_helpers import shipping_delivery
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.domain import (
    ActorKind,
    Fulfillment,
    IdempotencyConflict,
    InvalidTransition,
    Order,
    OrderStatus,
)

pytestmark = pytest.mark.integration

PENDING, PAID, PREPARING = OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderStatus.PREPARING
SHIPPED, CANCELLED, EXPIRED = OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.EXPIRED


def assert_same_order(actual: Order | None, expected: Order, *, number: int | None = None) -> None:
    """Todos los campos del dominio, uno a uno (las secuencias, como lista)."""
    assert actual is not None
    assert actual.id == expected.id
    assert actual.number == (number if number is not None else actual.number)
    assert actual.user_id == expected.user_id
    assert actual.status == expected.status
    assert list(actual.lines) == list(expected.lines)
    assert actual.delivery == expected.delivery
    assert actual.shipping_amount == expected.shipping_amount
    assert actual.subtotal_amount == expected.subtotal_amount
    assert actual.total_amount == expected.total_amount
    assert actual.created_at == expected.created_at
    assert actual.expires_at == expected.expires_at
    assert actual.estimated_delivery_on == expected.estimated_delivery_on
    assert actual.paid_at == expected.paid_at
    assert actual.refunded_amount == expected.refunded_amount
    assert actual.refunded_at == expected.refunded_at
    assert list(actual.history) == list(expected.history)
    assert actual.idempotency_key == expected.idempotency_key


def mixed_lines(session: Session) -> list[Any]:
    """Una línea con promoción, una Bajo pedido con plazo y una de stock sin promoción."""
    return [
        real_line(
            session,
            quantity=2,
            list_price=250_000,
            unit_price=225_000,
            promotion_id=uuid4(),
            sku="TST-ORD-0001",
            name="Heritage 38",
        ),
        real_line(
            session,
            quantity=1,
            list_price=900_000,
            fulfillment=Fulfillment.MADE_TO_ORDER,
            lead_time_days=21,
            sku="TST-ORD-0002",
            name="Tourbillon",
        ),
        real_line(session, quantity=3, list_price=40_000, sku="TST-ORD-0003", name="Correa"),
    ]


# ---------------------------------------------------------------------------------------------
# add y lectura completa.
def test_add_assigns_a_number_and_get_reads_every_field_back(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = new_order(db_session, lines=mixed_lines(db_session), delivery=shipping_delivery())

    added = repository.add(order)

    assert isinstance(added.number, int) and added.number > 0
    assert_same_order(added, order, number=added.number)
    assert order.number is None  # el dominio es inmutable: `add` devuelve otro objeto
    assert_same_order(repository.get(order.id), order, number=added.number)
    assert repository.get(order.id).number == added.number  # type: ignore[union-attr]


def test_the_round_trip_keeps_the_snapshot_prices_and_the_estimated_date(
    db_session: Session,
) -> None:
    order = stored_order(db_session, lines=mixed_lines(db_session))

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None
    first, second, third = read.lines
    assert (first.quantity, first.list_price, first.unit_price, first.discount_amount) == (
        2,
        250_000,
        225_000,
        25_000,
    )
    assert first.promotion_id == order.lines[0].promotion_id
    assert (second.fulfillment, second.lead_time_days) == (Fulfillment.MADE_TO_ORDER, 21)
    assert (third.fulfillment, third.lead_time_days, third.promotion_id) == (
        Fulfillment.STOCK,
        None,
        None,
    )
    assert read.subtotal_amount == 2 * 225_000 + 900_000 + 3 * 40_000
    assert read.estimated_delivery_on == order.estimated_delivery_on is not None
    assert read.expires_at == BASE + timedelta(minutes=30)


def test_lines_are_stored_with_their_position_and_read_back_in_that_order(
    db_session: Session,
) -> None:
    lines = mixed_lines(db_session)
    order = stored_order(db_session, lines=lines)

    stored = rows(
        db_session,
        "SELECT position, product_id, sku, line_total_amount FROM app.order_lines"
        " WHERE order_id = :id ORDER BY position",
        id=order.id,
    )

    assert stored == [
        (1, lines[0].product_id, "TST-ORD-0001", 450_000),
        (2, lines[1].product_id, "TST-ORD-0002", 900_000),
        (3, lines[2].product_id, "TST-ORD-0003", 120_000),
    ]
    read = SqlOrderRepository(db_session).get(order.id)
    assert [line.product_id for line in read.lines] == [line.product_id for line in lines]  # type: ignore[union-attr]


def test_a_pickup_order_round_trips_with_empty_location_fields(db_session: Session) -> None:
    order = pickup_order(db_session)

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None and read.delivery == order.delivery
    assert (read.delivery.department, read.delivery.address_line, read.delivery.reference) == (
        None,
        None,
        None,
    )
    assert rows(
        db_session,
        "SELECT delivery_method, department, province, district, address_line, reference,"
        " carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order.id,
    ) == [("pickup", None, None, None, None, None, None, None, None)]


def test_a_shipping_delivery_is_stored_without_carrier_tracking_or_shipping_date(
    db_session: Session,
) -> None:
    order = stored_order(db_session, delivery=shipping_delivery(reference=None))

    assert rows(
        db_session,
        "SELECT delivery_method, recipient_name, phone, district, reference, carrier,"
        " tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order.id,
    ) == [
        (
            "shipping",
            order.delivery.recipient_name,
            "+51987654321",
            "Miraflores",
            None,
            None,
            None,
            None,
        )
    ]
    assert SqlOrderRepository(db_session).get(order.id).delivery.reference is None  # type: ignore[union-attr]


def test_amounts_above_two_to_the_thirty_first_round_trip_without_loss(
    db_session: Session,
) -> None:
    # CA-ORDERS-23 / R2: Σ importes > 2³¹ céntimos.
    expensive = real_line(
        db_session, quantity=2, list_price=3_500_000_000, unit_price=3_000_000_000
    )
    order = stored_order(db_session, lines=[expensive])

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None
    assert read.subtotal_amount == read.total_amount == 6_000_000_000
    assert read.lines[0].discount_amount == 500_000_000
    assert scalar(
        db_session, "SELECT total_amount FROM app.orders WHERE id = :id", id=order.id
    ) == (6_000_000_000)


def test_add_stores_the_order_columns(db_session: Session) -> None:
    order = stored_order(db_session, key="k" * 30)

    assert rows(
        db_session,
        "SELECT user_id, status, idempotency_key, subtotal_amount, shipping_amount, total_amount,"
        " created_at, expires_at, paid_at, refunded_amount, refunded_at"
        " FROM app.orders WHERE id = :id",
        id=order.id,
    ) == [
        (
            order.user_id,
            "pendiente_pago",
            "k" * 30,
            order.subtotal_amount,
            0,
            order.total_amount,
            BASE,
            BASE + timedelta(minutes=30),
            None,
            None,
            None,
        )
    ]


def test_add_leaves_exactly_one_initial_history_row(db_session: Session) -> None:
    # CA-ORDERS-20: la creación deja una fila (None → pendiente_pago, el cliente, su fecha).
    order = stored_order(db_session)

    assert history_of(db_session, order.id) == [
        (None, "pendiente_pago", "customer", order.user_id, None, BASE)
    ]


def test_order_numbers_are_assigned_by_the_database_and_increase(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)

    numbers = [repository.add(new_order(db_session, user_id=user)).number for _ in range(3)]

    assert all(isinstance(n, int) for n in numbers)
    assert numbers[0] < numbers[1] < numbers[2]  # type: ignore[operator]


def test_add_does_not_commit(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    # La transacción es de quien llama (ORDERS-R4): `add`, `apply` y `expire_overdue` no confirman.
    def forbidden(*_: object) -> None:
        raise AssertionError("el repositorio hizo commit")

    order = new_order(db_session)
    monkeypatch.setattr(db_session, "commit", forbidden)
    repository = SqlOrderRepository(db_session)

    repository.add(order)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    repository.expire_overdue(BASE + timedelta(hours=2), order_ids=[order.id])


# ---------------------------------------------------------------------------------------------
# CA-ORDERS-08 (parte del repositorio): UNIQUE (user_id, idempotency_key) → IdempotencyConflict.
def test_the_same_key_for_the_same_user_raises_idempotency_conflict(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    first = repository.add(new_order(db_session, user_id=user, key="clave-de-prueba-0001"))
    second = new_order(db_session, user_id=user, key="clave-de-prueba-0001")

    with pytest.raises(IdempotencyConflict), db_session.begin_nested():
        repository.add(second)

    assert repository.find_by_key(user, "clave-de-prueba-0001").id == first.id  # type: ignore[union-attr]
    assert scalar(db_session, "SELECT count(*) FROM app.orders WHERE user_id = :u", u=user) == 1
    # El pedido rechazado no deja nada a medias: ni pedido, ni líneas, ni entrega, ni historial.
    for table in ("orders", "order_lines", "deliveries", "order_status_history"):
        column = "id" if table == "orders" else "order_id"
        assert (
            scalar(
                db_session, f"SELECT count(*) FROM app.{table} WHERE {column} = :id", id=second.id
            )
            == 0
        )


def test_the_same_key_for_another_user_creates_its_own_order(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    first = repository.add(new_order(db_session, key="clave-de-prueba-0002"))
    second = repository.add(new_order(db_session, key="clave-de-prueba-0002"))

    assert first.id != second.id and first.number != second.number


def test_another_key_for_the_same_user_creates_another_order(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)

    first = repository.add(new_order(db_session, user_id=user))
    second = repository.add(new_order(db_session, user_id=user))

    assert first.id != second.id


# ---------------------------------------------------------------------------------------------
# find_by_key.
def test_find_by_key_returns_the_complete_order_of_that_user(db_session: Session) -> None:
    order = stored_order(db_session, lines=mixed_lines(db_session))

    found = SqlOrderRepository(db_session).find_by_key(order.user_id, order.idempotency_key)

    assert_same_order(found, order, number=order.number)
    assert found.lines and found.delivery == order.delivery  # type: ignore[union-attr]


def test_find_by_key_ignores_other_users_and_unknown_keys(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    assert repository.find_by_key(uuid4(), order.idempotency_key) is None
    assert repository.find_by_key(order.user_id, "clave-que-no-existe-01") is None
    assert repository.find_by_key(add_profile(db_session), order.idempotency_key) is None


def test_find_by_key_treats_the_key_as_data_not_as_sql(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    hostile = "x' OR '1'='1' --"

    assert repository.find_by_key(order.user_id, hostile) is None
    assert repository.find_by_key(order.user_id, "x'; DROP TABLE app.orders; --") is None
    assert scalar(db_session, "SELECT to_regclass('app.orders') IS NOT NULL")


# ---------------------------------------------------------------------------------------------
# count_pending (R9).
def test_count_pending_counts_only_current_pending_orders_of_that_user(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    now = BASE + timedelta(minutes=10)
    current = [stored_order(db_session, user_id=user) for _ in range(2)]  # vencen a las 15:30
    stored_order(db_session, user_id=user, now=BASE - timedelta(hours=1))  # vencido
    cancelled = stored_order(db_session, user_id=user)
    repository.apply(
        cancelled.id, change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=user)
    )
    paid = stored_order(db_session, user_id=user)
    repository.apply(paid.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    stored_order(db_session)  # de otro cliente

    assert len(current) == 2
    assert repository.count_pending(user, now) == 2
    assert repository.count_pending(add_profile(db_session), now) == 0


def test_count_pending_excludes_an_order_that_expires_exactly_now(db_session: Session) -> None:
    # R6: vencido si expires_at ≤ now; vigente solo si expires_at > now.
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    expires = order.expires_at

    assert repository.count_pending(order.user_id, expires - timedelta(microseconds=1)) == 1
    assert repository.count_pending(order.user_id, expires) == 0
    assert repository.count_pending(order.user_id, expires + timedelta(seconds=1)) == 0


def test_count_pending_ignores_an_order_already_materialized_as_expired(
    db_session: Session,
) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.expire_overdue(BASE + timedelta(hours=1), order_ids=[order.id])

    assert repository.count_pending(order.user_id, BASE) == 0  # ya no es pendiente_pago


# ---------------------------------------------------------------------------------------------
# get.
def test_get_by_id_returns_the_order_and_none_for_an_unknown_id(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    assert_same_order(repository.get(order.id), order, number=order.number)
    assert repository.get(uuid4()) is None


def test_get_with_an_owner_filters_by_owner(db_session: Session) -> None:
    # R12: un pedido ajeno es None, igual que uno inexistente.
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    stranger = add_profile(db_session)

    assert repository.get(order.id, user_id=order.user_id) is not None
    assert repository.get(order.id, user_id=stranger) is None
    assert repository.get(order.id, user_id=stranger, lock=True) is None
    assert repository.get(uuid4(), user_id=order.user_id) is None


def test_get_with_lock_returns_the_same_complete_order(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session, lines=mixed_lines(db_session))

    locked = repository.get(order.id, lock=True)

    assert_same_order(locked, order, number=order.number)
    assert_same_order(repository.get(order.id, user_id=order.user_id, lock=True), order)


def test_get_returns_the_history_oldest_first(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    pay = change(PENDING, PAID, kind=ActorKind.SYSTEM, at=BASE + timedelta(minutes=5))
    prepare = change(PAID, PREPARING, note="Empaque", at=BASE + timedelta(minutes=6))
    ship = change(PREPARING, SHIPPED, at=BASE + timedelta(minutes=7))
    repository.apply(order.id, pay, paid=True)
    repository.apply(order.id, prepare)
    repository.apply(order.id, ship, carrier="Olva", tracking_code="OL-1")

    read = repository.get(order.id)

    assert read is not None
    assert [(c.from_status, c.to_status) for c in read.history] == [
        (None, PENDING),
        (PENDING, PAID),
        (PAID, PREPARING),
        (PREPARING, SHIPPED),
    ]
    assert list(read.history)[1:] == [pay, prepare, ship]
    assert read.history[0].actor_kind == ActorKind.CUSTOMER


# ---------------------------------------------------------------------------------------------
# apply (CA-ORDERS-20: un cambio, una fila de historial).
def test_apply_payment_sets_status_paid_at_and_one_history_row(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    pay = change(PENDING, PAID, kind=ActorKind.SYSTEM, at=BASE + timedelta(minutes=12))

    updated = repository.apply(order.id, pay, paid=True)

    assert updated.status == PAID and updated.paid_at == pay.at
    assert updated.history[-1] == pay and len(updated.history) == 2
    assert status_in_db(db_session, order.id) == "pagado"
    assert (
        scalar(db_session, "SELECT paid_at FROM app.orders WHERE id = :id", id=order.id) == pay.at
    )
    assert history_of(db_session, order.id)[-1] == (
        "pendiente_pago",
        "pagado",
        "system",
        None,
        None,
        pay.at,
    )
    assert len(history_of(db_session, order.id)) == 2


def test_apply_keeps_everything_else_of_the_order(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session, lines=mixed_lines(db_session))

    updated = repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)

    assert list(updated.lines) == list(order.lines)
    assert updated.delivery == order.delivery
    assert (updated.number, updated.user_id, updated.created_at, updated.expires_at) == (
        order.number,
        order.user_id,
        order.created_at,
        order.expires_at,
    )
    assert updated.total_amount == order.total_amount


def test_apply_without_paid_leaves_paid_at_empty(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    cancel = change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id)

    updated = repository.apply(order.id, cancel)

    assert updated.status == CANCELLED
    assert (updated.paid_at, updated.refunded_amount, updated.refunded_at) == (None, None, None)
    assert history_of(db_session, order.id)[-1][:5] == (
        "pendiente_pago",
        "cancelado",
        "customer",
        order.user_id,
        None,
    )


def test_apply_a_simulated_refund_on_cancelling_a_paid_order(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    cancel = change(PAID, CANCELLED, note="Cliente pidió cancelar", at=BASE + timedelta(hours=1))

    updated = repository.apply(order.id, cancel, refund_amount=order.total_amount)

    assert updated.status == CANCELLED
    assert (updated.refunded_amount, updated.refunded_at) == (order.total_amount, cancel.at)
    assert updated.paid_at is not None  # el pago ocurrió: no se borra
    assert history_of(db_session, order.id)[-1][:5] == (
        "pagado",
        "cancelado",
        "admin",
        cancel.actor_id,
        "Cliente pidió cancelar",
    )
    read = repository.get(order.id)
    assert read is not None and read.refunded_amount == order.total_amount


def test_apply_shipping_records_carrier_tracking_and_shipping_date(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    repository.apply(order.id, change(PAID, PREPARING))
    ship = change(PREPARING, SHIPPED, at=BASE + timedelta(days=1))

    updated = repository.apply(order.id, ship, carrier="Olva Courier", tracking_code="OL-123456")

    assert updated.status == SHIPPED
    assert rows(
        db_session,
        "SELECT carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order.id,
    ) == [("Olva Courier", "OL-123456", ship.at)]


def test_apply_shipping_without_carrier_still_sets_the_shipping_date(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    repository.apply(order.id, change(PAID, PREPARING))
    ship = change(PREPARING, SHIPPED, at=BASE + timedelta(days=1))

    repository.apply(order.id, ship)

    assert rows(
        db_session,
        "SELECT carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order.id,
    ) == [(None, None, ship.at)]


def test_apply_a_non_shipping_change_leaves_the_delivery_untouched(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    repository.apply(order.id, change(PAID, PREPARING))

    assert rows(
        db_session,
        "SELECT carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order.id,
    ) == [(None, None, None)]


def test_a_pickup_order_follows_its_own_path_without_shipping_data(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = pickup_order(db_session)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    repository.apply(order.id, change(PAID, PREPARING))
    ready = repository.apply(
        order.id, change(PREPARING, OrderStatus.READY_FOR_PICKUP, at=BASE + timedelta(days=2))
    )
    done = repository.apply(order.id, change(OrderStatus.READY_FOR_PICKUP, OrderStatus.DELIVERED))

    assert (ready.status, done.status) == (OrderStatus.READY_FOR_PICKUP, OrderStatus.DELIVERED)
    assert rows(
        db_session,
        "SELECT carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order.id,
    ) == [(None, None, None)]
    assert len(history_of(db_session, order.id)) == 5


@pytest.mark.parametrize(
    ("expected", "actual"),
    [
        (PAID, PENDING),  # esperaba pagado: sigue pendiente
        (PENDING, PAID),  # esperaba pendiente: otro ya lo pagó
        (PENDING, CANCELLED),
        (PENDING, EXPIRED),
    ],
)
def test_apply_with_an_unexpected_current_status_raises_invalid_transition(
    db_session: Session, expected: OrderStatus, actual: OrderStatus
) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    if actual == PAID:
        repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    elif actual == CANCELLED:
        repository.apply(
            order.id, change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id)
        )
    elif actual == EXPIRED:
        repository.expire_overdue(BASE + timedelta(hours=1), order_ids=[order.id])
    before_status = status_in_db(db_session, order.id)
    before_history = history_of(db_session, order.id)

    with pytest.raises(InvalidTransition):
        repository.apply(order.id, change(expected, OrderStatus.PREPARING))

    assert status_in_db(db_session, order.id) == before_status
    assert history_of(db_session, order.id) == before_history  # sin fila de historial a medias


def test_a_failed_apply_with_paid_does_not_set_paid_at(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.apply(
        order.id, change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id)
    )

    with pytest.raises(InvalidTransition):
        repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)

    assert scalar(db_session, "SELECT paid_at FROM app.orders WHERE id = :id", id=order.id) is None
    assert status_in_db(db_session, order.id) == "cancelado"


def test_every_change_adds_exactly_one_history_row(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    steps = [
        (change(PENDING, PAID, kind=ActorKind.SYSTEM), {"paid": True}),
        (change(PAID, PREPARING), {}),
        (change(PREPARING, SHIPPED), {"carrier": "Olva"}),
        (change(SHIPPED, OrderStatus.DELIVERED), {}),
    ]

    for number, (step, extra) in enumerate(steps, start=2):
        repository.apply(order.id, step, **extra)
        assert len(history_of(db_session, order.id)) == number


def test_apply_returns_the_order_as_get_reads_it_afterwards(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    updated = repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)

    assert_same_order(repository.get(order.id), updated)


# ---------------------------------------------------------------------------------------------
# SqlClock (UC-01, I-8): el reloj es el de la BD, no el de Python.
def test_the_clock_returns_the_transaction_time_of_the_database_in_utc(db_session: Session) -> None:
    clock = SqlClock(db_session)

    now = clock.now()

    assert now.tzinfo is not None and now.utcoffset() == timedelta(0)
    assert now == db_session.scalars(select(func.now())).one()
    assert abs(now - datetime.now(UTC)) < timedelta(minutes=1)


def test_the_clock_is_stable_inside_a_transaction(db_session: Session) -> None:
    # `now()` de PostgreSQL es la hora de inicio de la transacción: pedido y reservas comparten
    # instante aunque pase tiempo entre una llamada y otra.
    clock = SqlClock(db_session)
    first = clock.now()

    db_session.execute(select(func.pg_sleep(0.05)))

    assert clock.now() == first
