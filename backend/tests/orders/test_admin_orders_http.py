"""`GET /api/v1/orders/admin` y `GET /api/v1/orders/admin/{order_id}` con la app real y PostgreSQL
(T-078; CA-ORDERS-16, 17, 22 y 25 en lo que toca a la forma; SPEC §2, §3 UC-07 y UC-08, §4 R12,
R17 y R18, §7, §9). Autorización por rol (401, 403, 200), el router de administración no capturado
por `/{order_id}`, formas de salida con datos de todos los clientes, el detalle con `user_id`,
notas, `actor_id` y `can_transition_to` por estado y modalidad, y los datos personales. Cada
solicitud corre en un SAVEPOINT de la transacción de la prueba. Datos ficticios."""

import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_profile
from tests.identity.identity_helpers import make_token
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import (
    ADMIN_DETAIL_KEYS,
    ADMIN_HISTORY_KEYS,
    ADMIN_PATH,
    ADMIN_SUMMARY_KEYS,
    admin_get,
    admin_list,
    admin_of,
    admin_order,
    admin_page,
    named_order,
    tag,
)
from tests.orders.orders_create_helpers import LINE_KEYS
from tests.orders.orders_db_helpers import insert_history_row, real_line
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from tests.orders.orders_http_helpers import OrderShop, money, parse_utc
from tests.orders.orders_read_helpers import (
    ALL_STATUSES,
    get_order,
    headers,
    ids_of,
    list_orders,
    make_order,
    read_order,
    set_status,
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
# CA-ORDERS-16 y 22: autorización por rol en las dos rutas
def test_without_a_token_both_routes_are_401(shop: OrderShop) -> None:
    order = make_order(shop.session, shop.user())

    error_of(admin_list(shop, None), 401, "unauthenticated")
    error_of(admin_get(shop, None, order.id), 401, "unauthenticated")


@pytest.mark.parametrize("bearer", ["Bearer", "Bearer basura.sin.firma", "Basic YWRtaW46YWRtaW4="])
def test_a_malformed_or_invalid_token_is_401_not_403_and_not_data(
    shop: OrderShop, bearer: str
) -> None:
    order = make_order(shop.session, shop.user())
    bad = {"Authorization": bearer}

    for response in (
        shop.client.get(ADMIN_PATH, headers=bad),
        shop.client.get(f"{ADMIN_PATH}/{order.id}", headers=bad),
    ):
        error_of(response, 401, "unauthenticated")


def test_a_customer_is_403_on_the_list(shop: OrderShop) -> None:
    make_order(shop.session, shop.user())

    details = error_of(admin_list(shop, shop.user()), 403, "forbidden")

    assert details is None


def test_a_customer_is_403_on_the_detail_of_someone_elses_order(shop: OrderShop) -> None:
    order = make_order(shop.session, shop.user())

    error_of(admin_get(shop, shop.user(), order.id), 403, "forbidden")


def test_a_customer_is_403_on_the_detail_of_their_own_order(shop: OrderShop) -> None:
    me = shop.user()
    order = make_order(shop.session, me)

    error_of(admin_get(shop, me, order.id), 403, "forbidden")


def test_a_customer_gets_the_same_403_for_a_real_and_a_nonexistent_id(shop: OrderShop) -> None:
    me = shop.user()
    real = make_order(shop.session, shop.user())

    a = admin_get(shop, me, real.id)
    b = admin_get(shop, me, uuid4())

    assert a.status_code == b.status_code == 403
    assert a.json() == b.json()


def test_the_403_body_leaks_nothing_about_orders(shop: OrderShop) -> None:
    other = shop.user()
    name = tag()
    order = named_order(shop, other, name)

    for response in (admin_list(shop, shop.user()), admin_get(shop, shop.user(), order.id)):
        assert response.status_code == 403
        for secret in (name, str(order.id), str(other), format_order_number(order.number or 0)):
            assert secret not in response.text, secret


def test_a_customer_cannot_become_admin_with_untrusted_headers_or_params(shop: OrderShop) -> None:
    order = make_order(shop.session, shop.user())
    me = shop.user()
    fake = {
        **headers(me),
        "X-User-Role": "admin",
        "X-Role": "admin",
        "X-Forwarded-User": str(uuid4()),
    }

    assert shop.client.get(ADMIN_PATH, headers=fake).status_code == 403
    assert shop.client.get(f"{ADMIN_PATH}/{order.id}", headers=fake).status_code == 403
    assert (
        shop.client.get(ADMIN_PATH, headers=headers(me), params={"role": "admin"}).status_code
        == 403
    )


def test_the_role_comes_from_the_profile_not_from_the_token_claims(shop: OrderShop) -> None:
    me = shop.user()  # perfil de cliente
    token = make_token(str(me), role="admin", app_metadata={"role": "admin"})
    forged = {"Authorization": f"Bearer {token}"}

    assert shop.client.get(ADMIN_PATH, headers=forged).status_code == 403


def test_an_admin_is_200_on_both_routes(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user())

    assert admin_list(shop, admin).status_code == 200
    assert admin_get(shop, admin, order.id).status_code == 200


# --------------------------------------------------------------------------------------------
# El router de administración se registra antes que `/{order_id}`
def test_admin_is_a_route_not_an_order_id_the_list_is_not_a_422(shop: OrderShop) -> None:
    response = admin_list(shop, admin_of(shop))

    assert response.status_code == 200
    assert set(response.json()) == {"items", "total", "page", "page_size"}


def test_a_customer_on_admin_gets_403_not_the_422_of_an_invalid_uuid(shop: OrderShop) -> None:
    assert admin_list(shop, shop.user()).status_code == 403


def test_the_customer_route_still_serves_uuids_and_keeps_its_own_404(shop: OrderShop) -> None:
    me = shop.user()
    mine = make_order(shop.session, me)

    assert read_order(shop, me, mine.id)["id"] == str(mine.id)
    error_of(get_order(shop, me, uuid4()), 404, "not_found")
    assert get_order(shop, me, "no-es-uuid").status_code == 422


def test_an_admin_token_on_the_customer_routes_is_still_scoped_to_its_own_orders(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    theirs = make_order(shop.session, shop.user())

    error_of(get_order(shop, admin, theirs.id), 404, "not_found")  # R12: no hay atajo de rol
    assert list_orders(shop, admin).json()["total"] == 0


def test_trailing_slash_or_unknown_admin_paths_do_not_serve_orders(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user())

    # `/admin/` (barra final) redirige o 404, pero nunca devuelve un pedido ni un 500.
    response = shop.client.get(f"{ADMIN_PATH}/", headers=headers(admin), follow_redirects=False)
    assert response.status_code in (307, 308, 404, 200)
    assert response.status_code < 500
    assert (
        shop.client.get(f"{ADMIN_PATH}/{order.id}/extra", headers=headers(admin)).status_code == 404
    )


# --------------------------------------------------------------------------------------------
# CA-ORDERS-16: forma del listado con datos de todos los clientes
def test_the_list_shows_orders_of_all_customers_with_user_and_recipient(shop: OrderShop) -> None:
    admin, ana, luis = admin_of(shop), shop.user(), shop.user()
    label = tag()
    a = named_order(shop, ana, f"Ana {label}", district="Miraflores", minutes_ago=120)
    b = named_order(shop, luis, f"Luis {label}", district="Surco", minutes_ago=30)

    page = admin_page(shop, admin, ("q", label))

    assert ids_of(page) == [str(b.id), str(a.id)]  # el más reciente primero
    assert (page["total"], page["page"], page["page_size"]) == (2, 1, 20)
    by_id = {item["id"]: item for item in page["items"]}
    assert by_id[str(a.id)]["user_id"] == str(ana)
    assert by_id[str(a.id)]["recipient_name"] == f"Ana {label}"
    assert by_id[str(a.id)]["district"] == "Miraflores"
    assert by_id[str(b.id)]["user_id"] == str(luis)
    assert by_id[str(b.id)]["recipient_name"] == f"Luis {label}"
    assert by_id[str(b.id)]["district"] == "Surco"


def test_the_summary_has_exactly_the_admin_contract_fields(shop: OrderShop) -> None:
    admin, user = admin_of(shop), shop.user()
    label = tag()
    order = named_order(
        shop,
        user,
        f"Rosa {label}",
        status="pendiente_pago",
        minutes_ago=5,
        lines=[real_line(shop.session, quantity=2), real_line(shop.session, quantity=3)],
    )

    [item] = admin_page(shop, admin, ("q", label))["items"]

    assert set(item) == ADMIN_SUMMARY_KEYS
    assert item["id"] == str(order.id) and item["status"] == "pendiente_pago"
    assert item["number"] == format_order_number(order.number or 0)
    assert re.fullmatch(r"VAL-\d{6,}", item["number"])
    assert item["total"] == money(500_000) and item["item_count"] == 5
    assert parse_utc(item["created_at"]) == order.created_at
    assert parse_utc(item["expires_at"]) == order.expires_at  # solo pendiente_pago
    assert item["estimated_delivery_on"] is None


def test_the_summary_hides_phone_address_reference_and_internal_columns(shop: OrderShop) -> None:
    admin = admin_of(shop)
    label = tag()
    named_order(shop, shop.user(), f"Rosa {label}")

    response = admin_list(shop, admin, ("q", label))

    for private in (*("987654321", "Larco 1234", "Frente al parque"), "idempotency", "note"):
        assert private not in response.text, private
    for key in ("phone", "address_line", "reference", "department", "province", "idempotency_key"):
        assert f'"{key}"' not in response.text, key


def test_expires_at_is_null_for_every_state_except_pending_payment(shop: OrderShop) -> None:
    admin = admin_of(shop)
    label = tag()
    for status in ALL_STATUSES:
        named_order(shop, shop.user(), f"Ana {label}", status=status, minutes_ago=5)

    items = admin_page(shop, admin, ("q", label), ("page_size", 50))["items"]

    assert len(items) == len(ALL_STATUSES)
    for item in items:
        assert (item["expires_at"] is not None) == (item["status"] == "pendiente_pago")


def test_an_empty_result_is_an_empty_page_with_the_real_envelope(shop: OrderShop) -> None:
    admin = admin_of(shop)

    page = admin_page(shop, admin, ("q", tag()))

    assert page == {"items": [], "total": 0, "page": 1, "page_size": 20}


def test_the_list_does_not_accept_a_user_id_to_narrow_or_widen_the_result(shop: OrderShop) -> None:
    admin, ana, luis = admin_of(shop), shop.user(), shop.user()
    label = tag()
    named_order(shop, ana, f"Ana {label}")
    named_order(shop, luis, f"Luis {label}")

    page = admin_page(shop, admin, ("q", label), ("user_id", str(ana)))

    assert page["total"] == 2  # el parámetro se ignora: el contrato no lo declara


# --------------------------------------------------------------------------------------------
# CA-ORDERS-17: detalle completo
def test_the_detail_has_exactly_the_admin_contract_fields(shop: OrderShop) -> None:
    admin, user = admin_of(shop), shop.user()
    order = make_order(shop.session, user, status="pagado")

    body = admin_order(shop, admin, order.id)

    assert set(body) == ADMIN_DETAIL_KEYS
    assert body["id"] == str(order.id) and body["user_id"] == str(user)
    assert body["number"] == format_order_number(order.number or 0)
    assert body["status"] == "pagado" and body["paid_at"] is not None
    assert body["expires_at"] is None and body["expires_in_seconds"] is None


def test_the_detail_lines_totals_and_delivery_are_the_snapshot(shop: OrderShop) -> None:
    admin, user = admin_of(shop), shop.user()
    line = real_line(
        shop.session,
        quantity=2,
        list_price=150_000,
        unit_price=120_000,
        name="Heritage 38",
        sku="DEMO-H38",
    )
    order = make_order(
        shop.session,
        user,
        lines=[line],
        delivery=shipping_delivery(recipient_name="Ana Torres", district="Miraflores"),
    )

    body = admin_order(shop, admin, order.id)

    [got] = body["lines"]
    assert set(got) == LINE_KEYS
    assert (got["sku"], got["name"], got["quantity"]) == ("DEMO-H38", "Heritage 38", 2)
    assert got["list_price"] == money(150_000) and got["unit_price"] == money(120_000)
    assert got["discount_amount"] == money(30_000) and got["line_total"] == money(240_000)
    assert got["fulfillment"] == "stock" and got["lead_time_days"] is None
    assert body["subtotal"] == money(240_000) and body["shipping"] == money(0)
    assert body["total"] == money(240_000) and body["item_count"] == 2
    assert body["delivery"]["delivery_method"] == "shipping"
    assert body["refund"] is None


def test_the_admin_sees_the_full_delivery_data_including_phone_and_address(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), delivery=shipping_delivery())

    delivery = admin_order(shop, admin, order.id)["delivery"]

    assert delivery["recipient_name"] == "Ana Pérez" and delivery["phone"] == "+51987654321"
    assert (delivery["department"], delivery["province"], delivery["district"]) == (
        "Lima",
        "Lima",
        "Miraflores",
    )
    assert delivery["address_line"] == "Av. Larco 1234, piso 5"
    assert delivery["reference"] == "Frente al parque"
    assert delivery["pickup_store"] is None


def test_a_pickup_order_shows_the_store_and_no_address_to_the_admin(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), delivery=pickup_delivery())

    delivery = admin_order(shop, admin, order.id)["delivery"]

    assert delivery["delivery_method"] == "pickup"
    assert delivery["recipient_name"] == "Ana Pérez" and delivery["phone"] == "987654321"
    for field in ("department", "province", "district", "address_line", "reference"):
        assert delivery[field] is None, field
    assert delivery["pickup_store"] == {
        "name": helpers.STORE_ENV["PICKUP_STORE_NAME"],
        "address": helpers.STORE_ENV["PICKUP_STORE_ADDRESS"],
        "hours": helpers.STORE_ENV["PICKUP_STORE_HOURS"],
    }


def test_the_shipment_data_is_shown_once_the_order_was_shipped(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="enviado")
    shop.session.execute(
        text(
            "UPDATE app.deliveries SET carrier = 'Olva', tracking_code = 'OL-123',"
            " shipped_at = now() WHERE order_id = :id"
        ),
        {"id": order.id},
    )

    delivery = admin_order(shop, admin, order.id)["delivery"]

    assert (delivery["carrier"], delivery["tracking_code"]) == ("Olva", "OL-123")
    assert delivery["shipped_at"] is not None


def test_a_refunded_cancelled_order_shows_the_refund(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="pagado")
    shop.session.execute(
        text(
            "UPDATE app.orders SET status = 'cancelado', refunded_amount = total_amount,"
            " refunded_at = now() WHERE id = :id"
        ),
        {"id": order.id},
    )

    body = admin_order(shop, admin, order.id)

    assert body["status"] == "cancelado"
    assert body["refund"]["amount"] == money(order.total_amount)
    assert parse_utc(body["refund"]["at"]) <= datetime.now(UTC) + timedelta(minutes=1)
    assert body["can_transition_to"] == []


def test_amounts_above_two_to_the_31_are_exact(shop: OrderShop) -> None:
    admin = admin_of(shop)
    big = real_line(shop.session, quantity=2, list_price=2_500_000_000)
    order = make_order(shop.session, shop.user(), lines=[big])

    body = admin_order(shop, admin, order.id)

    assert body["total"] == money(5_000_000_000) and body["subtotal"] == money(5_000_000_000)
    assert body["lines"][0]["line_total"] == money(5_000_000_000)
    page = admin_page(shop, admin, ("q", format_order_number(order.number or 0)))
    assert page["items"][0]["total"] == money(5_000_000_000)


def test_a_made_to_order_line_shows_its_lead_time_and_the_estimated_date(shop: OrderShop) -> None:
    admin = admin_of(shop)
    line = replace(
        real_line(shop.session), fulfillment=Fulfillment.MADE_TO_ORDER, lead_time_days=21
    )
    order = make_order(shop.session, shop.user(), lines=[line])

    body = admin_order(shop, admin, order.id)

    assert body["lines"][0]["fulfillment"] == "made_to_order"
    assert body["lines"][0]["lead_time_days"] == 21
    assert order.estimated_delivery_on is not None
    assert body["estimated_delivery_on"] == order.estimated_delivery_on.isoformat()


def test_the_admin_detail_keeps_can_cancel_and_the_countdown_of_the_customer_detail(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    pending = make_order(shop.session, shop.user(), status="pendiente_pago", minutes_ago=5)
    paid = make_order(shop.session, shop.user(), status="pagado")

    on_pending = admin_order(shop, admin, pending.id)
    on_paid = admin_order(shop, admin, paid.id)

    assert on_pending["can_cancel"] is True and isinstance(on_pending["expires_in_seconds"], int)
    assert on_paid["can_cancel"] is False and on_paid["expires_in_seconds"] is None


def test_the_pending_detail_shows_the_countdown_and_expires_at(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="pendiente_pago", minutes_ago=10)

    body = admin_order(shop, admin, order.id)

    assert parse_utc(body["expires_at"]) == order.expires_at
    assert 0 <= body["expires_in_seconds"] <= 20 * 60


# --- historial: notas y actor_id solo para el administrador ---
def seed_history(shop: OrderShop, order_id: UUID, admin: UUID) -> None:
    insert_history_row(
        shop.session,
        order_id,
        from_status="pendiente_pago",
        to_status="pagado",
        actor_kind="customer",
        actor_id=uuid4(),
        note=None,
    )
    insert_history_row(
        shop.session,
        order_id,
        from_status="pagado",
        to_status="en_preparacion",
        actor_kind="admin",
        actor_id=admin,
        note="Nota interna: verificar caja",
    )


def test_the_admin_history_has_actor_id_and_the_internal_notes_oldest_first(
    shop: OrderShop,
) -> None:
    admin, user = admin_of(shop), shop.user()
    order = make_order(shop.session, user, status="en_preparacion")
    seed_history(shop, order.id, admin)

    history = admin_order(shop, admin, order.id)["history"]

    assert [(h["from_status"], h["status"], h["actor"]) for h in history] == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "pagado", "customer"),
        ("pagado", "en_preparacion", "admin"),
    ]
    assert all(set(h) == ADMIN_HISTORY_KEYS for h in history)
    assert history[0]["actor_id"] == str(user) and history[0]["note"] is None
    assert history[2]["actor_id"] == str(admin)
    assert history[2]["note"] == "Nota interna: verificar caja"
    stamps = [parse_utc(h["at"]) for h in history]
    assert stamps == sorted(stamps)


def test_the_same_order_for_its_owner_has_no_notes_no_actor_id_and_no_user_id(
    shop: OrderShop,
) -> None:
    admin, user = admin_of(shop), shop.user()
    order = make_order(shop.session, user, status="en_preparacion")
    seed_history(shop, order.id, admin)

    response = get_order(shop, user, order.id)

    assert response.status_code == 200
    for internal in ("Nota interna", "actor_id", "user_id", str(admin), "can_transition_to"):
        assert internal not in response.text, internal
    assert [h["actor"] for h in response.json()["history"]] == ["customer", "customer", "admin"]


def test_a_system_entry_has_a_null_actor_id_for_the_admin(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="expirado")
    insert_history_row(
        shop.session,
        order.id,
        from_status="pendiente_pago",
        to_status="expirado",
        actor_kind="system",
        actor_id=None,
    )

    last = admin_order(shop, admin, order.id)["history"][-1]

    assert (last["status"], last["actor"], last["actor_id"], last["note"]) == (
        "expirado",
        "system",
        None,
        None,
    )


# --- can_transition_to por estado y modalidad (§5, R20) ---
SHIPPING_TARGETS = {
    "pendiente_pago": {"cancelado"},
    "pagado": {"en_preparacion", "cancelado"},
    "en_preparacion": {"enviado", "cancelado"},
    "enviado": {"entregado"},
    "entregado": set(),
    "cancelado": set(),
    "expirado": set(),
}
PICKUP_TARGETS = {
    "pendiente_pago": {"cancelado"},
    "pagado": {"en_preparacion", "cancelado"},
    "en_preparacion": {"listo_para_recojo", "cancelado"},
    "listo_para_recojo": {"entregado"},
    "entregado": set(),
    "cancelado": set(),
    "expirado": set(),
}


@pytest.mark.parametrize(("status", "targets"), sorted(SHIPPING_TARGETS.items()))
def test_can_transition_to_of_a_shipping_order(
    shop: OrderShop, status: str, targets: set[str]
) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status=status, minutes_ago=5)

    got = admin_order(shop, admin, order.id)["can_transition_to"]

    assert isinstance(got, list) and len(got) == len(set(got))
    assert set(got) == targets


@pytest.mark.parametrize(("status", "targets"), sorted(PICKUP_TARGETS.items()))
def test_can_transition_to_of_a_pickup_order(
    shop: OrderShop, status: str, targets: set[str]
) -> None:
    admin = admin_of(shop)
    order = make_order(
        shop.session, shop.user(), status=status, minutes_ago=5, delivery=pickup_delivery()
    )

    got = admin_order(shop, admin, order.id)["can_transition_to"]

    assert set(got) == targets and len(got) == len(set(got))


def test_can_transition_to_never_offers_the_states_only_the_system_sets(shop: OrderShop) -> None:
    admin = admin_of(shop)
    for status in ALL_STATUSES:
        order = make_order(shop.session, shop.user(), status=status, minutes_ago=5)
        got = set(admin_order(shop, admin, order.id)["can_transition_to"])
        assert not got & {"pagado", "expirado", "pendiente_pago"}, status


def test_the_list_of_targets_changes_when_the_order_moves(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="pagado")
    before = set(admin_order(shop, admin, order.id)["can_transition_to"])

    set_status(shop.session, order.id, "en_preparacion")
    after = set(admin_order(shop, admin, order.id)["can_transition_to"])

    assert before == {"en_preparacion", "cancelado"} and after == {"enviado", "cancelado"}


# --- 404 y 422 del detalle ---
def test_an_unknown_order_is_404_not_found(shop: OrderShop) -> None:
    admin = admin_of(shop)

    details = error_of(admin_get(shop, admin, uuid4()), 404, "not_found")

    assert details is None


@pytest.mark.parametrize(
    "bad", ["no-es-uuid", "123", "VAL-000123", "00000000-0000-0000-0000", "%00"]
)
def test_a_malformed_order_id_is_422_with_the_path_location(shop: OrderShop, bad: str) -> None:
    admin = admin_of(shop)

    response = admin_get(shop, admin, bad)

    assert response.status_code == 422 and response.json()["error"]["code"] == "validation_error"
    assert "Traceback" not in response.text


def test_the_detail_is_found_for_every_customer_and_state(shop: OrderShop) -> None:
    admin = admin_of(shop)
    for status in ALL_STATUSES:
        order = make_order(shop.session, add_profile(shop.session), status=status, minutes_ago=5)
        assert admin_order(shop, admin, order.id)["status"] == status


def test_reading_the_detail_changes_nothing_for_a_paid_order(shop: OrderShop) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="pagado")
    count = lambda: shop.session.execute(  # noqa: E731
        text(
            "SELECT (SELECT count(*) FROM app.order_status_history WHERE order_id = :i),"
            " (SELECT count(*) FROM app.audit_log WHERE entity_id = :s),"
            " (SELECT status || updated_at::text FROM app.orders WHERE id = :i)"
        ),
        {"i": order.id, "s": str(order.id)},
    ).one()
    before = count()

    admin_order(shop, admin, order.id)
    admin_order(shop, admin, order.id)
    admin_page(shop, admin)

    assert count() == before


def test_the_order_ids_in_the_path_and_the_customer_path_are_kept_apart(shop: OrderShop) -> None:
    # Misma forma `/orders/<uuid>` y `/orders/admin/<uuid>`: cada una con su propio contrato.
    admin, user = admin_of(shop), shop.user()
    order = make_order(shop.session, user)

    assert "user_id" in admin_order(shop, admin, order.id)
    assert "user_id" not in read_order(shop, user, order.id)
