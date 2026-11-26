"""Datos de prueba de wishlist. Ficticios; perfiles y productos se insertan por SQL (con los
helpers de cart) porque wishlist no usa el código de identity ni el de catalog (FK, SPEC §6)."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_product, add_profile, captured

__all__ = ["add_entry", "add_product", "add_profile", "captured", "entries_of"]


def add_entry(
    session: Session, user_id: UUID, product_id: UUID, created_at: datetime | None = None
) -> None:
    """Fila de la lista por SQL; sin created_at usa el default de la BD."""
    columns = "id, user_id, product_id" + (", created_at" if created_at else "")
    marks = "gen_random_uuid(), :user, :product" + (", :created" if created_at else "")
    session.execute(
        text(f"INSERT INTO app.wishlist_items ({columns}) VALUES ({marks})"),
        {"user": user_id, "product": product_id, "created": created_at},
    )


def entries_of(session: Session, user_id: UUID) -> dict[UUID, datetime]:
    """product_id → created_at tal como está en la tabla."""
    rows = session.execute(
        text("SELECT product_id, created_at FROM app.wishlist_items WHERE user_id = :id"),
        {"id": user_id},
    )
    return {product_id: created_at for product_id, created_at in rows}
