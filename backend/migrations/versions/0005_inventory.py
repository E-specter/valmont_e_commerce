"""Inventario: stock, reservas, movimientos, ajustes y vista de disponibilidad (SPEC inventory §6).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _product_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["product_id"],
        ["app.products.id"],
        name=op.f(f"fk_{table}_product_id_products"),
        ondelete="RESTRICT",
    )


# INVENTORY-R1 y R2 (D-023, D-027); la misma regla que domain.availability_status. De
# app.products (catalog) solo lee id, order_policy y lead_time_days. Sin fila de stock,
# on_hand = 0. La suma va en un LATERAL por producto: con la vista unida a una página de
# productos, cada suma es un escaneo del índice (product_id, status, expires_at).
_AVAILABILITY_VIEW = """
CREATE VIEW app.product_availability AS
SELECT
    p.id AS product_id,
    a.available,
    CASE
        WHEN p.order_policy = 'made_to_order' THEN 'on_request'
        WHEN a.available > s.low_stock_threshold THEN 'in_stock'
        WHEN a.available >= 1 THEN 'low_stock'
        WHEN p.order_policy = 'backorder' THEN 'on_request'
        ELSE 'out_of_stock'
    END AS status,
    p.lead_time_days
FROM app.products AS p
CROSS JOIN app.inventory_settings AS s
LEFT JOIN app.inventory_items AS i ON i.product_id = p.id
CROSS JOIN LATERAL (
    SELECT (coalesce(i.on_hand, 0) - coalesce(sum(r.quantity), 0))::integer AS available
    FROM app.stock_reservations AS r
    WHERE r.product_id = p.id AND r.status = 'active' AND r.expires_at > now()
) AS a
"""


def upgrade() -> None:
    op.create_table(
        "inventory_settings",
        sa.Column("id", sa.SmallInteger(), autoincrement=False, nullable=False),
        sa.Column("low_stock_threshold", sa.Integer(), server_default=sa.text("2"), nullable=False),
        _timestamp("updated_at"),
        sa.CheckConstraint("id = 1", name=op.f("ck_inventory_settings_single_row")),
        sa.CheckConstraint(
            "low_stock_threshold >= 1", name=op.f("ck_inventory_settings_low_stock_threshold")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_settings")),
        schema="app",
    )
    # La fila única (umbral por defecto 2, D-027): la vista y los ajustes cuentan con ella.
    op.execute("INSERT INTO app.inventory_settings (id) VALUES (1)")
    op.create_table(
        "inventory_items",
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("on_hand", sa.Integer(), server_default=sa.text("0"), nullable=False),
        _timestamp("updated_at"),
        sa.CheckConstraint("on_hand >= 0", name=op.f("ck_inventory_items_on_hand")),
        _product_fk("inventory_items"),
        sa.PrimaryKeyConstraint("product_id", name=op.f("pk_inventory_items")),
        schema="app",
    )
    op.create_table(
        "stock_movements",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("quantity_delta", sa.Integer(), nullable=False),
        sa.Column("on_hand_after", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("order_id", sa.Uuid(), nullable=True),
        _timestamp("created_at"),
        sa.CheckConstraint(
            "kind IN ('entrada', 'ajuste_inventario', 'merma', 'devolucion', 'venta')",
            name=op.f("ck_stock_movements_kind"),
        ),
        sa.CheckConstraint(
            "kind NOT IN ('ajuste_inventario', 'merma') OR note IS NOT NULL",
            name=op.f("ck_stock_movements_note_required"),
        ),
        sa.CheckConstraint("on_hand_after >= 0", name=op.f("ck_stock_movements_on_hand_after")),
        sa.CheckConstraint("quantity_delta <> 0", name=op.f("ck_stock_movements_quantity_delta")),
        _product_fk("stock_movements"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_movements")),
        schema="app",
    )
    op.create_index(
        "ix_stock_movements_product_id_created_at",
        "stock_movements",
        ["product_id", "created_at"],
        schema="app",
    )
    op.create_table(
        "stock_reservations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        # Sin FK hasta que exista app.orders (la añadirá la migración de orders).
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _timestamp("created_at"),
        sa.CheckConstraint(
            "status IN ('active', 'consumed', 'released')",
            name=op.f("ck_stock_reservations_status"),
        ),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_stock_reservations_quantity")),
        _product_fk("stock_reservations"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_reservations")),
        schema="app",
    )
    op.create_index(
        "ix_stock_reservations_order_id", "stock_reservations", ["order_id"], schema="app"
    )
    op.create_index(
        "ix_stock_reservations_product_id_status_expires_at",
        "stock_reservations",
        ["product_id", "status", "expires_at"],
        schema="app",
    )
    op.execute(_AVAILABILITY_VIEW)


def downgrade() -> None:
    # Destructivo: borra stock, reservas y movimientos. Solo en BD locales o de pruebas. Los
    # índices caen con su tabla; la vista, primero, porque depende de ellas.
    op.execute("DROP VIEW app.product_availability")
    op.drop_table("stock_reservations", schema="app")
    op.drop_table("stock_movements", schema="app")
    op.drop_table("inventory_items", schema="app")
    op.drop_table("inventory_settings", schema="app")
