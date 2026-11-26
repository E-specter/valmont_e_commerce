"""Carrito: app.carts y app.cart_items (SPEC cart §6).

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "carts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["app.profiles.user_id"],
            name=op.f("fk_carts_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_carts")),
        sa.UniqueConstraint("user_id", name=op.f("uq_carts_user_id")),
        schema="app",
    )
    op.create_table(
        "cart_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("cart_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.SmallInteger(), nullable=False),
        sa.Column("selected", sa.Boolean(), server_default=sa.true(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        # Los topes de CART-R3 (5 y 20) son del dominio; aquí solo la última defensa.
        sa.CheckConstraint("quantity BETWEEN 1 AND 100", name=op.f("ck_cart_items_quantity")),
        sa.ForeignKeyConstraint(
            ["cart_id"],
            ["app.carts.id"],
            name=op.f("fk_cart_items_cart_id_carts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["app.products.id"],
            name=op.f("fk_cart_items_product_id_products"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_cart_items")),
        sa.UniqueConstraint("cart_id", "product_id", name=op.f("uq_cart_items_cart_id_product_id")),
        schema="app",
    )
    op.create_index("ix_cart_items_product_id", "cart_items", ["product_id"], schema="app")
    # D-029 (T-101): el rol de la aplicación gestiona ambas tablas (los artículos se retiran).
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON app.carts, app.cart_items TO valmont_app")


def downgrade() -> None:
    # Destructivo: borra los carritos. Solo en BD locales o de pruebas. Primero los artículos
    # (FK a carts); los índices y los permisos caen con las tablas.
    op.drop_table("cart_items", schema="app")
    op.drop_table("carts", schema="app")
