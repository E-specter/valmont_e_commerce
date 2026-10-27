"""Rol valmont_app de privilegios mínimos para el backend desplegado (D-029).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-27
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Los roles son del clúster y valmont_test lo comparte: si el rol ya existe no se toca.
    # LOGIN y contraseña se fijan al desplegar (T-100), nunca en una migración.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valmont_app') THEN
                CREATE ROLE valmont_app NOLOGIN;
            END IF;
        END $$
        """
    )
    # Sin CREATE en app ni propiedad de nada; alembic_version, solo el rol de migraciones. Cada
    # tabla nueva se concede en la migración de su módulo: tests/test_app_role.py lo exige.
    op.execute("GRANT USAGE ON SCHEMA app TO valmont_app")
    op.execute(
        """
        GRANT SELECT, INSERT, UPDATE, DELETE ON
            app.profiles, app.categories, app.movement_types, app.case_materials,
            app.products, app.product_images, app.inventory_settings, app.inventory_items,
            app.stock_reservations
        TO valmont_app
        """
    )
    # Solo inserción: el registro de auditoría (RF14.02; UPDATE y DELETE dan permission denied
    # antes de sus triggers) y el libro de movimientos de stock.
    op.execute("GRANT SELECT, INSERT ON app.audit_log, app.stock_movements TO valmont_app")
    op.execute("GRANT SELECT ON app.product_availability TO valmont_app")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO valmont_app")
    # La llaman products.search y las búsquedas. Su cuerpo (RETURN) se enlazó al crearla y no
    # busca extensions.unaccent por nombre: no hace falta USAGE en extensions. EXECUTE en
    # unaccent llega por PUBLIC, como en toda función.
    op.execute("GRANT EXECUTE ON FUNCTION app.f_unaccent(text) TO valmont_app")


def downgrade() -> None:
    # Sin DROP ROLE: el rol es del clúster y otra BD (desarrollo o valmont_test) puede tener aún
    # permisos para él, con lo que DROP ROLE fallaría; en despliegue, además, se perderían el
    # LOGIN y la contraseña de T-100. Sin estos permisos, el rol no alcanza nada de app.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valmont_app') THEN
                REVOKE ALL ON ALL TABLES IN SCHEMA app FROM valmont_app;
                REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM valmont_app;
                REVOKE ALL ON FUNCTION app.f_unaccent(text) FROM valmont_app;
                REVOKE ALL ON SCHEMA app FROM valmont_app;
            END IF;
        END $$
        """
    )
