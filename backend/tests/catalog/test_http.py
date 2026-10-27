import json
from decimal import Decimal
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from tests.catalog.catalog_helpers import (
    AUTOMATIC,
    GOLD,
    QUARTZ,
    STEEL,
    make_category,
    make_image,
    make_product,
)
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.domain import (
    AttributeKind,
    AttributeValue,
    Category,
    Product,
    ProductImage,
    ProductPage,
    ProductQuery,
    ProductSort,
    ProductSummary,
    SpecEntry,
)
from valmont.shared.config import Settings

BASE = "/api/v1/catalog"
CDN = "https://cdn.valmont.test"
SUMMARY_KEYS = {
    "id",
    "slug",
    "sku",
    "name",
    "category",
    "price",
    "movement",
    "case_material",
    "case_diameter_mm",
    "water_resistance_m",
    "main_image",
}
DETAIL_KEYS = SUMMARY_KEYS | {"description", "specs", "images", "related"}
NOT_FOUND = {"error": {"code": "not_found", "message": "Producto no encontrado.", "details": None}}

CATEGORY = make_category("Clásicos de prueba", description="Relojes ficticios.")


def summary(product: Product, *, images: int = 1, attributes: bool = True) -> ProductSummary:
    main = make_image(product, 0) if images else None
    return ProductSummary(
        product,
        CATEGORY,
        AUTOMATIC if attributes else None,
        STEEL if attributes else None,
        main,
    )


class FakeProducts:
    def __init__(self) -> None:
        self.summaries: dict[str, ProductSummary] = {}
        self.images: dict[UUID, list[ProductImage]] = {}
        self.related_items: list[ProductSummary] = []
        self.queries: list[ProductQuery] = []
        self.slugs: list[str] = []

    def list_published(self, query: ProductQuery) -> ProductPage:
        self.queries.append(query)
        items = list(self.summaries.values())
        return ProductPage(items, len(items) + 10)  # total de todas las páginas

    def get_published(self, slug: str) -> ProductSummary | None:
        self.slugs.append(slug)
        return self.summaries.get(slug)

    def list_images(self, product_id: UUID) -> list[ProductImage]:
        return self.images.get(product_id, [])

    def related(self, product: Product) -> list[ProductSummary]:
        return self.related_items


class FakeCategories:
    def __init__(self, categories: list[Category]) -> None:
        self.categories = categories

    def list_active(self) -> list[Category]:
        return self.categories


class FakeAttributes:
    def list_active(self, kind: AttributeKind) -> list[AttributeValue]:
        return [QUARTZ, AUTOMATIC] if kind is AttributeKind.MOVEMENT else [STEEL, GOLD]


def use_settings(monkeypatch: pytest.MonkeyPatch, **values: object) -> None:
    settings = Settings(_env_file=None, **values)
    monkeypatch.setattr(http, "get_settings", lambda: settings)


@pytest.fixture
def products() -> FakeProducts:
    return FakeProducts()


@pytest.fixture
def client(products: FakeProducts, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_settings(monkeypatch, storage_public_url=CDN + "/", supabase_url="http://interno:54321")
    app = create_app()
    app.dependency_overrides[http.get_product_repository] = lambda: products
    app.dependency_overrides[http.get_category_repository] = lambda: FakeCategories([CATEGORY])
    app.dependency_overrides[http.get_attribute_repository] = FakeAttributes
    return TestClient(app, raise_server_exceptions=False)


def test_listing_returns_the_contract_page_and_summary_shape(
    client: TestClient, products: FakeProducts
) -> None:
    with_attributes = make_product(
        CATEGORY,
        "Heritage de prueba",
        case_diameter_mm=Decimal("38.0"),
        water_resistance_m=50,
        price=1250000,
    )
    bare = make_product(CATEGORY, "Sencillo de prueba")
    products.summaries = {
        with_attributes.slug: summary(with_attributes),
        bare.slug: summary(bare, attributes=False),
    }

    response = client.get(f"{BASE}/products", params={"page": 2, "page_size": 2})

    assert response.status_code == 200
    body = response.json()
    assert (body["total"], body["page"], body["page_size"]) == (12, 2, 2)
    first, second = body["items"]
    assert set(first) == set(second) == SUMMARY_KEYS  # sin status, storage_path ni fechas
    main = products.summaries[with_attributes.slug].main_image
    assert first == {
        "id": str(with_attributes.id),
        "slug": "heritage-de-prueba",
        "sku": "TST-HERITAGE-DE-PRUEBA",
        "name": "Heritage de prueba",
        "category": {"slug": CATEGORY.slug, "name": CATEGORY.name},
        "price": {"amount": 1250000, "currency": "PEN"},
        "movement": {"code": AUTOMATIC.code, "label": AUTOMATIC.label},
        "case_material": {"code": STEEL.code, "label": STEEL.label},
        "case_diameter_mm": 38.0,
        "water_resistance_m": 50,
        "main_image": {
            "id": str(main.id),
            "url": f"{CDN}/storage/v1/object/public/products/{main.storage_path}",
            "alt": main.alt,
        },
    }
    # CATALOG-R5: los atributos que faltan aparecen con null.
    assert [second[key] for key in ("movement", "case_material")] == [None, None]
    assert [second[key] for key in ("case_diameter_mm", "water_resistance_m")] == [None, None]


def test_listing_passes_every_filter_to_the_query(
    client: TestClient, products: FakeProducts
) -> None:
    params = {
        "q": " aurora ",
        "category": "clasicos",
        "movement": "automatic",
        "case_material": "steel",
        "case_diameter_mm_min": "38",
        "case_diameter_mm_max": "41.5",
        "water_resistance_m_min": "100",
        "price_min": "100000",
        "price_max": "250000",
        "sort": "price_desc",
        "page": "3",
        "page_size": "48",
    }

    assert client.get(f"{BASE}/products", params=params).status_code == 200

    assert products.queries == [
        ProductQuery(
            q="aurora",
            category="clasicos",
            movement="automatic",
            case_material="steel",
            diameter_min=Decimal("38"),
            diameter_max=Decimal("41.5"),
            water_resistance_min=100,
            price_min=100000,
            price_max=250000,
            sort=ProductSort.PRICE_DESC,
            page=3,
            page_size=48,
        )
    ]


@pytest.mark.parametrize(
    ("params", "sort"),
    [
        ({}, ProductSort.NEWEST),
        ({"q": "aurora"}, ProductSort.RELEVANCE),
        ({"q": "   "}, ProductSort.NEWEST),  # q vacío = sin búsqueda
        ({"q": ""}, ProductSort.NEWEST),
        ({"price_min": "0", "price_max": "0"}, ProductSort.NEWEST),  # rangos inclusivos
    ],
)
def test_listing_defaults(
    client: TestClient, products: FakeProducts, params: dict[str, str], sort: ProductSort
) -> None:
    body = client.get(f"{BASE}/products", params=params).json()

    [query] = products.queries
    assert (query.sort, query.page, query.page_size) == (sort, 1, 24)
    assert (body["page"], body["page_size"]) == (1, 24)
    assert query.q in (None, "aurora")


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({"page": "0"}, id="page-0"),
        pytest.param({"page": "1001"}, id="page-1001"),
        pytest.param({"page_size": "0"}, id="page_size-0"),
        pytest.param({"page_size": "49"}, id="page_size-49"),
        pytest.param({"sort": "oldest"}, id="sort-desconocido"),
        pytest.param({"sort": "relevance"}, id="relevance-sin-q"),
        pytest.param({"sort": "relevance", "q": "  "}, id="relevance-con-q-vacio"),
        pytest.param({"q": "x" * 101}, id="q-largo"),
        pytest.param({"price_min": "-1"}, id="precio-negativo"),
        pytest.param({"price_max": "1.5"}, id="precio-decimal"),
        pytest.param({"price_min": "abc"}, id="precio-texto"),
        pytest.param({"price_min": "10", "price_max": "5"}, id="precio-min-mayor"),
        pytest.param(
            {"case_diameter_mm_min": "41.5", "case_diameter_mm_max": "38"}, id="diametro-min-mayor"
        ),
        pytest.param({"case_diameter_mm_min": "NaN"}, id="diametro-nan"),
        pytest.param({"water_resistance_m_min": "mucho"}, id="resistencia-texto"),
        pytest.param({"category": "clasicos\x00"}, id="categoria-nul"),
        pytest.param({"q": "reloj\x1f"}, id="q-control"),
    ],
)
def test_listing_rejects_invalid_parameters_with_422(
    client: TestClient, products: FakeProducts, params: dict[str, str]
) -> None:
    response = client.get(f"{BASE}/products", params=params)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert all(set(detail) == {"loc", "type", "msg"} for detail in error["details"])  # T-019
    assert products.queries == []


def test_detail_returns_images_specs_and_related_in_order(
    client: TestClient, products: FakeProducts
) -> None:
    product = make_product(
        CATEGORY,
        "Heritage de prueba",
        description="Línea 1\nLínea 2",
        specs=(SpecEntry("Calibre", "TST-01"), SpecEntry("Cristal", "Zafiro")),
    )
    other = make_product(CATEGORY, "Otro de prueba")
    products.summaries[product.slug] = summary(product)
    images = [make_image(product, 0), make_image(product, 1)]
    products.images[product.id] = images
    products.related_items = [summary(other)]

    response = client.get(f"{BASE}/products/{product.slug}")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == DETAIL_KEYS
    assert body["description"] == "Línea 1\nLínea 2"
    assert body["specs"] == [
        {"label": "Calibre", "value": "TST-01"},
        {"label": "Cristal", "value": "Zafiro"},
    ]
    assert [image["id"] for image in body["images"]] == [str(image.id) for image in images]
    assert all(set(image) == {"id", "url", "alt"} for image in body["images"])
    [related] = body["related"]
    assert set(related) == SUMMARY_KEYS
    assert related["slug"] == other.slug


@pytest.mark.parametrize("slug", ["no-existe", "Mayusculas", "con%00nul", "a" * 61])
def test_unknown_draft_or_malformed_slug_is_the_same_404(
    client: TestClient, products: FakeProducts, slug: str
) -> None:
    # Un borrador no está en get_published (CATALOG-R1): en el fake es lo mismo que no existir.
    response = client.get(f"{BASE}/products/{slug}")

    assert response.status_code == 404
    assert response.json() == NOT_FOUND
    assert products.slugs == (["no-existe"] if slug == "no-existe" else [])


def test_categories_and_attributes_return_public_fields_only(client: TestClient) -> None:
    categories = client.get(f"{BASE}/categories")
    attributes = client.get(f"{BASE}/attributes")

    assert categories.json() == [
        {"slug": CATEGORY.slug, "name": CATEGORY.name, "description": "Relojes ficticios."}
    ]
    assert attributes.json() == {
        "movements": [
            {"code": QUARTZ.code, "label": QUARTZ.label},
            {"code": AUTOMATIC.code, "label": AUTOMATIC.label},
        ],
        "case_materials": [
            {"code": STEEL.code, "label": STEEL.label},
            {"code": GOLD.code, "label": GOLD.label},
        ],
    }


@pytest.mark.parametrize(
    ("settings", "base"),
    [
        ({"storage_public_url": "https://cdn.valmont.test/"}, "https://cdn.valmont.test"),
        ({"supabase_url": "http://127.0.0.1:54321/"}, "http://127.0.0.1:54321"),
        (
            {"storage_public_url": "https://cdn.valmont.test", "supabase_url": "http://interno"},
            "https://cdn.valmont.test",
        ),
    ],
)
def test_image_url_uses_public_storage_url_or_supabase_url(
    client: TestClient,
    products: FakeProducts,
    monkeypatch: pytest.MonkeyPatch,
    settings: dict[str, str],
    base: str,
) -> None:
    use_settings(monkeypatch, **settings)
    product = make_product(CATEGORY, "Heritage de prueba")
    products.summaries[product.slug] = summary(product)

    [item] = client.get(f"{BASE}/products").json()["items"]

    path = products.summaries[product.slug].main_image.storage_path
    assert item["main_image"]["url"] == f"{base}/storage/v1/object/public/products/{path}"


def test_missing_storage_and_supabase_url_is_a_500_without_details(
    client: TestClient, products: FakeProducts, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_settings(monkeypatch)
    product = make_product(CATEGORY, "Heritage de prueba")
    products.summaries[product.slug] = summary(product)

    response = client.get(f"{BASE}/products")

    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "internal_error",
        "message": "Error interno del servidor.",
        "details": None,
    }


def test_openapi_declares_the_public_routes_and_common_errors() -> None:
    document = create_app().openapi()
    paths = document["paths"]
    expected = {
        f"{BASE}/products": {"200", "422"},
        f"{BASE}/products/{{slug}}": {"200", "404", "422"},
        f"{BASE}/categories": {"200"},
        f"{BASE}/attributes": {"200"},
    }

    for path, statuses in expected.items():
        responses = paths[path]["get"]["responses"]
        assert set(responses) == statuses, path
        for status in statuses - {"200"}:
            schema = responses[status]["content"]["application/json"]["schema"]
            assert schema == {"$ref": "#/components/schemas/ErrorOut"}
    params = [p["name"] for p in paths[f"{BASE}/products"]["get"]["parameters"]]
    assert params == [
        "q",
        "category",
        "movement",
        "case_material",
        "case_diameter_mm_min",
        "case_diameter_mm_max",
        "water_resistance_m_min",
        "price_min",
        "price_max",
        "sort",
        "page",
        "page_size",
    ]
    assert "HTTPValidationError" not in json.dumps(document)


def test_openapi_money_currency_is_required_in_responses_only() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    assert schemas["Money-Output"]["required"] == ["amount", "currency"]  # T-019
    assert schemas["Money-Input"]["required"] == ["amount"]  # la entrada admite PEN por defecto
    summary_schema = schemas["ProductSummaryOut"]
    assert summary_schema["properties"]["price"] == {"$ref": "#/components/schemas/Money-Output"}
    assert set(summary_schema["required"]) == SUMMARY_KEYS  # siempre presentes, aunque null
    assert set(schemas["ProductDetailOut"]["required"]) == DETAIL_KEYS
    assert set(schemas["ProductImageOut"]["properties"]) == {"id", "url", "alt"}
