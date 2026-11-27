"""Puertos y tipos de payments. Los casos de uso llegan con T-094 y T-095."""

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from valmont.modules.orders.application import PayableOrder
from valmont.modules.payments.domain import FailureCode, PaymentAttempt, PaymentMethod


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
