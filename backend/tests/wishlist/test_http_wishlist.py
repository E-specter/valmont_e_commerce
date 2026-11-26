"""Rutas de wishlist sin BD: autenticación, ausencia de rutas por id ajeno y OpenAPI contra la SPEC
§7 (T-067 y T-068; CA-WISH-09 en su parte de 401 y CA-WISH-11). La sesión falla si se toca: ninguna
de estas respuestas debe llegar a la BD."""

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

PATH = "/api/v1/wishlist"
ITEMS = f"{PATH}/items"
ITEM = f"{ITEMS}/{{product_id}}"
ITEM_KEYS = {
    "product_id",
    "sku",
    "slug",
    "name",
    "status",
    "added_at",
    "image",
    "availability",
    "unit_price",
    "original_price",
    "discount_amount",
}
NULLABLE_ITEM_KEYS = {
    "sku",
    "image",
    "availability",
    "unit_price",
    "original_price",
    "discount_amount",
}
LIST_KEYS = {"items", "item_count", "max_items"}


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


def call(client: TestClient, method: str, headers: dict[str, str] | None = None) -> Any:
    product = str(uuid4())
    if method == "get":
        return client.get(PATH, headers=headers)
    if method == "post":
        return client.post(ITEMS, headers=headers, json={"product_id": product})
    return client.delete(f"{ITEMS}/{product}", headers=headers)


# CA-WISH-09: sin token → 401 en las tres rutas
@pytest.mark.parametrize("method", ["get", "post", "delete"])
def test_without_a_token_every_route_is_401(client: TestClient, method: str) -> None:
    assert_unauthenticated(call(client, method))


@pytest.mark.parametrize("method", ["get", "post", "delete"])
@pytest.mark.parametrize(
    "authorization",
    ["", "Bearer", "Bearer basura", "Basic abc", "Bearer a.b.c", f"Bearer {'x' * 10}.{'y' * 10}.z"],
)
def test_a_malformed_authorization_header_is_401(
    client: TestClient, method: str, authorization: str
) -> None:
    assert_unauthenticated(call(client, method, {"Authorization": authorization}))


@pytest.mark.parametrize("method", ["get", "post", "delete"])
def test_a_token_signed_with_another_key_is_401(client: TestClient, method: str) -> None:
    token = make_token(str(uuid4()), key=OTHER_KEY)

    assert_unauthenticated(call(client, method, {"Authorization": f"Bearer {token}"}))


@pytest.mark.parametrize("method", ["get", "post", "delete"])
def test_an_expired_token_is_401(client: TestClient, method: str) -> None:
    token = make_token(str(uuid4()), exp=1)

    assert_unauthenticated(call(client, method, {"Authorization": f"Bearer {token}"}))


def test_without_a_token_a_bad_body_is_still_401_not_422(client: TestClient) -> None:
    # La autenticación va antes que la validación: nada del cuerpo se evalúa sin sesión.
    assert_unauthenticated(client.post(ITEMS, json={"user_id": str(uuid4())}))


# RN-10 / WISH-R2: no hay forma de nombrar la lista ajena
@pytest.mark.parametrize("path", [f"{PATH}/{uuid4()}", f"{PATH}/user/{uuid4()}"])
def test_there_is_no_route_to_read_a_list_by_id(client: TestClient, path: str) -> None:
    token = make_token(str(uuid4()))

    response = client.get(path, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code in (404, 405)


def test_the_item_route_has_no_get_and_the_collection_no_delete(client: TestClient) -> None:
    token = make_token(str(uuid4()))
    headers = {"Authorization": f"Bearer {token}"}

    assert client.get(f"{ITEMS}/{uuid4()}", headers=headers).status_code == 405
    assert client.delete(ITEMS, headers=headers).status_code == 405


# CA-WISH-11: OpenAPI
def operation(method: str, path: str) -> dict[str, Any]:
    return create_app().openapi()["paths"][path][method]


def schema_of(response: dict[str, Any]) -> Any:
    return response["content"]["application/json"]["schema"]


def resolve(name: str) -> dict[str, Any]:
    return create_app().openapi()["components"]["schemas"][name]


@pytest.mark.parametrize(
    ("method", "path", "statuses"),
    [
        ("get", PATH, {"200", "401", "503"}),
        ("post", ITEMS, {"200", "401", "409", "422", "503"}),
        ("delete", ITEM, {"200", "401", "422", "503"}),
    ],
)
def test_openapi_declares_statuses_and_error_schema(
    method: str, path: str, statuses: set[str]
) -> None:
    op = operation(method, path)

    assert statuses <= set(op["responses"])
    assert schema_of(op["responses"]["200"]) == {"$ref": "#/components/schemas/WishlistOut"}
    for status in statuses - {"200"}:
        assert schema_of(op["responses"][status]) == {"$ref": "#/components/schemas/ErrorOut"}
    assert op.get("security"), "la ruta exige el esquema bearer"
    assert "HTTPValidationError" not in json.dumps(op)


def test_openapi_does_not_declare_statuses_the_spec_does_not_have() -> None:
    # Retirar y listar son idempotentes y sin conflicto; agregar no tiene artículo (sin 404).
    assert not {"404", "409"} & set(operation("delete", ITEM)["responses"])
    assert not {"404", "409"} & set(operation("get", PATH)["responses"])
    assert "404" not in operation("post", ITEMS)["responses"]
    assert "422" not in operation("get", PATH)["responses"]


def test_openapi_the_three_routes_and_no_others() -> None:
    paths = {p for p in create_app().openapi()["paths"] if p.startswith(PATH)}

    assert paths == {PATH, ITEMS, ITEM}
    assert set(create_app().openapi()["paths"][PATH]) == {"get"}
    assert set(create_app().openapi()["paths"][ITEMS]) == {"post"}
    assert set(create_app().openapi()["paths"][ITEM]) == {"delete"}


def test_openapi_get_has_no_user_or_list_id_parameter() -> None:
    op = operation("get", PATH)

    assert op.get("parameters", []) == []
    assert "requestBody" not in op


def test_openapi_bodies_and_path_parameters() -> None:
    post, delete = operation("post", ITEMS), operation("delete", ITEM)

    assert schema_of(post["requestBody"]) == {"$ref": "#/components/schemas/WishlistItemIn"}
    assert "requestBody" not in delete
    assert post.get("parameters", []) == []
    [param] = delete["parameters"]
    assert (param["name"], param["in"], param["required"]) == ("product_id", "path", True)
    assert param["schema"]["format"] == "uuid"


def test_openapi_input_accepts_only_product_id() -> None:
    body = resolve("WishlistItemIn")

    assert set(body["properties"]) == {"product_id"}
    assert body["required"] == ["product_id"]
    assert body["properties"]["product_id"]["format"] == "uuid"
    assert body.get("additionalProperties") is False  # user_id u otro campo → 422
    assert not {"user_id", "price", "unit_price", "total"} & set(body["properties"])


def nullable(prop: dict[str, Any]) -> bool:
    return any(option.get("type") == "null" for option in prop.get("anyOf", []))


def test_openapi_wishlist_out_matches_spec_7() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    wishlist = schemas["WishlistOut"]
    assert set(wishlist["required"]) == LIST_KEYS == set(wishlist["properties"])
    assert wishlist["properties"]["items"]["items"] == {
        "$ref": "#/components/schemas/WishlistItemOut"
    }
    assert wishlist["properties"]["item_count"]["type"] == "integer"
    assert wishlist["properties"]["max_items"]["type"] == "integer"

    item = schemas["WishlistItemOut"]
    assert set(item["properties"]) == ITEM_KEYS
    assert set(item["required"]) == ITEM_KEYS  # siempre presentes, con null si no aplican
    for key in ITEM_KEYS:
        assert nullable(item["properties"][key]) == (key in NULLABLE_ITEM_KEYS), key


def test_openapi_item_does_not_expose_internal_fields() -> None:
    item = resolve("WishlistItemOut")

    assert not {"available", "order_policy", "quantity", "on_hand", "user_id", "price"} & set(
        item["properties"]
    )


def test_openapi_status_is_the_closed_set_of_spec_r5() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    status = schemas["WishlistItemOut"]["properties"]["status"]
    enum = status.get("enum") or schemas[status["$ref"].rsplit("/", 1)[1]]["enum"]

    assert set(enum) == {"available", "unavailable"}


def test_openapi_added_at_is_a_date_time_and_ids_are_uuids() -> None:
    props = resolve("WishlistItemOut")["properties"]

    assert props["added_at"]["format"] == "date-time"
    assert props["product_id"]["format"] == "uuid"


def test_openapi_availability_is_the_catalog_vocabulary() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    availability = schemas["WishlistItemOut"]["properties"]["availability"]
    ref = next(o["$ref"] for o in availability["anyOf"] if "$ref" in o)
    body = schemas[ref.rsplit("/", 1)[1]]

    assert set(body["properties"]) == {"status", "lead_time_days"}
    assert set(body["properties"]["status"]["enum"]) == {
        "in_stock",
        "low_stock",
        "out_of_stock",
        "on_request",
    }


def test_openapi_image_has_url_and_alt() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    image = schemas["WishlistItemOut"]["properties"]["image"]
    ref = next(o["$ref"] for o in image["anyOf"] if "$ref" in o)

    assert set(schemas[ref.rsplit("/", 1)[1]]["properties"]) == {"url", "alt"}


def test_openapi_money_is_integer_cents_with_currency() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    money = next(
        s for name, s in schemas.items() if name.startswith("Money") and "amount" in s["properties"]
    )

    assert money["properties"]["amount"]["type"] == "integer"
    currency = money["properties"]["currency"]
    assert currency.get("enum", [currency.get("const")]) == ["PEN"]
