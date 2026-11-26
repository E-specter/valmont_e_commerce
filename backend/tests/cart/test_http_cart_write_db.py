"""`POST/PATCH/DELETE /api/v1/cart/items` contra PostgreSQL con clientes reales (T-058; CA-CART-02
a 07, 10 y 11; SPEC §4 R1-R6, §7). Cada solicitud corre en un SAVEPOINT de la transacción de la
prueba. Datos ficticios; el token es el único origen de la identidad."""

from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.cart import test_http_cart_db as reads
from tests.cart.cart_helpers import add_listed, carts_of, lines_of, set_product
from tests.cart.test_http_cart_db import ITEM_KEYS, Shop, money
from tests.identity.identity_helpers import make_token
from tests.inventory.inventory_helpers import add_reservation
from tests.promotions.promotions_helpers import add_promotion
from valmont.modules.identity.domain import Role

pytestmark = pytest.mark.integration

ITEMS = "/api/v1/cart/items"
shop = reads.shop  # la misma fixture que las lecturas (cliente real, SAVEPOINT por solicitud)
CART_KEYS = {"items", "item_count", "selected_count", "total", "can_checkout"}


def send(shop: Shop, method: str, user: UUID | None, path: str, body: Any = None) -> Any:
    headers = {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}
    return shop.client.request(method, path, headers=headers, json=body)


def post(shop: Shop, user: UUID, product: object, quantity: object = None, **extra: Any) -> Any:
    body: dict[str, Any] = {"product_id": str(product), **extra}
    if quantity is not None:
        body["quantity"] = quantity
    return send(shop, "POST", user, ITEMS, body)


def patch(shop: Shop, user: UUID, product: object, body: Any) -> Any:
    return send(shop, "PATCH", user, f"{ITEMS}/{product}", body)


def delete(shop: Shop, user: UUID, product: object) -> Any:
    return send(shop, "DELETE", user, f"{ITEMS}/{product}")


def cart_id_of(shop: Shop, user: UUID) -> UUID:
    (cart_id,) = carts_of(shop.session, user)
    return cart_id


def assert_cart(response: Any) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == CART_KEYS
    assert all(set(item) == ITEM_KEYS for item in body["items"])
    return body


def assert_conflict(response: Any, code: str, details: dict[str, int]) -> None:
    assert response.status_code == 409, response.text
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code and body["error"]["details"] == details
    assert "Traceback" not in response.text


def assert_422_on(response: Any, *loc: str) -> None:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error" and set(response.json()) == {"error"}
    assert [d["loc"] for d in error["details"]] == [list(loc)], error["details"]
    assert all(set(d) == {"loc", "type", "msg"} for d in error["details"])  # sin "input"


# --------------------------------------------------------------------------------------------
# CA-CART-02: agregar
def test_adding_creates_the_cart_and_the_line_selected_with_quantity_one(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=250000, on_hand=5)
    assert carts_of(shop.session, user) == []

    body = assert_cart(post(shop, user, product))

    cart_id = cart_id_of(shop, user)
    assert lines_of(shop.session, cart_id) == {product: (1, True)}
    [item] = body["items"]
    assert item["product_id"] == str(product) and item["quantity"] == 1 and item["selected"]
    assert (body["item_count"], body["selected_count"], body["can_checkout"]) == (1, 1, True)
    assert body["total"] == money(250000)


def test_adding_with_a_quantity_sets_it(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=100000, on_hand=5)

    body = assert_cart(post(shop, user, product, 3))

    assert lines_of(shop.session, cart_id_of(shop, user)) == {product: (3, True)}
    assert body["items"][0]["subtotal"] == money(300000) and body["total"] == money(300000)


def test_adding_the_same_product_again_sums_into_one_line(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)

    post(shop, user, product, 1)
    body = assert_cart(post(shop, user, product, 2))

    cart_id = cart_id_of(shop, user)  # una sola fila de carrito
    assert lines_of(shop.session, cart_id) == {product: (3, True)}
    assert [i["quantity"] for i in body["items"]] == [3]


def test_adding_keeps_the_selection_state_of_an_existing_line(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (product, 1, False))

    assert_cart(post(shop, user, product, 1))

    assert lines_of(shop.session, cart_id) == {product: (2, False)}


def test_every_write_returns_the_full_cart_with_recalculated_totals(shop: Shop) -> None:
    user = shop.user()
    first = add_listed(shop.session, price=100000, on_hand=9)
    second = add_listed(shop.session, price=250000, on_hand=9)

    after_first = assert_cart(post(shop, user, first, 2))
    after_second = assert_cart(post(shop, user, second, 1))
    after_patch = assert_cart(patch(shop, user, first, {"quantity": 3}))
    after_unselect = assert_cart(patch(shop, user, second, {"selected": False}))
    after_delete = assert_cart(delete(shop, user, first))

    assert after_first["total"] == money(200000)
    assert [i["product_id"] for i in after_second["items"]] == [str(first), str(second)]
    assert after_second["total"] == money(450000) and after_second["item_count"] == 2
    assert after_patch["total"] == money(550000)
    assert (after_unselect["total"], after_unselect["selected_count"]) == (money(300000), 1)
    assert after_unselect["can_checkout"] is True
    assert [i["product_id"] for i in after_delete["items"]] == [str(second)]
    assert (after_delete["total"], after_delete["selected_count"]) == (money(0), 0)
    assert after_delete["can_checkout"] is False
    # La respuesta de escritura es la misma que devuelve la lectura posterior.
    assert shop.read(user) == after_delete


def test_the_server_prices_the_line_with_the_current_promotion(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1250000, on_hand=5)
    add_promotion(shop.session, kind="percent", value=15, scope="catalog")

    [item] = assert_cart(post(shop, user, product, 2))["items"]

    assert item["unit_price"] == money(1062500)
    assert item["original_price"] == money(1250000)
    assert item["discount_amount"] == money(187500)
    assert item["subtotal"] == money(2125000)


def test_prices_totals_and_amounts_in_the_body_are_rejected(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    for extra in ({"price": 1}, {"unit_price": {"amount": 1, "currency": "PEN"}}, {"total": 0}):
        response = post(shop, user, product, 1, **extra)
        assert response.status_code == 422, extra
    assert carts_of(shop.session, user) == []


# CA-CART-03: producto no agregable
def test_a_missing_and_a_draft_product_give_the_same_422_and_no_cart(shop: Shop) -> None:
    user = shop.user()
    draft = add_listed(shop.session, status="draft", on_hand=5)

    missing = post(shop, user, uuid4(), 1)
    hidden = post(shop, user, draft, 1)

    assert_422_on(missing, "body", "product_id")
    assert_422_on(hidden, "body", "product_id")
    assert missing.json() == hidden.json()  # no revela que el borrador existe
    assert carts_of(shop.session, user) == []


@pytest.mark.parametrize("value", ["no-es-un-uuid", "", 5, None, [str(uuid4())]])
def test_a_malformed_product_id_is_422_on_that_field(shop: Shop, value: object) -> None:
    user = shop.user()

    response = send(shop, "POST", user, ITEMS, {"product_id": value, "quantity": 1})

    assert_422_on(response, "body", "product_id")
    assert carts_of(shop.session, user) == []


def test_a_missing_product_id_is_422(shop: Shop) -> None:
    assert_422_on(send(shop, "POST", shop.user(), ITEMS, {"quantity": 1}), "body", "product_id")


def test_a_product_unpublished_after_listing_is_422(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    set_product(shop.session, product, status="draft", published_at=None)

    assert_422_on(post(shop, user, product), "body", "product_id")


# CA-CART-04: cantidad y disponibilidad (R3, R4, R5, RN-16)
@pytest.mark.parametrize("quantity", [0, -1, 6, 100, 1.5, "2", True, "uno", [1], {"n": 1}])
def test_an_invalid_quantity_on_post_is_422_and_changes_nothing(
    shop: Shop, quantity: object
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=20)

    response = send(shop, "POST", user, ITEMS, {"product_id": str(product), "quantity": quantity})

    assert_422_on(response, "body", "quantity")
    assert carts_of(shop.session, user) == []


# (política, en stock, cantidad actual, cantidad que se suma, resultado)
ADD_CASES = [
    ("stock", 3, 0, 3, 3),
    ("stock", 3, 0, 4, ("insufficient_stock", 3)),
    ("stock", 3, 2, 2, ("insufficient_stock", 3)),
    ("stock", 4, 3, 2, ("insufficient_stock", 4)),
    ("stock", 10, 0, 5, 5),
    ("stock", 10, 3, 2, 5),
    ("stock", 10, 3, 3, ("quantity_limit", 5)),
    ("stock", 10, 5, 1, ("quantity_limit", 5)),
    ("stock", 3, 3, 3, ("quantity_limit", 5)),  # R5: el tope del dominio gana al stock
    ("stock", 0, 5, 1, ("quantity_limit", 5)),
    ("stock", 1, 0, 1, 1),
    ("stock", 0, 0, 1, ("out_of_stock", 0)),
    ("stock", None, 0, 1, ("out_of_stock", 0)),
    ("stock", 0, 2, 1, ("out_of_stock", 0)),
    ("made_to_order", None, 0, 5, 5),
    ("made_to_order", 0, 2, 3, 5),
    ("made_to_order", None, 3, 3, ("quantity_limit", 5)),
    ("backorder", 0, 0, 5, 5),
    ("backorder", 1, 0, 5, 5),
    ("backorder", 0, 5, 1, ("quantity_limit", 5)),
]


@pytest.mark.parametrize(("policy", "on_hand", "current", "added", "outcome"), ADD_CASES)
def test_add_follows_the_r5_table(
    shop: Shop,
    policy: str,
    on_hand: int | None,
    current: int,
    added: int,
    outcome: int | tuple[str, int],
) -> None:
    user = shop.user()
    product = add_listed(shop.session, policy=policy, on_hand=on_hand)
    cart_id = shop.cart(user, (product, current, True)) if current else None

    response = post(shop, user, product, added)

    if isinstance(outcome, int):
        assert_cart(response)
        assert lines_of(shop.session, cart_id_of(shop, user)) == {product: (outcome, True)}
    else:
        assert_conflict(response, outcome[0], {"max_quantity": outcome[1]})
        # El rechazo no deja ningún cambio, ni siquiera un carrito vacío nuevo.
        if cart_id is None:
            assert carts_of(shop.session, user) == []
        else:
            assert lines_of(shop.session, cart_id) == {product: (current, True)}


def test_reservations_reduce_what_can_be_added(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    add_reservation(shop.session, product, 3)  # disponible = 2

    assert_conflict(post(shop, user, product, 3), "insufficient_stock", {"max_quantity": 2})
    assert_cart(post(shop, user, product, 2))


def test_a_made_to_order_product_is_added_with_its_lead_time(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, policy="made_to_order")

    [item] = assert_cart(post(shop, user, product, 2))["items"]

    assert item["status"] == "ok" and item["max_quantity"] == 5
    assert item["availability"] == {"status": "on_request", "lead_time_days": 21}


def test_a_rejected_add_to_a_cart_with_other_lines_changes_nothing(shop: Shop) -> None:
    user = shop.user()
    fine, scarce = add_listed(shop.session, on_hand=9), add_listed(shop.session, on_hand=1)
    cart_id = shop.cart(user, (fine, 2, False))
    before = lines_of(shop.session, cart_id)

    assert_conflict(post(shop, user, scarce, 2), "insufficient_stock", {"max_quantity": 1})

    assert lines_of(shop.session, cart_id) == before and shop.read(user)["item_count"] == 1


# CA-CART-04: el artículo 21
def test_the_21st_distinct_product_is_cart_full_but_an_existing_one_still_sums(shop: Shop) -> None:
    user = shop.user()
    products = [add_listed(shop.session, on_hand=9) for _ in range(21)]
    cart_id = shop.cart(user, *[(p, 1, True) for p in products[:20]])

    assert_conflict(post(shop, user, products[20], 1), "cart_full", {"max_lines": 20})
    assert products[20] not in lines_of(shop.session, cart_id)
    assert len(lines_of(shop.session, cart_id)) == 20
    assert_cart(post(shop, user, products[0], 2))  # existente con 20 líneas: permitido
    assert lines_of(shop.session, cart_id)[products[0]] == (3, True)
    assert_cart(delete(shop, user, products[1]))
    assert_cart(post(shop, user, products[20], 1))  # con un hueco, ya cabe
    assert len(lines_of(shop.session, cart_id)) == 20


def test_cart_full_applies_to_a_new_made_to_order_product_too(shop: Shop) -> None:
    user = shop.user()
    products = [add_listed(shop.session, on_hand=9) for _ in range(20)]
    shop.cart(user, *[(p, 1, True) for p in products])
    made_to_order = add_listed(shop.session, policy="made_to_order")

    assert_conflict(post(shop, user, made_to_order, 1), "cart_full", {"max_lines": 20})


# CA-CART-05: PATCH quantity
# (política, en stock, cantidad actual, cantidad final pedida, resultado)
PATCH_CASES = [
    ("stock", 3, 1, 3, 3),
    ("stock", 3, 1, 4, ("insufficient_stock", 3)),
    ("stock", 10, 1, 5, 5),
    ("stock", 10, 2, 1, 1),
    ("stock", 0, 2, 3, ("out_of_stock", 0)),
    ("stock", 0, 2, 1, 1),  # bajar siempre
    ("stock", 0, 2, 2, 2),  # igual no es subir
    ("stock", 2, 5, 4, 4),  # baja aunque la actual exceda el stock
    ("stock", 2, 3, 3, 3),
    ("stock", 2, 3, 4, ("insufficient_stock", 2)),
    ("made_to_order", None, 1, 5, 5),
    ("backorder", 0, 1, 5, 5),
]


@pytest.mark.parametrize(("policy", "on_hand", "current", "final", "outcome"), PATCH_CASES)
def test_patch_quantity_follows_the_r5_table_and_sets_the_final_value(
    shop: Shop,
    policy: str,
    on_hand: int | None,
    current: int,
    final: int,
    outcome: int | tuple[str, int],
) -> None:
    user = shop.user()
    product = add_listed(shop.session, policy=policy, on_hand=on_hand)
    cart_id = shop.cart(user, (product, current, True))

    response = patch(shop, user, product, {"quantity": final})

    if isinstance(outcome, int):
        body = assert_cart(response)
        assert lines_of(shop.session, cart_id) == {product: (outcome, True)}  # valor final
        assert body["items"][0]["quantity"] == outcome
    else:
        assert_conflict(response, outcome[0], {"max_quantity": outcome[1]})
        assert lines_of(shop.session, cart_id) == {product: (current, True)}


@pytest.mark.parametrize("quantity", [0, -1, 6, 1.5, "2", True, "uno"])
def test_an_invalid_quantity_on_patch_is_422_and_changes_nothing(
    shop: Shop, quantity: object
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=20)
    cart_id = shop.cart(user, (product, 2, True))

    assert_422_on(patch(shop, user, product, {"quantity": quantity}), "body", "quantity")

    assert lines_of(shop.session, cart_id) == {product: (2, True)}


def test_patch_of_a_product_not_in_the_cart_is_404_and_creates_nothing(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)

    for body in ({"quantity": 1}, {"selected": False}):
        response = patch(shop, user, product, body)
        assert response.status_code == 404, response.text
        assert response.json()["error"]["code"] == "not_found"
        assert set(response.json()) == {"error"}
    assert carts_of(shop.session, user) == []


def test_patch_of_a_product_not_in_a_non_empty_cart_is_404_and_changes_nothing(
    shop: Shop,
) -> None:
    user = shop.user()
    mine, absent = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=5)
    cart_id = shop.cart(user, (mine, 2, True))

    assert patch(shop, user, absent, {"quantity": 1}).status_code == 404
    assert patch(shop, user, uuid4(), {"quantity": 1}).status_code == 404

    assert lines_of(shop.session, cart_id) == {mine: (2, True)}


# CA-CART-05: validación del PATCH
@pytest.mark.parametrize(
    "body",
    [{}, {"quantity": None, "selected": None}],
    ids=["empty", "all null"],
)
def test_patch_without_any_field_is_422_on_the_body(shop: Shop, body: dict[str, Any]) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    cart_id = shop.cart(user, (product, 2, True))

    response = patch(shop, user, product, body)

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert ["body"] in [d["loc"] for d in response.json()["error"]["details"]]
    assert lines_of(shop.session, cart_id) == {product: (2, True)}


@pytest.mark.parametrize("selected", ["yes", "true", 1, 0, "", [True]])
def test_selected_must_be_a_strict_boolean(shop: Shop, selected: object) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    cart_id = shop.cart(user, (product, 2, True))

    assert_422_on(patch(shop, user, product, {"selected": selected}), "body", "selected")

    assert lines_of(shop.session, cart_id) == {product: (2, True)}


@pytest.mark.parametrize(
    "extra",
    [{"user_id": str(uuid4())}, {"cart_id": str(uuid4())}, {"price": 1}, {"product_id": "x"}],
)
def test_patch_rejects_extra_fields(shop: Shop, extra: dict[str, Any]) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    cart_id = shop.cart(user, (product, 2, True))

    response = patch(shop, user, product, {"quantity": 3, **extra})

    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_error"
    assert lines_of(shop.session, cart_id) == {product: (2, True)}


def test_a_malformed_route_product_id_is_422_on_the_path(shop: Shop) -> None:
    user = shop.user()

    for method, body in (("PATCH", {"quantity": 1}), ("DELETE", None)):
        response = send(shop, method, user, f"{ITEMS}/no-es-un-uuid", body)
        assert_422_on(response, "path", "product_id")


# CA-CART-07: selected
def test_patch_selected_toggles_the_flag_and_recalculates_the_total(shop: Shop) -> None:
    user = shop.user()
    a, b = add_listed(shop.session, price=100000, on_hand=9), add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (a, 2, True), (b, 1, True))

    off = assert_cart(patch(shop, user, a, {"selected": False}))
    assert lines_of(shop.session, cart_id) == {a: (2, False), b: (1, True)}  # la cantidad no cambia
    assert (off["selected_count"], off["item_count"], off["total"]) == (1, 2, money(100000))
    assert [i["selected"] for i in off["items"]] == [False, True]

    none = assert_cart(patch(shop, user, b, {"selected": False}))
    assert (none["total"], none["selected_count"], none["can_checkout"]) == (money(0), 0, False)

    back = assert_cart(patch(shop, user, a, {"selected": True}))
    assert (back["total"], back["selected_count"], back["can_checkout"]) == (
        money(200000),
        1,
        True,
    )


def test_selected_never_looks_at_stock_or_publication(shop: Shop) -> None:
    user = shop.user()
    gone, scarce = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=0)
    cart_id = shop.cart(user, (gone, 2, True), (scarce, 3, True))
    set_product(shop.session, gone, status="draft", published_at=None)

    for product in (gone, scarce):
        assert_cart(patch(shop, user, product, {"selected": False}))
        assert_cart(patch(shop, user, product, {"selected": True}))

    assert lines_of(shop.session, cart_id) == {gone: (2, True), scarce: (3, True)}


def test_one_patch_can_change_quantity_and_selection_together(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (product, 1, True))

    assert_cart(patch(shop, user, product, {"quantity": 4, "selected": False}))

    assert lines_of(shop.session, cart_id) == {product: (4, False)}


def test_a_rejected_combined_patch_changes_neither_field(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=2)
    cart_id = shop.cart(user, (product, 1, True))

    assert_conflict(
        patch(shop, user, product, {"quantity": 4, "selected": False}),
        "insufficient_stock",
        {"max_quantity": 2},
    )

    assert lines_of(shop.session, cart_id) == {product: (1, True)}


# CA-CART-09 / R5: un artículo que dejó de estar disponible
def test_an_unpublished_line_can_be_lowered_unselected_and_removed_but_not_raised(
    shop: Shop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (product, 3, True))
    set_product(shop.session, product, status="draft", published_at=None)

    # max_quantity vale 0 (R4): subir es 409 out_of_stock (decisión del Leader).
    assert_conflict(
        patch(shop, user, product, {"quantity": 4}), "out_of_stock", {"max_quantity": 0}
    )
    assert lines_of(shop.session, cart_id) == {product: (3, True)}
    lowered = assert_cart(patch(shop, user, product, {"quantity": 2}))
    assert lowered["items"][0]["status"] == "unavailable"
    assert_cart(patch(shop, user, product, {"selected": False}))
    assert lines_of(shop.session, cart_id) == {product: (2, False)}
    assert assert_cart(delete(shop, user, product))["items"] == []


# CA-CART-06: DELETE
def test_delete_removes_the_line_and_is_idempotent(shop: Shop) -> None:
    user = shop.user()
    keep, drop = add_listed(shop.session, on_hand=9), add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (keep, 1, True), (drop, 2, True))

    first = assert_cart(delete(shop, user, drop))
    second = assert_cart(delete(shop, user, drop))

    assert lines_of(shop.session, cart_id) == {keep: (1, True)}
    assert [i["product_id"] for i in first["items"]] == [str(keep)]
    assert second == first


def test_delete_of_an_absent_or_unknown_product_is_200_with_the_cart_unchanged(
    shop: Shop,
) -> None:
    user = shop.user()
    mine, other = add_listed(shop.session, on_hand=9), add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (mine, 2, True))

    for product in (other, uuid4()):
        body = assert_cart(delete(shop, user, product))
        assert [i["product_id"] for i in body["items"]] == [str(mine)]
    assert lines_of(shop.session, cart_id) == {mine: (2, True)}


def test_delete_without_a_cart_is_200_with_an_empty_cart(shop: Shop) -> None:
    user = shop.user()

    body = assert_cart(delete(shop, user, uuid4()))

    assert (body["items"], body["item_count"], body["total"]) == ([], 0, money(0))


def test_delete_removes_unavailable_and_out_of_stock_lines(shop: Shop) -> None:
    user = shop.user()
    gone, scarce = add_listed(shop.session, on_hand=5), add_listed(shop.session, on_hand=0)
    cart_id = shop.cart(user, (gone, 1, True), (scarce, 1, True))
    set_product(shop.session, gone, status="draft", published_at=None)

    assert_cart(delete(shop, user, gone))
    assert assert_cart(delete(shop, user, scarce))["items"] == []

    assert lines_of(shop.session, cart_id) == {}


def test_a_removed_product_can_be_added_again_as_a_new_selected_line(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (product, 4, False))

    delete(shop, user, product)
    assert_cart(post(shop, user, product))

    assert lines_of(shop.session, cart_id) == {product: (1, True)}


# CA-CART-11 / RN-10: aislamiento entre clientes
def test_a_customer_cannot_patch_a_line_that_only_exists_in_another_cart(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    mine, theirs = add_listed(shop.session, on_hand=9), add_listed(shop.session, on_hand=9)
    ana_cart = shop.cart(ana, (mine, 1, True))
    luis_cart = shop.cart(luis, (theirs, 2, True))

    quantity = patch(shop, ana, theirs, {"quantity": 5})
    selected = patch(shop, ana, theirs, {"selected": False})

    assert quantity.status_code == selected.status_code == 404
    assert str(luis) not in quantity.text
    assert lines_of(shop.session, luis_cart) == {theirs: (2, True)}
    assert lines_of(shop.session, ana_cart) == {mine: (1, True)}


def test_deleting_by_the_product_id_of_another_cart_changes_nothing_there(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    mine, theirs = add_listed(shop.session, on_hand=9), add_listed(shop.session, on_hand=9)
    shop.cart(ana, (mine, 1, True))
    luis_cart = shop.cart(luis, (theirs, 2, True))

    body = assert_cart(delete(shop, ana, theirs))

    assert [i["product_id"] for i in body["items"]] == [str(mine)]
    assert str(theirs) not in str(body)
    assert lines_of(shop.session, luis_cart) == {theirs: (2, True)}


def test_two_customers_with_the_same_product_do_not_touch_each_other(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    shared = add_listed(shop.session, on_hand=9)
    ana_cart = shop.cart(ana, (shared, 1, True))
    luis_cart = shop.cart(luis, (shared, 3, True))

    assert_cart(post(shop, ana, shared, 2))
    assert_cart(patch(shop, ana, shared, {"selected": False}))
    assert lines_of(shop.session, ana_cart) == {shared: (3, False)}
    assert lines_of(shop.session, luis_cart) == {shared: (3, True)}
    assert_cart(delete(shop, ana, shared))

    assert lines_of(shop.session, ana_cart) == {}
    assert lines_of(shop.session, luis_cart) == {shared: (3, True)}
    assert len(shop.read(luis)["items"]) == 1


def test_a_first_add_for_one_customer_never_creates_or_changes_another_cart(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=9)

    assert_cart(post(shop, ana, product))

    assert carts_of(shop.session, luis) == [] and len(carts_of(shop.session, ana)) == 1


@pytest.mark.parametrize("field", ["user_id", "cart_id", "customer_id"])
def test_identity_fields_in_the_body_are_422_and_never_used(shop: Shop, field: str) -> None:
    ana, luis = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=9)
    luis_cart = shop.cart(luis, (product, 1, True))

    response = send(shop, "POST", ana, ITEMS, {"product_id": str(product), field: str(luis)})

    assert response.status_code == 422
    assert lines_of(shop.session, luis_cart) == {product: (1, True)}
    assert carts_of(shop.session, ana) == []


def test_query_string_ids_do_not_redirect_a_write_to_another_cart(shop: Shop) -> None:
    ana, luis = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=9)
    luis_cart = shop.cart(luis, (product, 1, True))
    headers = {"Authorization": f"Bearer {make_token(str(ana))}"}

    response = shop.client.post(
        ITEMS,
        headers=headers,
        params={"user_id": str(luis), "cart_id": str(luis_cart)},
        json={"product_id": str(product)},
    )

    assert response.status_code == 200
    assert lines_of(shop.session, luis_cart) == {product: (1, True)}
    assert lines_of(shop.session, cart_id_of(shop, ana)) == {product: (1, True)}


def test_an_admin_writes_only_on_their_own_cart(shop: Shop) -> None:
    admin, customer = shop.user(Role.ADMIN), shop.user()
    product = add_listed(shop.session, on_hand=9)
    customer_cart = shop.cart(customer, (product, 1, True))

    assert_cart(post(shop, admin, product, 2))
    assert delete(shop, admin, uuid4()).status_code == 200
    assert patch(shop, admin, uuid4(), {"quantity": 1}).status_code == 404

    assert lines_of(shop.session, customer_cart) == {product: (1, True)}
    assert lines_of(shop.session, cart_id_of(shop, admin)) == {product: (2, True)}


def test_without_a_token_nothing_is_written_and_nothing_is_revealed(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)
    cart_id = shop.cart(user, (product, 2, True))

    responses = [
        send(shop, "POST", None, ITEMS, {"product_id": str(product)}),
        send(shop, "PATCH", None, f"{ITEMS}/{product}", {"quantity": 1}),
        send(shop, "DELETE", None, f"{ITEMS}/{product}"),
    ]

    for response in responses:
        assert response.status_code == 401 and set(response.json()) == {"error"}
    assert lines_of(shop.session, cart_id) == {product: (2, True)}


# CART-R14: sin auditoría
def audit_rows(shop: Shop) -> int:
    return shop.session.scalar(text("SELECT count(*) FROM app.audit_log")) or 0


def test_cart_writes_leave_no_audit_rows(shop: Shop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=9)
    before = audit_rows(shop)

    post(shop, user, product, 2)
    patch(shop, user, product, {"quantity": 3})
    patch(shop, user, product, {"selected": False})
    post(shop, user, product, 5)  # 409
    delete(shop, user, product)

    assert audit_rows(shop) == before
