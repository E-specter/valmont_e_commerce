"""Dominio de payments (SPEC §4, §5). Puro: sin fastapi, pydantic, sqlalchemy ni otros módulos.
Los mensajes de error nunca incluyen el valor recibido (R7, RN-11)."""

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

MAX_REJECTED_ATTEMPTS = 5
GATEWAY_SIMULATED = "simulated"

_LAST4 = re.compile(r"[0-9]{4}")
_KEY = re.compile(r"[A-Za-z0-9_-]{16,64}")


def _is_last4(value: object) -> bool:
    # fullmatch: `$` aceptaría un salto de línea final.
    return isinstance(value, str) and _LAST4.fullmatch(value) is not None


class AttemptStatus(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


class FailureCode(StrEnum):
    CARD_DECLINED = "card_declined"
    INSUFFICIENT_FUNDS = "insufficient_funds"
    EXPIRED_CARD = "expired_card"
    ORDER_EXPIRED = "order_expired"


class PaymentError(Exception):
    pass


class InvalidPaymentMethod(PaymentError, ValueError):
    pass


class OrderAlreadyPaid(PaymentError):
    pass


class TooManyAttempts(PaymentError):
    def __init__(self, max_attempts: int = MAX_REJECTED_ATTEMPTS) -> None:
        super().__init__("Se alcanzó el máximo de intentos rechazados")
        self.max_attempts = max_attempts


class IdempotencyKeyReused(PaymentError):
    pass


class GatewayUnavailable(PaymentError):
    pass


@dataclass(frozen=True)
class PaymentMethod:
    card_last4: str

    def __post_init__(self) -> None:
        if not _is_last4(self.card_last4):
            raise InvalidPaymentMethod("card_last4 debe tener exactamente 4 dígitos")


@dataclass(frozen=True)
class PaymentAttempt:
    id: UUID
    order_id: UUID
    user_id: UUID
    idempotency_key: str
    status: AttemptStatus
    amount: int
    failure_code: FailureCode | None
    card_last4: str
    gateway: str
    created_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.amount < 1:
            raise ValueError("El importe debe ser al menos 1")
        if (self.status is AttemptStatus.REJECTED) != (self.failure_code is not None):
            raise ValueError("Un intento rechazado lleva motivo y uno aprobado no")
        if not (isinstance(self.idempotency_key, str) and _KEY.fullmatch(self.idempotency_key)):
            raise ValueError("La clave de idempotencia no es válida")
        if not _is_last4(self.card_last4):
            raise ValueError("card_last4 debe tener exactamente 4 dígitos")
        if not 1 <= len(self.gateway) <= 30:
            raise ValueError("El nombre de la pasarela debe tener entre 1 y 30 caracteres")


def new_attempt(
    *,
    attempt_id: UUID,
    order_id: UUID,
    user_id: UUID,
    idempotency_key: str,
    amount: int,
    method: PaymentMethod,
    gateway: str,
    failure_code: FailureCode | None,
) -> PaymentAttempt:
    return PaymentAttempt(
        id=attempt_id,
        order_id=order_id,
        user_id=user_id,
        idempotency_key=idempotency_key,
        status=AttemptStatus.APPROVED if failure_code is None else AttemptStatus.REJECTED,
        amount=amount,
        failure_code=failure_code,
        card_last4=method.card_last4,
        gateway=gateway,
    )


def attempts_left(rejected_count: int) -> int:
    return max(0, MAX_REJECTED_ATTEMPTS - rejected_count)
