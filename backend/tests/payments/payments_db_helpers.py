"""Datos de prueba de payments contra la BD (T-093). Ficticios. Perfiles y pedidos se insertan con
los helpers de cart y de orders (FK a app.profiles y app.orders, SPEC §6); los intentos se pueden
insertar por SQL directo (para probar las restricciones) o con el repositorio (para probar este)."""

from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import insert_order_row, scalar
from valmont.modules.payments.domain import (
    GATEWAY_SIMULATED,
    FailureCode,
    PaymentAttempt,
    PaymentMethod,
    new_attempt,
)

# Pares (perfil, pedido) confirmados por la fixture `committed_orders` (conftest.py).
Factory = Callable[[int], list[tuple[UUID, UUID]]]
PARTIAL_INDEX = "uq_payment_attempts_order_approved"
# Dato de tarjeta ficticio que no se parece a nada del resto de los datos de las pruebas.
LAST4 = "7391"


def new_key() -> str:
    """Clave de idempotencia válida (un UUID, T-018c) y única."""
    return str(uuid4())


def user_with_order(session: Session) -> tuple[UUID, UUID]:
    """(user_id, order_id): un perfil y un pedido suyo, por SQL."""
    user = add_profile(session)
    return user, insert_order_row(session, user)


def attempt_values(
    order_id: UUID | None, user_id: UUID | None, /, **changes: Any
) -> dict[str, Any]:
    """Columnas de un intento aprobado válido; `created_at` va con el default de la BD."""
    values: dict[str, Any] = {
        "id": uuid4(),
        "order_id": order_id,
        "user_id": user_id,
        "idempotency_key": new_key(),
        "status": "approved",
        "amount": 100_000,
        "failure_code": None,
        "card_last4": "4242",
        "gateway": GATEWAY_SIMULATED,
    }
    return {**values, **changes}


def insert_sql(values: dict[str, Any]) -> str:
    # Los nombres de columna salen del código de la prueba; los valores van parametrizados.
    columns = ", ".join(values)
    marks = ", ".join(":" + name for name in values)
    return f"INSERT INTO app.payment_attempts ({columns}) VALUES ({marks})"


def insert_attempt_row(
    session: Session, order_id: UUID, user_id: UUID, **changes: Any
) -> dict[str, Any]:
    """Inserta un intento por SQL y devuelve sus valores (con el `id`)."""
    values = attempt_values(order_id, user_id, **changes)
    session.execute(text(insert_sql(values)), values)
    return values


def rejected_row(
    session: Session, order_id: UUID, user_id: UUID, code: str = "card_declined", **changes: Any
) -> dict[str, Any]:
    return insert_attempt_row(
        session, order_id, user_id, status="rejected", failure_code=code, **changes
    )


def violation(
    session: Session, order_id: UUID | None, user_id: UUID | None, **changes: Any
) -> tuple[str | None, str | None]:
    """Inserta una fila esperando que la BD la rechace; devuelve (SQLSTATE, tabla infractora)."""
    values = attempt_values(order_id, user_id, **changes)
    with pytest.raises(DBAPIError) as error, session.begin_nested():
        session.execute(text(insert_sql(values)), values)
    return error.value.orig.sqlstate, error.value.orig.diag.table_name


def violated_constraint(error: pytest.ExceptionInfo[Any]) -> str | None:
    return error.value.orig.diag.constraint_name


def make_attempt(
    order_id: UUID,
    user_id: UUID,
    *,
    failure_code: FailureCode | None = None,
    key: str | None = None,
    amount: int = 250_000,
    last4: str = "4242",
    gateway: str = GATEWAY_SIMULATED,
    attempt_id: UUID | None = None,
) -> PaymentAttempt:
    """Intento del dominio (aprobado si `failure_code` es None), sin guardar."""
    return new_attempt(
        attempt_id=attempt_id or uuid4(),
        order_id=order_id,
        user_id=user_id,
        idempotency_key=key or new_key(),
        amount=amount,
        method=PaymentMethod(last4),
        gateway=gateway,
        failure_code=failure_code,
    )


def attempts_in_db(session: Session, **filters: Any) -> int:
    """Filas de payment_attempts que casan con los filtros de igualdad dados (por SQL directo)."""
    where = " AND ".join(f"{column} = :{column}" for column in filters) or "true"
    return scalar(session, f"SELECT count(*) FROM app.payment_attempts WHERE {where}", **filters)
