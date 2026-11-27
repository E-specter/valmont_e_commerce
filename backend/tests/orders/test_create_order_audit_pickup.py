"""Historial, auditoría y recojo en tienda de `POST /api/v1/orders` contra PostgreSQL (T-074;
CA-ORDERS-20, 21 y 26 en lo que toca a la creación; SPEC §4 R11, R13, R18 y R20, H-1 a H-6).
La auditoría es la real (`app.audit_log` es de solo inserción: nada se confirma). Ficticios."""

import logging
import re
from typing import Any

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed, lines_of
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import (
    PERSONAL,
    PICKUP,
    SHIPPING,
    STORE_ENV,
    OrderShop,
    audit_rows,
    effects,
    money,
    order_row,
    place,
    quick,
    reservations,
    scalar,
    stock_in_cart,
)

pytestmark = pytest.mark.integration

shop = helpers.shop
STORE = {
    "name": STORE_ENV["PICKUP_STORE_NAME"],
    "address": STORE_ENV["PICKUP_STORE_ADDRESS"],
    "hours": STORE_ENV["PICKUP_STORE_HOURS"],
}
PRIVATE = (*PERSONAL, "Torres", "+51987654321", "Av. Larco")


def history_rows(shop: OrderShop, order_id: object) -> list[tuple[Any, ...]]:
    rows = shop.session.execute(
        text(
            "SELECT from_status, to_status, actor_kind, actor_id, note, created_at"
            " FROM app.order_status_history WHERE order_id = :id ORDER BY id"
        ),
        {"id": order_id},
    )
    return [tuple(r) for r in rows]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-20 / R11: historial inicial
def test_a_new_order_has_exactly_one_initial_history_row_by_the_customer(shop: OrderShop) -> None:
    user, _ = quick(shop)

    body = place(shop, user).json()

    created = order_row(shop.session, body["id"])["created_at"]
    assert history_rows(shop, body["id"]) == [
        (None, "pendiente_pago", "customer", user, None, created)
    ]
    assert body["history"] == [
        {
            "from_status": None,
            "status": "pendiente_pago",
            "at": body["created_at"],
            "actor": "customer",
        }
    ]


def test_a_replay_does_not_add_history(shop: OrderShop) -> None:
    user, _ = quick(shop)
    key = "6926408e-0576-572c-9e11-b1e554c68897"
    first = place(shop, user, key=key).json()

    place(shop, user, key=key)

    assert len(history_rows(shop, first["id"])) == 1


def test_a_failed_attempt_leaves_no_history_for_the_customer(shop: OrderShop) -> None:
    user = shop.user()
    sold_out = add_listed(shop.session, on_hand=0)
    stock_in_cart(shop, user, (sold_out, 1))

    assert place(shop, user).status_code == 409

    assert effects(shop.session, user)["history"] == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-21 / R11, R18: auditoría
def test_creation_is_audited_with_the_actor_the_entity_and_the_amounts(shop: OrderShop) -> None:
    user = shop.user()
    a, b = (
        add_listed(shop.session, price=100000, on_hand=5),
        add_listed(shop.session, price=50000, on_hand=5),
    )
    stock_in_cart(shop, user, (a, 2), (b, 1))

    body = place(shop, user).json()

    [entry] = audit_rows(shop.session, action="orders.created", entity_id=body["id"])
    assert entry["actor_id"] == user and entry["actor_role"] == "customer"
    assert entry["before"] is None
    after = entry["after"]
    assert set(after) == {"status", "number", "total_amount", "line_count"}
    assert after["status"] == "pendiente_pago"
    assert after["total_amount"] == 250000 and after["line_count"] == 2
    number = order_row(shop.session, body["id"])["order_number"]
    assert re.sub(r"\D", "", str(after["number"])).lstrip("0") == str(number)


def test_one_audit_entry_per_order_and_none_for_a_replay(shop: OrderShop) -> None:
    user, _ = quick(shop)
    key = "a3b3b62b-2a39-52cd-a8e9-3dda6ef56bee"
    first = place(shop, user, key=key).json()
    place(shop, user, key=key)
    other = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (other, 1))
    next_order = place(shop, user).json()

    entries = audit_rows(shop.session, actor_id=user, action="orders.created")

    assert sorted(e["entity_id"] for e in entries) == sorted([first["id"], next_order["id"]])


def test_the_audit_entry_has_no_name_phone_or_address(shop: OrderShop) -> None:
    user, _ = quick(shop)
    delivery = SHIPPING | {
        "recipient_name": "Rosa Tupac",
        "phone": "+51911222333",
        "address_line": "Jr. Secreta 999, Dpto 7",
        "reference": "Casa azul",
    }

    body = place(shop, user, delivery=delivery).json()

    [entry] = audit_rows(shop.session, entity_id=body["id"])
    dump = repr(entry)
    for personal in (
        "Rosa",
        "Tupac",
        "911222333",
        "Secreta",
        "Dpto",
        "Casa azul",
        "Miraflores",
        "Lima",
    ):
        assert personal not in dump, personal


def test_a_pickup_order_audit_has_no_personal_data_either(shop: OrderShop) -> None:
    user, _ = quick(shop)

    body = place(shop, user, delivery=PICKUP | {"recipient_name": "Rosa Tupac"}).json()

    dump = repr(audit_rows(shop.session, entity_id=body["id"]))
    assert "Rosa" not in dump and "987654321" not in dump and "Boutique" not in dump


@pytest.mark.parametrize("outcome", ["created", "replay", "invalid", "blocked", "empty", "pickup"])
def test_logs_never_contain_the_name_the_phone_or_the_address(
    shop: OrderShop, caplog: pytest.LogCaptureFixture, outcome: str
) -> None:
    caplog.set_level(logging.DEBUG)
    user = shop.user()
    product = add_listed(shop.session, on_hand=0 if outcome == "blocked" else 5)
    if outcome != "empty":
        stock_in_cart(shop, user, (product, 1))
    key = "3e8ac10d-e5c7-5743-b0fe-03adefd738e9"
    delivery: dict[str, Any] = SHIPPING
    if outcome == "invalid":
        delivery = SHIPPING | {"phone": "x"}
    if outcome == "pickup":
        delivery = PICKUP
        shop.set_store()  # sin boutique: 409
    if outcome == "replay":
        place(shop, user, key=key)

    place(shop, user, key=key, delivery=delivery)

    for personal in PRIVATE:
        assert personal not in caplog.text, personal


# --------------------------------------------------------------------------------------------
# CA-ORDERS-26 / R13, R20: recojo en tienda
def test_a_pickup_order_is_created_without_an_address_and_shows_the_store(shop: OrderShop) -> None:
    user, _ = quick(shop, price=100000)

    response = place(shop, user, delivery=PICKUP)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["delivery"] == {
        "delivery_method": "pickup",
        "recipient_name": "Ana Torres",
        "phone": "+51987654321",
        "department": None,
        "province": None,
        "district": None,
        "address_line": None,
        "reference": None,
        "pickup_store": STORE,
        "carrier": None,
        "tracking_code": None,
        "shipped_at": None,
    }
    assert body["shipping"] == money(0) and body["total"] == body["subtotal"] == money(100000)
    assert body["status"] == "pendiente_pago" and body["can_cancel"] is True
    stored = (
        shop.session.execute(
            text("SELECT * FROM app.deliveries WHERE order_id = :id"), {"id": body["id"]}
        )
        .mappings()
        .one()
    )
    assert stored["delivery_method"] == "pickup"
    assert stored["recipient_name"] == "Ana Torres" and stored["phone"] == "+51987654321"
    for column in ("department", "province", "district", "address_line", "reference",
                   "carrier", "tracking_code", "shipped_at"):  # fmt: skip
        assert stored[column] is None, column


def test_a_shipping_order_has_no_store_even_when_one_is_configured(shop: OrderShop) -> None:
    user, _ = quick(shop)

    body = place(shop, user).json()

    assert body["delivery"]["pickup_store"] is None


def test_the_store_shown_is_the_current_one_not_a_copy_frozen_in_the_order(shop: OrderShop) -> None:
    user, _ = quick(shop)
    key = "bf3c7833-c210-5f2f-ad3f-f6b82e91cbd7"
    first = place(shop, user, key=key, delivery=PICKUP)
    assert first.json()["delivery"]["pickup_store"] == STORE

    shop.set_store(name="Boutique Valmont San Isidro", address="Calle Los Pinos 55", hours="10-18")
    again = place(shop, user, key=key, delivery=PICKUP)

    assert again.status_code == 200
    assert again.json()["delivery"]["pickup_store"] == {
        "name": "Boutique Valmont San Isidro",
        "address": "Calle Los Pinos 55",
        "hours": "10-18",
    }
    assert again.json()["id"] == first.json()["id"]


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"name": "", "address": "", "hours": ""},
        {"name": "   ", "address": "Av. Larco 1", "hours": "10-18"},
        {"name": "Boutique", "address": "\t", "hours": "10-18"},
        {"name": "Boutique", "address": "Av. Larco 1", "hours": " "},
        {"name": "Boutique", "address": "Av. Larco 1"},
        {"address": "Av. Larco 1", "hours": "10-18"},
    ],
)
def test_pickup_without_a_complete_store_is_409_and_changes_nothing(
    shop: OrderShop, config: dict[str, str]
) -> None:
    user, product = quick(shop)
    shop.set_store(**config)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=PICKUP)

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "pickup_unavailable"
    assert set(response.json()["error"]) == {"code", "message", "details"}
    assert effects(shop.session, user, product) == before
    assert before["orders"] == before["reservations"] == 0
    assert helpers.available(shop.session, product) == 5


def test_shipping_still_works_when_no_store_is_configured(shop: OrderShop) -> None:
    user, _ = quick(shop)
    shop.set_store()

    response = place(shop, user, delivery=SHIPPING)

    assert response.status_code == 201, response.text
    assert response.json()["delivery"]["pickup_store"] is None


@pytest.mark.parametrize("cart", ["empty", "blocked"])
def test_the_store_is_checked_before_the_cart(shop: OrderShop, cart: str) -> None:
    # "Antes de tocar nada": ni siquiera se bloquea ni se lee el carrito.
    user = shop.user()
    shop.set_store()
    if cart == "blocked":
        stock_in_cart(shop, user, (add_listed(shop.session, on_hand=0), 1))

    response = place(shop, user, delivery=PICKUP)

    assert response.status_code == 409 and response.json()["error"]["code"] == "pickup_unavailable"


def test_a_pickup_order_with_made_to_order_lines_has_an_estimated_availability(
    shop: OrderShop,
) -> None:
    # H-6: misma fórmula que el envío.
    user, _ = quick(shop, policy="made_to_order", on_hand=None)

    body = place(shop, user, delivery=PICKUP).json()

    assert body["estimated_delivery_on"] is not None
    assert body["delivery"]["pickup_store"] == STORE


def test_a_pickup_order_reserves_stock_and_empties_the_cart_like_any_other(shop: OrderShop) -> None:
    user = shop.user()
    bought, left = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=5)
    cart_id = stock_in_cart(shop, user, (bought, 2), (left, 1, False))

    body = place(shop, user, delivery=PICKUP).json()

    assert [
        (r["product_id"], r["quantity"], r["status"])
        for r in reservations(shop.session, body["id"])
    ] == [(bought, 2, "active")]
    assert lines_of(shop.session, cart_id) == {left: (1, False)}
    assert (
        scalar(
            shop.session,
            "SELECT delivery_method FROM app.deliveries WHERE order_id = :id",
            id=body["id"],
        )
        == "pickup"
    )


def test_repeating_a_pickup_key_without_a_store_returns_the_original_order_with_200(
    shop: OrderShop,
) -> None:
    # La idempotencia va antes que la comprobación de la boutique (decisión del Leader, T-074).
    user, product = quick(shop)
    key = "d937b1f9-05d1-59e3-9282-5ec92d70d8fa"
    first = place(shop, user, key=key, delivery=PICKUP)
    assert first.status_code == 201
    shop.set_store()
    before = effects(shop.session, user, product)

    again = place(shop, user, key=key, delivery=PICKUP)

    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"]
    assert again.json()["delivery"]["pickup_store"] is None  # la vigente: no hay ninguna
    assert effects(shop.session, user, product) == before
