"""Lista de deseos: app.wishlist_items (SPEC wishlist §6).

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "wishlist_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["app.profiles.user_id"],
            name=op.f("fk_wishlist_items_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["app.products.id"],
            name=op.f("fk_wishlist_items_product_id_products"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_wishlist_items")),
        sa.UniqueConstraint(
            "user_id", "product_id", name=op.f("uq_wishlist_items_user_id_product_id")
        ),
        schema="app",
    )
    op.create_index("ix_wishlist_items_product_id", "wishlist_items", ["product_id"], schema="app")
    # D-029 (T-101): la aplicación agrega y retira; nunca actualiza una fila.
    op.execute("GRANT SELECT, INSERT, DELETE ON app.wishlist_items TO valmont_app")


def downgrade() -> None:
    # Destructivo: borra las listas (solo BD locales o de pruebas); índice y permisos caen con ella.
    op.drop_table("wishlist_items", schema="app")
