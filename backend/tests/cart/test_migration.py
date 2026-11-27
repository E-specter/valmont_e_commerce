"""Migración 0008 (CA-CART-15): reversible y sin diferencias con los modelos."""

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text

pytestmark = pytest.mark.integration

OBJECTS = text(
    "SELECT to_regclass('app.carts') IS NOT NULL, to_regclass('app.cart_items') IS NOT NULL"
)


def test_0008_follows_0007(migration_config: Config) -> None:
    revision = ScriptDirectory.from_config(migration_config).get_revision("0008")

    assert revision is not None and revision.down_revision == "0007"


def test_downgrade_drops_both_tables_and_upgrade_restores_them(
    migration_config: Config, migration_engine: Engine
) -> None:
    # cart_items primero: su FK apunta a carts; si el orden fuera el contrario, fallaría.
    command.downgrade(migration_config, "0007")
    with migration_engine.connect() as connection:
        assert connection.execute(OBJECTS).one() == (False, False)
        # Lo que 0007 y las anteriores crearon sigue ahí (FK de 0008: profiles y products).
        assert connection.scalar(
            text(
                "SELECT to_regclass('app.profiles') IS NOT NULL AND"
                " to_regclass('app.products') IS NOT NULL"
            )
        )

    command.upgrade(migration_config, "head")
    with migration_engine.connect() as connection:
        assert connection.execute(OBJECTS).one() == (True, True)


def test_alembic_check_reports_no_pending_changes(migration_config: Config) -> None:
    command.check(migration_config)  # lanza CommandError si los modelos y la BD difieren
