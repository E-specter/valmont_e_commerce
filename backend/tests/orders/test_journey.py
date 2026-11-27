"""Recorrido completo de orders de punta a punta (T-080; CA-ORDERS-01, 03, 06, 07, 12, 14, 18, 19,
20, 21 y 26 juntos): carrito → `POST /orders` → `ConfirmOrderPayment` real → `en_preparacion` →
`enviado` o `listo_para_recojo` → `entregado`, para `shipping` y `pickup`, por HTTP y por casos de
uso; y los caminos de cancelación (del cliente sin pagar y del administrador con reembolso). En
cada paso se comprueban importes, stock (`on_hand`, disponible, reservas, movimientos), historial y
auditoría reales (`SqlAuditRecorder`, también en el pago).

Cart, inventory, promotions, audit y orders reales contra valmont_test; cada prueba corre en la
transacción de la fixture `shop` (o `db_session`) y se deshace al terminar. Datos ficticios."""

from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_cart, add_item, add_listed, add_profile
from tests.inventory.inventory_helpers import consume_reservations, release_reservations
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import admin_of, admin_order
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from tests.orders.orders_http_helpers import (
    PICKUP,
    OrderShop,
    audit_rows,
    available,
    effects,
    on_hand,
    order_row,
    place,
    reservations,
    stock_in_cart,
)
from tests.orders.orders_read_helpers import headers, read_order
from tests.orders.orders_transition_helpers import history_of, moved, stock_movements
from tests.promotions.promotions_helpers import add_promotion
from valmont.modules.audit.adapters.persistence import SqlAuditRecorder
from valmont.modules.cart.adapters.wiring import get_prepare_checkout, get_remove_checked_out_items
from valmont.modules.inventory.adapters.wiring import get_reserve_stock
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.application import (
    Actor,
    AdminOrderQuery,
    CancelMyOrder,
    ConfirmOrderPayment,
    CreateOrder,
    ExpireOverdueOrders,
    GetAdminOrder,
    GetMyOrder,
    GetPayableOrder,
    ListAdminOrders,
    ListMyOrders,
    PaymentOutcome,
    PickupStore,
    TransitionOrder,
)
from valmont.modules.orders.domain import (
    ActorKind,
    DeliveryMethod,
    OrderNotPayable,
    OrderStatus,
)

pytestmark = pytest.mark.integration

shop = helpers.shop

WATCH_PRICE = 1_500_000_000  # dos unidades: 3 000 000 000 céntimos, por encima de 2³¹
STRAP_PRICE = 250_000
STORE = PickupStore("Boutique Valmont Miraflores", "Av. Larco 1234", "10:00 a 19:00")


def pay(session: Session, user: UUID, order_id: object) -> PaymentOutcome:
    """`ConfirmOrderPayment` real con la auditoría en la BD, como lo llamará payments."""
    confirm = ConfirmOrderPayment(
        SqlOrderRepository(session),
        consume_reservations(session),
        release_reservations(session),
        SqlAuditRecorder(session),
        SqlClock(session),
    )
    with session.begin_nested():
        return confirm(user, UUID(str(order_id)))


def payable(session: Session, user: UUID, order_id: object) -> Any:
    orders = SqlOrderRepository(session)
    expire = ExpireOverdueOrders(
        orders, release_reservations(session), SqlAuditRecorder(session), SqlClock(session)
    )
    return GetPayableOrder(orders, expire)(user, UUID(str(order_id)))


def audit_trail(session: Session, order_id: object) -> list[tuple[Any, ...]]:
    """(acción, rol, actor, before, after) de cada entrada de auditoría del pedido."""
    return [
        (a["action"], a["actor_role"], a["actor_id"], a["before"], a["after"])
        for a in audit_rows(session, entity_id=str(order_id))
    ]


def steps_of(session: Session, order_id: object) -> list[tuple[Any, Any, Any]]:
    return [(r[0], r[1], r[2]) for r in history_of(session, order_id)]


# --------------------------------------------------------------------------------------------
# Por HTTP: envío a domicilio y recojo en tienda hasta `entregado`


@pytest.mark.parametrize("method", ["shipping", "pickup"])
def test_the_whole_journey_by_http_from_the_cart_to_delivered(shop: OrderShop, method: str) -> None:
    pickup = method == "pickup"
    user, admin = shop.user(), admin_of(shop)
    watch = add_listed(shop.session, price=WATCH_PRICE, on_hand=5)
    strap = add_listed(shop.session, price=STRAP_PRICE, policy="made_to_order", on_hand=None)
    kept = add_listed(shop.session, price=90_000, on_hand=3)
    stock_in_cart(shop, user, (watch, 2), (strap, 1), (kept, 1, False))
    total = 2 * WATCH_PRICE + STRAP_PRICE

    # 1. Crear: importe del servidor, reserva de 30 min, carrito sin lo comprado.
    created = place(shop, user, delivery=PICKUP if pickup else None)
    assert created.status_code == 201, created.text
    order = created.json()
    order_id = order["id"]
    assert order["status"] == "pendiente_pago" and order["can_cancel"] is True
    assert order["subtotal"]["amount"] == order["total"]["amount"] == total
    assert order["shipping"]["amount"] == 0 and order["item_count"] == 3
    by_product = {line["product_id"]: line for line in order["lines"]}
    assert by_product[str(watch)]["fulfillment"] == "stock"
    assert by_product[str(watch)]["line_total"]["amount"] == 2 * WATCH_PRICE
    assert (by_product[str(strap)]["fulfillment"], by_product[str(strap)]["lead_time_days"]) == (
        "made_to_order",
        21,
    )
    assert order["estimated_delivery_on"] is not None  # el mayor plazo de Bajo pedido
    if pickup:
        assert order["delivery"]["address_line"] is None
        assert order["delivery"]["pickup_store"]["name"] == helpers.STORE_ENV["PICKUP_STORE_NAME"]
    else:
        assert order["delivery"]["pickup_store"] is None
    assert effects(shop.session, user)["cart"] == {kept: (1, False)}
    [reserved] = reservations(shop.session, order_id)
    assert (reserved["product_id"], reserved["quantity"], reserved["status"]) == (
        watch,
        2,
        "active",
    )
    assert reserved["expires_at"] == order_row(shop.session, order_id)["expires_at"]
    assert (on_hand(shop.session, watch), available(shop.session, watch)) == (5, 3)
    assert steps_of(shop.session, order_id) == [(None, "pendiente_pago", "customer")]

    # 2. Lo que payments cobrará y el pago real: descuenta el stock una sola vez.
    due = payable(shop.session, user, order_id)
    assert (due.status, due.total_amount, due.number) == (
        OrderStatus.PENDING_PAYMENT,
        total,
        order["number"],
    )
    assert pay(shop.session, user, order_id) == PaymentOutcome.PAID
    assert pay(shop.session, user, order_id) == PaymentOutcome.ALREADY_PAID
    assert (on_hand(shop.session, watch), available(shop.session, watch)) == (3, 3)
    assert [r["status"] for r in reservations(shop.session, order_id)] == ["consumed"]
    assert stock_movements(shop.session, order_id) == [("venta", -2)]
    after_payment = read_order(shop, user, order_id)
    assert after_payment["status"] == "pagado" and after_payment["paid_at"] is not None
    assert after_payment["can_cancel"] is False and after_payment["expires_at"] is None

    # 3. El administrador lo lleva hasta la entrega por la rama de su modalidad.
    handed = "listo_para_recojo" if pickup else "enviado"
    expected_targets = {
        "pagado": ["en_preparacion", "cancelado"],
        "en_preparacion": [handed, "cancelado"],
        handed: ["entregado"],
        "entregado": [],
    }
    previous = "pagado"
    for to in ("en_preparacion", handed, "entregado"):
        assert admin_order(shop, admin, order_id)["can_transition_to"] == expected_targets[previous]
        fields = {"carrier": "Olva", "tracking_code": "OL-123"} if to == "enviado" else {}
        body = moved(shop, admin, order_id, to, note=f"paso {to}", **fields)
        assert body["status"] == to and body["total"]["amount"] == total
        assert (on_hand(shop.session, watch), available(shop.session, watch)) == (3, 3)
        previous = to
    assert admin_order(shop, admin, order_id)["can_transition_to"] == []
    assert stock_movements(shop.session, order_id) == [("venta", -2)]  # ningún paso toca stock

    # 4. Lo que queda: historial completo, auditoría sin datos personales y vista del cliente.
    assert steps_of(shop.session, order_id) == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "pagado", "customer"),
        ("pagado", "en_preparacion", "admin"),
        ("en_preparacion", handed, "admin"),
        (handed, "entregado", "admin"),
    ]
    trail = audit_trail(shop.session, order_id)
    assert [(t[0], t[1], t[2]) for t in trail] == [
        ("orders.created", "customer", user),
        ("orders.status_changed", "customer", user),
        ("orders.status_changed", "admin", admin),
        ("orders.status_changed", "admin", admin),
        ("orders.status_changed", "admin", admin),
    ]
    assert trail[0][4] == {
        "status": "pendiente_pago",
        "number": int(order["number"].removeprefix("VAL-")),
        "total_amount": total,
        "line_count": 2,
    }
    final = read_order(shop, user, order_id)
    assert final["status"] == "entregado" and final["refund"] is None
    assert [h["status"] for h in final["history"]][-1] == "entregado"
    assert all(set(h) == {"from_status", "status", "at", "actor"} for h in final["history"])
    shipped = final["delivery"]
    if pickup:
        assert (shipped["carrier"], shipped["tracking_code"], shipped["shipped_at"]) == (
            None,
            None,
            None,
        )
    else:
        assert (shipped["carrier"], shipped["tracking_code"]) == ("Olva", "OL-123")
        assert shipped["shipped_at"] is not None


@pytest.mark.parametrize("method", ["shipping", "pickup"])
def test_the_admin_cancels_a_preparing_order_and_refunds_the_total_without_restocking(
    shop: OrderShop, method: str
) -> None:
    pickup = method == "pickup"
    user, admin = shop.user(), admin_of(shop)
    watch = add_listed(shop.session, price=WATCH_PRICE, on_hand=4)
    promoted = add_listed(shop.session, price=1_000_000, on_hand=4)
    add_promotion(shop.session, kind="percent", value=20, scope="products", product_ids=[promoted])
    stock_in_cart(shop, user, (watch, 2), (promoted, 1))
    order = place(shop, user, delivery=PICKUP if pickup else None).json()
    total = 2 * WATCH_PRICE + 800_000
    assert order["total"]["amount"] == total  # precio vigente de promotions

    assert pay(shop.session, user, order["id"]) == PaymentOutcome.PAID
    moved(shop, admin, order["id"], "en_preparacion")
    body = moved(shop, admin, order["id"], "cancelado", note="Cliente desiste")

    assert body["status"] == "cancelado" and body["refund"]["amount"]["amount"] == total
    row = order_row(shop.session, order["id"])
    assert (row["refunded_amount"], row["total_amount"]) == (total, total)
    assert (on_hand(shop.session, watch), on_hand(shop.session, promoted)) == (2, 3)  # R15
    assert sorted(stock_movements(shop.session, order["id"])) == [("venta", -2), ("venta", -1)]
    assert audit_trail(shop.session, order["id"])[-1][3:] == (
        {"status": "en_preparacion"},
        {"status": "cancelado", "refunded_amount": total},
    )
    customer_view = read_order(shop, user, order["id"])
    assert customer_view["refund"]["amount"]["amount"] == total
    assert all("note" not in h for h in customer_view["history"])

    # Ni otro reembolso, ni un pago, ni la cancelación del cliente cambian ya nada.
    again = shop.client.post(
        f"{helpers.PATH}/admin/{order['id']}/transitions",
        headers=headers(admin),
        json={"to": "cancelado", "note": "otra vez"},
    )
    assert again.status_code == 409
    with pytest.raises(OrderNotPayable):
        pay(shop.session, user, order["id"])
    mine = shop.client.post(f"{helpers.PATH}/{order['id']}/cancel", headers=headers(user))
    assert mine.status_code == 200 and mine.json()["refund"]["amount"]["amount"] == total
    assert order_row(shop.session, order["id"])["refunded_amount"] == total
    assert len(history_of(shop.session, order["id"])) == 4


def test_the_customer_cancels_before_paying_the_stock_comes_back_and_can_be_bought_again(
    shop: OrderShop,
) -> None:
    user = shop.user()
    watch = add_listed(shop.session, price=WATCH_PRICE, on_hand=1)  # la última unidad
    stock_in_cart(shop, user, (watch, 1))
    order = place(shop, user).json()
    assert available(shop.session, watch) == 0

    cancelled = shop.client.post(f"{helpers.PATH}/{order['id']}/cancel", headers=headers(user))

    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelado"
    assert cancelled.json()["refund"] is None
    assert [r["status"] for r in reservations(shop.session, order["id"])] == ["released"]
    assert (on_hand(shop.session, watch), available(shop.session, watch)) == (1, 1)
    assert stock_movements(shop.session, order["id"]) == []
    with pytest.raises(OrderNotPayable):
        pay(shop.session, user, order["id"])
    other = shop.user()
    stock_in_cart(shop, other, (watch, 1))
    assert place(shop, other).status_code == 201  # la unidad liberada se vende a otro
    assert available(shop.session, watch) == 0
    assert [t[0] for t in audit_trail(shop.session, order["id"])] == [
        "orders.created",
        "orders.status_changed",
    ]


# --------------------------------------------------------------------------------------------
# Por casos de uso (sin HTTP), como los compondrá payments o un proceso: los mismos efectos


class Store:
    def get(self) -> PickupStore | None:
        return STORE


def use_cases(session: Session) -> dict[str, Any]:
    orders, clock, audit = SqlOrderRepository(session), SqlClock(session), SqlAuditRecorder(session)
    release = release_reservations(session)
    expire = ExpireOverdueOrders(orders, release, audit, clock)
    return {
        "create": CreateOrder(
            orders,
            get_prepare_checkout(session),
            get_remove_checked_out_items(session),
            get_reserve_stock(session),
            Store(),
            clock,
            audit,
        ),
        "mine": GetMyOrder(orders, expire),
        "list_mine": ListMyOrders(orders, expire),
        "cancel": CancelMyOrder(orders, expire, release, audit, clock),
        "admin_list": ListAdminOrders(orders, expire),
        "admin_get": GetAdminOrder(orders, expire),
        "transition": TransitionOrder(orders, expire, release, audit, clock),
    }


def cart_with(session: Session, user: UUID, *lines: tuple[UUID, int]) -> None:
    cart = add_cart(session, user)
    for product, quantity in lines:
        add_item(session, cart, product, quantity)


@pytest.mark.parametrize("method", [DeliveryMethod.SHIPPING, DeliveryMethod.PICKUP])
def test_the_whole_journey_by_use_cases_leaves_the_same_facts(
    db_session: Session, method: DeliveryMethod
) -> None:
    session = db_session
    user, admin = add_profile(session), Actor(add_profile(session), ActorKind.ADMIN)
    watch = add_listed(session, price=WATCH_PRICE, on_hand=3)
    cart_with(session, user, (watch, 2))
    run = use_cases(session)
    delivery = pickup_delivery() if method == DeliveryMethod.PICKUP else shipping_delivery()

    created = run["create"](user, "clave-recorrido-uc-0001", delivery)
    order = created.order
    assert created.created and order.status == OrderStatus.PENDING_PAYMENT
    assert order.total_amount == 2 * WATCH_PRICE > 2**31
    assert run["create"](user, "clave-recorrido-uc-0001", delivery).created is False
    assert run["mine"](user, order.id).id == order.id
    assert [o.id for o in run["list_mine"](user, statuses=None, page=1, page_size=20).items] == [
        order.id
    ]
    assert pay(session, user, order.id) == PaymentOutcome.PAID
    assert on_hand(session, watch) == 1

    handed = (
        OrderStatus.READY_FOR_PICKUP if method == DeliveryMethod.PICKUP else OrderStatus.SHIPPED
    )
    for to in (OrderStatus.PREPARING, handed, OrderStatus.DELIVERED):
        moved_order = run["transition"](admin, order.id, to, note=f"paso {to.value}")
        assert moved_order.status == to and moved_order.total_amount == order.total_amount

    final = run["admin_get"](order.id)
    assert final.status == OrderStatus.DELIVERED and final.refunded_amount is None
    assert [(c.from_status, c.to_status, c.actor_kind) for c in final.history] == [
        (None, OrderStatus.PENDING_PAYMENT, ActorKind.CUSTOMER),
        (OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, ActorKind.CUSTOMER),
        (OrderStatus.PAID, OrderStatus.PREPARING, ActorKind.ADMIN),
        (OrderStatus.PREPARING, handed, ActorKind.ADMIN),
        (handed, OrderStatus.DELIVERED, ActorKind.ADMIN),
    ]
    assert on_hand(session, watch) == 1 and stock_movements(session, order.id) == [("venta", -2)]
    page = run["admin_list"](
        AdminOrderQuery(OrderStatus.DELIVERED, str(order.number), None, None, 1, 5)
    )
    assert [o.id for o in page.items] == [order.id]
    trail = audit_trail(session, order.id)
    assert [t[1] for t in trail] == ["customer", "customer", "admin", "admin", "admin"]
    assert all(t[2] == admin.user_id for t in trail[2:])
    rows = session.execute(
        text("SELECT before::text, after::text FROM app.audit_log WHERE entity_id = :id"),
        {"id": str(order.id)},
    ).all()
    personal = (delivery.recipient_name, delivery.phone, delivery.address_line or "§")
    assert all(p not in str(row) for row in rows for p in personal)


def test_the_cancel_journey_by_use_cases_releases_and_never_charges(db_session: Session) -> None:
    session = db_session
    user = add_profile(session)
    watch = add_listed(session, price=WATCH_PRICE, on_hand=2)
    cart_with(session, user, (watch, 2))
    run = use_cases(session)

    order = run["create"](user, "clave-cancelar-uc-00001", shipping_delivery()).order
    assert available(session, watch) == 0
    cancelled = run["cancel"](user, order.id)

    assert cancelled.status == OrderStatus.CANCELLED and cancelled.refunded_amount is None
    assert available(session, watch) == 2 and on_hand(session, watch) == 2
    assert run["cancel"](user, order.id).history == cancelled.history  # idempotente
    with pytest.raises(OrderNotPayable):
        pay(session, user, order.id)
    assert stock_movements(session, order.id) == []
