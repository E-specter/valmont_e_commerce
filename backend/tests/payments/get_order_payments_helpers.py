"""Ayudantes de las pruebas de `GetOrderPayments` y `GET /api/v1/payments/orders/{id}/attempts`
(T-095; CA-PAYMENTS-08 parte GET, 09, 11 y 16; SPEC §3 UC-02, §4 R8, R9, R15 y §7). Reutilizan los
de T-094 (`pay_order_helpers`, `payments_db_helpers`). Datos ficticios."""

from typing import Any
from uuid import UUID

from tests.identity.identity_helpers import make_token
from tests.orders.orders_http_helpers import OrderShop
from tests.payments.pay_order_helpers import ORDER, USER, FakeAttempts, FakeOrders, pay_path
from valmont.modules.orders.domain import OrderStatus
from valmont.modules.payments.application import GetOrderPayments
from valmont.modules.payments.domain import PaymentAttempt

OUT_KEYS = {"order_id", "can_pay", "attempts_left", "attempts"}
ALL_ORDER_STATUSES = list(OrderStatus)


def get_attempts(
    shop: OrderShop,
    user: UUID | None,
    order_id: object,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
) -> Any:
    """GET de los intentos. `user=None` omite el token."""
    sent: dict[str, str] = {}
    if user is not None:
        sent["Authorization"] = f"Bearer {make_token(str(user))}"
    sent.update(headers or {})
    return shop.client.get(pay_path(order_id), headers=sent, params=params)


# --------------------------------------------------------------------------------------------
# Casos de uso con falsos (sin BD)


class Read:
    """`GetOrderPayments` con los falsos de T-094: el repositorio y el puerto de orders."""

    def __init__(
        self,
        rows: tuple[PaymentAttempt, ...] = (),
        *,
        rejected: int | None = None,
        status: OrderStatus = OrderStatus.PENDING_PAYMENT,
    ) -> None:
        self.calls: list[str] = []
        self.attempts = FakeAttempts(self.calls, rows, rejected=rejected)
        self.orders = FakeOrders(self.calls, status)
        self.use_case = GetOrderPayments(self.attempts, self.orders.get_payable)  # type: ignore[arg-type]

    def __call__(self, user: UUID = USER, order: UUID = ORDER) -> Any:
        return self.use_case(user, order)
