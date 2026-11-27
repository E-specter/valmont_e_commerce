"""`valmont.shared.idempotency.IdempotencyKey` (T-018c, D-047 D-H1). Sin BD: una app mínima con la
dependencia real prueba qué acepta (UUID de 36 caracteres, mayúsculas o minúsculas), cómo lo
normaliza (minúsculas) y que un 422 no devuelve el valor. Y la capa: shared no importa módulos."""

import ast
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.shared.idempotency_key_helpers import (
    BAD_KEYS,
    IDEMPOTENCY_KEY_PATTERN,
    VALID_UUID,
)
from valmont.shared.idempotency import IDEMPOTENCY_KEY_PATTERN as CODE_PATTERN
from valmont.shared.idempotency import IdempotencyKey

SOURCE = Path(__file__).parents[2] / "src" / "valmont" / "shared" / "idempotency.py"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()

    @app.post("/echo")
    def echo(key: IdempotencyKey) -> dict[str, str]:
        return {"key": key}

    return TestClient(app, raise_server_exceptions=False)


def send(client: TestClient, value: str | None) -> object:
    return client.post("/echo", headers={} if value is None else {"Idempotency-Key": value})


def test_the_pattern_is_the_agreed_one() -> None:
    assert CODE_PATTERN == IDEMPOTENCY_KEY_PATTERN


@pytest.mark.parametrize(
    "value",
    [VALID_UUID, VALID_UUID.upper(), "3F2b8C1e-5A4d-4E7b-9c06-1D2e3F4a5B6c"],
    ids=["minusculas", "mayusculas", "mezcla"],
)
def test_a_uuid_is_accepted_and_normalised_to_lowercase(client: TestClient, value: str) -> None:
    response = send(client, value)

    assert response.status_code == 200  # type: ignore[attr-defined]
    assert response.json() == {"key": VALID_UUID}  # type: ignore[attr-defined]


def test_the_two_capitalisations_are_the_same_key(client: TestClient) -> None:
    keys = {send(client, v).json()["key"] for v in (VALID_UUID, VALID_UUID.upper())}  # type: ignore[attr-defined]

    assert keys == {VALID_UUID}


def test_the_missing_header_is_422_on_the_header(client: TestClient) -> None:
    response = send(client, None)

    assert response.status_code == 422  # type: ignore[attr-defined]
    [detail] = response.json()["detail"]  # type: ignore[attr-defined]
    assert detail["loc"] == ["header", "idempotency-key"]


@pytest.mark.parametrize("value", BAD_KEYS.values(), ids=BAD_KEYS.keys())
def test_anything_that_is_not_a_uuid_is_422_on_the_header(client: TestClient, value: str) -> None:
    response = send(client, value)

    assert response.status_code == 422  # type: ignore[attr-defined]
    [detail] = response.json()["detail"]  # type: ignore[attr-defined]
    assert detail["loc"] == ["header", "idempotency-key"]


def test_the_pattern_alone_rejects_a_trailing_newline_and_every_bad_key() -> None:
    compiled = re.compile(IDEMPOTENCY_KEY_PATTERN)

    assert compiled.fullmatch(VALID_UUID) and compiled.fullmatch(VALID_UUID.upper())
    assert not [v for v in BAD_KEYS.values() if v != "" and compiled.fullmatch(v)]


def test_the_openapi_of_the_type_declares_36_characters_and_the_pattern(client: TestClient) -> None:
    app: FastAPI = client.app  # type: ignore[assignment]
    [param] = app.openapi()["paths"]["/echo"]["post"]["parameters"]

    assert param["name"] == "idempotency-key" and param["required"] is True
    assert (param["schema"]["minLength"], param["schema"]["maxLength"]) == (36, 36)
    assert param["schema"]["pattern"] == IDEMPOTENCY_KEY_PATTERN


def test_shared_idempotency_does_not_import_any_module() -> None:
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    imported = [
        node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
    ] + [
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    ]

    assert not [name for name in imported if name.startswith("valmont.modules")], imported


def test_each_route_uses_the_shared_definition_and_has_no_copy() -> None:
    modules = SOURCE.parents[1] / "modules"
    for path in ("orders", "payments"):
        text = (modules / path / "adapters" / "http.py").read_text(encoding="utf-8")
        assert "from valmont.shared.idempotency import IdempotencyKey" in text, path
        assert not re.search(r"^IdempotencyKey\s*=", text, re.MULTILINE), path
        assert "A-Za-z0-9_-" not in text, path
