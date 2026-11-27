"""`POST /api/v1/orders` exige 18 años cumplidos (T-139; CA-IDENTITY-15 y 16, IDENTITY-R9 y R13,
D-045) por HTTP contra PostgreSQL, con cart, inventory y `EnsureAdult` reales. La fecha de
nacimiento se escribe directamente en `app.profiles`. Cada solicitud corre en un SAVEPOINT de la
transacción de la prueba; un 409 lo deshace, así que "sin efectos" se comprueba contando filas
antes y después (y, sin red de seguridad, en `test_create_order_age_committed.py`).

Revisión de seguridad: orden de las comprobaciones, aislamiento por usuario (la identidad sale del
token, ningún parámetro la cambia), errores sin datos y la fecha ausente de respuestas, registros
y auditoría."""

import json
import logging
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.cart.cart_helpers import add_listed
from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_age_helpers import (
    ADULT_BIRTH,
    MINOR_BIRTH,
    birth_date_of,
    set_birth_date,
)
from tests.orders.orders_create_helpers import DETAIL_KEYS
from tests.orders.orders_http_helpers import (
    PICKUP,
    OrderShop,
    audit_rows,
    available,
    effects,
    order_row,
    place,
    quick,
    reservations,
    stock_in_cart,
)
from valmont.modules.orders.adapters.http import get_clock

pytestmark = pytest.mark.integration

shop = helpers.shop
MESSAGES = {
    "birth_date_required": "Indica tu fecha de nacimiento para comprar.",
    "underage": "Debes tener 18 años cumplidos para comprar.",
}
# La fecha del menor en las formas en que podría colarse en un texto.
DATE_FORMS = ("2012-03-04", "2012-3-4", "04/03/2012", "20120304", "2012, 3, 4", "4 de marzo")


def customer(shop: OrderShop, birth_date: date | None, quantity: int = 2) -> tuple[UUID, UUID]:
    """(cliente, producto en su carrito) con esta fecha de nacimiento (None: sin fecha)."""
    user, product = quick(shop, quantity=quantity)
    set_birth_date(shop.session, user, birth_date)
    return user, product


def rejected(response: Any, code: str) -> None:
    assert response.status_code == 409, response.text
    assert response.json() == {
        "error": {"code": code, "message": MESSAGES[code], "details": None}
    }, response.text


class FixedClock:
    def __init__(self, now: datetime) -> None:
        self.value = now

    def now(self) -> datetime:
        return self.value


def freeze(shop: OrderShop, at: str) -> None:
    now = datetime.fromisoformat(at).replace(tzinfo=UTC)
    shop.override(get_clock, lambda: FixedClock(now))


# --------------------------------------------------------------------------------------------
# CA-IDENTITY-15: sin fecha, menor, adulto
@pytest.mark.parametrize(
    ("born", "code"), [(None, "birth_date_required"), (MINOR_BIRTH, "underage")]
)
def test_without_a_date_or_as_a_minor_the_order_is_409_with_no_effects(
    shop: OrderShop, born: date | None, code: str
) -> None:
    user, product = customer(shop, born)
    before, stock = effects(shop.session, user, product), available(shop.session, product)

    response = place(shop, user)

    rejected(response, code)
    assert effects(shop.session, user, product) == before
    assert before["orders"] == 0 and before["reservations"] == 0 and before["audit"] == 0
    assert available(shop.session, product) == stock == 5
    assert before["cart"] == {product: (2, True)}  # el carrito sigue como estaba


@pytest.mark.parametrize("born", [None, MINOR_BIRTH])
def test_the_409_of_age_is_the_same_on_every_retry_and_still_changes_nothing(
    shop: OrderShop, born: date | None
) -> None:
    user, product = customer(shop, born)
    before = effects(shop.session, user, product)

    responses = [place(shop, user, key="clave-de-edad-0000001") for _ in range(3)]

    assert len({r.text for r in responses}) == 1
    assert {r.status_code for r in responses} == {409}
    assert effects(shop.session, user, product) == before


def test_an_adult_gets_201_exactly_as_before(shop: OrderShop) -> None:
    user, product = customer(shop, ADULT_BIRTH)

    response = place(shop, user)

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == DETAIL_KEYS and body["status"] == "pendiente_pago"
    row = order_row(shop.session, body["id"])
    assert row["user_id"] == user and row["status"] == "pendiente_pago"
    assert [r["quantity"] for r in reservations(shop.session, body["id"])] == [2]
    assert available(shop.session, product) == 3
    after = effects(shop.session, user, product)
    assert after["orders"] == 1 and after["cart"] == {} and after["audit"] == 1
    assert [r["action"] for r in audit_rows(shop.session, actor_id=user)] == ["orders.created"]


def test_the_adult_response_does_not_contain_the_birth_date(shop: OrderShop) -> None:
    user, _ = customer(shop, ADULT_BIRTH)

    response = place(shop, user)

    assert response.status_code == 201
    for form in ("1990-05-17", "1990-5-17", "17/05/1990", "19900517", "birth"):
        assert form not in response.text, form


@pytest.mark.parametrize("born", [date(1990, 5, 17), date(1900, 1, 1), date(2000, 2, 29)])
def test_any_adult_date_is_accepted(shop: OrderShop, born: date) -> None:
    user, _ = customer(shop, born)

    assert place(shop, user).status_code == 201


# --------------------------------------------------------------------------------------------
# CA-IDENTITY-16: orden de las comprobaciones
def test_a_minor_with_an_empty_cart_gets_underage_not_empty_selection(shop: OrderShop) -> None:
    user = shop.user()
    set_birth_date(shop.session, user, MINOR_BIRTH)

    rejected(place(shop, user), "underage")


def test_without_a_date_and_with_an_empty_cart_it_is_birth_date_required(shop: OrderShop) -> None:
    user = shop.user()
    set_birth_date(shop.session, user, None)

    rejected(place(shop, user), "birth_date_required")


def test_a_minor_choosing_pickup_without_a_boutique_gets_underage(shop: OrderShop) -> None:
    user, product = customer(shop, MINOR_BIRTH)
    shop.set_store()  # sin boutique configurada
    before = effects(shop.session, user, product)

    rejected(place(shop, user, delivery=PICKUP), "underage")

    assert effects(shop.session, user, product) == before


def test_an_adult_keeps_the_previous_errors_empty_cart_and_pickup_unavailable(
    shop: OrderShop,
) -> None:
    empty = shop.user()
    user, _ = customer(shop, ADULT_BIRTH)
    shop.set_store()

    assert place(shop, empty).json()["error"]["code"] == "empty_selection"
    assert place(shop, user, delivery=PICKUP).json()["error"]["code"] == "pickup_unavailable"


def test_a_minor_with_an_out_of_stock_cart_gets_underage_and_no_stock_is_read(
    shop: OrderShop,
) -> None:
    user, product = quick(shop, quantity=1, on_hand=0)
    set_birth_date(shop.session, user, MINOR_BIRTH)

    rejected(place(shop, user), "underage")


# --------------------------------------------------------------------------------------------
# R8: la repetición de una clave ya creada responde 200 sin comprobar la edad
@pytest.mark.parametrize("later", [None, MINOR_BIRTH])
def test_replaying_a_created_order_is_200_even_if_the_profile_no_longer_qualifies(
    shop: OrderShop, later: date | None
) -> None:
    user, product = customer(shop, ADULT_BIRTH)
    first = place(shop, user, key="clave-de-repeticion-001")
    assert first.status_code == 201
    set_birth_date(shop.session, user, later)  # p. ej. una corrección hecha por soporte
    before = effects(shop.session, user, product)

    replay = place(shop, user, key="clave-de-repeticion-001")

    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert effects(shop.session, user, product) == before


def test_the_key_of_someone_elses_order_does_not_return_it_to_a_minor(shop: OrderShop) -> None:
    adult, _ = customer(shop, ADULT_BIRTH)
    created = place(shop, adult, key="clave-compartida-00001")
    assert created.status_code == 201
    minor, product = customer(shop, MINOR_BIRTH)
    before = effects(shop.session, minor, product)

    response = place(shop, minor, key="clave-compartida-00001")

    rejected(response, "underage")
    assert created.json()["id"] not in response.text
    assert effects(shop.session, minor, product) == before


# --------------------------------------------------------------------------------------------
# Seguridad: la identidad sale del token; nada que envíe el cliente cambia la decisión
def test_each_customer_is_judged_by_their_own_profile(shop: OrderShop) -> None:
    adult, adult_product = customer(shop, ADULT_BIRTH)
    minor, minor_product = customer(shop, MINOR_BIRTH)
    nothing, _ = customer(shop, None)

    assert place(shop, adult).status_code == 201
    rejected(place(shop, minor), "underage")
    rejected(place(shop, nothing), "birth_date_required")
    assert effects(shop.session, adult, adult_product)["orders"] == 1
    assert effects(shop.session, minor, minor_product)["orders"] == 0
    assert birth_date_of(shop.session, minor) == MINOR_BIRTH  # nada se modificó


def test_a_minor_cannot_borrow_an_adults_identity_by_parameter_header_or_body(
    shop: OrderShop,
) -> None:
    adult, _ = customer(shop, ADULT_BIRTH)
    minor, product = customer(shop, MINOR_BIRTH)
    before = effects(shop.session, minor, product)

    by_query = place(shop, minor, params={"user_id": str(adult), "birth_date": "1990-05-17"})
    by_header = place(
        shop,
        minor,
        headers={"X-User-Id": str(adult), "X-Birth-Date": "1990-05-17", "X-Forwarded-User": "1"},
    )

    rejected(by_query, "underage")
    rejected(by_header, "underage")
    assert effects(shop.session, minor, product) == before


@pytest.mark.parametrize(
    "extra", [{"birth_date": "1990-05-17"}, {"age": 30}, {"is_adult": True}, {"adult": True}]
)
def test_a_birth_date_or_age_in_the_body_is_422_and_never_a_bypass(
    shop: OrderShop, extra: dict[str, Any]
) -> None:
    minor, product = customer(shop, MINOR_BIRTH)
    before = effects(shop.session, minor, product)

    response = place(shop, minor, extra=extra)

    assert response.status_code == 422, response.text
    assert effects(shop.session, minor, product) == before
    assert birth_date_of(shop.session, minor) == MINOR_BIRTH  # el cuerpo no escribe la fecha


def test_without_a_valid_token_the_answer_is_401_and_never_reveals_the_age(
    shop: OrderShop,
) -> None:
    customer(shop, MINOR_BIRTH)

    anonymous = place(shop, None)
    forged = place(shop, None, headers={"Authorization": "Bearer no-es-un-token"})

    assert anonymous.status_code == 401 and forged.status_code == 401
    assert "underage" not in anonymous.text + forged.text


def test_a_decision_is_made_with_the_database_value_not_a_cached_one(shop: OrderShop) -> None:
    user, _ = customer(shop, MINOR_BIRTH)
    rejected(place(shop, user, key="clave-sin-cache-000001"), "underage")

    set_birth_date(shop.session, user, ADULT_BIRTH)  # soporte corrige la fecha
    product = add_listed(shop.session, on_hand=5)
    stock_in_cart(shop, user, (product, 1))

    assert place(shop, user, key="clave-sin-cache-000002").status_code == 201


# --------------------------------------------------------------------------------------------
# Límite en Lima (UTC−5)
@pytest.mark.parametrize(
    ("now", "born", "code"),
    [
        ("2026-11-28T03:00:00", "2008-11-27", None),  # cumple 18 hoy (22:00 del 27 en Lima)
        ("2026-11-28T03:00:00", "2008-11-28", "underage"),  # los cumple mañana
        ("2026-11-28T04:59:59", "2008-11-28", "underage"),  # en UTC es 28; en Lima, 27
        ("2026-11-28T05:00:00", "2008-11-28", None),  # 00:00 del 28 en Lima
        ("2026-11-27T04:59:59", "2008-11-27", "underage"),
        ("2026-11-27T05:00:00", "2008-11-27", None),
    ],
)
def test_the_18th_birthday_counts_from_midnight_in_lima(
    shop: OrderShop, now: str, born: str, code: str | None
) -> None:
    user, product = customer(shop, date.fromisoformat(born))
    freeze(shop, now)
    before = effects(shop.session, user, product)

    response = place(shop, user)

    if code is None:
        assert response.status_code == 201, response.text
    else:
        rejected(response, code)
        assert effects(shop.session, user, product) == before


def test_with_the_real_database_clock_an_adult_passes_and_a_minor_does_not(
    shop: OrderShop,
) -> None:
    """Sin reloj falso: `SqlClock` devuelve la hora con zona de la BD y la regla funciona."""
    today = datetime.now(UTC).date()
    older, _ = customer(shop, date(today.year - 20, today.month, 1))
    younger, _ = customer(shop, date(today.year - 17, today.month, 1))

    assert place(shop, older).status_code == 201
    rejected(place(shop, younger), "underage")


# --------------------------------------------------------------------------------------------
# Privacidad: la fecha no aparece en respuestas, registros ni auditoría
@pytest.mark.parametrize("outcome", ["underage", "missing", "created", "replay"])
def test_the_birth_date_never_reaches_responses_logs_or_the_audit_trail(
    shop: OrderShop, caplog: pytest.LogCaptureFixture, outcome: str
) -> None:
    caplog.set_level(logging.DEBUG)
    born = {"underage": MINOR_BIRTH, "missing": None}.get(outcome, date(2005, 3, 4))
    user, _ = customer(shop, born)
    responses = [place(shop, user, key="clave-de-privacidad-001")]
    if outcome == "replay":
        responses.append(place(shop, user, key="clave-de-privacidad-001"))

    everything = [r.text for r in responses] + [caplog.text]
    audit = shop.session.execute(text("SELECT before, after FROM app.audit_log")).all()
    everything += [json.dumps(list(row), default=str) for row in audit]
    forms = (*DATE_FORMS, "2005-03-04", "04/03/2005", "20050304", "2005, 3, 4")
    for blob in everything:
        for form in forms:
            assert form not in blob, form
    for response in responses:
        assert "birth" not in response.text.replace("birth_date_required", "")
    assert not any("underage" in r.message or "birth" in r.message.lower() for r in caplog.records)


@pytest.mark.parametrize("born", [None, MINOR_BIRTH])
def test_the_age_rejection_leaves_no_audit_row_for_anyone(
    shop: OrderShop, born: date | None
) -> None:
    user, _ = customer(shop, born)
    rows_before = shop.session.scalar(text("SELECT count(*) FROM app.audit_log"))

    rejected(place(shop, user), "birth_date_required" if born is None else "underage")

    assert shop.session.scalar(text("SELECT count(*) FROM app.audit_log")) == rows_before
    assert audit_rows(shop.session, actor_id=user) == []


def test_the_errors_have_no_stack_trace_internal_names_or_a_number_of_years(
    shop: OrderShop,
) -> None:
    minor, _ = customer(shop, MINOR_BIRTH)
    none, _ = customer(shop, None)

    for user in (minor, none):
        body = place(shop, user).text
        for leak in ("Traceback", "sqlalchemy", "profiles", "valmont.", 'File "', "14 años"):
            assert leak not in body, leak


# --------------------------------------------------------------------------------------------
# CA-IDENTITY-18: la validación de la entrada (422) va antes que la edad (409)
@pytest.mark.parametrize("born", [None, MINOR_BIRTH])
@pytest.mark.parametrize(
    "bad",
    [
        {"delivery": {"delivery_method": "teleport"}},
        {"delivery": {**PICKUP, "phone": "x"}},
        {"delivery": None},
        {},
    ],
)
def test_an_invalid_body_is_422_before_the_age_is_judged(
    shop: OrderShop, born: date | None, bad: dict[str, Any]
) -> None:
    user, product = customer(shop, born)
    before = effects(shop.session, user, product)

    response = helpers.post_raw(shop, user, bad)

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert effects(shop.session, user, product) == before


@pytest.mark.parametrize("born", [None, MINOR_BIRTH])
@pytest.mark.parametrize("key", [None, "corta", "con espacios no vale 0123456789"])
def test_a_missing_or_malformed_idempotency_key_is_422_before_the_age_is_judged(
    shop: OrderShop, born: date | None, key: str | None
) -> None:
    user, _ = customer(shop, born)

    response = place(shop, user, key=key)

    assert response.status_code == 422, response.text
