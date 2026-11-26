import json
from decimal import Decimal
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from tests.catalog.catalog_helpers import (
    AUTOMATIC,
    GOLD,
    QUANTITIES,
    QUARTZ,
    STEEL,
    all_keys,
    make_category,
    make_image,
    make_product,
)
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.domain import (
    AttributeKind,
    AttributeValue,
    Availability,
    AvailabilityStatus,
    Category,
    Pricing,
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
    "original_price",
    "discount_amount",
    "movement",
    "case_material",
    "case_diameter_mm",
    "water_resistance_m",
    "main_image",
    "availability",
}
DETAIL_KEYS = SUMMARY_KEYS | {"description", "specs", "images", "related"}
NOT_FOUND = {"error": {"code": "not_found", "message": "Producto no encontrado.", "details": None}}
IN_STOCK = Availability(AvailabilityStatus.IN_STOCK)

CATEGORY = make_category("Clásicos de prueba", description="Relojes ficticios.")


def summary(
    product: Product,
    *,
    images: int = 1,
    attributes: bool = True,
    availability: Availability = IN_STOCK,
    pricing: Pricing | None = None,
) -> ProductSummary:
    main = make_image(product, 0) if images else None
    return ProductSummary(
        product,
        CATEGORY,
        AUTOMATIC if attributes else None,
        STEEL if attributes else None,
        main,
        availability,
        pricing=pricing
        or Pricing(list_price=product.price, price=product.price, discount_amount=0),
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
        "original_price": None,  # sin promoción: los dos campos nuevos van en null (T-053)
        "discount_amount": None,
        "movement": {"code": AUTOMATIC.code, "label": AUTOMATIC.label},
        "case_material": {"code": STEEL.code, "label": STEEL.label},
        "case_diameter_mm": 38.0,
        "water_resistance_m": 50,
        "main_image": {
            "id": str(main.id),
            "url": f"{CDN}/storage/v1/object/public/products/{main.storage_path}",
            "alt": main.alt,
        },
        "availability": {"status": "in_stock", "lead_time_days": None},
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
        "available": "true",
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
            available=True,
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
    assert query.available is False  # sin el parámetro, también los agotados


@pytest.mark.parametrize(("value", "expected"), [("true", True), ("1", True), ("false", False)])
def test_available_parameter_is_a_boolean(
    client: TestClient, products: FakeProducts, value: str, expected: bool
) -> None:
    assert client.get(f"{BASE}/products", params={"available": value}).status_code == 200

    [query] = products.queries
    assert query.available is expected


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
        pytest.param({"available": "quizas"}, id="available-no-booleano"),
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


@pytest.mark.parametrize("name", ["q", "category", "movement", "case_material"])
def test_control_character_in_a_text_parameter_is_422_on_that_parameter(
    client: TestClient, name: str
) -> None:
    response = client.get(f"{BASE}/products", params={name: "texto\x1f"})

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["query", name]]


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
    low = Availability(AvailabilityStatus.LOW_STOCK)
    on_request = Availability(AvailabilityStatus.ON_REQUEST, 21)
    products.summaries[product.slug] = summary(product, availability=low)
    images = [make_image(product, 0), make_image(product, 1)]
    products.images[product.id] = images
    products.related_items = [summary(other, availability=on_request)]

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
    assert body["availability"] == {"status": "low_stock", "lead_time_days": None}
    assert related["availability"] == {"status": "on_request", "lead_time_days": 21}


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
        "available",
        "sort",
        "page",
        "page_size",
    ]
    [available] = [
        p for p in paths[f"{BASE}/products"]["get"]["parameters"] if p["name"] == "available"
    ]
    assert available["schema"]["type"] == "boolean"
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


def test_openapi_availability_is_required_with_four_states_and_no_quantities() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    ref = {"$ref": "#/components/schemas/AvailabilityOut"}
    assert schemas["ProductSummaryOut"]["properties"]["availability"] == ref
    assert schemas["ProductDetailOut"]["properties"]["availability"] == ref
    availability = schemas["AvailabilityOut"]
    fields = {"status", "lead_time_days"}
    assert set(availability["properties"]) == set(availability["required"]) == fields
    status = availability["properties"]["status"]
    assert (status["type"], status["enum"]) == ("string", [s.value for s in AvailabilityStatus])
    assert availability["properties"]["lead_time_days"]["anyOf"] == [
        {"type": "integer"},
        {"type": "null"},
    ]
    # Inventory publica su AvailabilityStatus: si otra clase compartiera el nombre, pydantic les
    # pondría la ruta del módulo (valmont__modules__…__AvailabilityStatus).
    assert not any(name.endswith("__AvailabilityStatus") for name in schemas)


def test_responses_never_carry_quantities(client: TestClient, products: FakeProducts) -> None:
    product = make_product(CATEGORY, "Heritage de prueba")
    products.summaries[product.slug] = summary(product)
    products.related_items = [summary(make_product(CATEGORY, "Otro de prueba"))]

    listing = client.get(f"{BASE}/products").json()
    detail = client.get(f"{BASE}/products/{product.slug}").json()

    for body in (listing, detail):
        assert not QUANTITIES & all_keys(body)


# --- Precio vigente con promociones (T-053, promotions SPEC §7, CA-PROMOTIONS-09) ---

MONEY_OUT = {"$ref": "#/components/schemas/Money-Output"}
DISCOUNTED = Pricing(list_price=1250000, price=1062500, discount_amount=187500)
DISCOUNTED_JSON = {
    "price": {"amount": 1062500, "currency": "PEN"},
    "original_price": {"amount": 1250000, "currency": "PEN"},
    "discount_amount": {"amount": 187500, "currency": "PEN"},
}
PRICE_KEYS = ("price", "original_price", "discount_amount")


def test_listing_shows_the_effective_price_and_the_saving_not_the_base_price(
    client: TestClient, products: FakeProducts
) -> None:
    on_sale = make_product(CATEGORY, "Heritage de prueba", price=1250000)
    regular = make_product(CATEGORY, "Sencillo de prueba", price=300000)
    products.summaries = {
        on_sale.slug: summary(on_sale, pricing=DISCOUNTED),
        regular.slug: summary(regular),
    }

    first, second = client.get(f"{BASE}/products").json()["items"]

    assert {key: first[key] for key in PRICE_KEYS} == DISCOUNTED_JSON
    assert first["discount_amount"]["amount"] == (
        first["original_price"]["amount"] - first["price"]["amount"]
    )
    assert second["price"] == {"amount": 300000, "currency": "PEN"}
    assert (second["original_price"], second["discount_amount"]) == (None, None)
    assert set(second) == SUMMARY_KEYS  # los campos viajan siempre, aunque sean null


def test_price_comes_from_pricing_even_if_the_product_base_price_differs(
    client: TestClient, products: FakeProducts
) -> None:
    product = make_product(CATEGORY, "Heritage de prueba", price=999999)
    products.summaries = {product.slug: summary(product, pricing=DISCOUNTED)}

    item = client.get(f"{BASE}/products").json()["items"][0]

    assert item["price"]["amount"] == 1062500
    assert item["original_price"]["amount"] == 1250000


def test_detail_and_related_share_the_discounted_shape(
    client: TestClient, products: FakeProducts
) -> None:
    product = make_product(CATEGORY, "Heritage de prueba", price=1250000)
    sibling = make_product(CATEGORY, "Otro de prueba", price=800000)
    plain = make_product(CATEGORY, "Sencillo de prueba", price=300000)
    products.summaries = {product.slug: summary(product, pricing=DISCOUNTED)}
    products.related_items = [
        summary(sibling, pricing=Pricing(800000, 720000, 80000)),
        summary(plain),
    ]

    body = client.get(f"{BASE}/products/{product.slug}").json()

    assert {key: body[key] for key in PRICE_KEYS} == DISCOUNTED_JSON
    assert set(body) == DETAIL_KEYS
    discounted, undiscounted = body["related"]
    assert set(discounted) == set(undiscounted) == SUMMARY_KEYS
    assert discounted["price"]["amount"] == 720000
    assert discounted["original_price"]["amount"] == 800000
    assert discounted["discount_amount"]["amount"] == 80000
    assert undiscounted["price"]["amount"] == 300000
    assert (undiscounted["original_price"], undiscounted["discount_amount"]) == (None, None)


def test_detail_without_promotion_has_the_two_fields_null(
    client: TestClient, products: FakeProducts
) -> None:
    product = make_product(CATEGORY, "Heritage de prueba", price=1250000)
    products.summaries = {product.slug: summary(product)}

    body = client.get(f"{BASE}/products/{product.slug}").json()

    assert body["price"] == {"amount": 1250000, "currency": "PEN"}
    assert (body["original_price"], body["discount_amount"]) == (None, None)


def test_public_body_never_exposes_promotion_internals(
    client: TestClient, products: FakeProducts
) -> None:
    product = make_product(CATEGORY, "Heritage de prueba", price=1250000)
    products.summaries = {product.slug: summary(product, pricing=DISCOUNTED)}
    products.related_items = [summary(product, pricing=DISCOUNTED)]

    listing = client.get(f"{BASE}/products").json()
    detail = client.get(f"{BASE}/products/{product.slug}").json()

    for body in (listing, detail):
        keys = all_keys(body)
        assert not {k for k in keys if "promotion" in k}
        assert not keys & {"kind", "scope", "percent_off", "amount_off", "starts_at", "ends_at"}
        assert not keys & {"discount_percent", "discount_type", "list_price"}
        assert "promotion" not in json.dumps(body).lower()


def test_openapi_new_price_fields_are_required_and_nullable_money() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    for name in ("ProductSummaryOut", "ProductDetailOut"):
        properties = schemas[name]["properties"]
        assert properties["price"] == MONEY_OUT  # no cambia: sigue obligatorio y no anulable
        for field in ("original_price", "discount_amount"):
            assert properties[field]["anyOf"] == [MONEY_OUT, {"type": "null"}]
            assert field in schemas[name]["required"]  # siempre presentes (CATALOG-R5)
        assert "price" in schemas[name]["required"]
