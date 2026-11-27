"""Migración 0012 (T-138; CA-IDENTITY-17): columna, CHECK, reversibilidad y alembic check."""

from collections.abc import Iterator
from datetime import date
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text

pytestmark = pytest.mark.integration

COLUMN = text(
    "SELECT data_type, is_nullable, column_default FROM information_schema.columns"
    " WHERE table_schema = 'app' AND table_name = 'profiles' AND column_name = 'birth_date'"
)
CONSTRAINT = text(
    "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
    " WHERE conrelid = 'app.profiles'::regclass AND conname = 'ck_profiles_birth_date_range'"
)
VERSION = text("SELECT version_num FROM app.alembic_version")


@pytest.fixture
def at_head(alembic_config: Config) -> Iterator[Config]:
    """Garantiza que la BD de pruebas vuelve a `head` aunque la prueba baje de versión."""
    yield alembic_config
    command.upgrade(alembic_config, "head")


def test_0012_exists_after_0011_and_is_the_head_or_before_it(alembic_config: Config) -> None:
    script = ScriptDirectory.from_config(alembic_config)
    revision = script.get_revision("0012")

    assert revision is not None
    assert revision.down_revision == "0011"


def test_upgrade_adds_a_nullable_date_column_with_no_default(db_engine: Engine) -> None:
    with db_engine.connect() as connection:
        [row] = connection.execute(COLUMN).all()

    assert (row.data_type, row.is_nullable, row.column_default) == ("date", "YES", None)


def test_upgrade_adds_the_named_check(db_engine: Engine) -> None:
    with db_engine.connect() as connection:
        definition = connection.scalar(CONSTRAINT)

    assert definition is not None
    assert "birth_date" in definition
    assert "1900-01-01" in definition


def test_alembic_check_finds_no_differences_between_models_and_database(
    alembic_config: Config,
) -> None:
    command.check(alembic_config)  # lanza CommandError si el modelo y la BD discrepan


def test_downgrade_to_0011_drops_column_and_check_and_upgrade_restores_them_with_nulls(
    at_head: Config, db_engine: Engine
) -> None:
    user_id = uuid4()
    with db_engine.begin() as connection:
        connection.execute(
            text("INSERT INTO app.profiles (user_id, birth_date) VALUES (:id, :birth)"),
            {"id": user_id, "birth": date(1990, 5, 17)},
        )
    try:
        command.downgrade(at_head, "0011")

        with db_engine.connect() as connection:
            assert connection.scalars(VERSION).all() == ["0011"]
            assert connection.execute(COLUMN).all() == []
            assert connection.scalar(CONSTRAINT) is None
            # La fila del perfil sobrevive; solo se pierde la fecha.
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM app.profiles WHERE user_id = :id"), {"id": user_id}
                )
                == 1
            )

        command.upgrade(at_head, "head")

        with db_engine.connect() as connection:
            assert connection.scalars(VERSION).all() == [
                ScriptDirectory.from_config(at_head).get_current_head()
            ]
            birth = connection.scalar(
                text("SELECT birth_date FROM app.profiles WHERE user_id = :id"), {"id": user_id}
            )
            assert birth is None  # perfiles existentes: NULL (R12)
            assert connection.execute(COLUMN).one().is_nullable == "YES"
            assert connection.scalar(CONSTRAINT) is not None
    finally:
        with db_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user_id}
            )


def test_upgrade_from_0011_keeps_existing_profiles_null(at_head: Config, db_engine: Engine) -> None:
    command.downgrade(at_head, "0011")
    old = [uuid4() for _ in range(3)]
    try:
        with db_engine.begin() as connection:
            for user in old:
                connection.execute(
                    text("INSERT INTO app.profiles (user_id) VALUES (:id)"), {"id": user}
                )

        command.upgrade(at_head, "0012")

        with db_engine.connect() as connection:
            rows = connection.execute(
                text("SELECT birth_date FROM app.profiles WHERE user_id = ANY(:ids)"),
                {"ids": old},
            ).all()
        assert len(rows) == 3
        assert all(row.birth_date is None for row in rows)
    finally:
        command.upgrade(at_head, "head")
        with db_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM app.profiles WHERE user_id = ANY(:ids)"), {"ids": old}
            )
