"""Restricciones de la BD (SPEC §6, CA-CART-15) y repositorio de cart (T-056) contra la BD de
pruebas.

Los CHECK, las FK y las claves se prueban con SQL directo: son la última defensa. Se comprueba el
código SQLSTATE (23514 CHECK, 23503 FK, 23505 unicidad, 23502 NOT NULL) y la tabla, no el nombre
de la restricción, que no forma parte de las firmas del paquete.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import (
    add_cart,
    add_item,
    add_product,
    add_profile,
    captured,
    carts_of,
    lines_of,
)
from valmont.modules.cart.adapters.persistence import InvalidReference, SqlCartRepository
from valmont.modules.cart.domain import Cart, CartItem

pytestmark = pytest.mark.integration

CHECK, FOREIGN_KEY, UNIQUE, NOT_NULL, OUT_OF_RANGE = "23514", "23503", "23505", "23502", "22003"
NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)

INSERT_CART = text("INSERT INTO app.carts (id, user_id) VALUES (:id, :user)")
INSERT_ITEM = text(
    "INSERT INTO app.cart_items (id, cart_id, product_id, quantity, selected)"
    " VALUES (:id, :cart, :product, :quantity, :selected)"
)


def sqlstate(error: pytest.ExceptionInfo[Any]) -> tuple[str | None, str | None]:
    diag = error.value.orig.diag
    return error.value.orig.sqlstate, diag.table_name


def item_row(cart_id: Any, product_id: Any, **changes: Any) -> dict[str, Any]:
    """Parámetros de una línea válida (1 unidad, seleccionada)."""
    values = {
        "id": uuid4(),
        "cart": cart_id,
        "product": product_id,
        "quantity": 1,
        "selected": True,
    }
    return {**values, **changes}


# ---------------------------------------------------------------------------------------------
# CA-CART-15: restricciones de app.carts.
def test_a_user_has_at_most_one_cart(db_session: Session) -> None:
    user = add_profile(db_session)
    add_cart(db_session, user)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT_CART, {"id": uuid4(), "user": user})

    assert sqlstate(error) == (UNIQUE, "carts")


def test_a_cart_needs_an_existing_profile_and_a_user(db_session: Session) -> None:
    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT_CART, {"id": uuid4(), "user": uuid4()})
    assert sqlstate(error) == (FOREIGN_KEY, "carts")

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT_CART, {"id": uuid4(), "user": None})
    assert sqlstate(error) == (NOT_NULL, "carts")


def test_cart_defaults_and_primary_key(db_session: Session) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))

    created, updated = db_session.execute(
        text("SELECT created_at, updated_at FROM app.carts WHERE id = :id"), {"id": cart_id}
    ).one()
    assert created is not None and updated is not None
    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT_CART, {"id": cart_id, "user": add_profile(db_session)})
    assert sqlstate(error) == (UNIQUE, "carts")


# ---------------------------------------------------------------------------------------------
# CA-CART-15: restricciones de app.cart_items.
@pytest.mark.parametrize("quantity", [0, -1, 101])
def test_quantity_outside_one_to_one_hundred_is_rejected(
    db_session: Session, quantity: int
) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(
            INSERT_ITEM, item_row(cart_id, add_product(db_session), quantity=quantity)
        )

    assert sqlstate(error) == (CHECK, "cart_items")


@pytest.mark.parametrize("quantity", [1, 5, 6, 100])
def test_quantity_boundaries_are_accepted(db_session: Session, quantity: int) -> None:
    # La BD solo exige 1–100: los topes de 5 y 20 son del dominio (SPEC §6).
    cart_id = add_cart(db_session, add_profile(db_session))
    product = add_product(db_session)

    db_session.execute(INSERT_ITEM, item_row(cart_id, product, quantity=quantity))

    assert lines_of(db_session, cart_id) == {product: (quantity, True)}


def test_quantity_is_a_smallint(db_session: Session) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))

    with pytest.raises(DBAPIError) as error, db_session.begin_nested():
        db_session.execute(INSERT_ITEM, item_row(cart_id, add_product(db_session), quantity=40000))

    assert error.value.orig.sqlstate == OUT_OF_RANGE


@pytest.mark.parametrize("column", ["cart", "product", "quantity", "selected"])
def test_explicit_nulls_are_rejected_on_every_required_column(
    db_session: Session, column: str
) -> None:
    # Un CHECK deja pasar el NULL: NOT NULL es lo que lo frena.
    cart_id = add_cart(db_session, add_profile(db_session))

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(
            INSERT_ITEM, item_row(cart_id, add_product(db_session), **{column: None})
        )

    assert sqlstate(error) == (NOT_NULL, "cart_items")


def test_item_defaults(db_session: Session) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))
    product = add_product(db_session)

    db_session.execute(
        text(
            "INSERT INTO app.cart_items (id, cart_id, product_id, quantity)"
            " VALUES (gen_random_uuid(), :c, :p, 2)"
        ),
        {"c": cart_id, "p": product},
    )

    selected, created, updated = db_session.execute(
        text(
            "SELECT selected, created_at, updated_at FROM app.cart_items"
            " WHERE cart_id = :c AND product_id = :p"
        ),
        {"c": cart_id, "p": product},
    ).one()
    assert selected is True and created is not None and updated is not None


def test_a_product_appears_once_per_cart_but_can_be_in_other_carts(db_session: Session) -> None:
    mine, theirs = (add_cart(db_session, add_profile(db_session)) for _ in range(2))
    product = add_product(db_session)
    add_item(db_session, mine, product)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT_ITEM, item_row(mine, product))
    assert sqlstate(error) == (UNIQUE, "cart_items")

    add_item(db_session, theirs, product)  # otro carrito, mismo producto: permitido
    assert lines_of(db_session, theirs) == {product: (1, True)}


def test_items_need_an_existing_cart_and_product(db_session: Session) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))
    for args in [(cart_id, uuid4()), (uuid4(), add_product(db_session))]:
        with pytest.raises(IntegrityError) as error, db_session.begin_nested():
            db_session.execute(INSERT_ITEM, item_row(*args))
        assert sqlstate(error) == (FOREIGN_KEY, "cart_items")


def test_deleting_a_cart_cascades_to_its_items_and_keeps_products(db_session: Session) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))
    product = add_product(db_session)
    add_item(db_session, cart_id, product)

    db_session.execute(text("DELETE FROM app.carts WHERE id = :id"), {"id": cart_id})

    assert lines_of(db_session, cart_id) == {}
    assert db_session.scalar(text("SELECT 1 FROM app.products WHERE id = :id"), {"id": product})


def test_deleting_a_profile_cascades_to_its_cart_and_items_only(db_session: Session) -> None:
    user, other = add_profile(db_session), add_profile(db_session)
    mine, theirs = add_cart(db_session, user), add_cart(db_session, other)
    product = add_product(db_session)
    add_item(db_session, mine, product)
    add_item(db_session, theirs, product)

    db_session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})

    assert carts_of(db_session, user) == [] and lines_of(db_session, mine) == {}
    assert carts_of(db_session, other) == [theirs]
    assert lines_of(db_session, theirs) == {product: (1, True)}


def test_a_product_in_a_cart_cannot_be_deleted_but_a_free_one_can(db_session: Session) -> None:
    cart_id = add_cart(db_session, add_profile(db_session))
    used, free = add_product(db_session), add_product(db_session)
    add_item(db_session, cart_id, used)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(text("DELETE FROM app.products WHERE id = :id"), {"id": used})
    assert sqlstate(error) == (FOREIGN_KEY, "cart_items")
    assert lines_of(db_session, cart_id) == {used: (1, True)}

    db_session.execute(text("DELETE FROM app.products WHERE id = :id"), {"id": free})


def test_foreign_key_actions_and_indexes_match_the_spec(db_session: Session) -> None:
    # confdeltype: 'c' = CASCADE, 'r' = RESTRICT (SPEC §6; NO ACTION ('a') no es lo especificado).
    actions = dict(
        db_session.execute(
            text(
                "SELECT conrelid::regclass::text || '->' || confrelid::regclass::text, confdeltype"
                " FROM pg_constraint WHERE contype = 'f'"
                " AND conrelid IN ('app.carts'::regclass, 'app.cart_items'::regclass)"
            )
        ).all()
    )
    unique = {
        tuple(columns)
        for (columns,) in db_session.execute(
            text(
                "SELECT array_agg(a.attname ORDER BY a.attname) FROM pg_constraint c"
                " JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)"
                " WHERE c.contype = 'u' AND c.conrelid IN"
                " ('app.carts'::regclass, 'app.cart_items'::regclass) GROUP BY c.oid"
            )
        )
    }
    definitions = " ".join(
        db_session.scalars(
            text(
                "SELECT indexdef FROM pg_indexes"
                " WHERE schemaname = 'app' AND tablename = 'cart_items'"
            )
        )
    )

    assert actions == {
        "app.carts->app.profiles": "c",
        "app.cart_items->app.carts": "c",
        "app.cart_items->app.products": "r",
    }
    assert unique == {("user_id",), ("cart_id", "product_id")}
    assert "(product_id)" in definitions


# ---------------------------------------------------------------------------------------------
# Repositorio: lock_for_user / find_for_user (CA-CART-02, R1).
@pytest.fixture
def repo(db_session: Session) -> SqlCartRepository:
    return SqlCartRepository(db_session)


def test_find_for_user_without_a_cart_returns_none_and_writes_nothing(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)

    with captured(db_session) as statements:
        found = repo.find_for_user(user)

    assert found is None and carts_of(db_session, user) == []
    assert not any(
        s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for s in statements
    )


def test_find_for_user_reads_without_locking(db_session: Session, repo: SqlCartRepository) -> None:
    user = add_profile(db_session)
    add_cart(db_session, user)

    with captured(db_session) as statements:
        repo.find_for_user(user)

    assert not any("FOR UPDATE" in statement.upper() for statement in statements)


def test_lock_for_user_creates_the_cart_once(db_session: Session, repo: SqlCartRepository) -> None:
    user = add_profile(db_session)

    first = repo.lock_for_user(user)
    second = repo.lock_for_user(user)

    assert first.user_id == user and first.items == ()
    assert second.id == first.id
    assert carts_of(db_session, user) == [first.id]


def test_lock_for_user_inserts_with_on_conflict_and_locks_for_update(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)

    with captured(db_session) as statements:
        repo.lock_for_user(user)

    upper = [statement.upper() for statement in statements]
    assert any("ON CONFLICT" in s and "DO NOTHING" in s for s in upper)
    assert any(s.rstrip().endswith("FOR UPDATE") or "FOR UPDATE" in s for s in upper)


def test_lock_for_user_returns_the_existing_cart_with_its_items(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)
    cart_id = add_cart(db_session, user)
    product = add_product(db_session)
    add_item(db_session, cart_id, product, 3, selected=False, created_at=NOW)

    cart = repo.lock_for_user(user)

    assert cart == Cart(
        id=cart_id,
        user_id=user,
        items=(CartItem(product_id=product, quantity=3, selected=False, created_at=NOW),),
    )
    assert repo.find_for_user(user) == cart
    assert carts_of(db_session, user) == [cart_id]  # no creó otro


def test_items_come_back_by_created_at_then_product_id(
    db_session: Session, repo: SqlCartRepository
) -> None:
    # CART-R15
    user = add_profile(db_session)
    cart_id = add_cart(db_session, user)
    low, high = sorted(add_product(db_session) for _ in range(2))
    newest, oldest = add_product(db_session), add_product(db_session)
    add_item(db_session, cart_id, newest, created_at=NOW + timedelta(hours=2))
    add_item(db_session, cart_id, high, created_at=NOW + timedelta(hours=1))
    add_item(db_session, cart_id, oldest, created_at=NOW)
    add_item(db_session, cart_id, low, created_at=NOW + timedelta(hours=1))
    expected = [oldest, low, high, newest]

    for cart in (repo.lock_for_user(user), repo.find_for_user(user)):
        assert cart is not None
        assert [item.product_id for item in cart.items] == expected


def test_a_user_never_sees_the_cart_of_another(
    db_session: Session, repo: SqlCartRepository
) -> None:
    mine, theirs = add_profile(db_session), add_profile(db_session)
    their_cart = add_cart(db_session, theirs)
    product = add_product(db_session)
    add_item(db_session, their_cart, product, 2)

    own = repo.lock_for_user(mine)
    other = repo.find_for_user(theirs)

    assert own.items == () and own.id != their_cart
    assert other is not None and other.id == their_cart and len(other.items) == 1
    assert repo.find_for_user(uuid4()) is None


# ---------------------------------------------------------------------------------------------
# Repositorio: save.
def test_save_persists_new_lines_and_round_trips(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)
    a, b = add_product(db_session), add_product(db_session)
    cart = repo.lock_for_user(user).add(a, 2, NOW).add(b, 5, NOW + timedelta(minutes=1))

    repo.save(cart)

    assert lines_of(db_session, cart.id) == {a: (2, True), b: (5, True)}
    assert repo.find_for_user(user) == cart


def test_save_updates_quantity_and_selected_and_removes_lines(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)
    a, b, c = (add_product(db_session) for _ in range(3))
    cart = repo.lock_for_user(user).add(a, 1, NOW).add(b, 1, NOW).add(c, 1, NOW)
    repo.save(cart)

    changed = cart.set_quantity(a, 4).set_selected(b, False).remove(c)
    repo.save(changed)

    assert lines_of(db_session, cart.id) == {a: (4, True), b: (1, False)}
    assert repo.find_for_user(user) == changed


def test_save_can_empty_the_cart_but_keeps_the_cart_row(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)
    product = add_product(db_session)
    cart = repo.lock_for_user(user).add(product, 1, NOW)
    repo.save(cart)

    repo.save(cart.remove(product))

    found = repo.find_for_user(user)
    assert found is not None and found.id == cart.id and found.items == ()


def test_save_of_an_unchanged_cart_changes_nothing(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)
    cart = repo.lock_for_user(user).add(add_product(db_session), 3, NOW)
    repo.save(cart)

    repo.save(cart)

    assert repo.find_for_user(user) == cart


def test_save_touches_the_cart_updated_at(db_session: Session, repo: SqlCartRepository) -> None:
    user = add_profile(db_session)
    cart = repo.lock_for_user(user)
    # Dentro de una transacción now() no avanza: se retrasa a mano y se comprueba que se mueve.
    db_session.execute(
        text("UPDATE app.carts SET updated_at = '2020-01-01 00:00:00+00' WHERE id = :id"),
        {"id": cart.id},
    )

    repo.save(cart.add(add_product(db_session), 1, NOW))

    updated = db_session.scalar(
        text("SELECT updated_at FROM app.carts WHERE id = :id"), {"id": cart.id}
    )
    assert updated > datetime(2021, 1, 1, tzinfo=UTC)


def test_save_only_touches_the_given_cart(db_session: Session, repo: SqlCartRepository) -> None:
    mine, theirs = add_profile(db_session), add_profile(db_session)
    shared, mine_only = add_product(db_session), add_product(db_session)
    their_cart = add_cart(db_session, theirs)
    add_item(db_session, their_cart, shared, 4, selected=False)
    cart = repo.lock_for_user(mine).add(shared, 1, NOW).add(mine_only, 1, NOW)
    repo.save(cart)

    repo.save(cart.remove(shared).set_quantity(mine_only, 3))

    assert lines_of(db_session, cart.id) == {mine_only: (3, True)}
    assert lines_of(db_session, their_cart) == {shared: (4, False)}


def test_save_reports_a_missing_product_and_leaves_the_cart_intact(
    db_session: Session, repo: SqlCartRepository
) -> None:
    user = add_profile(db_session)
    kept = add_product(db_session)
    cart = repo.lock_for_user(user).add(kept, 2, NOW)
    repo.save(cart)

    with pytest.raises(InvalidReference) as error, db_session.begin_nested():
        repo.save(cart.add(uuid4(), 1, NOW))

    assert error.value.field == "product_id"
    assert repo.find_for_user(user) == cart  # nada a medias
    assert lines_of(db_session, cart.id) == {kept: (2, True)}
