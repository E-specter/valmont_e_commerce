"""`ExpireOverdueOrders`, `ListMyOrders` y `GetMyOrder` con repositorio, reservas, auditoría y reloj
falsos (T-075; CA-ORDERS-10, 11, 13, 21 y 22; SPEC §3 UC-02, 03 y 05, §4 R6, R7, R11, R12 y R17).
Sin BD. El repositorio falso respeta lo que el real promete (dueño, `expires_at ≤ now`, límite, un
historial `system` por fila cambiada); lo que importa aquí es lo que hace el caso de uso con él:
materializar antes de leer, solo lo que lee, liberar y auditar una vez por pedido cambiado, y que
ajeno e inexistente sean el mismo `OrderNotFound`. Datos ficticios."""

from collections.abc import Collection
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest

from tests.orders.orders_create_helpers import NOW, Calls, FakeAudit, FakeClock
from tests.orders.orders_helpers import make_line, pickup_delivery, shipping_delivery
from valmont.modules.orders.application import (
    ExpireOverdueOrders,
    GetMyOrder,
    ListMyOrders,
    OrderPage,
    OrderSummary,
)
from valmont.modules.orders.domain import (
    ActorKind,
    Order,
    OrderNotFound,
    OrderStatus,
    StatusChange,
    build_order,
)

PENDING, PAID, CANCELLED, EXPIRED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
)
ME, OTHER = uuid4(), uuid4()


def an_order(
    user: UUID = ME,
    *,
    status: OrderStatus = PENDING,
    age_minutes: int = 5,
    created_at: datetime | None = None,
    number: int = 1,
    quantities: tuple[int, ...] = (1,),
    delivery_pickup: bool = False,
) -> Order:
    """Pedido creado hace `age_minutes` respecto a `NOW`: vence a los 30 minutos."""
    lines = [make_line(quantity=q) for q in quantities]
    delivery = pickup_delivery() if delivery_pickup else shipping_delivery()
    built = build_order(
        uuid4(),
        user,
        f"clave-{uuid4().hex}",
        lines,
        delivery,
        created_at or NOW - timedelta(minutes=age_minutes),
    )
    paid_at = NOW - timedelta(minutes=1) if status not in (PENDING, CANCELLED, EXPIRED) else None
    return replace(built, number=number, status=status, paid_at=paid_at)


def overdue(user: UUID = ME, **kwargs: object) -> Order:
    return an_order(user, age_minutes=31, **kwargs)  # type: ignore[arg-type]


@dataclass
class Repository:
    """Lo que `ExpireOverdueOrders`, `ListMyOrders` y `GetMyOrder` piden al repositorio."""

    calls: Calls
    orders: dict[UUID, Order] = field(default_factory=dict)
    expire_args: list[dict[str, object]] = field(default_factory=list)
    list_args: list[dict[str, object]] = field(default_factory=list)
    get_args: list[tuple[UUID, UUID | None, bool]] = field(default_factory=list)

    def add(self, *orders: Order) -> None:
        self.orders.update({o.id: o for o in orders})

    def expire_overdue(
        self,
        now: datetime,
        *,
        user_id: UUID | None = None,
        order_ids: Collection[UUID] | None = None,
        limit: int = 200,
    ) -> list[Order]:
        self.calls.append("expire")
        self.expire_args.append(
            {"now": now, "user_id": user_id, "order_ids": order_ids, "limit": limit}
        )
        picked = sorted(
            (
                o
                for o in self.orders.values()
                if o.status == PENDING
                and o.expires_at <= now
                and (user_id is None or o.user_id == user_id)
                and (order_ids is None or o.id in order_ids)
            ),
            key=lambda o: o.id,
        )[:limit]
        changed = StatusChange(PENDING, EXPIRED, ActorKind.SYSTEM, None, None, now)
        done = [replace(o, status=EXPIRED, history=(*o.history, changed)) for o in picked]
        self.add(*done)
        return done

    def get(
        self, order_id: UUID, *, user_id: UUID | None = None, lock: bool = False
    ) -> Order | None:
        self.calls.append("get")
        self.get_args.append((order_id, user_id, lock))
        order = self.orders.get(order_id)
        if order is None or (user_id is not None and order.user_id != user_id):
            return None
        return order

    def list_for_user(
        self,
        user_id: UUID,
        *,
        statuses: Collection[OrderStatus] | None,
        page: int,
        page_size: int,
    ) -> OrderPage:
        self.calls.append("list")
        self.list_args.append(
            {"user_id": user_id, "statuses": statuses, "page": page, "page_size": page_size}
        )
        mine = [
            o
            for o in self.orders.values()
            if o.user_id == user_id and (statuses is None or o.status in statuses)
        ]
        mine.sort(key=lambda o: (o.created_at, o.id), reverse=True)
        start = (page - 1) * page_size
        return OrderPage(
            tuple(summary(o) for o in mine[start : start + page_size]),
            len(mine),
            page,
            page_size,
        )


def summary(order: Order) -> OrderSummary:
    return OrderSummary(
        order.id,
        order.number or 0,
        order.user_id,
        order.status,
        order.total_amount,
        sum(line.quantity for line in order.lines),
        order.created_at,
        order.expires_at,
        order.estimated_delivery_on,
        order.delivery.recipient_name,
        order.delivery.district,
    )


@dataclass
class Release:
    calls: Calls
    released: list[UUID] = field(default_factory=list)

    def __call__(self, order_id: UUID) -> None:
        self.calls.append("release")
        self.released.append(order_id)


@dataclass
class World:
    calls: Calls
    repository: Repository
    release: Release
    audit: FakeAudit
    clock: FakeClock
    expire: ExpireOverdueOrders
    list_mine: ListMyOrders
    get_mine: GetMyOrder


def world(*orders: Order) -> World:
    calls = Calls()
    repository = Repository(calls)
    repository.add(*orders)
    release, audit, clock = Release(calls), FakeAudit(calls), FakeClock(calls)
    expire = ExpireOverdueOrders(repository, release, audit, clock)  # type: ignore[arg-type]
    return World(
        calls,
        repository,
        release,
        audit,
        clock,
        expire,
        ListMyOrders(repository, expire),  # type: ignore[arg-type]
        GetMyOrder(repository, expire),  # type: ignore[arg-type]
    )


def status_of(w: World, order: Order) -> OrderStatus:
    return w.repository.orders[order.id].status


# --------------------------------------------------------------------------------------------
# ExpireOverdueOrders (UC-05, R7, CA-ORDERS-13, 21)
def test_an_overdue_order_is_expired_released_and_audited_without_actor() -> None:
    order = overdue()
    w = world(order)

    expired = w.expire(user_id=ME)

    assert [o.id for o in expired] == [order.id] and expired[0].status == EXPIRED
    assert w.release.released == [order.id]
    [entry] = w.audit.entries
    assert entry.action == "orders.status_changed" and entry.entity_type == "order"
    assert entry.entity_id == str(order.id)
    assert entry.actor_id is None and entry.actor_role is None  # sistema (AUDIT-R5)
    assert entry.before == {"status": "pendiente_pago"}
    assert entry.after == {"status": "expirado"}


def test_the_expiry_asks_the_repository_with_the_clock_now() -> None:
    w = world(overdue())

    w.expire(user_id=ME)

    assert [a["now"] for a in w.repository.expire_args] == [NOW]
    assert w.calls.count("clock") == 1


def test_the_expiry_passes_owner_ids_and_limit_to_the_repository() -> None:
    w = world()
    ids = [uuid4(), uuid4()]

    w.expire(user_id=ME, order_ids=ids, limit=7)
    w.expire()

    first, second = w.repository.expire_args
    assert (first["user_id"], list(first["order_ids"]), first["limit"]) == (ME, ids, 7)  # type: ignore[arg-type]
    assert (second["user_id"], second["order_ids"], second["limit"]) == (None, None, 200)


def test_nothing_is_released_or_audited_when_nothing_changed() -> None:
    fresh, paid = an_order(age_minutes=5), overdue(status=PAID)
    w = world(fresh, paid)

    assert w.expire(user_id=ME) == []

    assert w.release.released == [] and w.audit.entries == []
    assert status_of(w, fresh) == PENDING and status_of(w, paid) == PAID


def test_the_limit_leaves_the_rest_for_the_next_read() -> None:
    orders = [overdue() for _ in range(3)]
    w = world(*orders)

    first = w.expire(user_id=ME, limit=2)
    second = w.expire(user_id=ME, limit=2)
    third = w.expire(user_id=ME, limit=2)

    assert (len(first), len(second), len(third)) == (2, 1, 0)
    assert sorted(w.release.released) == sorted(o.id for o in orders)
    assert len(w.audit.entries) == 3  # una sola vez por pedido


def test_repeating_the_expiry_does_not_duplicate_release_or_audit() -> None:
    order = overdue()
    w = world(order)

    w.expire(user_id=ME)
    again = w.expire(user_id=ME)

    assert again == []
    assert w.release.released == [order.id] and len(w.audit.entries) == 1
    history = w.repository.orders[order.id].history
    assert [h.to_status for h in history].count(EXPIRED) == 1


def test_every_changed_order_is_released_and_audited_once_each() -> None:
    a, b = overdue(), overdue()
    w = world(a, b, overdue(OTHER))

    w.expire(user_id=ME)

    assert sorted(w.release.released) == sorted([a.id, b.id])
    assert sorted(e.entity_id for e in w.audit.entries) == sorted([str(a.id), str(b.id)])


def test_the_exact_expiry_instant_is_overdue_and_one_second_before_is_not() -> None:
    at_limit = an_order(created_at=NOW - timedelta(minutes=30))  # expires_at == NOW
    one_second_left = an_order(created_at=NOW - timedelta(minutes=30) + timedelta(seconds=1))
    w = world(at_limit, one_second_left)

    expired = w.expire(user_id=ME)

    assert [o.id for o in expired] == [at_limit.id]
    assert status_of(w, one_second_left) == PENDING


def test_only_a_pending_order_expires() -> None:
    others = [overdue(status=s) for s in OrderStatus if s != PENDING]
    w = world(*others)

    assert w.expire() == [] and w.release.released == [] and w.audit.entries == []


def test_the_audit_of_an_expiry_has_no_personal_data() -> None:
    w = world(overdue())

    w.expire(user_id=ME)

    dump = repr(w.audit.entries)
    for personal in ("Ana", "Pérez", "987654321", "Larco", "Miraflores"):
        assert personal not in dump, personal


# --------------------------------------------------------------------------------------------
# GetMyOrder (UC-03, R7, R12; CA-ORDERS-11, 13, 22)
def test_get_my_order_returns_the_own_order() -> None:
    order = an_order()
    w = world(order)

    assert w.get_mine(ME, order.id).id == order.id


def test_get_my_order_materializes_the_expiry_before_reading() -> None:
    order = overdue()
    w = world(order)

    seen = w.get_mine(ME, order.id)

    assert seen.status == EXPIRED
    assert seen.history[-1].actor_kind == ActorKind.SYSTEM and seen.history[-1].actor_id is None
    assert w.release.released == [order.id] and len(w.audit.entries) == 1
    assert w.calls.index("expire") < w.calls.index("get")


def test_get_my_order_reads_only_the_owner_filtered_row() -> None:
    order = an_order()
    w = world(order)

    w.get_mine(ME, order.id)

    assert w.repository.get_args == [(order.id, ME, False)]  # filtra por dueño; sin bloqueo


def test_get_my_order_expires_only_the_order_it_reads() -> None:
    read, sibling, theirs = overdue(), overdue(), overdue(OTHER)
    w = world(read, sibling, theirs)

    w.get_mine(ME, read.id)

    assert status_of(w, read) == EXPIRED
    assert status_of(w, sibling) == PENDING  # mía y vencida, pero no la leí
    assert status_of(w, theirs) == PENDING
    assert w.release.released == [read.id]


def test_a_foreign_order_is_not_found() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.get_mine(ME, theirs.id)


def test_a_missing_order_is_not_found() -> None:
    w = world(an_order())

    with pytest.raises(OrderNotFound):
        w.get_mine(ME, uuid4())


def test_foreign_and_missing_raise_the_very_same_error() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    errors = []
    for order_id in (theirs.id, uuid4()):
        with pytest.raises(OrderNotFound) as caught:
            w.get_mine(ME, order_id)
        errors.append((type(caught.value), caught.value.args))

    assert errors[0] == errors[1]


def test_a_foreign_overdue_order_is_not_expired_by_a_probe() -> None:
    # Quien pregunta por un pedido que no es suyo no cambia nada de él: el pedido no se "leyó".
    theirs = overdue(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.get_mine(ME, theirs.id)

    assert status_of(w, theirs) == PENDING
    assert w.release.released == [] and w.audit.entries == []


def test_reading_the_same_overdue_order_twice_does_not_duplicate_anything() -> None:
    order = overdue()
    w = world(order)

    first = w.get_mine(ME, order.id)
    second = w.get_mine(ME, order.id)

    assert first.status == second.status == EXPIRED
    assert len(second.history) == len(first.history)
    assert w.release.released == [order.id] and len(w.audit.entries) == 1


@pytest.mark.parametrize("status", [s for s in OrderStatus if s != PENDING])
def test_an_order_that_is_not_pending_is_never_changed_by_a_read(status: OrderStatus) -> None:
    order = overdue(status=status)
    w = world(order)

    assert w.get_mine(ME, order.id).status == status
    assert w.release.released == [] and w.audit.entries == []


def test_a_pending_order_still_in_its_window_is_returned_unchanged() -> None:
    order = an_order(age_minutes=29)
    w = world(order)

    assert w.get_mine(ME, order.id).status == PENDING
    assert w.release.released == [] and w.audit.entries == []


# --------------------------------------------------------------------------------------------
# ListMyOrders (UC-02, R7, R17; CA-ORDERS-10, 13, 22; D-041 P-6)
def page_of(
    w: World, *, statuses: frozenset[OrderStatus] | None = None, **paging: int
) -> OrderPage:
    return w.list_mine(ME, statuses=statuses, **({"page": 1, "page_size": 20} | paging))


def test_list_returns_only_the_own_orders_newest_first() -> None:
    old = an_order(created_at=NOW - timedelta(hours=3))
    new = an_order(created_at=NOW - timedelta(minutes=1))
    middle = an_order(status=PAID, created_at=NOW - timedelta(hours=1))
    w = world(old, new, middle, an_order(OTHER), an_order(OTHER, status=PAID))

    page = page_of(w)

    assert [s.id for s in page.items] == [new.id, middle.id, old.id]
    assert (page.total, page.page, page.page_size) == (3, 1, 20)
    assert all(s.user_id == ME for s in page.items)


def test_list_orders_a_tie_on_created_at_by_id_descending() -> None:
    same = NOW - timedelta(minutes=1)
    twins = [an_order(created_at=same) for _ in range(4)]
    w = world(*twins)

    page = page_of(w)

    assert [s.id for s in page.items] == sorted((o.id for o in twins), reverse=True)


def test_list_paginates_with_the_real_total_and_an_empty_page_past_the_end() -> None:
    orders = [an_order(created_at=NOW - timedelta(minutes=n)) for n in range(1, 8)]
    w = world(*orders)
    expected = [o.id for o in sorted(orders, key=lambda o: (o.created_at, o.id), reverse=True)]

    pages = [page_of(w, page=p, page_size=3) for p in (1, 2, 3, 4)]

    assert [len(p.items) for p in pages] == [3, 3, 1, 0]
    assert [s.id for p in pages for s in p.items] == expected
    assert all(p.total == 7 for p in pages)
    assert [(p.page, p.page_size) for p in pages] == [(n, 3) for n in (1, 2, 3, 4)]


def test_list_passes_the_user_the_statuses_and_the_paging_to_the_repository() -> None:
    w = world()
    wanted = frozenset({PAID, OrderStatus.PREPARING})

    w.list_mine(ME, statuses=wanted, page=2, page_size=5)
    w.list_mine(ME, statuses=None, page=1, page_size=20)

    first, second = w.repository.list_args
    assert (first["user_id"], first["statuses"], first["page"], first["page_size"]) == (
        ME,
        wanted,
        2,
        5,
    )
    assert second["statuses"] is None  # sin filtro: todos los estados


def test_list_with_several_statuses_keeps_only_those() -> None:
    kept = [an_order(status=PAID), an_order(status=OrderStatus.PREPARING)]
    dropped = [an_order(status=OrderStatus.DELIVERED), an_order(), an_order(status=CANCELLED)]
    w = world(*kept, *dropped)

    page = page_of(w, statuses=frozenset({PAID, OrderStatus.PREPARING}))

    assert sorted(s.id for s in page.items) == sorted(o.id for o in kept)
    assert page.total == 2


def test_list_without_status_returns_every_status() -> None:
    orders = [
        an_order(status=s, created_at=NOW - timedelta(minutes=n))
        for n, s in enumerate(s for s in OrderStatus if s != PENDING)
    ]
    w = world(*orders, an_order())

    assert page_of(w).total == len(OrderStatus)


def test_list_materializes_the_own_overdue_orders_before_reading() -> None:
    mine = overdue()
    w = world(mine, an_order(age_minutes=2))

    page = page_of(w)

    assert w.calls.index("expire") < w.calls.index("list")
    assert {s.id: s.status for s in page.items}[mine.id] == EXPIRED
    assert w.release.released == [mine.id] and len(w.audit.entries) == 1


def test_the_filter_sees_the_real_status_after_the_expiry() -> None:
    mine = overdue()
    w = world(mine)

    assert [s.id for s in page_of(w, statuses=frozenset({EXPIRED})).items] == [mine.id]
    assert page_of(w, statuses=frozenset({PENDING})).items == ()


def test_list_expires_only_the_orders_of_the_reader() -> None:
    mine, theirs = overdue(), overdue(OTHER)
    w = world(mine, theirs)

    page_of(w)

    assert status_of(w, mine) == EXPIRED
    assert status_of(w, theirs) == PENDING
    assert [a["user_id"] for a in w.repository.expire_args] == [ME]
    assert w.release.released == [mine.id]


def test_listing_twice_does_not_duplicate_release_or_audit() -> None:
    w = world(overdue())

    page_of(w)
    page_of(w)

    assert len(w.release.released) == 1 and len(w.audit.entries) == 1


def test_a_customer_without_orders_gets_an_empty_page() -> None:
    w = world(an_order(OTHER))

    page = page_of(w)

    assert (page.items, page.total, page.page, page.page_size) == ((), 0, 1, 20)


def test_the_summary_carries_what_the_page_needs() -> None:
    order = an_order(quantities=(2, 3), number=123)
    w = world(order)

    (item,) = page_of(w).items

    assert (item.number, item.item_count, item.total_amount) == (123, 5, order.total_amount)
    assert item.expires_at == order.expires_at and item.status == PENDING


def test_an_empty_status_set_means_none_and_an_unset_one_means_all() -> None:
    w = world(an_order(), an_order(status=PAID))

    nothing = page_of(w, statuses=frozenset())
    everything = page_of(w, statuses=None)

    assert (nothing.items, nothing.total) == ((), 0)
    assert everything.total == 2
    assert w.repository.list_args[0]["statuses"] == frozenset()  # se entrega tal cual
