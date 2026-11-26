"""Datos de prueba de cart. Ficticios; perfiles y productos se insertan por SQL porque cart no usa
el código de identity ni el de catalog (FK a app.profiles y app.products, SPEC §6)."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import event, text
from sqlalchemy.orm import Session


def add_profile(session: Session) -> UUID:
    user_id = uuid4()
    session.execute(text("INSERT INTO app.profiles (user_id) VALUES (:id)"), {"id": user_id})
    return user_id


def add_product(session: Session) -> UUID:
    """Producto mínimo en app.products (borrador); cart solo necesita que la fila exista."""
    product_id, tag = uuid4(), uuid4().hex[:8]
    category_id = uuid4()
    session.execute(
        text("INSERT INTO app.categories (id, slug, name) VALUES (:id, :slug, 'Carrito')"),
        {"id": category_id, "slug": f"carrito-{tag}"},
    )
    session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id,"
            " price_cents) VALUES (:id, :sku, :slug, 'Reloj de prueba', 'Reloj ficticio.',"
            " :category, 100000)"
        ),
        {
            "id": product_id,
            "sku": f"TST-CRT-{tag}",
            "slug": f"carrito-{tag}",
            "category": category_id,
        },
    )
    return product_id


def add_cart(session: Session, user_id: UUID) -> UUID:
    cart_id = uuid4()
    session.execute(
        text("INSERT INTO app.carts (id, user_id) VALUES (:id, :user)"),
        {"id": cart_id, "user": user_id},
    )
    return cart_id


def add_item(
    session: Session,
    cart_id: UUID,
    product_id: UUID,
    quantity: int = 1,
    *,
    selected: bool = True,
    created_at: datetime | None = None,
) -> None:
    """Línea por SQL; sin created_at usa el default de la BD."""
    columns = "cart_id, product_id, quantity, selected" + (", created_at" if created_at else "")
    marks = ":cart, :product, :quantity, :selected" + (", :created" if created_at else "")
    session.execute(
        text(f"INSERT INTO app.cart_items (id, {columns}) VALUES (gen_random_uuid(), {marks})"),
        {
            "cart": cart_id,
            "product": product_id,
            "quantity": quantity,
            "selected": selected,
            "created": created_at,
        },
    )


def lines_of(session: Session, cart_id: UUID) -> dict[UUID, tuple[int, bool]]:
    """product_id → (quantity, selected) tal como está en la tabla."""
    rows = session.execute(
        text("SELECT product_id, quantity, selected FROM app.cart_items WHERE cart_id = :id"),
        {"id": cart_id},
    )
    return {product_id: (quantity, selected) for product_id, quantity, selected in rows}


def carts_of(session: Session, user_id: UUID) -> list[UUID]:
    return list(
        session.scalars(text("SELECT id FROM app.carts WHERE user_id = :id"), {"id": user_id})
    )


@contextmanager
def captured(session: Session) -> Iterator[list[str]]:
    """Las sentencias SQL que la sesión envía dentro del bloque."""
    connection = session.connection()
    statements: list[str] = []

    def capture(*args: Any) -> None:
        statements.append(args[2])

    event.listen(connection, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(connection, "before_cursor_execute", capture)
