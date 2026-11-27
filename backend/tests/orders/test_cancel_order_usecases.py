"""`CancelMyOrder` con repositorio, reservas, auditoría y reloj falsos (T-076; CA-ORDERS-12, 20, 21
y 22; SPEC §3 UC-04, §4 R4, R7, R10, R11 y R12). Sin BD. El repositorio falso respeta lo que el real
promete (dueño en `get`, `apply` compara el estado de origen y añade el historial, vencidos solo
`pendiente_pago` con `expires_at ≤ now`); lo que importa aquí es lo que hace el caso de uso con él:
bloquear el pedido propio antes de decidir, cancelar solo un `pendiente_pago` vigente, liberar y
auditar una sola vez, ser idempotente con un `cancelado`, rechazar el resto sin dejar ningún efecto
y tratar ajeno e inexistente como el mismo `OrderNotFound`. Datos ficticios."""

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest

from tests.orders.orders_create_helpers import NOW, Calls, FakeAudit
from tests.orders.test_my_orders_usecases import (
    CANCELLED,
    EXPIRED,
    ME,
    OTHER,
    PAID,
    PENDING,
    Release,
    Repository,
    an_order,
    overdue,
)
from valmont.modules.orders.application import CancelMyOrder, ExpireOverdueOrders
from valmont.modules.orders.domain import (
    ActorKind,
    InvalidTransition,
    NotCancellable,
    Order,
    OrderNotFound,
    OrderStatus,
    StatusChange,
)

NOT_CANCELLABLE = [
    s for s in OrderStatus if s not in (PENDING, CANCELLED)
]  # pagado… entregado y expirado
PERSONAL = ("Ana", "Pérez", "987654321", "Larco", "Miraflores", "Frente al parque")


class FixedClock:
    """Siempre el mismo instante: así `expires_at == now` es exacto, pase lo que pase."""

    def __init__(self, calls: Calls, at: datetime = NOW) -> None:
        self.calls, self.at = calls, at

    def now(self) -> datetime:
        self.calls.append("clock")
        return self.at


@dataclass
class CancelRepository(Repository):
    """`Repository` de T-075 más `apply` (el cambio de estado que hace el real, con historial)."""

    apply_args: list[tuple[UUID, StatusChange, dict[str, object]]] = field(default_factory=list)

    def apply(self, order_id: UUID, change: StatusChange, **options: object) -> Order:
        self.calls.append("apply")
        self.apply_args.append((order_id, change, options))
        order = self.orders[order_id]
        if change.from_status != order.status:
            raise InvalidTransition(change.from_status, change.to_status, frozenset())  # type: ignore[arg-type]
        done = replace(order, status=change.to_status, history=(*order.history, change))
        self.orders[order_id] = done
        return done


class FailingRelease(Release):
    def __call__(self, order_id: UUID) -> None:
        super().__call__(order_id)
        raise RuntimeError("inventory cayó")


@dataclass
class World:
    calls: Calls
    repository: CancelRepository
    release: Release
    audit: FakeAudit
    cancel: CancelMyOrder

    def stored(self, order: Order) -> Order:
        return self.repository.orders[order.id]

    def snapshot(self) -> dict[UUID, Order]:
        return dict(self.repository.orders)

    def effects(self) -> list[str]:
        return [c for c in self.calls if c in ("apply", "release", "audit")]


def world(*orders: Order, release_type: type[Release] = Release) -> World:
    calls = Calls()
    repository = CancelRepository(calls)
    repository.add(*orders)
    release, audit, clock = release_type(calls), FakeAudit(calls), FixedClock(calls)
    expire = ExpireOverdueOrders(repository, release, audit, clock)  # type: ignore[arg-type]
    cancel = CancelMyOrder(repository, expire, release, audit, clock)  # type: ignore[arg-type]
    return World(calls, repository, release, audit, cancel)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-12: un pendiente_pago propio y vigente se cancela
def test_a_current_pending_order_is_cancelled_released_and_audited() -> None:
    order = an_order()
    w = world(order)

    result = w.cancel(ME, order.id)

    assert result.id == order.id and result.status == CANCELLED
    assert w.stored(order).status == CANCELLED
    assert w.release.released == [order.id]
    assert len(w.audit.entries) == 1


def test_the_cancellation_is_one_customer_history_row_with_the_actor_and_no_note() -> None:
    order = an_order()
    w = world(order)

    result = w.cancel(ME, order.id)

    assert [(c.from_status, c.to_status, c.actor_kind) for c in result.history[1:]] == [
        (PENDING, CANCELLED, ActorKind.CUSTOMER)
    ]
    assert len(result.history) == len(order.history) + 1  # CA-ORDERS-20: exactamente una fila
    [(order_id, change, _)] = w.repository.apply_args
    assert order_id == order.id
    assert change.actor_id == ME and change.note is None  # la nota es del administrador


def test_the_customer_cancellation_does_not_refund_or_mark_paid() -> None:
    order = an_order()
    w = world(order)

    result = w.cancel(ME, order.id)

    [(_, _, options)] = w.repository.apply_args
    assert not options.get("paid") and options.get("refund_amount") is None
    assert result.refunded_amount is None and result.refunded_at is None and result.paid_at is None


def test_the_audit_has_the_customer_as_actor_the_entity_and_before_and_after() -> None:
    order = an_order()
    w = world(order)

    w.cancel(ME, order.id)

    [entry] = w.audit.entries
    assert entry.action == "orders.status_changed"
    assert (entry.entity_type, entry.entity_id) == ("order", str(order.id))
    assert (entry.actor_id, entry.actor_role) == (ME, "customer")  # CA-ORDERS-21: "con actor"
    assert entry.before == {"status": "pendiente_pago"}
    assert entry.after == {"status": "cancelado"}  # sin reembolso: el cliente no lo genera


def test_the_audit_has_no_personal_data_of_the_recipient() -> None:
    w = world(an_order())
    [order] = w.repository.orders.values()

    w.cancel(ME, order.id)

    dump = repr(w.audit.entries)
    for personal in PERSONAL:
        assert personal not in dump, personal


def test_the_order_is_locked_with_the_session_user_before_anything_else() -> None:
    order = an_order()
    w = world(order)

    w.cancel(ME, order.id)

    assert w.calls[0] == "get"  # R4: primero la fila del pedido, luego reservas y stock
    first = w.repository.get_args[0]
    assert first == (order.id, ME, True)  # filtrado por dueño y con FOR UPDATE


def test_the_clock_of_the_cancellation_comes_from_the_injected_clock() -> None:
    order = an_order()
    w = world(order)

    w.cancel(ME, order.id)

    [(_, change, _)] = w.repository.apply_args
    assert change.at == NOW


def test_the_order_is_released_after_the_state_change_not_before_deciding() -> None:
    order = an_order()
    w = world(order)

    w.cancel(ME, order.id)

    assert w.calls.index("apply") < w.calls.index("release")


def test_cancelling_one_order_leaves_the_other_orders_of_the_same_customer_alone() -> None:
    mine, also_mine = an_order(), an_order()
    w = world(mine, also_mine)

    w.cancel(ME, mine.id)

    assert w.stored(also_mine).status == PENDING and w.release.released == [mine.id]


def test_a_current_order_one_second_before_the_limit_is_cancellable() -> None:
    order = an_order(created_at=NOW - timedelta(minutes=30) + timedelta(seconds=1))
    w = world(order)

    assert w.cancel(ME, order.id).status == CANCELLED


@pytest.mark.parametrize("delivery_pickup", [False, True], ids=["shipping", "pickup"])
def test_both_delivery_methods_cancel_the_same_way(delivery_pickup: bool) -> None:
    order = an_order(delivery_pickup=delivery_pickup)
    w = world(order)

    assert w.cancel(ME, order.id).status == CANCELLED
    assert w.release.released == [order.id]


def test_a_multi_line_order_is_released_once_as_a_whole() -> None:
    order = an_order(quantities=(1, 2, 3))
    w = world(order)

    w.cancel(ME, order.id)

    assert w.release.released == [order.id]  # inventory libera todas las reservas del pedido


# --------------------------------------------------------------------------------------------
# CA-ORDERS-12: idempotencia (R10: ya cancelado → 200 sin cambios)
def test_cancelling_an_already_cancelled_order_returns_it_unchanged() -> None:
    order = an_order(status=CANCELLED)
    w = world(order)
    before = w.snapshot()

    result = w.cancel(ME, order.id)

    assert result.status == CANCELLED and result.id == order.id
    assert w.snapshot() == before
    assert w.effects() == []  # ni cambio de estado, ni liberación, ni auditoría


def test_cancelling_twice_does_not_duplicate_history_release_or_audit() -> None:
    order = an_order()
    w = world(order)

    first = w.cancel(ME, order.id)
    second = w.cancel(ME, order.id)

    assert first.status == second.status == CANCELLED
    assert second == first  # misma respuesta
    history = w.stored(order).history
    assert [h.to_status for h in history].count(CANCELLED) == 1
    assert len(w.repository.apply_args) == 1
    assert w.release.released == [order.id] and len(w.audit.entries) == 1


def test_many_repetitions_still_leave_one_history_row_one_release_and_one_audit() -> None:
    order = an_order()
    w = world(order)

    for _ in range(5):
        assert w.cancel(ME, order.id).status == CANCELLED

    assert len(w.stored(order).history) == len(order.history) + 1
    assert w.release.released == [order.id] and len(w.audit.entries) == 1


# --------------------------------------------------------------------------------------------
# CA-ORDERS-12: cualquier otro estado → NotCancellable(status), sin ningún cambio
@pytest.mark.parametrize("status", NOT_CANCELLABLE, ids=lambda s: s.value)
def test_every_other_state_is_not_cancellable_with_its_status(status: OrderStatus) -> None:
    order = an_order(status=status, age_minutes=60 if status == EXPIRED else 5)
    w = world(order)

    with pytest.raises(NotCancellable) as error:
        w.cancel(ME, order.id)

    assert error.value.status == status


@pytest.mark.parametrize("status", NOT_CANCELLABLE, ids=lambda s: s.value)
def test_a_rejected_cancellation_leaves_no_effect_at_all(status: OrderStatus) -> None:
    order = an_order(status=status, age_minutes=60 if status == EXPIRED else 5)
    w = world(order)
    before = w.snapshot()

    with pytest.raises(NotCancellable):
        w.cancel(ME, order.id)

    assert w.snapshot() == before
    assert w.effects() == []  # ni apply, ni liberación, ni auditoría
    assert w.release.released == [] and w.audit.entries == []


def test_a_paid_order_keeps_its_paid_at_and_history_after_the_rejection() -> None:
    order = an_order(status=PAID)
    w = world(order)

    with pytest.raises(NotCancellable):
        w.cancel(ME, order.id)

    kept = w.stored(order)
    assert kept.paid_at == order.paid_at and kept.history == order.history


# --------------------------------------------------------------------------------------------
# R7: un vencido no se cancela (decisión del Leader: 409 con `expirado`)
def test_an_overdue_pending_order_is_not_cancellable_and_reports_expired() -> None:
    order = overdue()
    w = world(order)

    with pytest.raises(NotCancellable) as error:
        w.cancel(ME, order.id)

    assert error.value.status == EXPIRED


def test_an_overdue_pending_order_is_never_cancelled() -> None:
    order = overdue()
    w = world(order)

    with pytest.raises(NotCancellable):
        w.cancel(ME, order.id)

    assert w.stored(order).status != CANCELLED
    assert not any(c.to_status == CANCELLED for c in w.stored(order).history)
    assert not any(c[1].to_status == CANCELLED for c in w.repository.apply_args)
    assert all(e.actor_role != "customer" for e in w.audit.entries)  # nada atribuido al cliente


def test_the_overdue_order_is_not_released_as_a_cancellation() -> None:
    order = overdue()
    w = world(order)

    with pytest.raises(NotCancellable):
        w.cancel(ME, order.id)

    # Si se materializó la caducidad (R7), es la del sistema; nunca una cancelación del cliente.
    for entry in w.audit.entries:
        assert entry.after == {"status": "expirado"} and entry.actor_id is None


def test_the_exact_expiry_instant_is_overdue_for_the_cancellation_too() -> None:
    order = an_order(created_at=NOW - timedelta(minutes=30))  # expires_at == NOW
    w = world(order)

    with pytest.raises(NotCancellable) as error:
        w.cancel(ME, order.id)

    assert error.value.status == EXPIRED and w.stored(order).status != CANCELLED


def test_an_overdue_order_of_someone_else_is_not_expired_by_my_attempt() -> None:
    theirs = overdue(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.cancel(ME, theirs.id)

    assert w.stored(theirs).status == PENDING  # el intento ajeno no materializa nada
    assert w.effects() == []


# --------------------------------------------------------------------------------------------
# CA-ORDERS-22 / R12: ajeno = inexistente
def test_a_foreign_order_is_order_not_found() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.cancel(ME, theirs.id)


def test_a_missing_order_is_order_not_found() -> None:
    w = world(an_order())

    with pytest.raises(OrderNotFound):
        w.cancel(ME, uuid4())


def test_foreign_and_missing_raise_the_same_error_with_the_same_message() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound) as foreign:
        w.cancel(ME, theirs.id)
    with pytest.raises(OrderNotFound) as missing:
        w.cancel(ME, uuid4())

    assert type(foreign.value) is type(missing.value)
    assert str(foreign.value) == str(missing.value)
    assert str(theirs.id) not in str(foreign.value) and str(OTHER) not in str(foreign.value)


@pytest.mark.parametrize("status", list(OrderStatus), ids=lambda s: s.value)
def test_a_foreign_order_in_any_state_changes_nothing(status: OrderStatus) -> None:
    theirs = an_order(OTHER, status=status)
    w = world(theirs, an_order())
    before = w.snapshot()

    with pytest.raises(OrderNotFound):
        w.cancel(ME, theirs.id)

    assert w.snapshot() == before and w.effects() == []


def test_the_lookup_is_always_filtered_by_the_user_of_the_session() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.cancel(ME, theirs.id)

    assert all(user == ME for _, user, _ in w.repository.get_args)  # nunca un get sin dueño


def test_each_customer_cancels_only_their_own_order() -> None:
    mine, theirs = an_order(ME), an_order(OTHER)
    w = world(mine, theirs)

    w.cancel(OTHER, theirs.id)
    with pytest.raises(OrderNotFound):
        w.cancel(OTHER, mine.id)

    assert w.stored(theirs).status == CANCELLED and w.stored(mine).status == PENDING
    assert w.release.released == [theirs.id]


# --------------------------------------------------------------------------------------------
# Un fallo de inventory o de auditoría no se traga: la transacción debe deshacerse entera
def test_a_failing_release_propagates_so_the_transaction_is_rolled_back() -> None:
    order = an_order()
    w = world(order, release_type=FailingRelease)

    with pytest.raises(RuntimeError, match="inventory"):
        w.cancel(ME, order.id)


def test_a_failing_audit_propagates_so_the_transaction_is_rolled_back() -> None:
    order = an_order()
    w = world(order)

    def boom(entry: object) -> None:
        raise RuntimeError("auditoría caída")

    w.audit.record = boom  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="auditoría"):
        w.cancel(ME, order.id)
