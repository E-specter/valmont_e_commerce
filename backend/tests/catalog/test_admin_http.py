"""Administración de catalog sin BD: autorización, validación de entrada y OpenAPI."""

import json
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.audit.adapters.http import get_audit_recorder
from valmont.modules.catalog.adapters import http
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role

ADMIN, CUSTOMER = uuid4(), uuid4()
BASE = "/api/v1/catalog/admin"
ANY_ID = str(uuid4())
VALID_PRODUCT = {
    "sku": "TST-001",
    "name": "Reloj de prueba",
    "description": "",
    "category_id": ANY_ID,
    "price": {"amount": 100000},
    "order_policy": "stock",
    "specs": [],
}
ROUTES = [
    ("GET", "/products", None),
    ("GET", f"/products/{ANY_ID}", None),
    ("POST", "/products", VALID_PRODUCT),
    ("PATCH", f"/products/{ANY_ID}", {"name": "Otro"}),
    ("POST", f"/products/{ANY_ID}/publish", None),
    ("POST", f"/products/{ANY_ID}/unpublish", None),
    ("GET", "/categories", None),
    ("POST", "/categories", {"name": "Pruebas"}),
    ("PATCH", f"/categories/{ANY_ID}", {"name": "Otra"}),
    ("GET", "/attributes", None),
    ("POST", "/movement-types", {"code": "prueba", "label": "Prueba"}),
    ("PATCH", "/movement-types/prueba", {"label": "Otra"}),
    ("POST", "/case-materials", {"code": "prueba", "label": "Prueba"}),
    ("PATCH", "/case-materials/prueba", {"label": "Otra"}),
]


class Untouchable:
    """Repositorio que falla si se usa: las respuestas de esta prueba no llegan a él."""

    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"no debía llamarse a {name}")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    profiles = InMemoryProfiles()
    for user_id, role in ((ADMIN, Role.ADMIN), (CUSTOMER, Role.CUSTOMER)):
        profiles.rows[user_id] = replace(Profile(user_id, Role.CUSTOMER, T0, T0), role=role)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    for dependency in (
        http.get_product_repository,
        http.get_category_repository,
        http.get_attribute_repository,
        get_audit_recorder,
    ):
        app.dependency_overrides[dependency] = Untouchable
    return TestClient(app, raise_server_exceptions=False)


def call(client: TestClient, method: str, path: str, body: object, user: UUID | None) -> object:
    headers = {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}
    return client.request(method, f"{BASE}{path}", json=body, headers=headers)


@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
def test_every_admin_route_requires_a_token(
    client: TestClient, method: str, path: str, body: object
) -> None:
    response = call(client, method, path, body, user=None)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
def test_every_admin_route_rejects_a_customer_with_403(
    client: TestClient, method: str, path: str, body: object
) -> None:
    response = call(client, method, path, body, user=CUSTOMER)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"status": "published"}, id="status"),  # campo extra
        pytest.param({"id": ANY_ID}, id="id"),
        pytest.param({"price": {"amount": -1}}, id="precio-negativo"),
        pytest.param({"price": {"amount": 1.5}}, id="precio-decimal"),
        pytest.param({"price": {"amount": 2**31}}, id="precio-mayor-que-integer"),
        pytest.param({"price": {"amount": 1, "currency": "USD"}}, id="usd"),
        pytest.param({"price": 100000}, id="precio-sin-money"),
        pytest.param({"sku": "  "}, id="sku-vacio"),
        pytest.param({"sku": "S" * 41}, id="sku-largo"),
        pytest.param({"name": "n" * 121}, id="nombre-largo"),
        pytest.param({"description": "d" * 5001}, id="descripcion-larga"),
        pytest.param({"description": "con\ttabulador"}, id="descripcion-tab"),
        pytest.param({"slug": "Con Mayusculas"}, id="slug"),
        pytest.param({"movement_code": "Automático"}, id="codigo"),
        pytest.param({"order_policy": "preorder"}, id="politica"),
        pytest.param({"lead_time_days": 0}, id="plazo-0"),
        pytest.param({"lead_time_days": "30"}, id="plazo-texto"),
        pytest.param({"case_diameter_mm": 38.25}, id="diametro-dos-decimales"),
        pytest.param({"case_diameter_mm": 0}, id="diametro-0"),
        pytest.param({"case_diameter_mm": 1000}, id="diametro-grande"),
        pytest.param({"water_resistance_m": -1}, id="resistencia-negativa"),
        pytest.param({"category_id": "no-uuid"}, id="categoria-no-uuid"),
        pytest.param(
            {"specs": [{"label": "Cristal", "value": "a"}, {"label": "CRISTAL", "value": "b"}]},
            id="specs-repetidas",
        ),
        pytest.param({"specs": [{"label": "x" * 61, "value": "a"}]}, id="spec-larga"),
        pytest.param({"specs": [{"label": "a", "value": "b", "extra": 1}]}, id="spec-extra"),
    ],
)
def test_create_product_rejects_invalid_bodies_with_422(
    client: TestClient, changes: dict[str, object]
) -> None:
    response = call(client, "POST", "/products", VALID_PRODUCT | changes, user=ADMIN)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    [field] = changes
    assert [detail["loc"][:2] for detail in error["details"]] == [["body", field]]


@pytest.mark.parametrize("field", ["sku", "name", "category_id", "price", "order_policy", "specs"])
def test_create_product_requires_the_contract_fields(client: TestClient, field: str) -> None:
    body = {k: v for k, v in VALID_PRODUCT.items() if k != field}

    assert call(client, "POST", "/products", body, user=ADMIN).status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"status": "published"},
        {"published_at": "2026-10-01T00:00:00Z"},
        {"sku": None},
        {"name": None},
        {"price": None},
        {"specs": None},
        {"slug": None},
        {"order_policy": None},
    ],
)
def test_patch_product_rejects_extra_fields_and_null_on_required_ones(
    client: TestClient, body: dict[str, object]
) -> None:
    assert call(client, "PATCH", f"/products/{ANY_ID}", body, user=ADMIN).status_code == 422


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/categories", {"name": "c" * 61}),
        ("/categories", {"name": "Pruebas", "description": "d" * 501}),
        ("/categories", {"name": "Pruebas", "is_active": "no"}),
        ("/categories", {"name": "Pruebas", "id": ANY_ID}),
        ("/movement-types", {"code": "Con Espacio", "label": "Prueba"}),
        ("/movement-types", {"code": "c" * 61, "label": "Prueba"}),
        ("/case-materials", {"code": "acero", "label": "l" * 61}),
    ],
)
def test_category_and_attribute_bodies_are_validated(
    client: TestClient, path: str, body: dict[str, object]
) -> None:
    assert call(client, "POST", path, body, user=ADMIN).status_code == 422


@pytest.mark.parametrize("path", ["/movement-types/Mal%20Formado", "/case-materials/con%00nul"])
def test_malformed_code_in_the_path_is_404(client: TestClient, path: str) -> None:
    response = call(client, "PATCH", path, {"label": "Otra"}, user=ADMIN)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_patch_attribute_value_cannot_change_its_code(client: TestClient) -> None:
    response = call(client, "PATCH", "/movement-types/prueba", {"code": "otro"}, user=ADMIN)

    assert response.status_code == 422


def test_openapi_declares_admin_errors_with_the_common_format() -> None:
    document = create_app().openapi()
    admin = {path: ops for path, ops in document["paths"].items() if "/catalog/admin" in path}
    routes = {
        (method.upper(), path.removeprefix(BASE)) for path, ops in admin.items() for method in ops
    }

    assert len(routes) == len(ROUTES)
    for operations in admin.values():
        for operation in operations.values():
            assert {"401", "403"} <= set(operation["responses"])
            for status, response in operation["responses"].items():
                if not status.startswith("2"):
                    schema = response["content"]["application/json"]["schema"]
                    assert schema == {"$ref": "#/components/schemas/ErrorOut"}
    assert set(admin[f"{BASE}/products"]["post"]["responses"]) >= {"201", "409", "422"}
    assert set(admin[f"{BASE}/products/{{product_id}}/publish"]["post"]["responses"]) >= {
        "404",
        "409",
    }
    assert "HTTPValidationError" not in json.dumps(document)
    schemas = document["components"]["schemas"]
    assert "status" not in schemas["ProductCreateIn"]["properties"]
    assert schemas["AdminProductOut"]["properties"]["price"] == {
        "$ref": "#/components/schemas/Money-Output"
    }


@pytest.mark.parametrize(
    ("path", "body"),
    [("/products", VALID_PRODUCT | {"name": "¡¡!!"}), ("/categories", {"name": "¡¡!!"})],
)
def test_name_that_cannot_give_a_slug_is_422_on_name(
    client: TestClient, path: str, body: dict[str, object]
) -> None:
    # M-4: sin slug se genera del nombre; el error va en el campo que lo causa.
    response = call(client, "POST", path, body, user=ADMIN)

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["body", "name"]]


def test_control_character_in_admin_search_is_422_on_q(client: TestClient) -> None:
    headers = {"Authorization": f"Bearer {make_token(str(ADMIN))}"}

    response = client.get(f"{BASE}/products", params={"q": "reloj\x00"}, headers=headers)

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["query", "q"]]


CONFLICT_CODES = {
    "sku_taken",
    "slug_taken",
    "slug_locked",
    "publish_requirements_unmet",
    "category_in_use",
    "code_taken",
}


@pytest.mark.parametrize(
    ("method", "path", "codes"),
    [
        ("post", "/products", {"sku_taken", "slug_taken"}),
        (
            "patch",
            "/products/{product_id}",
            {"sku_taken", "slug_taken", "slug_locked", "publish_requirements_unmet"},
        ),
        ("post", "/products/{product_id}/publish", {"publish_requirements_unmet"}),
        ("post", "/categories", {"slug_taken"}),
        ("patch", "/categories/{category_id}", {"slug_taken", "category_in_use"}),
        ("post", "/movement-types", {"code_taken"}),
        ("post", "/case-materials", {"code_taken"}),
    ],
)
def test_each_409_lists_only_the_codes_of_its_route(
    method: str, path: str, codes: set[str]
) -> None:
    # M-5: cada ruta describe solo los códigos 409 que puede devolver.
    responses = create_app().openapi()["paths"][f"{BASE}{path}"][method]["responses"]
    description = responses["409"]["description"]

    assert {code for code in CONFLICT_CODES if f"`{code}`" in description} == codes


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/products/{product_id}/unpublish"), ("patch", "/movement-types/{code}")],
)
def test_routes_that_cannot_conflict_declare_no_409(method: str, path: str) -> None:
    responses = create_app().openapi()["paths"][f"{BASE}{path}"][method]["responses"]

    assert "409" not in responses
