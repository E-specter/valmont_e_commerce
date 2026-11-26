"""Restricciones de app.wishlist_items (SPEC §6, CA-WISH-10) y repositorio de la lista (T-066;
parte de repositorio de CA-WISH-03, WISH-R1, R2, R8) contra la BD de pruebas.

Las restricciones se prueban con SQL directo: son la última defensa. Se comprueba el SQLSTATE
(23503 FK, 23505 unicidad, 23502 NOT NULL), la tabla y los nombres explícitos de §6.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.wishlist.wishlist_helpers import (
    add_entry,
    add_product,
    add_profile,
    captured,
    entries_of,
)
from valmont.modules.wishlist.adapters.persistence import InvalidReference, SqlWishlistRepository
from valmont.modules.wishlist.application import WishlistEntry

pytestmark = pytest.mark.integration

FOREIGN_KEY, UNIQUE, NOT_NULL = "23503", "23505", "23502"
NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)

INSERT = text(
    "INSERT INTO app.wishlist_items (id, user_id, product_id) VALUES (:id, :user, :product)"
)


def violation(error: pytest.ExceptionInfo[Any]) -> tuple[str | None, str | None, str | None]:
    diag = error.value.orig.diag
    return error.value.orig.sqlstate, diag.table_name, diag.constraint_name


def row(user_id: Any, product_id: Any, **changes: Any) -> dict[str, Any]:
    """Parámetros de INSERT; `changes` (id, user, product) pisa lo dado, p. ej. con None."""
    return {**{"id": uuid4(), "user": user_id, "product": product_id}, **changes}


# ---------------------------------------------------------------------------------------------
# CA-WISH-10: restricciones de app.wishlist_items.
def test_a_product_appears_once_per_user_but_can_be_in_other_lists(db_session: Session) -> None:
    mine, theirs = add_profile(db_session), add_profile(db_session)
    product = add_product(db_session)
    add_entry(db_session, mine, product)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(mine, product))
    assert violation(error) == (UNIQUE, "wishlist_items", "uq_wishlist_items_user_id_product_id")

    add_entry(db_session, theirs, product)  # otra lista, mismo producto: permitido (RN-03)
    assert set(entries_of(db_session, theirs)) == {product}
    assert set(entries_of(db_session, mine)) == {product}


def test_a_user_can_hold_many_different_products(db_session: Session) -> None:
    # La BD no impone el tope de 50: lo hace el caso de uso (R4, §6).
    user = add_profile(db_session)
    products = [add_product(db_session) for _ in range(3)]
    for product in products:
        add_entry(db_session, user, product)

    assert set(entries_of(db_session, user)) == set(products)


def test_items_need_an_existing_profile_and_product(db_session: Session) -> None:
    user, product = add_profile(db_session), add_product(db_session)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(uuid4(), product))
    assert violation(error) == (FOREIGN_KEY, "wishlist_items", "fk_wishlist_items_user_id_profiles")

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(user, uuid4()))
    assert violation(error) == (
        FOREIGN_KEY,
        "wishlist_items",
        "fk_wishlist_items_product_id_products",
    )


@pytest.mark.parametrize("column", ["id", "user", "product"])
def test_explicit_nulls_are_rejected_on_every_required_column(
    db_session: Session, column: str
) -> None:
    user, product = add_profile(db_session), add_product(db_session)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(user, product, **{column: None}))

    sqlstate, table, _ = violation(error)
    assert (sqlstate, table) == (NOT_NULL, "wishlist_items")


def test_created_at_defaults_to_now_and_the_primary_key_is_unique(db_session: Session) -> None:
    user, product = add_profile(db_session), add_product(db_session)
    item_id = uuid4()
    db_session.execute(INSERT, row(user, product, id=item_id))

    created = db_session.scalar(
        text("SELECT created_at FROM app.wishlist_items WHERE id = :id"), {"id": item_id}
    )
    assert created is not None and created.tzinfo is not None

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(user, add_product(db_session), id=item_id))
    assert violation(error)[:2] == (UNIQUE, "wishlist_items")


def test_deleting_a_profile_cascades_to_its_list_only(db_session: Session) -> None:
    user, other = add_profile(db_session), add_profile(db_session)
    product = add_product(db_session)
    add_entry(db_session, user, product)
    add_entry(db_session, other, product)

    db_session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})

    assert entries_of(db_session, user) == {}
    assert set(entries_of(db_session, other)) == {product}
    assert db_session.scalar(text("SELECT 1 FROM app.products WHERE id = :id"), {"id": product})


def test_a_product_in_a_list_cannot_be_deleted_but_a_free_one_can(db_session: Session) -> None:
    user = add_profile(db_session)
    used, free = add_product(db_session), add_product(db_session)
    add_entry(db_session, user, used)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(text("DELETE FROM app.products WHERE id = :id"), {"id": used})
    assert violation(error)[:2] == (FOREIGN_KEY, "wishlist_items")
    assert set(entries_of(db_session, user)) == {used}

    db_session.execute(text("DELETE FROM app.products WHERE id = :id"), {"id": free})


def test_foreign_key_actions_unique_key_columns_and_index_match_the_spec(
    db_session: Session,
) -> None:
    # confdeltype: 'c' = CASCADE, 'r' = RESTRICT (SPEC §6; NO ACTION ('a') no es lo especificado).
    actions = dict(
        db_session.execute(
            text(
                "SELECT confrelid::regclass::text, confdeltype FROM pg_constraint"
                " WHERE contype = 'f' AND conrelid = 'app.wishlist_items'::regclass"
            )
        ).all()
    )
    unique = {
        name: tuple(columns)
        for name, columns in db_session.execute(
            text(
                "SELECT c.conname, array_agg(a.attname ORDER BY a.attname) FROM pg_constraint c"
                " JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)"
                " WHERE c.contype = 'u' AND c.conrelid = 'app.wishlist_items'::regclass"
                " GROUP BY c.oid, c.conname"
            )
        )
    }
    definitions = " ".join(
        db_session.scalars(
            text(
                "SELECT indexdef FROM pg_indexes"
                " WHERE schemaname = 'app' AND tablename = 'wishlist_items'"
            )
        )
    )
    columns = {
        name: (data_type, nullable, default or "")
        for name, data_type, nullable, default in db_session.execute(
            text(
                "SELECT column_name, data_type, is_nullable, column_default"
                " FROM information_schema.columns"
                " WHERE table_schema = 'app' AND table_name = 'wishlist_items'"
            )
        )
    }

    assert actions == {"app.profiles": "c", "app.products": "r"}
    assert unique == {"uq_wishlist_items_user_id_product_id": ("product_id", "user_id")}
    assert "ix_wishlist_items_product_id" in definitions and "(product_id)" in definitions
    assert set(columns) == {"id", "user_id", "product_id", "created_at"}
    assert all(nullable == "NO" for _, nullable, _ in columns.values())
    assert columns["created_at"][0] == "timestamp with time zone"
    assert columns["created_at"][2].startswith("now()")


# ---------------------------------------------------------------------------------------------
# Repositorio (SqlWishlistRepository).
@pytest.fixture
def repo(db_session: Session) -> SqlWishlistRepository:
    return SqlWishlistRepository(db_session)


def test_an_empty_list_reads_as_empty_and_writes_nothing(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user = add_profile(db_session)

    with captured(db_session) as statements:
        found = repo.list_for_user(user)

    assert found == ()
    assert entries_of(db_session, user) == {}
    assert not any(
        s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) or "FOR UPDATE" in s.upper()
        for s in statements
    )  # UC-WISH-01: la lectura no escribe ni bloquea


def test_add_inserts_the_row_with_the_given_time_and_returns_true(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user, product = add_profile(db_session), add_product(db_session)

    assert repo.add(user, product, NOW) is True

    assert entries_of(db_session, user) == {product: NOW}
    assert repo.list_for_user(user) == (WishlistEntry(product, NOW),)


def test_add_uses_insert_on_conflict_do_nothing(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user, product = add_profile(db_session), add_product(db_session)

    with captured(db_session) as statements:
        repo.add(user, product, NOW)

    inserts = [s.upper() for s in statements if s.lstrip().upper().startswith("INSERT")]
    assert len(inserts) == 1
    assert "ON CONFLICT" in inserts[0] and "DO NOTHING" in inserts[0]


def test_adding_again_returns_false_keeps_one_row_and_the_original_added_at(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    # CA-WISH-03 (parte de repositorio): RN-03, sin error y sin tocar added_at.
    user, product = add_profile(db_session), add_product(db_session)
    assert repo.add(user, product, NOW) is True

    assert repo.add(user, product, NOW + timedelta(hours=3)) is False

    assert entries_of(db_session, user) == {product: NOW}
    assert len(repo.list_for_user(user)) == 1


def test_the_same_product_in_two_lists_is_one_row_each(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    mine, theirs = add_profile(db_session), add_profile(db_session)
    product = add_product(db_session)

    assert repo.add(mine, product, NOW) is True
    assert repo.add(theirs, product, NOW) is True

    assert set(entries_of(db_session, mine)) == {product}
    assert set(entries_of(db_session, theirs)) == {product}


def test_add_reports_a_missing_product_and_leaves_the_list_intact(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user, kept = add_profile(db_session), add_product(db_session)
    repo.add(user, kept, NOW)

    with pytest.raises(InvalidReference) as error, db_session.begin_nested():
        repo.add(user, uuid4(), NOW)

    assert error.value.field == "product_id"
    assert entries_of(db_session, user) == {kept: NOW}


def test_list_orders_most_recent_first(db_session: Session, repo: SqlWishlistRepository) -> None:
    # WISH-R8
    user = add_profile(db_session)
    old, middle, recent = (add_product(db_session) for _ in range(3))
    add_entry(db_session, user, middle, NOW)
    add_entry(db_session, user, recent, NOW + timedelta(days=1))
    add_entry(db_session, user, old, NOW - timedelta(days=1))

    found = repo.list_for_user(user)

    assert [entry.product_id for entry in found] == [recent, middle, old]
    assert [entry.added_at for entry in found] == [
        NOW + timedelta(days=1),
        NOW,
        NOW - timedelta(days=1),
    ]


def test_list_is_deterministic_when_added_at_ties(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    # WISH-R8: product_id desempata; no se fija el sentido, solo que el orden sea estable.
    user = add_profile(db_session)
    products = [add_product(db_session) for _ in range(4)]
    for product in products:
        add_entry(db_session, user, product, NOW)

    first = repo.list_for_user(user)
    second = repo.list_for_user(user)

    assert first == second
    assert [e.product_id for e in first] in (sorted(products), sorted(products, reverse=True))


def test_list_returns_only_the_users_own_rows(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    mine, theirs = add_profile(db_session), add_profile(db_session)
    shared, only_mine, only_theirs = (add_product(db_session) for _ in range(3))
    for user, product in (
        (mine, shared),
        (mine, only_mine),
        (theirs, shared),
        (theirs, only_theirs),
    ):
        add_entry(db_session, user, product, NOW)

    assert {e.product_id for e in repo.list_for_user(mine)} == {shared, only_mine}
    assert {e.product_id for e in repo.list_for_user(theirs)} == {shared, only_theirs}
    assert repo.list_for_user(uuid4()) == ()


def test_list_runs_one_select_without_locking(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user = add_profile(db_session)
    for _ in range(5):
        add_entry(db_session, user, add_product(db_session))

    with captured(db_session) as statements:
        repo.list_for_user(user)

    assert len(statements) == 1
    assert statements[0].lstrip().upper().startswith("SELECT")
    assert "FOR UPDATE" not in statements[0].upper()


def test_remove_deletes_the_row_and_returns_true_then_false(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user, kept, gone = add_profile(db_session), add_product(db_session), add_product(db_session)
    add_entry(db_session, user, kept, NOW)
    add_entry(db_session, user, gone, NOW)

    assert repo.remove(user, gone) is True
    assert repo.remove(user, gone) is False  # idempotente a nivel de repositorio (UC-WISH-03)

    assert set(entries_of(db_session, user)) == {kept}


def test_remove_never_touches_another_users_row(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    # WISH-R2 / RN-10: el producto de la lista ajena no se retira.
    mine, theirs = add_profile(db_session), add_profile(db_session)
    product = add_product(db_session)
    add_entry(db_session, theirs, product, NOW)

    assert repo.remove(mine, product) is False

    assert entries_of(db_session, theirs) == {product: NOW}


def test_remove_of_an_unknown_product_returns_false(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    assert repo.remove(add_profile(db_session), uuid4()) is False


def test_add_after_remove_inserts_again_with_the_new_time(
    db_session: Session, repo: SqlWishlistRepository
) -> None:
    user, product = add_profile(db_session), add_product(db_session)
    repo.add(user, product, NOW)
    repo.remove(user, product)

    assert repo.add(user, product, NOW + timedelta(days=2)) is True

    assert entries_of(db_session, user) == {product: NOW + timedelta(days=2)}
