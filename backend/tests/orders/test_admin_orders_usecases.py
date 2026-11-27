"""`ListAdminOrders` y `GetAdminOrder` con repositorio, reservas, auditoría y reloj falsos (T-078;
CA-ORDERS-13, 16, 17 y 22; SPEC §3 UC-07, 08 y 05, §4 R7, R12 y R17). Sin BD. Lo que importa es lo
que hacen los casos de uso: materializar los vencidos de **cualquier** cliente antes de leer (hasta
200), no filtrar por dueño, pasar la consulta tal cual y no escribir nada más. Datos ficticios."""

from dataclasses import dataclass
from datetime import timedelta
from inspect import signature
from uuid import UUID, uuid4

import pytest

from tests.orders.orders_create_helpers import NOW, Calls, FakeAudit, FakeClock
from tests.orders.test_my_orders_usecases import (
    EXPIRED,
    PAID,
    PENDING,
    Release,
    Repository,
    an_order,
    overdue,
    summary,
)
from valmont.modules.orders.application import (
    AdminOrderQuery,
    ExpireOverdueOrders,
    GetAdminOrder,
    ListAdminOrders,
    OrderPage,
)
from valmont.modules.orders.domain import Order, OrderNotFound

ANA, LUIS = uuid4(), uuid4()


def query(**changes: object) -> AdminOrderQuery:
    values: dict[str, object] = {
        "status": None,
        "q": None,
        "created_from": None,
        "created_to": None,
        "page": 1,
        "page_size": 20,
    }
    return AdminOrderQuery(**{**values, **changes})  # type: ignore[arg-type]


@dataclass
class AdminRepository(Repository):
    """Lo del repositorio de T-075 más `list_all`: estado actual de cada pedido, sin filtrar por
    dueño, y registro de la consulta recibida."""

    list_all_queries: list[AdminOrderQuery] | None = None

    def list_all(self, q: AdminOrderQuery) -> OrderPage:
        self.calls.append("list_all")
        self.list_all_queries = [*(self.list_all_queries or []), q]
        found = [o for o in self.orders.values() if q.status is None or o.status == q.status]
        found.sort(key=lambda o: (o.created_at, o.id), reverse=True)
        start = (q.page - 1) * q.page_size
        return OrderPage(
            tuple(summary(o) for o in found[start : start + q.page_size]),
            len(found),
            q.page,
            q.page_size,
        )


@dataclass
class World:
    calls: Calls
    repository: AdminRepository
    release: Release
    audit: FakeAudit
    list_all: ListAdminOrders
    get_one: GetAdminOrder


def world(*orders: Order) -> World:
    calls = Calls()
    repository = AdminRepository(calls)
    repository.add(*orders)
    release, audit, clock = Release(calls), FakeAudit(calls), FakeClock(calls)
    expire = ExpireOverdueOrders(repository, release, audit, clock)  # type: ignore[arg-type]
    return World(
        calls,
        repository,
        release,
        audit,
        ListAdminOrders(repository, expire),  # type: ignore[arg-type]
        GetAdminOrder(repository, expire),  # type: ignore[arg-type]
    )


def ids(page: OrderPage) -> set[UUID]:
    return {item.id for item in page.items}


# --------------------------------------------------------------------------------------------
# ListAdminOrders (UC-07, R7, R17; CA-ORDERS-13, 16)
def test_the_list_returns_the_orders_of_every_customer() -> None:
    a, b = an_order(ANA, status=PAID), an_order(LUIS, status=PAID)
    w = world(a, b)

    page = w.list_all(query())

    assert ids(page) == {a.id, b.id} and page.total == 2
    assert {item.user_id for item in page.items} == {ANA, LUIS}


def test_the_query_reaches_the_repository_unchanged() -> None:
    w = world(an_order(ANA, status=PAID))
    wanted = query(status=PAID, q="VAL-000123", page=3, page_size=7)

    w.list_all(wanted)

    assert w.repository.list_all_queries == [wanted]


def test_the_page_comes_back_exactly_as_the_repository_built_it() -> None:
    w = world(*(an_order(ANA, status=PAID, number=n, age_minutes=40 + n) for n in range(1, 4)))

    page = w.list_all(query(page=2, page_size=2))

    assert (page.page, page.page_size, page.total, len(page.items)) == (2, 2, 3, 1)


def test_overdue_orders_of_any_customer_are_materialized_before_the_page_is_read() -> None:
    mine, theirs = overdue(ANA), overdue(LUIS)
    w = world(mine, theirs)

    page = w.list_all(query())

    assert w.calls.index("expire") < w.calls.index("list_all")
    assert {item.status for item in page.items} == {EXPIRED}
    assert w.repository.orders[mine.id].status == EXPIRED
    assert w.repository.orders[theirs.id].status == EXPIRED


def test_the_expiry_is_asked_for_all_customers_with_the_limit_of_200() -> None:
    w = world(overdue(ANA))

    w.list_all(query())

    [args] = w.repository.expire_args
    assert args["user_id"] is None and args["order_ids"] is None and args["limit"] == 200
    assert args["now"] == NOW


def test_an_order_expired_by_the_read_shows_up_under_the_expired_filter() -> None:
    order = overdue(ANA)
    w = world(order)

    expired = w.list_all(query(status=EXPIRED))
    pending = w.list_all(query(status=PENDING))

    assert ids(expired) == {order.id}
    assert ids(pending) == set()


def test_each_materialized_order_is_released_and_audited_once_without_actor() -> None:
    a, b, fresh = overdue(ANA), overdue(LUIS), an_order(ANA, age_minutes=5)
    w = world(a, b, fresh)

    w.list_all(query())

    assert sorted(w.release.released) == sorted([a.id, b.id])
    assert sorted(e.entity_id for e in w.audit.entries) == sorted([str(a.id), str(b.id)])
    for entry in w.audit.entries:
        assert entry.action == "orders.status_changed"
        assert entry.actor_id is None and entry.actor_role is None
        assert entry.before == {"status": "pendiente_pago"} and entry.after == {
            "status": "expirado"
        }
    assert w.repository.orders[fresh.id].status == PENDING


def test_reading_again_does_not_duplicate_release_audit_or_history() -> None:
    order = overdue(ANA)
    w = world(order)

    w.list_all(query())
    w.list_all(query())
    w.list_all(query())

    assert w.release.released == [order.id] and len(w.audit.entries) == 1
    history = w.repository.orders[order.id].history
    assert [h.to_status for h in history].count(EXPIRED) == 1


def test_a_paid_or_cancelled_order_is_never_touched_by_the_read() -> None:
    old_paid = overdue(ANA, status=PAID)
    w = world(old_paid)

    w.list_all(query())

    assert w.repository.orders[old_paid.id].status == PAID
    assert w.release.released == [] and w.audit.entries == []


def test_with_more_than_200_overdue_one_read_materializes_200_and_the_next_the_rest() -> None:
    orders = [overdue(ANA if n % 2 else LUIS) for n in range(201)]
    w = world(*orders)

    w.list_all(query())
    after_first = sum(o.status == EXPIRED for o in w.repository.orders.values())
    w.list_all(query())
    after_second = sum(o.status == EXPIRED for o in w.repository.orders.values())

    assert (after_first, after_second) == (200, 201)
    assert len(w.audit.entries) == 201 and len(set(w.release.released)) == 201


def test_the_instant_of_expiry_is_overdue_for_the_admin_read_too() -> None:
    at_limit = an_order(ANA, created_at=NOW - timedelta(minutes=30))  # expires_at == now
    one_left = an_order(ANA, created_at=NOW - timedelta(minutes=30) + timedelta(seconds=1))
    w = world(at_limit, one_left)

    w.list_all(query())

    assert w.repository.orders[at_limit.id].status == EXPIRED
    assert w.repository.orders[one_left.id].status == PENDING


def test_the_list_writes_nothing_when_nothing_is_overdue() -> None:
    w = world(an_order(ANA, status=PAID), an_order(LUIS, age_minutes=5))

    w.list_all(query())

    assert w.release.released == [] and w.audit.entries == []
    assert w.calls.count("release") == 0 and w.calls.count("audit") == 0


# --------------------------------------------------------------------------------------------
# GetAdminOrder (UC-08, R7; CA-ORDERS-13, 17, 22)
@pytest.mark.parametrize("owner", [ANA, LUIS, uuid4()])
def test_the_admin_gets_the_order_of_any_customer(owner: UUID) -> None:
    order = an_order(owner, status=PAID)
    w = world(order)

    got = w.get_one(order.id)

    assert got.id == order.id and got.user_id == owner


def test_the_repository_is_asked_without_an_owner_filter() -> None:
    order = an_order(ANA, status=PAID)
    w = world(order)

    w.get_one(order.id)

    [(asked_id, asked_user, _lock)] = w.repository.get_args
    assert asked_id == order.id and asked_user is None


def test_an_unknown_order_is_order_not_found() -> None:
    w = world(an_order(ANA, status=PAID))

    with pytest.raises(OrderNotFound):
        w.get_one(uuid4())


def test_the_expiry_runs_for_that_order_only_and_before_the_read() -> None:
    target, other = overdue(ANA), overdue(LUIS)
    w = world(target, other)

    got = w.get_one(target.id)

    assert got.status == EXPIRED
    assert w.calls.index("expire") < w.calls.index("get")
    [args] = w.repository.expire_args
    assert args["user_id"] is None and list(args["order_ids"] or []) == [target.id]  # type: ignore[arg-type]
    assert w.repository.orders[other.id].status == PENDING  # la de otro pedido no se toca
    assert w.release.released == [target.id] and len(w.audit.entries) == 1


def test_the_expired_detail_carries_one_system_entry_and_reading_again_adds_none() -> None:
    order = overdue(ANA)
    w = world(order)

    first = w.get_one(order.id)
    second = w.get_one(order.id)

    assert [h.to_status for h in first.history].count(EXPIRED) == 1
    assert [h.to_status for h in second.history].count(EXPIRED) == 1
    system = [h for h in second.history if h.to_status == EXPIRED]
    assert system[0].actor_id is None and system[0].actor_kind.value == "system"
    assert w.release.released == [order.id] and len(w.audit.entries) == 1


def test_a_vigente_pending_order_is_returned_as_is() -> None:
    order = an_order(ANA, age_minutes=5)
    w = world(order)

    got = w.get_one(order.id)

    assert got.status == PENDING and w.release.released == [] and w.audit.entries == []


def test_a_missing_order_expires_nothing() -> None:
    bystander = overdue(LUIS)
    w = world(bystander)

    with pytest.raises(OrderNotFound):
        w.get_one(uuid4())

    assert w.repository.orders[bystander.id].status == PENDING and w.audit.entries == []


def test_the_admin_use_cases_do_not_need_an_actor_or_a_customer() -> None:
    # Firmas de §7: la consulta y el id; sin `user_id` (el administrador ve todos).
    assert list(signature(ListAdminOrders.__call__).parameters) == ["self", "query"]
    assert list(signature(GetAdminOrder.__call__).parameters) == ["self", "order_id"]
    assert list(signature(ListAdminOrders.__init__).parameters) == ["self", "orders", "expire"]
    assert list(signature(GetAdminOrder.__init__).parameters) == ["self", "orders", "expire"]
