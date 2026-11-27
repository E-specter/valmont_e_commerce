"""`TransitionOrder` con repositorio, reservas, auditoría y reloj falsos (T-079; CA-ORDERS-18, 19,
20, 21 y 26; SPEC §3 UC-09 y UC-10, §4 R1, R4, R7, R10, R11, R15, R19 y R20, §5). Sin BD. El
repositorio falso respeta lo que el real promete (`apply` compara el estado de origen, añade el
historial, guarda el reembolso y los datos de envío); lo que importa aquí es lo que hace el caso de
uso con él: bloquear el pedido (sin filtrar por dueño: el administrador ve todos) antes de decidir,
caducar solo ese pedido, validar con la tabla de §5 para cada uno de los 64 pares estado × destino
y por modalidad, aplicar con el administrador como actor, registrar el reembolso total solo al
cancelar un pagado o en preparación, liberar solo al cancelar un `pendiente_pago`, auditar una vez y
no dejar ningún efecto al rechazar. Datos ficticios."""

from dataclasses import dataclass, fields, replace
from uuid import UUID, uuid4

import pytest

from tests.orders.orders_create_helpers import NOW, Calls, FakeAudit
from tests.orders.orders_helpers import make_line, shipping_delivery
from tests.orders.orders_transition_helpers import (
    METHODS,
    NOTE,
    expected_targets,
    refunds,
)
from tests.orders.test_cancel_order_usecases import CancelRepository, FixedClock
from tests.orders.test_my_orders_usecases import OTHER, Release, an_order, overdue
from valmont.modules.orders.application import Actor, ExpireOverdueOrders, TransitionOrder
from valmont.modules.orders.domain import (
    ActorKind,
    Delivery,
    DeliveryDetails,
    InvalidTransition,
    Order,
    OrderNotFound,
    OrderStatus,
    StatusChange,
    build_order,
)

PENDING, PAID, PREPARING, SHIPPED, READY, DELIVERED, CANCELLED, EXPIRED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PREPARING,
    OrderStatus.SHIPPED,
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
)
STATUSES = tuple(OrderStatus)
ADMIN = uuid4()
ACTOR = Actor(ADMIN, ActorKind.ADMIN)
PERSONAL = ("Ana", "Pérez", "987654321", "Larco", "Miraflores", "Frente al parque")
# Pares válidos de §5 por modalidad: (estado, destino, modalidad).
VALID = [
    (s, t, m)
    for m in METHODS
    for s in STATUSES
    for t in STATUSES
    if t.value in expected_targets(s.value, m)
]


@dataclass
class TransitionRepository(CancelRepository):
    """`CancelRepository` con el `apply` completo del real: reembolso y datos de envío."""

    def apply(  # type: ignore[override]
        self,
        order_id: UUID,
        change: StatusChange,
        *,
        paid: bool = False,
        refund_amount: int | None = None,
        carrier: str | None = None,
        tracking_code: str | None = None,
    ) -> Order:
        self.calls.append("apply")
        options = {
            "paid": paid,
            "refund_amount": refund_amount,
            "carrier": carrier,
            "tracking_code": tracking_code,
        }
        self.apply_args.append((order_id, change, options))
        order = self.orders[order_id]
        if change.from_status != order.status:
            raise InvalidTransition(change.from_status, change.to_status, frozenset())  # type: ignore[arg-type]
        extra: dict[str, object] = {}
        if refund_amount is not None:
            extra.update(refunded_amount=refund_amount, refunded_at=change.at)
        delivery = order.delivery
        if change.to_status == SHIPPED:
            base = {f.name: getattr(delivery, f.name) for f in fields(DeliveryDetails)}
            delivery = Delivery(
                **base, carrier=carrier, tracking_code=tracking_code, shipped_at=change.at
            )
        done = replace(
            order,
            status=change.to_status,
            delivery=delivery,
            history=(*order.history, change),
            **extra,  # type: ignore[arg-type]
        )
        self.orders[order_id] = done
        return done


@dataclass
class World:
    calls: Calls
    repository: TransitionRepository
    release: Release
    audit: FakeAudit
    transition: TransitionOrder

    def stored(self, order: Order) -> Order:
        return self.repository.orders[order.id]

    def snapshot(self) -> dict[UUID, Order]:
        return dict(self.repository.orders)

    def effects(self) -> list[str]:
        return [c for c in self.calls if c in ("apply", "release", "audit")]

    def options(self) -> dict[str, object]:
        [(_, _, options)] = self.repository.apply_args
        return options


def world(*orders: Order) -> World:
    calls = Calls()
    repository = TransitionRepository(calls)
    repository.add(*orders)
    release, audit, clock = Release(calls), FakeAudit(calls), FixedClock(calls)
    expire = ExpireOverdueOrders(repository, release, audit, clock)  # type: ignore[arg-type]
    transition = TransitionOrder(repository, expire, release, audit, clock)  # type: ignore[arg-type]
    return World(calls, repository, release, audit, transition)


def note_for(to: OrderStatus) -> str | None:
    return NOTE if to == CANCELLED else None


def order_for(status: OrderStatus, method: str, **kwargs: object) -> Order:
    return an_order(OTHER, status=status, delivery_pickup=method == "pickup", **kwargs)  # type: ignore[arg-type]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-18: la matriz completa, 64 pares por modalidad
def test_the_spec_has_twelve_valid_pairs_six_per_method() -> None:
    assert len(VALID) == 12
    assert sum(1 for *_, m in VALID if m == "shipping") == 6


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("status", STATUSES, ids=lambda s: s.value)
@pytest.mark.parametrize("to", STATUSES, ids=lambda s: s.value)
def test_every_pair_is_accepted_or_invalid_transition_with_the_allowed_targets(
    method: str, status: OrderStatus, to: OrderStatus
) -> None:
    order = order_for(status, method)
    w = world(order)
    allowed = expected_targets(status.value, method)

    if to.value in allowed:
        result = w.transition(ACTOR, order.id, to, note=note_for(to))
        assert result.status == to and w.stored(order).status == to
        assert len(result.history) == len(order.history) + 1
        return
    before = w.snapshot()
    with pytest.raises(InvalidTransition) as error:
        w.transition(ACTOR, order.id, to, note=note_for(to))
    assert (error.value.from_status, error.value.to_status) == (status, to)
    assert {s.value for s in error.value.allowed} == allowed
    assert w.effects() == [] and w.snapshot() == before  # sin ningún efecto


@pytest.mark.parametrize("to", [PAID, EXPIRED, PENDING], ids=lambda s: s.value)
@pytest.mark.parametrize("method", METHODS)
def test_paid_expired_and_pending_are_never_a_destination_from_any_state(
    method: str, to: OrderStatus
) -> None:
    for status in STATUSES:  # R19: pagado solo lo pone el pago y expirado solo la caducidad
        order = order_for(status, method)
        w = world(order)
        with pytest.raises(InvalidTransition):
            w.transition(ACTOR, order.id, to)
        assert w.effects() == []


def test_shipped_is_only_for_shipping_and_ready_for_pickup_only_for_pickup() -> None:
    for method, wrong in (("pickup", SHIPPED), ("shipping", READY)):
        order = order_for(PREPARING, method)
        w = world(order)
        with pytest.raises(InvalidTransition) as error:
            w.transition(ACTOR, order.id, wrong)
        assert wrong not in error.value.allowed and CANCELLED in error.value.allowed  # R20
        assert w.effects() == []


@pytest.mark.parametrize("status", [DELIVERED, CANCELLED, EXPIRED], ids=lambda s: s.value)
@pytest.mark.parametrize("method", METHODS)
def test_terminal_states_have_no_way_out(method: str, status: OrderStatus) -> None:
    order = order_for(status, method)
    w = world(order)

    for to in STATUSES:
        with pytest.raises(InvalidTransition) as error:
            w.transition(ACTOR, order.id, to, note=NOTE)
        assert error.value.allowed == frozenset()
    assert w.effects() == []


# --------------------------------------------------------------------------------------------
# CA-ORDERS-18, 20, 21: cada transición válida deja una fila de historial y una auditoría
@pytest.mark.parametrize("status,to,method", VALID, ids=lambda v: getattr(v, "value", v))
def test_each_valid_transition_is_one_admin_history_row_and_one_audit_entry(
    status: OrderStatus, to: OrderStatus, method: str
) -> None:
    order = order_for(status, method)
    w = world(order)

    result = w.transition(ACTOR, order.id, to, note=note_for(to))

    assert [
        (c.from_status, c.to_status, c.actor_kind, c.actor_id) for c in result.history[-1:]
    ] == [(status, to, ActorKind.ADMIN, ADMIN)]
    assert len(result.history) == len(order.history) + 1  # exactamente una fila
    [entry] = w.audit.entries
    assert entry.action == "orders.status_changed"
    assert (entry.entity_type, entry.entity_id) == ("order", str(order.id))
    assert (entry.actor_id, entry.actor_role) == (ADMIN, "admin")  # el administrador, no el dueño
    assert entry.before == {"status": status.value}
    expected_after = {"status": to.value}
    if refunds(status.value, to.value):
        expected_after["refunded_amount"] = order.total_amount  # type: ignore[assignment]
    assert entry.after == expected_after


@pytest.mark.parametrize("status,to,method", VALID, ids=lambda v: getattr(v, "value", v))
def test_the_clock_of_the_change_is_the_injected_one_and_nobody_is_marked_paid(
    status: OrderStatus, to: OrderStatus, method: str
) -> None:
    order = order_for(status, method)
    w = world(order)

    w.transition(ACTOR, order.id, to, note=note_for(to))

    [(order_id, change, options)] = w.repository.apply_args
    assert order_id == order.id and change.at == NOW
    assert change.actor_kind == ActorKind.ADMIN and change.actor_id == ADMIN
    assert not options["paid"]  # R19: `pagado` y `paid_at` son del pago


def test_the_note_goes_to_the_history_and_the_actor_is_the_one_given_not_the_owner() -> None:
    order = order_for(PAID, "shipping")
    w = world(order)

    result = w.transition(ACTOR, order.id, PREPARING, note="Pieza revisada por el taller")

    assert result.history[-1].note == "Pieza revisada por el taller"
    assert result.history[-1].actor_id == ADMIN != order.user_id


def test_the_note_is_optional_for_a_transition_that_is_not_a_cancellation() -> None:
    order = order_for(PAID, "shipping")

    result = world(order).transition(ACTOR, order.id, PREPARING)

    assert result.status == PREPARING and result.history[-1].note is None


def test_the_audit_has_no_personal_data_of_the_recipient() -> None:
    order = order_for(PAID, "shipping")
    w = world(order)

    w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    dump = repr(w.audit.entries)
    for personal in PERSONAL:
        assert personal not in dump, personal


def test_the_same_transition_twice_is_invalid_and_adds_no_second_row() -> None:
    order = order_for(PAID, "shipping")
    w = world(order)
    w.transition(ACTOR, order.id, PREPARING)

    with pytest.raises(InvalidTransition) as error:
        w.transition(ACTOR, order.id, PREPARING)

    assert error.value.from_status == PREPARING and error.value.to_status == PREPARING
    assert len(w.stored(order).history) == len(order.history) + 1
    assert len(w.audit.entries) == 1


def test_a_transition_touches_nothing_of_the_other_orders() -> None:
    mine, other = order_for(PAID, "shipping"), order_for(PAID, "pickup")
    w = world(mine, other)

    w.transition(ACTOR, mine.id, CANCELLED, note=NOTE)

    assert w.stored(other) == other


# --------------------------------------------------------------------------------------------
# R4: se bloquea el pedido (de cualquier cliente) antes de decidir
def test_the_order_is_locked_first_without_filtering_by_owner() -> None:
    order = order_for(PAID, "shipping")
    w = world(order)

    w.transition(ACTOR, order.id, PREPARING)

    assert w.calls[0] == "get"
    assert w.repository.get_args[0] == (order.id, None, True)  # el administrador no es el dueño


def test_only_the_order_in_hand_is_expired_never_the_other_overdue_ones() -> None:
    order, stranger = order_for(PAID, "shipping"), overdue(OTHER)
    w = world(order, stranger)

    w.transition(ACTOR, order.id, PREPARING)

    assert w.stored(stranger).status == PENDING  # R7: solo el pedido pedido
    for args in w.repository.expire_args:
        assert list(args["order_ids"] or []) == [order.id]  # type: ignore[call-overload]


def test_the_expiry_check_comes_before_the_state_change() -> None:
    order = order_for(PAID, "shipping")
    w = world(order)

    w.transition(ACTOR, order.id, PREPARING)

    assert w.calls.index("get") < w.calls.index("expire") < w.calls.index("apply")


def test_an_unknown_order_is_not_found_without_any_effect() -> None:
    other = order_for(PAID, "shipping")
    w = world(other)

    with pytest.raises(OrderNotFound):
        w.transition(ACTOR, uuid4(), PREPARING)

    assert w.effects() == [] and w.snapshot() == {other.id: other}


# --------------------------------------------------------------------------------------------
# CA-ORDERS-19, R10, R15: cancelación y reembolso simulado
@pytest.mark.parametrize("status", [PAID, PREPARING], ids=lambda s: s.value)
@pytest.mark.parametrize("method", METHODS)
def test_cancelling_a_paid_or_preparing_order_refunds_the_whole_total(
    method: str, status: OrderStatus
) -> None:
    order = an_order(OTHER, status=status, delivery_pickup=method == "pickup", quantities=(2, 3))
    w = world(order)

    result = w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    assert result.status == CANCELLED
    assert result.refunded_amount == order.total_amount > 0  # reembolso total, nunca parcial
    assert result.refunded_at == NOW
    assert w.options()["refund_amount"] == order.total_amount
    assert result.history[-1].note == NOTE and result.history[-1].actor_id == ADMIN


def test_a_refund_above_two_pow_31_is_kept_whole() -> None:
    big = make_line(quantity=5, list_price=3_000_000_000)
    built = build_order(uuid4(), OTHER, "clave-grande-0001", [big], shipping_delivery(), NOW)
    order = replace(built, number=1, status=PAID, paid_at=NOW)
    w = world(order)

    result = w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    assert result.refunded_amount == 15_000_000_000 == order.total_amount
    assert w.audit.entries[0].after["refunded_amount"] == 15_000_000_000


@pytest.mark.parametrize("method", METHODS)
def test_cancelling_a_pending_order_releases_the_reservations_without_refund(method: str) -> None:
    order = order_for(PENDING, method)
    w = world(order)

    result = w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    assert result.status == CANCELLED
    assert result.refunded_amount is None and result.refunded_at is None
    assert w.options()["refund_amount"] is None
    assert w.release.released == [order.id]  # R10: libera las reservas
    assert w.calls.index("apply") < w.calls.index("release")
    [entry] = w.audit.entries
    assert entry.after == {"status": "cancelado"}  # sin `refunded_amount`


NOT_CANCELLING = [v for v in VALID if v[1] != CANCELLED]


@pytest.mark.parametrize("status,to,method", NOT_CANCELLING, ids=lambda v: getattr(v, "value", v))
def test_a_transition_that_is_not_a_cancellation_releases_nothing_and_refunds_nothing(
    status: OrderStatus, to: OrderStatus, method: str
) -> None:
    order = order_for(status, method)
    w = world(order)

    result = w.transition(ACTOR, order.id, to)

    assert w.release.released == [] and w.options()["refund_amount"] is None
    assert result.refunded_amount is None and result.refunded_at is None


@pytest.mark.parametrize(
    "status", [SHIPPED, READY, DELIVERED, CANCELLED, EXPIRED], ids=lambda s: s.value
)
def test_cancelling_a_shipped_ready_delivered_cancelled_or_expired_order_is_invalid(
    status: OrderStatus,
) -> None:
    method = "pickup" if status == READY else "shipping"
    order = order_for(status, method)
    w = world(order)

    with pytest.raises(InvalidTransition) as error:
        w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    assert CANCELLED not in error.value.allowed
    assert w.effects() == [] and w.stored(order).refunded_amount is None


@pytest.mark.parametrize("note", [None, ""], ids=["none", "empty"])
@pytest.mark.parametrize("status", [PENDING, PAID, PREPARING], ids=lambda s: s.value)
def test_a_cancellation_without_a_note_is_a_value_error_and_changes_nothing(
    status: OrderStatus, note: str | None
) -> None:
    order = order_for(status, "shipping")
    w = world(order)

    with pytest.raises(ValueError):
        w.transition(ACTOR, order.id, CANCELLED, note=note)

    assert w.effects() == [] and w.stored(order) == order


def test_a_second_cancellation_is_invalid_and_does_not_refund_twice() -> None:
    order = order_for(PAID, "shipping")
    w = world(order)
    w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    with pytest.raises(InvalidTransition):
        w.transition(ACTOR, order.id, CANCELLED, note="otra vez")

    assert w.stored(order).refunded_amount == order.total_amount
    assert len(w.repository.apply_args) == 1 and len(w.audit.entries) == 1


# --------------------------------------------------------------------------------------------
# CA-ORDERS-18: envío con transportista y seguimiento opcionales
def test_shipping_stores_the_carrier_the_tracking_code_and_the_shipping_moment() -> None:
    order = order_for(PREPARING, "shipping")
    w = world(order)

    result = w.transition(ACTOR, order.id, SHIPPED, carrier="Olva", tracking_code="OL-123")

    assert w.options()["carrier"] == "Olva" and w.options()["tracking_code"] == "OL-123"
    assert isinstance(result.delivery, Delivery)
    assert (result.delivery.carrier, result.delivery.tracking_code) == ("Olva", "OL-123")
    assert result.delivery.shipped_at == NOW


@pytest.mark.parametrize(
    "extra",
    [{}, {"carrier": "Olva"}, {"tracking_code": "OL-123"}],
    ids=["neither", "carrier", "tracking"],
)
def test_carrier_and_tracking_code_are_optional_and_shipped_at_is_always_set(
    extra: dict[str, str],
) -> None:
    order = order_for(PREPARING, "shipping")
    w = world(order)

    result = w.transition(ACTOR, order.id, SHIPPED, **extra)  # type: ignore[arg-type]

    assert isinstance(result.delivery, Delivery) and result.delivery.shipped_at == NOW
    assert result.delivery.carrier == extra.get("carrier")
    assert result.delivery.tracking_code == extra.get("tracking_code")


@pytest.mark.parametrize(
    "extra",
    [{"carrier": "Olva"}, {"tracking_code": "OL-123"}, {"carrier": "Olva", "tracking_code": "1"}],
    ids=["carrier", "tracking", "both"],
)
@pytest.mark.parametrize("to", [PREPARING, READY, DELIVERED, CANCELLED], ids=lambda s: s.value)
def test_carrier_or_tracking_code_with_another_destination_is_a_value_error_and_changes_nothing(
    to: OrderStatus, extra: dict[str, str]
) -> None:
    status = {PREPARING: PAID, READY: PREPARING, DELIVERED: READY, CANCELLED: PAID}[to]
    order = order_for(status, "pickup" if to in (READY, DELIVERED) else "shipping")
    w = world(order)

    with pytest.raises(ValueError):
        w.transition(ACTOR, order.id, to, note=NOTE, **extra)  # type: ignore[arg-type]

    assert w.effects() == [] and w.stored(order) == order


def test_shipping_a_pickup_order_is_invalid_even_with_a_carrier() -> None:
    order = order_for(PREPARING, "pickup")
    w = world(order)

    with pytest.raises(InvalidTransition):
        w.transition(ACTOR, order.id, SHIPPED, carrier="Olva")

    assert w.effects() == [] and w.stored(order) == order  # nada de transportista en un pickup


def test_ready_for_pickup_carries_no_extra_data() -> None:
    order = order_for(PREPARING, "pickup")
    w = world(order)

    result = w.transition(ACTOR, order.id, READY, note="Lista en vitrina")

    options = w.options()
    assert options["carrier"] is None and options["tracking_code"] is None
    assert not isinstance(result.delivery, Delivery) or result.delivery.shipped_at is None


def test_delivering_keeps_what_the_shipping_stored() -> None:
    order = order_for(PREPARING, "shipping")
    w = world(order)
    w.transition(ACTOR, order.id, SHIPPED, carrier="Olva", tracking_code="OL-123")

    result = w.transition(ACTOR, order.id, DELIVERED)

    assert result.status == DELIVERED
    assert [(c.to_status, c.actor_kind) for c in result.history[-2:]] == [
        (SHIPPED, ActorKind.ADMIN),
        (DELIVERED, ActorKind.ADMIN),
    ]
    assert w.repository.apply_args[-1][2]["carrier"] is None  # entregar no reescribe el envío


# --------------------------------------------------------------------------------------------
# R7: el vencido se caduca antes de decidir
@pytest.mark.parametrize("to", [PREPARING, CANCELLED, SHIPPED, DELIVERED], ids=lambda s: s.value)
def test_an_overdue_pending_order_is_expired_and_the_transition_is_invalid(to: OrderStatus) -> None:
    order = overdue(OTHER)
    w = world(order)

    with pytest.raises(InvalidTransition) as error:
        w.transition(ACTOR, order.id, to, note=note_for(to))

    assert error.value.from_status == EXPIRED and error.value.allowed == frozenset()
    assert w.stored(order).status == EXPIRED  # se caducó: nunca `cancelado` ni `en_preparacion`
    assert w.release.released == [order.id]
    assert w.repository.apply_args == []  # el administrador no aplicó nada
    [entry] = w.audit.entries
    assert entry.actor_id is None  # la auditoría de la caducidad es del sistema
    assert entry.after == {"status": "expirado"}


def test_an_order_overdue_by_exactly_now_is_also_expired_not_cancelled() -> None:
    order = an_order(OTHER, age_minutes=30)  # expires_at == NOW
    w = world(order)

    with pytest.raises(InvalidTransition):
        w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    assert w.stored(order).status == EXPIRED


def test_an_order_with_a_minute_left_is_still_cancellable_by_the_admin() -> None:
    order = an_order(OTHER, age_minutes=29)
    w = world(order)

    result = w.transition(ACTOR, order.id, CANCELLED, note=NOTE)

    assert result.status == CANCELLED and result.refunded_amount is None


def test_a_paid_order_never_expires_however_old_it_is() -> None:
    order = an_order(OTHER, status=PAID, age_minutes=600)
    w = world(order)

    result = w.transition(ACTOR, order.id, PREPARING)

    assert result.status == PREPARING and w.audit.entries[0].actor_id == ADMIN
    assert w.release.released == []
