"""Caducidad por lectura con la app real y PostgreSQL (T-075; CA-ORDERS-13, 20, 21 y 22; SPEC §3
UC-05, §4 R6, R7 y R11; D-017). Los pedidos nacen de `POST /orders` (reservas y carrito reales) y
se envejecen por SQL (`expires_at` en el pasado): el reloj de la BD es el de la transacción de la
prueba. Se comprueba lo que la lectura escribe: estado, historial `system`, auditoría sin actor,
reservas `released`; que repetir no duplica nada; que un pagado nunca vence y que solo caducan los
pedidos leídos. Datos ficticios."""

from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_db_helpers import real_line
from tests.orders.orders_http_helpers import (
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
    ALL_STATUSES,
    db_status,
    get_order,
    history_count,
    ids_of,
    list_orders,
    make_order,
    make_overdue,
    read_order,
    read_page,
    set_status,
    status_changed_audit,
    statuses_of,
)

pytestmark = pytest.mark.integration

shop = helpers.shop


def pending_order(
    shop: OrderShop, user: UUID | None = None, **product: Any
) -> tuple[UUID, str, UUID]:
    """(cliente, id del pedido, producto): pedido pendiente real con su reserva."""
    if user is None:
        user, product_id = quick(shop, **product)
    else:
        product_id = add_listed(shop.session, on_hand=product.pop("on_hand", 5), **product)
        stock_in_cart(shop, user, (product_id, 1))
    response = place(shop, user)
    assert response.status_code == 201, response.text
    return user, response.json()["id"], product_id


def history_rows(shop: OrderShop, order_id: object) -> list[tuple[Any, ...]]:
    rows = shop.session.execute(
        text(
            "SELECT from_status, to_status, actor_kind, actor_id, note FROM"
            " app.order_status_history WHERE order_id = :id ORDER BY id"
        ),
        {"id": order_id},
    )
    return [tuple(r) for r in rows]


def reservation_statuses(shop: OrderShop, order_id: object) -> list[str]:
    return [r["status"] for r in reservations(shop.session, order_id)]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-13: el vencido pasa a expirado al leerlo
def test_reading_an_overdue_order_shows_it_expired(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    body = read_order(shop, user, order_id)

    assert body["status"] == "expirado"
    assert body["can_cancel"] is False
    assert body["expires_at"] is None and body["expires_in_seconds"] is None
    assert db_status(shop.session, order_id) == "expirado"


def test_the_expiry_adds_one_system_history_entry_without_actor(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    body = read_order(shop, user, order_id)

    assert [(h["from_status"], h["status"], h["actor"]) for h in body["history"]] == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "expirado", "system"),
    ]
    assert history_rows(shop, order_id) == [
        (None, "pendiente_pago", "customer", user, None),
        ("pendiente_pago", "expirado", "system", None, None),
    ]


def test_the_expiry_releases_the_reservation_and_the_stock_is_available_again(
    shop: OrderShop,
) -> None:
    user, order_id, product = pending_order(shop)
    assert (
        reservation_statuses(shop, order_id) == ["active"] and available(shop.session, product) == 4
    )
    make_overdue(shop.session, order_id)

    read_order(shop, user, order_id)

    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5 and on_hand(shop.session, product) == 5


def test_a_multi_line_order_releases_every_reservation(shop: OrderShop) -> None:
    user = shop.user()
    a, b = add_listed(shop.session, on_hand=3), add_listed(shop.session, on_hand=4)
    stock_in_cart(shop, user, (a, 2), (b, 1))
    order_id = place(shop, user).json()["id"]
    assert sorted(reservation_statuses(shop, order_id)) == ["active", "active"]
    make_overdue(shop.session, order_id)

    read_order(shop, user, order_id)

    assert reservation_statuses(shop, order_id) == ["released", "released"]
    assert (available(shop.session, a), available(shop.session, b)) == (3, 4)


def test_the_expiry_is_audited_without_actor_and_without_personal_data(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    read_order(shop, user, order_id)

    [entry] = status_changed_audit(shop.session, order_id)
    assert entry["actor_id"] is None and entry["actor_role"] is None  # sistema (AUDIT-R5)
    assert entry["entity_type"] == "order"
    assert entry["before"] == {"status": "pendiente_pago"}
    assert entry["after"] == {"status": "expirado"}
    dump = repr(entry)
    for personal in ("Ana", "Torres", "987654321", "Larco", "Miraflores", str(user)):
        assert personal not in dump, personal


def test_reading_again_does_not_duplicate_history_audit_or_release(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    make_overdue(shop.session, order_id)
    first = read_order(shop, user, order_id)

    again = [read_order(shop, user, order_id) for _ in range(3)]
    read_page(shop, user)

    assert all(body == first for body in again)
    assert len(history_rows(shop, order_id)) == 2 and history_count(shop.session, order_id) == 2
    assert len(status_changed_audit(shop.session, order_id)) == 1
    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5


def test_the_list_materializes_the_expiry_too(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    make_overdue(shop.session, order_id)

    page = read_page(shop, user)

    assert statuses_of(page) == ["expirado"] and ids_of(page) == [order_id]
    assert page["items"][0]["expires_at"] is None
    assert reservation_statuses(shop, order_id) == ["released"]
    assert len(status_changed_audit(shop.session, order_id)) == 1
    assert len(history_rows(shop, order_id)) == 2
    assert available(shop.session, product) == 5


def test_the_status_filter_sees_the_real_state_after_the_expiry(shop: OrderShop) -> None:
    user = shop.user()
    _, overdue_id, _ = pending_order(shop, user)
    _, fresh_id, _ = pending_order(shop, user)
    make_overdue(shop.session, overdue_id)

    expired = read_page(shop, user, ("status", "expirado"))
    pending = read_page(shop, user, ("status", "pendiente_pago"))

    assert ids_of(expired) == [overdue_id] and ids_of(pending) == [fresh_id]
    assert expired["total"] == pending["total"] == 1


def test_the_list_and_the_detail_agree_on_an_expired_order(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    listed = read_page(shop, user)["items"][0]
    detail = read_order(shop, user, order_id)

    for key in ("id", "number", "status", "total", "expires_at"):
        assert listed[key] == detail[key], key


# --- bordes del reloj ------------------------------------------------------------------------
def test_an_order_whose_expires_at_is_exactly_now_is_overdue(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id, seconds_over=0)

    assert read_order(shop, user, order_id)["status"] == "expirado"


def test_an_order_one_second_before_its_expiry_is_still_pending_and_untouched(
    shop: OrderShop,
) -> None:
    user, order_id, product = pending_order(shop)
    make_overdue(shop.session, order_id, seconds_over=-1)

    body = read_order(shop, user, order_id)
    page = read_page(shop, user)

    assert body["status"] == "pendiente_pago" and body["can_cancel"] is True
    assert 0 <= body["expires_in_seconds"] <= 1
    assert statuses_of(page) == ["pendiente_pago"]
    assert reservation_statuses(shop, order_id) == ["active"]
    assert len(history_rows(shop, order_id)) == 1
    assert status_changed_audit(shop.session, order_id) == []
    assert available(shop.session, product) == 4


def test_a_pending_order_inside_its_window_is_not_expired_by_any_read(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    for _ in range(2):
        assert read_order(shop, user, order_id)["status"] == "pendiente_pago"
        assert statuses_of(read_page(shop, user)) == ["pendiente_pago"]

    assert db_status(shop.session, order_id) == "pendiente_pago"
    assert len(history_rows(shop, order_id)) == 1


# --- la disponibilidad ya es correcta antes de leer (R7, atajo) --------------------------------
def test_availability_is_already_right_before_anyone_reads_the_order(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    shop.session.execute(
        text("UPDATE app.stock_reservations SET expires_at = now() - interval '1 minute'")
    )
    make_overdue(shop.session, order_id)

    assert available(shop.session, product) == 5  # sin leer: la vista ignora la reserva vencida
    assert reservation_statuses(shop, order_id) == ["active"]  # aún sin cerrar
    assert db_status(shop.session, order_id) == "pendiente_pago"

    read_order(shop, user, order_id)

    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5


# --- un pagado nunca vence -------------------------------------------------------------------
def test_a_paid_order_with_a_past_expires_at_never_expires(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    set_status(shop.session, order_id, "pagado")
    make_overdue(shop.session, order_id)

    body = read_order(shop, user, order_id)
    page = read_page(shop, user)

    assert body["status"] == "pagado" and statuses_of(page) == ["pagado"]
    assert body["can_cancel"] is False and body["expires_in_seconds"] is None
    assert reservation_statuses(shop, order_id) == ["active"]  # no es el vencimiento quien la toca
    assert status_changed_audit(shop.session, order_id) == []
    assert history_count(shop.session, order_id) == 1
    assert available(shop.session, product) == 4


@pytest.mark.parametrize("status", [s for s in ALL_STATUSES if s != "pendiente_pago"])
def test_no_state_other_than_pending_is_changed_by_a_read(shop: OrderShop, status: str) -> None:
    user = shop.user()
    order = make_order(shop.session, user, status=status)
    make_overdue(shop.session, order.id)
    before = history_count(shop.session, order.id)

    body = read_order(shop, user, order.id)
    read_page(shop, user)

    assert body["status"] == status and db_status(shop.session, order.id) == status
    assert history_count(shop.session, order.id) == before
    assert status_changed_audit(shop.session, order.id) == []


# --- solo caducan los pedidos leídos -----------------------------------------------------------
def test_reading_one_order_expires_only_that_one(shop: OrderShop) -> None:
    user = shop.user()
    _, first, _ = pending_order(shop, user)
    _, second, _ = pending_order(shop, user)
    make_overdue(shop.session, first)
    make_overdue(shop.session, second)

    assert read_order(shop, user, first)["status"] == "expirado"

    assert db_status(shop.session, second) == "pendiente_pago"  # mío y vencido, pero no lo leí
    assert reservation_statuses(shop, second) == ["active"]
    assert len(history_rows(shop, second)) == 1
    assert status_changed_audit(shop.session, second) == []
    # su propia lectura sí lo materializa
    assert read_order(shop, user, second)["status"] == "expirado"


def test_the_list_expires_all_of_my_overdue_orders_and_not_the_ones_of_others(
    shop: OrderShop,
) -> None:
    me, other = shop.user(), shop.user()
    _, mine_a, _ = pending_order(shop, me)
    _, mine_b, _ = pending_order(shop, me)
    _, theirs, _ = pending_order(shop, other)
    for order_id in (mine_a, mine_b, theirs):
        make_overdue(shop.session, order_id)

    page = read_page(shop, me)

    assert statuses_of(page) == ["expirado", "expirado"]
    assert db_status(shop.session, theirs) == "pendiente_pago"
    assert reservation_statuses(shop, theirs) == ["active"]
    assert len(history_rows(shop, theirs)) == 1
    assert status_changed_audit(shop.session, theirs) == []
    assert len(status_changed_audit(shop.session, mine_a)) == 1
    assert len(status_changed_audit(shop.session, mine_b)) == 1


def test_a_foreign_probe_is_404_and_does_not_expire_the_owners_order(shop: OrderShop) -> None:
    owner, intruder = shop.user(), shop.user()
    _, order_id, _ = pending_order(shop, owner)
    make_overdue(shop.session, order_id)

    assert get_order(shop, intruder, order_id).status_code == 404

    assert db_status(shop.session, order_id) == "pendiente_pago"
    assert reservation_statuses(shop, order_id) == ["active"]
    assert status_changed_audit(shop.session, order_id) == []


def test_each_customer_reads_the_expiry_of_their_own_order(shop: OrderShop) -> None:
    ana, luis = shop.user(), shop.user()
    _, anas, _ = pending_order(shop, ana)
    _, luiss, _ = pending_order(shop, luis)
    make_overdue(shop.session, anas)
    make_overdue(shop.session, luiss)

    assert read_order(shop, ana, anas)["status"] == "expirado"
    assert db_status(shop.session, luiss) == "pendiente_pago"
    assert get_order(shop, ana, luiss).status_code == 404
    assert read_order(shop, luis, luiss)["status"] == "expirado"


# --- Bajo pedido y mixtos ----------------------------------------------------------------------
def test_a_made_to_order_only_order_expires_without_reservations(shop: OrderShop) -> None:
    user, product = quick(shop, policy="made_to_order", on_hand=None)
    order_id = place(shop, user).json()["id"]
    assert reservations(shop.session, order_id) == []
    make_overdue(shop.session, order_id)

    body = read_order(shop, user, order_id)

    assert body["status"] == "expirado" and reservations(shop.session, order_id) == []
    assert len(status_changed_audit(shop.session, order_id)) == 1


def test_a_mixed_order_releases_only_what_it_reserved(shop: OrderShop) -> None:
    user = shop.user()
    stocked = add_listed(shop.session, on_hand=3)
    custom = add_listed(shop.session, policy="made_to_order")
    stock_in_cart(shop, user, (stocked, 1), (custom, 1))
    order_id = place(shop, user).json()["id"]
    assert len(reservations(shop.session, order_id)) == 1
    make_overdue(shop.session, order_id)

    assert read_order(shop, user, order_id)["status"] == "expirado"

    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, stocked) == 3


# --- vuelve a poder comprar y no se cuenta contra el tope --------------------------------------
def test_after_the_expiry_the_stock_can_be_bought_again(shop: OrderShop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=1)
    stock_in_cart(shop, user, (product, 1))
    order_id = place(shop, user).json()["id"]
    buyer = shop.user()
    stock_in_cart(shop, buyer, (product, 1))
    assert place(shop, buyer).status_code == 409  # la última unidad está reservada
    make_overdue(shop.session, order_id)

    read_order(shop, user, order_id)

    assert place(shop, buyer).status_code == 201  # su carrito sigue igual tras el 409


def test_the_events_of_the_audit_log_count_one_per_expired_order(shop: OrderShop) -> None:
    user = shop.user()
    ids = [pending_order(shop, user)[1] for _ in range(3)]
    for order_id in ids:
        make_overdue(shop.session, order_id)

    read_page(shop, user)
    read_page(shop, user)

    entries = audit_rows(shop.session, action="orders.status_changed")
    assert sorted(e["entity_id"] for e in entries if e["entity_id"] in ids) == sorted(ids)
    assert all(e["actor_id"] is None for e in entries if e["entity_id"] in ids)


# --- el límite de 200 por lectura (R7, atajo) --------------------------------------------------
def test_with_more_than_200_overdue_orders_a_read_expires_200_and_the_next_finishes(
    shop: OrderShop,
) -> None:
    user = shop.user()
    line = real_line(shop.session)
    ids = [
        make_order(shop.session, user, status="pendiente_pago", minutes_ago=5, lines=[line]).id
        for _ in range(205)
    ]
    shop.session.execute(
        text(
            "UPDATE app.orders SET created_at = now() - interval '2 hours',"
            " expires_at = now() - interval '1 minute' WHERE user_id = :u"
        ),
        {"u": user},
    )

    first = list_orders(shop, user, ("page_size", 50))
    assert first.status_code == 200, first.text
    expired_after_first = shop.session.scalar(
        text("SELECT count(*) FROM app.orders WHERE user_id = :u AND status = 'expirado'"),
        {"u": user},
    )
    second = read_page(shop, user, ("page_size", 50))
    expired_after_second = shop.session.scalar(
        text("SELECT count(*) FROM app.orders WHERE user_id = :u AND status = 'expirado'"),
        {"u": user},
    )

    assert first.json()["total"] == second["total"] == 205
    assert expired_after_first == 200  # atajo documentado: el resto, en la siguiente lectura
    assert expired_after_second == 205
    assert len(ids) == 205
    assert (
        shop.session.scalar(
            text(
                "SELECT count(*) FROM app.order_status_history h JOIN app.orders o"
                " ON o.id = h.order_id WHERE o.user_id = :u AND h.to_status = 'expirado'"
            ),
            {"u": user},
        )
        == 205  # un historial por pedido, ninguno repetido
    )
