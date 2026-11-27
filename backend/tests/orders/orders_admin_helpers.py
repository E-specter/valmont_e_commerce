"""Ayudas de la administración de pedidos (T-078): GET con token de administrador, pedidos con
destinatario único (cada prueba filtra por su propia etiqueta y no depende de otras filas de la BD
de pruebas), antigüedad en la hora de Lima a medida y las claves exactas de las salidas de §7.
Datos ficticios."""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.orders.orders_create_helpers import DETAIL_KEYS, SUMMARY_KEYS
from tests.orders.orders_db_helpers import letters
from tests.orders.orders_helpers import shipping_delivery
from tests.orders.orders_http_helpers import PATH, OrderShop
from tests.orders.orders_read_helpers import headers, make_order
from valmont.modules.identity.domain import Role
from valmont.modules.orders.domain import Order

ADMIN_PATH = f"{PATH}/admin"
ADMIN_SUMMARY_KEYS = SUMMARY_KEYS | {"user_id", "recipient_name", "district"}
ADMIN_DETAIL_KEYS = DETAIL_KEYS | {"user_id", "can_transition_to"}
ADMIN_HISTORY_KEYS = {"from_status", "status", "at", "actor", "actor_id", "note"}
PERSONAL_DELIVERY = ("987654321", "Larco 1234", "Frente al parque")  # de `shipping_delivery()`


def admin_of(shop: OrderShop) -> UUID:
    return shop.user(Role.ADMIN)


def admin_list(shop: OrderShop, user: UUID | None, *params: tuple[str, Any]) -> Any:
    """GET /orders/admin; `params` admite repetir un nombre."""
    return shop.client.get(ADMIN_PATH, headers=headers(user), params=list(params))


def admin_page(shop: OrderShop, admin: UUID, *params: tuple[str, Any]) -> dict[str, Any]:
    response = admin_list(shop, admin, *params)
    assert response.status_code == 200, response.text
    return response.json()


def admin_get(shop: OrderShop, user: UUID | None, order_id: object) -> Any:
    return shop.client.get(f"{ADMIN_PATH}/{order_id}", headers=headers(user))


def admin_order(shop: OrderShop, admin: UUID, order_id: object) -> dict[str, Any]:
    response = admin_get(shop, admin, order_id)
    assert response.status_code == 200, response.text
    return response.json()


def named_order(
    shop: OrderShop, user: UUID, name: str, *, district: str = "Miraflores", **kwargs: Any
) -> Order:
    """Pedido de envío (por defecto `pagado`, hace 60 min) con ese destinatario."""
    kwargs.setdefault("delivery", shipping_delivery(recipient_name=name, district=district))
    return make_order(shop.session, user, **kwargs)


def tag() -> str:
    """Etiqueta única de solo letras para el nombre del destinatario."""
    return letters()


def set_created_at(session: Session, order_id: UUID, created_at: datetime) -> None:
    """Fija `created_at` (y un `expires_at` coherente con el CHECK). Usar solo con pedidos que no
    sean `pendiente_pago`: uno antiguo vencería al leerlo."""
    session.execute(
        text(
            "UPDATE app.orders SET created_at = :c, expires_at = :c + interval '30 minutes'"
            " WHERE id = :id"
        ),
        {"c": created_at, "id": order_id},
    )


def audit_count(session: Session, order_id: object) -> int:
    return session.execute(
        text("SELECT count(*) FROM app.audit_log WHERE entity_id = :id"), {"id": str(order_id)}
    ).scalar_one()
