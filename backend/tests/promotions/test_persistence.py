"""Restricciones de la BD (SPEC §6) y repositorio de promotions contra la BD de pruebas.

Los CHECK, las FK y las claves se prueban con SQL directo: son la última defensa (CA-14). Se
comprueba el código SQLSTATE (23514 CHECK, 23503 FK, 23505 unicidad) y la tabla, no el nombre
de la restricción, que no forma parte de las firmas del paquete.
"""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.promotions.promotions_helpers import (
    add_category,
    add_product,
    add_promotion,
    captured,
    effective,
)
from valmont.modules.promotions.adapters.persistence import (
    InvalidReference,
    SqlPromotionRepository,
)
from valmont.modules.promotions.domain import (
    Promotion,
    PromotionKind,
    PromotionScope,
    PromotionStatus,
)

pytestmark = pytest.mark.integration

CHECK, FOREIGN_KEY, UNIQUE = "23514", "23503", "23505"
START = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
END = START + timedelta(days=30)
PERCENT, FIXED = PromotionKind.PERCENT, PromotionKind.FIXED_AMOUNT
PRODUCTS, CATEGORY, CATALOG = (
    PromotionScope.PRODUCTS,
    PromotionScope.CATEGORY,
    PromotionScope.CATALOG,
)

INSERT = text(
    "INSERT INTO app.promotions (id, name, kind, percent_off, amount_off_cents, scope,"
    " category_id, starts_at, ends_at) VALUES (:id, :name, :kind, :percent, :amount, :scope,"
    " :category, :starts, :ends)"
)


def row(**changes: Any) -> dict[str, Any]:
    """Parámetros de una fila válida de app.promotions (15 %, alcance catalog)."""
    values: dict[str, Any] = {
        "id": uuid4(),
        "name": "Fila de prueba",
        "kind": "percent",
        "percent": 15,
        "amount": None,
        "scope": "catalog",
        "category": None,
        "starts": START,
        "ends": END,
    }
    return {**values, **changes}


def sqlstate(error: pytest.ExceptionInfo[IntegrityError]) -> tuple[str | None, str | None]:
    diag = error.value.orig.diag  # type: ignore[union-attr]
    return error.value.orig.sqlstate, diag.table_name  # type: ignore[union-attr]


# CA-PROMOTIONS-14: cada CHECK de app.promotions.
@pytest.mark.parametrize(
    "changes",
    [
        {"percent": 0},
        {"percent": 91},
        {"percent": -1},
        {"amount": 1000},  # percent con monto
        {"percent": None},  # percent sin valor
        {"kind": "fixed_amount", "percent": None, "amount": 0},
        {"kind": "fixed_amount", "percent": None, "amount": -5},
        {"kind": "fixed_amount", "percent": 15, "amount": 1000},  # fixed con porcentaje
        {"kind": "fixed_amount", "percent": None, "amount": None},
        {"kind": "bonus"},
        {"scope": "everything"},
        {"scope": "category", "category": None},
        {"scope": "catalog", "category": "category"},  # catalog con categoría
        {"scope": "products", "category": "category"},  # products con categoría
        {"ends": START},
        {"ends": START - timedelta(seconds=1)},
        {"name": ""},
        {"name": "x" * 121},
    ],
)
def test_promotion_checks_reject_invalid_rows(db_session: Session, changes: dict[str, Any]) -> None:
    if changes.get("category") == "category":
        changes = {**changes, "category": add_category(db_session)}

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(**changes))

    assert sqlstate(error) == (CHECK, "promotions")


@pytest.mark.parametrize(
    "changes",
    [
        {"percent": 1},
        {"percent": 90},
        {"kind": "fixed_amount", "percent": None, "amount": 1},
        {"kind": "fixed_amount", "percent": None, "amount": 2_147_483_647},
        {"name": "x"},
        {"name": "x" * 120},
        {"scope": "products"},
        {"ends": START + timedelta(microseconds=1)},
    ],
)
def test_promotion_boundaries_are_accepted(db_session: Session, changes: dict[str, Any]) -> None:
    db_session.execute(INSERT, row(**changes))


def test_category_scope_needs_an_existing_category(db_session: Session) -> None:
    db_session.execute(INSERT, row(scope="category", category=add_category(db_session)))

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(scope="category", category=uuid4()))

    assert sqlstate(error) == (FOREIGN_KEY, "promotions")


def test_defaults_and_primary_key(db_session: Session) -> None:
    promotion = row()
    db_session.execute(INSERT, promotion)

    active, created, updated = db_session.execute(
        text("SELECT is_active, created_at, updated_at FROM app.promotions WHERE id = :id"),
        promotion,
    ).one()
    assert active is True and created is not None and updated is not None
    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(INSERT, row(id=promotion["id"]))
    assert sqlstate(error) == (UNIQUE, "promotions")


# CA-PROMOTIONS-14: promotion_products (PK, FK a productos, FK compuesta, scope fijo).
def link(session: Session, promotion_id: UUID, product_id: UUID, **extra: Any) -> None:
    columns = ", ".join(["promotion_id", "product_id", *extra])
    marks = ", ".join(f":{name}" for name in ["promotion_id", "product_id", *extra])
    session.execute(
        text(f"INSERT INTO app.promotion_products ({columns}) VALUES ({marks})"),
        {"promotion_id": promotion_id, "product_id": product_id, **extra},
    )


def products_of(session: Session, promotion_id: UUID) -> set[UUID]:
    rows = session.execute(
        text("SELECT product_id FROM app.promotion_products WHERE promotion_id = :id"),
        {"id": promotion_id},
    )
    return {product_id for (product_id,) in rows}


def test_link_scope_defaults_to_products_and_the_pair_is_the_key(db_session: Session) -> None:
    product_id = add_product(db_session)
    promotion_id = add_promotion(db_session, scope="products", product_ids=[product_id])

    scopes = db_session.scalars(
        text("SELECT scope FROM app.promotion_products WHERE promotion_id = :id"),
        {"id": promotion_id},
    ).all()
    assert scopes == ["products"]
    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        link(db_session, promotion_id, product_id)
    assert sqlstate(error) == (UNIQUE, "promotion_products")


@pytest.mark.parametrize("scope", ["category", "catalog"])
def test_composite_fk_rejects_products_on_a_promotion_that_is_not_products_scope(
    db_session: Session, scope: str
) -> None:
    category_id = add_category(db_session) if scope == "category" else None
    promotion_id = add_promotion(db_session, scope=scope, category_id=category_id)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        link(db_session, promotion_id, add_product(db_session))

    assert sqlstate(error) == (FOREIGN_KEY, "promotion_products")


def test_link_scope_must_be_products(db_session: Session) -> None:
    promotion_id = add_promotion(db_session, scope="catalog")

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        link(db_session, promotion_id, add_product(db_session), scope="catalog")

    assert sqlstate(error) == (CHECK, "promotion_products")


def test_composite_fk_blocks_changing_the_scope_while_products_are_linked(
    db_session: Session,
) -> None:
    promotion_id = add_promotion(
        db_session, scope="products", product_ids=[add_product(db_session)]
    )

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(
            text("UPDATE app.promotions SET scope = 'catalog' WHERE id = :id"), {"id": promotion_id}
        )

    assert error.value.orig.sqlstate == FOREIGN_KEY  # type: ignore[union-attr]


def test_links_need_an_existing_product_and_promotion(db_session: Session) -> None:
    promotion_id = add_promotion(
        db_session, scope="products", product_ids=[add_product(db_session)]
    )
    for args in [(promotion_id, uuid4()), (uuid4(), add_product(db_session))]:
        with pytest.raises(IntegrityError) as error, db_session.begin_nested():
            link(db_session, *args)
        assert sqlstate(error) == (FOREIGN_KEY, "promotion_products")


def test_deleting_a_promotion_cascades_to_its_products(db_session: Session) -> None:
    product_id = add_product(db_session)
    promotion_id = add_promotion(db_session, scope="products", product_ids=[product_id])

    db_session.execute(text("DELETE FROM app.promotions WHERE id = :id"), {"id": promotion_id})

    assert products_of(db_session, promotion_id) == set()
    assert db_session.scalar(text("SELECT 1 FROM app.products WHERE id = :id"), {"id": product_id})


def test_products_and_categories_in_use_cannot_be_deleted(db_session: Session) -> None:
    product_id = add_product(db_session)
    add_promotion(db_session, scope="products", product_ids=[product_id])
    category_id = add_category(db_session)
    add_promotion(db_session, scope="category", category_id=category_id)

    for table, row_id in [("products", product_id), ("categories", category_id)]:
        with pytest.raises(IntegrityError) as error, db_session.begin_nested():
            db_session.execute(text(f"DELETE FROM app.{table} WHERE id = :id"), {"id": row_id})
        assert error.value.orig.sqlstate == FOREIGN_KEY  # type: ignore[union-attr]


def test_indexes_and_the_unique_pair_exist(db_session: Session) -> None:
    unique = db_session.scalar(
        text(
            "SELECT array_agg(a.attname ORDER BY a.attname) FROM pg_constraint c"
            " JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)"
            " WHERE c.conrelid = 'app.promotions'::regclass AND c.contype = 'u'"
        )
    )
    definitions = " ".join(
        db_session.scalars(
            text(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app'"
                " AND tablename IN ('promotions', 'promotion_products')"
            )
        )
    )
    assert unique == ["id", "scope"]
    assert "(is_active, starts_at, ends_at)" in definitions
    assert "(category_id) WHERE (category_id IS NOT NULL)" in definitions
    assert "(product_id)" in definitions


# Repositorio.
def make(**changes: Any) -> Promotion:
    fields: dict[str, Any] = {
        "id": uuid4(),
        "name": "Otoño de prueba",
        "kind": PERCENT,
        "percent_off": 15,
        "amount_off": None,
        "scope": CATALOG,
        "category_id": None,
        "product_ids": (),
        "starts_at": START,
        "ends_at": END,
        "is_active": True,
    }
    return Promotion(**{**fields, **changes})


def same(promotion: Promotion | None) -> Promotion | None:
    """Sin depender del orden en que el repositorio devuelve product_ids."""
    return (
        None
        if promotion is None
        else replace(promotion, product_ids=tuple(sorted(promotion.product_ids)))
    )


@pytest.fixture
def repo(db_session: Session) -> SqlPromotionRepository:
    return SqlPromotionRepository(db_session)


@pytest.mark.parametrize("kind", [PERCENT, FIXED])
def test_add_and_get_round_trip_every_scope(
    db_session: Session, repo: SqlPromotionRepository, kind: PromotionKind
) -> None:
    value = {"percent_off": 15} if kind is PERCENT else {"percent_off": None, "amount_off": 20000}
    category_id = add_category(db_session)
    products = tuple(sorted(add_product(db_session) for _ in range(3)))
    promotions = [
        make(kind=kind, **value),
        make(kind=kind, scope=CATEGORY, category_id=category_id, **value),
        make(kind=kind, scope=PRODUCTS, product_ids=products, is_active=False, **value),
    ]

    for promotion in promotions:
        repo.add(promotion)

    for promotion in promotions:
        assert same(repo.get(promotion.id)) == same(promotion)


def test_get_and_lock_return_none_for_an_unknown_id(repo: SqlPromotionRepository) -> None:
    assert repo.get(uuid4()) is None
    assert repo.lock(uuid4()) is None


def test_lock_reads_the_row_for_update(db_session: Session, repo: SqlPromotionRepository) -> None:
    promotion = make()
    repo.add(promotion)

    with captured(db_session) as statements:
        locked = repo.lock(promotion.id)

    assert same(locked) == same(promotion)
    assert any(statement.rstrip().endswith("FOR UPDATE") for statement in statements)


def test_update_changes_the_fields_and_replaces_the_products(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    a, b, c = (add_product(db_session) for _ in range(3))
    promotion = make(scope=PRODUCTS, product_ids=(a, b))
    repo.add(promotion)

    changed = replace(
        promotion,
        name="Renombrada",
        percent_off=40,
        product_ids=(b, c),
        ends_at=END + timedelta(days=1),
        is_active=False,
    )
    repo.update(changed)

    assert same(repo.get(promotion.id)) == same(changed)
    assert products_of(db_session, promotion.id) == {b, c}  # a se fue, c entró, b se conserva


def test_update_changing_kind_swaps_the_value(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    promotion = make()
    repo.add(promotion)

    changed = replace(promotion, kind=FIXED, percent_off=None, amount_off=20000)
    repo.update(changed)

    assert repo.get(promotion.id) == changed
    stored = db_session.execute(
        text("SELECT percent_off, amount_off_cents FROM app.promotions WHERE id = :id"),
        {"id": promotion.id},
    ).one()
    assert tuple(stored) == (None, 20000)


@pytest.mark.parametrize("target", ["category", "catalog"])
def test_update_changing_the_scope_away_from_products_deletes_the_product_rows(
    db_session: Session, repo: SqlPromotionRepository, target: str
) -> None:
    promotion = make(scope=PRODUCTS, product_ids=(add_product(db_session), add_product(db_session)))
    repo.add(promotion)
    changes: dict[str, Any] = {"scope": CATALOG, "product_ids": ()}
    if target == "category":
        changes = {"scope": CATEGORY, "product_ids": (), "category_id": add_category(db_session)}

    changed = replace(promotion, **changes)
    repo.update(changed)

    assert repo.get(promotion.id) == changed
    assert products_of(db_session, promotion.id) == set()


def test_update_from_category_to_products_and_back(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    promotion = make(scope=CATEGORY, category_id=add_category(db_session))
    repo.add(promotion)
    product_id = add_product(db_session)

    to_products = replace(promotion, scope=PRODUCTS, category_id=None, product_ids=(product_id,))
    repo.update(to_products)
    assert same(repo.get(promotion.id)) == same(to_products)

    to_catalog = replace(to_products, scope=CATALOG, product_ids=())
    repo.update(to_catalog)
    assert repo.get(promotion.id) == to_catalog
    assert products_of(db_session, promotion.id) == set()


@pytest.mark.parametrize(
    ("scope", "field"),
    [(PRODUCTS, "product_ids"), (CATEGORY, "category_id")],
)
def test_add_reports_a_missing_reference_on_its_field(
    db_session: Session, repo: SqlPromotionRepository, scope: PromotionScope, field: str
) -> None:
    ghost = (
        make(scope=PRODUCTS, product_ids=(add_product(db_session), uuid4()))
        if scope is PRODUCTS
        else make(scope=CATEGORY, category_id=uuid4())
    )

    with pytest.raises(InvalidReference) as error, db_session.begin_nested():
        repo.add(ghost)

    assert error.value.field == field
    assert repo.get(ghost.id) is None  # nada a medias


def test_update_reports_a_missing_reference_on_its_field(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    promotion = make(scope=PRODUCTS, product_ids=(add_product(db_session),))
    repo.add(promotion)
    products = replace(promotion, product_ids=(uuid4(),))
    category = replace(promotion, scope=CATEGORY, product_ids=(), category_id=uuid4())

    for changed, field in [(products, "product_ids"), (category, "category_id")]:
        with pytest.raises(InvalidReference) as error, db_session.begin_nested():
            repo.update(changed)
        assert error.value.field == field

    assert same(repo.get(promotion.id)) == same(promotion)


def test_other_integrity_errors_are_not_disguised(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    promotion = make()
    repo.add(promotion)

    with pytest.raises(IntegrityError), db_session.begin_nested():
        repo.add(make(id=promotion.id))


# list(): filtros por status calculado con el `now` recibido, orden starts_at desc, id; paginación.
def test_list_filters_by_status_and_scope_at_the_given_instant(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    now = START + timedelta(days=5)
    category_id = add_category(db_session)
    scheduled = make(starts_at=now + timedelta(days=1), ends_at=now + timedelta(days=2))
    active = make(scope=PRODUCTS, product_ids=(add_product(db_session),))
    expired = make(starts_at=now - timedelta(days=9), ends_at=now - timedelta(days=1))
    edge = make(starts_at=now - timedelta(days=1), ends_at=now)  # ends_at = now: vencida
    inactive = make(is_active=False, scope=CATEGORY, category_id=category_id)
    mine = {p.id for p in (scheduled, active, expired, edge, inactive)}
    for promotion in (scheduled, active, expired, edge, inactive):
        repo.add(promotion)

    def ids(status: PromotionStatus | None, scope: PromotionScope | None) -> set[UUID]:
        items, _ = repo.list(status, scope, now, 1, 48)
        return {p.id for p in items} & mine

    assert ids(None, None) == mine
    assert ids(PromotionStatus.SCHEDULED, None) == {scheduled.id}
    assert ids(PromotionStatus.ACTIVE, None) == {active.id}
    assert ids(PromotionStatus.EXPIRED, None) == {expired.id, edge.id}
    assert ids(PromotionStatus.INACTIVE, None) == {inactive.id}
    assert ids(None, PRODUCTS) == {active.id}
    assert ids(None, CATEGORY) == {inactive.id}
    assert ids(PromotionStatus.EXPIRED, CATALOG) == {expired.id, edge.id}
    assert ids(PromotionStatus.ACTIVE, CATALOG) == set()


def test_list_orders_by_start_desc_then_id_and_paginates(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    now = START
    _, before = repo.list(None, None, now, 1, 1)
    low, high = sorted(uuid4() for _ in range(2))
    newest = make(starts_at=now + timedelta(days=3), ends_at=now + timedelta(days=9))
    tie_low = make(id=low, starts_at=now + timedelta(days=2), ends_at=now + timedelta(days=9))
    tie_high = make(id=high, starts_at=now + timedelta(days=2), ends_at=now + timedelta(days=9))
    oldest = make(starts_at=now + timedelta(days=1), ends_at=now + timedelta(days=9))
    for promotion in (tie_high, oldest, newest, tie_low):
        repo.add(promotion)
    expected = [newest.id, tie_low.id, tie_high.id, oldest.id]

    items, total = repo.list(None, None, now, 1, 48)
    assert total == before + 4
    assert [p.id for p in items if p.id in expected] == expected

    first, total_again = repo.list(None, None, now, 1, 2)
    assert len(first) == 2 and total_again == total
    beyond, total_beyond = repo.list(None, None, now, 1000, 48)
    assert beyond == [] and total_beyond == total


# CA-PROMOTIONS-11/17 con el repositorio: crear/editar cambia el precio vigente al instante.
def test_repository_changes_are_visible_in_the_effective_price(
    db_session: Session, repo: SqlPromotionRepository
) -> None:
    product_id = add_product(db_session, 100000)
    now_start = db_session.scalar(text("SELECT now() - interval '1 hour'"))
    now_end = db_session.scalar(text("SELECT now() + interval '1 hour'"))
    promotion = make(
        scope=PRODUCTS, product_ids=(product_id,), starts_at=now_start, ends_at=now_end
    )

    repo.add(promotion)
    assert effective(db_session, product_id).price == 85000

    repo.update(replace(promotion, scope=CATALOG, product_ids=(), percent_off=50))
    assert effective(db_session, product_id).price == 50000

    repo.update(replace(promotion, scope=CATALOG, product_ids=(), is_active=False))
    assert effective(db_session, product_id).price == 100000
