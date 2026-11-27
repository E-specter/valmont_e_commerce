"""Transportista, seguimiento y fecha de envío en `GET /api/v1/orders/{id}` (T-075, R-11 ruta A;
SPEC §5 `Delivery`, §7 `delivery.carrier / tracking_code / shipped_at`). El pedido se lleva a
`enviado` con el repositorio (`apply`, como lo hará el administrador en T-079) o por SQL. Datos
ficticios."""

from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_db_helpers import change
from tests.orders.orders_helpers import pickup_delivery
from tests.orders.orders_http_helpers import OrderShop, parse_utc, place, quick
from tests.orders.orders_read_helpers import db_now, headers, make_order, read_order, read_page
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.domain import ActorKind, OrderStatus

pytestmark = pytest.mark.integration

shop = helpers.shop

PENDING, PAID, PREPARING, SHIPPED, READY, DELIVERED, CANCELLED = (
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PREPARING,
    OrderStatus.SHIPPED,
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
)
NO_SHIPMENT = {"carrier": None, "tracking_code": None, "shipped_at": None}


def shipment_of(body: dict[str, Any]) -> dict[str, Any]:
    return {k: body["delivery"][k] for k in ("carrier", "tracking_code", "shipped_at")}


def advance(
    shop: OrderShop,
    order_id: UUID,
    user: UUID,
    *steps: OrderStatus,
    start: OrderStatus = PENDING,
    **shipment: str,
) -> Any:
    """Lleva el pedido por `steps` con el repositorio; el último paso a `enviado` lleva los datos
    de envío. Devuelve el instante del último cambio."""
    repository = SqlOrderRepository(shop.session)
    at = db_now(shop.session)
    current = start
    for n, step in enumerate(steps, start=1):
        at = db_now(shop.session) + timedelta(minutes=n)
        kind = ActorKind.CUSTOMER if step == PAID else ActorKind.ADMIN
        extra = shipment if step == SHIPPED else {}
        repository.apply(
            order_id,
            change(current, step, kind=kind, actor_id=user if step == PAID else None, at=at),
            paid=step == PAID,
            **extra,
        )
        current = step
    return at


# --------------------------------------------------------------------------------------------
def test_a_shipped_order_shows_carrier_tracking_and_the_shipping_instant(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)

    at = advance(
        shop, order.id, me, PAID, PREPARING, SHIPPED, carrier="Olva Courier", tracking_code="OL-123"
    )

    body = read_order(shop, me, order.id)
    assert body["status"] == "enviado"
    assert body["delivery"]["carrier"] == "Olva Courier"
    assert body["delivery"]["tracking_code"] == "OL-123"
    assert parse_utc(body["delivery"]["shipped_at"]) == at
    assert body["delivery"]["shipped_at"].endswith("Z")  # UTC (RN-15)


def test_a_shipped_order_by_sql_shows_the_same_fields(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="enviado")
    shop.session.execute(
        text(
            "UPDATE app.deliveries SET carrier = 'Shalom', tracking_code = 'SH-9981',"
            " shipped_at = now() - interval '1 hour' WHERE order_id = :id"
        ),
        {"id": order.id},
    )

    body = read_order(shop, me, order.id)

    assert (body["delivery"]["carrier"], body["delivery"]["tracking_code"]) == ("Shalom", "SH-9981")
    assert parse_utc(body["delivery"]["shipped_at"]) == db_now(shop.session) - timedelta(hours=1)


def test_a_shipment_without_carrier_or_tracking_still_shows_when_it_shipped(
    shop: OrderShop,
) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)

    at = advance(shop, order.id, me, PAID, PREPARING, SHIPPED)

    body = read_order(shop, me, order.id)
    assert shipment_of(body) == {
        "carrier": None,
        "tracking_code": None,
        "shipped_at": body["delivery"]["shipped_at"],
    }
    assert parse_utc(body["delivery"]["shipped_at"]) == at


def test_only_the_carrier_or_only_the_tracking_code_is_kept_as_given(shop: OrderShop) -> None:
    me = shop.user()
    one = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    two = make_order(shop.session, me, status="pendiente_pago", minutes_ago=6)
    advance(shop, one.id, me, PAID, PREPARING, SHIPPED, carrier="Olva")
    advance(shop, two.id, me, PAID, PREPARING, SHIPPED, tracking_code="OL-77")

    only_carrier, only_tracking = (read_order(shop, me, o.id)["delivery"] for o in (one, two))

    assert (only_carrier["carrier"], only_carrier["tracking_code"]) == ("Olva", None)
    assert (only_tracking["carrier"], only_tracking["tracking_code"]) == (None, "OL-77")


def test_a_new_order_shows_the_three_fields_as_null(shop: OrderShop) -> None:
    user, _ = quick(shop)
    created = place(shop, user).json()

    body = read_order(shop, user, created["id"])

    assert shipment_of(body) == NO_SHIPMENT
    assert shipment_of(created) == NO_SHIPMENT  # POST y GET dicen lo mismo


@pytest.mark.parametrize("status", ["pagado", "en_preparacion", "cancelado", "expirado"])
def test_an_order_not_yet_shipped_has_the_three_fields_null(shop: OrderShop, status: str) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status=status)

    assert shipment_of(read_order(shop, me, order.id)) == NO_SHIPMENT


def test_the_shipment_data_stays_after_the_delivery(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    at = advance(shop, order.id, me, PAID, PREPARING, SHIPPED, carrier="Olva", tracking_code="OL-1")
    advance(shop, order.id, me, DELIVERED, start=SHIPPED)

    body = read_order(shop, me, order.id)

    assert body["status"] == "entregado"
    assert (body["delivery"]["carrier"], body["delivery"]["tracking_code"]) == ("Olva", "OL-1")
    assert parse_utc(body["delivery"]["shipped_at"]) == at


def test_a_pickup_order_never_shows_shipment_data_along_its_whole_life(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(
        shop.session, me, status="pendiente_pago", minutes_ago=5, delivery=pickup_delivery()
    )
    seen = [shipment_of(read_order(shop, me, order.id))]

    for step, start in ((PAID, PENDING), (PREPARING, PAID), (READY, PREPARING), (DELIVERED, READY)):
        advance(shop, order.id, me, step, start=start)
        seen.append(shipment_of(read_order(shop, me, order.id)))

    assert seen == [NO_SHIPMENT] * 5
    assert read_order(shop, me, order.id)["delivery"]["pickup_store"] is not None


def test_the_history_of_a_shipped_order_is_complete_and_oldest_first(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    advance(shop, order.id, me, PAID, PREPARING, SHIPPED, carrier="Olva", tracking_code="OL-1")

    history = read_order(shop, me, order.id)["history"]

    assert [(h["from_status"], h["status"], h["actor"]) for h in history] == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "pagado", "customer"),
        ("pagado", "en_preparacion", "admin"),
        ("en_preparacion", "enviado", "admin"),
    ]


def test_the_tracking_data_of_one_order_never_shows_in_another(shop: OrderShop) -> None:
    me = shop.user()
    shipped = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    other = make_order(shop.session, me, status="pagado")
    advance(shop, shipped.id, me, PAID, PREPARING, SHIPPED, carrier="Olva", tracking_code="OL-1")

    assert shipment_of(read_order(shop, me, other.id)) == NO_SHIPMENT


def test_the_tracking_is_private_to_the_owner(shop: OrderShop) -> None:
    me, intruder = shop.user(), shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    advance(shop, order.id, me, PAID, PREPARING, SHIPPED, carrier="Olva", tracking_code="OL-SECRET")

    response = shop.client.get(f"{helpers.PATH}/{order.id}", headers=headers(intruder))

    assert response.status_code == 404 and "OL-SECRET" not in response.text


def test_the_list_summary_does_not_carry_the_shipment_data(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    advance(shop, order.id, me, PAID, PREPARING, SHIPPED, carrier="Olva", tracking_code="OL-1")

    [item] = read_page(shop, me)["items"]

    assert item["status"] == "enviado"
    assert not {"carrier", "tracking_code", "shipped_at", "delivery"} & set(item)
