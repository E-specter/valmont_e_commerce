from datetime import UTC, datetime, timedelta

import pytest

from tests.catalog.test_domain import make_category, make_product
from valmont.modules.catalog.domain import (
    AdminProductQuery,
    CatalogError,
    Product,
    ProductStatus,
    SlugLocked,
    SpecEntry,
    check_specs,
)

FIRST = datetime(2026, 10, 1, tzinfo=UTC)
LATER = FIRST + timedelta(days=30)


def test_first_publication_sets_published_at_and_republishing_keeps_it() -> None:
    published = make_product().published(FIRST)
    republished = published.unpublished().published(LATER)

    assert (published.status, published.published_at) == (ProductStatus.PUBLISHED, FIRST)
    assert (republished.status, republished.published_at) == (ProductStatus.PUBLISHED, FIRST)


def test_unpublishing_keeps_the_first_publication_date() -> None:
    draft = make_product().published(FIRST).unpublished()

    assert (draft.status, draft.published_at) == (ProductStatus.DRAFT, FIRST)


def test_slug_changes_freely_until_the_first_publication() -> None:
    make_product().ensure_slug_can_change("otro-slug")


@pytest.mark.parametrize(
    "product",
    [make_product().published(FIRST), make_product().published(FIRST).unpublished()],
    ids=["publicado", "despublicado"],
)
def test_slug_is_locked_after_the_first_publication(product: Product) -> None:
    product.ensure_slug_can_change(product.slug)  # el mismo slug no es un cambio
    with pytest.raises(SlugLocked):
        product.ensure_slug_can_change("otro-slug")


def test_publishing_requires_every_rule_of_catalog_r2_before_the_transition() -> None:
    # ensure_publishable no cambia nada: published() solo se llama si pasa.
    product = make_product(order_policy="backorder", lead_time_days=10)

    product.ensure_publishable(make_category(), image_count=1)

    assert product.published(FIRST).lead_time_days == 10


def test_check_specs_rejects_duplicates_ignoring_case_and_more_than_40() -> None:
    assert check_specs([SpecEntry("Cristal", "Zafiro")]) == (SpecEntry("Cristal", "Zafiro"),)
    with pytest.raises(CatalogError):
        check_specs([SpecEntry("Cristal", "Zafiro"), SpecEntry("cristal", "Mineral")])
    with pytest.raises(CatalogError):
        check_specs(SpecEntry(f"Fila {n}", "x") for n in range(41))


def test_admin_query_accepts_status_and_blank_text_is_no_search() -> None:
    query = AdminProductQuery(status="draft", q="  ")

    assert (query.status, query.q, query.page, query.page_size) == (
        ProductStatus.DRAFT,
        None,
        1,
        24,
    )


@pytest.mark.parametrize(
    "changes",
    [{"status": "archived"}, {"q": "reloj\x00"}, {"page": 0}, {"page_size": 49}],
)
def test_admin_query_rejects_invalid_values(changes: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        AdminProductQuery(**changes)
