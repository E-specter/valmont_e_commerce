"""`POST /api/v1/wishlist/items` y `DELETE /api/v1/wishlist/items/{product_id}` contra PostgreSQL
con clientes reales (T-068; CA-WISH-02 a 06, 09 y 11; SPEC §4 R1-R4, R10 y §7). Cada solicitud
corre en un SAVEPOINT de la transacción de la prueba. Datos ficticios; el token es el único origen
de la identidad."""

from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest

from tests.cart.cart_helpers import add_listed, set_product
from tests.cart.test_http_cart_db import Shop, money
from tests.identity.identity_helpers import make_token
from tests.promotions.promotions_helpers import add_promotion
from tests.wishlist import test_http_wishlist_db as reads
from tests.wishlist.test_http_wishlist_db import BASE, ITEM_KEYS, get, wish
from tests.wishlist.wishlist_helpers import add_entry, captured, entries_of
from valmont.modules.identity.domain import Role

pytestmark = pytest.mark.integration

ITEMS = "/api/v1/wishlist/items"
MAX_ITEMS = 50
shop = reads.shop
LIST_KEYS = {"items", "item_count", "max_items"}


def send(shop: Shop, method: str, user: UUID | None, path: str, body: Any = None) -> Any:
    headers = {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}
    return shop.client.request(method, path, headers=headers, json=body)


def post(shop: Shop, user: UUID | None, product: object = None, **extra: Any) -> Any:
    body: dict[str, Any] = {"product_id": str(product), **extra}
    return send(shop, "POST", user, ITEMS, body)


def delete(shop: Shop, user: UUID | None, product: object) -> Any:
    return send(shop, "DELETE", user, f"{ITEMS}/{product}")


def assert_list(response: Any) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == LIST_KEYS
    assert all(set(item) == ITEM_KEYS for item in body["items"])
    assert body["item_count"] == len(body["items"]) and body["max_items"] == MAX_ITEMS
    return body


def ids_of(body: dict[str, Any]) -> list[str]:
    return [item["product_id"] for item in body["items"]]


def assert_422_on(response: Any, *loc: str) -> None:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error" and set(response.json()) == {"error"}
    assert [d["loc"] for d in error["details"]] == [list(loc)], error["details"]
    assert all(set(d) == {"loc", "type", "msg"} for d in error["details"])  # sin "input"


def fill(shop: Shop, user: UUID, count: int, *, hidden: int = 0) -> list[UUID]:
    """Lista con `count` artículos (`hidden` de ellos despublicados), el último el más reciente."""
    products = [
        add_listed(shop.session, on_hand=3, status="draft" if n < hidden else "published")
        for n in range(count)
    ]
    wish(shop, user, *products)
    return products


# --------------------------------------------------------------------------------------------
# CA-WISH-02: agregar
def test_adding_a_published_product_returns_the_list_with_it_and_creates_the_row(
    shop: Shop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=250000, on_hand=5, image=("p/a.jpg", "A"))

    body = assert_list(post(shop, user, product))

    [item] = body["items"]
    assert item["product_id"] == str(product) and item["status"] == "available"
    assert item["unit_price"] == money(250000)
    assert item["availability"] == {"status": "in_stock", "lead_time_days": None}
    assert item["added_at"] and item["image"]["alt"] == "A"
    assert set(entries_of(shop.session, user)) == {product}


def test_the_new_item_comes_first_and_the_response_is_the_whole_list(shop: Shop) -> None:
    user = shop.user()
    first, second = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)

    assert ids_of(assert_list(post(shop, user, first))) == [str(first)]
    body = assert_list(post(shop, user, second))

    assert ids_of(body) == [str(second), str(first)]  # WISH-R8 y R10
    assert body == reads.read(shop, user)  # lo mismo que devuelve el GET


def test_a_sold_out_published_product_can_be_added(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=0)

    [item] = assert_list(post(shop, user, product))["items"]

    assert item["status"] == "available"
    assert item["availability"]["status"] == "out_of_stock"


def test_the_added_item_has_the_catalog_price_with_a_promotion(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1250000, on_hand=5)
    add_promotion(shop.session, kind="percent", value=15, scope="catalog")

    [item] = assert_list(post(shop, user, product))["items"]

    assert item["unit_price"] == money(1062500)
    assert item["original_price"] == money(1250000)
    assert item["discount_amount"] == money(187500)


def test_an_admin_adds_to_their_own_list(shop: Shop) -> None:
    admin, customer = shop.user(Role.ADMIN), shop.user()
    product = add_listed(shop.session, on_hand=3)

    assert ids_of(assert_list(post(shop, admin, product))) == [str(product)]
    assert reads.read(shop, customer)["items"] == []


# CA-WISH-03 / R1: idempotente
def test_adding_the_same_product_again_is_a_200_with_one_row_and_the_same_added_at(
    shop: Shop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    first = assert_list(post(shop, user, product))
    rows = entries_of(shop.session, user)

    with captured(shop.session) as statements:
        again = assert_list(post(shop, user, product))

    assert again == first  # misma lista, mismo added_at
    assert entries_of(shop.session, user) == rows and len(rows) == 1
    assert not any(
        s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for s in statements
    )


def test_adding_a_product_present_with_an_old_added_at_leaves_it_intact(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    wish(shop, user, product)

    [item] = assert_list(post(shop, user, product))["items"]

    assert entries_of(shop.session, user) == {product: BASE}
    assert item["added_at"].startswith("2026-12-01T05:00:00")


def test_the_same_product_in_two_lists_is_one_row_each(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=3)

    assert_list(post(shop, ana, product))
    assert_list(post(shop, luis, product))

    assert set(entries_of(shop.session, ana)) == {product}
    assert set(entries_of(shop.session, luis)) == {product}


def test_adding_never_changes_another_users_list(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    theirs, mine = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    wish(shop, luis, theirs)
    before = entries_of(shop.session, luis)

    body = assert_list(post(shop, ana, mine))

    assert ids_of(body) == [str(mine)]
    assert entries_of(shop.session, luis) == before


# CA-WISH-04 / R3: producto no agregable
def test_a_nonexistent_product_is_422_on_product_id_and_creates_nothing(shop: Shop) -> None:
    user = shop.user()

    response = post(shop, user, uuid4())

    assert_422_on(response, "body", "product_id")
    assert entries_of(shop.session, user) == {}
    assert "Traceback" not in response.text


def test_a_draft_product_is_422_on_product_id_and_creates_nothing(shop: Shop) -> None:
    user = shop.user()
    draft = add_listed(shop.session, status="draft")

    response = post(shop, user, draft)

    assert_422_on(response, "body", "product_id")
    assert entries_of(shop.session, user) == {}


def test_a_draft_and_a_nonexistent_product_get_the_same_error(shop: Shop) -> None:
    user = shop.user()
    draft = add_listed(shop.session, status="draft")

    missing = post(shop, user, uuid4())
    hidden = post(shop, user, draft)

    assert missing.status_code == hidden.status_code == 422
    assert missing.json() == hidden.json()  # no revela que el borrador existe
    assert str(draft) not in hidden.text


def test_a_product_unpublished_after_listing_cannot_be_added_by_another_customer(
    shop: Shop,
) -> None:
    ana, luis = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=3)
    wish(shop, ana, product)
    set_product(shop.session, product, status="draft")

    assert_422_on(post(shop, luis, product), "body", "product_id")
    assert entries_of(shop.session, luis) == {}


@pytest.mark.parametrize("value", ["no-es-uuid", "123", "", None, 7, {"a": 1}])
def test_a_malformed_product_id_is_422_on_product_id(shop: Shop, value: object) -> None:
    user = shop.user()

    response = send(shop, "POST", user, ITEMS, {"product_id": value})

    assert_422_on(response, "body", "product_id")
    assert entries_of(shop.session, user) == {}


def test_a_missing_product_id_is_422_on_product_id(shop: Shop) -> None:
    user = shop.user()

    assert_422_on(send(shop, user=user, method="POST", path=ITEMS, body={}), "body", "product_id")


@pytest.mark.parametrize("body", [[], "texto", 7, None])
def test_a_body_that_is_not_an_object_is_422_without_a_trace(shop: Shop, body: object) -> None:
    user = shop.user()

    response = send(shop, "POST", user, ITEMS, body)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "Traceback" not in response.text


@pytest.mark.parametrize(
    "extra",
    [
        {"user_id": str(uuid4())},
        {"unit_price": 1},
        {"price": 100},
        {"quantity": 2},
        {"added_at": "2020-01-01T00:00:00Z"},
    ],
)
def test_an_extra_field_in_the_body_is_422_and_changes_nothing(
    shop: Shop, extra: dict[str, Any]
) -> None:
    user, other = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=3)
    if "user_id" in extra:
        extra = {"user_id": str(other)}

    response = post(shop, user, product, **extra)

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert entries_of(shop.session, user) == {} and entries_of(shop.session, other) == {}


def test_a_user_id_in_the_body_never_selects_another_list(shop: Shop) -> None:
    user, victim = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=3)

    post(shop, user, product, user_id=str(victim))

    assert entries_of(shop.session, victim) == {}  # ni agregado ni nada


# CA-WISH-05 / R4: tope blando
def test_with_fifty_items_a_new_product_is_409_wishlist_full_and_changes_nothing(
    shop: Shop,
) -> None:
    user = shop.user()
    fill(shop, user, MAX_ITEMS)
    before = entries_of(shop.session, user)
    new = add_listed(shop.session, on_hand=3)

    response = post(shop, user, new)

    assert response.status_code == 409, response.text
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == "wishlist_full"
    assert body["error"]["details"] == {"max_items": MAX_ITEMS}
    assert body["error"]["message"] and "Traceback" not in response.text
    assert entries_of(shop.session, user) == before and new not in before


def test_with_fifty_items_one_already_present_is_a_200(shop: Shop) -> None:
    user = shop.user()
    products = fill(shop, user, MAX_ITEMS)

    body = assert_list(post(shop, user, products[7]))

    assert body["item_count"] == MAX_ITEMS
    assert ids_of(body) == [str(p) for p in reversed(products)]


def test_with_forty_nine_items_the_fiftieth_is_accepted_and_the_next_is_not(shop: Shop) -> None:
    user = shop.user()
    fill(shop, user, MAX_ITEMS - 1)
    fiftieth, fifty_first = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)

    assert assert_list(post(shop, user, fiftieth))["item_count"] == MAX_ITEMS
    assert post(shop, user, fifty_first).status_code == 409
    assert len(entries_of(shop.session, user)) == MAX_ITEMS


def test_after_removing_one_another_can_be_added(shop: Shop) -> None:
    user = shop.user()
    products = fill(shop, user, MAX_ITEMS)
    new = add_listed(shop.session, on_hand=3)
    assert post(shop, user, new).status_code == 409

    assert delete(shop, user, products[0]).status_code == 200
    body = assert_list(post(shop, user, new))

    assert body["item_count"] == MAX_ITEMS and str(new) in ids_of(body)


def test_unpublished_items_count_toward_the_cap(shop: Shop) -> None:
    user = shop.user()
    fill(shop, user, MAX_ITEMS, hidden=3)
    new = add_listed(shop.session, on_hand=3)

    response = post(shop, user, new)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "wishlist_full"


def test_the_cap_is_per_customer(shop: Shop) -> None:
    full, other = shop.user(), shop.user()
    fill(shop, full, MAX_ITEMS)
    product = add_listed(shop.session, on_hand=3)

    assert ids_of(assert_list(post(shop, other, product))) == [str(product)]


# CA-WISH-06 / UC-WISH-03: retirar
def test_deleting_removes_the_product_and_returns_the_list_without_it(shop: Shop) -> None:
    user = shop.user()
    keep, drop = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    wish(shop, user, keep, drop)

    body = assert_list(delete(shop, user, drop))

    assert ids_of(body) == [str(keep)]
    assert set(entries_of(shop.session, user)) == {keep}
    assert body == reads.read(shop, user)


def test_deleting_twice_is_a_200_both_times(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    wish(shop, user, product)

    assert assert_list(delete(shop, user, product))["items"] == []
    assert assert_list(delete(shop, user, product))["items"] == []


def test_deleting_a_product_that_was_never_there_or_does_not_exist_is_a_200(shop: Shop) -> None:
    user = shop.user()
    mine, unlisted = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    wish(shop, user, mine)

    for product in (unlisted, uuid4()):
        assert ids_of(assert_list(delete(shop, user, product))) == [str(mine)]
    assert set(entries_of(shop.session, user)) == {mine}


def test_deleting_a_product_only_in_another_users_list_does_not_touch_it(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    theirs, mine = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    wish(shop, luis, theirs)
    wish(shop, ana, mine)
    luis_before = entries_of(shop.session, luis)

    body = assert_list(delete(shop, ana, theirs))

    assert ids_of(body) == [str(mine)]
    assert entries_of(shop.session, luis) == luis_before
    assert [i["product_id"] for i in reads.read(shop, luis)["items"]] == [str(theirs)]


def test_deleting_a_product_in_both_lists_only_removes_my_row(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    shared = add_listed(shop.session, on_hand=3)
    wish(shop, ana, shared)
    wish(shop, luis, shared)

    assert assert_list(delete(shop, ana, shared))["items"] == []

    assert set(entries_of(shop.session, luis)) == {shared}


def test_an_unpublished_product_can_be_deleted(shop: Shop) -> None:
    user = shop.user()
    live, gone = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)
    wish(shop, user, live, gone)
    set_product(shop.session, gone, status="draft")
    before = assert_list(get(shop, user))
    assert [i["status"] for i in before["items"]] == ["unavailable", "available"]

    body = assert_list(delete(shop, user, gone))

    assert ids_of(body) == [str(live)] and set(entries_of(shop.session, user)) == {live}


def test_the_delete_response_keeps_the_data_of_the_remaining_items(shop: Shop) -> None:
    user = shop.user()
    keep = add_listed(shop.session, price=300000, on_hand=0, image=("p/k.jpg", "K"))
    drop = add_listed(shop.session, on_hand=3)
    wish(shop, user, keep, drop)

    [item] = assert_list(delete(shop, user, drop))["items"]

    assert item["unit_price"] == money(300000)
    assert item["availability"]["status"] == "out_of_stock" and item["image"]["alt"] == "K"


def test_a_malformed_path_product_id_is_422_on_the_path_and_deletes_nothing(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    wish(shop, user, product)

    response = delete(shop, user, "no-es-uuid")

    assert_422_on(response, "path", "product_id")
    assert set(entries_of(shop.session, user)) == {product}


# CA-WISH-09: sin token (las tres rutas) y sin efectos sobre listas ajenas
def test_without_a_token_post_and_delete_are_401_and_change_nothing(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    wish(shop, user, product)
    before = entries_of(shop.session, user)

    for response in (
        post(shop, None, add_listed(shop.session, on_hand=3)),
        delete(shop, None, product),
    ):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthenticated"

    assert entries_of(shop.session, user) == before


def test_no_write_route_ever_changes_a_list_that_is_not_the_callers(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    products = [add_listed(shop.session, on_hand=3) for _ in range(3)]
    wish(shop, luis, *products)
    before = entries_of(shop.session, luis)

    for product in products:
        post(shop, ana, product)
        delete(shop, ana, product)
    post(shop, ana, uuid4())
    post(shop, ana, products[0], user_id=str(luis))
    delete(shop, ana, "basura")

    assert entries_of(shop.session, luis) == before
    assert entries_of(shop.session, ana) == {}


# R10 / sin N+1 también al escribir
def test_the_number_of_statements_when_adding_does_not_grow_with_the_list(shop: Shop) -> None:
    small, big = shop.user(), shop.user()
    fill(shop, small, 1)
    fill(shop, big, 10)
    one, two = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=3)

    with captured(shop.session) as with_one:
        assert post(shop, small, one).status_code == 200
    with captured(shop.session) as with_ten:
        assert post(shop, big, two).status_code == 200

    assert len(with_one) == len(with_ten)


def test_the_number_of_statements_when_deleting_does_not_grow_with_the_list(shop: Shop) -> None:
    small, big = shop.user(), shop.user()
    (_, only) = fill(shop, small, 2)  # quedan artículos tras retirar: la lista no queda vacía
    many = fill(shop, big, 10)

    with captured(shop.session) as with_one:
        assert delete(shop, small, only).status_code == 200
    with captured(shop.session) as with_ten:
        assert delete(shop, big, many[0]).status_code == 200

    assert len(with_one) == len(with_ten)


def test_adding_with_distinct_instants_orders_by_most_recent_first(shop: Shop) -> None:
    user = shop.user()
    old = add_listed(shop.session, on_hand=3)
    add_entry(shop.session, user, old, BASE - timedelta(days=30))
    new = add_listed(shop.session, on_hand=3)

    body = assert_list(post(shop, user, new))

    assert ids_of(body) == [str(new), str(old)]
