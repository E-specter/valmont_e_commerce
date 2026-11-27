"""Límites de longitud declarados en el OpenAPI (T-018e, RNF10; STATUS de hardening). Sin BD.

1. Recorrido: todo `string` de un cuerpo o parámetro sin `format`, `enum`, `const` ni `pattern`
   declara `maxLength`, y toda lista de entrada declara `maxItems`, salvo las excepciones.
2. Tabla: cada tope es el valor de su constante de dominio (nunca un literal copiado). En orders
   los límites son literales de `DeliveryDetails` (no hay constante): se fijan aquí.
3. No regresión: el tope solo se declara; no valida antes de normalizar, así que un texto con
   espacios que recortado cabe sigue aceptándose y uno que no cabe da el mismo 422 de siempre."""

from dataclasses import replace
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from tests.identity.identity_helpers import (
    T0,
    InMemoryProfiles,
    make_token,
    use_test_auth,
)
from valmont.main import create_app
from valmont.modules.catalog import domain as catalog
from valmont.modules.identity import domain as identity
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.modules.inventory import domain as inventory
from valmont.modules.orders.domain import OrderStatus
from valmont.modules.promotions import domain as promotions

HTTP_METHODS = ("get", "post", "put", "patch", "delete")
CATALOG = "/api/v1/catalog"
ADMIN = f"{CATALOG}/admin"

# Excepciones del paquete T-018e (y su ampliación a orders, autorizada por el Leader):
# `file` es binario; los diámetros son Decimal (anyOf). Los esquemas de respuesta no se recorren.
EXCEPTIONS = {"file", "case_diameter_mm", "case_diameter_mm_min", "case_diameter_mm_max"}
# Lista exceptuada por el Leader: el caso de uso exige el conjunto exacto de imágenes del producto
# (acotado por los datos) y T-018a limita el cuerpo a 256 KiB; no se declara un tope sin validar.
LIST_EXCEPTIONS = {"PUT /api/v1/catalog/admin/products/{product_id}/images/order body"}
# Literales sin constante de dominio (identity: teléfono "+" y 15 dígitos; fecha ISO).
PHONE_MAX = 16
BIRTH_DATE_MAX = 10
# Literales de `orders.domain.DeliveryDetails` (no son constantes allí).
RECIPIENT_NAME_MAX, LOCATION_MAX, ADDRESS_MAX = 80, 40, 150


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    return create_app().openapi()


# --------------------------------------------------------------------------------------------
# Recorrido del OpenAPI (solo lo que entra: parámetros y cuerpos)


def _schemas(spec: dict[str, Any]) -> dict[str, Any]:
    return spec["components"]["schemas"]


def _walk(
    spec: dict[str, Any], node: dict[str, Any], path: str, out: list[tuple[str, dict]]
) -> None:
    schemas, seen = _schemas(spec), set()

    def visit(n: dict[str, Any], where: str) -> None:
        if "$ref" in n:
            name = n["$ref"].rsplit("/", 1)[-1]
            if name not in seen:
                seen.add(name)
                visit(schemas[name], name)
                seen.discard(name)
            return
        for key in ("anyOf", "oneOf", "allOf"):
            for branch in n.get(key, []):
                visit(branch, where)
        kind = n.get("type")
        if kind == "object":
            for field, sub in n.get("properties", {}).items():
                visit(sub, f"{where}.{field}")
            extra = n.get("additionalProperties")
            if isinstance(extra, dict):
                visit(extra, f"{where}.*")
        elif kind == "array":
            out.append((where, n))
            visit(n.get("items", {}), f"{where}[]")
        elif kind == "string":
            out.append((where, n))

    visit(node, path)


def request_nodes(spec: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """(ubicación, nodo `string` o `array`) de todos los parámetros y cuerpos de la API."""
    found: list[tuple[str, dict[str, Any]]] = []
    for url, item in spec["paths"].items():
        for method, operation in item.items():
            if method not in HTTP_METHODS:
                continue
            where = f"{method.upper()} {url}"
            for param in operation.get("parameters", []):
                _walk(spec, param["schema"], f"{where} {param['in']}:{param['name']}", found)
            for content in operation.get("requestBody", {}).get("content", {}).values():
                _walk(spec, content["schema"], f"{where} body", found)
    return found


def is_excepted(where: str) -> bool:
    return where.replace("[]", "").replace(":", ".").rsplit(".", 1)[-1] in EXCEPTIONS


def needs_limit(node: dict[str, Any]) -> bool:
    if node.get("type") == "array":
        return True
    return not any(key in node for key in ("format", "enum", "const", "pattern"))


def test_every_request_string_and_list_declares_its_limit(spec: dict[str, Any]) -> None:
    missing: list[str] = []
    for where, node in request_nodes(spec):
        if is_excepted(where) or where in LIST_EXCEPTIONS or not needs_limit(node):
            continue
        key = "maxItems" if node["type"] == "array" else "maxLength"
        if node.get(key) is None:
            missing.append(f"{where} ({key})")

    assert not missing, "campos de entrada sin tope en el OpenAPI:\n" + "\n".join(sorted(missing))


def test_the_list_exception_still_exists_in_the_openapi(spec: dict[str, Any]) -> None:
    lists = {where for where, node in request_nodes(spec) if node.get("type") == "array"}

    assert LIST_EXCEPTIONS <= lists


def test_the_exceptions_still_exist_in_the_openapi(spec: dict[str, Any]) -> None:
    """La lista de excepciones no puede quedarse con nombres que ya no existen."""
    names = {
        where.replace("[]", "").replace(":", ".").rsplit(".", 1)[-1]
        for where, _ in request_nodes(spec)
    }

    assert EXCEPTIONS & names == {
        "file",
        "case_diameter_mm",
        "case_diameter_mm_min",
        "case_diameter_mm_max",
    }


# --------------------------------------------------------------------------------------------
# Cada tope sale de su constante


def _limit(node: dict[str, Any], key: str) -> Any:
    """El valor de `key` en el nodo o en alguna rama de su `anyOf` (campos opcionales)."""
    if key in node:
        return node[key]
    for branch in node.get("anyOf", []):
        if branch.get(key) is not None:
            return branch[key]
    return None


def _property(spec: dict[str, Any], schema: str, field: str) -> dict[str, Any]:
    return _schemas(spec)[schema]["properties"][field]


def _parameter(spec: dict[str, Any], method: str, url: str, name: str) -> dict[str, Any]:
    [param] = [p for p in spec["paths"][url][method]["parameters"] if p["name"] == name]
    return param["schema"]


BODY_STRINGS = [
    ("ProductCreateIn", "sku", catalog.SKU_MAX),
    ("ProductCreateIn", "slug", catalog.SLUG_MAX),
    ("ProductCreateIn", "name", catalog.NAME_MAX),
    ("ProductCreateIn", "description", catalog.DESCRIPTION_MAX),
    ("ProductCreateIn", "movement_code", catalog.SLUG_MAX),
    ("ProductCreateIn", "case_material_code", catalog.SLUG_MAX),
    ("ProductUpdateIn", "sku", catalog.SKU_MAX),
    ("ProductUpdateIn", "slug", catalog.SLUG_MAX),
    ("ProductUpdateIn", "name", catalog.NAME_MAX),
    ("ProductUpdateIn", "description", catalog.DESCRIPTION_MAX),
    ("ProductUpdateIn", "movement_code", catalog.SLUG_MAX),
    ("ProductUpdateIn", "case_material_code", catalog.SLUG_MAX),
    ("SpecIn", "label", catalog.SPEC_LABEL_MAX),
    ("SpecIn", "value", catalog.SPEC_VALUE_MAX),
    ("CategoryIn", "slug", catalog.SLUG_MAX),
    ("CategoryIn", "name", catalog.CATEGORY_NAME_MAX),
    ("CategoryIn", "description", catalog.CATEGORY_DESCRIPTION_MAX),
    ("CategoryUpdateIn", "slug", catalog.SLUG_MAX),
    ("CategoryUpdateIn", "name", catalog.CATEGORY_NAME_MAX),
    ("CategoryUpdateIn", "description", catalog.CATEGORY_DESCRIPTION_MAX),
    ("AttributeValueIn", "code", catalog.SLUG_MAX),
    ("AttributeValueIn", "label", catalog.LABEL_MAX),
    ("AttributeValueUpdateIn", "label", catalog.LABEL_MAX),
    ("ImageUpdateIn", "alt", catalog.ALT_MAX),
    ("ProfileUpdateIn", "full_name", identity.FULL_NAME_MAX),
    ("ProfileUpdateIn", "phone", PHONE_MAX),
    ("ProfileUpdateIn", "accept_privacy_version", identity.PRIVACY_VERSION_MAX),
    ("ProfileUpdateIn", "birth_date", BIRTH_DATE_MAX),
    ("PreferencesIn", "style", identity.SHORT_TEXT_MAX),
    ("MovementIn", "note", inventory.NOTE_MAX),
    ("PromotionIn", "name", promotions.NAME_MAX),
    ("PromotionUpdateIn", "name", promotions.NAME_MAX),
    ("ShippingIn", "recipient_name", RECIPIENT_NAME_MAX),
    ("ShippingIn", "phone", PHONE_MAX),
    ("ShippingIn", "department", LOCATION_MAX),
    ("ShippingIn", "province", LOCATION_MAX),
    ("ShippingIn", "district", LOCATION_MAX),
    ("ShippingIn", "address_line", ADDRESS_MAX),
    ("ShippingIn", "reference", ADDRESS_MAX),
    ("PickupIn", "recipient_name", RECIPIENT_NAME_MAX),
    ("PickupIn", "phone", PHONE_MAX),
]


@pytest.mark.parametrize(
    ("schema", "field", "expected"), BODY_STRINGS, ids=[f"{s}.{f}" for s, f, _ in BODY_STRINGS]
)
def test_a_body_string_declares_the_limit_of_its_domain_constant(
    spec: dict[str, Any], schema: str, field: str, expected: int
) -> None:
    assert _limit(_property(spec, schema, field), "maxLength") == expected


BODY_LISTS = [
    ("ProductCreateIn", "specs", catalog.SPECS_MAX),
    ("ProductUpdateIn", "specs", catalog.SPECS_MAX),
    ("PreferencesIn", "materials", identity.MATERIALS_MAX),
    ("PromotionIn", "product_ids", promotions.PRODUCTS_MAX),
    ("PromotionUpdateIn", "product_ids", promotions.PRODUCTS_MAX),
]


@pytest.mark.parametrize(
    ("schema", "field", "expected"), BODY_LISTS, ids=[f"{s}.{f}" for s, f, _ in BODY_LISTS]
)
def test_a_body_list_declares_the_limit_of_its_domain_constant(
    spec: dict[str, Any], schema: str, field: str, expected: int
) -> None:
    assert _limit(_property(spec, schema, field), "maxItems") == expected


def test_each_preference_material_declares_the_short_text_limit(spec: dict[str, Any]) -> None:
    materials = _property(spec, "PreferencesIn", "materials")
    items = _limit(materials, "items")

    assert _limit(items, "maxLength") == identity.SHORT_TEXT_MAX


def test_the_image_form_alt_declares_the_alt_limit(spec: dict[str, Any]) -> None:
    [form] = [name for name in _schemas(spec) if name.startswith("Body_upload_image")]

    assert _limit(_property(spec, form, "alt"), "maxLength") == catalog.ALT_MAX


PARAMETERS = [
    ("get", f"{CATALOG}/products", "category", catalog.SLUG_MAX),
    ("get", f"{CATALOG}/products", "movement", catalog.SLUG_MAX),
    ("get", f"{CATALOG}/products", "case_material", catalog.SLUG_MAX),
    ("get", f"{CATALOG}/products/{{slug}}", "slug", catalog.SLUG_MAX),
    ("patch", f"{ADMIN}/movement-types/{{code}}", "code", catalog.SLUG_MAX),
    ("patch", f"{ADMIN}/case-materials/{{code}}", "code", catalog.SLUG_MAX),
]


@pytest.mark.parametrize(
    ("method", "url", "name", "expected"),
    PARAMETERS,
    ids=[f"{m} {u} {n}" for m, u, n, _ in PARAMETERS],
)
def test_a_parameter_declares_the_limit_of_its_domain_constant(
    spec: dict[str, Any], method: str, url: str, name: str, expected: int
) -> None:
    assert _limit(_parameter(spec, method, url, name), "maxLength") == expected


def test_the_orders_status_filter_declares_a_list_limit_that_fits_every_status(
    spec: dict[str, Any],
) -> None:
    node = _parameter(spec, "get", "/api/v1/orders", "status")

    assert _limit(node, "maxItems") >= len(OrderStatus)


# --------------------------------------------------------------------------------------------
# Sin cambio de comportamiento: se declara, no se valida antes de normalizar


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    user = uuid4()
    profiles = InMemoryProfiles()
    profiles.rows[user] = replace(Profile(user, Role.CUSTOMER, T0, T0), role=Role.CUSTOMER)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    test_client = TestClient(app, raise_server_exceptions=False)
    test_client.headers["Authorization"] = f"Bearer {make_token(str(user))}"
    return test_client


ME = "/api/v1/identity/me"


def test_a_name_over_the_declared_limit_that_fits_once_trimmed_is_still_accepted(
    client: TestClient,
) -> None:
    padded = " " * 5 + "a" * identity.FULL_NAME_MAX + " " * 5  # 130 > 120 antes de recortar

    response = client.patch(ME, json={"full_name": padded})

    assert len(padded) > identity.FULL_NAME_MAX
    assert response.status_code == 200, response.text
    assert response.json()["full_name"] == "a" * identity.FULL_NAME_MAX


def test_a_name_that_is_too_long_even_trimmed_gives_the_same_422_as_before(
    client: TestClient,
) -> None:
    response = client.patch(ME, json={"full_name": "a" * (identity.FULL_NAME_MAX + 1)})

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [str(p).lower() for p in error["details"][0]["loc"]][:2] == ["body", "full_name"]


def test_a_spaced_phone_over_the_declared_limit_is_still_accepted(client: TestClient) -> None:
    spaced = "+51   987   654   321   "  # 24 > 16 antes de quitar los espacios

    response = client.patch(ME, json={"phone": spaced})

    assert len(spaced) > PHONE_MAX
    assert response.status_code == 200, response.text
    assert response.json()["phone"] == "+51987654321"


def test_a_style_over_the_declared_limit_that_fits_once_trimmed_is_still_accepted(
    client: TestClient,
) -> None:
    padded = " " * 10 + "a" * identity.SHORT_TEXT_MAX + " " * 10

    response = client.patch(ME, json={"preferences": {"style": padded}})

    assert response.status_code == 200, response.text
    assert response.json()["preferences"]["style"] == "a" * identity.SHORT_TEXT_MAX
