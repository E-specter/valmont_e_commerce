import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

pytestmark = pytest.mark.integration

VERSION = text("SELECT version_num FROM app.alembic_version")


def test_upgrade_creates_app_schema_with_version_table(
    alembic_config: Config, db_session: Session
) -> None:
    head = ScriptDirectory.from_config(alembic_config).get_current_head()

    assert db_session.scalars(VERSION).all() == [head]


def test_app_schema_is_closed_to_supabase_api_roles(db_session: Session) -> None:
    # NULL si la BD no tiene esos roles; False si existen y no tienen USAGE.
    query = text(
        "SELECT bool_or(has_schema_privilege(rolname, 'app', 'USAGE')) FROM pg_roles"
        " WHERE rolname IN ('anon', 'authenticated')"
    )

    assert db_session.scalar(query) is not True


def test_migrations_go_down_to_base_and_up_again(
    migration_config: Config, migration_engine: Engine
) -> None:
    head = ScriptDirectory.from_config(migration_config).get_current_head()

    command.downgrade(migration_config, "base")
    with migration_engine.connect() as connection:
        assert connection.scalars(VERSION).all() == []

    command.upgrade(migration_config, "head")
    with migration_engine.connect() as connection:
        assert connection.scalars(VERSION).all() == [head]
