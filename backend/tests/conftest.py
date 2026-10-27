from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import URL, Engine, create_engine, make_url, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from valmont.shared.config import get_settings

DB_HINT = "Arranca Supabase: npm run db:start"
MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def _create_database_if_missing(url: URL) -> None:
    # connect_timeout: sin él, psycopg espera 130 s si Supabase no está arrancado.
    admin = create_engine(
        url.set(database="postgres"),
        isolation_level="AUTOCOMMIT",
        connect_args={"connect_timeout": 5},
    )
    try:
        with admin.connect() as connection:
            query = text("SELECT 1 FROM pg_database WHERE datname = :name")
            if connection.scalar(query, {"name": url.database}) is None:
                # CREATE DATABASE no admite parámetros: se cita el identificador.
                name = connection.dialect.identifier_preparer.quote(url.database)
                connection.exec_driver_sql(f"CREATE DATABASE {name}")
    finally:
        admin.dispose()


@pytest.fixture(scope="session")
def alembic_config() -> Config:
    raw_url = get_settings().test_database_url
    if not raw_url:
        pytest.fail(f"Falta TEST_DATABASE_URL en backend/.env. {DB_HINT}", pytrace=False)
    url = make_url(raw_url)
    # Las pruebas bajan las migraciones: nunca contra una BD que no sea de pruebas.
    if not (url.database or "").endswith("_test"):
        pytest.fail("TEST_DATABASE_URL debe apuntar a una BD *_test.", pytrace=False)
    try:
        _create_database_if_missing(url)
    except OperationalError as exc:
        pytest.fail(f"{DB_HINT} ({exc.orig})", pytrace=False)
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.attributes["database_url"] = raw_url
    command.upgrade(config, "head")
    return config


@pytest.fixture(scope="session")
def db_engine(alembic_config: Config) -> Iterator[Engine]:
    engine = create_engine(alembic_config.attributes["database_url"], pool_pre_ping=True)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(db_engine: Engine) -> Iterator[Session]:
    with db_engine.connect() as connection:
        connection.begin()
        with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
            yield session
        connection.rollback()
