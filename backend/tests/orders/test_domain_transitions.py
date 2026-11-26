"""Estados, constantes y matriz de transiciones del administrador (T-072; CA-ORDERS-18 y 19,
ORDERS-R1, R10, R19, R20, SPEC §5). La tabla esperada está escrita a mano desde §5, no derivada
del código: así la prueba contradice al dominio si este se desvía de la SPEC."""

import pytest

from valmont.modules.inventory.domain import RESERVATION_MINUTES
from valmont.modules.orders.domain import (
    MAX_PENDING_ORDERS,
    ORDER_NUMBER_PREFIX,
    PAID_STATUSES,
    PAYMENT_WINDOW_MINUTES,
    ActorKind,
    DeliveryMethod,
    Fulfillment,
    InvalidTransition,
    OrderStatus,
    admin_targets,
    can_customer_cancel,
    check_admin_transition,
)

S = OrderStatus
SHIPPING, PICKUP = DeliveryMethod.SHIPPING, DeliveryMethod.PICKUP

# Columna "A" de SPEC §5 para el administrador, por modalidad. `pagado`, `expirado` y
# `pendiente_pago` nunca son destino del administrador (R19); `enviado` solo existe en
# `shipping` y `listo_para_recojo` solo en `pickup`; los terminales no tienen salida.
ADMIN_TARGETS: dict[DeliveryMethod, dict[OrderStatus, frozenset[OrderStatus]]] = {
    SHIPPING: {
        S.PENDING_PAYMENT: frozenset({S.CANCELLED}),
        S.PAID: frozenset({S.PREPARING, S.CANCELLED}),
        S.PREPARING: frozenset({S.SHIPPED, S.CANCELLED}),
        S.SHIPPED: frozenset({S.DELIVERED}),
        S.READY_FOR_PICKUP: frozenset(),  # no existe en shipping
        S.DELIVERED: frozenset(),
        S.CANCELLED: frozenset(),
        S.EXPIRED: frozenset(),
    },
    PICKUP: {
        S.PENDING_PAYMENT: frozenset({S.CANCELLED}),
        S.PAID: frozenset({S.PREPARING, S.CANCELLED}),
        S.PREPARING: frozenset({S.READY_FOR_PICKUP, S.CANCELLED}),
        S.SHIPPED: frozenset(),  # no existe en pickup
        S.READY_FOR_PICKUP: frozenset({S.DELIVERED}),
        S.DELIVERED: frozenset(),
        S.CANCELLED: frozenset(),
        S.EXPIRED: frozenset(),
    },
}

ALL_PAIRS = [
    pytest.param(method, source, target, id=f"{method}:{source}->{target}")
    for method in (SHIPPING, PICKUP)
    for source in OrderStatus
    for target in OrderStatus
]


def test_the_eight_states_have_their_wire_values() -> None:
    assert {s.name: s.value for s in OrderStatus} == {
        "PENDING_PAYMENT": "pendiente_pago",
        "PAID": "pagado",
        "PREPARING": "en_preparacion",
        "SHIPPED": "enviado",
        "READY_FOR_PICKUP": "listo_para_recojo",
        "DELIVERED": "entregado",
        "CANCELLED": "cancelado",
        "EXPIRED": "expirado",
    }
    assert len(OrderStatus) == 8


def test_the_other_enumerations_have_their_wire_values() -> None:
    assert {a.name: a.value for a in ActorKind} == {
        "CUSTOMER": "customer",
        "ADMIN": "admin",
        "SYSTEM": "system",
    }
    assert {f.name: f.value for f in Fulfillment} == {
        "STOCK": "stock",
        "MADE_TO_ORDER": "made_to_order",
    }
    assert {m.name: m.value for m in DeliveryMethod} == {
        "SHIPPING": "shipping",
        "PICKUP": "pickup",
    }


def test_constants_follow_the_spec() -> None:
    assert (PAYMENT_WINDOW_MINUTES, MAX_PENDING_ORDERS, ORDER_NUMBER_PREFIX) == (30, 3, "VAL-")


def test_payment_window_equals_the_reservation_window() -> None:
    # ORDERS-R6: la constante es propia, pero tiene que coincidir con la de la reserva.
    assert PAYMENT_WINDOW_MINUTES == RESERVATION_MINUTES


def test_paid_statuses_are_the_five_paid_or_later_states() -> None:
    assert PAID_STATUSES == frozenset(
        {S.PAID, S.PREPARING, S.SHIPPED, S.READY_FOR_PICKUP, S.DELIVERED}
    )
    assert isinstance(PAID_STATUSES, frozenset)


@pytest.mark.parametrize(("method", "source", "target"), ALL_PAIRS)
def test_admin_transition_matrix_64_pairs_per_method(
    method: DeliveryMethod, source: OrderStatus, target: OrderStatus
) -> None:
    # CA-ORDERS-18: cada par válido de §5 se acepta y el resto (64 pares por modalidad) → error.
    allowed = ADMIN_TARGETS[method][source]
    if target in allowed:
        assert check_admin_transition(source, target, method) is None
        return
    with pytest.raises(InvalidTransition) as exc:
        check_admin_transition(source, target, method)
    assert exc.value.from_status == source
    assert exc.value.to_status == target
    assert frozenset(exc.value.allowed) == allowed  # el 409 informa de lo que sí se puede


@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
@pytest.mark.parametrize("source", list(OrderStatus))
def test_admin_targets_returns_column_a_for_the_method(
    method: DeliveryMethod, source: OrderStatus
) -> None:
    result = admin_targets(source, method)
    assert isinstance(result, frozenset)
    assert result == ADMIN_TARGETS[method][source]


@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
def test_the_administrator_never_targets_paid_expired_or_pending(method: DeliveryMethod) -> None:
    # R19: `pagado` lo pone payments, `expirado` la caducidad y `pendiente_pago` solo la creación.
    for source in OrderStatus:
        targets = admin_targets(source, method)
        assert not targets & {S.PAID, S.EXPIRED, S.PENDING_PAYMENT}


@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
@pytest.mark.parametrize("terminal", [S.DELIVERED, S.CANCELLED, S.EXPIRED])
def test_terminal_states_have_no_admin_exit(method: DeliveryMethod, terminal: OrderStatus) -> None:
    assert admin_targets(terminal, method) == frozenset()


def test_the_happy_paths_of_each_method_are_walkable() -> None:
    # CA-ORDERS-18 / 26: `shipping` y `pickup` recorren su camino sin saltos.
    paths = {
        SHIPPING: [S.PAID, S.PREPARING, S.SHIPPED, S.DELIVERED],
        PICKUP: [S.PAID, S.PREPARING, S.READY_FOR_PICKUP, S.DELIVERED],
    }
    for method, path in paths.items():
        for source, target in zip(path, path[1:], strict=False):
            check_admin_transition(source, target, method)


@pytest.mark.parametrize(
    ("method", "source", "target"),
    [
        (PICKUP, S.PREPARING, S.SHIPPED),  # `enviado` en pickup
        (SHIPPING, S.PREPARING, S.READY_FOR_PICKUP),  # `listo_para_recojo` en shipping
        (PICKUP, S.SHIPPED, S.DELIVERED),
        (SHIPPING, S.READY_FOR_PICKUP, S.DELIVERED),
    ],
)
def test_a_transition_of_the_other_method_is_invalid(
    method: DeliveryMethod, source: OrderStatus, target: OrderStatus
) -> None:
    # R20 (H-3)
    with pytest.raises(InvalidTransition):
        check_admin_transition(source, target, method)


@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
@pytest.mark.parametrize("status", [S.SHIPPED, S.READY_FOR_PICKUP, S.DELIVERED])
def test_a_shipped_ready_or_delivered_order_cannot_be_cancelled_by_the_administrator(
    method: DeliveryMethod, status: OrderStatus
) -> None:
    # CA-ORDERS-19, D-016, H-4
    with pytest.raises(InvalidTransition):
        check_admin_transition(status, S.CANCELLED, method)


@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
@pytest.mark.parametrize("status", [S.PENDING_PAYMENT, S.PAID, S.PREPARING])
def test_the_administrator_can_cancel_until_shipping(
    method: DeliveryMethod, status: OrderStatus
) -> None:
    assert check_admin_transition(status, S.CANCELLED, method) is None


@pytest.mark.parametrize("status", list(OrderStatus))
def test_only_a_pending_order_can_be_cancelled_by_the_customer(status: OrderStatus) -> None:
    # ORDERS-R10: el cliente solo cancela `pendiente_pago` (la idempotencia de `cancelado`
    # la resuelve el caso de uso, no esta función).
    assert can_customer_cancel(status) is (status is S.PENDING_PAYMENT)
