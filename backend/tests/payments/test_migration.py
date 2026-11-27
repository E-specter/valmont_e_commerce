"""Migración 0011 (CA-PAYMENTS-15): encadenada, reversible (también con intentos dentro) y sin
diferencias con los modelos (`alembic check`). El downgrade es destructivo (SPEC §6): solo contra
la BD de pruebas, que las fixtures `migration_config` y `migration_engine` ya garantizan."""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import insert_order_row
from tests.payments.payments_db_helpers import insert_attempt_row, rejected_row

pytestmark = pytest.mark.integration

EXISTS = text("SELECT to_regclass('app.payment_attempts') IS NOT NULL")
INDEXES = text(
    "SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes"
    " WHERE schemaname = 'app' AND tablename = 'payment_attempts'"
)
GRANTS = text(
    "SELECT array_agg(p.privilege ORDER BY p.privilege) FROM unnest(ARRAY['SELECT', 'INSERT',"
    " 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)"
    " WHERE has_table_privilege('valmont_app', 'app.payment_attempts', p.privilege)"
)
ENV = Path(__file__).resolve().parents[2] / "migrations" / "env.py"


def test_0011_follows_0010(migration_config: Config) -> None:
    revision = ScriptDirectory.from_config(migration_config).get_revision("0011")

    assert revision is not None and revision.down_revision == "0010"


def test_0011_is_the_only_revision_after_0010(migration_config: Config) -> None:
    script = ScriptDirectory.from_config(migration_config)

    children = [r.revision for r in script.walk_revisions() if r.down_revision == "0010"]

    assert children == ["0011"]


def test_the_payments_models_are_registered_in_the_migration_environment() -> None:
    assert "valmont.modules.payments.adapters.persistence" in ENV.read_text(encoding="utf-8")


def test_downgrade_drops_the_table_and_upgrade_restores_it_with_its_grants(
    migration_config: Config, migration_engine: Engine
) -> None:
    with migration_engine.connect() as connection:
        indexes = connection.scalar(INDEXES)
    command.downgrade(migration_config, "0010")
    try:
        with migration_engine.connect() as connection:
            assert connection.scalar(EXISTS) is False
            # Lo de 0010 y anteriores sigue ahí: orders (FK de 0011) y profiles.
            assert connection.scalar(
                text(
                    "SELECT to_regclass('app.orders') IS NOT NULL AND"
                    " to_regclass('app.profiles') IS NOT NULL AND"
                    " to_regclass('app.order_status_history') IS NOT NULL"
                )
            )
            assert connection.scalar(text("SELECT version_num FROM app.alembic_version")) == "0010"
    finally:
        command.upgrade(migration_config, "head")

    with migration_engine.connect() as connection:
        assert connection.scalar(EXISTS) is True
        assert connection.scalar(INDEXES) == indexes
        assert connection.scalar(GRANTS) == ["INSERT", "SELECT"]


def test_downgrade_works_with_attempts_inside_and_upgrade_leaves_the_table_empty(
    migration_config: Config, migration_engine: Engine
) -> None:
    # El downgrade borra el historial de intentos (SPEC §6) y no debe chocar con sus FK.
    with Session(migration_engine) as session, session.begin():
        user = add_profile(session)
        order = insert_order_row(session, user)
        insert_attempt_row(session, order, user)
        rejected_row(session, order, user)
    try:
        command.downgrade(migration_config, "0010")
        with migration_engine.connect() as connection:
            assert connection.scalar(EXISTS) is False
            # Pedido y perfil sobreviven al downgrade.
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM app.orders WHERE id = :id"), {"id": order}
                )
                == 1
            )
    finally:
        command.upgrade(migration_config, "head")
        with Session(migration_engine) as session, session.begin():
            session.execute(text("DELETE FROM app.orders WHERE id = :id"), {"id": order})
            session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})

    with migration_engine.connect() as connection:
        assert connection.scalar(EXISTS) is True
        assert connection.scalar(text("SELECT count(*) FROM app.payment_attempts")) == 0


def test_upgrade_after_downgrade_enforces_the_partial_index_again(
    migration_config: Config, migration_engine: Engine
) -> None:
    command.downgrade(migration_config, "0010")
    command.upgrade(migration_config, "head")

    with migration_engine.connect() as connection:
        outer = connection.begin()
        try:
            with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
                user = add_profile(session)
                order = insert_order_row(session, user)
                insert_attempt_row(session, order, user)
                with (
                    pytest.raises(DBAPIError, match="uq_payment_attempts_order_approved"),
                    session.begin_nested(),
                ):
                    insert_attempt_row(session, order, user)
        finally:
            outer.rollback()


def test_alembic_check_reports_no_pending_changes(migration_config: Config) -> None:
    command.check(migration_config)  # lanza CommandError si los modelos y la BD difieren
