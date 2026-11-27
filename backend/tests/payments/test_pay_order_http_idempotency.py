"""Idempotencia (RF05.03) y tope de rechazos de `POST /api/v1/payments/orders/{id}/attempts` (T-094;
CA-PAYMENTS-03 y 09; SPEC §4 R3 y R9) con la app real contra PostgreSQL, en la transacción de la
fixture `shop` de orders (se deshace al terminar). Datos ficticios."""

from uuid import UUID

import pytest
from sqlalchemy import text

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import OrderShop, on_hand
from tests.orders.orders_read_helpers import set_status
from tests.payments.pay_order_helpers import (
    DECLINED,
    DOWN,
    another_order,
    attempt_rows,
    pay,
    payment_audit,
    placed_order,
    rolling_back_shop,
    sales,
    spy,
    status_of,
)
from tests.payments.payments_db_helpers import insert_attempt_row, new_key, rejected_row

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop


def code_of(response: object) -> str:
    return response.json()["error"]["code"]  # type: ignore[attr-defined]


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-03: la misma clave devuelve el mismo intento


def test_repeating_an_approved_payment_with_the_same_key_is_200_with_the_same_attempt(
    shop: OrderShop,
) -> None:
    gateway = spy(shop)
    p = placed_order(shop, quantity=2, on_hand=5)
    key = new_key()
    first = pay(shop, p.user, p.order_id, "4242", key=key)

    second = pay(shop, p.user, p.order_id, "4242", key=key)

    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json() == first.json()
    assert len(attempt_rows(shop.session, p.order_id)) == 1
    assert len(gateway.charges) == 1  # una sola llamada a la pasarela
    assert on_hand(shop.session, p.product) == 3 and len(sales(shop.session, p.order_id)) == 1
    assert len(payment_audit(shop.session, p.user)) == 1


def test_repeating_a_rejected_payment_with_the_same_key_is_200_with_the_same_rejection(
    shop: OrderShop,
) -> None:
    gateway = spy(shop)
    p = placed_order(shop)
    key = new_key()
    first = pay(shop, p.user, p.order_id, DECLINED, key=key)

    second = pay(shop, p.user, p.order_id, DECLINED, key=key)

    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json() == first.json() and second.json()["status"] == "rejected"
    assert len(attempt_rows(shop.session, p.order_id)) == 1 and len(gateway.charges) == 1
    assert len(payment_audit(shop.session, p.user)) == 1


def test_many_repetitions_still_leave_one_attempt_one_charge_and_one_audit(
    shop: OrderShop,
) -> None:
    gateway = spy(shop)
    p = placed_order(shop, quantity=1, on_hand=5)
    key = new_key()

    codes = [pay(shop, p.user, p.order_id, "4242", key=key).status_code for _ in range(5)]

    assert codes == [201, 200, 200, 200, 200]
    assert len(attempt_rows(shop.session, p.order_id)) == 1 and len(gateway.charges) == 1
    assert on_hand(shop.session, p.product) == 4
    assert len(payment_audit(shop.session, p.user)) == 1


def test_the_same_key_with_another_card_returns_the_original_attempt(shop: OrderShop) -> None:
    # Limitación aceptada (R3): no se compara la huella de la solicitud.
    p = placed_order(shop)
    key = new_key()
    first = pay(shop, p.user, p.order_id, DECLINED, key=key)

    second = pay(shop, p.user, p.order_id, "4242", key=key)

    assert second.status_code == 200 and second.json() == first.json()
    assert second.json()["status"] == "rejected" and second.json()["card_last4"] == DECLINED
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


def test_a_repeated_key_answers_200_even_after_the_order_was_paid_by_that_attempt(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    key = new_key()
    first = pay(shop, p.user, p.order_id, "4242", key=key)
    assert status_of(shop.session, p.order_id) == "pagado"

    second = pay(shop, p.user, p.order_id, "4242", key=key)

    assert second.status_code == 200 and second.json()["id"] == first.json()["id"]


def test_a_repeated_key_answers_200_when_the_order_was_later_cancelled(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()
    first = pay(shop, p.user, p.order_id, DECLINED, key=key)
    set_status(shop.session, p.order_id, "cancelado")

    second = pay(shop, p.user, p.order_id, DECLINED, key=key)

    assert second.status_code == 200 and second.json()["id"] == first.json()["id"]


def test_a_new_key_after_a_rejection_creates_a_new_attempt(shop: OrderShop) -> None:
    p = placed_order(shop)
    first = pay(shop, p.user, p.order_id, DECLINED)

    second = pay(shop, p.user, p.order_id, DECLINED)

    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json()["id"] != second.json()["id"]
    assert len(attempt_rows(shop.session, p.order_id)) == 2


def test_the_same_key_of_two_customers_creates_two_independent_attempts(shop: OrderShop) -> None:
    one, two = placed_order(shop), placed_order(shop)
    key = new_key()

    first = pay(shop, one.user, one.order_id, "4242", key=key)
    second = pay(shop, two.user, two.order_id, "4242", key=key)

    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json()["id"] != second.json()["id"]
    assert len(attempt_rows(shop.session, one.order_id)) == 1
    assert len(attempt_rows(shop.session, two.order_id)) == 1
    assert (
        status_of(shop.session, one.order_id) == status_of(shop.session, two.order_id) == "pagado"
    )


def test_a_key_of_another_customer_is_never_returned_to_a_stranger(shop: OrderShop) -> None:
    owner, stranger = placed_order(shop), placed_order(shop)
    key = new_key()
    owned = pay(shop, owner.user, owner.order_id, "4242", key=key).json()

    # El otro cliente usa la misma clave sobre SU pedido: obtiene su propio intento, no el ajeno.
    mine = pay(shop, stranger.user, stranger.order_id, "4242", key=key)

    assert mine.status_code == 201 and mine.json()["id"] != owned["id"]
    assert mine.json()["order_id"] == str(stranger.order_id)


def test_the_same_key_on_another_order_of_the_same_customer_is_409_key_reused(
    shop: OrderShop,
) -> None:
    gateway = spy(shop)
    p = placed_order(shop, price=100_000)
    other = another_order(shop, p.user, price=200_000)
    key = new_key()
    first = pay(shop, p.user, p.order_id, DECLINED, key=key)
    charges = len(gateway.charges)

    second = pay(shop, p.user, other, "4242", key=key)

    assert first.status_code == 201
    assert second.status_code == 409 and code_of(second) == "idempotency_key_reused"
    assert attempt_rows(shop.session, other) == []
    assert status_of(shop.session, other) == "pendiente_pago"
    assert len(gateway.charges) == charges  # ni siquiera llegó a la pasarela
    assert len(payment_audit(shop.session, p.user)) == 1


def test_a_503_leaves_the_key_free_for_a_retry_with_the_same_key(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()

    down = pay(shop, p.user, p.order_id, DOWN, key=key)
    retry = pay(shop, p.user, p.order_id, "4242", key=key)

    assert (down.status_code, retry.status_code) == (503, 201)
    assert len(attempt_rows(shop.session, p.order_id)) == 1


# --- cabecera Idempotency-Key ---------------------------------------------------------------


def test_the_header_is_required(shop: OrderShop) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242", key=None)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert response.json()["error"]["details"][0]["loc"] == ["header", "idempotency-key"]
    assert attempt_rows(shop.session, p.order_id) == []


@pytest.mark.parametrize(
    "key",
    [
        "a" * 15,
        "a" * 65,
        "clave con espacios " + "x" * 10,
        "clave;" + "x" * 14,
        "clave\t" + "x" * 14,
        "'; DROP TABLE app.orders; --",
        "x" * 16 + "\n",
    ],
    ids=["15", "65", "espacios", "punto-y-coma", "tab", "sql", "salto-de-linea"],
)
def test_a_key_that_is_not_a_uuid_is_422(shop: OrderShop, key: str) -> None:
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242", key=key)

    assert response.status_code == 422, response.text
    assert response.json()["error"]["details"][0]["loc"] == ["header", "idempotency-key"]
    assert attempt_rows(shop.session, p.order_id) == []
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-09: tope de rechazos


def reject_n(shop: OrderShop, user: UUID, order_id: UUID, times: int) -> list[str]:
    ids: list[str] = []
    for _ in range(times):
        response = pay(shop, user, order_id, DECLINED)
        assert response.status_code == 201 and response.json()["status"] == "rejected"
        ids.append(response.json()["id"])
    return ids


def test_after_five_rejections_the_sixth_attempt_is_409_too_many_attempts_with_the_max(
    shop: OrderShop,
) -> None:
    gateway = spy(shop)
    p = placed_order(shop)
    reject_n(shop, p.user, p.order_id, 5)
    charges = len(gateway.charges)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409, response.text
    assert code_of(response) == "too_many_attempts"
    assert response.json()["error"]["details"] == {"max": 5}
    assert len(attempt_rows(shop.session, p.order_id)) == 5  # sin intento nuevo
    assert len(gateway.charges) == charges  # no se cobra
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert len(payment_audit(shop.session, p.user)) == 5


def test_the_fifth_attempt_still_goes_through_and_four_rejections_do_not_block(
    shop: OrderShop,
) -> None:
    p = placed_order(shop, quantity=1, on_hand=5)
    reject_n(shop, p.user, p.order_id, 4)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"
    assert on_hand(shop.session, p.product) == 4


def test_the_fifth_rejection_is_still_a_201_and_blocks_the_next_one(shop: OrderShop) -> None:
    p = placed_order(shop)
    reject_n(shop, p.user, p.order_id, 4)

    fifth = pay(shop, p.user, p.order_id, DECLINED)
    sixth = pay(shop, p.user, p.order_id, DECLINED)

    assert (fifth.status_code, sixth.status_code) == (201, 409)


def test_at_the_limit_a_known_key_is_still_answered_with_200(shop: OrderShop) -> None:
    p = placed_order(shop)
    key = new_key()
    first = pay(shop, p.user, p.order_id, DECLINED, key=key)
    reject_n(shop, p.user, p.order_id, 4)
    assert pay(shop, p.user, p.order_id, "4242").status_code == 409

    again = pay(shop, p.user, p.order_id, DECLINED, key=key)

    assert again.status_code == 200 and again.json() == first.json()


def test_the_limit_is_checked_before_the_gateway_so_even_a_down_card_is_409(
    shop: OrderShop,
) -> None:
    p = placed_order(shop)
    reject_n(shop, p.user, p.order_id, 5)

    response = pay(shop, p.user, p.order_id, DOWN)

    assert response.status_code == 409 and code_of(response) == "too_many_attempts"


def test_order_expired_attempts_do_not_count_for_the_limit(shop: OrderShop) -> None:
    p = placed_order(shop)
    for _ in range(4):
        rejected_row(shop.session, p.order_id, p.user, "card_declined")
    for _ in range(3):
        rejected_row(shop.session, p.order_id, p.user, "order_expired")

    fifth = pay(shop, p.user, p.order_id, DECLINED)  # 5.º rechazo real: aún se registra
    sixth = pay(shop, p.user, p.order_id, "4242")

    assert fifth.status_code == 201 and fifth.json()["status"] == "rejected"
    assert sixth.status_code == 409 and code_of(sixth) == "too_many_attempts"


def test_only_order_expired_rows_never_block_the_order(shop: OrderShop) -> None:
    p = placed_order(shop)
    for _ in range(8):
        rejected_row(shop.session, p.order_id, p.user, "order_expired")

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"


def test_approved_rows_do_not_count_as_rejections(shop: OrderShop) -> None:
    p = placed_order(shop)
    other = another_order(shop, p.user)
    insert_attempt_row(shop.session, other, p.user)  # un aprobado de otro pedido
    reject_n(shop, p.user, p.order_id, 4)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"


def test_the_limit_is_per_order_not_per_customer(shop: OrderShop) -> None:
    p = placed_order(shop, price=100_000)
    other = another_order(shop, p.user, price=200_000)
    reject_n(shop, p.user, p.order_id, 5)

    response = pay(shop, p.user, other, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"


def test_a_cancelled_order_at_the_limit_is_not_payable_not_too_many(shop: OrderShop) -> None:
    p = placed_order(shop)
    reject_n(shop, p.user, p.order_id, 5)
    set_status(shop.session, p.order_id, "cancelado")

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409 and code_of(response) == "order_not_payable"
    assert response.json()["error"]["details"] == {"status": "cancelado"}


def test_a_paid_order_at_the_limit_is_already_paid_not_too_many(shop: OrderShop) -> None:
    p = placed_order(shop)
    reject_n(shop, p.user, p.order_id, 5)
    set_status(shop.session, p.order_id, "pagado")

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 409 and code_of(response) == "order_already_paid"


def test_the_rejections_of_other_customers_never_count(shop: OrderShop) -> None:
    mine, theirs = placed_order(shop), placed_order(shop)
    reject_n(shop, theirs.user, theirs.order_id, 5)

    response = pay(shop, mine.user, mine.order_id, "4242")

    assert response.status_code == 201 and response.json()["status"] == "approved"
    assert (
        shop.session.scalar(
            text("SELECT count(*) FROM app.payment_attempts WHERE order_id = :o"),
            {"o": mine.order_id},
        )
        == 1
    )
