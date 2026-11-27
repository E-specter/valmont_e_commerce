"""`POST /api/v1/orders` con precios, reservas y rollback reales (T-074; CA-ORDERS-02, 03, 05, 06,
07, 09; SPEC §4 R2 a R6 y R9, §7 "Crear"). Cart, inventory y promotions son los reales; solo se
sustituye un proveedor cuando hay que forzar una carrera que HTTP no puede producir sin hilos
(`insufficient_stock` tras validar, `idempotency_conflict`). Datos ficticios; todo se deshace."""

from datetime import timedelta, timezone
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed, carts_of, identity_of, lines_of, set_product
from tests.inventory.inventory_helpers import reserve_stock
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import (
    OrderShop,
    available,
    effects,
    fresh_key,
    line_rows,
    money,
    on_hand,
    order_row,
    parse_utc,
    place,
    quick,
    reservations,
    stock_in_cart,
)
from tests.promotions.promotions_helpers import add_promotion
from valmont.modules.inventory.adapters.wiring import get_reserve_stock
from valmont.modules.inventory.application import InsufficientStock
from valmont.modules.orders.adapters.http import get_orders
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.shared.db import SessionDep

pytestmark = pytest.mark.integration

shop = helpers.shop
LIMA = timezone(timedelta(hours=-5))
INT32_MAX = 2**31 - 1


class ReserveThenFail:
    """El `ReserveStock` real, que reserva de verdad, y después falla: así se ve que el error
    deshace las reservas ya hechas en la misma transacción (ORDERS-R4)."""

    def __init__(self, session: Any, error: Exception) -> None:
        self._real = reserve_stock(session)
        self._error = error

    def __call__(self, order_id: UUID, lines: Any, now: Any) -> Any:
        self._real(order_id, lines, now)
        raise self._error


def reserve_fails_with(shop: OrderShop, error: Exception) -> None:
    def provider(session: SessionDep) -> ReserveThenFail:
        return ReserveThenFail(session, error)

    shop.override(get_reserve_stock, provider)


class BlindToKeys(SqlOrderRepository):
    """Repositorio real que no encuentra nunca la clave: la solicitud llega a insertar y choca con
    `UNIQUE (user_id, idempotency_key)`, como en la carrera extrema de ORDERS-R8."""

    def find_by_key(self, user_id: UUID, key: str) -> None:
        return None


def blind_provider(session: SessionDep) -> BlindToKeys:
    return BlindToKeys(session)


def error_of(response: Any, status: int, code: str) -> Any:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code, body
    assert "Traceback" not in response.text
    return body["error"]["details"]


def without_images(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [{k: v for k, v in ln.items() if k != "image"} for ln in body["lines"]]


def lines_by_product(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {ln["product_id"]: ln for ln in body["lines"]}


# --------------------------------------------------------------------------------------------
# CA-ORDERS-02 / R3: instantánea
def test_the_line_snapshot_does_not_change_when_catalog_promotions_or_stock_change(
    shop: OrderShop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=100000, on_hand=5, name="Heritage 38")
    promotion = add_promotion(
        shop.session, kind="percent", value=10, scope="products", product_ids=[product]
    )
    sku, _, _ = identity_of(shop.session, product)
    stock_in_cart(shop, user, (product, 2))
    key = "cd200e9b-f68b-51b4-b606-972ed28e322c"
    first = place(shop, user, key=key)
    assert first.status_code == 201, first.text

    set_product(shop.session, product, name="Renombrado", price_cents=900000)
    shop.session.execute(text("UPDATE app.promotions SET is_active = false"))
    shop.session.execute(text("UPDATE app.inventory_items SET on_hand = 0"))
    replay = place(shop, user, key=key)

    assert replay.status_code == 200
    assert without_images(replay.json()) == without_images(first.json())
    assert replay.json()["total"] == first.json()["total"] == money(180000)
    [row] = line_rows(shop.session, first.json()["id"])
    assert (row["sku"], row["name"], row["quantity"]) == (sku, "Heritage 38", 2)
    assert (row["list_price_amount"], row["unit_price_amount"]) == (100000, 90000)
    assert (row["discount_amount"], row["line_total_amount"]) == (10000, 180000)
    assert row["promotion_id"] == promotion and row["product_id"] == product
    assert row["fulfillment"] == "stock"


# --------------------------------------------------------------------------------------------
# CA-ORDERS-03 / R2: el precio sale del servidor
def test_the_unit_price_is_the_current_promotion_price_and_totals_are_exact(
    shop: OrderShop,
) -> None:
    user = shop.user()
    promoted = add_listed(shop.session, price=1250000, on_hand=9)
    plain = add_listed(shop.session, price=40000, on_hand=9)
    fixed = add_listed(shop.session, price=300000, on_hand=9)
    p1 = add_promotion(
        shop.session, kind="percent", value=15, scope="products", product_ids=[promoted]
    )
    p2 = add_promotion(
        shop.session, kind="fixed_amount", value=50000, scope="products", product_ids=[fixed]
    )
    stock_in_cart(shop, user, (promoted, 2), (plain, 3), (fixed, 1))

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    by = lines_by_product(body)
    assert by[str(promoted)]["list_price"] == money(1250000)
    assert by[str(promoted)]["unit_price"] == money(1062500)
    assert by[str(promoted)]["discount_amount"] == money(187500)  # por unidad
    assert by[str(promoted)]["line_total"] == money(2125000)
    assert (by[str(plain)]["unit_price"], by[str(plain)]["discount_amount"]) == (
        money(40000),
        money(0),
    )
    assert by[str(plain)]["line_total"] == money(120000)
    assert by[str(fixed)]["unit_price"] == money(250000)
    assert by[str(fixed)]["line_total"] == money(250000)
    assert body["subtotal"] == body["total"] == money(2125000 + 120000 + 250000)
    assert body["shipping"] == money(0)
    stored = {r["product_id"]: r for r in line_rows(shop.session, body["id"])}
    assert stored[promoted]["promotion_id"] == p1 and stored[fixed]["promotion_id"] == p2
    assert stored[plain]["promotion_id"] is None
    assert order_row(shop.session, body["id"])["total_amount"] == 2495000


def test_an_expired_promotion_does_not_apply(shop: OrderShop) -> None:
    user, product = quick(shop, price=100000)
    add_promotion(shop.session, kind="percent", value=50, scope="catalog", ends=-60)

    body = place(shop, user).json()

    assert body["lines"][0]["unit_price"] == money(100000) and body["total"] == money(100000)


def test_amounts_above_two_to_the_31_are_exact_in_the_response_and_the_database(
    shop: OrderShop,
) -> None:
    user = shop.user()
    big = add_listed(shop.session, price=2_000_000_000, on_hand=9)
    small = add_listed(shop.session, price=7, on_hand=9)
    stock_in_cart(shop, user, (big, 3), (small, 1))

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    assert lines_by_product(body)[str(big)]["line_total"] == money(6_000_000_000)
    assert body["subtotal"] == body["total"] == money(6_000_000_007) and 6_000_000_007 > INT32_MAX
    row = order_row(shop.session, body["id"])
    assert (row["subtotal_amount"], row["total_amount"]) == (6_000_000_007, 6_000_000_007)
    stored = {r["product_id"]: r for r in line_rows(shop.session, body["id"])}
    assert stored[big]["line_total_amount"] == 6_000_000_000


def test_the_price_in_the_database_is_what_the_cart_charged_at_that_moment(
    shop: OrderShop,
) -> None:
    # D-037: no hay precio guardado en el carrito; manda el vigente al comprar.
    user, product = quick(shop, price=100000)
    set_product(shop.session, product, price_cents=130000)

    body = place(shop, user).json()

    assert body["lines"][0]["unit_price"] == money(130000)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-05 / R4: bloqueos y sin efectos
@pytest.mark.parametrize(
    ("status", "options", "quantity"),
    [
        ("out_of_stock", {"on_hand": 0}, 1),
        ("insufficient_stock", {"on_hand": 1}, 3),
        ("unavailable", {"on_hand": 5, "status": "draft"}, 1),
    ],
)
def test_a_selected_item_that_cannot_be_bought_is_409_checkout_blocked_with_its_issue(
    shop: OrderShop, status: str, options: dict[str, Any], quantity: int
) -> None:
    user = shop.user()
    good = add_listed(shop.session, on_hand=5)
    bad = add_listed(shop.session, **options)
    stock_in_cart(shop, user, (good, 2), (bad, quantity))
    before = effects(shop.session, user, good, bad)

    response = place(shop, user)

    details = error_of(response, 409, "checkout_blocked")
    assert details == {"issues": [{"product_id": str(bad), "status": status}]}
    assert effects(shop.session, user, good, bad) == before  # ni reservas, ni pedido, ni carrito
    assert before["orders"] == before["reservations"] == 0


def test_every_blocked_item_is_reported_and_nothing_is_reserved(shop: OrderShop) -> None:
    user = shop.user()
    good = add_listed(shop.session, on_hand=5)
    sold_out = add_listed(shop.session, on_hand=0)
    hidden = add_listed(shop.session, on_hand=5, status="draft")
    stock_in_cart(shop, user, (good, 1), (sold_out, 1), (hidden, 1))

    details = error_of(place(shop, user), 409, "checkout_blocked")

    assert {(i["product_id"], i["status"]) for i in details["issues"]} == {
        (str(sold_out), "out_of_stock"),
        (str(hidden), "unavailable"),
    }
    assert effects(shop.session, user, good)["reservations"] == 0


def test_another_customer_taking_the_stock_before_the_reserve_is_409_insufficient_stock(
    shop: OrderShop,
) -> None:
    # La carrera real está en test_create_order_concurrency; aquí se ve el contrato HTTP y que lo
    # reservado antes del error se deshace con el resto.
    user = shop.user()
    a, b = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (a, 1), (b, 2))
    before = effects(shop.session, user, a, b)
    reserve_fails_with(shop, InsufficientStock((b,)))

    response = place(shop, user)

    assert error_of(response, 409, "insufficient_stock") == {"product_ids": [str(b)]}
    assert effects(shop.session, user, a, b) == before
    assert (available(shop.session, a), available(shop.session, b)) == (5, 5)


def test_a_lookup_error_from_inventory_is_a_500_without_a_trace_and_without_effects(
    shop: OrderShop,
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)
    reserve_fails_with(shop, LookupError("Producto inexistente: secreto-interno"))

    response = place(shop, user)

    assert response.status_code == 500
    assert "Traceback" not in response.text and "secreto-interno" not in response.text
    assert effects(shop.session, user, product) == before


def test_the_last_unit_goes_to_the_first_buyer_and_the_second_gets_checkout_blocked(
    shop: OrderShop,
) -> None:
    first, second = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=1)
    stock_in_cart(shop, first, (product, 1))
    stock_in_cart(shop, second, (product, 1))

    one = place(shop, first)
    two = place(shop, second)

    assert one.status_code == 201
    details = error_of(two, 409, "checkout_blocked")
    assert details == {"issues": [{"product_id": str(product), "status": "out_of_stock"}]}
    assert on_hand(shop.session, product) == 1  # reservar no descuenta
    assert len(reservations(shop.session, one.json()["id"])) == 1
    assert effects(shop.session, second, product)["orders"] == 0
    assert lines_of(shop.session, carts_of(shop.session, second)[0]) == {product: (1, True)}


# --------------------------------------------------------------------------------------------
# CA-ORDERS-06 / R5, R6: reservas
def test_each_stock_line_creates_an_active_reservation_with_the_order_expiry(
    shop: OrderShop,
) -> None:
    user = shop.user()
    a, b = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=9)
    stock_in_cart(shop, user, (a, 2), (b, 4))

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    expires_at = parse_utc(body["expires_at"])
    rows = {r["product_id"]: r for r in reservations(shop.session, body["id"])}
    assert set(rows) == {a, b}
    assert (rows[a]["quantity"], rows[b]["quantity"]) == (2, 4)
    assert {r["status"] for r in rows.values()} == {"active"}
    assert {r["expires_at"] for r in rows.values()} == {expires_at}  # el mismo `now` (R6)
    assert order_row(shop.session, body["id"])["expires_at"] == expires_at
    assert (available(shop.session, a), available(shop.session, b)) == (3, 5)
    assert (on_hand(shop.session, a), on_hand(shop.session, b)) == (5, 9)  # no descuenta


def test_the_expiry_is_exactly_thirty_minutes_after_the_creation(shop: OrderShop) -> None:
    user, _ = quick(shop)

    body = place(shop, user).json()

    created, expires = parse_utc(body["created_at"]), parse_utc(body["expires_at"])
    assert expires - created == timedelta(minutes=30)
    assert order_row(shop.session, body["id"])["created_at"] == created


def test_unselected_items_are_not_reserved(shop: OrderShop) -> None:
    user = shop.user()
    bought, left = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (bought, 1), (left, 2, False))

    place(shop, user)

    assert (available(shop.session, bought), available(shop.session, left)) == (4, 5)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-07 / R5, RN-16: Bajo pedido
def estimate(body: dict[str, Any], days: int) -> str:
    return (
        parse_utc(body["created_at"]).astimezone(LIMA).date() + timedelta(days=days)
    ).isoformat()


def test_a_made_to_order_line_is_not_reserved_and_carries_its_lead_time(shop: OrderShop) -> None:
    user, product = quick(shop, policy="made_to_order", on_hand=None)

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    [line] = body["lines"]
    assert (line["fulfillment"], line["lead_time_days"]) == ("made_to_order", 21)
    assert reservations(shop.session, body["id"]) == []
    assert body["estimated_delivery_on"] == estimate(body, 21)
    row = order_row(shop.session, body["id"])
    assert row["estimated_delivery_on"].isoformat() == body["estimated_delivery_on"]
    [stored] = line_rows(shop.session, body["id"])
    assert (stored["fulfillment"], stored["lead_time_days"]) == ("made_to_order", 21)


def test_the_estimate_uses_the_longest_lead_time_of_the_made_to_order_lines(
    shop: OrderShop,
) -> None:
    user = shop.user()
    quick_one = add_listed(shop.session, policy="made_to_order")
    slow_one = add_listed(shop.session, policy="made_to_order")
    set_product(shop.session, quick_one, lead_time_days=10)
    set_product(shop.session, slow_one, lead_time_days=30)
    stocked = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (quick_one, 1), (slow_one, 1), (stocked, 1))

    body = place(shop, user).json()

    assert body["estimated_delivery_on"] == estimate(body, 30)
    leads = {ln["product_id"]: ln["lead_time_days"] for ln in body["lines"]}
    assert (leads[str(quick_one)], leads[str(slow_one)]) == (10, 30)


def test_a_mixed_order_reserves_only_the_stock_lines(shop: OrderShop) -> None:
    user = shop.user()
    stocked = add_listed(shop.session, on_hand=5)
    custom = add_listed(shop.session, policy="made_to_order")
    stock_in_cart(shop, user, (stocked, 2), (custom, 1))

    body = place(shop, user).json()

    by = lines_by_product(body)
    assert by[str(stocked)]["fulfillment"] == "stock"
    assert by[str(custom)]["fulfillment"] == "made_to_order"
    assert [r["product_id"] for r in reservations(shop.session, body["id"])] == [stocked]
    assert body["estimated_delivery_on"] == estimate(body, 21)
    assert body["total"] == money(300000)  # se paga completo al crear (D-040, P-5)


def test_an_order_with_only_stock_lines_has_no_estimated_delivery(shop: OrderShop) -> None:
    user, _ = quick(shop)

    assert place(shop, user).json()["estimated_delivery_on"] is None


def test_a_backorder_line_with_enough_stock_is_reserved_like_stock(shop: OrderShop) -> None:
    user, product = quick(shop, quantity=2, policy="backorder", on_hand=5)

    body = place(shop, user).json()

    [line] = body["lines"]
    assert line["fulfillment"] == "stock"
    assert [(r["product_id"], r["quantity"]) for r in reservations(shop.session, body["id"])] == [
        (product, 2)
    ]
    assert body["estimated_delivery_on"] is None


def test_a_backorder_line_without_enough_stock_goes_entirely_made_to_order(
    shop: OrderShop,
) -> None:
    user, product = quick(shop, quantity=3, policy="backorder", on_hand=1)

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    [line] = body["lines"]
    assert (line["fulfillment"], line["lead_time_days"], line["quantity"]) == (
        "made_to_order",
        21,
        3,
    )
    assert reservations(shop.session, body["id"]) == []  # ni siquiera la unidad que había
    assert on_hand(shop.session, product) == 1 and available(shop.session, product) == 1
    assert body["estimated_delivery_on"] == estimate(body, 21)


def test_an_order_with_only_made_to_order_lines_still_has_a_thirty_minute_window(
    shop: OrderShop,
) -> None:
    user, _ = quick(shop, policy="made_to_order", on_hand=None)

    body = place(shop, user).json()

    assert parse_utc(body["expires_at"]) - parse_utc(body["created_at"]) == timedelta(minutes=30)
    assert body["status"] == "pendiente_pago" and body["can_cancel"] is True
    assert 0 < body["expires_in_seconds"] <= 1800


# --------------------------------------------------------------------------------------------
# CA-ORDERS-08 / R8: repetir la clave
def test_repeating_the_key_returns_200_with_the_same_order_and_changes_nothing(
    shop: OrderShop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    other = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 2), (other, 1, False))
    key = "bb74418f-1fe4-512c-9c00-4db6236061f6"
    first = place(shop, user, key=key)
    assert first.status_code == 201
    stock_in_cart(shop, user, (product, 1))  # el cliente vuelve a elegir lo mismo
    before = effects(shop.session, user, product, other)

    again = place(shop, user, key=key)

    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"]
    assert again.json() == first.json()
    assert effects(shop.session, user, product, other) == before
    assert before["orders"] == 1 and before["reservations"] == 1
    assert before["cart"][product] == (1, True)  # la repetición no lo compra ni lo quita


def test_repeating_the_key_with_another_body_returns_the_original_order(shop: OrderShop) -> None:
    user, _ = quick(shop)
    key = "800c0a2e-a387-5151-ac4c-70de19ddb4d9"
    first = place(shop, user, key=key)

    again = place(
        shop, user, key=key, delivery={**helpers.PICKUP, "recipient_name": "Otra Persona"}
    )

    assert again.status_code == 200
    assert again.json()["id"] == first.json()["id"]
    assert again.json()["delivery"]["delivery_method"] == "shipping"
    assert again.json()["delivery"]["recipient_name"] == "Ana Torres"


def test_a_replay_still_works_when_the_cart_is_empty_or_the_user_is_at_the_cap(
    shop: OrderShop,
) -> None:
    user, _ = quick(shop)
    first = place(shop, user, key="d93b9b98-0b55-5f7b-9f4d-d425353c4948")
    for _n in range(2):
        buy(shop, user)  # ya hay 3 pendientes

    again = place(shop, user, key="d93b9b98-0b55-5f7b-9f4d-d425353c4948")

    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]


def test_a_unique_violation_on_insert_is_409_idempotency_conflict_and_undoes_everything(
    shop: OrderShop,
) -> None:
    user, product = quick(shop)
    key = "56d92902-c907-5fbe-84c0-f026e55d48c2"
    assert place(shop, user, key=key).status_code == 201
    again = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (again, 1))
    before = effects(shop.session, user, product, again)
    shop.override(get_orders, blind_provider)

    response = place(shop, user, key=key)

    error_of(response, 409, "idempotency_conflict")
    assert effects(shop.session, user, product, again) == before  # ni reserva ni carrito tocado
    assert available(shop.session, again) == 5


# --------------------------------------------------------------------------------------------
# CA-ORDERS-09 / R9: tope de pedidos sin pagar
def buy(shop: OrderShop, user: UUID, **options: Any) -> Any:
    """Un pedido más del cliente con un producto nuevo."""
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    return place(shop, user, **options)


def test_the_fourth_pending_order_is_409_with_max_three_and_no_effects(shop: OrderShop) -> None:
    user = shop.user()
    for _ in range(3):
        assert buy(shop, user).status_code == 201
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    before = effects(shop.session, user, product)

    response = place(shop, user)

    assert error_of(response, 409, "too_many_pending_orders") == {"max": 3}
    assert effects(shop.session, user, product) == before
    assert before["orders"] == 3


def test_an_expired_cancelled_or_paid_order_does_not_count_towards_the_cap(
    shop: OrderShop,
) -> None:
    user = shop.user()
    ids = [buy(shop, user).json()["id"] for _ in range(3)]
    over = buy(shop, user)
    error_of(over, 409, "too_many_pending_orders")
    # vencido
    shop.session.execute(
        text(
            "UPDATE app.orders SET created_at = created_at - interval '2 hours',"
            " expires_at = expires_at - interval '2 hours' WHERE id = :id"
        ),
        {"id": ids[0]},
    )
    assert buy(shop, user).status_code == 201
    # cancelado
    shop.session.execute(
        text("UPDATE app.orders SET status = 'cancelado' WHERE id = :id"), {"id": ids[1]}
    )
    assert buy(shop, user).status_code == 201
    # pagado
    shop.session.execute(
        text("UPDATE app.orders SET status = 'pagado', paid_at = now() WHERE id = :id"),
        {"id": ids[2]},
    )
    assert buy(shop, user).status_code == 201
    # ahora hay 3 pendientes vigentes (los creados después): el siguiente vuelve a toparse
    error_of(buy(shop, user), 409, "too_many_pending_orders")


def test_the_pending_orders_of_other_customers_do_not_count(shop: OrderShop) -> None:
    busy, calm = shop.user(), shop.user()
    for _ in range(3):
        assert buy(shop, busy).status_code == 201

    assert buy(shop, calm).status_code == 201
    error_of(buy(shop, busy), 409, "too_many_pending_orders")


def test_the_cap_check_runs_before_reserving(shop: OrderShop) -> None:
    user = shop.user()
    for _ in range(3):
        buy(shop, user)
    product = add_listed(shop.session, on_hand=1)
    stock_in_cart(shop, user, (product, 1))

    error_of(place(shop, user), 409, "too_many_pending_orders")

    assert available(shop.session, product) == 1


def test_a_fresh_key_each_time_is_needed_to_create_more_orders(shop: OrderShop) -> None:
    user = shop.user()
    key = fresh_key()
    first = buy(shop, user, key=key)
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))

    again = place(shop, user, key=key)

    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
    assert effects(shop.session, user, product)["orders"] == 1


def test_the_cap_wins_over_a_stock_failure_in_the_reserve(shop: OrderShop) -> None:
    # Orden de UC-ORDERS-01: el tope R9 se comprueba antes de reservar (ORDERS-R9).
    user = shop.user()
    for _ in range(3):
        assert buy(shop, user).status_code == 201
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    reserve_fails_with(shop, InsufficientStock((product,)))

    response = place(shop, user)

    assert error_of(response, 409, "too_many_pending_orders") == {"max": 3}
