"""El pago no comprueba la edad (T-139; D-045, P-IDENTITY-8 opción A): la mayoría de edad se exige
solo al crear el pedido. Un pedido que ya existe se paga aunque el perfil de su dueño ya no cumpla
(la fecha es inmodificable por el cliente; una corrección de soporte no invalida lo comprado).
Payments no importa nada de la edad ni de identity para esto. PostgreSQL real."""

import ast
from pathlib import Path

import pytest

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_age_helpers import MINOR_BIRTH, set_birth_date
from tests.orders.orders_http_helpers import OrderShop, order_row
from tests.payments.pay_order_helpers import (
    attempt_rows,
    pay,
    placed_order,
    rolling_back_shop,
    status_of,
)

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop

PAYMENTS = Path(__file__).resolve().parents[2] / "src" / "valmont" / "modules" / "payments"


@pytest.mark.parametrize("later", [None, MINOR_BIRTH])
def test_an_order_created_by_an_adult_is_paid_even_if_the_profile_no_longer_qualifies(
    shop: OrderShop, later: object
) -> None:
    p = placed_order(shop)
    set_birth_date(shop.session, p.user, later)  # type: ignore[arg-type]

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "approved"
    assert status_of(shop.session, p.order_id) == "pagado"
    assert order_row(shop.session, p.order_id)["paid_at"] is not None
    assert len(attempt_rows(shop.session, p.order_id)) == 1


def test_a_rejected_card_never_answers_with_an_age_error(shop: OrderShop) -> None:
    p = placed_order(shop)
    set_birth_date(shop.session, p.user, MINOR_BIRTH)

    response = pay(shop, p.user, p.order_id, "0002")

    assert response.status_code != 409 or response.json()["error"]["code"] not in (
        "underage",
        "birth_date_required",
    )
    assert "underage" not in response.text and "birth_date" not in response.text


AGE_NAMES = {"EnsureAdult", "Underage", "BirthDateRequired", "get_ensure_adult"}


def test_payments_code_does_not_use_the_age_check() -> None:
    offenders = []
    for path in PAYMENTS.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text("utf-8"))):
            imported = {a.name for a in node.names} if isinstance(node, ast.ImportFrom) else set()
            used = {node.id} if isinstance(node, ast.Name) else set()
            if (imported | used) & AGE_NAMES:
                offenders.append(path.name)

    assert offenders == []
