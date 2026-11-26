"""Promociones: tablas, alcance por productos y vista del precio vigente (SPEC promotions §6).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


# PROMOTIONS-R3, R4, R5 y R6 (D-037). De app.products (catalog) solo lee id, price_cents y
# category_id. Una fila por producto; de las promociones vigentes que lo cubren gana la de menor
# precio final (mayor descuento) y, con empate, la de menor id. R6: bigint en el porcentaje y
# descuento <= precio - 1 (precio final >= 1 céntimo); un descuento 0 no cuenta como aplicado.
_EFFECTIVE_PRICE_VIEW = """
CREATE VIEW app.product_effective_price AS
SELECT
    p.id AS product_id,
    p.price_cents AS list_price_cents,
    p.price_cents - coalesce(b.discount, 0) AS effective_price_cents,
    coalesce(b.discount, 0) AS discount_amount_cents,
    b.promotion_id
FROM app.products AS p
LEFT JOIN LATERAL (
    SELECT c.id AS promotion_id, c.discount
    FROM (
        SELECT
            pr.id,
            least(
                CASE pr.kind
                    WHEN 'percent' THEN (p.price_cents::bigint * pr.percent_off + 50) / 100
                    ELSE pr.amount_off_cents
                END,
                greatest(p.price_cents - 1, 0)
            )::integer AS discount
        FROM app.promotions AS pr
        WHERE pr.is_active AND pr.starts_at <= now() AND now() < pr.ends_at
          AND (
              pr.scope = 'catalog'
              OR (pr.scope = 'category' AND pr.category_id = p.category_id)
              OR (pr.scope = 'products' AND EXISTS (
                  SELECT 1 FROM app.promotion_products AS pp
                  WHERE pp.promotion_id = pr.id AND pp.product_id = p.id
              ))
          )
    ) AS c
    WHERE c.discount > 0
    ORDER BY c.discount DESC, c.id
    LIMIT 1
) AS b ON true
"""


def upgrade() -> None:
    op.create_table(
        "promotions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("percent_off", sa.SmallInteger(), nullable=True),
        sa.Column("amount_off_cents", sa.Integer(), nullable=True),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.CheckConstraint(
            "char_length(name) BETWEEN 1 AND 120", name=op.f("ck_promotions_name_length")
        ),
        sa.CheckConstraint("kind IN ('percent', 'fixed_amount')", name=op.f("ck_promotions_kind")),
        sa.CheckConstraint(
            "(kind = 'percent' AND percent_off IS NOT NULL AND percent_off BETWEEN 1 AND 90 "
            "AND amount_off_cents IS NULL) "
            "OR (kind = 'fixed_amount' AND amount_off_cents IS NOT NULL AND amount_off_cents >= 1 "
            "AND percent_off IS NULL)",
            name=op.f("ck_promotions_value"),
        ),
        sa.CheckConstraint(
            "scope IN ('products', 'category', 'catalog')", name=op.f("ck_promotions_scope")
        ),
        sa.CheckConstraint(
            "(scope = 'category') = (category_id IS NOT NULL)",
            name=op.f("ck_promotions_category_scope"),
        ),
        sa.CheckConstraint("ends_at > starts_at", name=op.f("ck_promotions_dates")),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["app.categories.id"],
            name=op.f("fk_promotions_category_id_categories"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_promotions")),
        sa.UniqueConstraint("id", "scope", name=op.f("uq_promotions_id")),
        schema="app",
    )
    op.create_index(
        "ix_promotions_is_active_starts_at_ends_at",
        "promotions",
        ["is_active", "starts_at", "ends_at"],
        schema="app",
    )
    op.create_index(
        "ix_promotions_category_id",
        "promotions",
        ["category_id"],
        schema="app",
        postgresql_where=sa.text("category_id IS NOT NULL"),
    )
    op.create_table(
        "promotion_products",
        sa.Column("promotion_id", sa.Uuid(), nullable=False),
        sa.Column("scope", sa.Text(), server_default="products", nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.CheckConstraint("scope = 'products'", name=op.f("ck_promotion_products_scope")),
        sa.ForeignKeyConstraint(
            ["promotion_id", "scope"],
            ["app.promotions.id", "app.promotions.scope"],
            name=op.f("fk_promotion_products_promotion_id_promotions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["app.products.id"],
            name=op.f("fk_promotion_products_product_id_products"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("promotion_id", "product_id", name=op.f("pk_promotion_products")),
        schema="app",
    )
    op.create_index(
        "ix_promotion_products_product_id", "promotion_products", ["product_id"], schema="app"
    )
    op.execute(_EFFECTIVE_PRICE_VIEW)
    # D-029 (T-101): cada objeto nuevo de app se concede al rol de la aplicación. Sin DELETE
    # no se podría reemplazar la lista de productos; las promociones no se borran desde la API.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON app.promotions, app.promotion_products "
        "TO valmont_app"
    )
    op.execute("GRANT SELECT ON app.product_effective_price TO valmont_app")


def downgrade() -> None:
    # Destructivo: borra las promociones. Solo en BD locales o de pruebas. La vista, primero,
    # porque depende de las tablas; los índices y los permisos caen con ellas.
    op.execute("DROP VIEW app.product_effective_price")
    op.drop_table("promotion_products", schema="app")
    op.drop_table("promotions", schema="app")
