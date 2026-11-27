"""`GetPayableOrder` y `ConfirmOrderPayment` con repositorio, reservas, auditoría y reloj falsos
(T-077; CA-ORDERS-14, 15, 20, 21 y 22; SPEC §3 UC-06, §4 R4, R6, R7, R11, R16 y R18). Sin BD. El
repositorio falso respeta lo que el real promete (dueño en `get`, `apply` compara el estado de
origen, añade el historial y fija `paid_at` si `paid=True`); lo que importa aquí es lo que hace el
caso de uso con él: bloquear el pedido propio antes de decidir, consumir las reservas ANTES de
cambiar el estado, pagar solo un `pendiente_pago` vigente, ser idempotente con un pagado o
posterior, expirar (sin relanzar) si el consumo o el reloj lo dicen, y no dejar ningún efecto tras
un rechazo. Datos ficticios."""

import dataclasses
import inspect
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest

from tests.orders.orders_create_helpers import NOW, Calls, FakeAudit
from tests.orders.test_cancel_order_usecases import CancelRepository, FixedClock
from tests.orders.test_my_orders_usecases import (
    CANCELLED,
    EXPIRED,
    ME,
    OTHER,
    PAID,
    PENDING,
    Release,
    an_order,
    overdue,
)
from valmont.modules.inventory.application import ReservationExpired
from valmont.modules.orders.application import (
    ConfirmOrderPayment,
    ExpireOverdueOrders,
    GetPayableOrder,
    PayableOrder,
    PaymentOutcome,
)
from valmont.modules.orders.domain import (
    PAID_STATUSES,
    ActorKind,
    Order,
    OrderNotFound,
    OrderNotPayable,
    OrderStatus,
    format_order_number,
)

PAID_OR_LATER = sorted(PAID_STATUSES, key=lambda s: s.value)
NOT_PAYABLE = [CANCELLED, EXPIRED]
PERSONAL = ("Ana", "Pérez", "987654321", "Larco", "Miraflores", "Frente al parque")


@dataclass
class PayRepository(CancelRepository):
    """`CancelRepository` más `paid_at`: `apply(..., paid=True)` lo fija con la hora del cambio."""

    def apply(self, order_id: UUID, change: object, **options: object) -> Order:
        done = super().apply(order_id, change, **options)  # type: ignore[arg-type]
        if options.get("paid"):
            done = replace(done, paid_at=change.at)  # type: ignore[attr-defined]
            self.orders[order_id] = done
        return done


@dataclass
class Consume:
    """`ConsumeReservations` falso: anota con qué se llamó y en qué estado estaba el pedido."""

    calls: Calls
    repository: PayRepository
    error: Exception | None = None
    consumed: list[tuple[UUID, datetime]] = field(default_factory=list)
    status_seen: list[OrderStatus] = field(default_factory=list)

    def __call__(self, order_id: UUID, now: datetime) -> None:
        self.calls.append("consume")
        self.consumed.append((order_id, now))
        self.status_seen.append(self.repository.orders[order_id].status)
        if self.error is not None:
            raise self.error


@dataclass
class World:
    calls: Calls
    repository: PayRepository
    consume: Consume
    release: Release
    audit: FakeAudit
    confirm: ConfirmOrderPayment
    payable: GetPayableOrder

    def stored(self, order: Order) -> Order:
        return self.repository.orders[order.id]

    def snapshot(self) -> dict[UUID, Order]:
        return dict(self.repository.orders)

    def effects(self) -> list[str]:
        return [c for c in self.calls if c in ("consume", "apply", "release", "audit")]


def world(*orders: Order, consume_error: Exception | None = None) -> World:
    calls = Calls()
    repository = PayRepository(calls)
    repository.add(*orders)
    consume = Consume(calls, repository, consume_error)
    release, audit, clock = Release(calls), FakeAudit(calls), FixedClock(calls)
    expire = ExpireOverdueOrders(repository, release, audit, clock)  # type: ignore[arg-type]
    return World(
        calls,
        repository,
        consume,
        release,
        audit,
        ConfirmOrderPayment(repository, consume, release, audit, clock),  # type: ignore[arg-type]
        GetPayableOrder(repository, expire),  # type: ignore[arg-type]
    )


# --------------------------------------------------------------------------------------------
# CA-ORDERS-14: un pendiente_pago propio y vigente se paga
def test_a_current_pending_order_is_paid() -> None:
    order = an_order()
    w = world(order)

    outcome = w.confirm(ME, order.id)

    assert outcome == PaymentOutcome.PAID
    assert w.stored(order).status == PAID
    assert w.stored(order).paid_at == NOW  # `paid_at` con la hora del reloj inyectado


def test_the_reservations_are_consumed_once_with_the_clock_now() -> None:
    order = an_order()
    w = world(order)

    w.confirm(ME, order.id)

    assert w.consume.consumed == [(order.id, NOW)]
    assert w.release.released == []  # pagar no libera nada


def test_the_reservations_are_consumed_before_the_state_change_r16() -> None:
    order = an_order()
    w = world(order)

    w.confirm(ME, order.id)

    assert w.calls.index("consume") < w.calls.index("apply")
    assert w.consume.status_seen == [PENDING]  # al consumir, el pedido aún no estaba pagado
    assert w.calls.index("apply") < w.calls.index("audit")


def test_the_payment_is_one_customer_history_row_with_the_actor_and_no_note() -> None:
    order = an_order()
    w = world(order)

    w.confirm(ME, order.id)

    stored = w.stored(order)
    assert [(c.from_status, c.to_status, c.actor_kind) for c in stored.history[1:]] == [
        (PENDING, PAID, ActorKind.CUSTOMER)
    ]
    assert len(stored.history) == len(order.history) + 1  # CA-ORDERS-20: exactamente una fila
    [(order_id, change, options)] = w.repository.apply_args
    assert order_id == order.id
    assert change.actor_id == ME and change.note is None and change.at == NOW
    assert options.get("paid") is True and options.get("refund_amount") is None


def test_paying_never_touches_the_amounts_of_the_order() -> None:
    order = an_order(quantities=(1, 2, 3))
    w = world(order)

    w.confirm(ME, order.id)

    stored = w.stored(order)
    assert (stored.subtotal_amount, stored.shipping_amount, stored.total_amount) == (
        order.subtotal_amount,
        order.shipping_amount,
        order.total_amount,
    )
    assert stored.lines == order.lines and stored.refunded_amount is None


def test_the_audit_has_the_customer_as_actor_the_entity_and_before_and_after() -> None:
    order = an_order()
    w = world(order)

    w.confirm(ME, order.id)

    [entry] = w.audit.entries
    assert entry.action == "orders.status_changed"
    assert (entry.entity_type, entry.entity_id) == ("order", str(order.id))
    assert (entry.actor_id, entry.actor_role) == (ME, "customer")
    assert entry.before["status"] == "pendiente_pago"
    assert entry.after["status"] == "pagado"


def test_the_audit_of_the_payment_has_no_personal_data_of_the_recipient() -> None:
    order = an_order()
    w = world(order)

    w.confirm(ME, order.id)

    dump = repr(w.audit.entries)
    for personal in PERSONAL:
        assert personal not in dump, personal  # CA-ORDERS-21, R18


def test_the_order_is_locked_with_the_session_user_before_anything_else() -> None:
    order = an_order()
    w = world(order)

    w.confirm(ME, order.id)

    assert w.calls[0] == "get"  # R4: primero la fila del pedido, luego reservas y stock
    assert w.repository.get_args[0] == (order.id, ME, True)  # por dueño y con FOR UPDATE


def test_the_other_orders_of_the_customer_are_left_alone() -> None:
    mine, also_mine = an_order(), an_order()
    w = world(mine, also_mine)

    w.confirm(ME, mine.id)

    assert w.stored(also_mine) == also_mine and w.consume.consumed == [(mine.id, NOW)]


def test_a_made_to_order_or_mixed_order_is_paid_the_same_way() -> None:
    # Inventory no devuelve nada que consumir para lo Bajo pedido: orders llama igual y paga.
    order = an_order(quantities=(1, 2, 3))
    w = world(order)

    assert w.confirm(ME, order.id) == PaymentOutcome.PAID
    assert w.stored(order).status == PAID and len(w.audit.entries) == 1


@pytest.mark.parametrize("delivery_pickup", [False, True], ids=["shipping", "pickup"])
def test_both_delivery_methods_are_paid_the_same_way(delivery_pickup: bool) -> None:
    order = an_order(delivery_pickup=delivery_pickup)
    w = world(order)

    assert w.confirm(ME, order.id) == PaymentOutcome.PAID
    assert w.stored(order).status == PAID


def test_one_second_before_the_limit_the_order_is_still_payable() -> None:
    order = an_order(created_at=NOW - timedelta(minutes=30) + timedelta(seconds=1))
    w = world(order)

    assert w.confirm(ME, order.id) == PaymentOutcome.PAID


# --------------------------------------------------------------------------------------------
# CA-ORDERS-14 / RF05.03: repetir el pago es idempotente
@pytest.mark.parametrize("status", PAID_OR_LATER, ids=lambda s: s.value)
def test_an_already_paid_order_returns_already_paid_with_no_effect(status: OrderStatus) -> None:
    order = an_order(status=status)
    w = world(order)
    before = w.snapshot()

    outcome = w.confirm(ME, order.id)

    assert outcome == PaymentOutcome.ALREADY_PAID
    assert w.snapshot() == before
    assert w.effects() == []  # ni consumo, ni cambio de estado, ni liberación, ni auditoría


def test_an_already_paid_order_past_its_pay_window_is_still_already_paid() -> None:
    # `expires_at` solo manda en pendiente_pago: pagado hace una hora no "vence".
    order = an_order(status=PAID, age_minutes=120)
    w = world(order)

    assert w.confirm(ME, order.id) == PaymentOutcome.ALREADY_PAID
    assert w.stored(order).status == PAID and w.effects() == []


def test_paying_twice_gives_paid_then_already_paid_with_one_of_each_effect() -> None:
    order = an_order()
    w = world(order)

    first, second = w.confirm(ME, order.id), w.confirm(ME, order.id)

    assert (first, second) == (PaymentOutcome.PAID, PaymentOutcome.ALREADY_PAID)
    assert len(w.consume.consumed) == 1 and len(w.repository.apply_args) == 1
    assert len(w.audit.entries) == 1 and w.release.released == []
    history = w.stored(order).history
    assert [h.to_status for h in history].count(PAID) == 1  # CA-ORDERS-20: un solo historial
    assert w.stored(order).paid_at == NOW


def test_many_repetitions_leave_one_consumption_one_history_row_and_one_audit() -> None:
    order = an_order()
    w = world(order)

    outcomes = [w.confirm(ME, order.id) for _ in range(5)]

    assert outcomes == [PaymentOutcome.PAID] + [PaymentOutcome.ALREADY_PAID] * 4
    assert len(w.consume.consumed) == 1 and len(w.audit.entries) == 1
    assert len(w.stored(order).history) == len(order.history) + 1


# --------------------------------------------------------------------------------------------
# CA-ORDERS-14 / R16: cancelado o expirado → OrderNotPayable(status), sin ningún cambio
@pytest.mark.parametrize("status", NOT_PAYABLE, ids=lambda s: s.value)
def test_a_cancelled_or_expired_order_is_not_payable_with_its_status(status: OrderStatus) -> None:
    order = an_order(status=status, age_minutes=5)
    w = world(order)

    with pytest.raises(OrderNotPayable) as error:
        w.confirm(ME, order.id)

    assert error.value.status == status


@pytest.mark.parametrize("status", NOT_PAYABLE, ids=lambda s: s.value)
@pytest.mark.parametrize("age", [5, 120], ids=["vigente", "vencido"])
def test_a_rejected_payment_leaves_no_effect_at_all(status: OrderStatus, age: int) -> None:
    order = an_order(status=status, age_minutes=age)
    w = world(order)
    before = w.snapshot()

    with pytest.raises(OrderNotPayable):
        w.confirm(ME, order.id)

    assert w.snapshot() == before
    assert w.effects() == []  # ni consumo, ni apply, ni liberación, ni auditoría
    assert w.consume.consumed == [] and w.release.released == [] and w.audit.entries == []


def test_a_cancelled_order_is_never_paid_even_if_its_reservations_were_alive() -> None:
    order = an_order(status=CANCELLED)
    w = world(order)

    with pytest.raises(OrderNotPayable):
        w.confirm(ME, order.id)

    assert w.stored(order).status == CANCELLED and w.stored(order).paid_at is None


# --------------------------------------------------------------------------------------------
# R6 / R7 / R16: pendiente_pago vencido → expira y devuelve EXPIRED, sin cobrar ni consumir
@pytest.mark.parametrize("age", [30, 31, 600], ids=["en-el-limite", "un-minuto", "horas"])
def test_an_overdue_pending_order_is_expired_not_paid(age: int) -> None:
    order = an_order(age_minutes=age)  # con 30 min, expires_at == NOW exacto
    w = world(order)

    outcome = w.confirm(ME, order.id)

    assert outcome == PaymentOutcome.EXPIRED
    stored = w.stored(order)
    assert stored.status == EXPIRED and stored.paid_at is None


def test_an_overdue_order_consumes_nothing_and_releases_its_reservations_once() -> None:
    order = overdue()
    w = world(order)

    w.confirm(ME, order.id)

    assert w.consume.consumed == []  # no hay cobro: no se descuenta stock
    assert w.release.released == [order.id]


def test_an_overdue_order_gets_one_system_history_row_and_one_audit_without_actor() -> None:
    order = overdue()
    w = world(order)

    w.confirm(ME, order.id)

    stored = w.stored(order)
    assert [(c.from_status, c.to_status, c.actor_kind, c.actor_id) for c in stored.history[1:]] == [
        (PENDING, EXPIRED, ActorKind.SYSTEM, None)
    ]
    [entry] = w.audit.entries
    assert entry.action == "orders.status_changed" and entry.entity_id == str(order.id)
    assert entry.actor_id is None and entry.actor_role is None  # sistema (AUDIT-R5)
    assert entry.before["status"] == "pendiente_pago" and entry.after["status"] == "expirado"


def test_the_exact_expiry_instant_is_overdue_and_a_second_before_is_not() -> None:
    at_limit = an_order(created_at=NOW - timedelta(minutes=30))
    one_left = an_order(created_at=NOW - timedelta(minutes=30) + timedelta(seconds=1))
    w = world(at_limit, one_left)

    assert w.confirm(ME, at_limit.id) == PaymentOutcome.EXPIRED
    assert w.confirm(ME, one_left.id) == PaymentOutcome.PAID


def test_after_expiring_a_new_payment_is_not_payable_and_nothing_repeats() -> None:
    order = overdue()
    w = world(order)

    first = w.confirm(ME, order.id)
    with pytest.raises(OrderNotPayable) as error:
        w.confirm(ME, order.id)

    assert first == PaymentOutcome.EXPIRED and error.value.status == EXPIRED
    assert w.release.released == [order.id] and len(w.audit.entries) == 1
    assert [h.to_status for h in w.stored(order).history].count(EXPIRED) == 1


def test_expiring_is_an_outcome_not_an_exception_so_the_transaction_can_commit() -> None:
    order = overdue()
    w = world(order)

    try:
        outcome = w.confirm(ME, order.id)
    except Exception as error:  # noqa: BLE001
        pytest.fail(f"EXPIRED debe devolverse, no lanzarse: {error!r}")

    assert outcome is PaymentOutcome.EXPIRED


# --------------------------------------------------------------------------------------------
# R16 / INVENTORY-R11: ReservationExpired → expira el pedido y devuelve EXPIRED sin relanzar
def test_a_reservation_expired_error_expires_the_order_and_returns_expired() -> None:
    order = an_order()
    w = world(order, consume_error=ReservationExpired())

    outcome = w.confirm(ME, order.id)

    assert outcome == PaymentOutcome.EXPIRED
    stored = w.stored(order)
    assert stored.status == EXPIRED and stored.paid_at is None
    assert w.consume.consumed == [(order.id, NOW)]  # lo intentó, antes de decidir


def test_a_reservation_expired_error_leaves_exactly_the_expiry_effects() -> None:
    order = an_order()
    w = world(order, consume_error=ReservationExpired())

    w.confirm(ME, order.id)

    assert w.release.released == [order.id]
    [entry] = w.audit.entries
    assert entry.actor_id is None and entry.after["status"] == "expirado"  # nunca "pagado"
    stored = w.stored(order)
    assert [(c.from_status, c.to_status, c.actor_kind) for c in stored.history[1:]] == [
        (PENDING, EXPIRED, ActorKind.SYSTEM)
    ]
    assert not any(o.get("paid") for _, _, o in w.repository.apply_args)  # sin cobro
    assert w.calls.index("consume") < w.calls.index("apply")


def test_any_other_error_from_the_consumption_propagates_without_changes() -> None:
    order = an_order()
    w = world(order, consume_error=RuntimeError("inventory cayó"))
    before = w.snapshot()

    with pytest.raises(RuntimeError, match="inventory"):
        w.confirm(ME, order.id)

    assert w.snapshot() == before  # nada se cambió, nada se auditó: la transacción se deshace
    assert w.audit.entries == [] and w.release.released == []
    assert not any(c in ("apply", "audit", "release") for c in w.calls)


def test_a_failing_audit_propagates_so_the_transaction_is_rolled_back() -> None:
    order = an_order()
    w = world(order)

    def boom(entry: object) -> None:
        raise RuntimeError("auditoría caída")

    w.audit.record = boom  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="auditoría"):
        w.confirm(ME, order.id)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-22 / R12: ajeno = inexistente
def test_a_foreign_order_is_order_not_found() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.confirm(ME, theirs.id)


def test_foreign_and_missing_raise_the_same_error_with_the_same_message() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound) as foreign:
        w.confirm(ME, theirs.id)
    with pytest.raises(OrderNotFound) as missing:
        w.confirm(ME, uuid4())

    assert type(foreign.value) is type(missing.value)
    assert str(foreign.value) == str(missing.value)
    assert str(theirs.id) not in str(foreign.value) and str(OTHER) not in str(foreign.value)


@pytest.mark.parametrize("status", list(OrderStatus), ids=lambda s: s.value)
def test_a_foreign_order_in_any_state_changes_nothing(status: OrderStatus) -> None:
    theirs = an_order(OTHER, status=status)
    w = world(theirs, an_order())
    before = w.snapshot()

    with pytest.raises(OrderNotFound):
        w.confirm(ME, theirs.id)

    assert w.snapshot() == before and w.effects() == []


def test_a_foreign_overdue_order_is_neither_expired_nor_released_by_my_attempt() -> None:
    theirs = overdue(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.confirm(ME, theirs.id)

    assert w.stored(theirs).status == PENDING and w.effects() == []


def test_every_lookup_is_filtered_by_the_user_of_the_session() -> None:
    theirs = an_order(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound):
        w.confirm(ME, theirs.id)

    assert all(user == ME for _, user, _ in w.repository.get_args)  # nunca un get sin dueño


def test_each_customer_pays_only_their_own_order() -> None:
    mine, theirs = an_order(ME), an_order(OTHER)
    w = world(mine, theirs)

    assert w.confirm(OTHER, theirs.id) == PaymentOutcome.PAID
    with pytest.raises(OrderNotFound):
        w.confirm(OTHER, mine.id)

    assert w.stored(theirs).status == PAID and w.stored(mine).status == PENDING
    assert w.consume.consumed == [(theirs.id, NOW)]


def test_the_use_cases_take_only_the_session_user_and_the_order_never_an_amount() -> None:
    for use_case in (ConfirmOrderPayment, GetPayableOrder):
        parameters = list(inspect.signature(use_case.__call__).parameters)
        assert parameters == ["self", "user_id", "order_id"], use_case


# --------------------------------------------------------------------------------------------
# GetPayableOrder (CA-ORDERS-14, 22)
def test_the_payable_order_has_total_status_and_expiry_of_the_own_order() -> None:
    order = an_order(number=42, quantities=(1, 2, 3))
    w = world(order)

    payable = w.payable(ME, order.id)

    assert payable == PayableOrder(
        order_id=order.id,
        number=format_order_number(42),
        status=PENDING,
        total_amount=order.total_amount,
        expires_at=order.expires_at,
    )
    assert isinstance(payable.number, str) and payable.number.startswith("VAL-")


def test_the_payable_order_exposes_only_what_payments_needs() -> None:
    assert [f.name for f in dataclasses.fields(PayableOrder)] == [
        "order_id",
        "number",
        "status",
        "total_amount",
        "expires_at",
    ]
    order = an_order()
    payable = world(order).payable(ME, order.id)
    with pytest.raises(dataclasses.FrozenInstanceError):
        payable.total_amount = 1  # type: ignore[misc]


def test_the_payable_order_carries_no_personal_data() -> None:
    order = an_order()
    w = world(order)

    dump = repr(w.payable(ME, order.id))

    for personal in PERSONAL:
        assert personal not in dump, personal


@pytest.mark.parametrize("status", list(OrderStatus), ids=lambda s: s.value)
def test_it_does_not_require_pending_payment_payments_decides_with_the_status(
    status: OrderStatus,
) -> None:
    order = an_order(status=status, age_minutes=120 if status == EXPIRED else 5)
    w = world(order)

    assert w.payable(ME, order.id).status == status


def test_reading_a_current_order_has_no_effect() -> None:
    order = an_order()
    w = world(order)
    before = w.snapshot()

    w.payable(ME, order.id)

    assert w.snapshot() == before and w.effects() == []


def test_an_overdue_pending_order_is_materialized_and_reported_as_expired() -> None:
    order = overdue()
    w = world(order)

    payable = w.payable(ME, order.id)

    assert payable.status == EXPIRED  # R7: la lectura caduca; payments ve `expirado`
    assert w.stored(order).status == EXPIRED
    assert w.release.released == [order.id] and len(w.audit.entries) == 1
    assert w.audit.entries[0].actor_id is None


def test_the_expiry_by_reading_is_scoped_to_the_owner_and_the_order() -> None:
    order = an_order()
    w = world(order)

    w.payable(ME, order.id)

    [args] = w.repository.expire_args
    assert args["user_id"] == ME and list(args["order_ids"]) == [order.id]  # type: ignore[arg-type]


def test_reading_twice_does_not_duplicate_the_expiry() -> None:
    order = overdue()
    w = world(order)

    w.payable(ME, order.id)
    w.payable(ME, order.id)

    assert w.release.released == [order.id] and len(w.audit.entries) == 1
    assert [h.to_status for h in w.stored(order).history].count(EXPIRED) == 1


def test_a_foreign_or_missing_order_is_order_not_found_for_the_payable_read() -> None:
    theirs = overdue(OTHER)
    w = world(theirs)

    with pytest.raises(OrderNotFound) as foreign:
        w.payable(ME, theirs.id)
    with pytest.raises(OrderNotFound) as missing:
        w.payable(ME, uuid4())

    assert str(foreign.value) == str(missing.value)
    assert w.stored(theirs).status == PENDING and w.effects() == []  # ni caducó lo ajeno


def test_the_payable_read_is_always_filtered_by_the_user_of_the_session() -> None:
    mine = an_order()
    w = world(mine, an_order(OTHER))

    w.payable(ME, mine.id)

    assert all(user == ME for _, user, _ in w.repository.get_args)


# --------------------------------------------------------------------------------------------
# PaymentOutcome (contrato con payments)
def test_the_payment_outcome_values_are_the_agreed_strings() -> None:
    assert {o.name: o.value for o in PaymentOutcome} == {
        "PAID": "paid",
        "ALREADY_PAID": "already_paid",
        "EXPIRED": "expired",
    }
    assert PaymentOutcome("already_paid") is PaymentOutcome.ALREADY_PAID
