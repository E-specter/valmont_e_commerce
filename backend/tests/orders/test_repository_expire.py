"""`expire_overdue` del repositorio (CA-ORDERS-13, ORDERS-R6 y R7, D-017): materializa los
pedidos `pendiente_pago` con `expires_at ≤ now` y solo esos, con límite, en orden por `id` y con
el historial `system` de las filas que cambió. El bloqueo `SKIP LOCKED` entre dos conexiones está
en `test_repository_concurrency.py`. Cada prueba acota con `order_ids` o `user_id` para no
depender de otras filas de la BD de pruebas."""

import inspect
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import (
    BASE,
    change,
    history_of,
    scalar,
    status_in_db,
    stored_order,
)
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.domain import ActorKind, OrderStatus, StatusChange

pytestmark = pytest.mark.integration

PENDING, PAID, CANCELLED, EXPIRED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
)
OVERDUE = BASE + timedelta(minutes=31)  # el pedido creado en BASE vence en BASE + 30 min


def test_an_overdue_pending_order_becomes_expired_with_one_system_history_row(
    db_session: Session,
) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    expired = repository.expire_overdue(OVERDUE, order_ids=[order.id])

    assert [o.id for o in expired] == [order.id]
    assert expired[0].status == EXPIRED
    assert expired[0].history[-1] == StatusChange(
        PENDING, EXPIRED, ActorKind.SYSTEM, None, None, OVERDUE
    )
    assert status_in_db(db_session, order.id) == "expirado"
    assert history_of(db_session, order.id) == [
        (None, "pendiente_pago", "customer", order.user_id, None, BASE),
        ("pendiente_pago", "expirado", "system", None, None, OVERDUE),
    ]


def test_the_returned_orders_are_complete(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    (expired,) = repository.expire_overdue(OVERDUE, order_ids=[order.id])

    assert (expired.number, expired.user_id, expired.total_amount) == (
        order.number,
        order.user_id,
        order.total_amount,
    )
    assert list(expired.lines) == list(order.lines) and expired.delivery == order.delivery
    assert expired.paid_at is None and expired.refunded_amount is None


def test_a_later_get_in_the_same_session_sees_the_new_status(db_session: Session) -> None:
    # El caso de uso materializa y luego lee en la misma sesión: la lectura no puede devolver el
    # pedido tal como estaba antes (identidad en memoria obsoleta).
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    assert repository.get(order.id).status == PENDING  # type: ignore[union-attr]

    repository.expire_overdue(OVERDUE, order_ids=[order.id])

    read = repository.get(order.id)
    assert read is not None and read.status == EXPIRED
    assert read.history[-1].actor_kind == ActorKind.SYSTEM


def test_the_deadline_is_inclusive(db_session: Session) -> None:
    # R6: vencido si expires_at ≤ now.
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    just_before = repository.expire_overdue(
        order.expires_at - timedelta(microseconds=1), order_ids=[order.id]
    )
    exactly = repository.expire_overdue(order.expires_at, order_ids=[order.id])

    assert just_before == []
    assert [o.id for o in exactly] == [order.id]


def test_a_current_order_is_not_touched(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    assert repository.expire_overdue(BASE + timedelta(minutes=29), order_ids=[order.id]) == []

    assert status_in_db(db_session, order.id) == "pendiente_pago"
    assert len(history_of(db_session, order.id)) == 1


@pytest.mark.parametrize("target", [PAID, CANCELLED])
def test_a_paid_or_cancelled_order_never_expires(db_session: Session, target: OrderStatus) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    if target == PAID:
        repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    else:
        repository.apply(
            order.id, change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=order.user_id)
        )
    history = history_of(db_session, order.id)

    assert repository.expire_overdue(BASE + timedelta(days=30), order_ids=[order.id]) == []

    assert status_in_db(db_session, order.id) == target.value
    assert history_of(db_session, order.id) == history


@pytest.mark.parametrize(
    "later", [OrderStatus.PREPARING, OrderStatus.SHIPPED, OrderStatus.DELIVERED]
)
def test_a_paid_order_further_along_never_expires(db_session: Session, later: OrderStatus) -> None:
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)
    repository.apply(order.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    path = [OrderStatus.PREPARING, OrderStatus.SHIPPED, OrderStatus.DELIVERED]
    current = PAID
    for step in path[: path.index(later) + 1]:
        repository.apply(order.id, change(current, step))
        current = step

    assert repository.expire_overdue(BASE + timedelta(days=30), order_ids=[order.id]) == []

    assert status_in_db(db_session, order.id) == later.value


def test_only_the_overdue_orders_of_the_chosen_ones_change_and_get_history(
    db_session: Session,
) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    overdue = stored_order(db_session, user_id=user)
    current = stored_order(db_session, user_id=user, now=BASE + timedelta(minutes=20))
    paid = stored_order(db_session, user_id=user)
    repository.apply(paid.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    already_cancelled = stored_order(db_session, user_id=user)
    repository.apply(
        already_cancelled.id,
        change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=user),
    )
    ids = [overdue.id, current.id, paid.id, already_cancelled.id]
    counts = {i: len(history_of(db_session, i)) for i in ids}

    expired = repository.expire_overdue(OVERDUE, order_ids=ids)

    assert [o.id for o in expired] == [overdue.id]
    assert {i: status_in_db(db_session, i) for i in ids} == {
        overdue.id: "expirado",
        current.id: "pendiente_pago",
        paid.id: "pagado",
        already_cancelled.id: "cancelado",
    }
    # Solo la fila que cambió recibe historial `system`.
    assert {i: len(history_of(db_session, i)) for i in ids} == {
        **counts,
        overdue.id: counts[overdue.id] + 1,
    }


def test_reading_again_does_not_duplicate_anything(db_session: Session) -> None:
    # R7: repetir la lectura no duplica historial; la segunda llamada no devuelve nada.
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    first = repository.expire_overdue(OVERDUE, order_ids=[order.id])
    second = repository.expire_overdue(OVERDUE, order_ids=[order.id])
    third = repository.expire_overdue(OVERDUE + timedelta(days=1), user_id=order.user_id)

    assert [len(first), len(second), len(third)] == [1, 0, 0]
    assert len(history_of(db_session, order.id)) == 2


def test_user_id_limits_the_scope_to_that_customer(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    mine = stored_order(db_session)
    other = stored_order(db_session)

    expired = repository.expire_overdue(OVERDUE, user_id=mine.user_id)

    assert [o.id for o in expired] == [mine.id]
    assert status_in_db(db_session, mine.id) == "expirado"
    assert status_in_db(db_session, other.id) == "pendiente_pago"  # R12: nadie ajeno se toca


def test_order_ids_limits_the_scope_to_those_orders(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    chosen = stored_order(db_session, user_id=user)
    not_chosen = stored_order(db_session, user_id=user)

    expired = repository.expire_overdue(OVERDUE, order_ids=[chosen.id, uuid4()])

    assert [o.id for o in expired] == [chosen.id]
    assert status_in_db(db_session, not_chosen.id) == "pendiente_pago"


def test_an_empty_order_ids_collection_means_none_and_touches_nothing(
    db_session: Session,
) -> None:
    # UC-03: "ninguno", no "sin filtro" (una colección vacía nunca amplía el alcance).
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session)

    assert repository.expire_overdue(OVERDUE, order_ids=[]) == []
    assert repository.expire_overdue(OVERDUE, order_ids=()) == []
    assert repository.expire_overdue(OVERDUE, user_id=order.user_id, order_ids=[]) == []

    assert status_in_db(db_session, order.id) == "pendiente_pago"
    assert len(history_of(db_session, order.id)) == 1


def test_user_id_and_order_ids_combine_as_both_conditions(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    mine = stored_order(db_session)
    other = stored_order(db_session)

    expired = repository.expire_overdue(
        OVERDUE, user_id=mine.user_id, order_ids=[mine.id, other.id]
    )

    assert [o.id for o in expired] == [mine.id]
    assert status_in_db(db_session, other.id) == "pendiente_pago"


def test_the_limit_bounds_one_call_and_the_rest_waits_for_the_next(db_session: Session) -> None:
    # R7: máximo `limit` por llamada, en orden por id; el resto se materializa en la siguiente.
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    ids = sorted(stored_order(db_session, user_id=user).id for _ in range(5))

    first = repository.expire_overdue(OVERDUE, user_id=user, limit=2)
    second = repository.expire_overdue(OVERDUE, user_id=user, limit=2)
    third = repository.expire_overdue(OVERDUE, user_id=user, limit=2)
    fourth = repository.expire_overdue(OVERDUE, user_id=user, limit=2)

    assert [o.id for o in first] == ids[:2]
    assert [o.id for o in second] == ids[2:4]
    assert [o.id for o in third] == ids[4:]
    assert fourth == []


def test_the_default_limit_is_200_and_keyword_only() -> None:
    limit = inspect.signature(SqlOrderRepository.expire_overdue).parameters["limit"]

    assert limit.default == 200
    assert limit.kind is inspect.Parameter.KEYWORD_ONLY


def test_the_results_come_ordered_by_id(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    ids = [stored_order(db_session, user_id=user).id for _ in range(4)]

    expired = repository.expire_overdue(OVERDUE, user_id=user)

    assert [o.id for o in expired] == sorted(ids)


def test_each_expired_order_gets_its_own_history_row_with_the_given_instant(
    db_session: Session,
) -> None:
    repository = SqlOrderRepository(db_session)
    user = add_profile(db_session)
    orders = [stored_order(db_session, user_id=user) for _ in range(3)]
    now = BASE + timedelta(hours=2)

    expired = repository.expire_overdue(now, user_id=user)

    assert len(expired) == 3
    for order in orders:
        assert history_of(db_session, order.id)[-1] == (
            "pendiente_pago",
            "expirado",
            "system",
            None,
            None,
            now,
        )
    assert (
        scalar(
            db_session,
            "SELECT count(*) FROM app.order_status_history WHERE order_id = ANY(:ids)"
            " AND actor_kind = 'system'",
            ids=[o.id for o in orders],
        )
        == 3
    )
