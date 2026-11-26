"""`GET /api/v1/cart` contra PostgreSQL con dos clientes reales (T-057; CA-CART-01, 08, 09, 10, 11).

Cada solicitud corre en un SAVEPOINT de la transacción de la prueba, que se deshace. Datos
ficticios. El token es el único origen de la identidad.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import (
    add_cart,
    add_image,
    add_item,
    add_listed,
    add_profile,
    captured,
    carts_of,
    identity_of,
    lines_of,
    set_product,
)
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.inventory.inventory_helpers import add_reservation
from tests.promotions.promotions_helpers import add_category, add_promotion
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import get_settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

PATH = "/api/v1/cart"
CDN = "https://cdn.valmont.test"
BASE = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
INT32_MAX = 2_147_483_647
ITEM_KEYS = {
    "product_id",
    "sku",
    "slug",
    "name",
    "image",
    "quantity",
    "selected",
    "status",
    "availability",
    "max_quantity",
    "unit_price",
    "original_price",
    "discount_amount",
    "subtotal",
}


def money(amount: int) -> dict[str, Any]:
    return {"amount": amount, "currency": "PEN"}


@dataclass
class Shop:
    session: Session
    client: TestClient
    profiles: InMemoryProfiles

    def user(self, role: Role = Role.CUSTOMER) -> UUID:
        user_id = add_profile(self.session)
        self.profiles.rows[user_id] = Profile(user_id, role, T0, T0)
        return user_id

    def cart(self, user: UUID, *lines: tuple[UUID, int, bool]) -> UUID:
        """Carrito con líneas creadas en el orden dado, un minuto de diferencia entre sí."""
        cart_id = add_cart(self.session, user)
        for n, (product_id, quantity, selected) in enumerate(lines):
            add_item(
                self.session,
                cart_id,
                product_id,
                quantity,
                selected=selected,
                created_at=BASE + timedelta(minutes=n),
            )
        return cart_id

    def get(self, user: UUID | None, **params: object) -> Any:
        headers = {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}
        return self.client.get(PATH, headers=headers, params=params)

    def read(self, user: UUID) -> dict[str, Any]:
        response = self.get(user)
        assert response.status_code == 200, response.text
        return response.json()


@pytest.fixture
def shop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[Shop]:
    use_test_auth(monkeypatch)
    monkeypatch.setenv("STORAGE_PUBLIC_URL", CDN)
    get_settings.cache_clear()
    profiles = InMemoryProfiles()
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    yield Shop(db_session, TestClient(app, raise_server_exceptions=False), profiles)
    get_settings.cache_clear()


def by_product(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["product_id"]: item for item in body["items"]}


# CA-CART-01: carrito inexistente o vacío; la lectura no crea filas
def test_a_customer_without_cart_gets_an_empty_cart_and_nothing_is_created(shop: Shop) -> None:
    user = shop.user()

    with captured(shop.session) as statements:
        response = shop.get(user)

    assert response.status_code == 200
    assert response.json() == {
        "items": [],
        "item_count": 0,
        "selected_count": 0,
        "total": money(0),
        "can_checkout": False,
    }
    assert carts_of(shop.session, user) == []
    assert not any(
        s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) or "FOR UPDATE" in s.upper()
        for s in statements
    )


def test_an_existing_empty_cart_reads_as_empty(shop: Shop) -> None:
    user = shop.user()
    shop.cart(user)

    body = shop.read(user)

    assert (body["items"], body["item_count"], body["total"], body["can_checkout"]) == (
        [],
        0,
        money(0),
        False,
    )


def test_reading_does_not_change_the_cart_rows(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    cart_id = shop.cart(user, (product, 2, True))
    before = lines_of(shop.session, cart_id)
    updated = shop.session.scalar(
        text("SELECT updated_at FROM app.carts WHERE id = :i"), {"i": cart_id}
    )

    shop.read(user)
    shop.read(user)

    assert lines_of(shop.session, cart_id) == before
    assert (
        shop.session.scalar(text("SELECT updated_at FROM app.carts WHERE id = :i"), {"i": cart_id})
        == updated
    )


def test_a_line_has_exactly_the_contract_fields_and_public_image_url(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(
        shop.session,
        price=250000,
        on_hand=7,
        name="Heritage 38",
        image=("heritage/frontal 1.jpg", "Heritage 38, vista frontal"),
    )
    sku, slug, _ = identity_of(shop.session, product)
    shop.cart(user, (product, 2, True))

    body = shop.read(user)

    assert set(body) == {"items", "item_count", "selected_count", "total", "can_checkout"}
    [item] = body["items"]
    assert set(item) == ITEM_KEYS
    assert item == {
        "product_id": str(product),
        "sku": sku,
        "slug": slug,
        "name": "Heritage 38",
        "image": {
            "url": f"{CDN}/storage/v1/object/public/products/heritage/frontal%201.jpg",
            "alt": "Heritage 38, vista frontal",
        },
        "quantity": 2,
        "selected": True,
        "status": "ok",
        "availability": {"status": "in_stock", "lead_time_days": None},
        "max_quantity": 5,
        "unit_price": money(250000),
        "original_price": None,
        "discount_amount": None,
        "subtotal": money(500000),
    }
    assert body["item_count"] == 1 and body["selected_count"] == 1
    assert body["total"] == money(500000) and body["can_checkout"] is True
    assert "storage_path" not in str(body) and "price_cents" not in str(body)


def test_a_line_without_image_has_null_image(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    shop.cart(user, (product, 1, True))

    [item] = shop.read(user)["items"]

    assert item["image"] is None and item["status"] == "ok"


def test_the_image_is_the_first_by_position(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    add_image(shop.session, product, "p/b.jpg", "Segunda", position=1)
    add_image(shop.session, product, "p/a.jpg", "Primera", position=0)
    shop.cart(user, (product, 1, True))

    [item] = shop.read(user)["items"]

    assert item["image"] == {
        "url": f"{CDN}/storage/v1/object/public/products/p/a.jpg",
        "alt": "Primera",
    }


# CA-CART-01 / R15: orden por created_at y product_id
def test_lines_come_by_created_at_then_product_id(shop: Shop) -> None:
    user = shop.user()
    first, second, third, tie_a, tie_b = (add_listed(shop.session, on_hand=3) for _ in range(5))
    cart_id = add_cart(shop.session, user)
    # Se insertan desordenadas; dos comparten el instante exacto.
    add_item(shop.session, cart_id, third, created_at=BASE + timedelta(minutes=9))
    add_item(shop.session, cart_id, tie_b, created_at=BASE + timedelta(minutes=5))
    add_item(shop.session, cart_id, first, created_at=BASE)
    add_item(shop.session, cart_id, tie_a, created_at=BASE + timedelta(minutes=5))
    add_item(shop.session, cart_id, second, created_at=BASE + timedelta(minutes=1))
    tied = sorted([tie_a, tie_b])

    ids = [item["product_id"] for item in shop.read(user)["items"]]

    assert ids == [str(p) for p in (first, second, *tied, third)]


# CA-CART-11 / RN-10: aislamiento
def test_each_customer_sees_only_their_own_cart(shop: Shop) -> None:
    ana, luis, nadie = shop.user(), shop.user(), shop.user()
    shared, only_ana, only_luis = (add_listed(shop.session, on_hand=9) for _ in range(3))
    shop.cart(ana, (shared, 1, True), (only_ana, 4, True))
    shop.cart(luis, (shared, 3, False), (only_luis, 2, True))

    ana_view, luis_view, empty_view = shop.read(ana), shop.read(luis), shop.read(nadie)

    ana_items, luis_items = by_product(ana_view), by_product(luis_view)
    assert set(ana_items) == {str(shared), str(only_ana)}
    assert set(luis_items) == {str(shared), str(only_luis)}
    assert (ana_items[str(shared)]["quantity"], ana_items[str(shared)]["selected"]) == (1, True)
    assert (luis_items[str(shared)]["quantity"], luis_items[str(shared)]["selected"]) == (3, False)
    assert str(only_luis) not in str(ana_view) and str(only_ana) not in str(luis_view)
    assert (ana_view["total"], luis_view["total"]) == (money(500000), money(200000))
    assert empty_view["items"] == [] and empty_view["total"] == money(0)


def test_ids_in_the_query_string_never_select_another_cart(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    mine, theirs = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    ana_cart = shop.cart(ana, (mine, 1, True))
    luis_cart = shop.cart(luis, (theirs, 1, True))

    response = shop.get(ana, user_id=str(luis), cart_id=str(luis_cart), customer_id=str(luis))

    assert response.status_code == 200
    assert [i["product_id"] for i in response.json()["items"]] == [str(mine)]
    assert ana_cart != luis_cart


def test_an_admin_sees_only_their_own_cart(shop: Shop) -> None:
    admin, customer = shop.user(Role.ADMIN), shop.user()
    product = add_listed(shop.session, on_hand=3)
    shop.cart(customer, (product, 1, True))

    assert shop.read(admin)["items"] == []
    assert len(shop.read(customer)["items"]) == 1


def test_without_token_the_cart_is_401_and_reveals_nothing(shop: Shop) -> None:
    user = shop.user()
    shop.cart(user, (add_listed(shop.session, on_hand=3), 1, True))

    response = shop.get(None)

    assert response.status_code == 401
    assert set(response.json()) == {"error"}
    assert response.json()["error"]["code"] == "unauthenticated"


# CA-CART-08: precio vigente, con y sin promoción, y subtotales en el servidor
def test_a_percent_promotion_shows_unit_original_and_discount(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1250000, on_hand=5)
    add_promotion(shop.session, kind="percent", value=15, scope="catalog")
    shop.cart(user, (product, 2, True))

    body = shop.read(user)

    [item] = body["items"]
    assert item["unit_price"] == money(1062500)
    assert item["original_price"] == money(1250000)
    assert item["discount_amount"] == money(187500)
    assert item["subtotal"] == money(2125000)
    assert body["total"] == money(2125000)


def test_a_fixed_amount_promotion_on_the_product(shop: Shop) -> None:
    user = shop.user()
    covered, plain = (
        add_listed(shop.session, price=500000, on_hand=5),
        add_listed(shop.session, price=500000, on_hand=5),
    )
    add_promotion(
        shop.session, kind="fixed_amount", value=40000, scope="products", product_ids=[covered]
    )
    shop.cart(user, (covered, 1, True), (plain, 1, True))

    items = by_product(shop.read(user))

    assert items[str(covered)]["unit_price"] == money(460000)
    assert items[str(covered)]["discount_amount"] == money(40000)
    assert items[str(plain)]["unit_price"] == money(500000)
    assert items[str(plain)]["original_price"] is None
    assert items[str(plain)]["discount_amount"] is None


def test_a_category_promotion_only_covers_its_category(shop: Shop) -> None:
    user = shop.user()
    mine, other = add_category(shop.session), add_category(shop.session)
    inside = add_listed(shop.session, price=100000, on_hand=5, category_id=mine)
    outside = add_listed(shop.session, price=100000, on_hand=5, category_id=other)
    add_promotion(shop.session, kind="percent", value=10, scope="category", category_id=mine)
    shop.cart(user, (inside, 1, True), (outside, 1, True))

    items = by_product(shop.read(user))

    assert items[str(inside)]["unit_price"] == money(90000)
    assert items[str(outside)]["unit_price"] == money(100000)
    assert items[str(outside)]["original_price"] is None


def test_the_cart_price_equals_the_catalog_price_for_the_same_product(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1250000, on_hand=5, image=("p/c.jpg", "Reloj"))
    _, slug, _ = identity_of(shop.session, product)
    add_promotion(shop.session, kind="percent", value=15, scope="catalog")
    shop.cart(user, (product, 1, True))

    [item] = shop.read(user)["items"]
    detail = shop.client.get(f"/api/v1/catalog/products/{slug}")

    assert detail.status_code == 200, detail.text
    card = detail.json()
    assert item["unit_price"] == card["price"]
    assert item["original_price"] == card["original_price"]
    assert item["discount_amount"] == card["discount_amount"]
    assert item["availability"] == card["availability"]


def test_a_subtotal_beyond_int32_is_exact(shop: Shop) -> None:
    user = shop.user()
    big, cent = (
        add_listed(shop.session, price=INT32_MAX, on_hand=9),
        add_listed(shop.session, price=1, on_hand=9),
    )
    shop.cart(user, (big, 5, True), (cent, 1, True))

    body = shop.read(user)

    items = by_product(body)
    assert items[str(big)]["subtotal"] == money(INT32_MAX * 5)
    assert body["total"] == money(INT32_MAX * 5 + 1)


def test_a_one_cent_product_with_a_promotion_stays_valid(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1, on_hand=3)
    add_promotion(shop.session, kind="percent", value=50, scope="catalog")
    shop.cart(user, (product, 1, True))

    [item] = shop.read(user)["items"]

    assert item["unit_price"]["amount"] >= 1  # RN-15: nunca un precio de 0
    assert item["subtotal"]["amount"] == item["unit_price"]["amount"]


def test_a_price_change_or_an_expired_promotion_shows_on_the_next_read(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=100000, on_hand=5)
    shop.cart(user, (product, 2, True))
    assert shop.read(user)["total"] == money(200000)

    set_product(shop.session, product, price_cents=150000)
    assert shop.read(user)["total"] == money(300000)

    promotion = add_promotion(shop.session, kind="percent", value=20, scope="catalog")
    promoted = shop.read(user)
    assert promoted["total"] == money(240000)
    assert promoted["items"][0]["original_price"] == money(150000)

    shop.session.execute(
        text("UPDATE app.promotions SET is_active = false WHERE id = :i"), {"i": promotion}
    )
    expired = shop.read(user)
    assert expired["total"] == money(300000)
    assert expired["items"][0]["original_price"] is None


# RN-05 / R8: total y conteo solo de los seleccionados
def test_total_and_selected_count_cover_only_selected_lines(shop: Shop) -> None:
    user = shop.user()
    picked, skipped = (
        add_listed(shop.session, price=100000, on_hand=9),
        add_listed(shop.session, price=900000, on_hand=9),
    )
    shop.cart(user, (picked, 2, True), (skipped, 1, False))

    body = shop.read(user)

    assert (body["item_count"], body["selected_count"]) == (2, 1)
    assert body["total"] == money(200000)
    skipped_item = by_product(body)[str(skipped)]
    assert skipped_item["selected"] is False and skipped_item["subtotal"] == money(900000)
    assert body["can_checkout"] is True


def test_with_nothing_selected_total_is_zero_and_checkout_is_off(shop: Shop) -> None:
    user = shop.user()
    shop.cart(user, (add_listed(shop.session, on_hand=9), 1, False))

    body = shop.read(user)

    assert (body["selected_count"], body["total"], body["can_checkout"]) == (0, money(0), False)


# CA-CART-09 / CA-CART-10: status, disponibilidad y máximo por política
def test_status_availability_and_max_quantity_per_policy(shop: Shop) -> None:
    user = shop.user()
    plenty = add_listed(shop.session, on_hand=20)
    last_units = add_listed(shop.session, on_hand=2)
    short = add_listed(shop.session, on_hand=2)
    sold_out = add_listed(shop.session, on_hand=0)
    no_row = add_listed(shop.session)
    made = add_listed(shop.session, policy="made_to_order")
    back_empty = add_listed(shop.session, policy="backorder", on_hand=0)
    shop.cart(
        user,
        (plenty, 5, True),
        (last_units, 2, False),
        (short, 4, False),
        (sold_out, 1, False),
        (no_row, 1, False),
        (made, 3, False),
        (back_empty, 5, False),
    )

    items = by_product(shop.read(user))

    def seen(product: UUID) -> tuple[Any, ...]:
        item = items[str(product)]
        return (
            item["status"],
            item["availability"]["status"],
            item["availability"]["lead_time_days"],
            item["max_quantity"],
        )

    assert seen(plenty) == ("ok", "in_stock", None, 5)
    assert seen(last_units) == ("ok", "low_stock", None, 2)
    assert seen(short) == ("insufficient_stock", "low_stock", None, 2)
    assert seen(sold_out) == ("out_of_stock", "out_of_stock", None, 0)
    assert seen(no_row) == ("out_of_stock", "out_of_stock", None, 0)
    assert seen(made) == ("ok", "on_request", 21, 5)  # bajo pedido: siempre ok (RN-16)
    assert seen(back_empty) == ("ok", "on_request", 21, 5)


def test_active_reservations_lower_availability_and_expired_ones_do_not(shop: Shop) -> None:
    user = shop.user()
    reserved, expired = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=5)
    add_reservation(shop.session, reserved, 4)
    add_reservation(shop.session, expired, 4, minutes=-1)
    shop.cart(user, (reserved, 2, True), (expired, 2, True))

    items = by_product(shop.read(user))

    assert (items[str(reserved)]["status"], items[str(reserved)]["max_quantity"]) == (
        "insufficient_stock",
        1,
    )
    assert (items[str(expired)]["status"], items[str(expired)]["max_quantity"]) == ("ok", 5)


def test_an_item_whose_policy_changed_after_adding_is_re_evaluated(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=0)
    shop.cart(user, (product, 2, True))
    assert shop.read(user)["items"][0]["status"] == "out_of_stock"

    set_product(shop.session, product, order_policy="made_to_order", lead_time_days=30)
    item = shop.read(user)["items"][0]

    assert item["status"] == "ok"
    assert item["availability"] == {"status": "on_request", "lead_time_days": 30}


# CA-CART-09: despublicado
def test_an_unpublished_item_shows_only_name_and_slug_and_leaves_the_total(shop: Shop) -> None:
    user = shop.user()
    live = add_listed(shop.session, price=100000, on_hand=5)
    gone = add_listed(
        shop.session,
        price=987654,
        on_hand=5,
        name="Reloj retirado",
        status="draft",
        image=("secreto/retirado.jpg", "No debe verse"),
    )
    gone_sku, gone_slug, _ = identity_of(shop.session, gone)
    shop.cart(user, (live, 1, True), (gone, 2, True))

    response = shop.get(user)

    body = response.json()
    item = by_product(body)[str(gone)]
    assert item == {
        "product_id": str(gone),
        "sku": None,
        "slug": gone_slug,
        "name": "Reloj retirado",
        "image": None,
        "quantity": 2,
        "selected": True,
        "status": "unavailable",
        "availability": None,
        "max_quantity": 0,
        "unit_price": None,
        "original_price": None,
        "discount_amount": None,
        "subtotal": None,
    }
    assert body["total"] == money(100000)
    assert body["can_checkout"] is False
    for secret in (gone_sku, "987654", "secreto", "No debe verse"):
        assert secret not in response.text


def test_an_unselected_unpublished_item_does_not_block_checkout(shop: Shop) -> None:
    user = shop.user()
    live = add_listed(shop.session, on_hand=5)
    gone = add_listed(shop.session, status="draft")
    shop.cart(user, (live, 1, True), (gone, 1, False))

    body = shop.read(user)

    assert by_product(body)[str(gone)]["status"] == "unavailable"
    assert body["can_checkout"] is True


def test_unpublishing_and_republishing_does_not_touch_the_cart(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=100000, on_hand=5)
    cart_id = shop.cart(user, (product, 2, True))

    set_product(shop.session, product, status="draft")
    hidden = shop.read(user)
    set_product(shop.session, product, status="published")
    back = shop.read(user)

    assert hidden["items"][0]["status"] == "unavailable"
    assert (back["items"][0]["status"], back["total"]) == ("ok", money(200000))
    assert lines_of(shop.session, cart_id) == {product: (2, True)}  # el artículo no se elimina


# CA-CART-09 / R9: can_checkout
def test_can_checkout_blocks_on_any_selected_line_that_is_not_ok(shop: Shop) -> None:
    user = shop.user()
    fine = add_listed(shop.session, price=100000, on_hand=5)
    sold_out = add_listed(shop.session, price=500000, on_hand=0)
    shop.cart(user, (fine, 1, True), (sold_out, 1, True))

    body = shop.read(user)

    assert body["can_checkout"] is False
    assert body["total"] == money(600000)  # R8: el importe informa, can_checkout decide


def test_an_unselected_sold_out_item_does_not_block_checkout(shop: Shop) -> None:
    user = shop.user()
    fine, sold_out = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=0)
    shop.cart(user, (fine, 1, True), (sold_out, 1, False))

    assert shop.read(user)["can_checkout"] is True


def test_a_twenty_line_cart_reads_in_full(shop: Shop) -> None:
    user = shop.user()
    products = [add_listed(shop.session, price=1000 + n, on_hand=9) for n in range(20)]
    shop.cart(user, *((p, 1, True) for p in products))

    body = shop.read(user)

    assert [i["product_id"] for i in body["items"]] == [str(p) for p in products]
    assert body["item_count"] == body["selected_count"] == 20
    assert body["total"] == money(sum(1000 + n for n in range(20)))


# SPEC §8: sin N+1
def statements_for(shop: Shop, user: UUID) -> list[str]:
    with captured(shop.session) as statements:
        response = shop.get(user)
    assert response.status_code == 200
    return statements


def test_the_number_of_statements_does_not_grow_with_the_lines(shop: Shop) -> None:
    one, ten = shop.user(), shop.user()
    single = add_listed(shop.session, on_hand=5, image=("p/u.jpg", "U"))
    shop.cart(one, (single, 1, True))
    many = [
        add_listed(
            shop.session,
            price=100000 + n,
            policy=("stock", "made_to_order", "backorder")[n % 3],
            on_hand=n,
            image=(f"p/{n}.jpg", f"Reloj {n}") if n % 2 else None,
        )
        for n in range(10)
    ]
    add_promotion(shop.session, kind="percent", value=10, scope="catalog")
    shop.cart(ten, *((p, 1, n % 2 == 0) for n, p in enumerate(many)))

    with_one, with_ten = statements_for(shop, one), statements_for(shop, ten)

    assert len(with_one) == len(with_ten)
    assert len(with_ten) <= 6  # savepoint + carrito + catálogo; N+1 daría más de 10


def test_the_number_of_statements_does_not_grow_with_unpublished_lines(shop: Shop) -> None:
    one, five = shop.user(), shop.user()
    shop.cart(one, (add_listed(shop.session, status="draft"), 1, True))
    shop.cart(five, *((add_listed(shop.session, status="draft"), 1, True) for _ in range(5)))

    assert len(statements_for(shop, one)) == len(statements_for(shop, five))


def test_an_empty_cart_reads_with_fewer_statements_than_one_with_lines(shop: Shop) -> None:
    empty, full = shop.user(), shop.user()
    shop.cart(full, (add_listed(shop.session, on_hand=5), 1, True))

    assert len(statements_for(shop, empty)) < len(statements_for(shop, full))


# Errores sin datos internos
def test_the_response_never_exposes_internal_data(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=7, image=("p/z.jpg", "Z"))
    add_promotion(shop.session, kind="percent", value=10, scope="catalog")
    shop.cart(user, (product, 1, True))

    response = shop.get(user)

    for leaked in (
        str(user),  # ni el id del usuario ni el del carrito
        "user_id",
        "cart_id",
        "storage_path",
        "image_path",
        "order_policy",
        "promotion_id",
        "list_price",
        "price_cents",
        "on_hand",
        "reserved",
        '"available"',
        "created_at",
    ):
        assert leaked not in response.text, leaked
