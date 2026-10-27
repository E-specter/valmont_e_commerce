from collections.abc import Callable
from decimal import Decimal

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import (
    AUTOMATIC,
    GOLD,
    QUARTZ,
    STEEL,
    Catalog,
    make_category,
    make_image,
    make_product,
    names,
)
from valmont.modules.catalog.adapters.persistence import (
    SqlAttributeRepository,
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.domain import (
    AttributeKind,
    AttributeValue,
    CatalogConflict,
    ProductQuery,
)

pytestmark = pytest.mark.integration


def test_listing_returns_only_published_newest_first_with_total(
    repo: SqlProductRepository, catalog: Catalog
) -> None:
    page = repo.list_published(ProductQuery(category=catalog.a.slug))

    assert names(page) == ["Cenit de prueba", "Boreal de prueba", "Aurora de prueba"]
    assert page.total == 3


@pytest.mark.parametrize(
    ("sort", "expected"),
    [
        ("newest", ["Cenit de prueba", "Boreal de prueba", "Aurora de prueba"]),
        ("price_asc", ["Aurora de prueba", "Cenit de prueba", "Boreal de prueba"]),
        ("price_desc", ["Boreal de prueba", "Cenit de prueba", "Aurora de prueba"]),
    ],
)
def test_listing_sorts(
    repo: SqlProductRepository, catalog: Catalog, sort: str, expected: list[str]
) -> None:
    assert names(repo.list_published(ProductQuery(category=catalog.a.slug, sort=sort))) == expected


@pytest.mark.parametrize("sort", ["newest", "price_asc", "price_desc"])
def test_ties_are_broken_by_id(db_session: Session, repo: SqlProductRepository, sort: str) -> None:
    # CATALOG-R8: mismo precio y misma fecha; sin desempate, las páginas podrían solaparse.
    category = make_category("Empates")
    SqlCategoryRepository(db_session).add(category)
    tied = [make_product(category, f"Empate {n} de prueba", days=9) for n in range(4)]
    for product in tied:
        repo.add(product)

    page = repo.list_published(ProductQuery(category=category.slug, sort=sort))

    assert [item.product.id for item in page.items] == sorted(p.id for p in tied)


@pytest.mark.parametrize(
    ("page", "expected"),
    [(1, ["Cenit de prueba", "Boreal de prueba"]), (2, ["Aurora de prueba"]), (3, [])],
)
def test_pagination_keeps_the_total_of_all_matches(
    repo: SqlProductRepository, catalog: Catalog, page: int, expected: list[str]
) -> None:
    result = repo.list_published(ProductQuery(category=catalog.a.slug, page=page, page_size=2))

    assert (names(result), result.total) == (expected, 3)


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({"movement": AUTOMATIC.code}, ["aurora"]),
        ({"case_material": GOLD.code}, ["boreal"]),
        ({"diameter_min": Decimal("40")}, ["boreal"]),
        ({"diameter_max": Decimal("38.0")}, ["aurora"]),  # rangos inclusivos
        ({"diameter_min": Decimal("38.0"), "diameter_max": Decimal("41.5")}, ["boreal", "aurora"]),
        ({"water_resistance_min": 100}, ["boreal"]),
        ({"price_min": 175000}, ["cenit", "boreal"]),
        ({"price_max": 175000}, ["cenit", "aurora"]),
        ({"price_min": 175000, "price_max": 175000}, ["cenit"]),
        ({"movement": AUTOMATIC.code, "price_min": 150000}, []),  # AND
        ({"case_material": STEEL.code, "diameter_min": Decimal("38")}, ["aurora"]),
    ],
)
def test_each_filter_restricts_results_and_leaves_out_products_without_the_attribute(
    repo: SqlProductRepository, catalog: Catalog, filters: dict[str, object], expected: list[str]
) -> None:
    page = repo.list_published(ProductQuery(category=catalog.a.slug, **filters))

    assert names(page) == [catalog.products[key].name for key in expected]
    assert page.total == len(expected)


def test_category_filter_uses_the_slug(repo: SqlProductRepository, catalog: Catalog) -> None:
    assert names(repo.list_published(ProductQuery(category=catalog.b.slug))) == [
        "Eclipse de prueba"
    ]
    assert names(repo.list_published(ProductQuery(category="no-existe"))) == []


@pytest.mark.parametrize(
    ("q", "expected"),
    [
        ("AURORA", ["aurora", "boreal"]),  # relevancia: Aurora la nombra dos veces
        ("TST-CEN-36", ["cenit"]),  # SKU
        ("vestir", ["cenit"]),  # descripción
        ("automatico", ["cenit"]),  # sin tilde encuentra "Automático" (CA-CATALOG-02)
        ("cronografo", ["boreal"]),
        ("relojes", []),
    ],
)
def test_search_finds_by_name_sku_and_description_ignoring_case_and_accents(
    repo: SqlProductRepository, catalog: Catalog, q: str, expected: list[str]
) -> None:
    page = repo.list_published(ProductQuery(q=q, category=catalog.a.slug))

    assert names(page) == [catalog.products[key].name for key in expected]
    assert page.total == len(expected)


def test_search_can_be_sorted_by_price_and_blank_text_is_no_search(
    repo: SqlProductRepository, catalog: Catalog
) -> None:
    by_price = repo.list_published(
        ProductQuery(q="aurora", sort="price_desc", category=catalog.a.slug)
    )
    blank = repo.list_published(ProductQuery(q="  ", category=catalog.a.slug))

    assert names(by_price) == ["Boreal de prueba", "Aurora de prueba"]
    assert blank.total == 3


def test_search_text_is_a_parameter_not_sql(repo: SqlProductRepository, catalog: Catalog) -> None:
    page = repo.list_published(ProductQuery(q="aurora'); DROP TABLE app.products; --"))

    assert page.total == 0
    assert repo.list_published(ProductQuery(category=catalog.a.slug)).total == 3


def test_search_uses_the_gin_index(
    db_session: Session, repo: SqlProductRepository, catalog: Catalog
) -> None:
    # Con 5 filas cualquier índice vale lo mismo. Se simula un catálogo real: muchos publicados
    # (status no filtra) que no coinciden con q, y estadísticas al día. Todo se deshace con la
    # transacción de la prueba.
    db_session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id,"
            " price_cents, status, published_at)"
            " SELECT gen_random_uuid(), 'TST-RELLENO-' || n, 'relleno-' || n, 'Relleno ' || n,"
            " 'Reloj ficticio de relleno.', :category, 100000, 'published', now()"
            " FROM generate_series(1, 300) AS n"
        ),
        {"category": catalog.b.id},
    )
    db_session.execute(text("SELECT gin_clean_pending_list('app.ix_products_search')"))
    db_session.execute(text("ANALYZE app.products"))
    db_session.execute(text("SET LOCAL enable_seqscan = off"))
    connection = db_session.connection()
    statements: list[tuple[str, object]] = []

    def capture(*args: object) -> None:
        _conn, _cursor, statement, parameters, *_ = args
        statements.append((str(statement), parameters))

    event.listen(connection, "before_cursor_execute", capture)
    try:
        repo.list_published(ProductQuery(q="aurora"))
    finally:
        event.remove(connection, "before_cursor_execute", capture)

    assert len(statements) == 2  # el total y la página
    for statement, parameters in statements:
        plan = connection.exec_driver_sql(f"EXPLAIN {statement}", parameters).scalars().all()
        assert any("ix_products_search" in line for line in plan), plan


def test_detail_query_joins_labels_first_image_and_keeps_specs_order(
    repo: SqlProductRepository, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]
    second, first = make_image(aurora, 1), make_image(aurora, 0)
    for image in (second, first):
        repo.add_image(image)

    summary = repo.get_published(aurora.slug)

    assert summary is not None
    assert summary.product == aurora
    assert summary.category == catalog.a
    assert (summary.movement, summary.case_material) == (AUTOMATIC, STEEL)
    assert summary.main_image == first
    assert repo.list_images(aurora.id) == [first, second]
    boreal = repo.get_published(catalog.products["boreal"].slug)
    assert boreal is not None
    assert boreal.product == catalog.products["boreal"]  # order_policy y lead_time_days
    cenit = repo.get_published(catalog.products["cenit"].slug)
    assert cenit is not None
    assert (cenit.movement, cenit.case_material, cenit.main_image) == (None, None, None)


def test_draft_never_appears_in_public_queries(
    repo: SqlProductRepository, catalog: Catalog
) -> None:
    draft = catalog.products["draco"]

    assert repo.get_published(draft.slug) is None
    assert repo.get_published("no-existe") is None
    assert draft.name not in names(repo.list_published(ProductQuery(q="vestir", page_size=48)))
    assert draft.name not in [s.product.name for s in repo.related(catalog.products["aurora"])]


def test_related_are_up_to_4_newest_published_of_the_same_category(
    repo: SqlProductRepository, catalog: Catalog
) -> None:
    for day in (5, 6, 7):
        repo.add(make_product(catalog.a, f"Extra {day} de prueba", days=day))

    related = repo.related(catalog.products["aurora"])

    assert [s.product.name for s in related] == [
        "Extra 7 de prueba",
        "Extra 6 de prueba",
        "Extra 5 de prueba",
        "Cenit de prueba",
    ]


def test_category_and_attribute_lists_show_only_active_values_by_position(
    db_session: Session, catalog: Catalog
) -> None:
    categories = SqlCategoryRepository(db_session)
    first = make_category("Primera", position=-1)
    for category in (first, make_category("Oculta", position=-2, is_active=False)):
        categories.add(category)
    attributes = SqlAttributeRepository(db_session)
    attributes.add(AttributeKind.MOVEMENT, AttributeValue("prueba-oculto", "Oculto", -1, False))

    assert categories.list_active() == [first, catalog.a, catalog.b]
    assert attributes.list_active(AttributeKind.MOVEMENT) == [QUARTZ, AUTOMATIC]
    assert attributes.list_active(AttributeKind.CASE_MATERIAL) == [STEEL, GOLD]


@pytest.mark.parametrize(
    ("build", "field"),
    [
        (lambda c: ("product", make_product(c.a, "Otro", sku=c.products["aurora"].sku)), "sku"),
        (lambda c: ("product", make_product(c.a, "Aurora de prueba", sku="TST-OTRO")), "slug"),
        (lambda c: ("category", make_category("Otra", slug=c.a.slug)), "slug"),
        (lambda c: ("movement", AttributeValue(AUTOMATIC.code, "Otro")), "code"),
        (lambda c: ("material", AttributeValue(STEEL.code, "Otro")), "code"),
        (lambda c: ("image", make_image(c.products["aurora"], 0)), "position"),
    ],
)
def test_duplicates_are_rejected_by_the_database_as_a_conflict(
    db_session: Session,
    repo: SqlProductRepository,
    catalog: Catalog,
    build: Callable[[Catalog], tuple[str, object]],
    field: str,
) -> None:
    repo.add_image(make_image(catalog.products["aurora"], 0))
    kind, entity = build(catalog)
    add = {
        "product": repo.add,
        "image": repo.add_image,
        "category": SqlCategoryRepository(db_session).add,
        "movement": lambda v: SqlAttributeRepository(db_session).add(AttributeKind.MOVEMENT, v),
        "material": lambda v: SqlAttributeRepository(db_session).add(
            AttributeKind.CASE_MATERIAL, v
        ),
    }[kind]

    with pytest.raises(CatalogConflict) as error, db_session.begin_nested():
        add(entity)

    assert error.value.field == field


def test_other_integrity_errors_are_not_disguised_as_conflicts(
    db_session: Session, repo: SqlProductRepository, catalog: Catalog
) -> None:
    orphan = make_product(make_category("Sin guardar"), "Huérfano")

    with pytest.raises(IntegrityError), db_session.begin_nested():
        repo.add(orphan)


@pytest.mark.parametrize(
    "values",
    [
        "price_cents = -1",
        "status = 'archived'",
        "case_diameter_mm = 0",
        "water_resistance_m = -1",
        "specs = '{}'",
        "order_policy = 'preorder'",
        "lead_time_days = 0",
    ],
)
def test_products_table_enforces_its_checks(
    db_session: Session, catalog: Catalog, values: str
) -> None:
    # Sentencias fijas de la prueba, sin datos externos.
    statement = text(f"UPDATE app.products SET {values} WHERE id = :id")

    with pytest.raises(IntegrityError), db_session.begin_nested():
        db_session.execute(statement, {"id": catalog.products["aurora"].id})
