"""Pedidos: orders, order_lines, deliveries y order_status_history (SPEC orders §6).

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STATUSES = (
    "'pendiente_pago','pagado','en_preparacion','enviado','listo_para_recojo','entregado',"
    "'cancelado','expirado'"
)
_PAID = "'pagado','en_preparacion','enviado','listo_para_recojo','entregado'"


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "orders",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("order_number", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("subtotal_amount", sa.BigInteger(), nullable=False),
        sa.Column("shipping_amount", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("total_amount", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("estimated_delivery_on", sa.Date(), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refunded_amount", sa.BigInteger(), nullable=True),
        sa.Column("refunded_at", sa.DateTime(timezone=True), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.CheckConstraint(f"status IN ({_STATUSES})", name=op.f("ck_orders_status")),
        sa.CheckConstraint(
            "char_length(idempotency_key) BETWEEN 16 AND 64",
            name=op.f("ck_orders_idempotency_key_length"),
        ),
        sa.CheckConstraint("subtotal_amount > 0", name=op.f("ck_orders_subtotal_positive")),
        sa.CheckConstraint("shipping_amount >= 0", name=op.f("ck_orders_shipping_non_negative")),
        sa.CheckConstraint(
            "total_amount = subtotal_amount + shipping_amount", name=op.f("ck_orders_total_sum")
        ),
        sa.CheckConstraint("expires_at > created_at", name=op.f("ck_orders_expires_after_created")),
        sa.CheckConstraint(
            f"status NOT IN ({_PAID}) OR paid_at IS NOT NULL", name=op.f("ck_orders_paid_at_set")
        ),
        sa.CheckConstraint(
            "(refunded_amount IS NULL) = (refunded_at IS NULL)",
            name=op.f("ck_orders_refund_pair"),
        ),
        sa.CheckConstraint(
            "refunded_amount IS NULL OR (status = 'cancelado' AND refunded_amount = total_amount)",
            name=op.f("ck_orders_refund_total"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["app.profiles.user_id"],
            name=op.f("fk_orders_user_id_profiles"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
        sa.UniqueConstraint("order_number", name=op.f("uq_orders_order_number")),
        sa.UniqueConstraint(
            "user_id", "idempotency_key", name=op.f("uq_orders_user_id_idempotency_key")
        ),
        schema="app",
    )
    op.create_index(
        "ix_orders_user_id_created_at",
        "orders",
        ["user_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="app",
    )
    op.create_index(
        "ix_orders_status_created_at",
        "orders",
        ["status", sa.text("created_at DESC")],
        schema="app",
    )
    op.create_index(
        "ix_orders_expires_at_pending",
        "orders",
        ["expires_at"],
        schema="app",
        postgresql_where=sa.text("status = 'pendiente_pago'"),
    )

    op.create_table(
        "order_lines",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("sku", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("quantity", sa.SmallInteger(), nullable=False),
        sa.Column("list_price_amount", sa.BigInteger(), nullable=False),
        sa.Column("unit_price_amount", sa.BigInteger(), nullable=False),
        sa.Column("discount_amount", sa.BigInteger(), nullable=False),
        sa.Column("line_total_amount", sa.BigInteger(), nullable=False),
        sa.Column("promotion_id", sa.Uuid(), nullable=True),  # sin FK: dato histórico (RN-04)
        sa.Column("fulfillment", sa.Text(), nullable=False),
        sa.Column("lead_time_days", sa.Integer(), nullable=True),
        sa.CheckConstraint("position >= 1", name=op.f("ck_order_lines_position")),
        sa.CheckConstraint("quantity BETWEEN 1 AND 100", name=op.f("ck_order_lines_quantity")),
        sa.CheckConstraint("list_price_amount > 0", name=op.f("ck_order_lines_list_price")),
        sa.CheckConstraint("unit_price_amount > 0", name=op.f("ck_order_lines_unit_price")),
        sa.CheckConstraint("discount_amount >= 0", name=op.f("ck_order_lines_discount")),
        sa.CheckConstraint(
            "discount_amount = list_price_amount - unit_price_amount",
            name=op.f("ck_order_lines_discount_sum"),
        ),
        sa.CheckConstraint(
            "line_total_amount = unit_price_amount * quantity",
            name=op.f("ck_order_lines_line_total"),
        ),
        sa.CheckConstraint(
            "fulfillment IN ('stock','made_to_order')", name=op.f("ck_order_lines_fulfillment")
        ),
        sa.CheckConstraint(
            "lead_time_days IS NULL OR lead_time_days > 0", name=op.f("ck_order_lines_lead_time")
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["app.orders.id"],
            name=op.f("fk_order_lines_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["app.products.id"],
            name=op.f("fk_order_lines_product_id_products"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_lines")),
        sa.UniqueConstraint(
            "order_id", "product_id", name=op.f("uq_order_lines_order_id_product_id")
        ),
        sa.UniqueConstraint("order_id", "position", name=op.f("uq_order_lines_order_id_position")),
        schema="app",
    )
    op.create_index("ix_order_lines_product_id", "order_lines", ["product_id"], schema="app")

    op.create_table(
        "deliveries",
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("delivery_method", sa.Text(), nullable=False),
        sa.Column("recipient_name", sa.Text(), nullable=False),
        sa.Column("phone", sa.Text(), nullable=False),
        sa.Column("department", sa.Text(), nullable=True),
        sa.Column("province", sa.Text(), nullable=True),
        sa.Column("district", sa.Text(), nullable=True),
        sa.Column("address_line", sa.Text(), nullable=True),
        sa.Column("reference", sa.Text(), nullable=True),
        sa.Column("carrier", sa.Text(), nullable=True),
        sa.Column("tracking_code", sa.Text(), nullable=True),
        sa.Column("shipped_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "delivery_method IN ('shipping','pickup')", name=op.f("ck_deliveries_method")
        ),
        sa.CheckConstraint(
            "delivery_method <> 'shipping' OR (department IS NOT NULL AND province IS NOT NULL "
            "AND district IS NOT NULL AND address_line IS NOT NULL)",
            name=op.f("ck_deliveries_shipping_location"),
        ),
        sa.CheckConstraint(
            "delivery_method <> 'pickup' OR (department IS NULL AND province IS NULL "
            "AND district IS NULL AND address_line IS NULL AND reference IS NULL "
            "AND carrier IS NULL AND tracking_code IS NULL AND shipped_at IS NULL)",
            name=op.f("ck_deliveries_pickup_clean"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["app.orders.id"],
            name=op.f("fk_deliveries_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("order_id", name=op.f("pk_deliveries")),
        schema="app",
    )

    op.create_table(
        "order_status_history",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("from_status", sa.Text(), nullable=True),
        sa.Column("to_status", sa.Text(), nullable=False),
        sa.Column("actor_kind", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        _timestamp("created_at"),
        sa.CheckConstraint(
            f"from_status IS NULL OR from_status IN ({_STATUSES})",
            name=op.f("ck_order_status_history_from_status"),
        ),
        sa.CheckConstraint(
            f"to_status IN ({_STATUSES})", name=op.f("ck_order_status_history_to_status")
        ),
        sa.CheckConstraint(
            "actor_kind IN ('customer','admin','system')",
            name=op.f("ck_order_status_history_actor_kind"),
        ),
        sa.CheckConstraint(
            "from_status IS NOT NULL OR to_status = 'pendiente_pago'",
            name=op.f("ck_order_status_history_initial"),
        ),
        sa.CheckConstraint(
            "(actor_kind = 'system') = (actor_id IS NULL)",
            name=op.f("ck_order_status_history_actor"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["app.orders.id"],
            name=op.f("fk_order_status_history_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_status_history")),
        schema="app",
    )
    op.create_index(
        "ix_order_status_history_order_id_id",
        "order_status_history",
        ["order_id", "id"],
        schema="app",
    )

    # D-029 (T-101): pedidos y entrega se actualizan; líneas e historial son de solo inserción y
    # nada se borra. Sin permisos de secuencia: las columnas de identidad ALWAYS no los piden.
    op.execute("GRANT SELECT, INSERT, UPDATE ON app.orders, app.deliveries TO valmont_app")
    op.execute("GRANT SELECT, INSERT ON app.order_lines, app.order_status_history TO valmont_app")


def downgrade() -> None:
    # Destructivo: borra los pedidos. Solo en BD locales o de pruebas. Primero lo que depende de
    # orders; índices, secuencias y permisos caen con las tablas.
    op.drop_table("order_status_history", schema="app")
    op.drop_table("deliveries", schema="app")
    op.drop_table("order_lines", schema="app")
    op.drop_table("orders", schema="app")
