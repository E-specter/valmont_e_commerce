"""Migración 0007 (CA-PROMOTIONS-14): reversible y sin diferencias con los modelos."""

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text

pytestmark = pytest.mark.integration

OBJECTS = text(
    "SELECT to_regclass('app.promotions') IS NOT NULL,"
    " to_regclass('app.promotion_products') IS NOT NULL,"
    " to_regclass('app.product_effective_price') IS NOT NULL"
)


def test_0007_follows_0006(alembic_config: Config) -> None:
    revision = ScriptDirectory.from_config(alembic_config).get_revision("0007")

    assert revision is not None and revision.down_revision == "0006"


def test_downgrade_drops_the_view_and_tables_and_upgrade_restores_them(
    alembic_config: Config, db_engine: Engine
) -> None:
    command.downgrade(alembic_config, "0006")
    with db_engine.connect() as connection:
        assert connection.execute(OBJECTS).one() == (False, False, False)
        # Las tablas de catalog, de las que depende la vista, siguen ahí.
        assert connection.scalar(text("SELECT to_regclass('app.products') IS NOT NULL"))

    command.upgrade(alembic_config, "head")
    with db_engine.connect() as connection:
        assert connection.execute(OBJECTS).one() == (True, True, True)


def test_alembic_check_reports_no_pending_changes(alembic_config: Config) -> None:
    command.check(alembic_config)  # lanza CommandError si los modelos y la BD difieren
