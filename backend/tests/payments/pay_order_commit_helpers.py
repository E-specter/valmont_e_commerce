"""Ayudantes de las pruebas de `POST /payments/.../attempts` con transacciones reales (T-094): cada
solicitud HTTP abre y **confirma** su propia transacción en valmont_test (como la app), y los datos
de cada prueba se confirman y se borran al final (los intentos primero: sus FK son RESTRICT).
La auditoría de las solicitudes va a memoria: `app.audit_log` no admite DELETE. Datos ficticios."""

from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.orders.orders_payment_helpers import use_cases
from tests.orders.test_create_order_concurrency import World
from tests.orders.test_http_concurrency import Api
from tests.payments.pay_order_helpers import pay_path
from tests.payments.payments_db_helpers import new_key
from valmont.modules.payments.adapters.persistence import SqlPaymentAttemptRepository
from valmont.modules.payments.adapters.simulated_gateway import SimulatedGateway
from valmont.modules.payments.application import PaymentGateway, PaymentResult, PayOrder
from valmont.modules.payments.domain import PaymentMethod


class PayApi(Api):
    """La app real, con `pay` y la posibilidad de cambiar la pasarela."""

    def pay(self, user: UUID, order_id: object, last4: str = "4242", key: str | None = None) -> Any:
        sent = self.auth(user) | {"Idempotency-Key": key or new_key()}
        return self.client.post(pay_path(order_id), headers=sent, json={"card_last4": last4})

    def read_orders(self, user: UUID) -> Any:
        return self.client.get("/api/v1/orders", headers=self.auth(user))

    def payment_entries(self) -> list[Any]:
        return [e for e in self.audit.entries if e.action == "payments.attempt_recorded"]

    def entries_of(self, action: str) -> list[Any]:
        return [e for e in self.audit.entries if e.action == action]


def committed_pay_world(engine: Engine) -> Iterator[World]:
    """Cuerpo del fixture `world`: borra al final intentos, movimientos y todo lo demás."""
    made = World(engine)
    yield made
    with Session(engine) as session, session.begin():
        session.execute(
            text("DELETE FROM app.payment_attempts WHERE user_id = ANY(:u)"), {"u": made.users}
        )
        session.execute(
            text("DELETE FROM app.stock_movements WHERE product_id = ANY(:p)"),
            {"p": made.products},
        )
    made.cleanup()


def attempts_of_order(engine: Engine, order_id: UUID) -> list[tuple[str, str | None, str]]:
    """(status, failure_code, gateway) de los intentos confirmados del pedido."""
    with Session(engine) as session:
        rows = session.execute(
            text(
                "SELECT status, failure_code, gateway FROM app.payment_attempts"
                " WHERE order_id = :o ORDER BY created_at, id"
            ),
            {"o": order_id},
        ).all()
    return [(r.status, r.failure_code, r.gateway) for r in rows]


def approved_of(engine: Engine, order_id: UUID) -> int:
    return sum(1 for status, _, _ in attempts_of_order(engine, order_id) if status == "approved")


def hold_pay(
    user: UUID,
    order_id: UUID,
    last4: str = "4242",
    key: str | None = None,
    gateway: PaymentGateway | None = None,
) -> Callable[[Session], PaymentResult]:
    """Un pago completo con los adaptadores reales (la auditoría en memoria) dentro de la
    transacción que `holding` o `race` mantienen abierta: bloquea el pedido hasta confirmar."""

    def work(session: Session) -> PaymentResult:
        confirm, get_payable, _, audit = use_cases(session)
        use_case = PayOrder(
            SqlPaymentAttemptRepository(session),
            gateway or SimulatedGateway(),
            get_payable,
            confirm,
            audit,  # type: ignore[arg-type]
        )
        return use_case(user, order_id, key or new_key(), PaymentMethod(last4))

    return work


def no_500(*responses: Any) -> None:
    for response in responses:
        assert response.status_code < 500, response.text
