"""Ayudas para las lecturas del cliente (T-075): pedidos con estado y antigüedad a medida, GET con
token, y el estado de la BD (reservas, auditoría, historial) tras leer. Datos ficticios.

Todo cuelga de la hora de la BD (`now()` de la transacción de la prueba, la misma que usa
`SqlClock`): los pedidos se crean y se envejecen respecto a ella, nunca respecto al reloj de la
máquina, así las pruebas no dependen de la fecha en que se ejecuten."""

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import make_token
from tests.orders.orders_db_helpers import stored_order
from tests.orders.orders_http_helpers import PATH, OrderShop
from valmont.modules.orders.domain import Order, OrderLine, OrderStatus

PAID_STATUSES = ("pagado", "en_preparacion", "enviado", "listo_para_recojo", "entregado")
ALL_STATUSES = ("pendiente_pago", *PAID_STATUSES, "cancelado", "expirado")


def db_now(session: Session) -> datetime:
    return session.execute(text("SELECT now()")).scalar_one()


def set_status(session: Session, order_id: UUID, status: str) -> None:
    """Estado por SQL: el pagado o posterior lleva `paid_at` (CHECK de la BD)."""
    session.execute(
        text(
            "UPDATE app.orders SET status = :s,"
            " paid_at = CASE WHEN :s = ANY(:paid) THEN now() END WHERE id = :id"
        ),
        {"s": status, "paid": list(PAID_STATUSES), "id": order_id},
    )


def make_order(
    session: Session,
    user: UUID,
    *,
    status: str = "pagado",
    minutes_ago: int = 60,
    lines: Sequence[OrderLine] | None = None,
    **kwargs: Any,
) -> Order:
    """Pedido guardado con el repositorio, creado hace `minutes_ago` minutos respecto a la BD y
    llevado a `status` por SQL. Un `pendiente_pago` con `minutes_ago` < 30 sigue vigente."""
    created = db_now(session) - timedelta(minutes=minutes_ago)
    order = stored_order(session, user_id=user, now=created, lines=lines, **kwargs)
    if status != "pendiente_pago":
        set_status(session, order.id, status)
    return order


def make_overdue(session: Session, order_id: UUID, *, seconds_over: int = 60) -> None:
    """Vence el pedido: `expires_at` queda `seconds_over` segundos en el pasado (0 = justo ahora,
    que ya es vencido: `expires_at ≤ now`; negativo = aún vigente por esos segundos)."""
    session.execute(
        text(
            "UPDATE app.orders SET created_at = now() - interval '2 hours',"
            " expires_at = now() - make_interval(secs => :s) WHERE id = :id"
        ),
        {"s": seconds_over, "id": order_id},
    )


def headers(user: UUID | None) -> dict[str, str]:
    return {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}


def list_orders(shop: OrderShop, user: UUID | None, *params: tuple[str, Any]) -> Any:
    """GET /orders; `params` admite el mismo nombre repetido (`status`)."""
    return shop.client.get(PATH, headers=headers(user), params=list(params))


def read_page(shop: OrderShop, user: UUID, *params: tuple[str, Any]) -> dict[str, Any]:
    response = list_orders(shop, user, *params)
    assert response.status_code == 200, response.text
    return response.json()


def get_order(shop: OrderShop, user: UUID | None, order_id: object) -> Any:
    return shop.client.get(f"{PATH}/{order_id}", headers=headers(user))


def read_order(shop: OrderShop, user: UUID, order_id: object) -> dict[str, Any]:
    response = get_order(shop, user, order_id)
    assert response.status_code == 200, response.text
    return response.json()


def db_status(session: Session, order_id: object) -> str:
    return session.execute(
        text("SELECT status FROM app.orders WHERE id = :id"), {"id": order_id}
    ).scalar_one()


def history_count(session: Session, order_id: object) -> int:
    return session.execute(
        text("SELECT count(*) FROM app.order_status_history WHERE order_id = :id"),
        {"id": order_id},
    ).scalar_one()


def status_changed_audit(session: Session, order_id: object) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            "SELECT actor_id, actor_role, entity_type, before, after FROM app.audit_log"
            " WHERE action = 'orders.status_changed' AND entity_id = :id ORDER BY id"
        ),
        {"id": str(order_id)},
    )
    return [dict(r) for r in rows.mappings()]


def statuses_of(page: dict[str, Any]) -> list[str]:
    return [item["status"] for item in page["items"]]


def ids_of(page: dict[str, Any]) -> list[str]:
    return [item["id"] for item in page["items"]]


def enum_values(*members: OrderStatus) -> list[str]:
    return [m.value for m in members]
