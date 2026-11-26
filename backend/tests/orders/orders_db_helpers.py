"""Datos de prueba de orders contra la BD (T-073). Ficticios. Perfiles y productos se insertan con
los helpers de cart (FK a app.profiles y app.products, SPEC §6); las filas de orders se pueden
insertar por SQL directo (para probar las restricciones) o con el repositorio (para probar este)."""

from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_product, add_profile
from tests.orders.orders_helpers import make_line, pickup_delivery, shipping_delivery
from valmont.modules.orders.adapters.persistence import SqlOrderRepository
from valmont.modules.orders.domain import (
    ActorKind,
    DeliveryDetails,
    Order,
    OrderLine,
    OrderStatus,
    StatusChange,
    build_order,
)

CHECK, FOREIGN_KEY, UNIQUE, NOT_NULL, OUT_OF_RANGE = "23514", "23503", "23505", "23502", "22003"
GENERATED_ALWAYS = "428C9"  # INSERT de un valor propio en una columna GENERATED ALWAYS
BASE = datetime(2026, 12, 1, 15, 0, tzinfo=UTC)  # 10:00 en Lima


def letters() -> str:
    """Etiqueta única solo con letras: sirve en un nombre sin chocar con un número de pedido."""
    return "".join(chr(ord("a") + int(c, 16)) for c in uuid4().hex[:12])


def sqlstate(error: pytest.ExceptionInfo[Any]) -> tuple[str | None, str | None]:
    """(SQLSTATE, tabla) del error de la BD."""
    return error.value.orig.sqlstate, error.value.orig.diag.table_name


def rejected(
    session: Session, statement: str, params: dict[str, Any]
) -> tuple[str | None, str | None]:
    """Ejecuta `statement` esperando que la BD lo rechace; devuelve (SQLSTATE, tabla)."""
    with pytest.raises(DBAPIError) as error, session.begin_nested():
        session.execute(text(statement), params)
    return sqlstate(error)


def scalar(session: Session, query: str, **params: Any) -> Any:
    session.flush()  # lo que el repositorio dejó pendiente se ve en el SQL directo
    return session.scalar(text(query), params)


def rows(session: Session, query: str, **params: Any) -> list[tuple[Any, ...]]:
    session.flush()
    return [tuple(row) for row in session.execute(text(query), params)]


# --- filas por SQL directo (para las restricciones) -----------------------------------------


def _insert(session: Session, table: str, values: dict[str, Any]) -> None:
    # Los nombres de columna salen del código de la prueba; los valores van parametrizados.
    columns = ", ".join(values)
    marks = ", ".join(f":{name}" for name in values)
    session.execute(text(f"INSERT INTO app.{table} ({columns}) VALUES ({marks})"), values)


def order_values(user_id: UUID | None, /, **changes: Any) -> dict[str, Any]:
    """Columnas de un pedido válido (pendiente, 1 línea de 100000 céntimos, 30 min de ventana)."""
    created = changes.get("created_at") or BASE  # None: la prueba de NOT NULL
    values: dict[str, Any] = {
        "id": uuid4(),
        "user_id": user_id,
        "status": "pendiente_pago",
        "idempotency_key": f"key-{uuid4().hex}",
        "subtotal_amount": 100_000,
        "shipping_amount": 0,
        "total_amount": 100_000,
        "created_at": created,
        "expires_at": created + timedelta(minutes=30),
    }
    return {**values, **changes}


def insert_order_row(session: Session, user_id: UUID | None = None, **changes: Any) -> UUID:
    """Inserta un pedido por SQL (perfil nuevo si no se da `user_id`) y devuelve su id."""
    values = order_values(add_profile(session) if user_id is None else user_id, **changes)
    _insert(session, "orders", values)
    return values["id"]


def line_values(
    order_id: UUID | None, product_id: UUID | None, /, **changes: Any
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "id": uuid4(),
        "order_id": order_id,
        "position": 1,
        "product_id": product_id,
        "sku": "TST-ORD-0001",
        "name": "Reloj de prueba",
        "quantity": 1,
        "list_price_amount": 100_000,
        "unit_price_amount": 100_000,
        "discount_amount": 0,
        "line_total_amount": 100_000,
        "fulfillment": "stock",
    }
    return {**values, **changes}


def insert_line_row(
    session: Session, order_id: UUID, product_id: UUID | None = None, **changes: Any
) -> UUID:
    values = line_values(order_id, add_product(session) if product_id is None else product_id)
    values.update(changes)
    _insert(session, "order_lines", values)
    return values["id"]


def delivery_values(order_id: UUID | None, /, **changes: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "order_id": order_id,
        "delivery_method": "shipping",
        "recipient_name": "Ana Pérez",
        "phone": "+51987654321",
        "department": "Lima",
        "province": "Lima",
        "district": "Miraflores",
        "address_line": "Av. Larco 1234, piso 5",
    }
    return {**values, **changes}


def insert_delivery_row(session: Session, order_id: UUID, **changes: Any) -> None:
    _insert(session, "deliveries", delivery_values(order_id, **changes))


def history_values(order_id: UUID | None, /, **changes: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "order_id": order_id,
        "from_status": None,
        "to_status": "pendiente_pago",
        "actor_kind": "customer",
        "actor_id": uuid4(),
    }
    return {**values, **changes}


def insert_history_row(session: Session, order_id: UUID, **changes: Any) -> None:
    _insert(session, "order_status_history", history_values(order_id, **changes))


# --- pedidos del dominio (para el repositorio) ----------------------------------------------


def real_line(session: Session, **kwargs: Any) -> OrderLine:
    """Línea de `make_line` con un producto que existe (FK a app.products)."""
    return replace(make_line(**kwargs), product_id=add_product(session))


def new_order(
    session: Session,
    *,
    user_id: UUID | None = None,
    key: str | None = None,
    now: datetime = BASE,
    lines: Sequence[OrderLine] | None = None,
    delivery: DeliveryDetails | None = None,
    order_id: UUID | None = None,
    recipient: str | None = None,
) -> Order:
    """Pedido `pendiente_pago` del dominio, sin guardar; el perfil y los productos sí se crean."""
    user = add_profile(session) if user_id is None else user_id
    chosen = [real_line(session)] if lines is None else list(lines)
    if delivery is None:
        delivery = shipping_delivery(recipient_name=recipient or f"Ana {letters()}")
    return build_order(
        order_id or uuid4(), user, key or f"key-{uuid4().hex}", chosen, delivery, now
    )


def stored_order(session: Session, **kwargs: Any) -> Order:
    """`new_order` guardado con el repositorio (devuelve el pedido con su número)."""
    return SqlOrderRepository(session).add(new_order(session, **kwargs))


def pickup_order(session: Session, **kwargs: Any) -> Order:
    kwargs.setdefault("delivery", pickup_delivery(recipient_name=f"Ana {letters()}"))
    return stored_order(session, **kwargs)


def change(
    from_status: OrderStatus | None,
    to_status: OrderStatus,
    *,
    kind: ActorKind = ActorKind.ADMIN,
    actor_id: UUID | None = None,
    note: str | None = None,
    at: datetime = BASE + timedelta(minutes=5),
) -> StatusChange:
    """StatusChange coherente con el CHECK de la BD (system sin actor; el resto, con actor)."""
    if kind == ActorKind.SYSTEM:
        actor_id = None
    elif actor_id is None:
        actor_id = uuid4()
    return StatusChange(from_status, to_status, kind, actor_id, note, at)


def history_of(session: Session, order_id: UUID) -> list[tuple[Any, ...]]:
    """Filas de order_status_history, de la más antigua a la más reciente."""
    return rows(
        session,
        "SELECT from_status, to_status, actor_kind, actor_id, note, created_at"
        " FROM app.order_status_history WHERE order_id = :id ORDER BY id",
        id=order_id,
    )


def status_in_db(session: Session, order_id: UUID) -> str:
    return scalar(session, "SELECT status FROM app.orders WHERE id = :id", id=order_id)
