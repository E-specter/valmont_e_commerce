"""`POST/PATCH/DELETE /api/v1/cart/items` sin BD: 401 y OpenAPI (T-058; CA-CART-11 en su parte de
401 y CA-CART-16 para las tres rutas, SPEC §7). La sesión falla si se toca: la autenticación
precede a la validación y a la BD."""

import json
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from tests.identity.identity_helpers import (
    OTHER_KEY,
    InMemoryProfiles,
    make_token,
    use_test_auth,
)
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.shared.db import get_session

ITEMS = "/api/v1/cart/items"
ITEM = "/api/v1/cart/items/{product_id}"
OTHER = uuid4()


class Untouchable:
    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"no debía llamarse a {name}")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = InMemoryProfiles
    app.dependency_overrides[get_session] = Untouchable
    return TestClient(app, raise_server_exceptions=False)


def calls(client: TestClient, headers: dict[str, str], body: Any = None) -> list[Any]:
    """Las tres rutas de escritura con la misma cabecera y, si hay cuerpo, el mismo cuerpo."""
    item = f"{ITEMS}/{OTHER}"
    return [
        client.post(ITEMS, headers=headers, json=body),
        client.patch(item, headers=headers, json=body),
        client.delete(item, headers=headers),
    ]


def assert_unauthenticated(response: Any) -> None:
    assert response.status_code == 401
    body = response.json()
    assert set(body) == {"error"} and body["error"]["code"] == "unauthenticated"
    assert "Traceback" not in response.text


# CA-CART-11: sin token → 401 en las rutas de escritura
def test_without_a_token_every_write_route_is_401(client: TestClient) -> None:
    for response in calls(client, {}, {"product_id": str(OTHER), "quantity": 1}):
        assert_unauthenticated(response)


@pytest.mark.parametrize("authorization", ["Bearer", "Bearer basura", "Basic abc", "Bearer a.b.c"])
def test_a_malformed_authorization_header_is_401(client: TestClient, authorization: str) -> None:
    for response in calls(client, {"Authorization": authorization}, {"quantity": 1}):
        assert_unauthenticated(response)


def test_a_token_signed_with_another_key_or_expired_is_401(client: TestClient) -> None:
    for token in (make_token(str(uuid4()), key=OTHER_KEY), make_token(str(uuid4()), exp=1)):
        for response in calls(client, {"Authorization": f"Bearer {token}"}, {"quantity": 1}):
            assert_unauthenticated(response)


def test_authentication_comes_before_validation(client: TestClient) -> None:
    # Un cuerpo inválido sin token es 401, no 422: nada del cuerpo se revela a un visitante.
    for response in calls(client, {}, {"user_id": str(OTHER), "quantity": 0}):
        assert_unauthenticated(response)
    assert_unauthenticated(client.delete(f"{ITEMS}/no-es-un-uuid"))


# CA-CART-16
def operation(method: str, path: str) -> dict[str, Any]:
    return create_app().openapi()["paths"][path][method]


def schema_of(response: dict[str, Any]) -> Any:
    return response["content"]["application/json"]["schema"]


def resolve(name: str) -> dict[str, Any]:
    return create_app().openapi()["components"]["schemas"][name]


@pytest.mark.parametrize(
    ("method", "path", "statuses"),
    [
        ("post", ITEMS, {"200", "401", "409", "422", "503"}),
        ("patch", ITEM, {"200", "401", "404", "409", "422", "503"}),
        ("delete", ITEM, {"200", "401", "422", "503"}),
    ],
)
def test_openapi_declares_statuses_and_error_schema(
    method: str, path: str, statuses: set[str]
) -> None:
    op = operation(method, path)

    assert statuses <= set(op["responses"])
    assert schema_of(op["responses"]["200"]) == {"$ref": "#/components/schemas/CartOut"}
    for status in statuses - {"200"}:
        assert schema_of(op["responses"][status]) == {"$ref": "#/components/schemas/ErrorOut"}
    assert op.get("security"), "la ruta exige el esquema bearer"
    assert "HTTPValidationError" not in json.dumps(op)


def test_openapi_does_not_declare_statuses_the_spec_does_not_have() -> None:
    # DELETE es idempotente (sin 404 ni 409); POST no tiene artículo de ruta (sin 404).
    assert not {"404", "409"} & set(operation("delete", ITEM)["responses"])
    assert "404" not in operation("post", ITEMS)["responses"]


def test_openapi_bodies_and_path_parameters() -> None:
    post, patch, delete = (
        operation("post", ITEMS),
        operation("patch", ITEM),
        operation("delete", ITEM),
    )

    assert schema_of(post["requestBody"]) == {"$ref": "#/components/schemas/CartItemIn"}
    assert schema_of(patch["requestBody"]) == {"$ref": "#/components/schemas/CartItemUpdateIn"}
    assert "requestBody" not in delete
    assert post.get("parameters", []) == []
    for op in (patch, delete):
        [param] = op["parameters"]
        assert (param["name"], param["in"], param["required"]) == ("product_id", "path", True)
        assert param["schema"]["format"] == "uuid"


def test_openapi_inputs_accept_only_the_spec_fields_and_no_amounts() -> None:
    item_in, update_in = resolve("CartItemIn"), resolve("CartItemUpdateIn")

    assert set(item_in["properties"]) == {"product_id", "quantity"}
    assert item_in["required"] == ["product_id"]
    assert set(update_in["properties"]) == {"quantity", "selected"}
    assert not update_in.get("required")
    for body in (item_in, update_in):
        assert body.get("additionalProperties") is False  # un campo extra → 422
        assert not {"user_id", "cart_id", "price", "unit_price", "total"} & set(body["properties"])
    quantity = json.dumps(item_in["properties"]["quantity"])
    assert '"minimum": 1' in quantity and '"maximum": 5' in quantity
    assert "integer" in quantity
