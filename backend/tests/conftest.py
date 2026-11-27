from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import URL, Engine, create_engine, make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from valmont.shared.config import get_settings

DB_HINT = "Arranca Supabase: npm run db:start"
TEMP_INFIX = "_tmp_"
MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def _admin_engine(url: URL) -> Engine:
    # connect_timeout: sin él, psycopg espera 130 s si Supabase no está arrancado.
    return create_engine(
        url.set(database="postgres"),
        isolation_level="AUTOCOMMIT",
        connect_args={"connect_timeout": 5},
    )


def _base_test_url() -> URL:
    raw_url = get_settings().test_database_url
    if not raw_url:
        pytest.fail(f"Falta TEST_DATABASE_URL en backend/.env. {DB_HINT}", pytrace=False)
    url = make_url(raw_url)
    # Las pruebas bajan las migraciones: nunca contra una BD que no sea de pruebas.
    if not (url.database or "").endswith("_test"):
        pytest.fail("TEST_DATABASE_URL debe apuntar a una BD *_test.", pytrace=False)
    return url


@contextmanager
def _temporary_database(kind: str) -> Iterator[Config]:
    """BD propia de esta ejecución, migrada a `head`: la crea y la borra la suite.

    Nunca se toca la BD base (`valmont_test`) ni la de desarrollo: solo se borra lo que lleva el
    prefijo `<base>_tmp_` y que esta misma llamada creó. Así varias ejecuciones a la vez (agentes
    en paralelo) no se pisan, y las pruebas de migración pueden bajar y subir sin riesgo.
    """
    base = _base_test_url()
    name = f"{base.database}{TEMP_INFIX}{kind}_{uuid4().hex[:8]}"
    assert name.startswith(f"{base.database}{TEMP_INFIX}")  # lo único que se borra
    admin = _admin_engine(base)
    try:
        with admin.connect() as connection:
            # CREATE/DROP DATABASE no admiten parámetros: se cita el identificador.
            quoted = connection.dialect.identifier_preparer.quote(name)
            try:
                connection.exec_driver_sql(f"CREATE DATABASE {quoted}")
            except OperationalError as exc:
                pytest.fail(f"{DB_HINT} ({exc.orig})", pytrace=False)
            try:
                config = Config()
                config.set_main_option("script_location", str(MIGRATIONS_DIR))
                config.attributes["database_url"] = base.set(database=name).render_as_string(
                    hide_password=False
                )
                command.upgrade(config, "head")
                yield config
            finally:
                # FORCE: cierra conexiones que alguna prueba dejara abiertas.
                connection.exec_driver_sql(f"DROP DATABASE IF EXISTS {quoted} WITH (FORCE)")
    finally:
        admin.dispose()


@pytest.fixture(scope="session")
def alembic_config() -> Iterator[Config]:
    with _temporary_database("run") as config:
        yield config


@pytest.fixture(scope="session")
def db_engine(alembic_config: Config) -> Iterator[Engine]:
    engine = create_engine(alembic_config.attributes["database_url"], pool_pre_ping=True)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def migration_config() -> Iterator[Config]:
    """BD aparte para las pruebas que bajan y suben migraciones; nunca la de `alembic_config`."""
    with _temporary_database("mig") as config:
        yield config


@pytest.fixture(scope="session")
def migration_engine(migration_config: Config) -> Iterator[Engine]:
    engine = create_engine(migration_config.attributes["database_url"], pool_pre_ping=True)
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(db_engine: Engine) -> Iterator[Session]:
    with db_engine.connect() as connection:
        connection.begin()
        with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
            yield session
        connection.rollback()
