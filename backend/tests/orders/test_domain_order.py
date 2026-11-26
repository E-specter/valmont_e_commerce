"""`OrderLine`, `Order`, `build_order` y los errores del dominio (T-072; CA-ORDERS-03, 07, 20 y
26, ORDERS-R2, R3, R5, R6, R11). Sin BD."""

import dataclasses
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest

from tests.orders.orders_helpers import NOW, make_line, pickup_delivery, shipping_delivery
from valmont.modules.orders.domain import (
    ActorKind,
    DeliveryDetails,
    DeliveryInvalid,
    Fulfillment,
    IdempotencyConflict,
    InvalidTransition,
    NotCancellable,
    Order,
    OrderLine,
    OrderNotFound,
    OrderNotPayable,
    OrderStatus,
    PickupUnavailable,
    StatusChange,
    TooManyPendingOrders,
    build_order,
)

INT32_MAX = 2_147_483_647
KEY = "k" * 16


def build(
    lines: Sequence[OrderLine], delivery: DeliveryDetails | None = None, **kwargs: Any
) -> Order:
    return build_order(
        kwargs.pop("order_id", uuid4()),
        kwargs.pop("user_id", uuid4()),
        kwargs.pop("key", KEY),
        lines,
        delivery or shipping_delivery(),
        kwargs.pop("now", NOW),
    )


def test_line_total_is_unit_price_times_quantity() -> None:
    line = make_line(quantity=3, list_price=250_000, unit_price=200_000)
    assert line.line_total == 600_000
    assert line.discount_amount == 50_000


def test_line_total_above_2_pow_31_is_exact() -> None:
    line = make_line(quantity=5, list_price=900_000_000)
    assert line.line_total == 4_500_000_000 > INT32_MAX


def test_the_snapshot_is_immutable() -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        make_line().unit_price = 1  # type: ignore[misc]


def test_build_order_starts_pending_with_the_payment_window() -> None:
    order_id, user_id = uuid4(), uuid4()
    lines = [make_line(quantity=2, list_price=250_000, unit_price=200_000), make_line()]
    delivery = shipping_delivery()

    order = build(lines, delivery, order_id=order_id, user_id=user_id)

    assert order.id == order_id
    assert order.user_id == user_id
    assert order.number is None  # lo asigna la BD (R14)
    assert order.status == OrderStatus.PENDING_PAYMENT
    assert order.idempotency_key == KEY
    assert order.delivery == delivery
    assert tuple(order.lines) == tuple(lines)
    assert order.created_at == NOW
    assert order.expires_at == NOW + timedelta(minutes=30)
    assert (order.paid_at, order.refunded_amount, order.refunded_at) == (None, None, None)


def test_build_order_computes_the_amounts_in_integers() -> None:
    # CA-ORDERS-03 / R2: subtotal = Σ line_total; shipping = 0; total = subtotal + shipping.
    lines = [make_line(quantity=2, list_price=250_000, unit_price=200_000), make_line(quantity=1)]
    order = build(lines)
    assert order.subtotal_amount == 2 * 200_000 + 100_000
    assert order.shipping_amount == 0
    assert order.total_amount == 500_000


def test_the_total_is_derived_from_subtotal_and_shipping() -> None:
    order = dataclasses.replace(build([make_line(quantity=2)]), shipping_amount=1_500)
    assert order.subtotal_amount == 200_000
    assert order.total_amount == 201_500


def test_subtotal_above_2_pow_31_is_exact() -> None:
    lines = [make_line(quantity=5, list_price=900_000_000), make_line(list_price=123_456_789)]
    order = build(lines)
    assert order.subtotal_amount == 4_500_000_000 + 123_456_789
    assert order.total_amount == order.subtotal_amount > INT32_MAX


def test_shipping_is_free_in_both_methods() -> None:
    assert build([make_line()], shipping_delivery()).shipping_amount == 0
    assert build([make_line()], pickup_delivery()).shipping_amount == 0


def test_the_initial_history_records_the_creation_by_the_customer() -> None:
    # R11 / CA-ORDERS-20: exactamente una fila inicial `None → pendiente_pago`, actor customer.
    user_id = uuid4()
    order = build([make_line()], user_id=user_id)

    (entry,) = order.history
    assert isinstance(entry, StatusChange)
    assert entry.from_status is None
    assert entry.to_status == OrderStatus.PENDING_PAYMENT
    assert entry.actor_kind == ActorKind.CUSTOMER
    assert entry.actor_id == user_id  # supuesto anotado en el traspaso
    assert entry.note is None
    assert entry.at == NOW


def test_no_lines_is_an_error() -> None:
    with pytest.raises(ValueError):
        build([])


def test_estimated_delivery_is_none_without_made_to_order_lines() -> None:
    assert build([make_line(), make_line()]).estimated_delivery_on is None


def test_estimated_delivery_uses_the_greatest_made_to_order_lead_time() -> None:
    # CA-ORDERS-07: NOW = 2026-12-01 10:00 en Lima.
    lines = [
        make_line(fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=10),
        make_line(fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=21),
        make_line(),
    ]
    assert build(lines).estimated_delivery_on == date(2026, 12, 22)


def test_a_stock_line_never_counts_for_the_estimate_even_if_it_carries_a_lead_time() -> None:
    # R5: solo las líneas `made_to_order`. Un `backorder` con stock suficiente se reserva
    # (fulfillment = stock) aunque su producto tenga plazo.
    lines = [
        make_line(fulfillment=Fulfillment.STOCK, lead_time_days=30),
        make_line(fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=10),
    ]
    assert build(lines).estimated_delivery_on == date(2026, 12, 11)
    only_stock = [make_line(fulfillment=Fulfillment.STOCK, lead_time_days=30)]
    assert build(only_stock).estimated_delivery_on is None


def test_made_to_order_without_lead_time_gives_no_estimate() -> None:
    lines = [make_line(fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=None)]
    assert build(lines).estimated_delivery_on is None


def test_estimated_delivery_uses_the_lima_date_of_creation() -> None:
    late_night = datetime(2026, 12, 1, 4, 30, tzinfo=UTC)  # 23:30 del 30 nov en Lima
    lines = [make_line(fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=2)]
    order = build(lines, now=late_night)
    assert order.estimated_delivery_on == date(2026, 12, 2)
    assert order.expires_at == late_night + timedelta(minutes=30)


def test_pickup_gets_the_same_estimate_formula() -> None:
    # H-6
    lines = [make_line(fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=4)]
    order = build(lines, pickup_delivery())
    assert order.estimated_delivery_on == date(2026, 12, 5)


# --- errores -------------------------------------------------------------------------------


def test_invalid_transition_carries_its_details() -> None:
    allowed = frozenset({OrderStatus.PREPARING, OrderStatus.CANCELLED})
    error = InvalidTransition(OrderStatus.PAID, OrderStatus.DELIVERED, allowed)
    assert isinstance(error, Exception)
    assert (error.from_status, error.to_status) == (OrderStatus.PAID, OrderStatus.DELIVERED)
    assert frozenset(error.allowed) == allowed


@pytest.mark.parametrize("error_type", [NotCancellable, OrderNotPayable])
def test_status_errors_carry_the_status(error_type: type[Exception]) -> None:
    error = error_type(OrderStatus.DELIVERED)
    assert error.status == OrderStatus.DELIVERED  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    "error_type", [TooManyPendingOrders, IdempotencyConflict, PickupUnavailable, OrderNotFound]
)
def test_the_remaining_errors_are_plain_exceptions(error_type: type[Exception]) -> None:
    assert issubclass(error_type, Exception)
    with pytest.raises(error_type):
        raise error_type


def test_delivery_invalid_is_a_value_error() -> None:
    assert issubclass(DeliveryInvalid, ValueError)


# --- invariantes de §5 (ValueError) ----------------------------------------------------------


@pytest.mark.parametrize("quantity", [0, -1])
def test_a_line_needs_a_quantity_of_at_least_one(quantity: int) -> None:
    with pytest.raises(ValueError):
        make_line(quantity=quantity)
    assert make_line(quantity=1).quantity == 1


@pytest.mark.parametrize(("list_price", "unit_price"), [(0, 1), (1, 0), (0, 0), (-5, 10), (10, -5)])
def test_a_line_needs_prices_of_at_least_one_cent(list_price: int, unit_price: int) -> None:
    with pytest.raises(ValueError):
        OrderLine(
            product_id=uuid4(),
            sku="TST-ORD-0001",
            name="Reloj de prueba",
            quantity=1,
            list_price=list_price,
            unit_price=unit_price,
            discount_amount=0,
            promotion_id=None,
            fulfillment=Fulfillment.STOCK,
            lead_time_days=None,
        )
    assert make_line(list_price=1).unit_price == 1


def test_a_refund_only_exists_in_a_cancelled_order_and_equals_the_total() -> None:
    order = build([make_line(quantity=2)])
    total = order.total_amount

    cancelled = dataclasses.replace(
        order, status=OrderStatus.CANCELLED, refunded_amount=total, refunded_at=NOW
    )
    assert cancelled.refunded_amount == total

    for status in OrderStatus:
        if status is OrderStatus.CANCELLED:
            continue
        with pytest.raises(ValueError):
            dataclasses.replace(order, status=status, refunded_amount=total)
    for wrong in (total - 1, total + 1, 0):
        with pytest.raises(ValueError):
            dataclasses.replace(order, status=OrderStatus.CANCELLED, refunded_amount=wrong)


@pytest.mark.parametrize("status", list(OrderStatus))
def test_no_refund_is_valid_in_any_status(status: OrderStatus) -> None:
    order = dataclasses.replace(build([make_line()]), status=status)
    assert order.refunded_amount is None


def test_an_order_cannot_be_rebuilt_without_lines() -> None:
    with pytest.raises(ValueError):
        dataclasses.replace(build([make_line()]), lines=())
