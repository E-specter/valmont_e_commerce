"""CA-CATALOG-01 a 04 por HTTP contra PostgreSQL (la transacción de la prueba se deshace)."""

import pytest
from fastapi.testclient import TestClient
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
)
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.adapters.persistence import (
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.domain import ProductImage
from valmont.shared.config import Settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

BASE = "/api/v1/catalog"
CDN = "https://cdn.valmont.test"
NOT_FOUND = {"error": {"code": "not_found", "message": "Producto no encontrado.", "details": None}}


@pytest.fixture
def images(repo: SqlProductRepository, catalog: Catalog) -> dict[str, list[ProductImage]]:
    """Dos imágenes por producto, guardadas en orden inverso: la API debe ordenarlas."""
    stored = {}
    for key, product in catalog.products.items():
        stored[key] = [make_image(product, 0), make_image(product, 1)]
        for image in reversed(stored[key]):
            repo.add_image(image)
    return stored


@pytest.fixture
def client(
    db_session: Session, images: dict[str, list[ProductImage]], monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    settings = Settings(_env_file=None, storage_public_url=CDN)
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db_session
    return TestClient(app)


def names(client: TestClient, **params: object) -> list[str]:
    response = client.get(f"{BASE}/products", params=params)
    assert response.status_code == 200, response.json()
    return [item["name"] for item in response.json()["items"]]


def test_listing_shows_only_published_paginated_with_real_total(
    client: TestClient, catalog: Catalog
) -> None:
    first = client.get(f"{BASE}/products", params={"category": catalog.a.slug, "page_size": 2})
    last = client.get(
        f"{BASE}/products", params={"category": catalog.a.slug, "page_size": 2, "page": 2}
    )
    beyond = client.get(
        f"{BASE}/products", params={"category": catalog.a.slug, "page_size": 2, "page": 9}
    )

    assert [i["name"] for i in first.json()["items"]] == ["Cenit de prueba", "Boreal de prueba"]
    assert [i["name"] for i in last.json()["items"]] == ["Aurora de prueba"]
    assert beyond.json() == {"items": [], "total": 3, "page": 9, "page_size": 2}  # CATALOG-R9
    assert first.json()["total"] == last.json()["total"] == 3  # el borrador no cuenta


@pytest.mark.parametrize(
    ("sort", "expected"),
    [
        ("newest", ["Cenit de prueba", "Boreal de prueba", "Aurora de prueba"]),
        ("price_asc", ["Aurora de prueba", "Cenit de prueba", "Boreal de prueba"]),
        ("price_desc", ["Boreal de prueba", "Cenit de prueba", "Aurora de prueba"]),
    ],
)
def test_listing_sorts(
    client: TestClient, catalog: Catalog, sort: str, expected: list[str]
) -> None:
    assert names(client, category=catalog.a.slug, sort=sort) == expected


@pytest.mark.parametrize(
    ("q", "expected"),
    [
        ("aurora", ["Aurora de prueba", "Boreal de prueba"]),  # relevancia por defecto
        ("AURORA", ["Aurora de prueba", "Boreal de prueba"]),
        ("TST-CEN-36", ["Cenit de prueba"]),  # SKU
        ("vestir", ["Cenit de prueba"]),  # descripción
        ("automatico", ["Cenit de prueba"]),  # sin tilde encuentra "Automático"
        ("cronografo", ["Boreal de prueba"]),
    ],
)
def test_search_by_name_sku_and_description_ignoring_case_and_accents(
    client: TestClient, catalog: Catalog, q: str, expected: list[str]
) -> None:
    assert names(client, category=catalog.a.slug, q=q) == expected


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({"movement": AUTOMATIC.code}, ["Aurora de prueba"]),
        ({"case_material": GOLD.code}, ["Boreal de prueba"]),
        ({"case_diameter_mm_min": "38", "case_diameter_mm_max": "38"}, ["Aurora de prueba"]),
        ({"case_diameter_mm_min": "40"}, ["Boreal de prueba"]),
        ({"water_resistance_m_min": "100"}, ["Boreal de prueba"]),
        ({"price_min": "175000"}, ["Cenit de prueba", "Boreal de prueba"]),
        ({"price_max": "175000"}, ["Cenit de prueba", "Aurora de prueba"]),
        ({"movement": QUARTZ.code, "case_material": STEEL.code}, []),  # AND
    ],
)
def test_each_filter_restricts_and_leaves_out_products_without_the_attribute(
    client: TestClient, catalog: Catalog, filters: dict[str, str], expected: list[str]
) -> None:
    assert names(client, category=catalog.a.slug, **filters) == expected


def test_category_filter_by_slug_and_unknown_slug_is_empty(
    client: TestClient, catalog: Catalog
) -> None:
    assert names(client, category=catalog.b.slug) == ["Eclipse de prueba"]
    assert names(client, category="no-existe") == []


def test_detail_has_ordered_images_specs_attributes_and_related(
    client: TestClient, catalog: Catalog, images: dict[str, list[ProductImage]]
) -> None:
    aurora = catalog.products["aurora"]

    body = client.get(f"{BASE}/products/{aurora.slug}").json()

    assert body["description"] == "Aurora ficticia con esfera azul.\nSegunda línea (CATALOG-R12)."
    assert body["specs"] == [
        {"label": "Cristal", "value": "Zafiro"},
        {"label": "Calibre", "value": "TST-01"},
    ]
    assert [image["id"] for image in body["images"]] == [str(i.id) for i in images["aurora"]]
    first = images["aurora"][0]
    assert body["main_image"] == {
        "id": str(first.id),
        "url": f"{CDN}/storage/v1/object/public/products/{first.storage_path}",
        "alt": first.alt,
    }
    assert (body["movement"], body["case_material"]) == (
        {"code": AUTOMATIC.code, "label": AUTOMATIC.label},
        {"code": STEEL.code, "label": STEEL.label},
    )
    assert (body["case_diameter_mm"], body["water_resistance_m"]) == (38.0, 50)
    assert body["price"] == {"amount": 100000, "currency": "PEN"}
    # CATALOG-R6: misma categoría, sin el propio ni el borrador ni la otra categoría.
    assert [item["name"] for item in body["related"]] == ["Cenit de prueba", "Boreal de prueba"]


def test_related_are_at_most_4(
    client: TestClient, repo: SqlProductRepository, catalog: Catalog
) -> None:
    for day in (5, 6, 7):
        extra = make_product(catalog.a, f"Extra {day} de prueba", days=day)
        repo.add(extra)
        repo.add_image(make_image(extra, 0))

    related = client.get(f"{BASE}/products/{catalog.products['aurora'].slug}").json()["related"]

    assert [item["name"] for item in related] == [
        "Extra 7 de prueba",
        "Extra 6 de prueba",
        "Extra 5 de prueba",
        "Cenit de prueba",
    ]


def test_draft_and_unknown_slug_are_the_same_404(client: TestClient, catalog: Catalog) -> None:
    draft = client.get(f"{BASE}/products/{catalog.products['draco'].slug}")
    unknown = client.get(f"{BASE}/products/no-existe")

    assert (draft.status_code, unknown.status_code) == (404, 404)
    assert draft.json() == unknown.json() == NOT_FOUND
    assert "Draco borrador" not in names(client, q="vestir", page_size=48)


def test_categories_and_attributes_show_only_active_values_by_position(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    categories = SqlCategoryRepository(db_session)
    first = make_category("Primera", position=-1)
    for category in (first, make_category("Oculta", position=-2, is_active=False)):
        categories.add(category)

    listed = client.get(f"{BASE}/categories").json()
    attributes = client.get(f"{BASE}/attributes").json()

    assert [c["slug"] for c in listed] == [first.slug, catalog.a.slug, catalog.b.slug]
    assert listed[0] == {"slug": first.slug, "name": "Primera", "description": None}
    assert attributes == {
        "movements": [
            {"code": QUARTZ.code, "label": QUARTZ.label},
            {"code": AUTOMATIC.code, "label": AUTOMATIC.label},
        ],
        "case_materials": [
            {"code": STEEL.code, "label": STEEL.label},
            {"code": GOLD.code, "label": GOLD.label},
        ],
    }
