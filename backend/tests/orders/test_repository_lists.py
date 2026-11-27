"""Listados del repositorio (CA-ORDERS-17, ORDERS-R17, SPEC §7): `list_for_user` y `list_all` con
su orden (`created_at desc, id desc`), paginación, filtros de administración y comodines
escapados. Cada prueba usa una etiqueta propia en el nombre del destinatario para no depender de
otras filas de la BD de pruebas."""

from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import (
    BASE,
    change,
    letters,
    pickup_order,
    real_line,
    scalar,
    stored_order,
)
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.application import AdminOrderQuery, OrderPage, OrderSummary
from valmont.modules.orders.domain import (
    ActorKind,
    OrderStatus,
    format_order_number,
)

pytestmark = pytest.mark.integration

PENDING, PAID, CANCELLED = OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderStatus.CANCELLED


def at(minutes: int) -> datetime:
    return BASE + timedelta(minutes=minutes)


def admin_query(**changes: Any) -> AdminOrderQuery:
    values: dict[str, Any] = {
        "status": None,
        "q": None,
        "created_from": None,
        "created_to": None,
        "page": 1,
        "page_size": 20,
    }
    return AdminOrderQuery(**{**values, **changes})


def named(session: Session, name: str, **kwargs: Any) -> Any:
    """Pedido de envío guardado con ese nombre de destinatario."""
    kwargs.setdefault("delivery", shipping_delivery(recipient_name=name))
    return stored_order(session, **kwargs)


# ---------------------------------------------------------------------------------------------
# list_for_user.
def test_list_for_user_returns_only_the_own_orders_newest_first(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    me, other = add_profile(db_session), add_profile(db_session)
    middle = stored_order(db_session, user_id=me, now=at(10))
    oldest = stored_order(db_session, user_id=me, now=at(0))
    newest = stored_order(db_session, user_id=me, now=at(20))
    stored_order(db_session, user_id=other, now=at(30))  # ajeno: no aparece ni cuenta

    page = repository.list_for_user(me, statuses=None, page=1, page_size=20)

    assert isinstance(page, OrderPage)
    assert [s.id for s in page.items] == [newest.id, middle.id, oldest.id]
    assert (page.total, page.page, page.page_size) == (3, 1, 20)


def test_orders_created_at_the_same_instant_are_ordered_by_id_descending(
    db_session: Session,
) -> None:
    repository = SqlOrderRepository(db_session)
    me = add_profile(db_session)
    ids = [stored_order(db_session, user_id=me, now=at(0)).id for _ in range(4)]

    page = repository.list_for_user(me, statuses=None, page=1, page_size=20)

    assert [s.id for s in page.items] == sorted(ids, reverse=True)


def test_the_summary_carries_the_fields_of_the_listing(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    lines = [
        real_line(db_session, quantity=2, list_price=250_000, unit_price=225_000),
        real_line(db_session, quantity=3, list_price=40_000),
    ]
    order = named(db_session, f"Ana {letters()}", lines=lines, now=at(5))

    (summary,) = repository.list_for_user(order.user_id, statuses=None, page=1, page_size=20).items

    assert isinstance(summary, OrderSummary)
    assert summary.id == order.id and summary.number == order.number
    assert summary.user_id == order.user_id and summary.status == PENDING
    assert summary.total_amount == 2 * 225_000 + 3 * 40_000
    assert summary.item_count == 5  # Σ de cantidades, no de líneas
    assert (summary.created_at, summary.expires_at) == (at(5), at(35))
    assert summary.estimated_delivery_on == order.estimated_delivery_on
    assert summary.recipient_name == order.delivery.recipient_name
    assert summary.district == "Miraflores"


def test_the_summary_of_a_pickup_order_has_no_district(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = pickup_order(db_session)

    (summary,) = repository.list_for_user(order.user_id, statuses=None, page=1, page_size=20).items

    assert summary.district is None and summary.recipient_name == order.delivery.recipient_name


def test_the_summary_total_above_two_to_the_thirty_first_is_exact(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    line = real_line(db_session, quantity=2, list_price=3_500_000_000, unit_price=3_000_000_000)
    order = stored_order(db_session, lines=[line])

    (summary,) = repository.list_for_user(order.user_id, statuses=None, page=1, page_size=20).items

    assert summary.total_amount == 6_000_000_000


def test_list_for_user_filters_by_status(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    me = add_profile(db_session)
    pending = stored_order(db_session, user_id=me, now=at(0))
    paid = stored_order(db_session, user_id=me, now=at(1))
    cancelled = stored_order(db_session, user_id=me, now=at(2))
    repository.apply(paid.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    repository.apply(cancelled.id, change(PENDING, CANCELLED, kind=ActorKind.CUSTOMER, actor_id=me))

    def listed(status: OrderStatus | None) -> tuple[list[Any], int]:
        page = repository.list_for_user(
            me, statuses=None if status is None else {status}, page=1, page_size=20
        )
        return [s.id for s in page.items], page.total

    assert listed(PENDING) == ([pending.id], 1)
    assert listed(PAID) == ([paid.id], 1)
    assert listed(CANCELLED) == ([cancelled.id], 1)
    assert listed(OrderStatus.EXPIRED) == ([], 0)
    assert listed(None) == ([cancelled.id, paid.id, pending.id], 3)


def test_list_for_user_paginates_with_the_real_total(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    me = add_profile(db_session)
    ordered = [stored_order(db_session, user_id=me, now=at(n)).id for n in range(5)][::-1]

    pages = [repository.list_for_user(me, statuses=None, page=p, page_size=2) for p in (1, 2, 3)]

    assert [[s.id for s in p.items] for p in pages] == [ordered[:2], ordered[2:4], ordered[4:]]
    assert [p.total for p in pages] == [5, 5, 5]
    assert [(p.page, p.page_size) for p in pages] == [(1, 2), (2, 2), (3, 2)]


def test_a_page_beyond_the_last_is_empty_with_the_real_total(db_session: Session) -> None:
    # R17: items [] y el total verdadero.
    repository = SqlOrderRepository(db_session)
    me = add_profile(db_session)
    for n in range(3):
        stored_order(db_session, user_id=me, now=at(n))

    page = repository.list_for_user(me, statuses=None, page=4, page_size=2)

    assert page.items == () and (page.total, page.page, page.page_size) == (3, 4, 2)


def test_a_customer_without_orders_gets_an_empty_page(db_session: Session) -> None:
    page = SqlOrderRepository(db_session).list_for_user(
        add_profile(db_session), statuses=None, page=1, page_size=20
    )

    assert page.items == () and page.total == 0


def test_list_for_user_does_not_leak_orders_of_another_user_by_status(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    me, other = add_profile(db_session), add_profile(db_session)
    stored_order(db_session, user_id=other)

    page = repository.list_for_user(me, statuses={PENDING}, page=1, page_size=20)

    assert page.items == () and page.total == 0


# ---------------------------------------------------------------------------------------------
# list_all (administración).
def test_list_all_returns_orders_of_every_customer_newest_first(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    first = named(db_session, f"{tag} Uno", now=at(0))
    second = named(db_session, f"{tag} Dos", now=at(10))
    third = named(db_session, f"{tag} Tres", now=at(5))  # otros clientes: cada pedido, su dueño

    page = repository.list_all(admin_query(q=tag))

    assert [s.id for s in page.items] == [second.id, third.id, first.id]
    assert page.total == 3
    assert {s.user_id for s in page.items} == {first.user_id, second.user_id, third.user_id}


def test_the_admin_summary_has_the_recipient_and_the_district(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    name = f"Luz {letters()}"
    order = named(db_session, name, now=at(3))

    (summary,) = repository.list_all(admin_query(q=name)).items

    assert summary.id == order.id and summary.number == order.number
    assert (summary.recipient_name, summary.district) == (name, "Miraflores")
    assert summary.item_count == 1 and summary.total_amount == order.total_amount


def test_list_all_ties_are_ordered_by_id_descending(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    ids = [named(db_session, f"{tag} {n}x", now=at(0)).id for n in "abc"]

    page = repository.list_all(admin_query(q=tag))

    assert [s.id for s in page.items] == sorted(ids, reverse=True)


def test_list_all_paginates_with_the_real_total(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    ordered = [named(db_session, f"{tag} {n}", now=at(i)).id for i, n in enumerate("abcde")][::-1]

    first = repository.list_all(admin_query(q=tag, page=1, page_size=2))
    last = repository.list_all(admin_query(q=tag, page=3, page_size=2))
    beyond = repository.list_all(admin_query(q=tag, page=9, page_size=2))

    assert [s.id for s in first.items] == ordered[:2] and first.total == 5
    assert [s.id for s in last.items] == ordered[4:] and last.total == 5
    assert beyond.items == () and beyond.total == 5
    assert (first.page, first.page_size, beyond.page) == (1, 2, 9)


def test_list_all_filters_by_status(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    pending = named(db_session, f"{tag} Pendiente", now=at(0))
    paid = named(db_session, f"{tag} Pagado", now=at(1))
    repository.apply(paid.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)

    only_paid = repository.list_all(admin_query(q=tag, status=PAID))
    only_pending = repository.list_all(admin_query(q=tag, status=PENDING))
    none = repository.list_all(admin_query(q=tag, status=OrderStatus.DELIVERED))

    assert [s.id for s in only_paid.items] == [paid.id] and only_paid.total == 1
    assert [s.id for s in only_pending.items] == [pending.id] and only_pending.total == 1
    assert none.items == () and none.total == 0


def test_q_matches_the_order_number_with_or_without_the_prefix(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    target = named(db_session, f"{tag} Uno", now=at(0))
    named(db_session, f"{tag} Dos", now=at(1))

    by_label = repository.list_all(admin_query(q=format_order_number(target.number)))
    by_digits = repository.list_all(admin_query(q=str(target.number)))

    assert [s.id for s in by_label.items] == [target.id]
    assert [s.id for s in by_digits.items] == [target.id]


def test_q_for_an_unknown_number_finds_nothing(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    named(db_session, f"Ana {letters()}")

    page = repository.list_all(admin_query(q="VAL-999999999"))

    assert page.items == () and page.total == 0


def test_q_matches_the_recipient_name_containing_it_ignoring_case(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    target = named(db_session, f"{tag} Maria Lopez", now=at(0))
    named(db_session, f"{tag} Pedro Ruiz", now=at(1))

    page = repository.list_all(admin_query(q=f"{tag.upper()} MARIA"))
    inner = repository.list_all(admin_query(q="aria lopez"))  # contiene, no solo prefijo

    assert [s.id for s in page.items] == [target.id]
    assert target.id in [s.id for s in inner.items]
    assert all(s.recipient_name.lower().endswith("aria lopez") for s in inner.items)


def test_q_escapes_the_percent_wildcard(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    literal = named(db_session, f"{tag} Mar%a Lopez", now=at(0))
    named(db_session, f"{tag} Maria Lopez", now=at(1))  # "r%a" sin escapar también lo casaría

    page = repository.list_all(admin_query(q=f"{tag} Mar%a"))
    only_wildcard = repository.list_all(admin_query(q="%"))

    assert [s.id for s in page.items] == [literal.id]
    assert [s.id for s in only_wildcard.items] == [literal.id]  # solo el nombre con un % literal


def test_q_escapes_the_underscore_wildcard(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    literal = named(db_session, f"{tag} Ma_ia Lopez", now=at(0))
    named(db_session, f"{tag} Maria Lopez", now=at(1))  # "Ma_ia" sin escapar también lo casaría

    page = repository.list_all(admin_query(q=f"{tag} Ma_ia"))

    assert [s.id for s in page.items] == [literal.id]


def test_q_escapes_the_backslash(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    literal = named(db_session, f"{tag} Ana\\Luz", now=at(0))
    named(db_session, f"{tag} AnaLuz", now=at(1))

    assert [s.id for s in repository.list_all(admin_query(q=f"{tag} Ana\\Luz")).items] == [
        literal.id
    ]


def test_q_is_data_not_sql(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    named(db_session, f"Ana {letters()}")

    hostile = repository.list_all(admin_query(q="x%' OR '1'='1"))
    dropping = repository.list_all(admin_query(q="'; DROP TABLE app.orders; --"))

    assert hostile.items == () and dropping.items == ()
    assert scalar(db_session, "SELECT to_regclass('app.orders') IS NOT NULL")


def test_list_all_without_q_applies_no_text_filter(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    order = named(db_session, f"Ana {letters()}", now=BASE + timedelta(days=3650))

    page = repository.list_all(admin_query(q=None))

    assert page.items[0].id == order.id  # el más reciente de toda la tabla
    assert page.total >= 1


# Fechas de Lima (UTC−5, D-015): 2026-12-02T04:59:59Z es el 1 de diciembre 23:59:59 en Lima y
# 2026-12-02T05:00:00Z es el 2 de diciembre 00:00:00.
LIMA_LAST_SECOND_OF_1_DEC = datetime(2026, 12, 2, 4, 59, 59, tzinfo=UTC)
LIMA_FIRST_SECOND_OF_2_DEC = datetime(2026, 12, 2, 5, 0, 0, tzinfo=UTC)


def test_created_from_and_created_to_use_lima_dates_and_are_both_inclusive(
    db_session: Session,
) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    first_day_early = named(db_session, f"{tag} A", now=datetime(2026, 12, 1, 5, 0, tzinfo=UTC))
    first_day_late = named(db_session, f"{tag} B", now=LIMA_LAST_SECOND_OF_1_DEC)
    second_day = named(db_session, f"{tag} C", now=LIMA_FIRST_SECOND_OF_2_DEC)
    before = named(db_session, f"{tag} D", now=datetime(2026, 12, 1, 4, 59, 59, tzinfo=UTC))

    def ids(**kw: Any) -> set[Any]:
        return {s.id for s in repository.list_all(admin_query(q=tag, **kw)).items}

    dec_1, dec_2 = date(2026, 12, 1), date(2026, 12, 2)
    assert ids(created_from=dec_1, created_to=dec_1) == {first_day_early.id, first_day_late.id}
    assert ids(created_from=dec_2, created_to=dec_2) == {second_day.id}
    assert ids(created_from=dec_1) == {first_day_early.id, first_day_late.id, second_day.id}
    assert ids(created_to=dec_1) == {first_day_early.id, first_day_late.id, before.id}
    assert ids(created_from=dec_1, created_to=dec_2) == {
        first_day_early.id,
        first_day_late.id,
        second_day.id,
    }
    assert ids(created_from=date(2026, 12, 3)) == set()
    assert before.id not in ids(created_from=dec_1)


def test_list_all_combines_every_filter(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    tag = letters()
    keep = named(db_session, f"{tag} Maria", now=at(0))
    named(db_session, f"{tag} Pedro", now=at(1))  # otro nombre
    repository.apply(keep.id, change(PENDING, PAID, kind=ActorKind.SYSTEM), paid=True)
    other_status = named(db_session, f"{tag} Maria", now=at(2))  # mismo nombre, otro estado

    page = repository.list_all(
        admin_query(
            q=f"{tag} maria",
            status=PAID,
            created_from=date(2026, 12, 1),
            created_to=date(2026, 12, 1),
        )
    )

    assert [s.id for s in page.items] == [keep.id]
    assert other_status.id not in [s.id for s in page.items]


def test_the_listing_functions_do_not_modify_anything(db_session: Session) -> None:
    # Materializar los vencidos es de otro paso (expire_overdue): listar solo lee.
    repository = SqlOrderRepository(db_session)
    order = stored_order(db_session, now=BASE - timedelta(days=2))  # vencido hace dos días

    repository.list_for_user(order.user_id, statuses=None, page=1, page_size=20)
    repository.list_all(admin_query(q=order.delivery.recipient_name))

    assert scalar(db_session, "SELECT status FROM app.orders WHERE id = :id", id=order.id) == (
        "pendiente_pago"
    )


def test_a_pickup_order_also_appears_in_the_administration_list(db_session: Session) -> None:
    repository = SqlOrderRepository(db_session)
    name = f"Recojo {letters()}"
    order = stored_order(db_session, delivery=pickup_delivery(recipient_name=name))

    (summary,) = repository.list_all(admin_query(q=name)).items

    assert summary.id == order.id and summary.district is None
