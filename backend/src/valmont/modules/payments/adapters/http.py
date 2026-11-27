"""HTTP de payments (SPEC §7). Sin lógica de negocio; ni el cuerpo ni `card_last4` se registran."""

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from valmont.modules.audit.adapters.http import AuditRecorderDep
from valmont.modules.identity.adapters.http import current_user
from valmont.modules.identity.domain import CurrentUser
from valmont.modules.orders.adapters.wiring import (
    get_confirm_order_payment,
    get_get_payable_order,
)
from valmont.modules.orders.application import (
    ConfirmOrderPayment,
    GetPayableOrder,
    OrderNotFound,
    OrderNotPayable,
)
from valmont.modules.payments.adapters.persistence import SqlPaymentAttemptRepository
from valmont.modules.payments.adapters.simulated_gateway import SimulatedGateway
from valmont.modules.payments.application import (
    GetOrderPayments,
    OrderPayments,
    PaymentAttemptRepository,
    PaymentGateway,
    PayOrder,
)
from valmont.modules.payments.domain import (
    MAX_REJECTED_ATTEMPTS,
    AttemptStatus,
    FailureCode,
    GatewayUnavailable,
    IdempotencyKeyReused,
    OrderAlreadyPaid,
    PaymentAttempt,
    PaymentMethod,
    TooManyAttempts,
)
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, ErrorOut, error_response
from valmont.shared.idempotency import IdempotencyKey
from valmont.shared.money import Money

router = APIRouter(prefix="/api/v1/payments", tags=["payments"])

_NO_STORE = {"Cache-Control": "no-store"}


class PayOrderIn(BaseModel):
    # Cuerpo cerrado: ni importe, ni user_id, ni resultado, ni número, vencimiento o CVV (R7).
    model_config = ConfigDict(extra="forbid")
    card_last4: str = Field(pattern=r"^[0-9]{4}$")


class PaymentAttemptOut(BaseModel):
    id: UUID
    order_id: UUID
    status: AttemptStatus
    failure_code: FailureCode | None
    amount: Money
    card_last4: str
    created_at: datetime

    @classmethod
    def build(cls, attempt: PaymentAttempt) -> PaymentAttemptOut:
        if attempt.created_at is None:
            raise ValueError("El intento no tiene fecha")
        return cls(
            id=attempt.id,
            order_id=attempt.order_id,
            status=attempt.status,
            failure_code=attempt.failure_code,
            amount=Money(amount=attempt.amount),
            card_last4=attempt.card_last4,
            created_at=attempt.created_at,
        )


class OrderPaymentsOut(BaseModel):
    order_id: UUID
    can_pay: bool
    attempts_left: int
    attempts: list[PaymentAttemptOut]

    @classmethod
    def build(cls, result: OrderPayments) -> OrderPaymentsOut:
        return cls(
            order_id=result.order.order_id,
            can_pay=result.can_pay,
            attempts_left=result.attempts_left,
            attempts=[PaymentAttemptOut.build(a) for a in result.attempts],
        )


# --- Proveedores ---


def get_payment_attempts(session: SessionDep) -> PaymentAttemptRepository:
    return SqlPaymentAttemptRepository(session)


def get_payment_gateway() -> PaymentGateway:
    return SimulatedGateway()  # único punto que nombra el adaptador (R11)


def get_pay_order(
    attempts: Annotated[PaymentAttemptRepository, Depends(get_payment_attempts)],
    gateway: Annotated[PaymentGateway, Depends(get_payment_gateway)],
    get_payable: Annotated[GetPayableOrder, Depends(get_get_payable_order)],
    confirm: Annotated[ConfirmOrderPayment, Depends(get_confirm_order_payment)],
    audit: AuditRecorderDep,
) -> PayOrder:
    return PayOrder(attempts, gateway, get_payable, confirm, audit)


def get_get_order_payments(
    attempts: Annotated[PaymentAttemptRepository, Depends(get_payment_attempts)],
    get_payable: Annotated[GetPayableOrder, Depends(get_get_payable_order)],
) -> GetOrderPayments:
    return GetOrderPayments(attempts, get_payable)


# --- Errores ---


def _example(code: str, message: str, details: object = None) -> dict[str, object]:
    return {"value": {"error": {"code": code, "message": message, "details": details}}}


_RESPONSES: dict[int | str, dict[str, Any]] = {
    **{s: ERROR_RESPONSES[s] for s in (401, 404, 422)},
    200: {"model": PaymentAttemptOut, "description": "Repite la clave: el intento original."},
    409: {
        "model": ErrorOut,
        "description": "`order_not_payable` (`details`: `status`), `order_already_paid`,"
        " `too_many_attempts` (`details`: `max`) o `idempotency_key_reused`.",
        "content": {
            "application/json": {
                "examples": {
                    "order_not_payable": _example(
                        "order_not_payable", "El pedido no se puede pagar.", {"status": "expirado"}
                    ),
                    "order_already_paid": _example(
                        "order_already_paid", "El pedido ya está pagado."
                    ),
                    "too_many_attempts": _example(
                        "too_many_attempts",
                        "Se alcanzó el máximo de intentos rechazados.",
                        {"max": MAX_REJECTED_ATTEMPTS},
                    ),
                    "idempotency_key_reused": _example(
                        "idempotency_key_reused", "La clave pertenece a otro pedido."
                    ),
                }
            }
        },
    },
    503: {
        "model": ErrorOut,
        "description": "`payment_gateway_unavailable` (sin intento; reintente con la misma"
        " clave) o `auth_unavailable`.",
    },
}


def _fail(
    session: Session, status: int, code: str, message: str, details: object = None
) -> JSONResponse:
    session.rollback()  # `SessionDep` confirmaría: un error no deja efectos (R5, §7)
    response = error_response(status, code, message, details)
    response.headers.update(_NO_STORE)
    return response


@router.post(
    "/orders/{order_id}/attempts",
    status_code=201,
    response_model=PaymentAttemptOut,
    responses=_RESPONSES,
)
def pay_order(
    order_id: UUID,
    body: PayOrderIn,
    idempotency_key: IdempotencyKey,
    response: Response,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[PayOrder, Depends(get_pay_order)],
    session: SessionDep,
) -> PaymentAttemptOut | JSONResponse:
    response.headers.update(_NO_STORE)
    try:
        result = use_case(user.user_id, order_id, idempotency_key, PaymentMethod(body.card_last4))
    except OrderNotFound:
        return _fail(session, 404, "not_found", "Pedido no encontrado.")
    except OrderNotPayable as exc:
        return _fail(
            session,
            409,
            "order_not_payable",
            "El pedido no se puede pagar.",
            {"status": exc.status.value},
        )
    except OrderAlreadyPaid:
        return _fail(session, 409, "order_already_paid", "El pedido ya está pagado.")
    except TooManyAttempts as exc:
        return _fail(
            session,
            409,
            "too_many_attempts",
            "Se alcanzó el máximo de intentos rechazados.",
            {"max": exc.max_attempts},
        )
    except IdempotencyKeyReused:
        return _fail(session, 409, "idempotency_key_reused", "La clave pertenece a otro pedido.")
    except GatewayUnavailable:
        return _fail(
            session, 503, "payment_gateway_unavailable", "La pasarela de pago no está disponible."
        )
    if not result.created:
        response.status_code = 200
    return PaymentAttemptOut.build(result.attempt)


@router.get(
    "/orders/{order_id}/attempts",
    response_model=OrderPaymentsOut,
    responses={s: ERROR_RESPONSES[s] for s in (401, 404, 422, 503)},
)
def list_order_attempts(
    order_id: UUID,
    response: Response,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[GetOrderPayments, Depends(get_get_order_payments)],
    session: SessionDep,
) -> OrderPaymentsOut | JSONResponse:
    response.headers.update(_NO_STORE)
    try:
        result = use_case(user.user_id, order_id)
    except OrderNotFound:
        return _fail(session, 404, "not_found", "Pedido no encontrado.")
    return OrderPaymentsOut.build(result)
