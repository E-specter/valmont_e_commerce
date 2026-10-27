from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from valmont.modules.catalog.domain import (
    PAGE_SIZE_DEFAULT,
    AttributeValue,
    CatalogError,
    Category,
    NotPublishable,
    OrderPolicy,
    Product,
    ProductImage,
    ProductQuery,
    ProductSort,
    ProductStatus,
    SpecEntry,
    slugify,
)

# Los mismos que identity: Cc (\x00 no cabe en un text de PostgreSQL) y sustitutos sueltos.
FORBIDDEN_CHARS = ["\x00", "\x1f", "\t", "\n", "\x7f", "\ud800", "\udfff"]


def make_product(**changes: object) -> Product:
    fields: dict[str, object] = {
        "id": uuid4(),
        "sku": "TST-001",
        "slug": "reloj-de-prueba",
        "name": "Reloj de prueba",
        "description": "Descripción ficticia.",
        "category_id": uuid4(),
        "price": 100000,
    }
    return Product(**{**fields, **changes})


def make_category(**changes: object) -> Category:
    return Category(**{"id": uuid4(), "slug": "pruebas", "name": "Pruebas", **changes})


@pytest.mark.parametrize(
    ("name", "slug"),
    [
        ("Heritage 38", "heritage-38"),
        ("  Reloj Clásico   Ñandú — Edición ", "reloj-clasico-nandu-edicion"),
        ("ÁCERO & Oro: 41mm", "acero-oro-41mm"),
    ],
)
def test_slugify_lowercases_strips_accents_and_joins_with_hyphens(name: str, slug: str) -> None:
    assert slugify(name) == slug


@pytest.mark.parametrize("name", ["", "   ", "¡¡!!", "—"])
def test_slugify_rejects_names_without_letters_or_digits(name: str) -> None:
    with pytest.raises(CatalogError):
        slugify(name)


def test_product_strips_texts_and_defaults_to_empty_draft() -> None:
    product = make_product(sku=" TST-001 ", name=" Reloj de prueba ")

    assert (product.sku, product.name, product.specs) == ("TST-001", "Reloj de prueba", ())
    assert (product.status, product.published_at) == (ProductStatus.DRAFT, None)


def test_specs_keep_editorial_order_and_strip_texts() -> None:
    specs = [SpecEntry(" Cristal ", " Zafiro "), SpecEntry("Calibre", "VT-01")]

    product = make_product(specs=specs)

    assert product.specs == (SpecEntry("Cristal", "Zafiro"), SpecEntry("Calibre", "VT-01"))
    assert len(make_product(specs=[SpecEntry(f"Fila {n}", "x") for n in range(40)]).specs) == 40


@pytest.mark.parametrize(
    ("label", "value"), [("", "Zafiro"), ("Cristal", " "), ("a" * 61, "x"), ("Cristal", "x" * 201)]
)
def test_spec_entry_label_has_1_to_60_and_value_1_to_200_characters(label: str, value: str) -> None:
    assert SpecEntry("a" * 60, "x" * 200).label == "a" * 60
    with pytest.raises(CatalogError):
        SpecEntry(label, value)


def test_spec_labels_are_unique_ignoring_case() -> None:
    with pytest.raises(CatalogError):
        make_product(specs=[SpecEntry("Cristal", "Zafiro"), SpecEntry("CRISTAL", "Mineral")])


def test_description_is_plain_text_with_normalized_line_breaks() -> None:
    product = make_product(description="  Línea 1\r\nLínea 2\rLínea 3\n\nFin \n")

    assert product.description == "Línea 1\nLínea 2\nLínea 3\n\nFin"


@pytest.mark.parametrize("char", [c for c in FORBIDDEN_CHARS if c != "\n"])
def test_description_rejects_every_other_control_character(char: str) -> None:
    with pytest.raises(CatalogError):
        make_product(description=f"Ficticio{char}texto")


@pytest.mark.parametrize(
    ("build", "limit"),
    [
        (lambda n: make_product(sku="S" * n), 40),
        (lambda n: make_product(name="n" * n), 120),
        (lambda n: make_product(description="d" * n), 5000),
        (lambda n: make_product(slug="s" * n), 60),
        (lambda n: make_category(name="c" * n), 60),
        (lambda n: make_category(description="d" * n), 500),
        (lambda n: AttributeValue(code="c" * n, label="Valor"), 60),
        (lambda n: AttributeValue(code="steel", label="l" * n), 60),
        (lambda n: ProductImage(uuid4(), uuid4(), "p/1.webp", "a" * n, 0), 150),
    ],
)
def test_texts_accept_up_to_their_spec_length(build: Callable[[int], object], limit: int) -> None:
    build(limit)
    with pytest.raises(CatalogError):
        build(limit + 1)


def test_slugify_cuts_long_names_to_60_without_a_trailing_hyphen() -> None:
    assert slugify("a" * 50 + " " + "b" * 20) == "a" * 50 + "-" + "b" * 9
    assert slugify("a" * 59 + " b") == "a" * 59


def test_draft_may_have_empty_description_and_zero_price() -> None:
    product = make_product(description="  ", price=0)

    assert (product.description, product.price) == ("", 0)


@pytest.mark.parametrize("diameter", [Decimal("38"), Decimal("41.5"), Decimal("999.9")])
def test_product_accepts_diameter_above_zero_with_one_decimal(diameter: Decimal) -> None:
    assert make_product(case_diameter_mm=diameter).case_diameter_mm == diameter


@pytest.mark.parametrize(
    "changes",
    [
        {"price": -1},
        {"sku": "  "},
        {"name": ""},
        {"slug": "Con Espacios"},
        {"slug": "acento-é"},
        {"slug": "-guion-inicial"},
        {"slug": "doble--guion"},
        {"movement_code": "Automático"},
        {"case_material_code": ""},
        {"case_diameter_mm": Decimal("0")},
        {"case_diameter_mm": Decimal("-1")},
        {"case_diameter_mm": Decimal("38.25")},
        {"case_diameter_mm": Decimal("1000")},
        {"case_diameter_mm": Decimal("NaN")},
        {"case_diameter_mm": Decimal("Infinity")},
        {"water_resistance_m": -1},
        {"lead_time_days": 0},
        {"lead_time_days": -5},
        {"specs": [SpecEntry("Cristal", "Zafiro"), SpecEntry("Cristal", "Mineral")]},
        {"specs": [SpecEntry(f"Fila {n}", "x") for n in range(41)]},
        {"status": ProductStatus.PUBLISHED},  # sin published_at
    ],
)
def test_product_enforces_its_invariants(changes: dict[str, object]) -> None:
    with pytest.raises(CatalogError):
        make_product(**changes)


def test_published_product_keeps_its_publication_time() -> None:
    at = datetime(2026, 10, 1, tzinfo=UTC)

    product = make_product(status="published", published_at=at)

    assert (product.status, product.published_at) == (ProductStatus.PUBLISHED, at)


def test_complete_product_with_active_category_and_image_is_publishable() -> None:
    make_product().ensure_publishable(make_category(), image_count=1)


def test_publication_lists_every_missing_requirement() -> None:
    product = make_product(description="", price=0, order_policy="made_to_order")

    with pytest.raises(NotPublishable) as error:
        product.ensure_publishable(make_category(is_active=False), image_count=0)

    assert error.value.missing == ("description", "category", "price", "image", "lead_time_days")


def test_order_policy_defaults_to_stock_and_rejects_unknown_values() -> None:
    product = make_product(order_policy="backorder", lead_time_days=21)

    assert (make_product().order_policy, make_product().lead_time_days) == (OrderPolicy.STOCK, None)
    assert (product.order_policy, product.lead_time_days) == (OrderPolicy.BACKORDER, 21)
    with pytest.raises(ValueError):
        make_product(order_policy="preorder")


@pytest.mark.parametrize("policy", ["made_to_order", "backorder"])
def test_publishing_a_product_sold_on_order_requires_lead_time(policy: str) -> None:
    category = make_category()

    with pytest.raises(NotPublishable) as error:
        make_product(order_policy=policy).ensure_publishable(category, image_count=1)

    assert error.value.missing == ("lead_time_days",)
    make_product(order_policy=policy, lead_time_days=30).ensure_publishable(category, 1)


@pytest.mark.parametrize(
    ("category", "image_count", "missing"),
    [
        (make_category(is_active=False), 1, ("category",)),
        (make_category(), 0, ("image",)),
    ],
)
def test_publication_requires_active_category_and_an_image(
    category: Category, image_count: int, missing: tuple[str, ...]
) -> None:
    with pytest.raises(NotPublishable) as error:
        make_product().ensure_publishable(category, image_count)

    assert error.value.missing == missing


def test_category_and_attribute_value_normalize_their_texts() -> None:
    category = make_category(name=" Clásicos ", description="   ")
    value = AttributeValue(code="automatic", label=" Automático ")

    assert (category.name, category.description) == ("Clásicos", None)
    assert (value.label, value.position, value.is_active) == ("Automático", 0, True)


@pytest.mark.parametrize(
    "build",
    [
        lambda: make_category(slug="Clásicos"),
        lambda: make_category(name=" "),
        lambda: AttributeValue(code="acero inoxidable", label="Acero"),
        lambda: AttributeValue(code="steel", label=""),
        lambda: ProductImage(uuid4(), uuid4(), "p/1.webp", " ", 0),
        lambda: ProductImage(uuid4(), uuid4(), "p/1.webp", "a" * 151, 0),
        lambda: ProductImage(uuid4(), uuid4(), " ", "Esfera", 0),
    ],
)
def test_category_attribute_and_image_enforce_their_invariants(build: Callable[[], object]) -> None:
    with pytest.raises(CatalogError):
        build()


@pytest.mark.parametrize("char", FORBIDDEN_CHARS)
@pytest.mark.parametrize(
    "build",
    [
        lambda text: slugify(f"Heritage{text}"),
        lambda text: make_product(name=f"Reloj{text}"),
        lambda text: make_product(sku=f"TST{text}"),
        lambda text: SpecEntry(f"Cristal{text}", "Zafiro"),
        lambda text: SpecEntry("Cristal", f"Zafiro{text}"),
        lambda text: make_category(name=f"Pruebas{text}"),
        lambda text: make_category(description=f"Pruebas{text}"),
        lambda text: AttributeValue(code="steel", label=f"Acero{text}"),
        lambda text: ProductImage(uuid4(), uuid4(), "p/1.webp", f"a{text}", 0),
        lambda text: ProductQuery(q=f"reloj{text}"),
        lambda text: ProductQuery(category=f"pruebas{text}"),
        lambda text: ProductQuery(movement=f"automatic{text}"),
        lambda text: ProductQuery(case_material=f"steel{text}"),
    ],
)
def test_texts_reject_control_characters_and_lone_surrogates(
    build: Callable[[str], object], char: str
) -> None:
    with pytest.raises(CatalogError):
        build(char)


def test_query_defaults_to_newest_first_page_of_24() -> None:
    query = ProductQuery()

    assert (query.sort, query.page, query.page_size) == (ProductSort.NEWEST, 1, PAGE_SIZE_DEFAULT)
    assert PAGE_SIZE_DEFAULT == 24


def test_query_with_text_defaults_to_relevance_and_blank_text_is_no_text() -> None:
    assert ProductQuery(q=" aurora ").q == "aurora"
    assert ProductQuery(q="aurora").sort == ProductSort.RELEVANCE
    assert (ProductQuery(q="   ").q, ProductQuery(q="   ").sort) == (None, ProductSort.NEWEST)
    assert ProductQuery(q="aurora", sort="price_asc").sort == ProductSort.PRICE_ASC


@pytest.mark.parametrize(
    "changes",
    [
        {"sort": "relevance"},  # CATALOG-R8: solo con q
        {"sort": "oldest"},
        {"page": 0},
        {"page_size": 0},
        {"page_size": 49},
    ],
)
def test_query_rejects_invalid_sort_and_pagination(changes: dict[str, object]) -> None:
    with pytest.raises(CatalogError):
        ProductQuery(**changes)


@pytest.mark.parametrize("page_size", [1, 48])
def test_query_accepts_page_size_from_1_to_48(page_size: int) -> None:
    assert ProductQuery(page_size=page_size).page_size == page_size
