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


LEAD_TIME_DAYS = 21


def add_listed(
    session: Session,
    *,
    price: int = 100000,
    policy: str = "stock",
    on_hand: int | None = None,
    status: str = "published",
    category_id: UUID | None = None,
    name: str = "Reloj de prueba",
    image: tuple[str, str] | None = None,
) -> UUID:
    """Producto publicable de la T-057: política, precio, estado, stock (None: sin fila de
    inventario) e imagen (ruta, alt). Con política distinta de `stock` lleva plazo de 21 días."""
    product_id, tag = uuid4(), uuid4().hex[:8]
    if category_id is None:
        category_id = uuid4()
        session.execute(
            text("INSERT INTO app.categories (id, slug, name) VALUES (:id, :slug, 'Lectura')"),
            {"id": category_id, "slug": f"lectura-{tag}"},
        )
    session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id,"
            " price_cents, status, order_policy, lead_time_days, published_at) VALUES (:id, :sku,"
            " :slug, :name, 'Reloj ficticio.', :category, :price, :status, :policy, :lead,"
            " CASE WHEN :status = 'published' THEN now() END)"
        ),
        {
            "id": product_id,
            "sku": f"TST-LEC-{tag}",
            "slug": f"lectura-{tag}",
            "name": name,
            "category": category_id,
            "price": price,
            "status": status,
            "policy": policy,
            "lead": None if policy == "stock" else LEAD_TIME_DAYS,
        },
    )
    if on_hand is not None:
        session.execute(
            text("INSERT INTO app.inventory_items (product_id, on_hand) VALUES (:id, :n)"),
            {"id": product_id, "n": on_hand},
        )
    if image is not None:
        add_image(session, product_id, *image)
    return product_id


def add_image(
    session: Session, product_id: UUID, path: str, alt: str = "Vista frontal", position: int = 0
) -> None:
    session.execute(
        text(
            "INSERT INTO app.product_images (id, product_id, storage_path, alt, position)"
            " VALUES (gen_random_uuid(), :product, :path, :alt, :position)"
        ),
        {"product": product_id, "path": path, "alt": alt, "position": position},
    )


def identity_of(session: Session, product_id: UUID) -> tuple[str, str, str]:
    """(sku, slug, name) tal como están en app.products."""
    row = session.execute(
        text("SELECT sku, slug, name FROM app.products WHERE id = :id"), {"id": product_id}
    ).one()
    return row[0], row[1], row[2]


def set_product(session: Session, product_id: UUID, **columns: object) -> None:
    """Cambia columnas de app.products (precio, estado, política...) como lo haría catalog."""
    assignments = ", ".join(f"{column} = :{column}" for column in columns)
    session.execute(
        text(f"UPDATE app.products SET {assignments} WHERE id = :id"),
        {**columns, "id": product_id},
    )
