"""Perfil: fecha de nacimiento fijable una sola vez (SPEC identity §13, D-045).

Aditiva y reversible. El downgrade destruye las fechas guardadas: no se ejecuta en un entorno
con clientes reales sin copia y aprobación del usuario.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("profiles", sa.Column("birth_date", sa.Date(), nullable=True), schema="app")
    op.create_check_constraint(
        op.f("ck_profiles_birth_date_range"),
        "profiles",
        "birth_date >= DATE '1900-01-01'",
        schema="app",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_profiles_birth_date_range"), "profiles", schema="app")
    op.drop_column("profiles", "birth_date", schema="app")
