from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, Engine, TextClause, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

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
    "inventory_items": CRUD,
    "inventory_settings": CRUD,
    "movement_types": CRUD,
    "product_availability": {"SELECT"},
    "product_effective_price": {"SELECT"},
    "product_images": CRUD,
    "products": CRUD,
    "profiles": CRUD,
    "promotion_products": CRUD,
    "promotions": CRUD,
    "stock_movements": {"SELECT", "INSERT"},  # libro de movimientos: solo inserción
    "stock_reservations": CRUD,
}
EXPECTED_SEQUENCES = {
    "audit_log_id_seq": {"USAGE", "SELECT"},
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


def test_downgrade_to_0005_revokes_the_grants_and_upgrade_restores_them(
    alembic_config: Config, db_engine: Engine
) -> None:
    command.downgrade(alembic_config, "0005")
    with db_engine.connect() as connection:
        assert not any(privileges(connection, TABLE_PRIVILEGES).values())
        assert not any(privileges(connection, SEQUENCE_PRIVILEGES).values())
        assert connection.execute(SCHEMA_PRIVILEGES).one() == (False, False)
        # El rol se queda: es del clúster y otra BD puede tener aún permisos para él (0006).
        assert connection.scalar(text("SELECT 1 FROM pg_roles WHERE rolname = 'valmont_app'"))

    command.upgrade(alembic_config, "head")
    with db_engine.connect() as connection:
        assert privileges(connection, TABLE_PRIVILEGES) == EXPECTED_TABLES
        assert privileges(connection, SEQUENCE_PRIVILEGES) == EXPECTED_SEQUENCES
