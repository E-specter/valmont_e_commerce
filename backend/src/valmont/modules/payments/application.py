"""Puertos, tipos y casos de uso de payments (T-094, T-095)."""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID, uuid4

from valmont.modules.audit.application import AuditEntry, AuditRecorder
from valmont.modules.orders.application import (
    ConfirmOrderPayment,
    GetPayableOrder,
    OrderNotPayable,
    OrderStatus,
    PayableOrder,
    PaymentOutcome,
)
from valmont.modules.payments.domain import (
    MAX_REJECTED_ATTEMPTS,
    FailureCode,
    IdempotencyKeyReused,
    OrderAlreadyPaid,
    PaymentAttempt,
    PaymentMethod,
    TooManyAttempts,
    attempts_left,
    new_attempt,
)


@dataclass(frozen=True)
class GatewayCharge:
    reference: UUID
    amount: int
    method: PaymentMethod


@dataclass(frozen=True)
class GatewayResult:
    failure_code: FailureCode | None

    @property
    def approved(self) -> bool:
        return self.failure_code is None


class PaymentGateway(Protocol):
    name: str

    def authorize(self, charge: GatewayCharge) -> GatewayResult:
        """Puede lanzar `GatewayUnavailable`."""
        ...


class PaymentAttemptRepository(Protocol):
    def add(self, attempt: PaymentAttempt) -> PaymentAttempt | None:
        """Inserta; `None` si (user_id, idempotency_key) ya existe; `OrderAlreadyPaid` si el
        pedido ya tiene un `approved`. No hace commit."""
        ...

    def lock_key(self, user_id: UUID, key: str) -> None:
        """Bloqueo consultivo de transacción por (user_id, key): serializa las solicitudes con
        la misma clave hasta el commit o rollback. Va antes de cualquier bloqueo de fila."""
        ...

    def find_by_key(self, user_id: UUID, key: str) -> PaymentAttempt | None: ...

    def list_for_order(self, user_id: UUID, order_id: UUID) -> tuple[PaymentAttempt, ...]:
        """Solo los del dueño, `created_at desc, id desc`."""
        ...

    def count_rejected(self, user_id: UUID, order_id: UUID) -> int:
        """Rechazados del dueño sin contar `order_expired`."""
        ...


@dataclass(frozen=True)
class PaymentResult:
    attempt: PaymentAttempt
    created: bool


@dataclass(frozen=True)
class OrderPayments:
    order: PayableOrder
    attempts: tuple[PaymentAttempt, ...]
    can_pay: bool
    attempts_left: int


class PayOrder:
    """UC-01 (R3...R6, R9, R10, R13). Sin commit: lo hace la sesión de la solicitud."""

    def __init__(
        self,
        attempts: PaymentAttemptRepository,
        gateway: PaymentGateway,
        get_payable: GetPayableOrder,
        confirm: ConfirmOrderPayment,
        audit: AuditRecorder,
    ) -> None:
        self._attempts = attempts
        self._gateway = gateway
        self._get_payable = get_payable
        self._confirm = confirm
        self._audit = audit

    def _replay(self, user_id: UUID, order_id: UUID, key: str) -> PaymentResult | None:
        existing = self._attempts.find_by_key(user_id, key)
        if existing is None:
            return None
        if existing.order_id != order_id:
            raise IdempotencyKeyReused
        return PaymentResult(existing, False)

    def __call__(
        self, user_id: UUID, order_id: UUID, idempotency_key: str, method: PaymentMethod
    ) -> PaymentResult:
        # T-099: primero el bloqueo de la clave, luego los de fila (pedido, reservas): orden fijo.
        self._attempts.lock_key(user_id, idempotency_key)
        if replay := self._replay(user_id, order_id, idempotency_key):
            return replay
        order = self._get_payable(user_id, order_id)  # el importe sale solo de aquí (R2)
        if order.status in (OrderStatus.CANCELLED, OrderStatus.EXPIRED):
            raise OrderNotPayable(order.status)
        if order.status != OrderStatus.PENDING_PAYMENT:
            raise OrderAlreadyPaid
        if self._attempts.count_rejected(user_id, order_id) >= MAX_REJECTED_ATTEMPTS:
            raise TooManyAttempts
        attempt_id = uuid4()
        result = self._gateway.authorize(GatewayCharge(attempt_id, order.total_amount, method))
        failure = result.failure_code
        confirmed = False
        if result.approved:
            outcome = self._confirm(user_id, order_id)
            if outcome is PaymentOutcome.EXPIRED:
                failure = FailureCode.ORDER_EXPIRED  # R6b: 2xx para conservar la expiración
            elif outcome is PaymentOutcome.ALREADY_PAID:
                if replay := self._replay(user_id, order_id, idempotency_key):
                    return replay
                raise OrderAlreadyPaid
            else:
                confirmed = outcome is PaymentOutcome.PAID
        attempt = new_attempt(
            attempt_id=attempt_id,
            order_id=order_id,
            user_id=user_id,
            idempotency_key=idempotency_key,
            amount=order.total_amount,
            method=method,
            gateway=self._gateway.name,
            failure_code=failure,
        )
        saved = self._attempts.add(attempt)  # tras confirmar: sin KEY SHARE previo al bloqueo
        if saved is None:  # carrera con la misma clave (R3.3)
            if confirmed:  # T-099: ya cobramos y confirmamos; nunca reutilizar un intento ajeno
                raise IdempotencyKeyReused  # la ruta hace rollback y deshace la confirmación
            if replay := self._replay(user_id, order_id, idempotency_key):
                return replay
            raise IdempotencyKeyReused
        self._audit.record(
            AuditEntry(
                "payments.attempt_recorded",
                "payment_attempt",
                str(saved.id),
                user_id,
                "customer",
                after={
                    "order_id": str(order_id),
                    "status": saved.status.value,
                    "failure_code": saved.failure_code.value if saved.failure_code else None,
                    "amount": saved.amount,
                },
            )
        )
        return PaymentResult(saved, True)


class GetOrderPayments:
    """UC-02 (R8, R9, R15). `GetPayableOrder` filtra por dueño y expira el pedido vencido."""

    def __init__(self, attempts: PaymentAttemptRepository, get_payable: GetPayableOrder) -> None:
        self._attempts = attempts
        self._get_payable = get_payable

    def __call__(self, user_id: UUID, order_id: UUID) -> OrderPayments:
        order = self._get_payable(user_id, order_id)  # OrderNotFound: ajeno o inexistente
        left = attempts_left(self._attempts.count_rejected(user_id, order_id))
        return OrderPayments(
            order=order,
            attempts=self._attempts.list_for_order(user_id, order_id),
            can_pay=order.status is OrderStatus.PENDING_PAYMENT and left > 0,
            attempts_left=left,
        )
