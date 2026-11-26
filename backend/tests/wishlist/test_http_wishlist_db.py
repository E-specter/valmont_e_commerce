"""`GET /api/v1/wishlist` contra PostgreSQL con clientes reales (T-067; CA-WISH-01, 07, 08, 09, 11).

Cada solicitud corre en un SAVEPOINT de la transacción de la prueba, que se deshace. Datos
ficticios. El token es el único origen de la identidad.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.cart import test_http_cart_db as cart_http
from tests.cart.cart_helpers import add_image, add_listed, identity_of, set_product
from tests.cart.test_http_cart_db import CDN, INT32_MAX, Shop, money
from tests.identity.identity_helpers import make_token
from tests.inventory.inventory_helpers import add_reservation
from tests.promotions.promotions_helpers import add_category, add_promotion
from tests.wishlist.wishlist_helpers import add_entry, captured, entries_of
from valmont.modules.identity.domain import Role

pytestmark = pytest.mark.integration

PATH = "/api/v1/wishlist"
BASE = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
shop = cart_http.shop  # la misma fixture que el carrito (cliente real, SAVEPOINT por solicitud)
ITEM_KEYS = {
    "product_id",
    "sku",
    "slug",
    "name",
    "status",
    "added_at",
    "image",
    "availability",
    "unit_price",
    "original_price",
    "discount_amount",
}


def wish(shop: Shop, user: UUID, *products: UUID) -> None:
    """Filas creadas en el orden dado, un minuto entre sí: la última es la más reciente."""
    for n, product in enumerate(products):
        add_entry(shop.session, user, product, BASE + timedelta(minutes=n))


def get(shop: Shop, user: UUID | None, **params: object) -> Any:
    headers = {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}
    return shop.client.get(PATH, headers=headers, params=params)


def read(shop: Shop, user: UUID) -> dict[str, Any]:
    response = get(shop, user)
    assert response.status_code == 200, response.text
    return response.json()


def by_product(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["product_id"]: item for item in body["items"]}


def only_item(shop: Shop, user: UUID) -> dict[str, Any]:
    [item] = read(shop, user)["items"]
    return item


# CA-WISH-01: sin filas → lista vacía, sin crear nada
def test_a_customer_without_rows_gets_an_empty_list_and_nothing_is_created(shop: Shop) -> None:
    user = shop.user()

    with captured(shop.session) as statements:
        response = get(shop, user)

    assert response.status_code == 200
    assert response.json() == {"items": [], "item_count": 0, "max_items": 50}
    assert entries_of(shop.session, user) == {}
    assert not any(
        s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) or "FOR UPDATE" in s.upper()
        for s in statements
    )


def test_reading_does_not_change_the_rows(shop: Shop) -> None:
    user = shop.user()
    wish(shop, user, add_listed(shop.session, on_hand=3), add_listed(shop.session, status="draft"))
    before = entries_of(shop.session, user)

    read(shop, user)
    read(shop, user)

    assert entries_of(shop.session, user) == before


def test_an_item_has_exactly_the_contract_fields_and_public_image_url(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(
        shop.session,
        price=250000,
        on_hand=7,
        name="Heritage 38",
        image=("heritage/frontal 1.jpg", "Heritage 38, vista frontal"),
    )
    sku, slug, _ = identity_of(shop.session, product)
    wish(shop, user, product)

    body = read(shop, user)

    assert set(body) == {"items", "item_count", "max_items"}
    [item] = body["items"]
    assert set(item) == ITEM_KEYS
    added_at = datetime.fromisoformat(item.pop("added_at"))
    assert added_at == BASE and added_at.utcoffset() == timedelta(0)  # ISO 8601 en UTC
    assert item == {
        "product_id": str(product),
        "sku": sku,
        "slug": slug,
        "name": "Heritage 38",
        "status": "available",
        "image": {
            "url": f"{CDN}/storage/v1/object/public/products/heritage/frontal%201.jpg",
            "alt": "Heritage 38, vista frontal",
        },
        "availability": {"status": "in_stock", "lead_time_days": None},
        "unit_price": money(250000),
        "original_price": None,
        "discount_amount": None,
    }
    assert (body["item_count"], body["max_items"]) == (1, 50)


def test_an_item_without_image_has_null_image(shop: Shop) -> None:
    user = shop.user()
    wish(shop, user, add_listed(shop.session, on_hand=3))

    item = only_item(shop, user)

    assert item["image"] is None and item["status"] == "available"


def test_the_image_is_the_first_by_position(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    add_image(shop.session, product, "p/b.jpg", "Segunda", position=1)
    add_image(shop.session, product, "p/a.jpg", "Primera", position=0)
    wish(shop, user, product)

    assert only_item(shop, user)["image"] == {
        "url": f"{CDN}/storage/v1/object/public/products/p/a.jpg",
        "alt": "Primera",
    }


# CA-WISH-01 / R8: más reciente primero y product_id para estabilidad
def test_items_come_by_created_at_descending_then_product_id(shop: Shop) -> None:
    user = shop.user()
    oldest, middle, newest, tie_a, tie_b = (add_listed(shop.session, on_hand=3) for _ in range(5))
    # Se insertan desordenadas; dos comparten el instante exacto.
    for product, minutes in ((middle, 1), (tie_b, 5), (oldest, 0), (newest, 9), (tie_a, 5)):
        add_entry(shop.session, user, product, BASE + timedelta(minutes=minutes))
    tied = sorted([tie_a, tie_b])

    ids = [item["product_id"] for item in read(shop, user)["items"]]

    assert ids == [str(p) for p in (newest, *tied, middle, oldest)]


def test_item_count_is_the_number_of_items_including_unavailable_ones(shop: Shop) -> None:
    user = shop.user()
    wish(
        shop,
        user,
        add_listed(shop.session, on_hand=3),
        add_listed(shop.session, status="draft"),
        add_listed(shop.session, on_hand=3),
    )

    body = read(shop, user)

    assert body["item_count"] == len(body["items"]) == 3


# CA-WISH-01 / CA-WISH-09 / RN-10: aislamiento
def test_each_customer_sees_only_their_own_list(shop: Shop) -> None:
    ana, luis, nadie = shop.user(), shop.user(), shop.user()
    shared, only_ana, only_luis = (add_listed(shop.session, on_hand=9) for _ in range(3))
    wish(shop, ana, shared, only_ana)
    wish(shop, luis, only_luis, shared)

    ana_view, luis_view, empty_view = read(shop, ana), read(shop, luis), read(shop, nadie)

    assert [i["product_id"] for i in ana_view["items"]] == [str(only_ana), str(shared)]
    assert [i["product_id"] for i in luis_view["items"]] == [str(shared), str(only_luis)]
    assert str(only_luis) not in str(ana_view) and str(only_ana) not in str(luis_view)
    assert empty_view == {"items": [], "item_count": 0, "max_items": 50}


def test_ids_in_the_query_string_never_select_another_list(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    mine, theirs = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    wish(shop, ana, mine)
    wish(shop, luis, theirs)

    response = get(shop, ana, user_id=str(luis), wishlist_id=str(luis), customer_id=str(luis))

    assert response.status_code == 200
    assert [i["product_id"] for i in response.json()["items"]] == [str(mine)]


def test_an_admin_sees_only_their_own_list(shop: Shop) -> None:
    admin, customer = shop.user(Role.ADMIN), shop.user()
    wish(shop, customer, add_listed(shop.session, on_hand=3))

    assert read(shop, admin)["items"] == []
    assert len(read(shop, customer)["items"]) == 1


def test_without_token_the_list_is_401_and_reveals_nothing(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3, name="Reloj secreto")
    wish(shop, user, product)

    response = get(shop, None)

    assert response.status_code == 401
    assert set(response.json()) == {"error"}
    assert response.json()["error"]["code"] == "unauthenticated"
    assert "Reloj secreto" not in response.text and str(product) not in response.text


# CA-WISH-07 / R7: precio vigente, con y sin promoción
def test_a_percent_promotion_shows_unit_original_and_discount(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1250000, on_hand=5)
    add_promotion(shop.session, kind="percent", value=15, scope="catalog")
    wish(shop, user, product)

    item = only_item(shop, user)

    assert item["unit_price"] == money(1062500)
    assert item["original_price"] == money(1250000)
    assert item["discount_amount"] == money(187500)


def test_a_fixed_amount_promotion_on_the_product(shop: Shop) -> None:
    user = shop.user()
    covered = add_listed(shop.session, price=500000, on_hand=5)
    plain = add_listed(shop.session, price=500000, on_hand=5)
    add_promotion(
        shop.session, kind="fixed_amount", value=40000, scope="products", product_ids=[covered]
    )
    wish(shop, user, covered, plain)

    items = by_product(read(shop, user))

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
    wish(shop, user, inside, outside)

    items = by_product(read(shop, user))

    assert items[str(inside)]["unit_price"] == money(90000)
    assert items[str(outside)]["unit_price"] == money(100000)
    assert items[str(outside)]["original_price"] is None


def test_the_wishlist_price_equals_the_catalog_price_for_the_same_product(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1250000, on_hand=5, image=("p/c.jpg", "Reloj"))
    _, slug, _ = identity_of(shop.session, product)
    add_promotion(shop.session, kind="percent", value=15, scope="catalog")
    wish(shop, user, product)

    item = only_item(shop, user)
    detail = shop.client.get(f"/api/v1/catalog/products/{slug}")

    assert detail.status_code == 200, detail.text
    card = detail.json()
    assert item["unit_price"] == card["price"]
    assert item["original_price"] == card["original_price"]
    assert item["discount_amount"] == card["discount_amount"]
    assert item["availability"] == card["availability"]


def test_a_price_at_int32_max_is_exact(shop: Shop) -> None:
    user = shop.user()
    wish(shop, user, add_listed(shop.session, price=INT32_MAX, on_hand=9))

    assert only_item(shop, user)["unit_price"] == money(INT32_MAX)


def test_a_one_cent_product_with_a_promotion_stays_valid(shop: Shop) -> None:
    user = shop.user()
    wish(shop, user, add_listed(shop.session, price=1, on_hand=3))
    add_promotion(shop.session, kind="percent", value=50, scope="catalog")

    assert only_item(shop, user)["unit_price"]["amount"] >= 1  # RN-15: nunca un precio de 0


def test_a_price_change_or_an_expired_promotion_shows_on_the_next_read(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=100000, on_hand=5)
    wish(shop, user, product)
    assert only_item(shop, user)["unit_price"] == money(100000)

    set_product(shop.session, product, price_cents=150000)
    assert only_item(shop, user)["unit_price"] == money(150000)

    promotion = add_promotion(shop.session, kind="percent", value=20, scope="catalog")
    promoted = only_item(shop, user)
    assert (promoted["unit_price"], promoted["original_price"]) == (
        money(120000),
        money(150000),
    )

    shop.session.execute(
        text("UPDATE app.promotions SET is_active = false WHERE id = :i"), {"i": promotion}
    )
    expired = only_item(shop, user)
    assert expired["unit_price"] == money(150000) and expired["original_price"] is None


# CA-WISH-07 / R5 / R7: disponibilidad; agotado sigue available
def test_availability_per_policy_and_stock(shop: Shop) -> None:
    user = shop.user()
    plenty = add_listed(shop.session, on_hand=20)
    last_units = add_listed(shop.session, on_hand=2)
    sold_out = add_listed(shop.session, on_hand=0)
    no_row = add_listed(shop.session)
    made = add_listed(shop.session, policy="made_to_order")
    back_empty = add_listed(shop.session, policy="backorder", on_hand=0)
    wish(shop, user, plenty, last_units, sold_out, no_row, made, back_empty)

    items = by_product(read(shop, user))

    def seen(product: UUID) -> tuple[Any, ...]:
        item = items[str(product)]
        return (
            item["status"],
            item["availability"]["status"],
            item["availability"]["lead_time_days"],
        )

    assert seen(plenty) == ("available", "in_stock", None)
    assert seen(last_units) == ("available", "low_stock", None)
    assert seen(sold_out) == (
        "available",
        "out_of_stock",
        None,
    )  # agotado NO es un estado de la lista
    assert seen(no_row) == ("available", "out_of_stock", None)
    assert seen(made) == ("available", "on_request", 21)  # RN-16: Bajo pedido con su plazo
    assert seen(back_empty) == ("available", "on_request", 21)


def test_a_sold_out_item_keeps_its_price_and_image(shop: Shop) -> None:
    user = shop.user()
    wish(shop, user, add_listed(shop.session, price=300000, on_hand=0, image=("p/s.jpg", "S")))

    item = only_item(shop, user)

    assert item["status"] == "available"
    assert item["unit_price"] == money(300000) and item["image"] is not None


def test_active_reservations_lower_availability_and_expired_ones_do_not(shop: Shop) -> None:
    user = shop.user()
    reserved, expired = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=5)
    add_reservation(shop.session, reserved, 5)
    add_reservation(shop.session, expired, 5, minutes=-1)
    wish(shop, user, reserved, expired)

    items = by_product(read(shop, user))

    assert items[str(reserved)]["availability"]["status"] == "out_of_stock"
    assert items[str(expired)]["availability"]["status"] == "in_stock"


def test_an_item_whose_policy_changed_after_adding_is_re_evaluated(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=0)
    wish(shop, user, product)
    assert only_item(shop, user)["availability"]["status"] == "out_of_stock"

    set_product(shop.session, product, order_policy="made_to_order", lead_time_days=30)

    assert only_item(shop, user)["availability"] == {"status": "on_request", "lead_time_days": 30}


# CA-WISH-08 / R6: despublicado
def test_an_unpublished_item_shows_only_name_and_slug(shop: Shop) -> None:
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
    wish(shop, user, live, gone)

    response = get(shop, user)

    body = response.json()
    item = by_product(body)[str(gone)]
    item.pop("added_at")
    assert item == {
        "product_id": str(gone),
        "sku": None,
        "slug": gone_slug,
        "name": "Reloj retirado",
        "status": "unavailable",
        "image": None,
        "availability": None,
        "unit_price": None,
        "original_price": None,
        "discount_amount": None,
    }
    assert by_product(body)[str(live)]["status"] == "available"
    for secret in (gone_sku, "987654", "secreto", "No debe verse"):
        assert secret not in response.text


def test_unpublishing_and_republishing_restores_the_data_without_touching_the_rows(
    shop: Shop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=100000, on_hand=5, image=("p/r.jpg", "R"))
    wish(shop, user, product)
    rows = entries_of(shop.session, user)
    shown = only_item(shop, user)

    set_product(shop.session, product, status="draft")
    hidden = only_item(shop, user)
    set_product(shop.session, product, status="published")
    back = only_item(shop, user)

    assert hidden["status"] == "unavailable" and hidden["unit_price"] is None
    assert back == shown  # republicarlo lo restablece, incluido added_at
    assert entries_of(shop.session, user) == rows  # el artículo no se elimina


def test_an_unavailable_item_keeps_its_place_in_the_order(shop: Shop) -> None:
    user = shop.user()
    first, middle, last = (add_listed(shop.session, on_hand=3) for _ in range(3))
    wish(shop, user, first, middle, last)
    set_product(shop.session, middle, status="draft")

    body = read(shop, user)

    assert [(i["product_id"], i["status"]) for i in body["items"]] == [
        (str(last), "available"),
        (str(middle), "unavailable"),
        (str(first), "available"),
    ]


# Sin N+1 (SPEC §8, CA-WISH-11)
def statements_for(shop: Shop, user: UUID) -> list[str]:
    with captured(shop.session) as statements:
        response = get(shop, user)
    assert response.status_code == 200
    return statements


def test_the_number_of_statements_does_not_grow_with_the_items(shop: Shop) -> None:
    one, ten = shop.user(), shop.user()
    wish(shop, one, add_listed(shop.session, on_hand=5, image=("p/u.jpg", "U")))
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
    wish(shop, ten, *many)

    with_one, with_ten = statements_for(shop, one), statements_for(shop, ten)

    assert len(with_one) == len(with_ten)
    assert len(with_ten) <= 6  # savepoint + lista + productos; N+1 daría más de 10


def test_the_number_of_statements_does_not_grow_with_unpublished_items(shop: Shop) -> None:
    one, five = shop.user(), shop.user()
    wish(shop, one, add_listed(shop.session, status="draft"))
    wish(shop, five, *(add_listed(shop.session, status="draft") for _ in range(5)))

    assert len(statements_for(shop, one)) == len(statements_for(shop, five))


def test_an_empty_list_reads_with_fewer_statements_than_one_with_items(shop: Shop) -> None:
    empty, full = shop.user(), shop.user()
    wish(shop, full, add_listed(shop.session, on_hand=5))

    assert len(statements_for(shop, empty)) < len(statements_for(shop, full))


# Sin datos internos
def test_the_response_never_exposes_internal_data(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=7, image=("p/z.jpg", "Z"))
    add_promotion(shop.session, kind="percent", value=10, scope="catalog")
    wish(shop, user, product)

    response = get(shop, user)

    for leaked in (
        str(user),
        "user_id",
        "wishlist_id",
        "storage_path",
        "image_path",
        "order_policy",
        "promotion_id",
        "list_price",
        "price_cents",
        "on_hand",
        "reserved",
        "quantity",
        '"available":',  # el número de unidades; "status": "available" sí es válido
    ):
        assert leaked not in response.text, leaked
