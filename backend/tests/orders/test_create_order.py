"""`CreateOrder` con repositorio, carrito, inventario, reloj, boutique y auditoría falsos (T-074;
UC-ORDERS-01, ORDERS-R2, R3, R5, R6, R8, R9, R11, R13, R20; CA-ORDERS-01 a 09, 20, 21, 26). Sin BD.
Se prueba la interfaz pública: `CreateOrder(...)(user_id, key, delivery) -> CreatedOrder`."""

import re
from uuid import uuid4

import pytest

from tests.orders.orders_create_helpers import (
    KEY,
    NOW,
    STORE,
    Harness,
    checkout_line,
    harness,
    run,
)
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from valmont.modules.cart.application import CartIssue, CheckoutBlocked, EmptySelection
from valmont.modules.cart.domain import CartLineStatus
from valmont.modules.inventory.application import InsufficientStock
from valmont.modules.inventory.domain import OrderLine as StockLine
from valmont.modules.orders.application import CreatedOrder
from valmont.modules.orders.domain import (
    ActorKind,
    DeliveryMethod,
    Fulfillment,
    IdempotencyConflict,
    OrderStatus,
    PickupUnavailable,
    TooManyPendingOrders,
)

USER = uuid4()
FLOW = ["find", "prepare", "count", "reserve", "add", "remove", "audit"]


def steps(h: Harness) -> list[str]:
    return [c for c in h.calls if c != "clock" and c != "store"]


def no_writes(h: Harness) -> None:
    """Un error deja intactos pedido, carrito y auditoría: nada se guardó ni se quitó."""
    assert [c for c in h.calls if c in ("add", "remove", "audit")] == []
    assert h.orders.added == [] and h.remove.args == [] and h.audit.entries == []


# --------------------------------------------------------------------------------------------
# CA-ORDERS-01 / R8: el flujo
def test_the_flow_follows_uc_orders_01_in_order() -> None:
    h = harness(checkout_line(), checkout_line())

    result = run(h, USER)

    assert isinstance(result, CreatedOrder) and result.created is True
    assert steps(h) == FLOW
    assert h.calls.index("clock") < h.calls.index("find")  # el `now` de la BD va primero


def test_the_order_is_built_for_the_token_user_with_the_given_key_as_pending_payment() -> None:
    h = harness(checkout_line())

    order = run(h, USER).order

    assert order.user_id == USER and order.idempotency_key == KEY
    assert order.status == OrderStatus.PENDING_PAYMENT
    assert h.orders.find_args == [(USER, KEY)]  # la clave se busca para ese usuario
    assert h.prepare.args == [USER]


def test_the_returned_order_is_the_one_the_repository_saved_with_its_number() -> None:
    h = harness(checkout_line())

    order = run(h, USER).order

    assert order.number == 123 and h.orders.added == [order]


def test_remove_checked_out_items_gets_exactly_the_products_of_the_order() -> None:
    lines = [checkout_line(quantity=2), checkout_line(), checkout_line(quantity=5)]
    h = harness(*lines)

    order = run(h, USER).order

    assert [(u, set(p)) for u, p in h.remove.args] == [(USER, {ln.product_id for ln in lines})]
    assert {ln.product_id for ln in order.lines} == {ln.product_id for ln in lines}


# --------------------------------------------------------------------------------------------
# CA-ORDERS-02 / R3: la instantánea
def test_each_line_snapshots_what_the_cart_priced() -> None:
    promotion = uuid4()
    line = checkout_line(
        sku="DEMO-H38",
        name="Heritage 38",
        quantity=2,
        list_price=125_000,
        price=106_250,
        discount_amount=18_750,
        promotion_id=promotion,
    )
    h = harness(line, checkout_line())

    [first, _] = run(h, USER).order.lines

    assert (first.product_id, first.sku, first.name, first.quantity) == (
        line.product_id,
        "DEMO-H38",
        "Heritage 38",
        2,
    )
    assert (first.list_price, first.unit_price, first.discount_amount) == (125_000, 106_250, 18_750)
    assert first.promotion_id == promotion


def test_a_line_without_promotion_keeps_a_null_promotion() -> None:
    h = harness(checkout_line())

    [line] = run(h, USER).order.lines

    assert line.promotion_id is None and line.discount_amount == 0
    assert line.unit_price == line.list_price


# --------------------------------------------------------------------------------------------
# CA-ORDERS-03 / R2: importes del servidor
def test_amounts_are_computed_from_the_price_of_prepare_checkout() -> None:
    h = harness(
        checkout_line(quantity=2, list_price=125_000, price=106_250, discount_amount=18_750),
        checkout_line(quantity=3, list_price=40_000, price=40_000),
    )

    order = run(h, USER).order

    assert [ln.line_total for ln in order.lines] == [212_500, 120_000]
    assert order.subtotal_amount == 332_500
    assert order.shipping_amount == 0
    assert order.total_amount == 332_500


def test_amounts_above_two_to_the_31_are_exact_integers() -> None:
    big = 2_000_000_000
    h = harness(checkout_line(quantity=3, list_price=big, price=big), checkout_line(price=7))

    order = run(h, USER).order

    assert order.lines[0].line_total == 6_000_000_000 > 2**31
    assert order.subtotal_amount == 6_000_000_007
    assert order.total_amount == 6_000_000_007 and isinstance(order.total_amount, int)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-04 / CA-ORDERS-26 / R13: entrega
def test_the_delivery_goes_into_the_order_as_given() -> None:
    delivery = shipping_delivery(recipient_name="Luz Quispe", district="Barranco")
    h = harness(checkout_line())

    order = run(h, USER, delivery=delivery).order

    assert order.delivery == delivery
    assert order.delivery.delivery_method == DeliveryMethod.SHIPPING


def test_a_pickup_order_is_created_with_no_address_and_no_shipping_cost() -> None:
    delivery = pickup_delivery(recipient_name="Luz Quispe")
    h = harness(checkout_line())

    order = run(h, USER, delivery=delivery).order

    assert order.delivery == delivery
    assert (order.delivery.department, order.delivery.address_line) == (None, None)
    assert order.shipping_amount == 0 and order.total_amount == order.subtotal_amount
    assert steps(h) == FLOW


def test_pickup_without_a_store_fails_before_touching_anything() -> None:
    h = harness(checkout_line(), store=None)

    with pytest.raises(PickupUnavailable):
        run(h, USER, delivery=pickup_delivery())

    assert [
        c for c in h.calls if c in ("prepare", "count", "reserve", "add", "remove", "audit")
    ] == []
    assert h.orders.added == [] and h.remove.args == [] and h.audit.entries == []


def test_shipping_does_not_need_the_store() -> None:
    h = harness(checkout_line(), store=None)

    result = run(h, USER, delivery=shipping_delivery())

    assert result.created is True


# --------------------------------------------------------------------------------------------
# CA-ORDERS-05: errores de cart e inventory, sin efectos
def test_an_empty_selection_raises_and_leaves_no_effects() -> None:
    h = harness()
    h.prepare.error = EmptySelection()

    with pytest.raises(EmptySelection):
        run(h, USER)

    assert h.effects() == []
    assert h.calls.count("find") == 2  # busca la clave, y otra vez al vaciarse el carrito


def test_a_blocked_checkout_raises_with_its_issues_and_leaves_no_effects() -> None:
    issues = (CartIssue(uuid4(), CartLineStatus.OUT_OF_STOCK),)
    h = harness()
    h.prepare.error = CheckoutBlocked(issues)

    with pytest.raises(CheckoutBlocked) as error:
        run(h, USER)

    assert error.value.issues == issues
    assert h.effects() == []


def test_insufficient_stock_raises_with_its_products_and_nothing_is_saved() -> None:
    product = uuid4()
    h = harness(checkout_line(product_id=product))
    h.reserve.error = InsufficientStock((product,))

    with pytest.raises(InsufficientStock) as error:
        run(h, USER)

    assert error.value.product_ids == (product,)
    no_writes(h)


def test_a_lookup_error_from_inventory_is_not_translated() -> None:
    # Producto inexistente tras validarlo cart = error de programación (500), no un caso de negocio.
    h = harness(checkout_line())
    h.reserve.error = LookupError("producto inexistente")

    with pytest.raises(LookupError):
        run(h, USER)

    no_writes(h)


def test_nothing_is_reserved_when_the_checkout_is_blocked_or_the_cap_is_reached() -> None:
    blocked = harness()
    blocked.prepare.error = CheckoutBlocked((CartIssue(uuid4(), CartLineStatus.UNAVAILABLE),))
    capped = harness(checkout_line())
    capped.orders.pending = 3

    with pytest.raises(CheckoutBlocked):
        run(blocked, USER)
    with pytest.raises(TooManyPendingOrders):
        run(capped, USER)

    assert "reserve" not in blocked.calls and "reserve" not in capped.calls


# --------------------------------------------------------------------------------------------
# CA-ORDERS-06 / R5 / R6: reservas y un único `now`
def test_reserve_stock_gets_the_order_id_one_line_per_product_and_the_order_now() -> None:
    a, b = checkout_line(quantity=2), checkout_line(quantity=4)
    h = harness(a, b)

    order = run(h, USER).order

    [(order_id, lines, now)] = h.reserve.args
    assert order_id == order.id
    assert {(ln.product_id, ln.quantity) for ln in lines} == {(a.product_id, 2), (b.product_id, 4)}
    assert all(isinstance(ln, StockLine) for ln in lines) and len(lines) == 2
    assert now == order.created_at


def test_a_single_now_is_used_for_the_order_the_cap_and_the_reservations() -> None:
    h = harness(checkout_line())

    order = run(h, USER).order

    assert h.clock.ticks == 1  # el reloj se lee una sola vez
    assert order.created_at == NOW
    assert h.orders.count_args == [(USER, NOW)] and h.reserve.args[0][2] == NOW


def test_the_payment_window_is_thirty_minutes_from_that_now() -> None:
    h = harness(checkout_line())

    order = run(h, USER).order

    assert (order.expires_at - order.created_at).total_seconds() == 30 * 60


# --------------------------------------------------------------------------------------------
# CA-ORDERS-07 / R5: Bajo pedido
def test_lines_reserved_are_stock_and_the_rest_are_made_to_order_with_their_lead_time() -> None:
    stocked, custom = checkout_line(), checkout_line(lead_time_days=21)
    h = harness(stocked, custom)
    h.reserve.on_request = {custom.product_id: 21}

    order = run(h, USER).order

    by_product = {ln.product_id: ln for ln in order.lines}
    assert by_product[stocked.product_id].fulfillment == Fulfillment.STOCK
    assert by_product[custom.product_id].fulfillment == Fulfillment.MADE_TO_ORDER
    assert by_product[custom.product_id].lead_time_days == 21


def test_estimated_delivery_is_the_lima_date_plus_the_longest_lead_time() -> None:
    short, long_ = checkout_line(lead_time_days=10), checkout_line(lead_time_days=30)
    h = harness(checkout_line(), short, long_)
    h.reserve.on_request = {short.product_id: 10, long_.product_id: 30}

    order = run(h, USER).order

    assert order.estimated_delivery_on is not None
    assert order.estimated_delivery_on.isoformat() == "2026-12-31"  # 1 dic Lima + 30 días


def test_an_order_with_only_stock_lines_has_no_estimated_delivery() -> None:
    h = harness(checkout_line(), checkout_line())

    assert run(h, USER).order.estimated_delivery_on is None


def test_an_order_with_only_made_to_order_lines_is_created_and_still_expires() -> None:
    custom = checkout_line(lead_time_days=21)
    h = harness(custom)
    h.reserve.on_request = {custom.product_id: 21}

    order = run(h, USER).order

    assert [ln.fulfillment for ln in order.lines] == [Fulfillment.MADE_TO_ORDER]
    assert (order.expires_at - order.created_at).total_seconds() == 30 * 60
    assert steps(h) == FLOW  # igual se guarda, se vacía el carrito y se audita


def test_a_backorder_line_without_enough_stock_goes_whole_to_made_to_order() -> None:
    back = checkout_line(quantity=3, lead_time_days=14)
    h = harness(back)
    h.reserve.on_request = {back.product_id: 14}  # inventory lo dejó entero bajo pedido

    [line] = run(h, USER).order.lines

    assert line.fulfillment == Fulfillment.MADE_TO_ORDER
    assert (line.quantity, line.lead_time_days) == (3, 14)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-08 / R8: idempotencia
def test_a_repeated_key_returns_the_original_order_and_touches_nothing() -> None:
    h = harness(checkout_line())
    first = run(h, USER)
    h.calls.clear()
    h.orders.added.clear()

    again = run(h, USER, delivery=pickup_delivery(recipient_name="Otra Persona"))

    assert again.created is False and again.order == first.order  # ignora el cuerpo nuevo
    assert h.effects() == [] and "prepare" not in h.calls and "count" not in h.calls
    assert h.orders.added == []


def test_a_repeated_key_wins_even_if_the_user_is_now_at_the_pending_cap() -> None:
    h = harness(checkout_line())
    first = run(h, USER)
    h.orders.pending = 3

    again = run(h, USER)

    assert again.created is False and again.order == first.order


def test_the_same_key_of_another_user_is_a_different_order() -> None:
    h = harness(checkout_line())
    mine = run(h, USER)
    other = uuid4()

    theirs = run(h, other)

    assert theirs.created is True and theirs.order.id != mine.order.id
    assert theirs.order.user_id == other and h.orders.find_args[-1] == (other, KEY)


def test_an_empty_selection_is_a_replay_when_the_key_was_confirmed_meanwhile() -> None:
    # Otra solicitud con la misma clave confirmó mientras esta esperaba el carrito (R8, paso 2).
    h = harness(checkout_line())
    winner = run(h, USER).order
    h.orders.stored.clear()
    h.calls.clear()
    h.prepare.error = EmptySelection()
    h.prepare.on_error = lambda: h.orders.stored.__setitem__((USER, KEY), winner)

    again = run(h, USER)

    assert again.created is False and again.order == winner
    assert h.calls.count("find") == 2
    assert h.effects() == []


def test_a_unique_violation_on_insert_is_an_idempotency_conflict_with_no_further_effects() -> None:
    h = harness(checkout_line())
    h.orders.conflict = True

    with pytest.raises(IdempotencyConflict):
        run(h, USER)

    assert "remove" not in h.calls and "audit" not in h.calls  # el que llama deshace la transacción


# --------------------------------------------------------------------------------------------
# CA-ORDERS-09 / R9: tope de pedidos sin pagar
@pytest.mark.parametrize("pending", [3, 4, 10])
def test_three_or_more_pending_orders_block_a_new_one(pending: int) -> None:
    h = harness(checkout_line())
    h.orders.pending = pending

    with pytest.raises(TooManyPendingOrders):
        run(h, USER)

    assert h.effects() == []
    assert h.orders.count_args == [(USER, NOW)]


@pytest.mark.parametrize("pending", [0, 1, 2])
def test_fewer_than_three_pending_orders_still_allow_one_more(pending: int) -> None:
    h = harness(checkout_line())
    h.orders.pending = pending

    assert run(h, USER).created is True


# --------------------------------------------------------------------------------------------
# CA-ORDERS-20 / R11: historial inicial
def test_the_order_is_born_with_one_initial_history_entry_by_the_customer() -> None:
    h = harness(checkout_line())

    order = run(h, USER).order

    [entry] = order.history
    assert entry.from_status is None and entry.to_status == OrderStatus.PENDING_PAYMENT
    assert entry.actor_kind == ActorKind.CUSTOMER and entry.actor_id == USER
    assert entry.at == order.created_at and entry.note is None


# --------------------------------------------------------------------------------------------
# CA-ORDERS-21 / R11, R18: auditoría
def test_one_orders_created_audit_entry_with_actor_and_amounts_and_no_personal_data() -> None:
    h = harness(checkout_line(quantity=2), checkout_line())
    delivery = shipping_delivery(
        recipient_name="Rosa Tupac", phone="+51911222333", address_line="Jr. Secreta 999, Dpto 7"
    )

    order = run(h, USER, delivery=delivery).order

    [entry] = h.audit.entries
    assert entry.action == "orders.created"
    assert entry.entity_id == str(order.id)
    assert entry.actor_id == USER and entry.actor_role in ("customer", None)
    assert entry.before is None
    assert entry.after is not None
    assert set(entry.after) == {"status", "number", "total_amount", "line_count"}
    assert entry.after["status"] == "pendiente_pago"
    assert entry.after["total_amount"] == order.total_amount
    assert entry.after["line_count"] == 2
    assert re.sub(r"\D", "", str(entry.after["number"])).lstrip("0") == "123"
    dump = repr(entry)
    for personal in ("Rosa", "Tupac", "911222333", "Secreta", "Dpto", "Miraflores", "Larco"):
        assert personal not in dump


def test_nothing_is_audited_on_a_replay() -> None:
    h = harness(checkout_line())
    run(h, USER)

    run(h, USER)

    assert len(h.audit.entries) == 1


def test_the_audit_is_recorded_after_the_order_is_saved_and_the_cart_emptied() -> None:
    h = harness(checkout_line())

    run(h, USER)

    assert h.calls.index("add") < h.calls.index("remove") < h.calls.index("audit")


def test_the_pickup_store_is_not_copied_into_the_order_snapshot() -> None:
    # H-5: la boutique vigente se lee de Settings al mostrar el pedido, no se congela.
    h = harness(checkout_line())

    order = run(h, USER, delivery=pickup_delivery()).order

    assert STORE.name not in repr(order.delivery) and STORE.address not in repr(order)


def test_a_repeated_pickup_key_is_a_replay_even_if_the_store_is_gone_now() -> None:
    # La idempotencia va antes que la comprobación de la boutique (decisión del Leader, T-074).
    h = harness(checkout_line())
    first = run(h, USER, delivery=pickup_delivery())
    h.store.store = None
    h.calls.clear()

    again = run(h, USER, delivery=pickup_delivery())

    assert again.created is False and again.order == first.order
    assert h.effects() == []
