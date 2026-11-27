"""Transiciones de administración por HTTP con pedidos reales (T-079; CA-ORDERS-18, 20, 21, 22 y 26;
SPEC §4 R11, R12, R18, R19 y R20, §5, §7). El recorrido completo de cada modalidad con pedidos que
nacen de `POST /orders` y se pagan con el `ConfirmOrderPayment` real; la forma de la salida; el
historial (una fila por transición, con el administrador como actor y su nota); la auditoría
(`orders.status_changed` con el administrador, sin datos personales ni nota en los logs); envío con
transportista y seguimiento, visibles después al administrador y al cliente; lo que el cliente no
ve (nota y `actor_id`); y que el actor sale del token, no de cabeceras ni del cuerpo. Cada solicitud
corre en un SAVEPOINT de la transacción de la prueba. Datos ficticios."""

import logging
from typing import Any

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import (
    ADMIN_DETAIL_KEYS,
    ADMIN_HISTORY_KEYS,
    admin_of,
    admin_order,
)
from tests.orders.orders_http_helpers import (
    PERSONAL,
    OrderShop,
    audit_rows,
    money,
    on_hand,
    parse_utc,
)
from tests.orders.orders_read_helpers import get_order, headers, list_orders, read_order
from tests.orders.orders_transition_helpers import (
    NOTE,
    delivery_columns,
    history_of,
    moved,
    order_in,
    paid,
    stock_movements,
    total_of,
    transition,
)
from tests.orders.test_admin_orders_http import error_of
from tests.orders.test_cancel_order_http import cancel

pytestmark = pytest.mark.integration

shop = helpers.shop

CUSTOMER_HISTORY_KEYS = {"from_status", "status", "at", "actor"}


# --------------------------------------------------------------------------------------------
# Forma de la salida y coherencia con la lectura
def test_the_response_is_an_admin_order_detail_with_the_new_state(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")

    body = moved(shop, admin_of(shop), order.id, "en_preparacion")

    assert set(body) == ADMIN_DETAIL_KEYS
    assert body["id"] == str(order.id) and body["user_id"] == str(order.user_id)
    assert body["status"] == "en_preparacion"
    assert body["total"] == money(order.total_amount)
    assert body["can_cancel"] is False and body["refund"] is None
    assert all(set(h) == ADMIN_HISTORY_KEYS for h in body["history"])


@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
def test_after_a_200_the_response_is_what_the_admin_detail_shows(
    shop: OrderShop, pickup: bool
) -> None:
    _, order_id, _ = paid(shop, pickup=pickup)
    admin = admin_of(shop)
    handed = "listo_para_recojo" if pickup else "enviado"

    for to in ("en_preparacion", handed, "entregado"):
        body = moved(shop, admin, order_id, to)
        assert admin_order(shop, admin, order_id) == body, to  # la interfaz usa el cuerpo recibido
        assert body["can_transition_to"] == admin_order(shop, admin, order_id)["can_transition_to"]


def test_the_last_history_entry_has_the_admin_the_note_and_the_states(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    admin = admin_of(shop)

    body = moved(shop, admin, order.id, "en_preparacion", note="Pieza al taller")

    last = body["history"][-1]
    assert last["from_status"] == "pagado" and last["status"] == "en_preparacion"
    assert last["actor"] == "admin" and last["actor_id"] == str(admin)
    assert last["note"] == "Pieza al taller"
    assert parse_utc(last["at"]) >= parse_utc(body["history"][0]["at"])


@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
def test_the_full_journey_is_one_admin_row_per_step_in_the_history_and_the_audit(
    shop: OrderShop, pickup: bool
) -> None:
    user, order_id, _ = paid(shop, pickup=pickup)
    admin = admin_of(shop)
    handed = "listo_para_recojo" if pickup else "enviado"
    steps = ["en_preparacion", handed, "entregado"]

    for to in steps:
        moved(shop, admin, order_id, to, note=f"paso {to}")

    rows = history_of(shop.session, order_id)
    assert [(r[0], r[1], r[2]) for r in rows] == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "pagado", "customer"),
        ("pagado", "en_preparacion", "admin"),
        ("en_preparacion", handed, "admin"),
        (handed, "entregado", "admin"),
    ]
    assert [(r[3], r[4]) for r in rows[2:]] == [(admin, f"paso {to}") for to in steps]
    entries = [
        a
        for a in audit_rows(shop.session, entity_id=order_id)
        if a["action"] == "orders.status_changed"
    ]
    admin_entries = [a for a in entries if a["actor_role"] == "admin"]
    assert len(admin_entries) == 3  # una auditoría por transición, ni más ni menos
    assert all(a["actor_id"] == admin and a["entity_type"] == "order" for a in admin_entries)
    assert [(a["before"], a["after"]) for a in admin_entries] == [
        ({"status": "pagado"}, {"status": "en_preparacion"}),
        ({"status": "en_preparacion"}, {"status": handed}),
        ({"status": handed}, {"status": "entregado"}),
    ]
    final = read_order(shop, user, order_id)
    assert final["status"] == "entregado" and final["can_cancel"] is False
    assert final["refund"] is None


def test_the_journey_never_touches_the_stock_that_the_payment_already_took(
    shop: OrderShop,
) -> None:
    _, order_id, product = paid(shop, quantity=2, on_hand=5)
    admin = admin_of(shop)
    assert on_hand(shop.session, product) == 3
    movements = stock_movements(shop.session, order_id)

    for to in ("en_preparacion", "enviado", "entregado"):
        moved(shop, admin, order_id, to)

    assert on_hand(shop.session, product) == 3
    assert stock_movements(shop.session, order_id) == movements == [("venta", -2)]


# --------------------------------------------------------------------------------------------
# Envío: transportista, seguimiento y `shipped_at`
def test_shipping_stores_carrier_tracking_and_shipped_at_and_shows_them_to_both(
    shop: OrderShop,
) -> None:
    user, order_id, _ = paid(shop)
    admin = admin_of(shop)
    moved(shop, admin, order_id, "en_preparacion")

    body = moved(shop, admin, order_id, "enviado", carrier="Olva", tracking_code="OL-123")

    for view in (body["delivery"], admin_order(shop, admin, order_id)["delivery"]):
        assert (view["carrier"], view["tracking_code"]) == ("Olva", "OL-123")
        assert parse_utc(view["shipped_at"]) == parse_utc(body["history"][-1]["at"])
    seen = read_order(shop, user, order_id)["delivery"]  # el cliente también lo ve
    assert (seen["carrier"], seen["tracking_code"]) == ("Olva", "OL-123")
    assert parse_utc(seen["shipped_at"]) == parse_utc(body["history"][-1]["at"])
    carrier, tracking, shipped_at = delivery_columns(shop.session, order_id)
    assert (carrier, tracking) == ("Olva", "OL-123") and shipped_at is not None


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"carrier": "Olva"},
        {"tracking_code": "OL-123"},
        {"carrier": None, "tracking_code": None},
    ],
    ids=["neither", "carrier", "tracking", "nulls"],
)
def test_carrier_and_tracking_are_optional_but_shipped_at_is_always_set(
    shop: OrderShop, extra: dict[str, Any]
) -> None:
    order = order_in(shop, "en_preparacion")

    body = moved(shop, admin_of(shop), order.id, "enviado", **extra)

    delivery = body["delivery"]
    assert delivery["carrier"] == extra.get("carrier")
    assert delivery["tracking_code"] == extra.get("tracking_code")
    assert delivery["shipped_at"] is not None


@pytest.mark.parametrize("size,status", [(1, 200), (60, 200), (61, 422)])
@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
def test_carrier_and_tracking_are_one_to_sixty_characters(
    shop: OrderShop, field: str, size: int, status: int
) -> None:
    order = order_in(shop, "en_preparacion")

    response = transition(shop, admin_of(shop), order.id, "enviado", **{field: "c" * size})

    assert response.status_code == status, response.text
    if status == 422:
        error_of(response, 422, "validation_error")
        assert delivery_columns(shop.session, order.id) == (None, None, None)
        assert order_state(shop, order.id) == "en_preparacion"


def order_state(shop: OrderShop, order_id: object) -> str:
    return admin_order(shop, admin_of(shop), order_id)["status"]


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
def test_an_empty_carrier_or_tracking_is_422(shop: OrderShop, field: str) -> None:
    order = order_in(shop, "en_preparacion")

    error_of(
        transition(shop, admin_of(shop), order.id, "enviado", **{field: ""}),
        422,
        "validation_error",
    )

    assert delivery_columns(shop.session, order.id) == (None, None, None)


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
@pytest.mark.parametrize(
    "status,to,method",
    [
        ("pagado", "en_preparacion", "shipping"),
        ("en_preparacion", "listo_para_recojo", "pickup"),
        ("listo_para_recojo", "entregado", "pickup"),
        ("enviado", "entregado", "shipping"),
        ("pagado", "cancelado", "shipping"),
        ("pendiente_pago", "cancelado", "shipping"),
    ],
)
def test_carrier_or_tracking_with_another_destination_is_422_even_if_the_transition_is_valid(
    shop: OrderShop, field: str, status: str, to: str, method: str
) -> None:
    order = order_in(shop, status, method)
    admin = admin_of(shop)

    details = error_of(
        transition(shop, admin, order.id, to, **{field: "Olva"}), 422, "validation_error"
    )

    assert details  # la entrada es inválida por el destino, no por la máquina de estados
    assert order_state(shop, order.id) == status
    assert delivery_columns(shop.session, order.id) == (None, None, None)
    assert len(history_of(shop.session, order.id)) == 1


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
def test_carrier_or_tracking_with_an_invalid_pair_is_422_not_409(
    shop: OrderShop, field: str
) -> None:
    order = order_in(shop, "pagado")  # pagado → entregado sería 409, pero el cuerpo ya es inválido

    error_of(
        transition(shop, admin_of(shop), order.id, "entregado", **{field: "Olva"}),
        422,
        "validation_error",
    )


def test_only_the_shipping_step_sets_shipped_at(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    admin = admin_of(shop)

    prepared = moved(shop, admin, order.id, "en_preparacion")
    assert prepared["delivery"]["shipped_at"] is None

    shipped = moved(shop, admin, order.id, "enviado", carrier="Olva", tracking_code="OL-9")
    delivered = moved(shop, admin, order.id, "entregado")

    assert delivered["delivery"] == shipped["delivery"]  # entregar no reescribe el envío


def test_a_pickup_order_never_gets_carrier_tracking_or_shipped_at(shop: OrderShop) -> None:
    _, order_id, _ = paid(shop, pickup=True)
    admin = admin_of(shop)

    for to in ("en_preparacion", "listo_para_recojo", "entregado"):
        body = moved(shop, admin, order_id, to)
        delivery = body["delivery"]
        assert (delivery["carrier"], delivery["tracking_code"], delivery["shipped_at"]) == (
            None,
            None,
            None,
        )
        assert delivery["delivery_method"] == "pickup" and delivery["pickup_store"] is not None
    assert delivery_columns(shop.session, order_id) == (None, None, None)


def test_shipping_a_pickup_order_with_carrier_is_409_and_writes_nothing(shop: OrderShop) -> None:
    order = order_in(shop, "en_preparacion", "pickup")

    details = error_of(
        transition(shop, admin_of(shop), order.id, "enviado", carrier="Olva", tracking_code="1"),
        409,
        "invalid_transition",
    )

    assert set(details["allowed"]) == {"listo_para_recojo", "cancelado"}
    assert delivery_columns(shop.session, order.id) == (None, None, None)
    assert order_state(shop, order.id) == "en_preparacion"


def test_the_pickup_store_shown_is_the_current_one_of_settings(shop: OrderShop) -> None:
    _, order_id, _ = paid(shop, pickup=True)
    shop.set_store(name="Boutique Nueva", address="Calle Nueva 1", hours="L-V 9 a 5")

    body = moved(shop, admin_of(shop), order_id, "en_preparacion")

    assert body["delivery"]["pickup_store"] == {
        "name": "Boutique Nueva",
        "address": "Calle Nueva 1",
        "hours": "L-V 9 a 5",
    }


# --------------------------------------------------------------------------------------------
# Lo que el cliente ve y no ve (R11, R12, R18)
def test_the_customer_sees_the_admin_step_without_note_or_actor_id(shop: OrderShop) -> None:
    user, order_id, _ = paid(shop)
    admin = admin_of(shop)
    internal_note = "Cliente sospechoso de fraude"

    moved(shop, admin, order_id, "en_preparacion", note=internal_note)

    seen = read_order(shop, user, order_id)
    assert seen["history"][-1]["actor"] == "admin" and seen["history"][-1]["status"] == (
        "en_preparacion"
    )
    assert all(set(h) == CUSTOMER_HISTORY_KEYS for h in seen["history"])
    dump = repr(seen)
    assert internal_note not in dump and str(admin) not in dump
    listing = list_orders(shop, user).json()
    assert internal_note not in repr(listing) and str(admin) not in repr(listing)
    assert listing["items"][0]["status"] == "en_preparacion"


def test_the_admin_sees_the_note_and_the_actor_id_in_the_detail(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    admin = admin_of(shop)
    moved(shop, admin, order.id, "en_preparacion", note="Visible solo para administración")

    last = admin_order(shop, admin, order.id)["history"][-1]

    assert last["note"] == "Visible solo para administración" and last["actor_id"] == str(admin)


def test_another_customer_still_cannot_read_the_order_the_admin_moved(shop: OrderShop) -> None:
    owner = shop.user()
    order = order_in(shop, "pagado", user=owner)
    moved(shop, admin_of(shop), order.id, "en_preparacion", note=NOTE)

    stranger = get_order(shop, shop.user(), order.id)

    error_of(stranger, 404, "not_found")
    assert NOTE not in stranger.text


@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
def test_the_customer_cannot_cancel_once_the_admin_started_preparing(
    shop: OrderShop, pickup: bool
) -> None:
    user, order_id, _ = paid(shop, pickup=pickup)
    moved(shop, admin_of(shop), order_id, "en_preparacion")

    details = error_of(cancel(shop, user, order_id), 409, "not_cancellable")

    assert details == {"status": "en_preparacion"}


# --------------------------------------------------------------------------------------------
# CA-ORDERS-21 y R18: auditoría y logs sin datos personales ni la nota
def test_the_audit_and_the_logs_of_a_transition_have_no_personal_data_nor_the_note(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    _, order_id, _ = paid(shop)
    caplog.set_level(logging.DEBUG)
    note = "Nota-interna-confidencial-4711"

    moved(shop, admin_of(shop), order_id, "en_preparacion", note=note)
    moved(shop, admin_of(shop), order_id, "enviado", note=note, carrier="Olva", tracking_code="T1")

    dump = repr(audit_rows(shop.session, entity_id=order_id))
    for personal in (*PERSONAL, "Torres"):
        assert personal not in dump, personal
        assert personal not in caplog.text, personal
    assert note not in caplog.text  # la nota es interna: tampoco en los logs
    assert "Olva" not in caplog.text and "T1" not in caplog.text


def test_a_rejected_transition_logs_no_body_and_leaks_no_trace(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    order = order_in(shop, "entregado")
    caplog.set_level(logging.DEBUG)
    note = "Nota-rechazada-9981"

    response = transition(shop, admin_of(shop), order.id, "cancelado", note=note)

    error_of(response, 409, "invalid_transition")
    assert note not in caplog.text and note not in response.text
    assert "Traceback" not in response.text


# --------------------------------------------------------------------------------------------
# El actor sale del token
def test_the_actor_is_the_token_admin_not_a_header_nor_the_body(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    admin, other_admin = admin_of(shop), admin_of(shop)
    spoof = {"X-User-Id": str(other_admin), "X-Actor-Id": str(other_admin), "X-Actor": "system"}

    response = shop.client.post(
        f"{helpers.PATH}/admin/{order.id}/transitions",
        headers={**headers(admin), **spoof},
        json={"to": "en_preparacion"},
    )

    assert response.status_code == 200, response.text
    last = response.json()["history"][-1]
    assert (last["actor"], last["actor_id"]) == ("admin", str(admin))
    assert history_of(shop.session, order.id)[-1][2:4] == ("admin", admin)
    [entry] = [a for a in audit_rows(shop.session, entity_id=str(order.id))]
    assert entry["actor_id"] == admin and entry["actor_role"] == "admin"


def test_two_admins_each_leave_their_own_id_in_their_own_step(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    first, second = admin_of(shop), admin_of(shop)

    moved(shop, first, order.id, "en_preparacion")
    moved(shop, second, order.id, "enviado")

    rows = history_of(shop.session, order.id)[-2:]
    assert [r[3] for r in rows] == [first, second]


def test_the_total_of_the_order_is_never_changed_by_a_transition(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    total = total_of(shop.session, order.id)

    for to in ("en_preparacion", "enviado", "entregado"):
        body = moved(shop, admin_of(shop), order.id, to)
        assert body["total"] == money(total) and total_of(shop.session, order.id) == total
