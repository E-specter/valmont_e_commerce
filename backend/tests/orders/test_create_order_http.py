"""`POST /api/v1/orders` por HTTP contra PostgreSQL con cart, inventory y promotions reales (T-074;
CA-ORDERS-01, 04, 08, 11, 22; SPEC §3 UC-01, §4 R8 y R13, §7). Cada solicitud corre en un SAVEPOINT
de la transacción de la prueba. Datos ficticios; el token es el único origen de la identidad."""

import re
from typing import Any
from uuid import UUID, uuid4

import pytest

from tests.cart.cart_helpers import add_listed, captured, lines_of, set_product
from tests.identity.identity_helpers import use_test_auth
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_create_helpers import DETAIL_KEYS, LINE_KEYS
from tests.orders.orders_http_helpers import (
    PICKUP,
    SHIPPING,
    OrderShop,
    effects,
    money,
    order_row,
    parse_utc,
    place,
    post_raw,
    quick,
    stock_in_cart,
)

pytestmark = pytest.mark.integration

shop = helpers.shop
DELIVERY_KEYS = {
    "delivery_method",
    "recipient_name",
    "phone",
    "department",
    "province",
    "district",
    "address_line",
    "reference",
    "pickup_store",
    "carrier",
    "tracking_code",
    "shipped_at",
}


def error_of(response: Any, status: int, code: str) -> Any:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code, body
    assert "Traceback" not in response.text and "sqlalchemy" not in response.text.lower()
    return body["error"]["details"]


def assert_422_in_delivery(response: Any, field: str | None) -> None:
    """422 con `loc` ["body", "delivery", …, campo]; sin campo (unión): solo el prefijo."""
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error" and set(response.json()) == {"error"}
    assert all(set(d) == {"loc", "type", "msg"} for d in error["details"])  # sin "input" (PII)
    locs = [d["loc"] for d in error["details"]]
    assert all(loc[:2] == ["body", "delivery"] for loc in locs), locs
    if field is not None:
        assert any(loc[-1] == field for loc in locs), locs


# --------------------------------------------------------------------------------------------
# CA-ORDERS-01: crear desde el carrito
def test_it_creates_a_pending_order_with_one_line_per_selected_item_and_keeps_the_rest(
    shop: OrderShop,
) -> None:
    user = shop.user()
    a, b, c = (add_listed(shop.session, on_hand=9) for _ in range(3))
    cart_id = shop.cart(user, (a, 2, True), (b, 1, True), (c, 3, False))

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "pendiente_pago"
    assert {ln["product_id"]: ln["quantity"] for ln in body["lines"]} == {str(a): 2, str(b): 1}
    assert body["item_count"] == 3  # Σ cantidades
    assert lines_of(shop.session, cart_id) == {c: (3, False)}  # solo queda lo no seleccionado
    assert order_row(shop.session, body["id"])["user_id"] == user
    assert effects(shop.session, user)["orders"] == 1


def test_without_a_session_it_is_401_and_creates_nothing(shop: OrderShop) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    missing = place(shop, None)
    garbage = place(shop, None, headers={"Authorization": "Bearer no-es-un-token"})

    assert error_of(missing, 401, "unauthenticated") is None
    error_of(garbage, 401, "unauthenticated")
    assert effects(shop.session, user, product) == before


def test_with_the_identity_provider_down_it_is_503(
    shop: OrderShop, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, product = quick(shop)
    use_test_auth(monkeypatch, jwks=None)
    before = effects(shop.session, user, product)

    response = place(shop, user)

    error_of(response, 503, "auth_unavailable")
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("selected", [False, None])
def test_a_cart_without_selected_items_is_409_empty_selection_and_changes_nothing(
    shop: OrderShop, selected: bool | None
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    if selected is not None:  # None: el cliente ni siquiera tiene carrito
        shop.cart(user, (product, 2, selected))
    before = effects(shop.session, user, product)

    response = place(shop, user)

    error_of(response, 409, "empty_selection")
    assert effects(shop.session, user, product) == before
    assert effects(shop.session, user)["orders"] == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-04 / R13: la entrega
INVALID_SHIPPING = [
    ("recipient_name", "A"),
    ("recipient_name", "A" * 81),
    ("recipient_name", "   "),
    ("recipient_name", "Ana\nPérez"),
    ("recipient_name", "Ana\x00Pérez"),
    ("recipient_name", 12345),
    ("phone", "abc"),
    ("phone", "12345"),
    ("phone", "1" * 16),
    ("phone", "++5198765432"),
    ("phone", "98765432\n"),
    ("department", "L"),
    ("department", "L" * 41),
    ("department", "Li\tma"),
    ("province", "L"),
    ("province", "P" * 41),
    ("province", "Li\nma"),
    ("district", "M"),
    ("district", "M" * 41),
    ("district", "Mira\x07flores"),
    ("address_line", "Av.1"),
    ("address_line", "A" * 151),
    ("address_line", "Av. Larco\n345"),
    ("reference", "R" * 151),
    ("reference", "Frente\nal parque"),
]


@pytest.mark.parametrize(("field", "value"), INVALID_SHIPPING)
def test_an_invalid_shipping_field_is_422_on_that_field_and_creates_nothing(
    shop: OrderShop, field: str, value: Any
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=SHIPPING | {field: value})

    assert_422_in_delivery(response, field)
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("field", ["department", "province", "district", "address_line"])
def test_a_shipping_order_without_a_required_location_field_is_422(
    shop: OrderShop, field: str
) -> None:
    user, product = quick(shop)
    delivery = {k: v for k, v in SHIPPING.items() if k != field}

    response = place(shop, user, delivery=delivery)

    assert_422_in_delivery(response, field)
    assert effects(shop.session, user, product)["orders"] == 0


@pytest.mark.parametrize("field", ["recipient_name", "phone"])
@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
def test_name_and_phone_are_required_in_both_modes(
    shop: OrderShop, method: dict[str, Any], field: str
) -> None:
    user, _ = quick(shop)

    response = place(shop, user, delivery={k: v for k, v in method.items() if k != field})

    assert_422_in_delivery(response, field)


@pytest.mark.parametrize("phone", ["abc", "12345", "1" * 16])
def test_the_phone_format_is_checked_in_pickup_too(shop: OrderShop, phone: str) -> None:
    user, _ = quick(shop)

    assert_422_in_delivery(place(shop, user, delivery=PICKUP | {"phone": phone}), "phone")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("department", "Lima"),
        ("province", "Lima"),
        ("district", "Miraflores"),
        ("address_line", "Av. Larco 345, piso 4"),
        ("reference", "Frente al parque"),
    ],
)
def test_a_shipping_only_field_with_pickup_is_422_and_creates_nothing(
    shop: OrderShop, field: str, value: str
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=PICKUP | {field: value})

    assert_422_in_delivery(response, field)
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize(
    "delivery",
    [
        {**SHIPPING, "delivery_method": "courier"},
        {**SHIPPING, "delivery_method": "SHIPPING"},
        {**SHIPPING, "delivery_method": None},
        {k: v for k, v in SHIPPING.items() if k != "delivery_method"},
        {
            "delivery_method": "pickup",
            "recipient_name": "Ana Torres",
            "phone": "987654321",
            "pickup_store": "Otra",
        },  # fmt: skip
    ],
)
def test_an_unknown_or_missing_delivery_method_or_extra_field_is_422(
    shop: OrderShop, delivery: dict[str, Any]
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    assert_422_in_delivery(place(shop, user, delivery=delivery), None)
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("delivery", [None, "Lima", 5, [], {}])
def test_delivery_is_required_and_must_be_an_object(shop: OrderShop, delivery: Any) -> None:
    user, product = quick(shop)
    body: dict[str, Any] = {} if delivery is None else {"delivery": delivery}

    response = post_raw(shop, user, body)

    assert_422_in_delivery(response, None)
    assert effects(shop.session, user, product)["orders"] == 0


def test_a_request_without_a_body_is_422(shop: OrderShop) -> None:
    user, _ = quick(shop)

    assert post_raw(shop, user, None).status_code == 422


def test_a_422_never_echoes_what_the_client_sent(shop: OrderShop) -> None:
    user, _ = quick(shop)

    response = place(
        shop, user, delivery=SHIPPING | {"recipient_name": "SECRETO\nPersona", "phone": "x"}
    )

    assert response.status_code == 422
    assert "SECRETO" not in response.text and "Persona" not in response.text


def test_boundary_lengths_are_accepted_and_the_order_stores_them_as_given(
    shop: OrderShop,
) -> None:
    user, _ = quick(shop)
    delivery = SHIPPING | {
        "recipient_name": "N" * 80,
        "phone": "+" + "9" * 15,
        "department": "D" * 40,
        "province": "P" * 40,
        "district": "Di",
        "address_line": "A" * 150,
        "reference": "R" * 150,
    }

    response = place(shop, user, delivery=delivery)

    assert response.status_code == 201, response.text
    sent = response.json()["delivery"]
    assert {k: sent[k] for k in delivery if k != "delivery_method"} == {
        k: v for k, v in delivery.items() if k != "delivery_method"
    }
    minimum = SHIPPING | {"recipient_name": "Ab", "phone": "123456", "department": "Li",
                          "province": "Li", "district": "Mi", "address_line": "Av. 1"}  # fmt: skip
    user2, _ = quick(shop)
    assert place(shop, user2, delivery=minimum).status_code == 201


def test_the_reference_is_optional_and_comes_back_null(shop: OrderShop) -> None:
    user, _ = quick(shop)
    delivery = {k: v for k, v in SHIPPING.items() if k != "reference"}

    response = place(shop, user, delivery=delivery)

    assert response.status_code == 201, response.text
    assert response.json()["delivery"]["reference"] is None


def test_spaces_are_trimmed_and_repeated_spaces_collapsed(shop: OrderShop) -> None:
    user, _ = quick(shop)
    delivery = SHIPPING | {
        "recipient_name": "  Ana    María   Torres  ",
        "district": " Santiago   de   Surco ",
        "address_line": "  Av.   Larco   345  ",
    }

    response = place(shop, user, delivery=delivery)

    assert response.status_code == 201, response.text
    sent = response.json()["delivery"]
    assert sent["recipient_name"] == "Ana María Torres"
    assert sent["district"] == "Santiago de Surco"
    assert sent["address_line"] == "Av. Larco 345"
    stored = helpers.scalar(
        shop.session, "SELECT recipient_name FROM app.deliveries WHERE order_id = :id",
        id=UUID(response.json()["id"]),
    )  # fmt: skip
    assert stored == "Ana María Torres"


def test_text_that_looks_like_sql_or_html_is_stored_and_returned_as_plain_text(
    shop: OrderShop,
) -> None:
    user, _ = quick(shop)
    name = "Robert'); DROP TABLE app.orders;--"
    reference = "<script>alert(1)</script>"

    response = place(
        shop, user, delivery=SHIPPING | {"recipient_name": name, "reference": reference}
    )

    assert response.status_code == 201, response.text
    assert response.json()["delivery"]["recipient_name"] == name
    assert response.json()["delivery"]["reference"] == reference
    assert helpers.scalar(shop.session, "SELECT count(*) FROM app.orders") >= 1  # la tabla sigue


def test_shipping_is_free_in_both_modes(shop: OrderShop) -> None:
    for method in (SHIPPING, PICKUP):
        user, _ = quick(shop, price=100000)
        body = place(shop, user, delivery=method).json()
        assert body["shipping"] == money(0) and body["total"] == body["subtotal"], method
        assert helpers.order_row(shop.session, body["id"])["shipping_amount"] == 0


# --------------------------------------------------------------------------------------------
# CA-ORDERS-08 / R8: la cabecera Idempotency-Key
@pytest.mark.parametrize(
    "key",
    [
        "a" * 15,
        "a" * 65,
        "clave con espacios 12",
        "clave.con.punto.0000",
        "clave/con/barra/0000",
        "!" * 20,
        "a" * 15 + ".",
    ],
)
def test_a_malformed_idempotency_key_is_422_on_the_header_and_creates_nothing(
    shop: OrderShop, key: str
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, key=key)

    assert response.status_code == 422, response.text
    locs = [
        [p.lower() if isinstance(p, str) else p for p in d["loc"]]
        for d in response.json()["error"]["details"]
    ]
    assert ["header", "idempotency-key"] in locs
    assert effects(shop.session, user, product) == before


def test_a_missing_idempotency_key_is_422_on_the_header_and_creates_nothing(
    shop: OrderShop,
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, key=None)

    assert response.status_code == 422, response.text
    locs = [[p.lower() for p in d["loc"]] for d in response.json()["error"]["details"]]
    assert ["header", "idempotency-key"] in locs
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("length", [16, 64])
def test_the_key_limits_are_inclusive_and_all_allowed_characters_work(
    shop: OrderShop, length: int
) -> None:
    user, _ = quick(shop)
    key = ("aZ09_-" * 20)[:length]

    assert place(shop, user, key=key).status_code == 201


def test_the_key_header_name_is_case_insensitive_like_any_http_header(shop: OrderShop) -> None:
    user, _ = quick(shop)
    response = place(shop, user, key=None, headers={"idempotency-key": helpers.fresh_key()})

    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------------------------
# CA-ORDERS-11: forma del detalle recién creado
def test_the_created_order_has_exactly_the_contract_shape(shop: OrderShop) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=250000, on_hand=9, name="Heritage 38")
    stock_in_cart(shop, user, (product, 2))

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == DETAIL_KEYS
    assert UUID(body["id"]) and re.fullmatch(r"VAL-\d{6,}", body["number"])
    row = order_row(shop.session, body["id"])
    assert body["number"] == f"VAL-{row['order_number']:06d}"
    assert (body["status"], body["item_count"], body["paid_at"]) == ("pendiente_pago", 2, None)
    assert (body["total"], body["subtotal"], body["shipping"]) == (
        money(500000),
        money(500000),
        money(0),
    )
    assert body["estimated_delivery_on"] is None and body["refund"] is None
    assert body["can_cancel"] is True
    assert 0 < body["expires_in_seconds"] <= 30 * 60
    created, expires = parse_utc(body["created_at"]), parse_utc(body["expires_at"])
    assert body["created_at"].endswith("Z") and body["expires_at"].endswith("Z")
    assert (expires - created).total_seconds() == 30 * 60
    assert created == row["created_at"] and expires == row["expires_at"]
    [line] = body["lines"]
    assert set(line) == LINE_KEYS
    assert (line["product_id"], line["name"], line["quantity"]) == (str(product), "Heritage 38", 2)
    assert (line["list_price"], line["unit_price"]) == (money(250000), money(250000))
    assert (line["discount_amount"], line["line_total"]) == (money(0), money(500000))
    assert line["fulfillment"] == "stock"
    assert set(body["delivery"]) == DELIVERY_KEYS
    assert body["delivery"] == {
        "delivery_method": "shipping",
        "recipient_name": "Ana Torres",
        "phone": "+51987654321",
        "department": "Lima",
        "province": "Lima",
        "district": "Miraflores",
        "address_line": "Av. Larco 345, piso 4",
        "reference": "Frente al parque",
        "pickup_store": None,
        "carrier": None,
        "tracking_code": None,
        "shipped_at": None,
    }
    assert body["history"] == [
        {
            "from_status": None,
            "status": "pendiente_pago",
            "at": body["created_at"],
            "actor": "customer",
        }
    ]


def test_the_customer_response_carries_no_user_id_no_notes_and_no_internal_fields(
    shop: OrderShop,
) -> None:
    user, _ = quick(shop)

    response = place(shop, user)

    text = response.text
    for internal in ("user_id", "actor_id", "idempotency", "note", str(user)):
        assert internal not in text, internal


def test_amounts_are_json_integers_with_the_pen_currency(shop: OrderShop) -> None:
    user, _ = quick(shop, price=123457)

    body = place(shop, user).json()

    for key in ("total", "subtotal", "shipping"):
        assert set(body[key]) == {"amount", "currency"} and body[key]["currency"] == "PEN"
        assert type(body[key]["amount"]) is int
    for line in body["lines"]:
        for key in ("list_price", "unit_price", "discount_amount", "line_total"):
            assert type(line[key]["amount"]) is int


def test_a_line_shows_the_current_image_of_its_product(shop: OrderShop) -> None:
    # D-041 P-7: la imagen no se guarda en el pedido; se lee del lector compartido.
    user = shop.user()
    with_image = add_listed(
        shop.session, on_hand=5, image=("heritage/frontal 1.jpg", "Vista frontal")
    )
    without = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (with_image, 1), (without, 1))

    body = place(shop, user).json()

    images = {ln["product_id"]: ln["image"] for ln in body["lines"]}
    assert images[str(with_image)] == {
        "url": f"{helpers.CDN}/storage/v1/object/public/products/heritage/frontal%201.jpg",
        "alt": "Vista frontal",
    }
    assert images[str(without)] is None


def test_the_image_is_null_when_the_product_is_no_longer_published_even_on_a_replay(
    shop: OrderShop,
) -> None:
    user = shop.user()
    gone = add_listed(shop.session, on_hand=5, image=("p/a.jpg", "Reloj A"))
    stays = add_listed(shop.session, on_hand=5, image=("p/b.jpg", "Reloj B"))
    stock_in_cart(shop, user, (gone, 1), (stays, 1))
    first = place(shop, user, key="clave-de-reintento-0001")
    assert first.status_code == 201

    set_product(shop.session, gone, status="draft")
    replay = place(shop, user, key="clave-de-reintento-0001")

    assert replay.status_code == 200
    images = {ln["product_id"]: ln["image"] for ln in replay.json()["lines"]}
    assert images[str(gone)] is None
    assert images[str(stays)]["alt"] == "Reloj B"
    # el resto de la instantánea no cambia (CA-ORDERS-02)
    names = {ln["product_id"]: ln["name"] for ln in first.json()["lines"]}
    assert names == {ln["product_id"]: ln["name"] for ln in replay.json()["lines"]}


def test_the_images_of_all_lines_are_read_with_one_query(shop: OrderShop) -> None:
    user = shop.user()
    products = [
        add_listed(shop.session, on_hand=5, image=(f"p/{n}.jpg", "Reloj")) for n in range(4)
    ]
    stock_in_cart(shop, user, *((p, 1) for p in products))
    place(shop, user, key="clave-de-reintento-0002")

    with captured(shop.session) as statements:
        replay = place(shop, user, key="clave-de-reintento-0002")  # sin PrepareCheckout

    assert replay.status_code == 200
    assert len([s for s in statements if "product_images" in s]) == 1


# --------------------------------------------------------------------------------------------
# CA-ORDERS-22: aislamiento y entradas que no cuentan
@pytest.mark.parametrize(
    "extra",
    [
        {"user_id": str(uuid4())},
        {"total": 1},
        {"total": {"amount": 1, "currency": "PEN"}},
        {"subtotal": 1},
        {"shipping_amount": 0},
        {"price": 1},
        {"unit_price": {"amount": 1, "currency": "PEN"}},
        {"lines": [{"product_id": str(uuid4()), "quantity": 1}]},
        {"items": []},
        {"status": "pagado"},
        {"paid_at": "2026-12-01T00:00:00Z"},
        {"idempotency_key": "otra-clave-0000000000"},
        {"discount": 99},
    ],
)
def test_a_top_level_field_outside_the_contract_is_422_and_creates_nothing(
    shop: OrderShop, extra: dict[str, Any]
) -> None:
    user, product = quick(shop)
    before = effects(shop.session, user, product)

    response = place(shop, user, extra=extra)

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize(
    "extra", [{"user_id": "x"}, {"total": 1}, {"unit_price": 1}, {"status": "p"}]
)
@pytest.mark.parametrize("method", [SHIPPING, PICKUP])
def test_a_field_outside_the_contract_inside_delivery_is_422(
    shop: OrderShop, method: dict[str, Any], extra: dict[str, Any]
) -> None:
    user, product = quick(shop)

    response = place(shop, user, delivery=method | extra)

    assert_422_in_delivery(response, next(iter(extra)))
    assert effects(shop.session, user, product)["orders"] == 0


def test_a_user_id_in_headers_or_the_query_string_is_ignored(shop: OrderShop) -> None:
    me, product = quick(shop)
    victim = shop.user()
    victim_product = add_listed(shop.session, on_hand=5)
    victim_cart = stock_in_cart(shop, victim, (victim_product, 1))

    response = place(
        shop,
        me,
        headers={"X-User-Id": str(victim), "X-Forwarded-User": str(victim)},
        params={"user_id": str(victim)},
    )

    assert response.status_code == 201, response.text
    assert order_row(shop.session, response.json()["id"])["user_id"] == me
    assert effects(shop.session, victim)["orders"] == 0
    assert lines_of(shop.session, victim_cart) == {victim_product: (1, True)}  # su carrito, intacto
    assert effects(shop.session, me, product)["orders"] == 1


def test_a_customer_with_an_empty_cart_cannot_take_the_order_of_another(shop: OrderShop) -> None:
    owner, product = quick(shop)
    key = "clave-compartida-0001"
    mine = place(shop, owner, key=key)
    other = shop.user()

    theirs = place(shop, other, key=key)  # misma clave, otro cliente, carrito vacío

    assert mine.status_code == 201
    error_of(theirs, 409, "empty_selection")  # no recibe el pedido ajeno
    assert str(mine.json()["id"]) not in theirs.text


def test_each_customer_gets_their_own_order_with_the_same_key_and_the_same_products(
    shop: OrderShop,
) -> None:
    first, second = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, first, (product, 1))
    stock_in_cart(shop, second, (product, 2))
    key = "clave-compartida-0002"

    one = place(shop, first, key=key)
    two = place(shop, second, key=key)

    assert (one.status_code, two.status_code) == (201, 201)
    assert one.json()["id"] != two.json()["id"]
    assert order_row(shop.session, one.json()["id"])["user_id"] == first
    assert order_row(shop.session, two.json()["id"])["user_id"] == second
    assert two.json()["lines"][0]["quantity"] == 2
    assert effects(shop.session, first)["orders"] == effects(shop.session, second)["orders"] == 1


def test_a_second_customer_does_not_touch_the_cart_of_the_first(shop: OrderShop) -> None:
    first, product = quick(shop, quantity=3)
    second = shop.user()
    stock_in_cart(shop, second, (product, 1, False))
    before = effects(shop.session, first, product)

    response = place(shop, second)

    error_of(response, 409, "empty_selection")
    assert effects(shop.session, first, product) == before
