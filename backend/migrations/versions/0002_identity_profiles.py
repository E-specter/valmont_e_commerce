"""Perfiles de identity: app.profiles (SPEC identity §6).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Sin FK a auth.users: es de Supabase y no existe en la BD de pruebas (SPEC §6).
    op.create_table(
        "profiles",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.Text(), server_default="customer", nullable=False),
        sa.Column("full_name", sa.Text(), nullable=True),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column(
            "preferences",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("privacy_version", sa.Text(), nullable=True),
        sa.Column("privacy_accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "marketing_opt_in", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(preferences) = 'object'", name=op.f("ck_profiles_preferences_object")
        ),
        sa.CheckConstraint("role IN ('customer', 'admin')", name=op.f("ck_profiles_role")),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_profiles")),
        schema="app",
    )


def downgrade() -> None:
    # Destructivo: borra los perfiles. Solo en BD locales o de pruebas.
    op.drop_table("profiles", schema="app")
