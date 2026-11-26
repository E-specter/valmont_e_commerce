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


def test_0008_follows_0007(alembic_config: Config) -> None:
    revision = ScriptDirectory.from_config(alembic_config).get_revision("0008")

    assert revision is not None and revision.down_revision == "0007"


def test_downgrade_drops_both_tables_and_upgrade_restores_them(
    alembic_config: Config, db_engine: Engine
) -> None:
    # cart_items primero: su FK apunta a carts; si el orden fuera el contrario, fallaría.
    command.downgrade(alembic_config, "0007")
    with db_engine.connect() as connection:
        assert connection.execute(OBJECTS).one() == (False, False)
        # Lo que 0007 y las anteriores crearon sigue ahí (FK de 0008: profiles y products).
        assert connection.scalar(
            text(
                "SELECT to_regclass('app.profiles') IS NOT NULL AND"
                " to_regclass('app.products') IS NOT NULL"
            )
        )

    command.upgrade(alembic_config, "head")
    with db_engine.connect() as connection:
        assert connection.execute(OBJECTS).one() == (True, True)


def test_alembic_check_reports_no_pending_changes(alembic_config: Config) -> None:
    command.check(alembic_config)  # lanza CommandError si los modelos y la BD difieren
