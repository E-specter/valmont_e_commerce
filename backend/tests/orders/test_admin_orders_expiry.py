"""Caducidad por lectura y datos personales en las lecturas de administración, con la app real y
PostgreSQL (T-078; CA-ORDERS-13, 21 y 22; SPEC §3 UC-05, §4 R6, R7, R11 y R18, §9). Los pedidos
nacen de `POST /orders` (reservas y carrito reales) y se envejecen por SQL: el reloj de la BD es el
de la transacción de la prueba. El listado materializa hasta 200 vencidos de **cualquier** cliente;
el detalle solo el pedido pedido. Se comprueba lo que la lectura escribe (estado, historial,
auditoría sin actor, reservas `released`), que repetir no duplica nada y que ni los logs ni la
auditoría llevan nombre, teléfono ni dirección. Datos ficticios."""

import logging
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import (
    admin_get,
    admin_list,
    admin_of,
    admin_order,
    admin_page,
    audit_count,
    named_order,
    tag,
)
from tests.orders.orders_db_helpers import real_line
from tests.orders.orders_http_helpers import (
    PERSONAL,
    OrderShop,
    audit_rows,
    available,
    on_hand,
    place,
    quick,
    reservations,
    stock_in_cart,
)
from tests.orders.orders_read_helpers import (
    db_status,
    headers,
    history_count,
    ids_of,
    make_order,
    make_overdue,
    status_changed_audit,
    statuses_of,
)

pytestmark = pytest.mark.integration

shop = helpers.shop

PERSONAL_DATA = (*PERSONAL, "Torres", "+51987654321")


def pending_order(shop: OrderShop, **product: Any) -> tuple[UUID, str, UUID, str]:
    """(cliente, id del pedido, producto, número visible): pedido pendiente real con su reserva."""
    user, product_id = quick(shop, **product)
    response = place(shop, user)
    assert response.status_code == 201, response.text
    body = response.json()
    return user, body["id"], product_id, body["number"]


def reservation_statuses(shop: OrderShop, order_id: object) -> list[str]:
    return [r["status"] for r in reservations(shop.session, order_id)]


def app_logs(caplog: pytest.LogCaptureFixture) -> str:
    """Lo que registra la aplicación; el cliente de pruebas (httpx) también loguea la URL pedida,
    con la `q` que la prueba envía, y eso no es la aplicación."""
    return " | ".join(r.getMessage() for r in caplog.records if not r.name.startswith("httpx"))


def history_rows(shop: OrderShop, order_id: object) -> list[tuple[Any, ...]]:
    rows = shop.session.execute(
        text(
            "SELECT from_status, to_status, actor_kind, actor_id, note FROM"
            " app.order_status_history WHERE order_id = :id ORDER BY id"
        ),
        {"id": order_id},
    )
    return [tuple(r) for r in rows]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-13: el listado materializa los vencidos de cualquier cliente
def test_listing_shows_an_overdue_order_of_another_customer_as_expired(shop: OrderShop) -> None:
    admin = admin_of(shop)
    user, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)

    page = admin_page(shop, admin, ("q", number))

    assert ids_of(page) == [order_id] and statuses_of(page) == ["expirado"]
    assert page["items"][0]["user_id"] == str(user)
    assert page["items"][0]["expires_at"] is None
    assert db_status(shop.session, order_id) == "expirado"


def test_the_expiry_by_the_list_adds_one_system_history_entry_without_actor(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    user, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)

    admin_page(shop, admin, ("q", number))

    assert history_rows(shop, order_id) == [
        (None, "pendiente_pago", "customer", user, None),
        ("pendiente_pago", "expirado", "system", None, None),
    ]


def test_the_expiry_by_the_list_releases_the_reservation_and_the_stock_is_available(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    _, order_id, product, number = pending_order(shop)
    assert reservation_statuses(shop, order_id) == ["active"]
    assert available(shop.session, product) == 4
    make_overdue(shop.session, order_id)

    admin_page(shop, admin, ("q", number))

    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5 and on_hand(shop.session, product) == 5


def test_the_expiry_by_the_list_is_audited_without_actor_and_once(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)

    admin_page(shop, admin, ("q", number))

    [entry] = status_changed_audit(shop.session, order_id)
    assert entry["actor_id"] is None and entry["actor_role"] is None
    assert entry["entity_type"] == "order"
    assert entry["before"] == {"status": "pendiente_pago"}
    assert entry["after"] == {"status": "expirado"}


def test_listing_expires_the_orders_of_several_customers_in_one_read(shop: OrderShop) -> None:
    admin = admin_of(shop)
    first, second = pending_order(shop), pending_order(shop)
    for _, order_id, _, _ in (first, second):
        make_overdue(shop.session, order_id)

    admin_page(shop, admin, ("q", first[3]))  # un solo listado, ni siquiera de ese pedido

    assert db_status(shop.session, first[1]) == "expirado"
    assert db_status(shop.session, second[1]) == "expirado"
    assert reservation_statuses(shop, second[1]) == ["released"]


def test_a_filtered_list_still_materializes_before_filtering(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)

    as_expired = admin_page(shop, admin, ("q", number), ("status", "expirado"))
    as_pending = admin_page(shop, admin, ("q", number), ("status", "pendiente_pago"))

    assert ids_of(as_expired) == [order_id] and as_expired["total"] == 1
    assert as_pending["items"] == [] and as_pending["total"] == 0


def test_the_status_filter_sees_the_real_state_even_in_the_same_request(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)

    # primera lectura del pedido: la del propio filtro por `pendiente_pago`
    assert admin_page(shop, admin, ("q", number), ("status", "pendiente_pago"))["total"] == 0
    assert db_status(shop.session, order_id) == "expirado"


def test_reading_again_does_not_duplicate_history_audit_or_release(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, product, number = pending_order(shop)
    make_overdue(shop.session, order_id)

    admin_page(shop, admin, ("q", number))
    snapshot = (
        history_count(shop.session, order_id),
        audit_count(shop.session, order_id),
        reservation_statuses(shop, order_id),
        available(shop.session, product),
    )
    admin_page(shop, admin, ("q", number))
    admin_order(shop, admin, order_id)
    admin_page(shop, admin)

    assert (
        history_count(shop.session, order_id),
        audit_count(shop.session, order_id),
        reservation_statuses(shop, order_id),
        available(shop.session, product),
    ) == snapshot
    assert snapshot[0] == 2 and len(status_changed_audit(shop.session, order_id)) == 1


def test_a_vigente_pending_order_is_not_touched_by_the_admin_read(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, product, number = pending_order(shop)
    before = (history_count(shop.session, order_id), audit_count(shop.session, order_id))

    page = admin_page(shop, admin, ("q", number))
    detail = admin_order(shop, admin, order_id)

    assert statuses_of(page) == ["pendiente_pago"] and detail["status"] == "pendiente_pago"
    assert reservation_statuses(shop, order_id) == ["active"]
    assert available(shop.session, product) == 4
    assert (history_count(shop.session, order_id), audit_count(shop.session, order_id)) == before


def test_the_exact_expiry_instant_is_overdue_and_a_second_before_is_not(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, at_limit, _, n1 = pending_order(shop)
    _, one_left, _, n2 = pending_order(shop)
    make_overdue(shop.session, at_limit, seconds_over=0)  # expires_at == now: vencido
    make_overdue(shop.session, one_left, seconds_over=-1)  # un segundo de margen: vigente

    admin_page(shop, admin, ("q", n1))

    assert db_status(shop.session, at_limit) == "expirado"
    assert db_status(shop.session, one_left) == "pendiente_pago"
    assert statuses_of(admin_page(shop, admin, ("q", n2))) == ["pendiente_pago"]


@pytest.mark.parametrize(
    "status", ["pagado", "en_preparacion", "enviado", "entregado", "cancelado"]
)
def test_an_old_order_in_any_other_state_never_expires(shop: OrderShop, status: str) -> None:
    admin, label = admin_of(shop), tag()
    order = named_order(shop, shop.user(), f"Ana {label}", status=status, minutes_ago=600)

    page = admin_page(shop, admin, ("q", label))

    assert statuses_of(page) == [status] and db_status(shop.session, order.id) == status
    assert history_count(shop.session, order.id) == 1  # solo la creación


def test_a_paid_order_keeps_its_reservation_state_untouched(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, product, number = pending_order(shop)
    shop.session.execute(
        text(
            "UPDATE app.orders SET status = 'pagado', paid_at = now(),"
            " created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'"
            " WHERE id = :id"
        ),
        {"id": order_id},
    )

    admin_page(shop, admin, ("q", number))

    assert db_status(shop.session, order_id) == "pagado"
    assert reservation_statuses(shop, order_id) == ["active"]
    assert available(shop.session, product) == 4


def test_a_made_to_order_only_order_also_expires_when_read(shop: OrderShop) -> None:
    admin = admin_of(shop)
    user = shop.user()
    product = add_listed(shop.session, policy="made_to_order", on_hand=None)
    stock_in_cart(shop, user, (product, 1))
    response = place(shop, user)
    assert response.status_code == 201, response.text
    order_id, number = response.json()["id"], response.json()["number"]
    assert reservation_statuses(shop, order_id) == []
    make_overdue(shop.session, order_id)

    assert statuses_of(admin_page(shop, admin, ("q", number))) == ["expirado"]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-13: el detalle materializa solo el pedido pedido
def test_the_detail_of_an_overdue_order_is_expired_with_no_transitions(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, _, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    body = admin_order(shop, admin, order_id)

    assert body["status"] == "expirado"
    assert body["can_transition_to"] == []
    assert body["expires_at"] is None and body["expires_in_seconds"] is None
    assert [(h["from_status"], h["status"], h["actor"], h["actor_id"]) for h in body["history"]][
        -1
    ] == ("pendiente_pago", "expirado", "system", None)
    assert db_status(shop.session, order_id) == "expirado"


def test_the_detail_releases_the_reservation_and_audits_once_even_when_read_twice(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    _, order_id, product, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    admin_order(shop, admin, order_id)
    admin_order(shop, admin, order_id)

    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5
    assert history_count(shop.session, order_id) == 2
    assert len(status_changed_audit(shop.session, order_id)) == 1


def test_the_detail_expires_only_the_requested_order(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, asked, _, _ = pending_order(shop)
    _, bystander, bystander_product, _ = pending_order(shop)
    make_overdue(shop.session, asked)
    make_overdue(shop.session, bystander)

    admin_order(shop, admin, asked)

    assert db_status(shop.session, asked) == "expirado"
    assert db_status(shop.session, bystander) == "pendiente_pago"
    assert reservation_statuses(shop, bystander) == ["active"]
    assert available(shop.session, bystander_product) == 4


def test_a_missing_order_expires_nothing_and_is_404(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, bystander, _, _ = pending_order(shop)
    make_overdue(shop.session, bystander)

    assert admin_get(shop, admin, "00000000-0000-0000-0000-000000000000").status_code == 404

    assert db_status(shop.session, bystander) == "pendiente_pago"


def test_a_customer_forbidden_from_the_admin_routes_expires_nothing(shop: OrderShop) -> None:
    _, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)
    intruder = shop.user()

    assert admin_list(shop, intruder, ("q", number)).status_code == 403
    assert admin_get(shop, intruder, order_id).status_code == 403

    assert db_status(shop.session, order_id) == "pendiente_pago"
    assert reservation_statuses(shop, order_id) == ["active"]


def test_the_owner_sees_the_same_expired_order_the_admin_materialized(shop: OrderShop) -> None:
    admin = admin_of(shop)
    user, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)
    admin_page(shop, admin, ("q", number))

    mine = shop.client.get(f"{helpers.PATH}/{order_id}", headers=headers(user)).json()

    assert mine["status"] == "expirado" and mine["can_cancel"] is False
    assert [h["actor"] for h in mine["history"]] == ["customer", "system"]


# --------------------------------------------------------------------------------------------
# R7: como máximo 200 por lectura (lectura de administración de 200+ vencidos)
def test_one_admin_list_materializes_at_most_200_overdue_and_the_next_read_the_rest(
    shop: OrderShop,
) -> None:
    admin, label = admin_of(shop), tag()
    users = [shop.user(), shop.user()]
    line = real_line(shop.session)  # un solo producto: no hace falta stock, solo la FK
    orders = [
        make_order(
            shop.session,
            users[n % 2],
            status="pendiente_pago",
            minutes_ago=5,
            lines=[line],
            recipient=f"Ana {label}",
        )
        for n in range(201)
    ]
    ids = [o.id for o in orders]
    shop.session.execute(
        text(
            "UPDATE app.orders SET created_at = now() - interval '2 hours',"
            " expires_at = now() - interval '1 minute' WHERE id = ANY(:ids)"
        ),
        {"ids": ids},
    )
    overdue_sql = (
        "SELECT count(*) FROM app.orders WHERE status = 'pendiente_pago' AND expires_at <= now()"
    )
    expired_sql = "SELECT count(*) FROM app.orders WHERE status = 'expirado'"
    overdue_before = shop.session.execute(text(overdue_sql)).scalar_one()
    expired_before = shop.session.execute(text(expired_sql)).scalar_one()
    assert overdue_before >= 201

    first = admin_page(shop, admin, ("q", label), ("page_size", 1))

    assert first["total"] == 201  # el listado sigue filtrando por el nombre; el total es de los 201
    done = shop.session.execute(text(expired_sql)).scalar_one() - expired_before
    assert done == 200  # tope de R7 por llamada: nunca más de 200, aunque haya más vencidos
    for _ in range(10):  # el resto, en las siguientes lecturas
        if shop.session.execute(text(overdue_sql)).scalar_one() == 0:
            break
        admin_page(shop, admin, ("q", label), ("page_size", 1))
    assert shop.session.execute(text(overdue_sql)).scalar_one() == 0

    per_order = shop.session.execute(
        text(
            "SELECT h.order_id, count(*) FROM app.order_status_history h"
            " WHERE h.order_id = ANY(:ids) AND h.to_status = 'expirado' GROUP BY h.order_id"
        ),
        {"ids": ids},
    ).all()
    assert len(per_order) == 201 and {count for _, count in per_order} == {1}
    audited = shop.session.execute(
        text(
            "SELECT entity_id, count(*) FROM app.audit_log"
            " WHERE action = 'orders.status_changed' AND entity_id = ANY(:ids) GROUP BY entity_id"
        ),
        {"ids": [str(i) for i in ids]},
    ).all()
    assert len(audited) == 201 and {count for _, count in audited} == {1}


# --------------------------------------------------------------------------------------------
# R18: sin datos personales en logs ni en la auditoría (CA-ORDERS-21)
def test_logs_never_contain_name_phone_or_address_when_the_admin_reads(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    admin = admin_of(shop)
    _, order_id, _, number = pending_order(shop)
    caplog.set_level(logging.DEBUG)

    assert admin_list(shop, admin, ("q", number)).status_code == 200
    assert admin_get(shop, admin, order_id).status_code == 200
    assert admin_list(shop, admin, ("q", "Ana Torres")).status_code == 200  # el nombre llega por q
    assert admin_get(shop, admin, "00000000-0000-0000-0000-000000000000").status_code == 404
    assert admin_list(shop, shop.user()).status_code == 403
    assert admin_list(shop, admin, ("page", "0")).status_code == 422

    for personal in PERSONAL_DATA:
        assert personal not in app_logs(caplog), personal


def test_logs_and_audit_of_an_expiry_by_the_admin_read_have_no_personal_data(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    admin = admin_of(shop)
    _, order_id, _, number = pending_order(shop)
    make_overdue(shop.session, order_id)
    caplog.set_level(logging.DEBUG)

    admin_page(shop, admin, ("q", number))

    dump = repr(audit_rows(shop.session, entity_id=order_id))
    assert "orders.status_changed" in dump
    for personal in PERSONAL_DATA:
        assert personal not in dump, personal
        assert personal not in app_logs(caplog), personal


def test_the_search_term_is_not_written_to_the_audit_either(shop: OrderShop) -> None:
    admin = admin_of(shop)
    _, order_id, _, _ = pending_order(shop)
    before = shop.session.execute(text("SELECT count(*) FROM app.audit_log")).scalar_one()

    admin_page(shop, admin, ("q", "Ana Torres"))
    admin_order(shop, admin, order_id)

    after = shop.session.execute(text("SELECT count(*) FROM app.audit_log")).scalar_one()
    assert after == before  # leer no audita (R11 audita cambios), y menos con datos personales
