"""Migración 0009 (CA-WISH-10): reversible, encadenada y sin diferencias con los modelos."""

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text

pytestmark = pytest.mark.integration

EXISTS = text("SELECT to_regclass('app.wishlist_items') IS NOT NULL")


def test_0009_follows_0008(migration_config: Config) -> None:
    revision = ScriptDirectory.from_config(migration_config).get_revision("0009")

    assert revision is not None and revision.down_revision == "0008"


def test_downgrade_drops_the_table_and_upgrade_restores_it(
    migration_config: Config, migration_engine: Engine
) -> None:
    command.downgrade(migration_config, "0008")
    with migration_engine.connect() as connection:
        assert connection.scalar(EXISTS) is False
        # Lo que 0008 y las anteriores crearon sigue ahí (FK de 0009: profiles y products).
        assert connection.scalar(
            text(
                "SELECT to_regclass('app.profiles') IS NOT NULL AND"
                " to_regclass('app.products') IS NOT NULL AND"
                " to_regclass('app.cart_items') IS NOT NULL"
            )
        )

    command.upgrade(migration_config, "head")
    with migration_engine.connect() as connection:
        assert connection.scalar(EXISTS) is True


def test_alembic_check_reports_no_pending_changes(migration_config: Config) -> None:
    command.check(migration_config)  # lanza CommandError si los modelos y la BD difieren
