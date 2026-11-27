"""El puerto de pasarela por HTTP (T-094; CA-PAYMENTS-12, R11): con una pasarela falsa inyectada en
el proveedor `get_payment_gateway`, la ruta produce los mismos resultados sin tocar orders, el
router ni el esquema; el nombre de la pasarela se guarda en el intento; y los proveedores del
módulo componen lo documentado. La app real contra PostgreSQL en la transacción de la `shop`."""

import inspect
from typing import Any, get_args, get_type_hints

import pytest
from sqlalchemy.orm import Session

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_http_helpers import OrderShop, on_hand
from tests.payments.pay_order_helpers import (
    attempt_rows,
    pay,
    payment_audit,
    placed_order,
    rolling_back_shop,
    sales,
    status_of,
)
from valmont.modules.payments.adapters.http import (
    get_pay_order,
    get_payment_attempts,
    get_payment_gateway,
)
from valmont.modules.payments.adapters.persistence import SqlPaymentAttemptRepository
from valmont.modules.payments.adapters.simulated_gateway import SimulatedGateway
from valmont.modules.payments.application import (
    GatewayCharge,
    GatewayResult,
    PaymentGateway,
    PayOrder,
)
from valmont.modules.payments.domain import FailureCode, GatewayUnavailable

pytestmark = pytest.mark.integration

orders_shop = helpers.shop
shop = rolling_back_shop


class ScriptedGateway:
    """Una pasarela de otro proveedor: nombre propio y resultado a medida."""

    name = "otro-proveedor"

    def __init__(self, failure: FailureCode | None = None, down: bool = False) -> None:
        self.failure = failure
        self.down = down
        self.charges: list[GatewayCharge] = []

    def authorize(self, charge: GatewayCharge) -> GatewayResult:
        self.charges.append(charge)
        if self.down:
            raise GatewayUnavailable
        return GatewayResult(self.failure)


def install(shop: OrderShop, gateway: ScriptedGateway) -> ScriptedGateway:
    port: PaymentGateway = gateway
    shop.override(get_payment_gateway, lambda: port)
    return gateway


def test_the_default_gateway_provider_is_the_simulated_one() -> None:
    gateway = get_payment_gateway()

    assert isinstance(gateway, SimulatedGateway) and gateway.name == "simulated"


def test_the_provider_takes_no_parameters_so_swapping_it_changes_nothing_else() -> None:
    assert list(inspect.signature(get_payment_gateway).parameters) == []


def test_the_attempts_provider_builds_the_sql_repository_on_the_request_session(
    db_session: Session,
) -> None:
    repository = get_payment_attempts(db_session)

    assert isinstance(repository, SqlPaymentAttemptRepository)


def test_the_pay_order_provider_returns_the_use_case() -> None:
    hints = get_type_hints(get_pay_order, include_extras=True)

    assert hints["return"] is PayOrder
    types = {get_args(h)[0] for k, h in hints.items() if k != "return" and get_args(h)}
    assert PaymentGateway in types


def test_an_approving_foreign_gateway_pays_and_its_name_is_stored(shop: OrderShop) -> None:
    gateway = install(shop, ScriptedGateway())
    p = placed_order(shop, quantity=2, on_hand=5)

    response = pay(shop, p.user, p.order_id, "5555")

    assert response.status_code == 201 and response.json()["status"] == "approved"
    [row] = attempt_rows(shop.session, p.order_id)
    assert row["gateway"] == "otro-proveedor"
    assert status_of(shop.session, p.order_id) == "pagado"
    assert on_hand(shop.session, p.product) == 3
    [charge] = gateway.charges
    assert charge.amount == p.total and charge.method.card_last4 == "5555"


@pytest.mark.parametrize(
    "failure",
    [FailureCode.CARD_DECLINED, FailureCode.INSUFFICIENT_FUNDS, FailureCode.EXPIRED_CARD],
)
def test_a_foreign_gateway_rejection_with_each_code_is_recorded_without_touching_the_order(
    shop: OrderShop, failure: FailureCode
) -> None:
    install(shop, ScriptedGateway(failure))
    p = placed_order(shop, on_hand=5)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 201, response.text
    assert (response.json()["status"], response.json()["failure_code"]) == (
        "rejected",
        failure.value,
    )
    assert status_of(shop.session, p.order_id) == "pendiente_pago"
    assert sales(shop.session, p.order_id) == [] and on_hand(shop.session, p.product) == 5
    assert attempt_rows(shop.session, p.order_id)[0]["gateway"] == "otro-proveedor"


def test_a_foreign_gateway_outage_is_the_same_503_with_no_effect(shop: OrderShop) -> None:
    install(shop, ScriptedGateway(down=True))
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "4242")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "payment_gateway_unavailable"
    assert attempt_rows(shop.session, p.order_id) == []
    assert payment_audit(shop.session, p.user) == []
    assert status_of(shop.session, p.order_id) == "pendiente_pago"


def test_the_real_card_digits_do_not_decide_the_result_when_the_gateway_is_another(
    shop: OrderShop,
) -> None:
    install(shop, ScriptedGateway())  # aprueba siempre
    p = placed_order(shop)

    response = pay(shop, p.user, p.order_id, "0002")  # con el simulado sería un rechazo

    assert response.status_code == 201 and response.json()["status"] == "approved"


def test_the_gateway_never_receives_more_than_the_charge(shop: OrderShop) -> None:
    gateway = install(shop, ScriptedGateway())
    p = placed_order(shop)

    pay(shop, p.user, p.order_id, "4242")

    [charge] = gateway.charges
    attributes: Any = vars(charge)
    assert set(attributes) == {"reference", "amount", "method"}
    assert set(vars(charge.method)) == {"card_last4"}
