"""Esquema app cerrado a los roles de la API de datos de Supabase (D-010).

Revision ID: 0001
Revises:
Create Date: 2026-10-26
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # env.py crea el esquema; los IF EXISTS permiten una BD de pruebas sin los roles de Supabase.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                REVOKE ALL ON SCHEMA app FROM anon;
            END IF;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                REVOKE ALL ON SCHEMA app FROM authenticated;
            END IF;
        END $$
        """
    )


def downgrade() -> None:
    # No se borra app (guarda app.alembic_version) ni se devuelven permisos que nunca tuvieron.
    pass
