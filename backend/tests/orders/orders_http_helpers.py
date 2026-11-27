"""Cliente HTTP real contra PostgreSQL para `POST /api/v1/orders` (T-074). Cada solicitud corre en
un SAVEPOINT de la transacción de la prueba (se deshace al terminar); un error de la solicitud
deshace el SAVEPOINT, así que "sin efectos" se comprueba contando filas antes y después. Datos
ficticios; el token es el único origen de la identidad."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_cart, add_item, add_listed, carts_of
from tests.cart.test_http_cart_db import Shop
from tests.identity.identity_helpers import InMemoryProfiles, make_token, use_test_auth
from tests.orders.orders_age_helpers import ADULT_BIRTH, set_birth_date
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Role
from valmont.shared.config import get_settings
from valmont.shared.db import get_session

PATH = "/api/v1/orders"
CDN = "https://cdn.valmont.test"
STORE_ENV = {
    "PICKUP_STORE_NAME": "Boutique Valmont Miraflores",
    "PICKUP_STORE_ADDRESS": "Av. Larco 1234, Miraflores, Lima",
    "PICKUP_STORE_HOURS": "Lunes a sábado, 10:00 a 19:00",
}
SHIPPING: dict[str, Any] = {
    "delivery_method": "shipping",
    "recipient_name": "Ana Torres",
    "phone": "+51987654321",
    "department": "Lima",
    "province": "Lima",
    "district": "Miraflores",
    "address_line": "Av. Larco 345, piso 4",
    "reference": "Frente al parque",
}
PICKUP: dict[str, Any] = {
    "delivery_method": "pickup",
    "recipient_name": "Ana Torres",
    "phone": "+51987654321",
}
PERSONAL = ("Ana Torres", "987654321", "Larco 345", "Miraflores", "Frente al parque")


def money(amount: int) -> dict[str, Any]:
    return {"amount": amount, "currency": "PEN"}


@dataclass
class OrderShop(Shop):
    app: FastAPI
    monkeypatch: pytest.MonkeyPatch

    def user(self, role: Role = Role.CUSTOMER) -> UUID:
        """Cliente de prueba con fecha de nacimiento de adulto (T-139): `POST /orders` la exige."""
        user_id = super().user(role)
        set_birth_date(self.session, user_id, ADULT_BIRTH)
        return user_id

    def set_store(self, **values: str) -> None:
        """Datos de la boutique en el entorno de `Settings` (sin argumentos: ninguno)."""
        names = {"name": "PICKUP_STORE_NAME", "address": "PICKUP_STORE_ADDRESS"}
        names["hours"] = "PICKUP_STORE_HOURS"
        for key, variable in names.items():
            self.monkeypatch.setenv(variable, values.get(key, ""))
        get_settings.cache_clear()

    def override(self, dependency: Callable[..., Any], provider: Callable[..., Any]) -> None:
        self.app.dependency_overrides[dependency] = provider


@pytest.fixture
def shop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[OrderShop]:
    use_test_auth(monkeypatch)
    monkeypatch.setenv("STORAGE_PUBLIC_URL", CDN)
    for variable, value in STORE_ENV.items():
        monkeypatch.setenv(variable, value)
    get_settings.cache_clear()
    profiles = InMemoryProfiles()
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    client = TestClient(app, raise_server_exceptions=False)
    yield OrderShop(db_session, client, profiles, app, monkeypatch)
    get_settings.cache_clear()


def fresh_key() -> str:
    return str(uuid4())


def place(
    shop: OrderShop,
    user: UUID | None,
    *,
    key: str | None = "",
    delivery: Any = None,
    extra: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
) -> Any:
    """POST /orders. `key=""` genera una clave nueva; `key=None` omite la cabecera."""
    sent: dict[str, str] = {}
    if key is not None:
        sent["Idempotency-Key"] = key or fresh_key()
    if user is not None:
        sent["Authorization"] = f"Bearer {make_token(str(user))}"
    sent.update(headers or {})
    payload = {"delivery": SHIPPING if delivery is None else delivery} | (extra or {})
    return shop.client.post(PATH, headers=sent, json=payload, params=params)


def post_raw(shop: OrderShop, user: UUID, body: Any) -> Any:
    """POST con un cuerpo a medida (o sin cuerpo si es None) y una clave válida."""
    headers = {"Idempotency-Key": fresh_key(), "Authorization": f"Bearer {make_token(str(user))}"}
    return (
        shop.client.post(PATH, headers=headers, json=body)
        if body is not None
        else (shop.client.post(PATH, headers=headers))
    )


def stock_in_cart(
    shop: OrderShop, user: UUID, *specs: tuple[UUID, int, bool] | tuple[UUID, int]
) -> UUID:
    """Añade líneas al carrito del cliente (lo crea si falta); selected=True por defecto."""
    [cart_id, *_] = carts_of(shop.session, user) or [add_cart(shop.session, user)]
    for spec in specs:
        product, quantity, selected = (*spec, True)[:3]
        add_item(shop.session, cart_id, product, quantity, selected=selected)
    return cart_id


def quick(shop: OrderShop, quantity: int = 1, **product: Any) -> tuple[UUID, UUID]:
    """(cliente, producto publicado con stock) y el producto en su carrito, seleccionado."""
    user = shop.user()
    product.setdefault("on_hand", 5)
    product_id = add_listed(shop.session, **product)
    stock_in_cart(shop, user, (product_id, quantity))
    return user, product_id


def scalar(session: Session, query: str, **params: Any) -> Any:
    return session.scalar(text(query), params)


def order_row(session: Session, order_id: object) -> dict[str, Any]:
    row = session.execute(text("SELECT * FROM app.orders WHERE id = :id"), {"id": order_id})
    return dict(row.mappings().one())


def line_rows(session: Session, order_id: object) -> list[dict[str, Any]]:
    rows = session.execute(
        text("SELECT * FROM app.order_lines WHERE order_id = :id ORDER BY position"),
        {"id": order_id},
    )
    return [dict(r) for r in rows.mappings()]


def reservations(session: Session, order_id: object) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            "SELECT product_id, quantity, status, expires_at FROM app.stock_reservations"
            " WHERE order_id = :id ORDER BY product_id"
        ),
        {"id": order_id},
    )
    return [dict(r) for r in rows.mappings()]


def available(session: Session, product_id: UUID) -> int:
    query = "SELECT available FROM app.product_availability WHERE product_id = :id"
    return scalar(session, query, id=product_id)


def on_hand(session: Session, product_id: UUID) -> int:
    query = "SELECT on_hand FROM app.inventory_items WHERE product_id = :id"
    return scalar(session, query, id=product_id)


def audit_rows(session: Session, **filters: Any) -> list[dict[str, Any]]:
    clauses = " AND ".join(f"{name} = :{name}" for name in filters) or "true"
    rows = session.execute(
        text(
            "SELECT action, entity_type, entity_id, actor_id, actor_role, before, after"
            f" FROM app.audit_log WHERE {clauses} ORDER BY id"
        ),
        filters,
    )
    return [dict(r) for r in rows.mappings()]


def effects(session: Session, user: UUID, *products: UUID) -> dict[str, Any]:
    """Todo lo que una solicitud de este cliente puede escribir, para comparar antes y después."""
    cart = session.execute(
        text(
            "SELECT i.product_id, i.quantity, i.selected FROM app.cart_items i"
            " JOIN app.carts c ON c.id = i.cart_id WHERE c.user_id = :u"
        ),
        {"u": user},
    )
    return {
        "orders": scalar(session, "SELECT count(*) FROM app.orders WHERE user_id = :u", u=user),
        "lines": scalar(
            session,
            "SELECT count(*) FROM app.order_lines l JOIN app.orders o ON o.id = l.order_id"
            " WHERE o.user_id = :u",
            u=user,
        ),
        "deliveries": scalar(
            session,
            "SELECT count(*) FROM app.deliveries d JOIN app.orders o ON o.id = d.order_id"
            " WHERE o.user_id = :u",
            u=user,
        ),
        "history": scalar(
            session,
            "SELECT count(*) FROM app.order_status_history h JOIN app.orders o"
            " ON o.id = h.order_id WHERE o.user_id = :u",
            u=user,
        ),
        "reservations": scalar(
            session,
            "SELECT count(*) FROM app.stock_reservations WHERE product_id = ANY(:p)",
            p=list(products),
        ),
        "audit": scalar(
            session,
            "SELECT count(*) FROM app.audit_log WHERE actor_id = :u AND action LIKE 'orders.%'",
            u=user,
        ),
        "cart": {row.product_id: (row.quantity, row.selected) for row in cart},
    }


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
