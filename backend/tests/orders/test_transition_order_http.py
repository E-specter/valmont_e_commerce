"""`POST /api/v1/orders/admin/{order_id}/transitions` con la app real y PostgreSQL (T-079;
CA-ORDERS-18, 20, 22 y 26; SPEC §2, §3 UC-09, §4 R1, R19 y R20, §5, §7 "Transiciones", §9).
Autorización por rol (401, 403, 200), la matriz completa de §5 por HTTP y por modalidad (cada par
válido se acepta; cada otro par es 409 `invalid_transition` con `from`, `to` y `allowed`; `pagado`,
`expirado` y `pendiente_pago` como destino son 422), la validación del cuerpo (`extra="forbid"`,
longitudes, tipos), el 404, y que ningún rechazo deja efectos. Cada solicitud corre en un SAVEPOINT
de la transacción de la prueba. Datos ficticios."""

from typing import Any
from uuid import uuid4

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import ADMIN_PATH, admin_of, admin_order
from tests.orders.orders_http_helpers import OrderShop
from tests.orders.orders_read_helpers import ALL_STATUSES, db_status, headers
from tests.orders.orders_transition_helpers import (
    METHODS,
    TYPED_TARGETS,
    UNTYPED_TARGETS,
    body_for,
    expected_targets,
    fingerprint,
    history_of,
    order_in,
    post_transition,
    refunds,
    transition,
    transition_path,
)
from tests.orders.test_admin_orders_http import error_of

pytestmark = pytest.mark.integration

shop = helpers.shop

PAIRS = [(m, s, t) for m in METHODS for s in ALL_STATUSES for t in TYPED_TARGETS]
UNTYPED = [(m, s, t) for m in METHODS for s in ALL_STATUSES for t in UNTYPED_TARGETS]


def locs(details: Any) -> list[list[Any]]:
    return [d["loc"] for d in details]


# --------------------------------------------------------------------------------------------
# CA-ORDERS-22: autorización por rol
def test_without_a_token_it_is_401_and_nothing_changes(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    before = fingerprint(shop.session, order.id)

    error_of(transition(shop, None, order.id, "en_preparacion"), 401, "unauthenticated")

    assert fingerprint(shop.session, order.id) == before


@pytest.mark.parametrize("bearer", ["Bearer", "Bearer basura.sin.firma", "Basic YWRtaW46YWRtaW4="])
def test_a_malformed_or_invalid_token_is_401_not_403(shop: OrderShop, bearer: str) -> None:
    order = order_in(shop, "pagado")
    before = fingerprint(shop.session, order.id)

    response = post_transition(
        shop, None, order.id, body_for("en_preparacion"), headers={"Authorization": bearer}
    )

    error_of(response, 401, "unauthenticated")
    assert fingerprint(shop.session, order.id) == before


def test_a_customer_is_403_on_someone_elses_order_and_nothing_changes(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    before = fingerprint(shop.session, order.id)

    details = error_of(transition(shop, shop.user(), order.id, "en_preparacion"), 403, "forbidden")

    assert details is None and fingerprint(shop.session, order.id) == before


@pytest.mark.parametrize("to", TYPED_TARGETS)
def test_the_owner_cannot_use_the_admin_route_on_their_own_order(shop: OrderShop, to: str) -> None:
    owner = shop.user()
    order = order_in(shop, "pagado", user=owner)
    before = fingerprint(shop.session, order.id)

    error_of(transition(shop, owner, order.id, to), 403, "forbidden")

    assert fingerprint(shop.session, order.id) == before  # ni siquiera cancelar su propio pagado


def test_a_customer_cannot_cancel_with_a_refund_through_the_admin_route(shop: OrderShop) -> None:
    owner = shop.user()
    order = order_in(shop, "pagado", user=owner)

    error_of(transition(shop, owner, order.id, "cancelado"), 403, "forbidden")

    assert db_status(shop.session, order.id) == "pagado"
    assert fingerprint(shop.session, order.id)["order"]["refunded_amount"] is None


def test_a_customer_gets_403_not_404_on_a_missing_order_so_nothing_is_revealed(
    shop: OrderShop,
) -> None:
    error_of(transition(shop, shop.user(), uuid4(), "en_preparacion"), 403, "forbidden")


@pytest.mark.parametrize("body", [{}, {"to": "pagado"}, {"to": "x", "user_id": "y"}, []])
def test_a_customer_with_an_invalid_body_is_403_before_any_validation(
    shop: OrderShop, body: Any
) -> None:
    order = order_in(shop, "pagado")

    error_of(post_transition(shop, shop.user(), order.id, body), 403, "forbidden")


def test_an_admin_is_200(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")

    response = transition(shop, admin_of(shop), order.id, "en_preparacion")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    assert db_status(shop.session, order.id) == "en_preparacion"


def test_the_route_only_answers_to_post(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    admin = admin_of(shop)

    for method in ("get", "put", "patch", "delete"):
        response = getattr(shop.client, method)(transition_path(order.id), headers=headers(admin))
        assert response.status_code == 405, method

    assert db_status(shop.session, order.id) == "pagado"


# --------------------------------------------------------------------------------------------
# CA-ORDERS-18 y 26: la matriz completa por HTTP, por modalidad
@pytest.mark.parametrize("method,status,to", PAIRS, ids=lambda v: v)
def test_every_pair_is_accepted_or_409_invalid_transition_with_the_allowed_targets(
    shop: OrderShop, method: str, status: str, to: str
) -> None:
    admin, order = admin_of(shop), order_in(shop, status, method)
    before = fingerprint(shop.session, order.id)
    allowed = expected_targets(status, method)

    response = transition(shop, admin, order.id, to)

    if to in allowed:
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == to and db_status(shop.session, order.id) == to
        assert sorted(body["can_transition_to"]) == sorted(expected_targets(to, method))
        assert (body["refund"] is not None) == refunds(status, to)
        assert len(body["history"]) == len(before["history"]) + 1
        return
    details = error_of(response, 409, "invalid_transition")
    assert set(details) == {"from", "to", "allowed"}
    assert (details["from"], details["to"]) == (status, to)
    assert isinstance(details["allowed"], list) and len(details["allowed"]) == len(allowed)
    assert set(details["allowed"]) == allowed  # coincide con `can_transition_to` de §5
    assert fingerprint(shop.session, order.id) == before  # sin ningún efecto


@pytest.mark.parametrize("method,status,to", UNTYPED, ids=lambda v: v)
def test_paid_expired_and_pending_as_destination_are_422_never_409(
    shop: OrderShop, method: str, status: str, to: str
) -> None:
    order = order_in(shop, status, method)
    before = fingerprint(shop.session, order.id)

    details = error_of(transition(shop, admin_of(shop), order.id, to), 422, "validation_error")

    assert ["body", "to"] in locs(details)  # R19: lo rechaza el esquema, no la máquina de estados
    assert fingerprint(shop.session, order.id) == before


def test_the_valid_pairs_are_exactly_twelve_and_the_allowed_lists_match_can_transition_to(
    shop: OrderShop,
) -> None:
    admin, valid = admin_of(shop), 0
    for method in METHODS:
        for status in ALL_STATUSES:
            order = order_in(shop, status, method)
            shown = admin_order(shop, admin, order.id)["can_transition_to"]
            assert set(shown) == expected_targets(status, method), (method, status)
            valid += len(shown)
    assert valid == 12


def test_a_status_without_exit_gives_an_empty_allowed_list(shop: OrderShop) -> None:
    order = order_in(shop, "entregado")

    details = error_of(
        transition(shop, admin_of(shop), order.id, "en_preparacion"), 409, "invalid_transition"
    )

    assert details == {"from": "entregado", "to": "en_preparacion", "allowed": []}


@pytest.mark.parametrize("method,wrong", [("pickup", "enviado"), ("shipping", "listo_para_recojo")])
def test_the_other_modalitys_handoff_is_409_with_the_right_one_in_allowed(
    shop: OrderShop, method: str, wrong: str
) -> None:
    order = order_in(shop, "en_preparacion", method)

    details = error_of(transition(shop, admin_of(shop), order.id, wrong), 409, "invalid_transition")

    right = "listo_para_recojo" if method == "pickup" else "enviado"
    assert set(details["allowed"]) == {right, "cancelado"}  # R20, H-3


def test_skipping_a_state_is_409(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")

    for skip in ("enviado", "entregado"):
        details = error_of(
            transition(shop, admin_of(shop), order.id, skip), 409, "invalid_transition"
        )
        assert set(details["allowed"]) == {"en_preparacion", "cancelado"}
    assert db_status(shop.session, order.id) == "pagado"


def test_going_back_is_409(shop: OrderShop) -> None:
    order = order_in(shop, "en_preparacion")

    error_of(
        transition(shop, admin_of(shop), order.id, "en_preparacion"), 409, "invalid_transition"
    )
    assert db_status(shop.session, order.id) == "en_preparacion"


# --------------------------------------------------------------------------------------------
# Validación del cuerpo (TransitionIn, extra="forbid")
BAD_TO = [None, "", "ENVIADO", "enviar", "desconocido", 5, True, ["enviado"], {"a": 1}]


@pytest.mark.parametrize("to", BAD_TO, ids=repr)
def test_an_invalid_destination_is_422(shop: OrderShop, to: Any) -> None:
    order = order_in(shop, "pagado")
    before = fingerprint(shop.session, order.id)

    details = error_of(
        post_transition(shop, admin_of(shop), order.id, {"to": to}), 422, "validation_error"
    )

    assert ["body", "to"] in locs(details)
    assert fingerprint(shop.session, order.id) == before


EXTRAS = [
    ("user_id", str(uuid4())),
    ("actor_id", str(uuid4())),
    ("actor", "admin"),
    ("status", "pagado"),
    ("refund_amount", 1),
    ("refunded_amount", 1),
    ("total", 1),
    ("paid_at", "2026-01-01T00:00:00Z"),
    ("shipped_at", "2026-01-01T00:00:00Z"),
    ("amount", 100),
]


@pytest.mark.parametrize("name,value", EXTRAS, ids=[n for n, _ in EXTRAS])
def test_an_extra_field_is_422_and_nothing_is_written(
    shop: OrderShop, name: str, value: Any
) -> None:
    order = order_in(shop, "pagado")
    before = fingerprint(shop.session, order.id)

    response = post_transition(
        shop, admin_of(shop), order.id, {"to": "en_preparacion", name: value}
    )

    details = error_of(response, 422, "validation_error")
    assert ["body", name] in locs(details)
    assert fingerprint(shop.session, order.id) == before


@pytest.mark.parametrize("body", [None, [], "texto", 7, [{"to": "en_preparacion"}]], ids=repr)
def test_a_body_that_is_not_an_object_is_422(shop: OrderShop, body: Any) -> None:
    order = order_in(shop, "pagado")

    error_of(post_transition(shop, admin_of(shop), order.id, body), 422, "validation_error")

    assert db_status(shop.session, order.id) == "pagado"


def test_a_request_without_body_or_with_broken_json_is_422(shop: OrderShop) -> None:
    order, admin = order_in(shop, "pagado"), admin_of(shop)

    empty = shop.client.post(transition_path(order.id), headers=headers(admin))
    broken = shop.client.post(
        transition_path(order.id),
        headers={**headers(admin), "Content-Type": "application/json"},
        content=b'{"to": ',
    )

    for response in (empty, broken):
        error_of(response, 422, "validation_error")
    assert db_status(shop.session, order.id) == "pagado"


@pytest.mark.parametrize("size,status", [(1, 200), (500, 200), (501, 422)])
def test_the_note_is_one_to_five_hundred_characters(
    shop: OrderShop, size: int, status: int
) -> None:
    order = order_in(shop, "pagado")
    note = "n" * size

    response = transition(shop, admin_of(shop), order.id, "en_preparacion", note=note)

    assert response.status_code == status, response.text
    if status == 200:
        assert response.json()["history"][-1]["note"] == note
    else:
        assert note not in response.text  # el error no devuelve el texto recibido
        assert db_status(shop.session, order.id) == "pagado"


@pytest.mark.parametrize("note", [5, ["a"], {"a": "b"}, True], ids=repr)
def test_a_note_that_is_not_text_is_422(shop: OrderShop, note: Any) -> None:
    order = order_in(shop, "pagado")

    details = error_of(
        transition(shop, admin_of(shop), order.id, "en_preparacion", note=note),
        422,
        "validation_error",
    )

    assert ["body", "note"] in locs(details)


def test_the_error_details_never_echo_the_input(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    internal_note = "Ana-Torres-987654321-" + "x" * 500

    response = transition(shop, admin_of(shop), order.id, "en_preparacion", note=internal_note)

    details = error_of(response, 422, "validation_error")
    assert all(set(d) == {"loc", "type", "msg"} for d in details)  # sin `input` ni `ctx`
    assert "Ana-Torres" not in response.text


def test_the_note_is_plain_text_returned_exactly_as_sent(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")
    note = "<script>alert(1)</script> ñandú; DROP TABLE orders; --"

    body = transition(shop, admin_of(shop), order.id, "en_preparacion", note=note).json()

    assert body["history"][-1]["note"] == note  # texto plano, parametrizado: no se interpreta


# --------------------------------------------------------------------------------------------
# 404 y ruta
def test_an_unknown_order_is_404_not_found(shop: OrderShop) -> None:
    for to in ("en_preparacion", "cancelado"):
        error_of(transition(shop, admin_of(shop), uuid4(), to), 404, "not_found")


def test_a_malformed_order_id_is_422(shop: OrderShop) -> None:
    response = post_transition(shop, admin_of(shop), "no-es-un-uuid", body_for("en_preparacion"))

    details = error_of(response, 422, "validation_error")
    assert ["path", "order_id"] in locs(details)


def test_the_route_is_not_captured_by_the_customer_routes(shop: OrderShop) -> None:
    order = order_in(shop, "pagado")

    response = shop.client.post(
        f"{ADMIN_PATH}/{order.id}/transitions",
        headers=headers(admin_of(shop)),
        json=body_for("en_preparacion"),
    )

    assert response.status_code == 200 and response.json()["id"] == str(order.id)


def test_the_admin_operates_on_orders_of_any_customer(shop: OrderShop) -> None:
    admin = admin_of(shop)
    first, second = order_in(shop, "pagado"), order_in(shop, "pagado", "pickup")

    for order in (first, second):
        body = transition(shop, admin, order.id, "en_preparacion").json()
        assert body["status"] == "en_preparacion" and body["user_id"] == str(order.user_id)


def test_a_transition_touches_nothing_of_the_other_orders(shop: OrderShop) -> None:
    mine, theirs = order_in(shop, "pagado"), order_in(shop, "pagado")
    before = fingerprint(shop.session, theirs.id)

    transition(shop, admin_of(shop), mine.id, "cancelado")

    assert fingerprint(shop.session, theirs.id) == before


# --------------------------------------------------------------------------------------------
# La nota se recorta y no admite caracteres de control salvo el salto de línea (A1 y A2): las
# mismas reglas con `cancelado` (obligatoria) y con cualquier otro destino (opcional)
NOTE_TARGETS = [
    ("pagado", "en_preparacion"),
    ("pagado", "cancelado"),
    ("pendiente_pago", "cancelado"),
]
NOTE_IDS = ["preparing", "cancel-paid", "cancel-pending"]


@pytest.mark.parametrize("status,to", NOTE_TARGETS, ids=NOTE_IDS)
@pytest.mark.parametrize("note", ["   ", " \t ", "\n", "  \n  ", "\u00a0"], ids=repr)
def test_a_blank_note_is_422_and_nothing_changes(
    shop: OrderShop, status: str, to: str, note: str
) -> None:
    order = order_in(shop, status)
    before = fingerprint(shop.session, order.id)

    details = error_of(
        post_transition(shop, admin_of(shop), order.id, {"to": to, "note": note}),
        422,
        "validation_error",
    )

    assert ["body", "note"] in locs(details) or ["body"] in locs(details)
    assert fingerprint(shop.session, order.id) == before


@pytest.mark.parametrize("status,to", NOTE_TARGETS, ids=NOTE_IDS)
def test_a_note_with_spaces_around_is_stored_trimmed(shop: OrderShop, status: str, to: str) -> None:
    order = order_in(shop, status)

    body = transition(shop, admin_of(shop), order.id, to, note="   Pieza revisada \n ").json()

    assert body["history"][-1]["note"] == "Pieza revisada"
    assert history_of(shop.session, order.id)[-1][4] == "Pieza revisada"


@pytest.mark.parametrize("status,to", NOTE_TARGETS, ids=NOTE_IDS)
@pytest.mark.parametrize("control", ["\t", "\x00", "\x07", "\x1b", "\r", "\x7f"], ids=repr)
def test_a_note_with_a_control_character_inside_is_422(
    shop: OrderShop, status: str, to: str, control: str
) -> None:
    order = order_in(shop, status)
    before = fingerprint(shop.session, order.id)
    note = f"Motivo{control}interno"

    response = post_transition(shop, admin_of(shop), order.id, {"to": to, "note": note})

    details = error_of(response, 422, "validation_error")
    assert ["body", "note"] in locs(details)
    assert "interno" not in response.text
    assert fingerprint(shop.session, order.id) == before


@pytest.mark.parametrize("status,to", NOTE_TARGETS, ids=NOTE_IDS)
def test_a_note_with_a_line_break_inside_is_200_and_kept(
    shop: OrderShop, status: str, to: str
) -> None:
    order = order_in(shop, status)

    body = transition(
        shop, admin_of(shop), order.id, to, note="Primera línea\nSegunda línea"
    ).json()

    assert body["history"][-1]["note"] == "Primera línea\nSegunda línea"


@pytest.mark.parametrize("status,to", NOTE_TARGETS, ids=NOTE_IDS)
def test_the_limit_of_five_hundred_counts_the_trimmed_note(
    shop: OrderShop, status: str, to: str
) -> None:
    order, admin = order_in(shop, status), admin_of(shop)
    over = order_in(shop, status)

    fits = transition(shop, admin, order.id, to, note="  " + "n" * 500 + "  ")
    too_long = transition(shop, admin, over.id, to, note="  " + "n" * 501 + "  ")

    assert fits.status_code == 200 and fits.json()["history"][-1]["note"] == "n" * 500
    error_of(too_long, 422, "validation_error")
    assert db_status(shop.session, over.id) == status
