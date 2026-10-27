"""Catálogo: categorías, listas de valores, productos e imágenes (SPEC catalog §6).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _attribute_values(name: str) -> None:
    op.create_table(
        name,
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.PrimaryKeyConstraint("code", name=op.f(f"pk_{name}")),
        schema="app",
    )


def upgrade() -> None:
    # CA-CATALOG-02: buscar sin tildes. unaccent es una extensión "trusted" (sin superusuario)
    # y va en extensions, que PostgREST no expone (en public sería una RPC). Si ya estaba en
    # otro esquema se traslada: IF NOT EXISTS no la movería.
    op.execute("CREATE SCHEMA IF NOT EXISTS extensions")
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions")
    op.execute(
        """
        DO $$
        BEGIN
            IF (SELECT extnamespace::regnamespace::text FROM pg_extension
                WHERE extname = 'unaccent') <> 'extensions' THEN
                ALTER EXTENSION unaccent SET SCHEMA extensions;
            END IF;
        END $$
        """
    )
    # unaccent() no es IMMUTABLE y la columna generada lo exige: se envuelve. Cuerpo SQL
    # estándar (RETURN): se enlaza al crearse y registra la dependencia de la extensión.
    op.execute(
        """
        CREATE FUNCTION app.f_unaccent(text) RETURNS text
            LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
            RETURN extensions.unaccent('extensions.unaccent'::regdictionary, $1)
        """
    )
    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_categories")),
        sa.UniqueConstraint("slug", name=op.f("uq_categories_slug")),
        schema="app",
    )
    _attribute_values("movement_types")
    _attribute_values("case_materials")
    op.create_table(
        "products",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("sku", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("order_policy", sa.Text(), server_default="stock", nullable=False),
        sa.Column("lead_time_days", sa.Integer(), nullable=True),
        sa.Column("movement_code", sa.Text(), nullable=True),
        sa.Column("case_material_code", sa.Text(), nullable=True),
        sa.Column("case_diameter_mm", sa.Numeric(precision=4, scale=1), nullable=True),
        sa.Column("water_resistance_m", sa.Integer(), nullable=True),
        sa.Column(
            "specs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'"),
            nullable=False,
        ),
        sa.Column(
            "search",
            postgresql.TSVECTOR(),
            sa.Computed(
                "to_tsvector('spanish', app.f_unaccent("
                "name || ' ' || sku || ' ' || coalesce(description, '')))",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.CheckConstraint("price_cents >= 0", name=op.f("ck_products_price_cents")),
        sa.CheckConstraint("status IN ('draft', 'published')", name=op.f("ck_products_status")),
        sa.CheckConstraint(
            "order_policy IN ('stock', 'made_to_order', 'backorder')",
            name=op.f("ck_products_order_policy"),
        ),
        sa.CheckConstraint("lead_time_days > 0", name=op.f("ck_products_lead_time_days")),
        sa.CheckConstraint("case_diameter_mm > 0", name=op.f("ck_products_case_diameter_mm")),
        sa.CheckConstraint("water_resistance_m >= 0", name=op.f("ck_products_water_resistance_m")),
        sa.CheckConstraint("jsonb_typeof(specs) = 'array'", name=op.f("ck_products_specs_array")),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["app.categories.id"],
            name=op.f("fk_products_category_id_categories"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["movement_code"],
            ["app.movement_types.code"],
            name=op.f("fk_products_movement_code_movement_types"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["case_material_code"],
            ["app.case_materials.code"],
            name=op.f("fk_products_case_material_code_case_materials"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_products")),
        sa.UniqueConstraint("sku", name=op.f("uq_products_sku")),
        sa.UniqueConstraint("slug", name=op.f("uq_products_slug")),
        schema="app",
    )
    op.create_index(
        "ix_products_search", "products", ["search"], schema="app", postgresql_using="gin"
    )
    op.create_index(
        "ix_products_status_published_at", "products", ["status", "published_at"], schema="app"
    )
    op.create_index("ix_products_category_id", "products", ["category_id"], schema="app")
    op.create_index("ix_products_price_cents", "products", ["price_cents"], schema="app")
    op.create_index("ix_products_movement_code", "products", ["movement_code"], schema="app")
    op.create_index(
        "ix_products_case_material_code", "products", ["case_material_code"], schema="app"
    )
    op.create_table(
        "product_images",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("alt", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        _timestamp("created_at"),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["app.products.id"],
            name=op.f("fk_product_images_product_id_products"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_images")),
        sa.UniqueConstraint("product_id", "position", name=op.f("uq_product_images_product_id")),
        schema="app",
    )


def downgrade() -> None:
    # Destructivo: borra el catálogo. Solo en BD locales o de pruebas. Los índices caen con
    # su tabla. La extensión unaccent y el esquema extensions se quedan: no se sabe si
    # existían antes de 0004.
    op.drop_table("product_images", schema="app")
    op.drop_table("products", schema="app")
    op.drop_table("case_materials", schema="app")
    op.drop_table("movement_types", schema="app")
    op.drop_table("categories", schema="app")
    op.execute("DROP FUNCTION app.f_unaccent(text)")
