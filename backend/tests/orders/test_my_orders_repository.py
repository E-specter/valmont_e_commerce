"""Cambios de T-075 en el repositorio real (SPEC §5 y §6; D-041 P-6, R-11): `list_for_user` con
varios estados (`statuses`, `IN (...)`) y los pedidos completos (`get`, `find_by_key`, `apply`,
`expire_overdue`) con la entrega como `Delivery`: transportista, seguimiento y fecha de envío.
Las pruebas de orden y paginación de T-073 siguen en `test_repository_lists.py`. Ficticios."""

from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import BASE, change, stored_order
from tests.orders.orders_helpers import pickup_delivery
from tests.orders.orders_read_helpers import ALL_STATUSES, set_status
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.domain import (
    ActorKind,
    Delivery,
    DeliveryDetails,
    DeliveryMethod,
    Order,
    OrderStatus,
)

pytestmark = pytest.mark.integration

PENDING, PAID, PREPARING, SHIPPED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PREPARING,
    OrderStatus.SHIPPED,
)


def one_of_each(session: Session) -> tuple[UUID, dict[str, Order]]:
    """Un pedido por estado de un cliente nuevo, de más antiguo a más reciente."""
    user = add_profile(session)
    made: dict[str, Order] = {}
    for n, status in enumerate(ALL_STATUSES):
        order = stored_order(session, user_id=user, now=BASE + timedelta(minutes=n))
        if status != "pendiente_pago":
            set_status(session, order.id, status)
        made[status] = order
    return user, made


# --- list_for_user con varios estados (D-041 P-6) --------------------------------------------
@pytest.mark.parametrize("kind", [frozenset, list, tuple, set])
def test_list_for_user_accepts_any_collection_of_statuses(db_session: Session, kind: type) -> None:
    user, made = one_of_each(db_session)
    wanted = kind([PAID, PREPARING])

    page = SqlOrderRepository(db_session).list_for_user(user, statuses=wanted, page=1, page_size=20)

    assert {s.id for s in page.items} == {made["pagado"].id, made["en_preparacion"].id}
    assert page.total == 2


def test_list_for_user_with_none_returns_every_status(db_session: Session) -> None:
    user, made = one_of_each(db_session)

    page = SqlOrderRepository(db_session).list_for_user(user, statuses=None, page=1, page_size=20)

    assert {s.id for s in page.items} == {o.id for o in made.values()} and page.total == 8


def test_list_for_user_with_one_status_matches_the_single_filter(db_session: Session) -> None:
    user, made = one_of_each(db_session)

    page = SqlOrderRepository(db_session).list_for_user(
        user, statuses=frozenset({SHIPPED}), page=1, page_size=20
    )

    assert [s.id for s in page.items] == [made["enviado"].id]


def test_the_total_and_the_page_count_only_the_filtered_orders(db_session: Session) -> None:
    user, made = one_of_each(db_session)
    wanted = frozenset({PAID, PREPARING, SHIPPED})
    repository = SqlOrderRepository(db_session)

    first = repository.list_for_user(user, statuses=wanted, page=1, page_size=2)
    second = repository.list_for_user(user, statuses=wanted, page=2, page_size=2)
    beyond = repository.list_for_user(user, statuses=wanted, page=3, page_size=2)

    assert [s.id for s in (*first.items, *second.items)] == [  # el más reciente primero
        made["enviado"].id,
        made["en_preparacion"].id,
        made["pagado"].id,
    ]
    assert (first.total, second.total, beyond.total) == (3, 3, 3) and beyond.items == ()


def test_the_statuses_filter_never_crosses_to_another_customers_orders(db_session: Session) -> None:
    me, theirs = add_profile(db_session), add_profile(db_session)
    mine = stored_order(db_session, user_id=me)
    other = stored_order(db_session, user_id=theirs)
    for order in (mine, other):
        set_status(db_session, order.id, "pagado")

    page = SqlOrderRepository(db_session).list_for_user(
        me, statuses=frozenset({PAID, PENDING}), page=1, page_size=20
    )

    assert [s.id for s in page.items] == [mine.id] and page.total == 1


def test_the_filter_is_passed_as_a_parameter_not_concatenated(db_session: Session) -> None:
    # Un valor del enum nunca lleva comillas, pero la consulta no debe construirse con texto.
    user, _ = one_of_each(db_session)
    seen: list[str] = []

    def capture(*args: Any) -> None:
        statement = args[2]
        seen.append(statement)

    event.listen(db_session.get_bind(), "before_cursor_execute", capture)
    try:
        SqlOrderRepository(db_session).list_for_user(
            user, statuses=frozenset({PAID}), page=1, page_size=20
        )
    finally:
        event.remove(db_session.get_bind(), "before_cursor_execute", capture)

    assert seen and not any("'pagado'" in s for s in seen)


# --- el pedido completo trae los datos de envío (R-11) ---------------------------------------
def test_get_returns_a_delivery_with_the_shipment_columns(db_session: Session) -> None:
    order = stored_order(db_session)
    db_session.execute(
        text(
            "UPDATE app.deliveries SET carrier = 'Olva', tracking_code = 'OL-1',"
            " shipped_at = :at WHERE order_id = :id"
        ),
        {"at": BASE + timedelta(hours=3), "id": order.id},
    )

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None and isinstance(read.delivery, Delivery)
    assert isinstance(read.delivery, DeliveryDetails)
    assert (read.delivery.carrier, read.delivery.tracking_code) == ("Olva", "OL-1")
    assert read.delivery.shipped_at == BASE + timedelta(hours=3)


def test_get_returns_none_shipment_fields_for_a_new_order(db_session: Session) -> None:
    shipping, pickup = (
        stored_order(db_session),
        stored_order(db_session, delivery=pickup_delivery()),
    )
    repository = SqlOrderRepository(db_session)

    for order in (shipping, pickup):
        read = repository.get(order.id)
        assert read is not None and read.delivery == order.delivery
        shipment = tuple(
            getattr(read.delivery, name, None)
            for name in ("carrier", "tracking_code", "shipped_at")
        )
        assert shipment == (None, None, None)


def test_the_delivery_keeps_every_other_field_of_the_input(db_session: Session) -> None:
    order = stored_order(db_session)

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None
    d, o = read.delivery, order.delivery
    assert (d.delivery_method, d.recipient_name, d.phone) == (
        DeliveryMethod.SHIPPING,
        o.recipient_name,
        o.phone,
    )
    assert (d.department, d.province, d.district, d.address_line, d.reference) == (
        o.department,
        o.province,
        o.district,
        o.address_line,
        o.reference,
    )


def test_find_by_key_returns_the_same_complete_order(db_session: Session) -> None:
    order = stored_order(db_session, key="clave-de-busqueda-0001")

    found = SqlOrderRepository(db_session).find_by_key(order.user_id, "clave-de-busqueda-0001")

    assert found is not None and found.delivery == order.delivery
    assert found.id == order.id


def test_apply_to_shipped_returns_the_order_with_the_shipment_data(db_session: Session) -> None:
    order = stored_order(db_session)
    repository = SqlOrderRepository(db_session)
    at = BASE + timedelta(hours=2)
    repository.apply(
        order.id, change(PENDING, PAID, kind=ActorKind.CUSTOMER, actor_id=order.user_id), paid=True
    )
    repository.apply(order.id, change(PAID, PREPARING))

    shipped = repository.apply(
        order.id, change(PREPARING, SHIPPED, at=at), carrier="Olva", tracking_code="OL-9"
    )

    assert isinstance(shipped.delivery, Delivery)
    assert (shipped.delivery.carrier, shipped.delivery.tracking_code) == ("Olva", "OL-9")
    assert shipped.delivery.shipped_at == at and shipped.status == SHIPPED


def test_expire_overdue_returns_orders_with_the_complete_delivery(db_session: Session) -> None:
    order = stored_order(db_session)

    (expired,) = SqlOrderRepository(db_session).expire_overdue(
        BASE + timedelta(minutes=31), order_ids=[order.id]
    )

    assert expired.delivery == order.delivery  # sin envío: el mismo `DeliveryDetails` de `add`
    assert not any(
        getattr(expired.delivery, n, None) for n in ("carrier", "tracking_code", "shipped_at")
    )
    assert expired.delivery.recipient_name == order.delivery.recipient_name


def test_a_pickup_order_reads_back_as_a_valid_pickup_delivery(db_session: Session) -> None:
    order = stored_order(db_session, delivery=pickup_delivery(), key=f"clave-{uuid4().hex}")

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None and read.delivery.delivery_method == DeliveryMethod.PICKUP
    assert read.delivery.department is None and read.delivery.address_line is None


@pytest.mark.parametrize("column", ["carrier", "tracking_code", "shipped_at"])
def test_a_single_shipment_column_is_enough_to_read_a_delivery(
    db_session: Session, column: str
) -> None:
    order = stored_order(db_session)
    value = BASE + timedelta(hours=1) if column == "shipped_at" else "X-1"
    db_session.execute(
        text(f"UPDATE app.deliveries SET {column} = :v WHERE order_id = :id"),
        {"v": value, "id": order.id},
    )

    read = SqlOrderRepository(db_session).get(order.id)

    assert read is not None and isinstance(read.delivery, Delivery)
    assert getattr(read.delivery, column) == value


# --- statuses vacío = ninguno (decisión del Leader) --------------------------------------------
@pytest.mark.parametrize("empty", [frozenset(), [], ()])
def test_an_empty_statuses_collection_means_no_order_at_all(
    db_session: Session, empty: Any
) -> None:
    user, _ = one_of_each(db_session)

    page = SqlOrderRepository(db_session).list_for_user(user, statuses=empty, page=1, page_size=20)

    assert (page.items, page.total, page.page, page.page_size) == ((), 0, 1, 20)


# --- el caso de uso real sobre el repositorio real: un GET ajeno no cambia nada (R7, R12) -------
def test_a_foreign_read_of_an_overdue_order_changes_nothing_in_the_database(
    db_session: Session,
) -> None:
    # La solicitud HTTP deshace su SAVEPOINT al responder 404, así que ese rastro solo se ve aquí,
    # con el caso de uso y la sesión de la prueba.
    from tests.orders.orders_create_helpers import Calls, FakeAudit
    from tests.orders.orders_db_helpers import history_of, status_in_db
    from tests.orders.test_my_orders_concurrency import FixedClock
    from tests.orders.test_my_orders_usecases import Release
    from valmont.modules.orders.application import ExpireOverdueOrders, GetMyOrder
    from valmont.modules.orders.domain import OrderNotFound

    order = stored_order(db_session)
    intruder = add_profile(db_session)
    repository, calls = SqlOrderRepository(db_session), Calls()
    release, audit = Release(calls), FakeAudit(calls)
    expire = ExpireOverdueOrders(repository, release, audit, FixedClock(BASE + timedelta(hours=1)))  # type: ignore[arg-type]

    with pytest.raises(OrderNotFound):
        GetMyOrder(repository, expire)(intruder, order.id)  # type: ignore[arg-type]

    assert status_in_db(db_session, order.id) == "pendiente_pago"
    assert len(history_of(db_session, order.id)) == 1
    assert release.released == [] and audit.entries == []
    # el dueño sí la materializa
    assert GetMyOrder(repository, expire)(order.user_id, order.id).status == OrderStatus.EXPIRED  # type: ignore[arg-type]
