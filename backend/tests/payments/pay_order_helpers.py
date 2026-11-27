"""Ayudantes de las pruebas de `PayOrder` y `POST /api/v1/payments/orders/{id}/attempts` (T-094).

Tres partes:
- falsos para los casos de uso (repositorio de intentos, pasarela, puertos de orders, auditoría)
  con ids fijos, para que ningún id aleatorio contenga por casualidad los 4 dígitos de prueba;
- cliente HTTP real contra PostgreSQL (la fixture `shop` de orders: cada solicitud en un SAVEPOINT
  de la transacción de la prueba) con una pasarela espía;
- lecturas de la BD tras cada solicitud (intentos, pedido, stock, reservas, auditoría).

Datos ficticios. Ningún valor se parece a un secreto real."""

import itertools
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_listed
from tests.identity.identity_helpers import make_token
from tests.orders.orders_http_helpers import OrderShop, audit_rows, place, stock_in_cart
from tests.payments.payments_db_helpers import new_key
from valmont.modules.orders.application import PayableOrder, PaymentOutcome
from valmont.modules.orders.domain import OrderNotFound, OrderStatus
from valmont.modules.payments.adapters.http import get_payment_gateway
from valmont.modules.payments.adapters.simulated_gateway import SimulatedGateway
from valmont.modules.payments.application import (
    GatewayCharge,
    GatewayResult,
    PaymentGateway,
    PayOrder,
)
from valmont.modules.payments.domain import (
    AttemptStatus,
    FailureCode,
    OrderAlreadyPaid,
    PaymentAttempt,
    PaymentMethod,
    new_attempt,
)
from valmont.shared.db import get_session

PAY_ROOT = "/api/v1/payments"
ATTEMPT_KEYS = {"id", "order_id", "status", "failure_code", "amount", "card_last4", "created_at"}
# Resultado de la pasarela simulada por `card_last4` (D-043, SPEC R12).
DECLINED, NO_FUNDS, EXPIRED_CARD, DOWN = "0002", "9995", "0069", "0119"
REJECTIONS = [
    (DECLINED, "card_declined"),
    (NO_FUNDS, "insufficient_funds"),
    (EXPIRED_CARD, "expired_card"),
]
PAID_STATES = ("pagado", "en_preparacion", "enviado", "listo_para_recojo", "entregado")


def pay_path(order_id: object) -> str:
    return f"{PAY_ROOT}/orders/{order_id}/attempts"


# --------------------------------------------------------------------------------------------
# Falsos para los casos de uso (sin BD)

USER = UUID("00000000-0000-4000-8000-0000000000a1")
STRANGER = UUID("00000000-0000-4000-8000-0000000000a2")
ORDER = UUID("00000000-0000-4000-8000-0000000000b1")
OTHER_ORDER = UUID("00000000-0000-4000-8000-0000000000b2")
KEY = "pay-0123456789abcdef0123456789abcdef"
OTHER_KEY = "pay-fedcba9876543210fedcba9876543210"
TOTAL = 250_000
LAST4 = "7391"  # no aparece en ningún id fijo ni importe de las pruebas con falsos
NOW = datetime(2026, 12, 1, 15, 0, tzinfo=UTC)

GATEWAY_FAILURES = [
    FailureCode.CARD_DECLINED,
    FailureCode.INSUFFICIENT_FUNDS,
    FailureCode.EXPIRED_CARD,
]
_ids = itertools.count(1)
EFFECTS = ("authorize", "confirm", "add", "audit")


def stored(
    failure: FailureCode | None = None,
    *,
    user: UUID = USER,
    order: UUID = ORDER,
    key: str = KEY,
    last4: str = "4242",
    amount: int = TOTAL,
    attempt_id: UUID | None = None,
) -> PaymentAttempt:
    """Un intento ya guardado (con `created_at`)."""
    attempt = new_attempt(
        attempt_id=attempt_id or UUID(int=next(_ids)),
        order_id=order,
        user_id=user,
        idempotency_key=key,
        amount=amount,
        method=PaymentMethod(last4),
        gateway="fake",
        failure_code=failure,
    )
    return replace(attempt, created_at=NOW)


class FakeAttempts:
    """`PaymentAttemptRepository` en memoria con la semántica de la BD: `add` devuelve `None` si
    (user, key) existe y lanza `OrderAlreadyPaid` si el pedido ya tiene un aprobado.

    - `late`: un intento que "aparece" tras la primera búsqueda (otra solicitud con la misma
      clave lo inserta mientras esta espera): la siguiente `find_by_key` lo ve y `add` choca.
    - `rejected`: fija lo que devuelve `count_rejected` (si no, cuenta las filas)."""

    def __init__(
        self,
        calls: list[str],
        rows: tuple[PaymentAttempt, ...] = (),
        *,
        late: PaymentAttempt | None = None,
        rejected: int | None = None,
        add_error: Exception | None = None,
    ) -> None:
        self.calls = calls
        self.rows = list(rows)
        self.late = late
        self.rejected = rejected
        self.add_error = add_error
        self.lookups: list[tuple[UUID, str]] = []
        self.added: list[PaymentAttempt] = []
        self.locks: list[tuple[UUID, str]] = []  # T-099: sin efectos ni entrada en `calls`

    def lock_key(self, user_id: UUID, key: str) -> None:
        self.locks.append((user_id, key))

    def _visible(self) -> list[PaymentAttempt]:
        return self.rows + ([self.late] if self.late and self.lookups else [])

    def find_by_key(self, user_id: UUID, key: str) -> PaymentAttempt | None:
        self.calls.append("find_by_key")
        found = next(
            (a for a in self._visible() if (a.user_id, a.idempotency_key) == (user_id, key)),
            None,
        )
        self.lookups.append((user_id, key))
        return found

    def add(self, attempt: PaymentAttempt) -> PaymentAttempt | None:
        self.calls.append("add")
        self.added.append(attempt)
        if self.add_error is not None:
            raise self.add_error
        rows = self._visible()
        if any(
            (a.user_id, a.idempotency_key) == (attempt.user_id, attempt.idempotency_key)
            for a in rows
        ):
            return None
        if attempt.status is AttemptStatus.APPROVED and any(
            a.order_id == attempt.order_id and a.status is AttemptStatus.APPROVED for a in rows
        ):
            raise OrderAlreadyPaid
        saved = replace(attempt, created_at=NOW)
        self.rows.append(saved)
        return saved

    def list_for_order(self, user_id: UUID, order_id: UUID) -> tuple[PaymentAttempt, ...]:
        self.calls.append("list_for_order")
        return tuple(a for a in self.rows if (a.user_id, a.order_id) == (user_id, order_id))

    def count_rejected(self, user_id: UUID, order_id: UUID) -> int:
        self.calls.append("count_rejected")
        if self.rejected is not None:
            return self.rejected
        return sum(
            1
            for a in self.rows
            if (a.user_id, a.order_id) == (user_id, order_id)
            and a.status is AttemptStatus.REJECTED
            and a.failure_code is not FailureCode.ORDER_EXPIRED
        )


class FakeGateway:
    """`PaymentGateway`: aprueba (`result=None`), rechaza con un código o lanza un error."""

    name = "fake"

    def __init__(
        self,
        calls: list[str],
        result: FailureCode | None = None,
        error: Exception | None = None,
    ) -> None:
        self.calls = calls
        self.result = result
        self.error = error
        self.charges: list[GatewayCharge] = []

    def authorize(self, charge: GatewayCharge) -> GatewayResult:
        self.calls.append("authorize")
        self.charges.append(charge)
        if self.error is not None:
            raise self.error
        return GatewayResult(self.result)


class FakeOrders:
    """Los dos puertos de orders que recibe `PayOrder`: `get_payable` y `confirm`."""

    def __init__(
        self,
        calls: list[str],
        status: OrderStatus = OrderStatus.PENDING_PAYMENT,
        total: int = TOTAL,
        outcome: PaymentOutcome | Exception = PaymentOutcome.PAID,
    ) -> None:
        self.calls = calls
        self.status = status
        self.total = total
        self.outcome = outcome
        self.payable_for: list[tuple[UUID, UUID]] = []
        self.confirmed: list[tuple[UUID, UUID]] = []

    def get_payable(self, user_id: UUID, order_id: UUID) -> PayableOrder:
        self.calls.append("get_payable")
        self.payable_for.append((user_id, order_id))
        if (user_id, order_id) != (USER, ORDER):  # ajeno o inexistente: el mismo error
            raise OrderNotFound
        return PayableOrder(
            ORDER, "VAL-000001", self.status, self.total, NOW + timedelta(minutes=30)
        )

    def confirm(self, user_id: UUID, order_id: UUID) -> PaymentOutcome:
        self.calls.append("confirm")
        self.confirmed.append((user_id, order_id))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class FakeAudit:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls
        self.entries: list[Any] = []

    def record(self, entry: Any) -> None:
        self.calls.append("audit")
        self.entries.append(entry)


@dataclass
class Rig:
    calls: list[str]
    attempts: FakeAttempts
    gateway: FakeGateway
    orders: FakeOrders
    audit: FakeAudit
    use_case: PayOrder

    def effects(self) -> list[str]:
        """Llamadas con efecto fuera de PayOrder: pasarela, confirmación, guardar y auditar."""
        return [c for c in self.calls if c in EFFECTS]

    def pay(
        self,
        last4: str = "4242",
        *,
        user: UUID = USER,
        order: UUID = ORDER,
        key: str = KEY,
    ) -> Any:
        return self.use_case(
            user_id=user, order_id=order, idempotency_key=key, method=PaymentMethod(last4)
        )


def rig(
    *,
    rows: tuple[PaymentAttempt, ...] = (),
    late: PaymentAttempt | None = None,
    rejected: int | None = None,
    add_error: Exception | None = None,
    result: FailureCode | None = None,
    gateway_error: Exception | None = None,
    status: OrderStatus = OrderStatus.PENDING_PAYMENT,
    total: int = TOTAL,
    outcome: PaymentOutcome | Exception = PaymentOutcome.PAID,
) -> Rig:
    calls: list[str] = []
    attempts = FakeAttempts(calls, rows, late=late, rejected=rejected, add_error=add_error)
    gateway = FakeGateway(calls, result, gateway_error)
    orders = FakeOrders(calls, status, total, outcome)
    audit = FakeAudit(calls)
    gateway_port: PaymentGateway = gateway
    use_case = PayOrder(attempts, gateway_port, orders.get_payable, orders.confirm, audit)  # type: ignore[arg-type]
    return Rig(calls, attempts, gateway, orders, audit, use_case)


# --------------------------------------------------------------------------------------------
# Cliente HTTP real (fixture `shop` de orders) con pasarela espía


class SpyGateway:
    """Envuelve la pasarela simulada y cuenta las llamadas (y guarda los cargos recibidos)."""

    def __init__(self, inner: PaymentGateway | None = None) -> None:
        self.inner: PaymentGateway = inner or SimulatedGateway()
        self.name = self.inner.name
        self.charges: list[GatewayCharge] = []

    def authorize(self, charge: GatewayCharge) -> GatewayResult:
        self.charges.append(charge)
        return self.inner.authorize(charge)


def spy(shop: OrderShop) -> SpyGateway:
    """Instala la pasarela espía en el proveedor `get_payment_gateway` de la app."""
    gateway = SpyGateway()
    shop.override(get_payment_gateway, lambda: gateway)
    return gateway


@dataclass
class Placed:
    user: UUID
    order_id: UUID
    product: UUID
    total: int
    quantity: int


def placed_order(
    shop: OrderShop,
    quantity: int = 1,
    *,
    price: int = 250_000,
    on_hand: int | None = 5,
    **product: Any,
) -> Placed:
    """Cliente con un pedido `pendiente_pago` real (carrito → `POST /orders`), con su reserva."""
    user = shop.user()
    product_id = add_listed(shop.session, price=price, on_hand=on_hand, **product)
    stock_in_cart(shop, user, (product_id, quantity))
    created = place(shop, user)
    assert created.status_code == 201, created.text
    body = created.json()
    return Placed(user, UUID(body["id"]), product_id, body["total"]["amount"], quantity)


def another_order(shop: OrderShop, user: UUID, quantity: int = 1, price: int = 120_000) -> UUID:
    """Otro pedido pendiente del mismo cliente (el tope de 3 sin pagar lo permite)."""
    product_id = add_listed(shop.session, price=price, on_hand=5)
    stock_in_cart(shop, user, (product_id, quantity))
    created = place(shop, user)
    assert created.status_code == 201, created.text
    return UUID(created.json()["id"])


def pay(
    shop: OrderShop,
    user: UUID | None,
    order_id: object,
    last4: str = "4242",
    *,
    key: str | None = "",
    body: Any = ...,
    headers: dict[str, str] | None = None,
    content: bytes | None = None,
) -> Any:
    """POST del pago. `key=""` genera una clave nueva; `key=None` omite la cabecera; `user=None`
    omite el token; `body` sustituye al cuerpo `{"card_last4": last4}`."""
    sent: dict[str, str] = {}
    if key is not None:
        sent["Idempotency-Key"] = key or new_key()
    if user is not None:
        sent["Authorization"] = f"Bearer {make_token(str(user))}"
    sent.update(headers or {})
    if content is not None:
        sent["Content-Type"] = "application/json"
        return shop.client.post(pay_path(order_id), headers=sent, content=content)
    payload = {"card_last4": last4} if body is ... else body
    return shop.client.post(pay_path(order_id), headers=sent, json=payload)


# --------------------------------------------------------------------------------------------
# Lo que se mira en la BD


def attempt_rows(session: Session, order_id: object) -> list[dict[str, Any]]:
    rows = session.execute(
        text("SELECT * FROM app.payment_attempts WHERE order_id = :o ORDER BY created_at, id"),
        {"o": order_id},
    )
    return [dict(r) for r in rows.mappings()]


def attempts_of_user(session: Session, user: UUID) -> int:
    return session.scalar(
        text("SELECT count(*) FROM app.payment_attempts WHERE user_id = :u"), {"u": user}
    )


def status_of(session: Session, order_id: object) -> str:
    return session.scalar(text("SELECT status FROM app.orders WHERE id = :id"), {"id": order_id})


def sales(session: Session, order_id: object) -> list[tuple[str, int]]:
    """(kind, quantity_delta) de los movimientos de stock del pedido."""
    rows = session.execute(
        text("SELECT kind, quantity_delta FROM app.stock_movements WHERE order_id = :id"),
        {"id": order_id},
    )
    return [(r.kind, r.quantity_delta) for r in rows]


def reservation_states(session: Session, order_id: object) -> list[str]:
    rows = session.scalars(
        text("SELECT status FROM app.stock_reservations WHERE order_id = :id ORDER BY product_id"),
        {"id": order_id},
    )
    return list(rows)


def expire_reservations_only(session: Session, order_id: object) -> None:
    """Las reservas vencidas y el pedido aún vigente: el pedido vence "durante el pago" (R6b)."""
    session.execute(
        text(
            "UPDATE app.stock_reservations SET expires_at = now() - interval '1 minute'"
            " WHERE order_id = :id"
        ),
        {"id": order_id},
    )


def payment_audit(session: Session, user: UUID) -> list[dict[str, Any]]:
    return audit_rows(session, action="payments.attempt_recorded", actor_id=user)


def any_audit_since(session: Session, user: UUID) -> int:
    """Todas las entradas de auditoría de este cliente (payments y orders)."""
    return session.scalar(
        text("SELECT count(*) FROM app.audit_log WHERE actor_id = :u"), {"u": user}
    )


@pytest.fixture(name="shop")
def rolling_back_shop(orders_shop: OrderShop, db_session: Session) -> OrderShop:
    """La `shop` de orders con la sesión de cada solicitud como la de la app (`get_session`):
    una sesión propia sobre la misma conexión, con SAVEPOINT. Un `session.rollback()` de la
    solicitud (los errores de payments lo hacen, R5) deshace solo lo de la solicitud y no los
    datos que la prueba creó antes."""

    def request_session() -> Iterator[Session]:
        with (
            Session(bind=db_session.get_bind(), join_transaction_mode="create_savepoint") as s,
            s.begin(),
        ):
            yield s

    orders_shop.app.dependency_overrides[get_session] = request_session
    return orders_shop
