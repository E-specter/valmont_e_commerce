"""`POST /api/v1/orders/{order_id}/cancel` con la app real y PostgreSQL (T-076; CA-ORDERS-12, 20, 21
y 22; SPEC §3 UC-04, §4 R4, R7, R9, R10, R11, R12, §7 "Cancelar"). Los pedidos nacen de
`POST /orders` (reservas y carrito reales). Se comprueba la respuesta y lo que queda en la BD:
estado, historial, auditoría, reservas y disponibilidad; que lo rechazado no deja ningún efecto;
que repetir no duplica nada; que un pedido ajeno y uno inexistente son la misma respuesta; que
ningún `user_id` de la entrada cuenta; y que el stock liberado se puede volver a comprar. Cada
solicitud corre en un SAVEPOINT que el error deshace, como la transacción real. Datos ficticios."""

import logging
from typing import Any
from uuid import UUID, uuid4

import pytest

from tests.cart.cart_helpers import add_listed
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_create_helpers import DETAIL_KEYS
from tests.orders.orders_http_helpers import (
    PERSONAL,
    PICKUP,
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
    PAID_STATUSES,
    db_status,
    get_order,
    headers,
    history_count,
    make_overdue,
    read_order,
    read_page,
    set_status,
    status_changed_audit,
)
from tests.orders.test_create_order_http import error_of
from tests.orders.test_my_orders_expiry import history_rows, pending_order, reservation_statuses

pytestmark = pytest.mark.integration

shop = helpers.shop

NOT_CANCELLABLE = (*PAID_STATUSES, "expirado")
CHANGING = {"status", "can_cancel", "expires_at", "expires_in_seconds", "history"}


def cancel(shop: OrderShop, user: UUID | None, order_id: object, **request: Any) -> Any:
    extra = request.pop("headers", {})
    return shop.client.post(
        f"{helpers.PATH}/{order_id}/cancel", headers={**headers(user), **extra}, **request
    )


def cancelled(shop: OrderShop, user: UUID, order_id: object) -> dict[str, Any]:
    response = cancel(shop, user, order_id)
    assert response.status_code == 200, response.text
    return response.json()


def buy(shop: OrderShop, user: UUID, product: UUID, quantity: int = 1, delivery: Any = None) -> Any:
    """Añade el producto al carrito del cliente y crea el pedido (201 esperado)."""
    stock_in_cart(shop, user, (product, quantity))
    response = place(shop, user, delivery=delivery)
    assert response.status_code == 201, response.text
    return response.json()


def untouched(body: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in body.items() if k not in CHANGING}


def reservation_totals(shop: OrderShop, order_id: object) -> list[tuple[str, int]]:
    return [(r["status"], r["quantity"]) for r in reservations(shop.session, order_id)]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-12: cancelar un pendiente_pago propio y vigente
def test_cancelling_an_own_pending_order_is_200_and_cancelled(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    response = cancel(shop, user, order_id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == DETAIL_KEYS  # OrderDetailOut
    assert body["id"] == order_id and body["status"] == "cancelado"
    assert body["can_cancel"] is False
    assert body["expires_at"] is None and body["expires_in_seconds"] is None
    assert body["paid_at"] is None and body["refund"] is None  # sin reembolso
    assert response.headers["content-type"].startswith("application/json")


def test_the_cancelled_order_in_the_database_has_no_payment_nor_refund(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    cancelled(shop, user, order_id)

    row = helpers.order_row(shop.session, order_id)
    assert row["status"] == "cancelado"
    assert row["paid_at"] is None
    assert row["refunded_amount"] is None and row["refunded_at"] is None


def test_the_cancellation_keeps_lines_totals_and_delivery_as_they_were(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    before = read_order(shop, user, order_id)

    after = cancelled(shop, user, order_id)

    assert untouched(after) == untouched(before)  # instantánea intacta (RN-04)


def test_the_response_of_the_cancellation_is_what_the_detail_shows_afterwards(
    shop: OrderShop,
) -> None:
    user, order_id, _ = pending_order(shop)

    body = cancelled(shop, user, order_id)

    assert read_order(shop, user, order_id) == body


def test_the_cancellation_is_one_customer_history_row_with_the_actor(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    body = cancelled(shop, user, order_id)

    assert [(h["from_status"], h["status"], h["actor"]) for h in body["history"]] == [
        (None, "pendiente_pago", "customer"),
        ("pendiente_pago", "cancelado", "customer"),
    ]
    assert all(set(h) == {"from_status", "status", "at", "actor"} for h in body["history"])
    assert history_rows(shop, order_id) == [  # CA-ORDERS-20: exactamente una fila nueva
        (None, "pendiente_pago", "customer", user, None),
        ("pendiente_pago", "cancelado", "customer", user, None),
    ]


def test_the_reservation_is_released_and_the_stock_is_available_again(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    assert reservation_statuses(shop, order_id) == ["active"]
    assert available(shop.session, product) == 4

    cancelled(shop, user, order_id)

    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5
    assert on_hand(shop.session, product) == 5  # liberar no toca el stock físico


def test_only_the_cancelled_order_is_released_when_the_customer_has_two(shop: OrderShop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    first, second = buy(shop, user, product)["id"], buy(shop, user, product)["id"]
    assert available(shop.session, product) == 3

    cancelled(shop, user, first)

    assert reservation_statuses(shop, first) == ["released"]
    assert reservation_statuses(shop, second) == ["active"]
    assert available(shop.session, product) == 4
    assert read_order(shop, user, second)["status"] == "pendiente_pago"


def test_the_cancellation_touches_nothing_of_another_customer(shop: OrderShop) -> None:
    mine, my_order, _ = pending_order(shop)
    other, theirs, other_product = pending_order(shop)
    before = helpers.effects(shop.session, other, other_product)

    cancelled(shop, mine, my_order)

    assert helpers.effects(shop.session, other, other_product) == before
    assert db_status(shop.session, theirs) == "pendiente_pago"
    assert reservation_statuses(shop, theirs) == ["active"]


def test_a_cancelled_order_is_listed_as_cancelled_and_not_as_pending(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    cancelled(shop, user, order_id)

    only_cancelled = read_page(shop, user, ("status", "cancelado"))
    only_pending = read_page(shop, user, ("status", "pendiente_pago"))
    assert [i["id"] for i in only_cancelled["items"]] == [order_id]
    assert only_pending["items"] == []


@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
def test_both_delivery_methods_can_be_cancelled(shop: OrderShop, pickup: bool) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=3)
    order = buy(shop, user, product, delivery=PICKUP if pickup else None)

    body = cancelled(shop, user, order["id"])

    assert body["status"] == "cancelado"
    assert body["delivery"]["delivery_method"] == ("pickup" if pickup else "shipping")
    assert available(shop.session, product) == 3


def test_the_cancellation_is_not_counted_as_pending_for_the_limit_of_three(
    shop: OrderShop,
) -> None:
    user = shop.user()
    orders = [buy(shop, user, add_listed(shop.session, on_hand=5))["id"] for _ in range(3)]
    stock_in_cart(shop, user, (add_listed(shop.session, on_hand=5), 1))
    error_of(place(shop, user), 409, "too_many_pending_orders")  # R9

    cancelled(shop, user, orders[0])

    assert place(shop, user).status_code == 201  # uno cancelado no cuenta


# --------------------------------------------------------------------------------------------
# El stock liberado se puede volver a comprar
def test_the_last_unit_of_a_cancelled_order_can_be_bought_by_someone_else(
    shop: OrderShop,
) -> None:
    ana, luis = shop.user(), shop.user()
    product = add_listed(shop.session, on_hand=1)
    first = buy(shop, ana, product)
    stock_in_cart(shop, luis, (product, 1))
    blocked = place(shop, luis)
    assert blocked.status_code == 409, blocked.text  # nada disponible mientras Ana lo reserva
    assert available(shop.session, product) == 0

    cancelled(shop, ana, first["id"])
    assert available(shop.session, product) == 1
    bought = place(shop, luis)

    assert bought.status_code == 201, bought.text
    assert available(shop.session, product) == 0 and on_hand(shop.session, product) == 1
    assert reservation_statuses(shop, bought.json()["id"]) == ["active"]
    assert reservation_statuses(shop, first["id"]) == ["released"]  # la de Ana sigue liberada


def test_the_same_customer_can_buy_the_released_stock_again(shop: OrderShop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=1)
    first = buy(shop, user, product)

    cancelled(shop, user, first["id"])
    second = buy(shop, user, product)

    assert second["id"] != first["id"] and second["status"] == "pendiente_pago"
    assert available(shop.session, product) == 0


# --------------------------------------------------------------------------------------------
# Bajo pedido y mixtos (RF04.07, R5)
def test_a_made_to_order_only_order_is_cancelled_without_reservations(shop: OrderShop) -> None:
    user, product = quick(shop, policy="made_to_order", on_hand=None)
    order = place(shop, user).json()
    assert reservations(shop.session, order["id"]) == []

    body = cancelled(shop, user, order["id"])

    assert body["status"] == "cancelado"
    assert [(ln["fulfillment"], ln["lead_time_days"]) for ln in body["lines"]] == [
        ("made_to_order", 21)
    ]
    assert body["estimated_delivery_on"] == order["estimated_delivery_on"]  # instantánea
    assert reservations(shop.session, order["id"]) == []


def test_a_mixed_order_releases_only_the_stock_line(shop: OrderShop) -> None:
    user = shop.user()
    stocked = add_listed(shop.session, on_hand=4)
    on_request = add_listed(shop.session, policy="made_to_order", on_hand=None)
    stock_in_cart(shop, user, (stocked, 2), (on_request, 1))
    order = place(shop, user).json()
    assert reservation_totals(shop, order["id"]) == [("active", 2)]
    assert available(shop.session, stocked) == 2

    body = cancelled(shop, user, order["id"])

    assert body["status"] == "cancelado"
    assert {ln["fulfillment"] for ln in body["lines"]} == {"stock", "made_to_order"}
    assert reservation_totals(shop, order["id"]) == [("released", 2)]
    assert available(shop.session, stocked) == 4


# --------------------------------------------------------------------------------------------
# CA-ORDERS-12 / 20 / 21: repetir
def test_cancelling_twice_is_200_both_times_with_the_same_body(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    first = cancelled(shop, user, order_id)
    second = cancelled(shop, user, order_id)

    assert second == first
    assert second["status"] == "cancelado"


def test_cancelling_twice_adds_no_history_audit_or_release(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    cancelled(shop, user, order_id)
    before = helpers.effects(shop.session, user, product)
    audit_before = audit_rows(shop.session, entity_id=order_id)
    released_before = reservations(shop.session, order_id)

    for _ in range(3):
        assert cancel(shop, user, order_id).status_code == 200

    assert helpers.effects(shop.session, user, product) == before
    assert history_count(shop.session, order_id) == 2  # creación + una sola cancelación
    assert len(status_changed_audit(shop.session, order_id)) == 1
    assert audit_rows(shop.session, entity_id=order_id) == audit_before
    assert reservations(shop.session, order_id) == released_before
    assert available(shop.session, product) == 5


# --------------------------------------------------------------------------------------------
# CA-ORDERS-21: auditoría con actor, sin datos personales
def test_the_audit_records_the_customer_the_entity_and_before_and_after(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    cancelled(shop, user, order_id)

    [entry] = status_changed_audit(shop.session, order_id)
    assert entry["entity_type"] == "order"
    assert entry["actor_id"] == user and entry["actor_role"] == "customer"
    assert entry["before"] == {"status": "pendiente_pago"}
    assert entry["after"] == {"status": "cancelado"}


def test_the_audit_and_the_logs_of_a_cancellation_have_no_personal_data(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    user, order_id, _ = pending_order(shop)
    caplog.set_level(logging.DEBUG)

    cancelled(shop, user, order_id)

    dump = repr(audit_rows(shop.session, entity_id=order_id))
    for personal in (*PERSONAL, "Torres"):
        assert personal not in dump, personal
        assert personal not in caplog.text, personal


def test_the_creation_audit_is_still_the_only_other_entry_of_the_order(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    cancelled(shop, user, order_id)

    assert [a["action"] for a in audit_rows(shop.session, entity_id=order_id)] == [
        "orders.created",
        "orders.status_changed",
    ]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-12: cualquier otro estado → 409 not_cancellable, sin cambios
@pytest.mark.parametrize("status", NOT_CANCELLABLE)
def test_an_order_in_any_other_state_is_409_not_cancellable_with_its_status(
    shop: OrderShop, status: str
) -> None:
    user, order_id, _ = pending_order(shop)
    set_status(shop.session, order_id, status)

    response = cancel(shop, user, order_id)

    details = error_of(response, 409, "not_cancellable")
    assert details == {"status": status}
    message = response.json()["error"]["message"]
    assert isinstance(message, str) and message
    assert str(order_id) not in response.text and "VAL-" not in response.text


@pytest.mark.parametrize("status", NOT_CANCELLABLE)
def test_a_rejected_cancellation_changes_nothing(shop: OrderShop, status: str) -> None:
    user, order_id, product = pending_order(shop)
    set_status(shop.session, order_id, status)
    before = helpers.effects(shop.session, user, product)
    row_before = helpers.order_row(shop.session, order_id)
    reservations_before = reservations(shop.session, order_id)
    audit_before = audit_rows(shop.session, entity_id=order_id)

    assert cancel(shop, user, order_id).status_code == 409

    assert helpers.effects(shop.session, user, product) == before
    assert helpers.order_row(shop.session, order_id) == row_before
    assert db_status(shop.session, order_id) == status
    assert reservations(shop.session, order_id) == reservations_before  # nada liberado
    assert audit_rows(shop.session, entity_id=order_id) == audit_before
    assert history_count(shop.session, order_id) == 1


def test_a_paid_order_keeps_its_stock_reserved_after_the_rejection(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    set_status(shop.session, order_id, "pagado")

    cancel(shop, user, order_id)

    assert reservation_statuses(shop, order_id) == ["active"]
    assert available(shop.session, product) == 4 and on_hand(shop.session, product) == 5


# --------------------------------------------------------------------------------------------
# R7: un vencido no se cancela; la caducidad se materializa en la siguiente lectura
def test_an_overdue_order_is_409_not_cancellable_with_status_expired(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    details = error_of(cancel(shop, user, order_id), 409, "not_cancellable")

    assert details == {"status": "expirado"}


def test_an_order_overdue_by_exactly_now_is_also_409(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id, seconds_over=0)  # expires_at == now: ya vencido

    assert error_of(cancel(shop, user, order_id), 409, "not_cancellable") == {"status": "expirado"}


def test_an_order_with_seconds_left_is_still_cancellable(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id, seconds_over=-30)  # le quedan 30 s

    assert cancelled(shop, user, order_id)["status"] == "cancelado"


def test_the_409_of_an_overdue_order_rolls_back_so_nothing_is_stored_by_that_call(
    shop: OrderShop,
) -> None:
    user, order_id, product = pending_order(shop)
    make_overdue(shop.session, order_id)
    audit_before = audit_rows(shop.session, entity_id=order_id)

    assert cancel(shop, user, order_id).status_code == 409

    # El 409 deshace la transacción: ni cancelación ni caducidad quedan guardadas (decisión D del
    # Leader; R7 perezosa: la caducidad se materializa en la siguiente lectura).
    assert db_status(shop.session, order_id) == "pendiente_pago"
    assert history_count(shop.session, order_id) == 1
    assert reservation_statuses(shop, order_id) == ["active"]
    assert audit_rows(shop.session, entity_id=order_id) == audit_before
    assert available(shop.session, product) == 4


def test_a_read_after_the_409_leaves_the_order_expired_with_the_stock_released(
    shop: OrderShop,
) -> None:
    user, order_id, product = pending_order(shop)
    make_overdue(shop.session, order_id)
    assert cancel(shop, user, order_id).status_code == 409

    body = read_order(shop, user, order_id)

    assert body["status"] == "expirado"
    assert [(h["status"], h["actor"]) for h in body["history"]] == [
        ("pendiente_pago", "customer"),
        ("expirado", "system"),
    ]
    assert history_rows(shop, order_id) == [  # una sola fila `system`, y ninguna de cancelación
        (None, "pendiente_pago", "customer", user, None),
        ("pendiente_pago", "expirado", "system", None, None),
    ]
    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5
    [entry] = status_changed_audit(shop.session, order_id)
    assert entry["actor_id"] is None and entry["after"] == {"status": "expirado"}


def test_once_expired_the_cancellation_stays_409_and_adds_nothing(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    make_overdue(shop.session, order_id)
    read_order(shop, user, order_id)  # materializa la caducidad
    before = helpers.effects(shop.session, user, product)

    for _ in range(2):
        assert error_of(cancel(shop, user, order_id), 409, "not_cancellable") == {
            "status": "expirado"
        }

    assert helpers.effects(shop.session, user, product) == before
    assert history_count(shop.session, order_id) == 2
    assert len(status_changed_audit(shop.session, order_id)) == 1


def test_an_overdue_order_is_never_marked_cancelled_by_any_path(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)
    make_overdue(shop.session, order_id)

    cancel(shop, user, order_id)
    read_order(shop, user, order_id)
    cancel(shop, user, order_id)

    assert db_status(shop.session, order_id) == "expirado"
    assert all(row[1] != "cancelado" for row in history_rows(shop, order_id))


# --------------------------------------------------------------------------------------------
# CA-ORDERS-22 / R12: ajeno o inexistente, el mismo 404 sin efectos
def test_a_foreign_order_and_a_missing_one_are_the_very_same_404(shop: OrderShop) -> None:
    me = shop.user()
    _, theirs, _ = pending_order(shop)

    foreign = cancel(shop, me, theirs)
    missing = cancel(shop, me, uuid4())

    assert foreign.status_code == missing.status_code == 404
    error_of(foreign, 404, "not_found")
    assert foreign.json() == missing.json()
    assert foreign.headers["content-type"] == missing.headers["content-type"]
    assert len(foreign.content) == len(missing.content)
    assert str(theirs) not in foreign.text


def test_the_404_never_reveals_the_foreign_data(shop: OrderShop) -> None:
    me = shop.user()
    _, theirs, _ = pending_order(shop)

    text_of_response = cancel(shop, me, theirs).text

    for private in (*PERSONAL, "VAL-", "pendiente_pago", "cancelado", "Torres"):
        assert private not in text_of_response, private


def test_a_foreign_cancellation_attempt_changes_nothing(shop: OrderShop) -> None:
    me = shop.user()
    other, theirs, product = pending_order(shop)
    before = helpers.effects(shop.session, other, product)
    row_before = helpers.order_row(shop.session, theirs)
    audit_before = audit_rows(shop.session, entity_id=theirs)
    mine_before = helpers.effects(shop.session, me)

    assert cancel(shop, me, theirs).status_code == 404

    assert helpers.effects(shop.session, other, product) == before
    assert helpers.order_row(shop.session, theirs) == row_before
    assert audit_rows(shop.session, entity_id=theirs) == audit_before
    assert reservation_statuses(shop, theirs) == ["active"]
    assert helpers.effects(shop.session, me) == mine_before  # tampoco hay efectos propios
    assert read_order(shop, other, theirs)["status"] == "pendiente_pago"  # sigue vigente


def test_a_foreign_overdue_order_is_not_expired_by_someone_elses_attempt(shop: OrderShop) -> None:
    me = shop.user()
    other, theirs, _ = pending_order(shop)
    make_overdue(shop.session, theirs)

    assert cancel(shop, me, theirs).status_code == 404

    assert db_status(shop.session, theirs) == "pendiente_pago"  # no materializó nada ajeno
    assert history_count(shop.session, theirs) == 1
    assert reservation_statuses(shop, theirs) == ["active"]
    assert audit_rows(shop.session, entity_id=theirs, action="orders.status_changed") == []


@pytest.mark.parametrize("status", ("pendiente_pago", *NOT_CANCELLABLE, "cancelado"))
def test_a_foreign_order_is_404_in_every_state_never_409(shop: OrderShop, status: str) -> None:
    me = shop.user()
    other, theirs, _ = pending_order(shop)
    set_status(shop.session, theirs, status)  # `cancelado` ajeno tampoco responde 200

    response = cancel(shop, me, theirs)

    error_of(response, 404, "not_found")
    assert db_status(shop.session, theirs) == status


def test_both_customers_cancel_their_own_and_get_404_on_the_others(shop: OrderShop) -> None:
    ana, anas, _ = pending_order(shop)
    luis, luiss, _ = pending_order(shop)

    assert cancel(shop, ana, luiss).status_code == 404
    assert cancel(shop, luis, anas).status_code == 404
    assert cancel(shop, ana, anas).status_code == 200
    assert cancel(shop, luis, luiss).status_code == 200


def test_the_owner_cannot_be_overridden_with_a_user_id_in_the_body(shop: OrderShop) -> None:
    attacker = shop.user()
    victim, theirs, _ = pending_order(shop)

    for response in (
        cancel(shop, attacker, theirs, json={"user_id": str(victim)}),
        cancel(shop, attacker, theirs, json={"user_id": str(attacker), "id": str(theirs)}),
        cancel(shop, attacker, theirs, params={"user_id": str(victim)}),
        cancel(shop, attacker, theirs, headers={"X-User-Id": str(victim)}),
    ):
        assert response.status_code == 404, response.text  # no revela ni obedece

    assert db_status(shop.session, theirs) == "pendiente_pago"
    assert reservation_statuses(shop, theirs) == ["active"]


def test_a_user_id_in_the_input_of_the_owner_is_ignored(shop: OrderShop) -> None:
    mine, my_order, _ = pending_order(shop)
    other, theirs, _ = pending_order(shop)

    response = cancel(shop, mine, my_order, json={"user_id": str(other)})

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelado"
    assert db_status(shop.session, my_order) == "cancelado"
    assert db_status(shop.session, theirs) == "pendiente_pago"  # el id recibido no cuenta
    [entry] = status_changed_audit(shop.session, my_order)
    assert entry["actor_id"] == mine  # el actor sale del token


def test_the_owner_who_names_another_order_in_the_body_still_cancels_only_the_path_one(
    shop: OrderShop,
) -> None:
    mine, my_order, _ = pending_order(shop)
    _, theirs, _ = pending_order(shop)

    cancel(shop, mine, my_order, json={"order_id": str(theirs)})

    assert db_status(shop.session, my_order) == "cancelado"
    assert db_status(shop.session, theirs) == "pendiente_pago"


# --------------------------------------------------------------------------------------------
# 401, 422 y métodos
def test_the_cancellation_without_a_session_is_401_and_changes_nothing(shop: OrderShop) -> None:
    user, order_id, product = pending_order(shop)
    before = helpers.effects(shop.session, user, product)

    error_of(cancel(shop, None, order_id), 401, "unauthenticated")
    garbage = shop.client.post(
        f"{helpers.PATH}/{order_id}/cancel", headers={"Authorization": "Bearer no-es-un-token"}
    )
    error_of(garbage, 401, "unauthenticated")

    assert helpers.effects(shop.session, user, product) == before
    assert db_status(shop.session, order_id) == "pendiente_pago"


def test_the_401_does_not_depend_on_the_order_existing(shop: OrderShop) -> None:
    _, real, _ = pending_order(shop)

    a, b = cancel(shop, None, real), cancel(shop, None, uuid4())

    assert a.status_code == b.status_code == 401 and a.json() == b.json()


@pytest.mark.parametrize("bad", ["abc", "123", "00000000-0000-0000-0000", "not-a-uuid", "1;DROP"])
def test_a_malformed_order_id_is_422_with_the_path_field(shop: OrderShop, bad: str) -> None:
    details = error_of(cancel(shop, shop.user(), bad), 422, "validation_error")

    assert any("order_id" in item["loc"] for item in details)
    assert all("input" not in item for item in details)


@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
def test_only_post_is_allowed_on_the_cancel_route(shop: OrderShop, method: str) -> None:
    user, order_id, _ = pending_order(shop)

    response = getattr(shop.client, method)(
        f"{helpers.PATH}/{order_id}/cancel", headers=headers(user)
    )

    assert response.status_code == 405
    assert db_status(shop.session, order_id) == "pendiente_pago"


def test_the_detail_route_still_works_and_does_not_cancel(shop: OrderShop) -> None:
    user, order_id, _ = pending_order(shop)

    assert get_order(shop, user, order_id).status_code == 200
    assert db_status(shop.session, order_id) == "pendiente_pago"
