"""`GET /api/v1/orders` y `GET /api/v1/orders/{order_id}` con la app real y PostgreSQL (T-075;
CA-ORDERS-10, 11, 22 y 25 en lo que toca a la forma; SPEC §3 UC-02 y UC-03, §4 R12 y R17, §7;
D-041 P-6 y P-7). Cada solicitud corre en un SAVEPOINT de la transacción de la prueba. Los pedidos
se siembran con el repositorio y SQL (estado y antigüedad a medida) respecto a la hora de la BD.
La caducidad por lectura está en `test_my_orders_expiry.py`. Datos ficticios."""

import re
from dataclasses import replace
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed, set_product
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_create_helpers import DETAIL_KEYS, LINE_KEYS, SUMMARY_KEYS
from tests.orders.orders_db_helpers import real_line
from tests.orders.orders_helpers import make_line, pickup_delivery, shipping_delivery
from tests.orders.orders_http_helpers import (
    CDN,
    OrderShop,
    money,
    parse_utc,
    place,
    quick,
)
from tests.orders.orders_read_helpers import (
    ALL_STATUSES,
    PAID_STATUSES,
    get_order,
    headers,
    ids_of,
    list_orders,
    make_order,
    read_order,
    read_page,
    statuses_of,
)
from valmont.modules.orders.domain import Fulfillment, format_order_number

pytestmark = pytest.mark.integration

shop = helpers.shop


def error_of(response: Any, status: int, code: str) -> Any:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code, body
    assert "Traceback" not in response.text
    return body["error"]["details"]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-10: listado propio
def test_the_list_shows_only_my_orders_newest_first_with_the_page_envelope(shop: OrderShop) -> None:
    me, other = shop.user(), shop.user()
    oldest = make_order(shop.session, me, minutes_ago=300)
    newest = make_order(shop.session, me, minutes_ago=10)
    middle = make_order(shop.session, me, minutes_ago=120)
    make_order(shop.session, other, minutes_ago=5)

    page = read_page(shop, me)

    assert ids_of(page) == [str(newest.id), str(middle.id), str(oldest.id)]
    assert (page["total"], page["page"], page["page_size"]) == (3, 1, 20)
    assert set(page) == {"items", "total", "page", "page_size"}


def test_two_customers_each_see_only_their_own_orders(shop: OrderShop) -> None:
    ana, luis = shop.user(), shop.user()
    anas = {str(make_order(shop.session, ana, minutes_ago=60 + n).id) for n in range(2)}
    luiss = {str(make_order(shop.session, luis, minutes_ago=60 + n).id) for n in range(3)}

    ana_page, luis_page = read_page(shop, ana), read_page(shop, luis)

    assert set(ids_of(ana_page)) == anas and ana_page["total"] == 2
    assert set(ids_of(luis_page)) == luiss and luis_page["total"] == 3
    assert not anas & luiss


def test_a_user_id_query_parameter_does_not_widen_the_list(shop: OrderShop) -> None:
    me, other = shop.user(), shop.user()
    mine = make_order(shop.session, me)
    theirs = make_order(shop.session, other)

    page = read_page(shop, me, ("user_id", str(other)))

    assert ids_of(page) == [str(mine.id)] and str(theirs.id) not in str(page)


def test_a_customer_without_orders_gets_an_empty_page(shop: OrderShop) -> None:
    make_order(shop.session, shop.user())

    assert read_page(shop, shop.user()) == {"items": [], "total": 0, "page": 1, "page_size": 20}


def test_the_summary_has_exactly_the_contract_fields_and_no_personal_or_internal_data(
    shop: OrderShop,
) -> None:
    me = shop.user()
    order = make_order(
        shop.session,
        me,
        status="pendiente_pago",
        minutes_ago=5,
        recipient="Rosa Tupac",
        lines=[real_line(shop.session, quantity=2), real_line(shop.session, quantity=3)],
    )

    response = list_orders(shop, me)

    [item] = response.json()["items"]
    assert set(item) == SUMMARY_KEYS
    assert item["id"] == str(order.id) and item["status"] == "pendiente_pago"
    assert item["number"] == format_order_number(order.number or 0)
    assert re.fullmatch(r"VAL-\d{6,}", item["number"])
    assert item["total"] == money(500_000) and item["item_count"] == 5  # Σ cantidades
    assert parse_utc(item["created_at"]) == order.created_at
    assert parse_utc(item["expires_at"]) == order.expires_at
    assert item["estimated_delivery_on"] is None
    for private in ("user_id", "Rosa", "Tupac", "987654321", "Larco", "Miraflores", str(me)):
        assert private not in response.text, private


def test_the_summary_shows_the_estimated_delivery_date_of_a_made_to_order_order(
    shop: OrderShop,
) -> None:
    me = shop.user()
    line = replace(
        real_line(shop.session), fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=21
    )
    order = make_order(shop.session, me, lines=[line])

    [item] = read_page(shop, me)["items"]

    assert order.estimated_delivery_on is not None
    assert item["estimated_delivery_on"] == order.estimated_delivery_on.isoformat()


@pytest.mark.parametrize("status", ALL_STATUSES)
def test_expires_at_is_only_present_in_a_pending_order(shop: OrderShop, status: str) -> None:
    me = shop.user()
    make_order(shop.session, me, status=status, minutes_ago=5 if status == "pendiente_pago" else 60)

    [item] = read_page(shop, me)["items"]

    assert item["status"] == status
    assert (item["expires_at"] is not None) == (status == "pendiente_pago")


def test_money_in_the_summary_is_an_integer_of_cents_above_two_to_the_thirty_first(
    shop: OrderShop,
) -> None:
    me = shop.user()
    big = real_line(shop.session, quantity=3, list_price=2_000_000_000)
    make_order(shop.session, me, lines=[big])

    [item] = read_page(shop, me)["items"]

    assert item["total"] == {"amount": 6_000_000_000, "currency": "PEN"}
    assert type(item["total"]["amount"]) is int


# --- orden y paginación (CA-ORDERS-17 / R17) -------------------------------------------------
def test_orders_created_at_the_same_instant_are_listed_by_id_descending(shop: OrderShop) -> None:
    me = shop.user()
    # `make_order` cuelga de la hora de la BD, fija en la transacción: mismos `created_at`.
    twins = [make_order(shop.session, me, minutes_ago=120) for _ in range(4)]

    page = read_page(shop, me)

    assert ids_of(page) == sorted((str(o.id) for o in twins), reverse=True)


def test_the_list_paginates_without_gaps_or_repeats_and_with_the_real_total(
    shop: OrderShop,
) -> None:
    me = shop.user()
    orders = [make_order(shop.session, me, minutes_ago=60 + n) for n in range(7)]
    newest_first = [str(o.id) for o in orders]  # más reciente = menos minutos

    pages = [read_page(shop, me, ("page", p), ("page_size", 3)) for p in (1, 2, 3)]

    assert [len(p["items"]) for p in pages] == [3, 3, 1]
    assert [i for p in pages for i in ids_of(p)] == newest_first
    assert all((p["total"], p["page_size"]) == (7, 3) for p in pages)
    assert [p["page"] for p in pages] == [1, 2, 3]


def test_a_page_past_the_last_is_empty_with_the_real_total(shop: OrderShop) -> None:
    me = shop.user()
    for n in range(4):
        make_order(shop.session, me, minutes_ago=60 + n)

    page = read_page(shop, me, ("page", 5), ("page_size", 3))

    assert page == {"items": [], "total": 4, "page": 5, "page_size": 3}


def test_the_last_allowed_page_and_the_largest_page_size_are_accepted(shop: OrderShop) -> None:
    me = shop.user()
    make_order(shop.session, me)

    assert read_page(shop, me, ("page", 1000))["items"] == []
    assert len(read_page(shop, me, ("page_size", 50))["items"]) == 1
    assert read_page(shop, me, ("page_size", 1))["page_size"] == 1


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("page", "0"),
        ("page", "-1"),
        ("page", "1001"),
        ("page", "abc"),
        ("page", ""),
        ("page_size", "0"),
        ("page_size", "-5"),
        ("page_size", "51"),
        ("page_size", "abc"),
    ],
)
def test_an_invalid_page_or_page_size_is_422_with_the_field(
    shop: OrderShop, name: str, value: str
) -> None:
    me = shop.user()
    make_order(shop.session, me)

    details = error_of(list_orders(shop, me, (name, value)), 422, "validation_error")

    assert any(name in item["loc"] for item in details)


# --- filtro por estado (D-041 P-6) -----------------------------------------------------------
def one_of_each_status(shop: OrderShop) -> Any:
    me = shop.user()
    for n, status in enumerate(ALL_STATUSES):
        make_order(
            shop.session,
            me,
            status=status,
            minutes_ago=5 if status == "pendiente_pago" else 60 + n,
        )
    return me


def test_without_status_every_state_is_returned(shop: OrderShop) -> None:
    me = one_of_each_status(shop)

    page = read_page(shop, me)

    assert sorted(statuses_of(page)) == sorted(ALL_STATUSES) and page["total"] == 8


def test_a_single_status_filters(shop: OrderShop) -> None:
    me = one_of_each_status(shop)

    page = read_page(shop, me, ("status", "pagado"))

    assert statuses_of(page) == ["pagado"] and page["total"] == 1


def test_a_repeated_status_filters_by_all_of_them(shop: OrderShop) -> None:
    me = one_of_each_status(shop)

    page = read_page(shop, me, ("status", "pagado"), ("status", "en_preparacion"))

    assert sorted(statuses_of(page)) == ["en_preparacion", "pagado"] and page["total"] == 2


def test_the_filter_by_three_statuses_paginates_over_the_filtered_total(shop: OrderShop) -> None:
    me = one_of_each_status(shop)
    wanted = ("enviado", "listo_para_recojo", "entregado")

    first = read_page(shop, me, *[("status", s) for s in wanted], ("page_size", 2))
    second = read_page(shop, me, *[("status", s) for s in wanted], ("page_size", 2), ("page", 2))

    assert (first["total"], len(first["items"]), len(second["items"])) == (3, 2, 1)
    assert sorted(statuses_of(first) + statuses_of(second)) == sorted(wanted)


def test_all_the_statuses_together_are_the_same_as_no_filter(shop: OrderShop) -> None:
    me = one_of_each_status(shop)

    page = read_page(shop, me, *[("status", s) for s in ALL_STATUSES])

    assert sorted(statuses_of(page)) == sorted(ALL_STATUSES)


def test_a_repeated_status_given_twice_does_not_duplicate_rows(shop: OrderShop) -> None:
    me = one_of_each_status(shop)

    page = read_page(shop, me, ("status", "pagado"), ("status", "pagado"))

    assert statuses_of(page) == ["pagado"]


def test_the_filter_never_shows_orders_of_another_customer(shop: OrderShop) -> None:
    me, other = shop.user(), shop.user()
    make_order(shop.session, me, status="pagado")
    make_order(shop.session, other, status="pagado")

    page = read_page(shop, me, ("status", "pagado"), ("status", "cancelado"))

    assert page["total"] == 1


@pytest.mark.parametrize("bad", ["bogus", "", "PAGADO", "paid", "pagado,cancelado", "pendiente"])
def test_an_unknown_status_is_422(shop: OrderShop, bad: str) -> None:
    me = shop.user()
    make_order(shop.session, me)

    details = error_of(list_orders(shop, me, ("status", bad)), 422, "validation_error")

    assert any("status" in item["loc"] for item in details)


def test_one_unknown_value_among_valid_ones_is_422(shop: OrderShop) -> None:
    me = shop.user()
    make_order(shop.session, me)

    response = list_orders(shop, me, ("status", "pagado"), ("status", "bogus"))

    error_of(response, 422, "validation_error")


def test_the_list_without_a_session_is_401(shop: OrderShop) -> None:
    make_order(shop.session, shop.user())

    error_of(list_orders(shop, None), 401, "unauthenticated")
    garbage = shop.client.get(helpers.PATH, headers={"Authorization": "Bearer no-es-un-token"})
    error_of(garbage, 401, "unauthenticated")


# --------------------------------------------------------------------------------------------
# CA-ORDERS-11: detalle propio
def test_the_detail_of_a_new_order_has_the_whole_contract_shape(shop: OrderShop) -> None:
    user, _ = quick(shop, quantity=2)
    created = place(shop, user).json()

    body = read_order(shop, user, created["id"])

    assert set(body) == DETAIL_KEYS
    assert all(set(line) == LINE_KEYS for line in body["lines"])
    assert body["id"] == created["id"] and body["status"] == "pendiente_pago"
    assert body["number"] == created["number"] and re.fullmatch(r"VAL-\d{6,}", body["number"])
    assert body["total"] == created["total"] == body["subtotal"] and body["shipping"] == money(0)
    assert body["item_count"] == 2 and body["paid_at"] is None and body["refund"] is None
    assert body["delivery"]["delivery_method"] == "shipping"
    assert body["delivery"]["district"] == "Miraflores" and body["delivery"]["pickup_store"] is None
    for key in ("carrier", "tracking_code", "shipped_at"):
        assert body["delivery"][key] is None
    assert body["history"] == [
        {
            "from_status": None,
            "status": "pendiente_pago",
            "at": body["created_at"],
            "actor": "customer",
        }
    ]


def test_the_detail_of_a_new_order_matches_what_creating_it_returned(shop: OrderShop) -> None:
    user, _ = quick(shop)
    created = place(shop, user).json()

    body = read_order(shop, user, created["id"])

    comparable = ("id", "number", "status", "total", "lines", "delivery", "history", "can_cancel")
    assert {k: body[k] for k in comparable} == {k: created[k] for k in comparable}
    assert parse_utc(body["created_at"]) == parse_utc(created["created_at"])
    assert parse_utc(body["expires_at"]) == parse_utc(created["expires_at"])


def test_the_detail_line_carries_the_snapshot_with_money_and_fulfillment(shop: OrderShop) -> None:
    me = shop.user()
    line = replace(
        real_line(shop.session, quantity=2, list_price=100_000, unit_price=90_000),
        fulfillment=Fulfillment.MADE_TO_ORDER,
        lead_time_days=14,
    )
    order = make_order(shop.session, me, lines=[line])

    body = read_order(shop, me, order.id)

    [row] = body["lines"]
    assert row["product_id"] == str(line.product_id) and row["sku"] == line.sku
    assert (row["quantity"], row["fulfillment"], row["lead_time_days"]) == (2, "made_to_order", 14)
    assert row["list_price"] == money(100_000) and row["unit_price"] == money(90_000)
    assert row["discount_amount"] == money(10_000)  # por unidad
    assert row["line_total"] == money(180_000)
    assert body["subtotal"] == body["total"] == money(180_000) and body["item_count"] == 2


def test_the_detail_lines_follow_the_order_of_the_order_and_show_the_current_image(
    shop: OrderShop,
) -> None:
    me = shop.user()
    with_image = add_listed(shop.session, image=("heritage/frontal 1.jpg", "Vista frontal"))
    without = add_listed(shop.session)
    lines = [
        replace(make_line(sku="TST-A"), product_id=with_image),
        replace(make_line(sku="TST-B"), product_id=without),
    ]
    order = make_order(shop.session, me, lines=lines)

    body = read_order(shop, me, order.id)

    assert [row["sku"] for row in body["lines"]] == ["TST-A", "TST-B"]
    assert body["lines"][0]["image"] == {
        "url": f"{CDN}/storage/v1/object/public/products/heritage/frontal%201.jpg",
        "alt": "Vista frontal",
    }
    assert body["lines"][1]["image"] is None


def test_the_image_is_null_when_the_product_is_no_longer_published(shop: OrderShop) -> None:
    me = shop.user()
    product = add_listed(shop.session, image=("p/a.jpg", "Reloj A"))
    order = make_order(shop.session, me, lines=[replace(make_line(), product_id=product)])
    assert read_order(shop, me, order.id)["lines"][0]["image"] is not None

    set_product(shop.session, product, status="draft")

    body = read_order(shop, me, order.id)
    assert body["lines"][0]["image"] is None
    assert body["lines"][0]["name"] == "Reloj de prueba"  # el resto de la instantánea sigue


@pytest.mark.parametrize("status", ALL_STATUSES)
def test_can_cancel_and_the_countdown_follow_the_state(shop: OrderShop, status: str) -> None:
    me = shop.user()
    order = make_order(
        shop.session, me, status=status, minutes_ago=5 if status == "pendiente_pago" else 60
    )

    body = read_order(shop, me, order.id)

    pending = status == "pendiente_pago"
    assert body["status"] == status and body["can_cancel"] is pending
    assert (body["expires_at"] is not None) is pending
    assert (body["expires_in_seconds"] is not None) is pending


def test_the_countdown_is_the_remaining_seconds_and_never_negative(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=10)

    body = read_order(shop, me, order.id)

    # Todo ocurre en la misma transacción de la BD: `now` no avanza, así que son 20 min exactos.
    assert 1199 <= body["expires_in_seconds"] <= 1200
    assert type(body["expires_in_seconds"]) is int


def test_a_fresh_order_has_a_30_minute_window(shop: OrderShop) -> None:
    user, _ = quick(shop)
    created = place(shop, user).json()

    body = read_order(shop, user, created["id"])

    assert 1799 <= body["expires_in_seconds"] <= 1800
    assert parse_utc(body["expires_at"]) - parse_utc(body["created_at"]) == timedelta(minutes=30)


def test_the_history_is_listed_oldest_first_with_the_actor_kind(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    for n, (a, b, kind, actor) in enumerate(
        [
            ("pendiente_pago", "pagado", "customer", "u"),
            ("pagado", "en_preparacion", "admin", "a"),
        ]
    ):
        shop.session.execute(
            text(
                "INSERT INTO app.order_status_history (order_id, from_status, to_status,"
                " actor_kind, actor_id, note, created_at) VALUES (:o, :f, :t, :k, :a, :n,"
                " now() + make_interval(mins => :m))"
            ),
            {
                "o": order.id,
                "f": a,
                "t": b,
                "k": kind,
                "a": me if actor == "u" else uuid4(),
                "n": "Nota interna del administrador" if kind == "admin" else None,
                "m": n + 1,
            },
        )

    body = read_order(shop, me, order.id)

    assert [(h["from_status"], h["status"], h["actor"]) for h in body["history"]] == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "pagado", "customer"),
        ("pagado", "en_preparacion", "admin"),
    ]
    times = [parse_utc(h["at"]) for h in body["history"]]
    assert times == sorted(times)
    assert all(set(h) == {"from_status", "status", "at", "actor"} for h in body["history"])
    assert "Nota interna" not in str(body)  # las notas son solo del administrador


def test_a_refund_is_visible_to_the_customer_with_amount_and_instant(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pagado")
    shop.session.execute(
        text(
            "UPDATE app.orders SET status = 'cancelado', refunded_amount = total_amount,"
            " refunded_at = now() WHERE id = :id"
        ),
        {"id": order.id},
    )

    body = read_order(shop, me, order.id)

    assert body["status"] == "cancelado" and body["can_cancel"] is False
    assert body["refund"]["amount"] == body["total"]
    assert set(body["refund"]) == {"amount", "at"} and parse_utc(body["refund"]["at"])


@pytest.mark.parametrize("status", [s for s in ALL_STATUSES if s != "cancelado"])
def test_an_order_without_a_refund_shows_null(shop: OrderShop, status: str) -> None:
    me = shop.user()
    order = make_order(
        shop.session, me, status=status, minutes_ago=5 if status == "pendiente_pago" else 60
    )

    assert read_order(shop, me, order.id)["refund"] is None


def test_paid_at_is_shown_once_paid(shop: OrderShop) -> None:
    me = shop.user()
    paid = make_order(shop.session, me, status="pagado")
    pending = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)

    assert parse_utc(read_order(shop, me, paid.id)["paid_at"])
    assert read_order(shop, me, pending.id)["paid_at"] is None


def test_the_detail_response_has_no_user_id_no_actor_id_and_no_notes(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pagado")
    shop.session.execute(
        text("UPDATE app.order_status_history SET note = 'Reservado para VIP' WHERE order_id = :o"),
        {"o": order.id},
    )

    response = get_order(shop, me, order.id)

    assert response.status_code == 200
    for private in ("user_id", "actor_id", "note", "VIP", str(me), "idempotency"):
        assert private not in response.text, private


# --- entrega (R13, R20) ----------------------------------------------------------------------
def test_the_detail_of_a_shipping_order_has_the_address_and_no_boutique(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, delivery=shipping_delivery(reference=None))

    delivery = read_order(shop, me, order.id)["delivery"]

    assert delivery["delivery_method"] == "shipping" and delivery["pickup_store"] is None
    assert (delivery["department"], delivery["province"], delivery["district"]) == (
        "Lima",
        "Lima",
        "Miraflores",
    )
    assert delivery["address_line"] == "Av. Larco 1234, piso 5" and delivery["reference"] is None
    assert delivery["phone"] == "+51987654321"


def test_the_detail_of_a_pickup_order_has_no_address_and_the_current_boutique(
    shop: OrderShop,
) -> None:
    me = shop.user()
    order = make_order(shop.session, me, delivery=pickup_delivery())

    delivery = read_order(shop, me, order.id)["delivery"]

    assert delivery["delivery_method"] == "pickup"
    for key in ("department", "province", "district", "address_line", "reference"):
        assert delivery[key] is None, key
    assert delivery["pickup_store"] == {
        "name": helpers.STORE_ENV["PICKUP_STORE_NAME"],
        "address": helpers.STORE_ENV["PICKUP_STORE_ADDRESS"],
        "hours": helpers.STORE_ENV["PICKUP_STORE_HOURS"],
    }


def test_the_boutique_shown_is_the_current_one_not_a_frozen_copy(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, delivery=pickup_delivery())
    shop.set_store(name="Otra Boutique", address="Calle Nueva 100", hours="24 horas")

    store = read_order(shop, me, order.id)["delivery"]["pickup_store"]

    assert store == {"name": "Otra Boutique", "address": "Calle Nueva 100", "hours": "24 horas"}


def test_a_pickup_order_still_reads_when_the_boutique_is_no_longer_configured(
    shop: OrderShop,
) -> None:
    me = shop.user()
    order = make_order(shop.session, me, delivery=pickup_delivery())
    shop.set_store()  # sin datos: pickup no disponible para crear, pero el pedido se sigue leyendo

    response = get_order(shop, me, order.id)

    assert response.status_code == 200
    assert response.json()["delivery"]["pickup_store"] is None


# --------------------------------------------------------------------------------------------
# CA-ORDERS-11 y 22 / R12: 404 idéntico, 422, 401
def test_a_foreign_order_and_a_missing_one_are_the_very_same_404(shop: OrderShop) -> None:
    me, other = shop.user(), shop.user()
    theirs = make_order(shop.session, other, status="pagado")

    foreign = get_order(shop, me, theirs.id)
    missing = get_order(shop, me, uuid4())

    assert foreign.status_code == missing.status_code == 404
    error_of(foreign, 404, "not_found")
    assert foreign.json() == missing.json()
    assert foreign.headers["content-type"] == missing.headers["content-type"]
    assert len(foreign.content) == len(missing.content)


@pytest.mark.parametrize("status", ALL_STATUSES)
def test_a_foreign_order_is_404_in_every_state(shop: OrderShop, status: str) -> None:
    me, other = shop.user(), shop.user()
    theirs = make_order(
        shop.session, other, status=status, minutes_ago=5 if status == "pendiente_pago" else 60
    )

    response = get_order(shop, me, theirs.id)

    assert response.status_code == 404
    assert str(theirs.id) not in response.text and str(other) not in response.text


def test_the_404_never_reveals_the_foreign_data(shop: OrderShop) -> None:
    me, other = shop.user(), shop.user()
    theirs = make_order(shop.session, other, recipient="Rosa Tupac", status="pagado")

    text_of_response = get_order(shop, me, theirs.id).text

    for private in ("Rosa", "Tupac", "VAL-", "pagado", "987654321", "Larco"):
        assert private not in text_of_response, private


def test_both_customers_read_their_own_order_and_get_404_on_the_others(shop: OrderShop) -> None:
    ana, luis = shop.user(), shop.user()
    anas, luiss = make_order(shop.session, ana), make_order(shop.session, luis)

    assert get_order(shop, ana, anas.id).status_code == 200
    assert get_order(shop, luis, luiss.id).status_code == 200
    assert get_order(shop, ana, luiss.id).status_code == 404
    assert get_order(shop, luis, anas.id).status_code == 404


@pytest.mark.parametrize("bad", ["abc", "123", "00000000-0000-0000-0000", "not-a-uuid", "1;DROP"])
def test_a_malformed_order_id_is_422_with_the_path_field(shop: OrderShop, bad: str) -> None:
    details = error_of(get_order(shop, shop.user(), bad), 422, "validation_error")

    assert any("order_id" in item["loc"] for item in details)


def test_the_detail_without_a_session_is_401_even_for_a_real_order(shop: OrderShop) -> None:
    order = make_order(shop.session, shop.user())

    error_of(get_order(shop, None, order.id), 401, "unauthenticated")
    garbage = shop.client.get(
        f"{helpers.PATH}/{order.id}", headers={"Authorization": "Bearer no-es-un-token"}
    )
    error_of(garbage, 401, "unauthenticated")


def test_the_401_does_not_depend_on_the_order_existing(shop: OrderShop) -> None:
    real = make_order(shop.session, shop.user())

    a, b = get_order(shop, None, real.id), get_order(shop, None, uuid4())

    assert a.status_code == b.status_code == 401 and a.json() == b.json()


def test_a_user_id_query_parameter_does_not_change_whose_order_is_read(shop: OrderShop) -> None:
    me, other = shop.user(), shop.user()
    theirs = make_order(shop.session, other)

    response = shop.client.get(
        f"{helpers.PATH}/{theirs.id}", params={"user_id": str(other)}, headers=headers(me)
    )

    assert response.status_code == 404


def test_reading_an_order_does_not_write_anything_when_nothing_is_overdue(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me, status="pendiente_pago", minutes_ago=5)
    before = helpers.effects(shop.session, me)

    for _ in range(3):
        read_order(shop, me, order.id)
        read_page(shop, me)

    assert helpers.effects(shop.session, me) == before


def test_a_paid_order_is_listed_as_any_other(shop: OrderShop) -> None:
    me = shop.user()
    for status in PAID_STATUSES:
        make_order(shop.session, me, status=status)

    assert sorted(statuses_of(read_page(shop, me))) == sorted(PAID_STATUSES)
