"""`GET /api/v1/cart` sin BD: autenticación, forma del contrato y OpenAPI (T-057; CA-CART-11 en
su parte de 401 y CA-CART-16 para `GET`, SPEC §7). La sesión falla si se toca: ninguna de estas
respuestas debe llegar a la BD."""

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

PATH = "/api/v1/cart"
ITEM_KEYS = {
    "product_id",
    "sku",
    "slug",
    "name",
    "image",
    "quantity",
    "selected",
    "status",
    "availability",
    "max_quantity",
    "unit_price",
    "original_price",
    "discount_amount",
    "subtotal",
}
NULLABLE_ITEM_KEYS = {
    "sku",
    "image",
    "availability",
    "unit_price",
    "original_price",
    "discount_amount",
    "subtotal",
}
CART_KEYS = {"items", "item_count", "selected_count", "total", "can_checkout"}


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


def assert_unauthenticated(response: Any) -> None:
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == "unauthenticated"
    assert set(body) == {"error"}
    assert "Traceback" not in response.text


# CA-CART-01 / CA-CART-11: sin token → 401
def test_without_a_token_the_cart_is_401(client: TestClient) -> None:
    assert_unauthenticated(client.get(PATH))


@pytest.mark.parametrize(
    "authorization",
    ["", "Bearer", "Bearer basura", "Basic abc", "Bearer a.b.c", f"Bearer {'x' * 10}.{'y' * 10}.z"],
)
def test_a_malformed_authorization_header_is_401(client: TestClient, authorization: str) -> None:
    assert_unauthenticated(client.get(PATH, headers={"Authorization": authorization}))


def test_a_token_signed_with_another_key_is_401(client: TestClient) -> None:
    token = make_token(str(uuid4()), key=OTHER_KEY)

    assert_unauthenticated(client.get(PATH, headers={"Authorization": f"Bearer {token}"}))


def test_an_expired_token_is_401(client: TestClient) -> None:
    token = make_token(str(uuid4()), exp=1)

    assert_unauthenticated(client.get(PATH, headers={"Authorization": f"Bearer {token}"}))


# RN-10: no hay forma de nombrar el carrito ajeno
@pytest.mark.parametrize("path", [f"{PATH}/{uuid4()}", f"{PATH}/user/{uuid4()}"])
def test_there_is_no_route_to_read_a_cart_by_id(client: TestClient, path: str) -> None:
    token = make_token(str(uuid4()))

    response = client.get(path, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code in (404, 405)


def test_the_openapi_get_has_no_user_or_cart_id_parameter() -> None:
    operation = create_app().openapi()["paths"][PATH]["get"]

    assert operation.get("parameters", []) == []
    assert "requestBody" not in operation


# CA-CART-16
def test_openapi_declares_get_cart_with_its_statuses_and_error_schema() -> None:
    document = create_app().openapi()
    operation = document["paths"][PATH]["get"]

    assert {"200", "401", "503"} <= set(operation["responses"])
    ok = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert ok == {"$ref": "#/components/schemas/CartOut"}
    for status in ("401", "503"):
        schema = operation["responses"][status]["content"]["application/json"]["schema"]
        assert schema == {"$ref": "#/components/schemas/ErrorOut"}
    assert operation.get("security"), "la ruta exige el esquema bearer"
    assert "HTTPValidationError" not in str(document["paths"][PATH])


def nullable(prop: dict[str, Any]) -> bool:
    return any(option.get("type") == "null" for option in prop.get("anyOf", []))


def test_openapi_cart_out_matches_spec_7() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    cart = schemas["CartOut"]
    assert set(cart["required"]) == CART_KEYS
    assert set(cart["properties"]) == CART_KEYS
    assert cart["properties"]["items"]["items"] == {"$ref": "#/components/schemas/CartItemOut"}
    assert not nullable(cart["properties"]["total"])

    item = schemas["CartItemOut"]
    assert set(item["properties"]) == ITEM_KEYS
    assert set(item["required"]) == ITEM_KEYS  # siempre presentes, con null si no aplican
    for key in ITEM_KEYS:
        assert nullable(item["properties"][key]) == (key in NULLABLE_ITEM_KEYS), key


def test_openapi_status_is_the_closed_set_of_spec_r7() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    status = schemas["CartItemOut"]["properties"]["status"]
    enum = status.get("enum") or schemas[status["$ref"].rsplit("/", 1)[1]]["enum"]

    assert set(enum) == {"ok", "insufficient_stock", "out_of_stock", "unavailable"}


def test_openapi_availability_status_is_the_catalog_vocabulary() -> None:
    document = create_app().openapi()
    schemas = document["components"]["schemas"]
    availability = schemas["CartItemOut"]["properties"]["availability"]
    ref = next(o["$ref"] for o in availability["anyOf"] if "$ref" in o)
    body = schemas[ref.rsplit("/", 1)[1]]

    assert set(body["properties"]) == {"status", "lead_time_days"}
    assert set(body["properties"]["status"]["enum"]) == {
        "in_stock",
        "low_stock",
        "out_of_stock",
        "on_request",
    }


def test_openapi_money_is_integer_cents_with_currency() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    money = next(
        s for name, s in schemas.items() if name.startswith("Money") and "amount" in s["properties"]
    )

    assert money["properties"]["amount"]["type"] == "integer"
    currency = money["properties"]["currency"]
    assert currency.get("enum", [currency.get("const")]) == ["PEN"]
