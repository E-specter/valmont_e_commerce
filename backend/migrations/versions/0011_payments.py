"""Pagos: payment_attempts, tabla de solo inserción (SPEC payments §6).

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "payment_attempts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("card_last4", sa.Text(), nullable=False),
        sa.Column("gateway", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(idempotency_key) BETWEEN 16 AND 64",
            name=op.f("ck_payment_attempts_idempotency_key"),
        ),
        sa.CheckConstraint(
            "status IN ('approved','rejected')", name=op.f("ck_payment_attempts_status")
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_payment_attempts_amount_positive")),
        sa.CheckConstraint(
            "failure_code ~ '^[a-z_]{1,40}$'", name=op.f("ck_payment_attempts_failure_code_format")
        ),
        sa.CheckConstraint(
            "card_last4 ~ '^[0-9]{4}$'", name=op.f("ck_payment_attempts_card_last4_format")
        ),
        sa.CheckConstraint(
            "char_length(gateway) BETWEEN 1 AND 30",
            name=op.f("ck_payment_attempts_gateway_length"),
        ),
        sa.CheckConstraint(
            "(status = 'rejected') = (failure_code IS NOT NULL)",
            name=op.f("ck_payment_attempts_failure_pair"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["app.orders.id"],
            name=op.f("fk_payment_attempts_order_id_orders"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["app.profiles.user_id"],
            name=op.f("fk_payment_attempts_user_id_profiles"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payment_attempts")),
        sa.UniqueConstraint(
            "user_id",
            "idempotency_key",
            name=op.f("uq_payment_attempts_user_id_idempotency_key"),
        ),
        schema="app",
    )
    op.create_index(
        "uq_payment_attempts_order_approved",
        "payment_attempts",
        ["order_id"],
        unique=True,
        schema="app",
        postgresql_where=sa.text("status = 'approved'"),
    )
    op.create_index(
        "ix_payment_attempts_order_id_created_at",
        "payment_attempts",
        ["order_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="app",
    )
    op.execute("GRANT SELECT, INSERT ON app.payment_attempts TO valmont_app")


def downgrade() -> None:
    # Destructivo: borra el historial de intentos; solo en BD locales o de pruebas.
    op.drop_table("payment_attempts", schema="app")
