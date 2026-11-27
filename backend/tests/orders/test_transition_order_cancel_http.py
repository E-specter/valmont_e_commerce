"""Cancelación del administrador con reembolso simulado por HTTP y PostgreSQL (T-079;
CA-ORDERS-19, 20, 21, 22 y 26; SPEC §3 UC-10, §4 R7, R10, R11, R15, R18 y R19, §7 "Transiciones";
D-016, RN-08). El dinero y el stock:
- cancelar un `pagado` o `en_preparacion` registra el reembolso total (importe y fecha), deja una
  fila de historial con el administrador y su nota, audita con el reembolso y NO toca el `on_hand`,
  los movimientos ni las reservas ya consumidas (R15);
- cancelar un `pendiente_pago` libera las reservas sin reembolso;
- enviado, listo para recojo, entregado, cancelado y expirado se rechazan sin tocar el dinero;
- la `note` es obligatoria; un vencido se caduca y no se cancela.
Los pedidos nacen de `POST /orders` y se pagan con `ConfirmOrderPayment`. Datos ficticios."""

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import admin_of, admin_order
from tests.orders.orders_db_helpers import real_line
from tests.orders.orders_http_helpers import (
    OrderShop,
    audit_rows,
    available,
    money,
    on_hand,
    parse_utc,
    place,
    reservations,
    stock_in_cart,
)
from tests.orders.orders_read_helpers import (
    db_status,
    make_overdue,
    read_order,
)
from tests.orders.orders_transition_helpers import (
    NOTE,
    bought,
    fingerprint,
    history_of,
    moved,
    order_in,
    paid,
    post_transition,
    refund_columns,
    stock_movements,
    total_of,
    transition,
)
from tests.orders.test_admin_orders_http import error_of
from tests.orders.test_cancel_order_http import cancel
from tests.orders.test_my_orders_expiry import history_rows, reservation_statuses

pytestmark = pytest.mark.integration

shop = helpers.shop


def statuses_of_reservations(shop: OrderShop, order_id: object) -> list[str]:
    return [r["status"] for r in reservations(shop.session, order_id)]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-19 y 26: pagado y en_preparacion → cancelado con reembolso total
@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
@pytest.mark.parametrize("stage", ["pagado", "en_preparacion"])
def test_cancelling_a_paid_or_preparing_order_refunds_the_whole_total_with_the_note(
    shop: OrderShop, pickup: bool, stage: str
) -> None:
    user, order_id, product = paid(shop, pickup=pickup, quantity=2, on_hand=5)
    admin = admin_of(shop)
    if stage == "en_preparacion":
        moved(shop, admin, order_id, "en_preparacion")
    total = total_of(shop.session, order_id)
    before = len(history_of(shop.session, order_id))

    response = transition(shop, admin, order_id, "cancelado", note="Pieza defectuosa")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "cancelado" and body["can_transition_to"] == []
    last = body["history"][-1]
    assert body["refund"] == {"amount": money(total), "at": last["at"]}  # total, nunca parcial
    assert total == 2 * body["lines"][0]["unit_price"]["amount"]
    assert (last["from_status"], last["status"], last["actor"]) == (stage, "cancelado", "admin")
    assert (last["actor_id"], last["note"]) == (str(admin), "Pieza defectuosa")
    amount, at = refund_columns(shop.session, order_id)
    assert amount == total and at is not None and parse_utc(last["at"]) == at
    assert db_status(shop.session, order_id) == "cancelado"
    rows = history_of(shop.session, order_id)
    assert len(rows) == before + 1  # exactamente una fila
    assert rows[-1] == (stage, "cancelado", "admin", admin, "Pieza defectuosa")
    assert body["paid_at"] is not None  # el pago ocurrió y se conserva para los reportes
    seen = read_order(shop, user, order_id)  # el cliente ve el reembolso, no la nota
    assert seen["refund"] == body["refund"] and seen["status"] == "cancelado"
    assert "Pieza defectuosa" not in repr(seen) and str(admin) not in repr(seen)
    assert on_hand(shop.session, product) == 3  # ver el siguiente test para R15


@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
@pytest.mark.parametrize("stage", ["pagado", "en_preparacion"])
def test_the_refund_does_not_put_the_stock_back_r15(
    shop: OrderShop, pickup: bool, stage: str
) -> None:
    _, order_id, product = paid(shop, pickup=pickup, quantity=2, on_hand=5)
    admin = admin_of(shop)
    if stage == "en_preparacion":
        moved(shop, admin, order_id, "en_preparacion")
    on_hand_before = on_hand(shop.session, product)
    available_before = available(shop.session, product)
    movements = stock_movements(shop.session, order_id)
    assert on_hand_before == 3 and movements == [("venta", -2)]

    moved(shop, admin, order_id, "cancelado", note=NOTE)

    assert on_hand(shop.session, product) == on_hand_before  # R15: el stock NO se repone
    assert available(shop.session, product) == available_before
    assert stock_movements(shop.session, order_id) == movements  # sin entrada ni devolución
    assert statuses_of_reservations(shop, order_id) == ["consumed"]  # no se liberan las consumidas


@pytest.mark.parametrize("stage", ["pagado", "en_preparacion"])
def test_the_audit_has_the_admin_and_the_refund(shop: OrderShop, stage: str) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    if stage == "en_preparacion":
        moved(shop, admin, order_id, "en_preparacion")
    total = total_of(shop.session, order_id)

    moved(shop, admin, order_id, "cancelado", note=NOTE)

    entries = [
        a
        for a in audit_rows(shop.session, entity_id=order_id)
        if a["action"] == "orders.status_changed" and a["actor_role"] == "admin"
    ]
    entry = entries[-1]
    assert entry["actor_id"] == admin and entry["entity_type"] == "order"
    assert entry["before"] == {"status": stage}
    assert entry["after"] == {"status": "cancelado", "refunded_amount": total}


def test_a_refund_above_two_pow_31_is_kept_whole_in_the_database_and_the_response(
    shop: OrderShop,
) -> None:
    user = shop.user()
    big = real_line(shop.session, quantity=5, list_price=3_000_000_000)
    order = order_in(shop, "pagado", user=user, lines=[big])
    total = total_of(shop.session, order.id)
    assert total == 15_000_000_000

    body = moved(shop, admin_of(shop), order.id, "cancelado", note=NOTE)

    assert body["refund"]["amount"] == money(15_000_000_000)
    assert refund_columns(shop.session, order.id)[0] == 15_000_000_000


def test_the_refund_equals_the_total_even_when_the_order_has_several_lines(
    shop: OrderShop,
) -> None:
    user = shop.user()
    lines = [
        real_line(shop.session, quantity=3, list_price=120_000, unit_price=100_000),
        real_line(shop.session, quantity=1, list_price=555_555),
    ]
    order = order_in(shop, "en_preparacion", user=user, lines=lines)

    body = moved(shop, admin_of(shop), order.id, "cancelado", note=NOTE)

    assert body["refund"]["amount"] == money(3 * 100_000 + 555_555)
    assert refund_columns(shop.session, order.id)[0] == total_of(shop.session, order.id)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-19: pendiente_pago → cancelado sin reembolso y con las reservas liberadas
@pytest.mark.parametrize("pickup", [False, True], ids=["shipping", "pickup"])
def test_cancelling_a_pending_order_releases_the_reservation_without_refund(
    shop: OrderShop, pickup: bool
) -> None:
    user, order_id, product = bought(shop, pickup=pickup, quantity=2, on_hand=5)
    admin = admin_of(shop)
    assert statuses_of_reservations(shop, order_id) == ["active"]
    assert available(shop.session, product) == 3

    body = moved(shop, admin, order_id, "cancelado", note="Cliente lo pidió por teléfono")

    assert body["status"] == "cancelado" and body["refund"] is None
    assert refund_columns(shop.session, order_id) == (None, None)
    assert statuses_of_reservations(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5 and on_hand(shop.session, product) == 5
    assert stock_movements(shop.session, order_id) == []  # nada se vendió ni se devolvió
    assert body["paid_at"] is None
    assert history_of(shop.session, order_id)[-1] == (
        "pendiente_pago",
        "cancelado",
        "admin",
        admin,
        "Cliente lo pidió por teléfono",
    )
    assert read_order(shop, user, order_id)["refund"] is None


def test_the_audit_of_a_pending_cancellation_has_the_admin_and_no_refund(shop: OrderShop) -> None:
    _, order_id, _ = bought(shop)
    admin = admin_of(shop)

    moved(shop, admin, order_id, "cancelado", note=NOTE)

    entry = [a for a in audit_rows(shop.session, entity_id=order_id) if a["actor_role"] == "admin"]
    assert len(entry) == 1 and entry[0]["actor_id"] == admin
    assert entry[0]["before"] == {"status": "pendiente_pago"}
    assert entry[0]["after"] == {"status": "cancelado"}


def test_the_released_stock_can_be_bought_again_and_other_orders_keep_their_reservation(
    shop: OrderShop,
) -> None:
    user, first, product = bought(shop, quantity=2, on_hand=3)
    other = shop.user()
    stock_in_cart(shop, other, (product, 1))
    second = place(shop, other)
    assert second.status_code == 201 and available(shop.session, product) == 0
    theirs = fingerprint(shop.session, second.json()["id"])

    moved(shop, admin_of(shop), first, "cancelado", note=NOTE)

    assert available(shop.session, product) == 2  # solo se liberó lo del pedido cancelado
    assert statuses_of_reservations(shop, second.json()["id"]) == ["active"]
    assert fingerprint(shop.session, second.json()["id"]) == theirs
    stock_in_cart(shop, user, (product, 2))
    assert place(shop, user).status_code == 201


# --------------------------------------------------------------------------------------------
# CA-ORDERS-19: enviado, listo para recojo, entregado, cancelado y expirado no se cancelan
@pytest.mark.parametrize(
    "status,method",
    [
        ("enviado", "shipping"),
        ("listo_para_recojo", "pickup"),
        ("entregado", "shipping"),
        ("entregado", "pickup"),
        ("cancelado", "shipping"),
        ("expirado", "shipping"),
    ],
)
def test_a_shipped_ready_delivered_cancelled_or_expired_order_is_409_and_no_money_moves(
    shop: OrderShop, status: str, method: str
) -> None:
    order = order_in(shop, status, method)
    before = fingerprint(shop.session, order.id)

    details = error_of(
        transition(shop, admin_of(shop), order.id, "cancelado", note=NOTE),
        409,
        "invalid_transition",
    )

    assert (details["from"], details["to"]) == (status, "cancelado")
    assert "cancelado" not in details["allowed"]
    assert refund_columns(shop.session, order.id) == (None, None)
    assert fingerprint(shop.session, order.id) == before


def test_cancelling_twice_does_not_refund_twice(shop: OrderShop) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    first = moved(shop, admin, order_id, "cancelado", note=NOTE)
    after_first = fingerprint(shop.session, order_id)

    details = error_of(
        transition(shop, admin, order_id, "cancelado", note="otra vez"), 409, "invalid_transition"
    )

    assert details == {"from": "cancelado", "to": "cancelado", "allowed": []}
    assert fingerprint(shop.session, order_id) == after_first
    assert admin_order(shop, admin, order_id)["refund"] == first["refund"]  # mismo importe y fecha
    assert len([r for r in history_of(shop.session, order_id) if r[1] == "cancelado"]) == 1


def test_the_customer_cancelling_an_order_the_admin_cancelled_changes_nothing(
    shop: OrderShop,
) -> None:
    user, order_id, _ = paid(shop)
    body = moved(shop, admin_of(shop), order_id, "cancelado", note=NOTE)
    after = fingerprint(shop.session, order_id)

    again = cancel(shop, user, order_id)

    assert again.status_code == 200 and again.json()["refund"] == body["refund"]  # idempotente
    assert fingerprint(shop.session, order_id) == after
    assert refund_columns(shop.session, order_id)[0] == total_of(shop.session, order_id)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-19: la nota es obligatoria (1 a 500)
@pytest.mark.parametrize("stage", ["pendiente_pago", "pagado", "en_preparacion"])
@pytest.mark.parametrize(
    "fields",
    [{}, {"note": None}, {"note": ""}, {"note": "x" * 501}, {"note": 7}],
    ids=["missing", "null", "empty", "too-long", "not-text"],
)
def test_a_cancellation_without_a_valid_note_is_422_and_nothing_moves(
    shop: OrderShop, stage: str, fields: dict[str, object]
) -> None:
    order = order_in(shop, stage)
    before = fingerprint(shop.session, order.id)

    response = post_transition(shop, admin_of(shop), order.id, {"to": "cancelado", **fields})

    details = error_of(response, 422, "validation_error")
    assert details
    assert fingerprint(shop.session, order.id) == before
    assert refund_columns(shop.session, order.id) == (None, None)


@pytest.mark.parametrize("size", [1, 500])
def test_a_note_of_one_or_five_hundred_characters_cancels(shop: OrderShop, size: int) -> None:
    order = order_in(shop, "pagado")

    body = moved(shop, admin_of(shop), order.id, "cancelado", note="m" * size)

    assert body["history"][-1]["note"] == "m" * size and body["refund"] is not None


# --------------------------------------------------------------------------------------------
# R7: un vencido se caduca y no se cancela
def test_an_overdue_pending_order_is_409_from_expired_and_never_cancelled(shop: OrderShop) -> None:
    user, order_id, product = bought(shop)
    make_overdue(shop.session, order_id)
    admin = admin_of(shop)

    for to in ("en_preparacion", "cancelado"):
        details = error_of(
            transition(shop, admin, order_id, to, **({"note": NOTE} if to == "cancelado" else {})),
            409,
            "invalid_transition",
        )
        assert details == {"from": "expirado", "to": to, "allowed": []}

    # El 409 deshace la transacción (como en T-076): la caducidad se materializa en la lectura.
    body = admin_order(shop, admin, order_id)
    assert body["status"] == "expirado" and body["refund"] is None
    assert [(h["status"], h["actor"]) for h in body["history"]] == [
        ("pendiente_pago", "customer"),
        ("expirado", "system"),
    ]
    assert history_rows(shop, order_id) == [
        (None, "pendiente_pago", "customer", user, None),
        ("pendiente_pago", "expirado", "system", None, None),
    ]
    assert reservation_statuses(shop, order_id) == ["released"]
    assert available(shop.session, product) == 5
    assert refund_columns(shop.session, order_id) == (None, None)


def test_an_order_overdue_by_exactly_now_is_also_409(shop: OrderShop) -> None:
    _, order_id, _ = bought(shop)
    make_overdue(shop.session, order_id, seconds_over=0)  # expires_at == now: vencido

    error_of(
        transition(shop, admin_of(shop), order_id, "cancelado", note=NOTE),
        409,
        "invalid_transition",
    )


def test_an_order_with_seconds_left_is_still_cancellable_by_the_admin(shop: OrderShop) -> None:
    _, order_id, product = bought(shop)
    make_overdue(shop.session, order_id, seconds_over=-30)

    body = moved(shop, admin_of(shop), order_id, "cancelado", note=NOTE)

    assert body["status"] == "cancelado" and body["refund"] is None
    assert available(shop.session, product) == 5


def test_a_paid_order_never_expires_however_old_it_is(shop: OrderShop) -> None:
    order = order_in(shop, "pagado", minutes_ago=60 * 24 * 30)

    body = moved(shop, admin_of(shop), order.id, "cancelado", note=NOTE)

    assert body["status"] == "cancelado" and body["refund"] is not None
