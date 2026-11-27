from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, Engine, TextClause, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from tests.orders.orders_db_helpers import (
    insert_delivery_row,
    insert_history_row,
    insert_line_row,
    insert_order_row,
)
from tests.payments.payments_db_helpers import insert_attempt_row, rejected_row

pytestmark = pytest.mark.integration

CRUD = {"SELECT", "INSERT", "UPDATE", "DELETE"}
# Cada tabla y vista de app con lo que puede hacer valmont_app (migración 0006). Una tabla
# nueva sin su GRANT, o con uno de más, rompe la prueba del mapa: se concede de forma explícita.
EXPECTED_TABLES = {
    "alembic_version": set(),  # solo el rol de migraciones
    "audit_log": {"SELECT", "INSERT"},  # solo inserción (RF14.02)
    "cart_items": CRUD,
    "carts": CRUD,
    "case_materials": CRUD,
    "categories": CRUD,
    "deliveries": {"SELECT", "INSERT", "UPDATE"},  # nada de orders se borra (SPEC §6, T-073)
    "inventory_items": CRUD,
    "inventory_settings": CRUD,
    "movement_types": CRUD,
    "order_lines": {"SELECT", "INSERT"},  # la instantánea del pedido no se edita
    "order_status_history": {"SELECT", "INSERT"},  # solo inserción (RF12.02, ORDERS-R11)
    "orders": {"SELECT", "INSERT", "UPDATE"},
    "payment_attempts": {"SELECT", "INSERT"},  # intentos de pago: solo inserción (T-093, R1)
    "product_availability": {"SELECT"},
    "product_effective_price": {"SELECT"},
    "product_images": CRUD,
    "products": CRUD,
    "profiles": CRUD,
    "promotion_products": CRUD,
    "promotions": CRUD,
    "stock_movements": {"SELECT", "INSERT"},  # libro de movimientos: solo inserción
    "stock_reservations": CRUD,
    "wishlist_items": {"SELECT", "INSERT", "DELETE"},  # una fila se agrega o se retira: sin UPDATE
}
EXPECTED_SEQUENCES = {
    "audit_log_id_seq": {"USAGE", "SELECT"},
    # Identidades de la 0010 (T-073): el INSERT en la tabla basta, no necesitan permiso propio.
    "order_status_history_id_seq": set(),
    "orders_order_number_seq": set(),
    "stock_movements_id_seq": {"USAGE", "SELECT"},
}
# Privilegios efectivos (directos o por PUBLIC) de valmont_app en cada relación de app. SELECT,
# INSERT, UPDATE y REFERENCES admiten GRANT por columna: has_any_column_privilege los ve, así un
# GRANT sobre una sola columna rompe el mapa en vez de pasar inadvertido.
TABLE_PRIVILEGES = text(
    "SELECT c.relname, array_agg(p.privilege) FILTER (WHERE CASE"
    " WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')"
    " THEN has_any_column_privilege('valmont_app', c.oid, p.privilege)"
    " ELSE has_table_privilege('valmont_app', c.oid, p.privilege) END)"
    " FROM pg_class AS c CROSS JOIN unnest(ARRAY["
    "'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'"
    "]) AS p(privilege)"
    " WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')"
    " GROUP BY c.relname"
)
SEQUENCE_PRIVILEGES = text(
    "SELECT c.relname, array_agg(p.privilege)"
    " FILTER (WHERE has_sequence_privilege('valmont_app', c.oid, p.privilege))"
    " FROM pg_class AS c CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)"
    " WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'S'"
    " GROUP BY c.relname"
)
SCHEMA_PRIVILEGES = text(
    "SELECT has_schema_privilege('valmont_app', 'app', 'USAGE'),"
    " has_schema_privilege('valmont_app', 'app', 'CREATE')"
)
AUDIT_ROW = text(
    "INSERT INTO app.audit_log (action, entity_type, entity_id, after)"
    " VALUES ('catalog.product_created', 'product', :id, '{}')"
)
MOVEMENT_ROW = text(
    "INSERT INTO app.stock_movements (product_id, kind, quantity_delta, on_hand_after)"
    " VALUES (:product, 'entrada', 5, 5)"
)


def insert_product(session: Session) -> UUID:
    # La columna generada search ejecuta app.f_unaccent y, dentro, extensions.unaccent.
    product = uuid4()
    params = {"category": uuid4(), "product": product, "slug": f"t101-{product}"}
    session.execute(
        text("INSERT INTO app.categories (id, slug, name) VALUES (:category, :slug, 'T-101')"),
        params,
    )
    session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id, price_cents)"
            " VALUES (:product, :slug, :slug, 'Cronógrafo', 'Prueba de T-101', :category, 100)"
        ),
        params,
    )
    return product


def privileges(connection: Connection | Session, query: TextClause) -> dict[str, set[str]]:
    return {name: set(granted or ()) for name, granted in connection.execute(query)}


@pytest.fixture
def app_session(db_session: Session) -> Session:
    # PostgreSQL 16+: quien crea un rol sin ser superusuario recibe ADMIN sobre él, pero no SET,
    # y SET ROLE lo exige. Se lo concede a sí mismo; el rollback de db_session lo deshace todo.
    if not db_session.scalar(text("SELECT pg_has_role('valmont_app', 'SET')")):
        db_session.execute(text("GRANT valmont_app TO CURRENT_USER WITH SET TRUE"))
    db_session.execute(text("SET LOCAL ROLE valmont_app"))
    return db_session


def test_app_role_has_no_special_attributes_and_owns_nothing(db_session: Session) -> None:
    # LOGIN no se comprueba: lo fija el despliegue (T-100), no la migración.
    attributes = text(
        "SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls"
        " FROM pg_roles WHERE rolname = 'valmont_app'"
    )
    owned = text(
        "SELECT count(*) FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass"
        " AND refobjid = 'valmont_app'::regrole AND deptype = 'o'"
    )

    assert not any(db_session.execute(attributes).one())
    assert db_session.scalar(owned) == 0
    assert db_session.execute(SCHEMA_PRIVILEGES).one() == (True, False)


def test_privileges_on_every_table_view_and_sequence_match_the_map(db_session: Session) -> None:
    assert privileges(db_session, TABLE_PRIVILEGES) == EXPECTED_TABLES
    assert privileges(db_session, SEQUENCE_PRIVILEGES) == EXPECTED_SEQUENCES


def test_app_role_reads_and_writes_the_backend_tables(app_session: Session) -> None:
    product = insert_product(app_session)
    params = {"product": product, "slug": f"t101-{product}", "id": uuid4()}
    for statement in (
        "UPDATE app.products SET price_cents = 200 WHERE id = :product",
        "INSERT INTO app.inventory_items (product_id, on_hand) VALUES (:product, 5)",
        "INSERT INTO app.stock_reservations (id, product_id, order_id, quantity, expires_at)"
        " VALUES (:id, :product, :id, 1, now() + interval '15 minutes')",
    ):
        app_session.execute(text(statement), params)
    app_session.execute(MOVEMENT_ROW, params)
    app_session.execute(AUDIT_ROW, {"id": params["slug"]})
    search = text(
        "SELECT id FROM app.products WHERE id = :product"
        " AND search @@ websearch_to_tsquery('spanish', app.f_unaccent('cronografo'))"
    )
    available = text("SELECT available FROM app.product_availability WHERE product_id = :product")
    audited = text("SELECT count(*) FROM app.audit_log WHERE entity_id = :slug")

    assert app_session.scalar(search, params) == product
    assert app_session.scalar(available, params) == 4
    assert app_session.scalar(audited, params) == 1
    app_session.execute(text("DELETE FROM app.stock_reservations WHERE id = :id"), params)
    assert app_session.scalar(available, params) == 5


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE app.audit_log SET after = '{}' WHERE entity_id = :id",
        "DELETE FROM app.audit_log WHERE entity_id = :id",
        "TRUNCATE app.audit_log",
    ],
)
def test_app_role_is_denied_changes_to_audit_log_before_the_trigger(
    app_session: Session, statement: str
) -> None:
    # Hay una fila que casa: si el permiso no lo frenara, saltaría el trigger ("solo inserción").
    entity_id = str(uuid4())
    app_session.execute(AUDIT_ROW, {"id": entity_id})

    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text(statement), {"id": entity_id})


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE app.stock_movements SET note = 'cambio' WHERE product_id = :product",
        "DELETE FROM app.stock_movements WHERE product_id = :product",
    ],
)
def test_app_role_is_denied_changes_to_stock_movements(
    app_session: Session, statement: str
) -> None:
    # Hay una fila que casa: el libro de movimientos es de solo inserción para valmont_app.
    params = {"product": insert_product(app_session)}
    app_session.execute(MOVEMENT_ROW, params)

    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text(statement), params)


def test_app_role_manages_promotions_and_reads_their_effective_price(app_session: Session) -> None:
    # T-051: CRUD sobre promotions y promotion_products; la vista, solo lectura.
    product = insert_product(app_session)
    params = {"product": product, "promotion": uuid4()}
    for statement in (
        "INSERT INTO app.promotions (id, name, kind, percent_off, scope, starts_at, ends_at)"
        " VALUES (:promotion, 'T-051', 'percent', 10, 'products', now(),"
        " now() + interval '1 day')",
        "INSERT INTO app.promotion_products (promotion_id, product_id)"
        " VALUES (:promotion, :product)",
        "UPDATE app.promotions SET percent_off = 20 WHERE id = :promotion",
    ):
        app_session.execute(text(statement), params)
    price = text(
        "SELECT effective_price_cents FROM app.product_effective_price WHERE product_id = :product"
    )

    assert app_session.scalar(price, params) == 80  # 20 % de 100 céntimos
    app_session.execute(
        text("DELETE FROM app.promotion_products WHERE promotion_id = :promotion"), params
    )
    app_session.execute(text("DELETE FROM app.promotions WHERE id = :promotion"), params)
    assert app_session.scalar(price, params) == 100


def test_app_role_writes_and_reads_the_profile_birth_date(app_session: Session) -> None:
    # T-138 (CA-IDENTITY-17): la columna nueva cae bajo el CRUD ya concedido sobre profiles (el mapa
    # no cambia); la fijación atómica y el CHECK de rango funcionan con el rol de la aplicación.
    params = {"user": uuid4()}
    app_session.execute(text("INSERT INTO app.profiles (user_id) VALUES (:user)"), params)
    read = text("SELECT birth_date FROM app.profiles WHERE user_id = :user")
    assert app_session.scalar(read, params) is None

    set_once = text(
        "UPDATE app.profiles SET birth_date = DATE '1990-05-17', updated_at = now()"
        " WHERE user_id = :user AND birth_date IS NULL"
    )
    assert app_session.execute(set_once, params).rowcount == 1
    assert app_session.execute(set_once, params).rowcount == 0
    assert str(app_session.scalar(read, params)) == "1990-05-17"
    with pytest.raises(DBAPIError, match="birth_date_range"), app_session.begin_nested():
        app_session.execute(
            text("UPDATE app.profiles SET birth_date = DATE '1899-12-31' WHERE user_id = :user"),
            params,
        )


def test_app_role_manages_carts_and_their_items(app_session: Session) -> None:
    # T-056: CRUD sobre carts y cart_items; los topes de R3 son del dominio, no de los permisos.
    product = insert_product(app_session)
    params = {"product": product, "user": uuid4(), "cart": uuid4()}
    for statement in (
        "INSERT INTO app.profiles (user_id) VALUES (:user)",
        "INSERT INTO app.carts (id, user_id) VALUES (:cart, :user)",
        "INSERT INTO app.cart_items (id, cart_id, product_id, quantity)"
        " VALUES (gen_random_uuid(), :cart, :product, 2)",
        "UPDATE app.cart_items SET quantity = 3, selected = false WHERE cart_id = :cart",
        "UPDATE app.carts SET updated_at = now() WHERE id = :cart",
    ):
        app_session.execute(text(statement), params)
    quantity = text("SELECT quantity FROM app.cart_items WHERE cart_id = :cart")

    assert app_session.scalar(quantity, params) == 3
    app_session.execute(text("DELETE FROM app.cart_items WHERE cart_id = :cart"), params)
    app_session.execute(text("DELETE FROM app.carts WHERE id = :cart"), params)
    assert app_session.scalar(quantity, params) is None


def test_app_role_adds_reads_and_removes_wishlist_items_but_cannot_update_them(
    app_session: Session,
) -> None:
    # T-066: SELECT, INSERT y DELETE sobre wishlist_items; la fila nunca se modifica (SPEC §6).
    product = insert_product(app_session)
    params = {"product": product, "user": uuid4()}
    for statement in (
        "INSERT INTO app.profiles (user_id) VALUES (:user)",
        "INSERT INTO app.wishlist_items (id, user_id, product_id)"
        " VALUES (gen_random_uuid(), :user, :product)",
    ):
        app_session.execute(text(statement), params)
    count = text("SELECT count(*) FROM app.wishlist_items WHERE user_id = :user")

    assert app_session.scalar(count, params) == 1
    for statement in (
        "UPDATE app.wishlist_items SET created_at = now() WHERE user_id = :user",
        "UPDATE app.wishlist_items SET product_id = product_id WHERE user_id = :user",
    ):
        with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
            app_session.execute(text(statement), params)
    app_session.execute(text("DELETE FROM app.wishlist_items WHERE user_id = :user"), params)
    assert app_session.scalar(count, params) == 0


def test_app_role_creates_reads_and_updates_orders_and_their_delivery(
    app_session: Session,
) -> None:
    # T-073: INSERT, SELECT y UPDATE sobre orders y deliveries; el número sale de la identidad
    # sin permiso sobre su secuencia; lo escrito se lee con el mismo rol.
    product = insert_product(app_session)
    user = uuid4()
    app_session.execute(text("INSERT INTO app.profiles (user_id) VALUES (:user)"), {"user": user})
    order = insert_order_row(app_session, user)
    insert_line_row(app_session, order, product)
    insert_delivery_row(app_session, order)
    insert_history_row(app_session, order)
    params = {"order": order}

    app_session.execute(
        text("UPDATE app.orders SET status = 'cancelado', updated_at = now() WHERE id = :order"),
        params,
    )
    app_session.execute(
        text("UPDATE app.deliveries SET carrier = 'Olva' WHERE order_id = :order"), params
    )

    assert app_session.scalar(text("SELECT status FROM app.orders WHERE id = :order"), params) == (
        "cancelado"
    )
    assert app_session.scalar(text("SELECT order_number FROM app.orders WHERE id = :order"), params)
    for table, column in (
        ("order_lines", "order_id"),
        ("deliveries", "order_id"),
        ("order_status_history", "order_id"),
    ):
        count = text(f"SELECT count(*) FROM app.{table} WHERE {column} = :order")
        assert app_session.scalar(count, params) == 1


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE app.order_status_history SET note = 'cambio' WHERE order_id = :order",
        "DELETE FROM app.order_status_history WHERE order_id = :order",
        "UPDATE app.order_lines SET quantity = 2, line_total_amount = 200000"
        " WHERE order_id = :order",
        "UPDATE app.order_lines SET sku = 'otro' WHERE order_id = :order",
        "DELETE FROM app.order_lines WHERE order_id = :order",
        "DELETE FROM app.deliveries WHERE order_id = :order",
        "DELETE FROM app.orders WHERE id = :order",
    ],
)
def test_app_role_is_denied_what_orders_never_do(app_session: Session, statement: str) -> None:
    # CA-ORDERS-20: sin UPDATE ni DELETE sobre el historial y las líneas; nada de orders se borra.
    # Hay una fila que casa: si el permiso no lo frenara, la sentencia la tocaría.
    user = uuid4()
    app_session.execute(text("INSERT INTO app.profiles (user_id) VALUES (:user)"), {"user": user})
    order = insert_order_row(app_session, user)
    insert_line_row(app_session, order, insert_product(app_session))
    insert_delivery_row(app_session, order)
    insert_history_row(app_session, order)

    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text(statement), {"order": order})


@pytest.mark.parametrize("table", ["orders", "order_lines", "deliveries", "order_status_history"])
def test_app_role_cannot_truncate_the_orders_tables(app_session: Session, table: str) -> None:
    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text(f"TRUNCATE app.{table}"))


def test_app_role_cannot_truncate_wishlist_items(app_session: Session) -> None:
    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text("TRUNCATE app.wishlist_items"))


@pytest.mark.parametrize("statement", ["TRUNCATE app.carts", "TRUNCATE app.cart_items"])
def test_app_role_cannot_truncate_the_cart_tables(app_session: Session, statement: str) -> None:
    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "TRUNCATE app.promotions",
        "TRUNCATE app.promotion_products",
        "INSERT INTO app.product_effective_price (product_id) VALUES (gen_random_uuid())",
        "UPDATE app.product_effective_price SET effective_price_cents = 1",
        "DELETE FROM app.product_effective_price",
    ],
)
def test_app_role_cannot_truncate_promotions_or_write_the_view(
    app_session: Session, statement: str
) -> None:
    # La vista no es actualizable: PostgreSQL lo rechaza antes de mirar permisos; el mapa de
    # privilegios (SELECT únicamente) es lo que prueba que no hay más.
    denied = "permission denied|cannot (insert into|update|delete from) view"
    with pytest.raises(DBAPIError, match=denied), app_session.begin_nested():
        app_session.execute(text(statement))


@pytest.mark.parametrize(
    "statement",
    [
        "CREATE TABLE app.t101_probe (id integer)",
        "ALTER TABLE app.products ADD COLUMN t101_probe integer",
    ],
)
def test_app_role_cannot_change_the_schema(app_session: Session, statement: str) -> None:
    with (
        pytest.raises(DBAPIError, match="permission denied|must be owner"),
        app_session.begin_nested(),
    ):
        app_session.execute(text(statement))


def test_app_role_inserts_and_reads_payment_attempts_without_any_sequence(
    app_session: Session,
) -> None:
    # T-093 / CA-PAYMENTS-15: SELECT e INSERT sobre payment_attempts; la tabla no tiene secuencia
    # (el id es un uuid de la aplicación), así que no hay nada más que conceder.
    user = uuid4()
    app_session.execute(text("INSERT INTO app.profiles (user_id) VALUES (:user)"), {"user": user})
    order = insert_order_row(app_session, user)
    approved = insert_attempt_row(app_session, order, user)
    rejected_row(app_session, order, user)
    params = {"order": order, "id": approved["id"]}

    count = text("SELECT count(*) FROM app.payment_attempts WHERE order_id = :order")
    status = text("SELECT status FROM app.payment_attempts WHERE id = :id")

    assert app_session.scalar(count, params) == 2
    assert app_session.scalar(status, params) == "approved"
    # El INSERT ... ON CONFLICT DO NOTHING ... RETURNING del repositorio también lo permite.
    conflict = text(
        "INSERT INTO app.payment_attempts (id, order_id, user_id, idempotency_key, status,"
        " amount, card_last4, gateway) VALUES (gen_random_uuid(), :order, :user, :key,"
        " 'approved', 1, '4242', 'simulated') ON CONFLICT (user_id, idempotency_key)"
        " DO NOTHING RETURNING created_at"
    )
    key = app_session.scalar(
        text("SELECT idempotency_key FROM app.payment_attempts WHERE id = :id"), params
    )
    assert app_session.execute(conflict, {"order": order, "user": user, "key": key}).first() is None


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE app.payment_attempts SET status = 'rejected', failure_code = 'card_declined'"
        " WHERE order_id = :order",
        "UPDATE app.payment_attempts SET amount = 1 WHERE order_id = :order",
        "UPDATE app.payment_attempts SET card_last4 = '0000' WHERE order_id = :order",
        "UPDATE app.payment_attempts SET gateway = 'otra' WHERE order_id = :order",
        "DELETE FROM app.payment_attempts WHERE order_id = :order",
    ],
)
def test_app_role_is_denied_changes_to_payment_attempts(
    app_session: Session, statement: str
) -> None:
    # CA-PAYMENTS-15: la tabla es de solo inserción para valmont_app. Hay una fila que casa: si
    # el permiso no lo frenara, la sentencia la tocaría.
    user = uuid4()
    app_session.execute(text("INSERT INTO app.profiles (user_id) VALUES (:user)"), {"user": user})
    order = insert_order_row(app_session, user)
    insert_attempt_row(app_session, order, user)

    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text(statement), {"order": order})

    still = text("SELECT status, amount, card_last4 FROM app.payment_attempts WHERE order_id = :o")
    assert app_session.execute(still, {"o": order}).all() == [("approved", 100_000, "4242")]


def test_app_role_cannot_truncate_payment_attempts(app_session: Session) -> None:
    with pytest.raises(DBAPIError, match="permission denied"), app_session.begin_nested():
        app_session.execute(text("TRUNCATE app.payment_attempts"))


def test_app_role_has_no_privilege_on_payment_attempts_beyond_select_and_insert(
    db_session: Session,
) -> None:
    # TRUNCATE, REFERENCES y TRIGGER tampoco: el mapa global lo dice, aquí se nombra la tabla.
    granted = privileges(db_session, TABLE_PRIVILEGES)["payment_attempts"]

    assert granted == {"SELECT", "INSERT"}


def test_downgrade_to_0005_revokes_the_grants_and_upgrade_restores_them(
    migration_config: Config, migration_engine: Engine
) -> None:
    command.downgrade(migration_config, "0005")
    with migration_engine.connect() as connection:
        assert not any(privileges(connection, TABLE_PRIVILEGES).values())
        assert not any(privileges(connection, SEQUENCE_PRIVILEGES).values())
        assert connection.execute(SCHEMA_PRIVILEGES).one() == (False, False)
        # El rol se queda: es del clúster y otra BD puede tener aún permisos para él (0006).
        assert connection.scalar(text("SELECT 1 FROM pg_roles WHERE rolname = 'valmont_app'"))

    command.upgrade(migration_config, "head")
    with migration_engine.connect() as connection:
        assert privileges(connection, TABLE_PRIVILEGES) == EXPECTED_TABLES
        assert privileges(connection, SEQUENCE_PRIVILEGES) == EXPECTED_SEQUENCES
