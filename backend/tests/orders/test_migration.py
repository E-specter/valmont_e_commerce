"""Migración 0010 (CA-ORDERS-23): encadenada, reversible (también con pedidos dentro) y sin
diferencias con los modelos (`alembic check`)."""

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_product, add_profile
from tests.orders.orders_db_helpers import (
    insert_delivery_row,
    insert_history_row,
    insert_line_row,
    insert_order_row,
)

pytestmark = pytest.mark.integration

TABLES = ("orders", "order_lines", "deliveries", "order_status_history")
EXISTING = text(
    "SELECT array_agg(t ORDER BY t) FROM unnest(ARRAY['orders', 'order_lines', 'deliveries',"
    " 'order_status_history']) AS t WHERE to_regclass('app.' || t) IS NOT NULL"
)
SEQUENCES = text(
    "SELECT count(*) FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relkind = 'S'"
    " AND relname IN ('orders_order_number_seq', 'order_status_history_id_seq')"
)


def test_0010_follows_0009(alembic_config: Config) -> None:
    revision = ScriptDirectory.from_config(alembic_config).get_revision("0010")

    assert revision is not None and revision.down_revision == "0009"


def test_downgrade_drops_the_four_tables_and_upgrade_restores_them(
    alembic_config: Config, db_engine: Engine
) -> None:
    command.downgrade(alembic_config, "0009")
    try:
        with db_engine.connect() as connection:
            assert connection.scalar(EXISTING) is None
            assert connection.scalar(SEQUENCES) == 0
            # Lo que 0009 y las anteriores crearon sigue ahí (FK de 0010: profiles y products).
            assert connection.scalar(
                text(
                    "SELECT to_regclass('app.profiles') IS NOT NULL AND"
                    " to_regclass('app.products') IS NOT NULL AND"
                    " to_regclass('app.wishlist_items') IS NOT NULL"
                )
            )
    finally:
        command.upgrade(alembic_config, "head")

    with db_engine.connect() as connection:
        assert sorted(connection.scalar(EXISTING)) == sorted(TABLES)
        assert connection.scalar(SEQUENCES) == 2


def test_downgrade_works_with_orders_inside_and_leaves_no_trace(
    alembic_config: Config, db_engine: Engine
) -> None:
    # El orden del downgrade (historial, entrega, líneas, pedidos) importa con filas: las FK.
    with Session(db_engine) as session, session.begin():
        user = add_profile(session)
        product = add_product(session)
        order_id = insert_order_row(session, user)
        insert_line_row(session, order_id, product)
        insert_delivery_row(session, order_id)
        insert_history_row(session, order_id)
    try:
        command.downgrade(alembic_config, "0009")
        with db_engine.connect() as connection:
            assert connection.scalar(EXISTING) is None
    finally:
        command.upgrade(alembic_config, "head")
        with Session(db_engine) as session, session.begin():
            category = session.scalar(
                text("SELECT category_id FROM app.products WHERE id = :id"), {"id": product}
            )
            session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})
            session.execute(text("DELETE FROM app.products WHERE id = :id"), {"id": product})
            session.execute(text("DELETE FROM app.categories WHERE id = :id"), {"id": category})

    with db_engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT count(*) FROM app.orders WHERE id = :id"), {"id": order_id}
            )
            == 0
        )


def test_alembic_check_reports_no_pending_changes(alembic_config: Config) -> None:
    command.check(alembic_config)  # lanza CommandError si los modelos y la BD difieren
