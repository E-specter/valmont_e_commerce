"""Registro de auditoría de solo inserción: app.audit_log (SPEC audit §6).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column("entity_id", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("actor_role", sa.Text(), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.CheckConstraint("action ~ '^[a-z]+\\.[a-z_]+$'", name=op.f("ck_audit_log_action")),
        sa.CheckConstraint(
            "before IS NOT NULL OR after IS NOT NULL", name=op.f("ck_audit_log_before_or_after")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_log")),
        schema="app",
    )
    op.create_index(
        "ix_audit_log_entity",
        "audit_log",
        ["entity_type", "entity_id", "occurred_at"],
        unique=False,
        schema="app",
    )
    op.create_index(
        "ix_audit_log_occurred_at", "audit_log", ["occurred_at"], unique=False, schema="app"
    )
    # Alembic no autogenera funciones ni triggers. Inmutabilidad (RF14.02): ni siquiera el
    # propietario o un superusuario puede cambiar filas sin desactivar antes los triggers.
    op.execute(
        """
        CREATE FUNCTION app.reject_audit_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'app.audit_log es de solo inserción: % rechazado', TG_OP;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_log_reject_update_delete
            BEFORE UPDATE OR DELETE ON app.audit_log
            FOR EACH ROW EXECUTE FUNCTION app.reject_audit_change()
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_log_reject_truncate
            BEFORE TRUNCATE ON app.audit_log
            FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_change()
        """
    )


def downgrade() -> None:
    # Destructivo: borra el registro de auditoría. Solo en BD locales o de pruebas (SPEC §6).
    op.execute("DROP TRIGGER audit_log_reject_truncate ON app.audit_log")
    op.execute("DROP TRIGGER audit_log_reject_update_delete ON app.audit_log")
    op.execute("DROP FUNCTION app.reject_audit_change()")
    op.drop_index("ix_audit_log_occurred_at", table_name="audit_log", schema="app")
    op.drop_index("ix_audit_log_entity", table_name="audit_log", schema="app")
    op.drop_table("audit_log", schema="app")
