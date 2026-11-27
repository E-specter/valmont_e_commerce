"""Ayudas de las transiciones de administración (T-079): la tabla de §5 escrita a mano (no se
importa `admin_targets`: así la prueba no depende del código que verifica), POST de transiciones con
token de administrador, pedidos en un estado y modalidad dados, pedidos reales (compra + pago con
`ConfirmOrderPayment`) y lo que se mira en la BD tras cada transición. Datos ficticios."""

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_listed
from tests.orders.orders_admin_helpers import ADMIN_PATH, audit_count
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from tests.orders.orders_http_helpers import PICKUP, OrderShop, order_row, place, stock_in_cart
from tests.orders.orders_payment_helpers import use_cases
from tests.orders.orders_read_helpers import ALL_STATUSES, headers, make_order
from valmont.modules.orders.application import PaymentOutcome
from valmont.modules.orders.domain import Order

METHODS = ("shipping", "pickup")
# Los cinco destinos que admite `TransitionIn.to` y los tres que el esquema rechaza (R19).
TYPED_TARGETS = ("en_preparacion", "enviado", "listo_para_recojo", "entregado", "cancelado")
UNTYPED_TARGETS = ("pagado", "expirado", "pendiente_pago")
ALL_TARGETS = ALL_STATUSES  # los ocho estados como destino: los 64 pares estado × destino
NOTE = "Motivo interno de la prueba"


def expected_targets(status: str, method: str) -> frozenset[str]:
    """SPEC §5 y R20, escrita a mano."""
    handed = "enviado" if method == "shipping" else "listo_para_recojo"
    table = {
        "pendiente_pago": {"cancelado"},
        "pagado": {"en_preparacion", "cancelado"},
        "en_preparacion": {handed, "cancelado"},
        "enviado": {"entregado"} if method == "shipping" else set(),
        "listo_para_recojo": {"entregado"} if method == "pickup" else set(),
        "entregado": set(),
        "cancelado": set(),
        "expirado": set(),
    }
    return frozenset(table[status])


def refunds(status: str, to: str) -> bool:
    """Solo cancelar un pagado o en preparación genera el reembolso simulado total (R10)."""
    return to == "cancelado" and status in ("pagado", "en_preparacion")


def body_for(to: str, **fields: Any) -> dict[str, Any]:
    """Cuerpo mínimo válido: `cancelado` exige `note`."""
    body: dict[str, Any] = {"to": to}
    if to == "cancelado":
        body["note"] = NOTE
    return body | fields


def transition_path(order_id: object) -> str:
    return f"{ADMIN_PATH}/{order_id}/transitions"


def post_transition(
    shop: OrderShop, user: UUID | None, order_id: object, body: Any, **request: Any
) -> Any:
    extra = request.pop("headers", {})
    return shop.client.post(
        transition_path(order_id), headers={**headers(user), **extra}, json=body, **request
    )


def transition(shop: OrderShop, user: UUID | None, order_id: object, to: str, **fields: Any) -> Any:
    """POST /orders/admin/{id}/transitions con el cuerpo mínimo válido de `to` más `fields`."""
    return post_transition(shop, user, order_id, body_for(to, **fields))


def moved(shop: OrderShop, admin: UUID, order_id: object, to: str, **fields: Any) -> dict[str, Any]:
    response = transition(shop, admin, order_id, to, **fields)
    assert response.status_code == 200, response.text
    return response.json()


def order_in(
    shop: OrderShop,
    status: str,
    method: str = "shipping",
    *,
    user: UUID | None = None,
    **kwargs: Any,
) -> Order:
    """Pedido en `status` con esa modalidad. `pendiente_pago` queda vigente (hace 5 minutos)."""
    delivery = (
        pickup_delivery(recipient_name="Ana Perez")
        if method == "pickup"
        else shipping_delivery(recipient_name="Ana Perez")
    )
    kwargs.setdefault("minutes_ago", 5 if status == "pendiente_pago" else 60)
    return make_order(shop.session, user or shop.user(), status=status, delivery=delivery, **kwargs)


def bought(
    shop: OrderShop, *, pickup: bool = False, quantity: int = 1, on_hand: int = 5
) -> tuple[UUID, str, UUID]:
    """(cliente, id del pedido, producto): pedido `pendiente_pago` real con su reserva."""
    user, product = shop.user(), add_listed(shop.session, on_hand=on_hand)
    stock_in_cart(shop, user, (product, quantity))
    response = place(shop, user, delivery=PICKUP if pickup else None)
    assert response.status_code == 201, response.text
    return user, response.json()["id"], product


def paid(
    shop: OrderShop, *, pickup: bool = False, quantity: int = 1, on_hand: int = 5
) -> tuple[UUID, str, UUID]:
    """Como `bought`, pero pagado con el `ConfirmOrderPayment` real (descuenta el stock)."""
    user, order_id, product = bought(shop, pickup=pickup, quantity=quantity, on_hand=on_hand)
    confirm, *_ = use_cases(shop.session)
    assert confirm(user, UUID(order_id)) == PaymentOutcome.PAID
    return user, order_id, product


def stock_movements(session: Session, order_id: object) -> list[tuple[str, int]]:
    rows = session.execute(
        text(
            "SELECT kind, quantity_delta FROM app.stock_movements WHERE order_id = :id ORDER BY id"
        ),
        {"id": order_id},
    )
    return [(r.kind, r.quantity_delta) for r in rows]


def refund_columns(session: Session, order_id: object) -> tuple[Any, Any]:
    row = session.execute(
        text("SELECT refunded_amount, refunded_at FROM app.orders WHERE id = :id"),
        {"id": order_id},
    ).one()
    return row.refunded_amount, row.refunded_at


def delivery_columns(session: Session, order_id: object) -> tuple[Any, Any, Any]:
    row = session.execute(
        text("SELECT carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id"),
        {"id": order_id},
    ).one()
    return row.carrier, row.tracking_code, row.shipped_at


def total_of(session: Session, order_id: object) -> int:
    return session.execute(
        text("SELECT total_amount FROM app.orders WHERE id = :id"), {"id": order_id}
    ).scalar_one()


def history_of(session: Session, order_id: object) -> list[tuple[Any, ...]]:
    """(from_status, to_status, actor_kind, actor_id, note) de la más antigua a la más reciente."""
    rows = session.execute(
        text(
            "SELECT from_status, to_status, actor_kind, actor_id, note FROM"
            " app.order_status_history WHERE order_id = :id ORDER BY id"
        ),
        {"id": order_id},
    )
    return [tuple(r) for r in rows]


def fingerprint(session: Session, order_id: object) -> dict[str, Any]:
    """Todo lo que una transición puede escribir en el pedido, para comparar antes y después."""
    return {
        "order": order_row(session, order_id),
        "history": history_of(session, order_id),
        "audit": audit_count(session, order_id),
        "delivery": delivery_columns(session, order_id),
    }
