"""Auditoría final de seguridad de orders por HTTP (T-080; RNF02, OWASP ASVS nivel 1; SPEC §4 R12,
R13, R18, §7, §9). Completa las suites de T-074…T-079 con lo que no atacaban: el mismo pedido ajeno
escrito con otras grafías de UUID, cada token manipulado contra **todas** las rutas, claims de rol
falsos en las tres rutas de administración, inyección y caracteres de control en `carrier`,
`tracking_code` y `note`, fechas en el borde del calendario, cuerpos enormes, abuso de la clave de
idempotencia y fuga de datos personales en un 500 y en un recorrido completo a nivel DEBUG.

App real contra valmont_test, cada solicitud en un SAVEPOINT de la transacción de la prueba (fixture
`shop`). Datos ficticios."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import jwt
import pytest

from tests.cart.cart_helpers import add_listed
from tests.identity.identity_helpers import (
    ISSUER,
    KID,
    OTHER_KEY,
    claims_for,
    hs256_signed_with_public_key,
    make_token,
)
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import ADMIN_PATH, admin_of, admin_order, named_order
from tests.orders.orders_http_helpers import (
    PATH,
    PERSONAL,
    PICKUP,
    SHIPPING,
    OrderShop,
    audit_rows,
    effects,
    order_row,
    place,
    reservations,
    stock_in_cart,
)
from tests.orders.orders_read_helpers import headers, make_order
from tests.orders.orders_transition_helpers import (
    bought,
    fingerprint,
    moved,
    paid,
    post_transition,
)
from valmont.modules.orders.adapters.http import get_create_order

pytestmark = pytest.mark.integration

shop = helpers.shop

NIL = "00000000-0000-0000-0000-000000000000"
MAX = "ffffffff-ffff-ffff-ffff-ffffffffffff"


def routes(order_id: object) -> list[tuple[str, str, Any]]:
    """Las siete rutas de §7 con un cuerpo válido: (método, ruta, json)."""
    return [
        ("POST", PATH, {"delivery": SHIPPING}),
        ("GET", PATH, None),
        ("GET", f"{PATH}/{order_id}", None),
        ("POST", f"{PATH}/{order_id}/cancel", None),
        ("GET", ADMIN_PATH, None),
        ("GET", f"{ADMIN_PATH}/{order_id}", None),
        ("POST", f"{ADMIN_PATH}/{order_id}/transitions", {"to": "en_preparacion"}),
    ]


def call(shop: OrderShop, method: str, path: str, body: Any, auth: dict[str, str]) -> Any:
    sent = {"Idempotency-Key": f"key-{uuid4().hex}", **auth}
    return shop.client.request(method, path, headers=sent, json=body)


def spellings(order_id: UUID) -> list[str]:
    """El mismo UUID escrito de otras formas que un analizador laxo podría aceptar."""
    text = str(order_id)
    return [text.upper(), order_id.hex, order_id.hex.upper(), "{" + text + "}", f"urn:uuid:{text}"]


def raw_post(shop: OrderShop, path: str, user: UUID, content: str, **extra: str) -> Any:
    """POST con el JSON escrito a mano: así viaja `\\ud800` (httpx no codifica un sustituto)."""
    sent = {"Content-Type": "application/json", **headers(user), **extra}
    return shop.client.post(path, headers=sent, content=content.encode())


def code_of(response: Any) -> str:
    return response.json()["error"]["code"]


# --------------------------------------------------------------------------------------------
# IDOR: el pedido ajeno con otra grafía de UUID, ids aleatorios y extremos (R12, CA-ORDERS-22)


def test_a_foreign_order_spelled_as_any_uuid_form_is_never_served_nor_cancelled(
    shop: OrderShop,
) -> None:
    owner, stranger = shop.user(), shop.user()
    order = make_order(shop.session, owner, status="pendiente_pago", minutes_ago=5)
    missing = shop.client.get(f"{PATH}/{uuid4()}", headers=headers(stranger))
    assert missing.status_code == 404

    for spelled in spellings(order.id):
        read = shop.client.get(f"{PATH}/{spelled}", headers=headers(stranger))
        cancel = shop.client.post(f"{PATH}/{spelled}/cancel", headers=headers(stranger))
        for response in (read, cancel):
            assert response.status_code in (404, 422), (spelled, response.text)
            if response.status_code == 404:
                assert response.json() == missing.json()  # el mismo 404 que un inexistente
    assert order_row(shop.session, order.id)["status"] == "pendiente_pago"


def test_the_owner_spelling_the_uuid_differently_still_reaches_only_their_own_order(
    shop: OrderShop,
) -> None:
    owner = shop.user()
    order = make_order(shop.session, owner, status="pagado")

    for spelled in spellings(order.id):
        response = shop.client.get(f"{PATH}/{spelled}", headers=headers(owner))
        assert response.status_code in (200, 422), (spelled, response.text)
        if response.status_code == 200:
            assert response.json()["id"] == str(order.id)


@pytest.mark.parametrize("order_id", [NIL, MAX, "random"])
def test_random_and_extreme_ids_are_the_same_404_on_every_customer_route(
    shop: OrderShop, order_id: str
) -> None:
    user = shop.user()
    make_order(shop.session, user, status="pendiente_pago", minutes_ago=5)  # tiene un pedido
    target = str(uuid4()) if order_id == "random" else order_id

    read = shop.client.get(f"{PATH}/{target}", headers=headers(user))
    cancel = shop.client.post(f"{PATH}/{target}/cancel", headers=headers(user))

    assert read.status_code == cancel.status_code == 404
    assert (
        read.json()
        == cancel.json()
        == {"error": {"code": "not_found", "message": "Pedido no encontrado.", "details": None}}
    )


def test_an_admin_can_read_any_order_but_a_spelled_id_never_reaches_a_different_one(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    order = make_order(shop.session, shop.user(), status="pagado")
    other = make_order(shop.session, shop.user(), status="pagado")

    for spelled in spellings(order.id):
        response = shop.client.get(f"{ADMIN_PATH}/{spelled}", headers=headers(admin))
        assert response.status_code in (200, 422), response.text
        if response.status_code == 200:
            assert response.json()["id"] == str(order.id) != str(other.id)


# --------------------------------------------------------------------------------------------
# Tokens manipulados en las siete rutas (ASVS V3) y claims de rol falsos (V4)


def _expired(sub: str) -> str:
    return make_token(sub, exp=int((datetime.now(UTC) - timedelta(minutes=1)).timestamp()))


def _unsigned(sub: str) -> str:
    return jwt.encode(claims_for(sub), None, algorithm="none", headers={"kid": KID})


TAMPERED = {
    "caducado": _expired,
    "otro_emisor": lambda sub: make_token(sub, iss="https://otro.example/auth/v1"),
    "otra_audiencia": lambda sub: make_token(sub, aud="service_role"),
    "otra_clave": lambda sub: make_token(sub, key=OTHER_KEY),
    "kid_desconocido": lambda sub: make_token(sub, kid="otra-kid"),
    "alg_none": _unsigned,
    "hs256_con_clave_publica": hs256_signed_with_public_key,
    "sin_exp": lambda sub: make_token(sub, exp=None),
    "sub_no_uuid": lambda sub: make_token("admin"),
    "sin_sub": lambda sub: make_token(None),
    "firma_cortada": lambda sub: make_token(sub).rsplit(".", 1)[0] + ".",
    "basura": lambda sub: "no-es-un-jwt",
}


@pytest.mark.parametrize("name", list(TAMPERED))
def test_a_tampered_token_is_401_on_every_route_and_writes_nothing(
    shop: OrderShop, name: str
) -> None:
    owner = shop.user()
    admin = admin_of(shop)
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, owner, (product, 1))
    order = make_order(shop.session, owner, status="pagado")
    before = effects(shop.session, owner, product), fingerprint(shop.session, order.id)

    for subject in (owner, admin):  # ni el del cliente ni el del administrador
        token = TAMPERED[name](str(subject))
        for method, path, body in routes(order.id):
            response = call(shop, method, path, body, {"Authorization": f"Bearer {token}"})
            assert response.status_code == 401, (name, method, path, response.text)
            assert code_of(response) == "unauthenticated"
            assert response.headers["www-authenticate"] == "Bearer"
    assert (effects(shop.session, owner, product), fingerprint(shop.session, order.id)) == before


@pytest.mark.parametrize(
    "auth",
    [{}, {"Authorization": "Bearer "}, {"Authorization": "Basic YWRtaW46YWRtaW4="}],
    ids=["sin_cabecera", "bearer_vacio", "basic"],
)
def test_without_a_bearer_token_every_route_is_401(shop: OrderShop, auth: dict[str, str]) -> None:
    order = make_order(shop.session, shop.user(), status="pagado")

    for method, path, body in routes(order.id):
        response = call(shop, method, path, body, auth)
        assert response.status_code == 401, (method, path, response.text)


@pytest.mark.parametrize(
    "claims",
    [
        {"role": "admin"},
        {"role": "service_role"},
        {"app_metadata": {"role": "admin"}},
        {"user_metadata": {"role": "admin"}},
        {"user_role": "admin", "is_admin": True},
    ],
    ids=["role", "service_role", "app_metadata", "user_metadata", "otros"],
)
def test_a_customer_with_forged_role_claims_is_403_on_every_admin_route(
    shop: OrderShop, claims: dict[str, Any]
) -> None:
    customer = shop.user()
    order = make_order(shop.session, customer, status="pagado")
    before = fingerprint(shop.session, order.id)
    token = make_token(str(customer), **claims)

    for method, path, body in routes(order.id)[4:]:
        response = call(shop, method, path, body, {"Authorization": f"Bearer {token}"})
        assert response.status_code == 403, (method, path, response.text)
        assert code_of(response) == "forbidden"
    assert fingerprint(shop.session, order.id) == before  # su propio pedido, sin preparar


def test_a_token_of_a_real_admin_signed_by_another_issuer_is_not_an_admin(
    shop: OrderShop,
) -> None:
    admin = admin_of(shop)
    token = make_token(str(admin), iss=ISSUER + "/otro")

    response = call(shop, "GET", ADMIN_PATH, None, {"Authorization": f"Bearer {token}"})

    assert response.status_code == 401


# --------------------------------------------------------------------------------------------
# Inyección y caracteres de control (ASVS V5): `q`, `note`, `carrier`, `tracking_code`, entrega


def test_sql_looking_q_terms_match_only_literally_and_never_widen_the_list(
    shop: OrderShop,
) -> None:
    admin, user = admin_of(shop), shop.user()
    tag = "zqxjvwk"
    named_order(shop, user, f"{tag} O'Brien")
    named_order(shop, user, f"{tag} Pérez")

    def total(q: str) -> int:
        response = shop.client.get(ADMIN_PATH, headers=headers(admin), params={"q": q})
        assert response.status_code == 200, (q, response.text)
        return response.json()["total"]

    assert total(tag) == 2
    assert total(f"{tag} O'Brien") == 1  # la comilla es texto
    for payload in (
        f"{tag}' OR '1'='1",
        f"{tag}' OR 1=1 --",
        f"{tag}%",
        f"{tag}_",
        f"{tag}\\",
        f"{tag}'); DELETE FROM app.orders; --",
        "' OR '1'='1",
        "VAL-1 OR 1=1",
        "1; SELECT pg_sleep(5)",
    ):
        assert total(payload) == 0, payload
    assert total(tag) == 2  # nada se borró


def test_a_note_carrier_and_tracking_that_look_like_sql_or_html_are_stored_as_plain_text(
    shop: OrderShop,
) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    note = "'); DELETE FROM app.order_status_history; -- <script>alert(1)</script>"
    carrier = "<img src=x onerror=alert(1)>"
    tracking = "1' OR '1'='1"

    moved(shop, admin, order_id, "en_preparacion", note=note)
    body = moved(shop, admin, order_id, "enviado", carrier=carrier, tracking_code=tracking)

    assert body["delivery"]["carrier"] == carrier
    assert body["delivery"]["tracking_code"] == tracking
    assert [h["note"] for h in body["history"]][2] == note
    assert len(body["history"]) == 4  # el historial sigue entero


@pytest.mark.parametrize("field", ["carrier", "tracking_code"])
@pytest.mark.parametrize("value", ["\\u0000", "OL\\u0000123", "\\ud800"])
def test_a_nul_or_a_lone_surrogate_in_carrier_or_tracking_is_422_never_500(
    shop: OrderShop, field: str, value: str
) -> None:
    # §7 solo fija 1–60, pero un NUL o un sustituto suelto no caben en un `text` de PostgreSQL:
    # la única respuesta válida es 422 (como `note`, `q` y la entrega, R13), nunca un 500.
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    moved(shop, admin, order_id, "en_preparacion")
    before = fingerprint(shop.session, order_id)

    response = raw_post(
        shop,
        f"{ADMIN_PATH}/{order_id}/transitions",
        admin,
        f'{{"to": "enviado", "{field}": "{value}"}}',
    )

    assert response.status_code == 422, response.text
    assert code_of(response) == "validation_error"
    assert fingerprint(shop.session, order_id) == before


@pytest.mark.parametrize("value", ["\\ud800", "Motivo \\udfff interno"])
def test_a_lone_surrogate_in_the_note_is_422_never_500(shop: OrderShop, value: str) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    before = fingerprint(shop.session, order_id)

    response = raw_post(
        shop,
        f"{ADMIN_PATH}/{order_id}/transitions",
        admin,
        f'{{"to": "cancelado", "note": "{value}"}}',
    )

    assert response.status_code == 422, response.text
    assert fingerprint(shop.session, order_id) == before


@pytest.mark.parametrize("field", ["recipient_name", "address_line", "reference", "district"])
def test_a_lone_surrogate_in_a_delivery_field_is_422_on_that_field(
    shop: OrderShop, field: str
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    before = effects(shop.session, user, product)
    fields = {k: v for k, v in SHIPPING.items() if k != field}
    body = ", ".join(f'"{k}": "{v}"' for k, v in fields.items())

    response = raw_post(
        shop,
        PATH,
        user,
        f'{{"delivery": {{{body}, "{field}": "Ana \\ud800 Torres"}}}}',
        **{"Idempotency-Key": f"key-{uuid4().hex}"},
    )

    assert response.status_code == 422, response.text
    assert response.json()["error"]["details"][0]["loc"][-1] == field
    assert effects(shop.session, user, product) == before


# --------------------------------------------------------------------------------------------
# Manipulación de importes: la cancelación del cliente y del administrador no aceptan importes


def test_a_customer_cancel_with_a_refund_or_status_in_the_body_or_query_cancels_without_refund(
    shop: OrderShop,
) -> None:
    user, order_id, product = bought(shop)

    response = shop.client.post(
        f"{PATH}/{order_id}/cancel",
        headers=headers(user),
        params={"refund": "100000", "status": "pagado", "total": "1"},
        json={"refund": {"amount": 100000}, "refunded_amount": 100000, "status": "pagado"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["refund"] is None and response.json()["status"] == "cancelado"
    row = order_row(shop.session, order_id)
    assert (row["status"], row["refunded_amount"], row["refunded_at"]) == ("cancelado", None, None)
    assert [r["status"] for r in reservations(shop.session, order_id)] == ["released"]


def test_query_parameters_with_amounts_do_not_change_what_the_order_costs(
    shop: OrderShop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, price=1_234_567, on_hand=5)
    stock_in_cart(shop, user, (product, 2))

    response = place(shop, user, params={"total": "1", "price": "1", "shipping_amount": "-5"})

    assert response.status_code == 201, response.text
    row = order_row(shop.session, response.json()["id"])
    assert (row["subtotal_amount"], row["shipping_amount"], row["total_amount"]) == (
        2_469_134,
        0,
        2_469_134,
    )


@pytest.mark.parametrize(
    "body",
    [
        {"to": ["cancelado"], "note": "x"},
        {"to": "cancelado", "note": 123},
        {"to": "cancelado", "note": ["a"]},
        {"to": "enviado", "carrier": 5},
        {"to": None},
        "cancelado",
    ],
)
def test_type_confusion_in_the_transition_body_is_422_and_nothing_moves(
    shop: OrderShop, body: Any
) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)
    before = fingerprint(shop.session, order_id)

    response = post_transition(shop, admin, order_id, body)

    assert response.status_code == 422, response.text
    assert fingerprint(shop.session, order_id) == before


# --------------------------------------------------------------------------------------------
# Abuso de la clave de idempotencia (R8, R-4)


def test_the_same_key_with_another_delivery_returns_the_original_and_changes_nothing(
    shop: OrderShop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    key = "clave-abuso-0000000001"
    first = place(shop, user, key=key)
    assert first.status_code == 201, first.text
    stock_in_cart(shop, user, (add_listed(shop.session, on_hand=5), 1))  # carrito nuevo
    before = effects(shop.session, user, product)

    other = place(shop, user, key=key, delivery=PICKUP | {"recipient_name": "Otra Persona"})

    assert other.status_code == 200, other.text
    assert other.json() == first.json() | {"expires_in_seconds": other.json()["expires_in_seconds"]}
    assert other.json()["delivery"]["delivery_method"] == "shipping"  # R-4: el original
    assert effects(shop.session, user, product) == before  # ni pedido, ni reserva, ni carrito


def test_the_key_of_a_cancelled_order_returns_that_order_and_never_buys_again(
    shop: OrderShop,
) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    key = "clave-cancelada-000001"
    first = place(shop, user, key=key)
    assert shop.client.post(f"{PATH}/{first.json()['id']}/cancel", headers=headers(user)).is_success
    stock_in_cart(shop, user, (product, 1))  # vuelve a ponerlo en el carrito
    before = effects(shop.session, user, product)

    again = place(shop, user, key=key)

    assert again.status_code == 200 and again.json()["status"] == "cancelado"
    assert effects(shop.session, user, product) == before  # la reutilización no compra


def test_keys_differing_only_in_case_are_different_purchases(shop: OrderShop) -> None:
    user = shop.user()
    stock_in_cart(shop, user, (add_listed(shop.session, on_hand=5), 1))
    first = place(shop, user, key="CLAVE-MAYUS-00000001")
    stock_in_cart(shop, user, (add_listed(shop.session, on_hand=5), 1))
    second = place(shop, user, key="clave-mayus-00000001")

    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json()["id"] != second.json()["id"]


# --------------------------------------------------------------------------------------------
# Límites de tamaño y bordes del calendario: 422, nunca 500


@pytest.mark.parametrize("day", ["9999-12-31", "0001-01-01"])
@pytest.mark.parametrize("name", ["created_from", "created_to"])
def test_calendar_edge_dates_in_the_admin_filter_never_answer_500(
    shop: OrderShop, name: str, day: str
) -> None:
    admin = admin_of(shop)

    response = shop.client.get(ADMIN_PATH, headers=headers(admin), params={name: day})

    assert response.status_code in (200, 422), response.text
    assert "Traceback" not in response.text
    if response.status_code == 422:
        assert code_of(response) == "validation_error"


@pytest.mark.parametrize(
    "params",
    [{"page": "1" + "0" * 30}, {"page_size": "9" * 25}, {"page": "-1"}, {"page": "1e3"}],
)
def test_huge_or_odd_page_numbers_are_422_on_both_lists(
    shop: OrderShop, params: dict[str, str]
) -> None:
    for path, user in ((PATH, shop.user()), (ADMIN_PATH, admin_of(shop))):
        response = shop.client.get(path, headers=headers(user), params=params)
        assert response.status_code == 422, (path, response.text)


def test_a_megabyte_delivery_field_is_413_and_creates_nothing(shop: OrderShop) -> None:
    user = shop.user()
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))
    before = effects(shop.session, user, product)

    response = place(shop, user, delivery=SHIPPING | {"address_line": "A" * 1_000_000})

    # T-018a: el límite transversal (256 KiB) responde antes que la validación.
    assert response.status_code == 413, response.text[:300]
    assert response.json()["error"]["code"] == "payload_too_large"
    assert len(response.content) < 2_000  # el error no devuelve lo enviado
    assert effects(shop.session, user, product) == before


def test_a_body_with_thousands_of_extra_keys_is_422(shop: OrderShop) -> None:
    user = shop.user()
    extra = {f"campo_{n}": n for n in range(5_000)}

    response = place(shop, user, extra=extra)

    assert response.status_code == 422
    assert len(response.content) < 2_000_000


@pytest.mark.parametrize("size", [65, 10_000])
def test_an_oversized_idempotency_key_or_path_id_is_422(shop: OrderShop, size: int) -> None:
    user = shop.user()

    key = place(shop, user, key="k" * size)
    path = shop.client.get(f"{PATH}/{'a' * size}", headers=headers(user))

    assert key.status_code == path.status_code == 422


def test_a_note_of_ten_thousand_characters_is_422(shop: OrderShop) -> None:
    _, order_id, _ = paid(shop)
    admin = admin_of(shop)

    response = post_transition(shop, admin, order_id, {"to": "cancelado", "note": "x" * 10_000})

    assert response.status_code == 422
    assert order_row(shop.session, order_id)["status"] == "pagado"


# --------------------------------------------------------------------------------------------
# Datos personales: ni en un 500, ni en los logs de un recorrido completo, ni en la auditoría


def test_an_unexpected_error_is_a_generic_500_without_trace_body_or_personal_data(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    class Broken:
        def __call__(self, *args: object) -> None:
            raise RuntimeError("fallo inesperado")

    shop.override(get_create_order, Broken)
    user = shop.user()
    caplog.set_level(logging.DEBUG)

    response = place(shop, user)

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "internal_error",
            "message": "Error interno del servidor.",
            "details": None,
        }
    }
    assert "x-request-id" in response.headers
    for secret in PERSONAL:
        assert secret not in caplog.text and secret not in response.text


def test_a_whole_journey_logs_and_audits_no_personal_data_even_at_debug(
    shop: OrderShop, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    user, order_id, _ = paid(shop)
    admin = admin_of(shop)
    for to in ("en_preparacion", "enviado", "entregado"):
        moved(shop, admin, order_id, to)
    shop.client.get(PATH, headers=headers(user))
    shop.client.get(f"{PATH}/{order_id}", headers=headers(user))
    shop.client.get(ADMIN_PATH, headers=headers(admin), params={"q": "Ana"})
    admin_order(shop, admin, order_id)

    entries = audit_rows(shop.session, entity_id=order_id)
    assert len(entries) == 4  # creado y tres transiciones (el pago de `paid` audita en memoria)
    for secret in PERSONAL:
        assert secret not in caplog.text, secret
        assert all(secret not in str(entry) for entry in entries), secret


def test_errors_are_json_with_a_request_id_and_never_html(shop: OrderShop) -> None:
    user = shop.user()

    for response in (
        shop.client.get(f"{PATH}/{uuid4()}", headers=headers(user)),
        shop.client.get(f"{PATH}/no-uuid", headers=headers(user)),
        shop.client.get(ADMIN_PATH, headers=headers(user)),
        shop.client.get(PATH),
        shop.client.delete(f"{PATH}/{uuid4()}", headers=headers(user)),
    ):
        assert response.headers["content-type"] == "application/json"
        assert "x-request-id" in response.headers
        assert set(response.json()) == {"error"}
