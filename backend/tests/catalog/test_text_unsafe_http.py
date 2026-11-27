"""Administración de catalog: bidi e invisibles en el texto de entrada (T-018d, D-047 D-H2).

Sin BD: los repositorios y Storage son `Untouchable`, así que un 422 prueba además que el rechazo
ocurre antes de cualquier efecto. Cada caso exige el formato común (`validation_error`), el `loc`
del campo y que la respuesta no repita el valor."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.catalog.catalog_helpers import InMemoryStorage, tiny_png
from tests.catalog.test_admin_http import ADMIN, ANY_ID, VALID_PRODUCT, Untouchable, call
from tests.catalog.test_domain import make_product
from tests.catalog.test_images_http import OneProduct, make_client, upload
from tests.identity.identity_helpers import T0, InMemoryProfiles, use_test_auth
from valmont.main import create_app
from valmont.modules.audit.adapters.http import get_audit_recorder
from valmont.modules.catalog.adapters import admin_http, http
from valmont.modules.catalog.domain import CatalogError, clean_text
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role

MARK = "Marcador"
HIDDEN = ["‮", "⁧", "​", "‍", "﻿", "­", "⁠", "‏"]
FILLERS = ["ㅤ", "⠀", "ﾠ", "ᅟ", "͏"]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    profiles = InMemoryProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    for dependency in (
        http.get_product_repository,
        http.get_category_repository,
        http.get_attribute_repository,
        get_audit_recorder,
        admin_http.get_image_storage,
    ):
        app.dependency_overrides[dependency] = Untouchable
    return TestClient(app, raise_server_exceptions=False)


def assert_rejected(response: Any, loc: list[str], char: str | None = None) -> None:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"][: len(loc)] for d in error["details"]] == [loc]
    assert all(set(d) <= {"loc", "type", "msg"} for d in error["details"])  # sin "input"
    assert MARK not in response.text
    if char is not None:
        assert char not in response.text
        assert f"\\u{ord(char):04x}" not in response.text.lower()


# (método, ruta, cuerpo con {} donde va el valor, loc del campo)
BODIES = [
    ("POST", "/products", {**VALID_PRODUCT, "name": f"Reloj {MARK}{{}}"}, ["body", "name"]),
    (
        "POST",
        "/products",
        {**VALID_PRODUCT, "description": f"Línea 1\nLínea {MARK}{{}}"},
        ["body", "description"],
    ),
    ("POST", "/products", {**VALID_PRODUCT, "sku": f"TS{{}}-{MARK}"}, ["body", "sku"]),
    (
        "POST",
        "/products",
        {**VALID_PRODUCT, "specs": [{"label": f"Cristal {MARK}{{}}", "value": "Zafiro"}]},
        ["body", "specs"],
    ),
    ("PATCH", f"/products/{ANY_ID}", {"name": f"Otro {MARK}{{}}"}, ["body", "name"]),
    ("PATCH", f"/products/{ANY_ID}", {"description": f"{MARK}{{}}"}, ["body", "description"]),
    ("POST", "/categories", {"name": f"Pruebas {MARK}{{}}"}, ["body", "name"]),
    ("PATCH", f"/categories/{ANY_ID}", {"name": f"Otra {MARK}{{}}"}, ["body", "name"]),
    (
        "POST",
        "/movement-types",
        {"code": "prueba", "label": f"Prueba {MARK}{{}}"},
        ["body", "label"],
    ),
    ("PATCH", "/case-materials/prueba", {"label": f"Otra {MARK}{{}}"}, ["body", "label"]),
    ("PATCH", f"/products/{ANY_ID}/images/{ANY_ID}", {"alt": f"Vista {MARK}{{}}"}, ["body", "alt"]),
]


def fill(value: Any, char: str) -> Any:
    if isinstance(value, str):
        return value.replace("{}", char)
    if isinstance(value, list):
        return [fill(item, char) for item in value]
    if isinstance(value, dict):
        return {key: fill(item, char) for key, item in value.items()}
    return value


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize(
    ("method", "path", "body", "loc"),
    BODIES,
    ids=[f"{b[0]}-{b[1].split('/')[1]}-{b[3][-1]}-{i}" for i, b in enumerate(BODIES)],
)
def test_a_hidden_char_in_a_catalog_text_is_422_before_any_effect(
    client: TestClient, method: str, path: str, body: dict[str, Any], loc: list[str], char: str
) -> None:
    response = call(client, method, path, fill(body, char), user=ADMIN)

    assert_rejected(response, loc, char)


@pytest.mark.parametrize("char", ["‮", "​", "﻿"])
def test_a_hidden_char_alone_at_the_edges_of_a_name_is_422(client: TestClient, char: str) -> None:
    for name in (f"{char}Reloj", f"Reloj{char}"):
        response = call(client, "POST", "/products", VALID_PRODUCT | {"name": name}, user=ADMIN)
        assert_rejected(response, ["body", "name"])


@pytest.mark.parametrize("filler", FILLERS, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize(
    ("path", "body", "field"),
    [
        ("/products", VALID_PRODUCT, "name"),
        ("/products", VALID_PRODUCT, "sku"),
        ("/categories", {"name": "x"}, "name"),
        ("/movement-types", {"code": "prueba", "label": "x"}, "label"),
    ],
)
def test_a_required_text_made_only_of_an_invisible_filler_is_422(
    client: TestClient, filler: str, path: str, body: dict[str, Any], field: str
) -> None:
    response = call(client, "POST", path, body | {field: filler * 3}, user=ADMIN)

    assert_rejected(response, ["body", field])


@pytest.mark.parametrize("char", ["‮", "​", "‍", "­"])
def test_a_hidden_char_in_the_image_alt_of_an_upload_is_422_and_nothing_is_stored(
    monkeypatch: pytest.MonkeyPatch, char: str
) -> None:
    untouched = make_client(monkeypatch, Untouchable(), Untouchable())

    response = upload(untouched, tiny_png(), alt=f"Vista {MARK}{char}")

    assert_rejected(response, ["body", "alt"], char)


@pytest.mark.parametrize("filler", FILLERS)
def test_an_alt_made_only_of_a_filler_is_422_on_upload(
    monkeypatch: pytest.MonkeyPatch, filler: str
) -> None:
    untouched = make_client(monkeypatch, Untouchable(), Untouchable())

    assert_rejected(upload(untouched, tiny_png(), alt=filler), ["body", "alt"])


# --- Lo legítimo y el salto de línea ---


@pytest.mark.parametrize(
    "value",
    [
        "Reloj de pulsera — edición 1925",
        "Peña Über “Clásico” O’Hara",
        "Cal. 3135 é",
        "精工表",
        "Ελληνικό ρολόι",
        "Часы",
        "Reloj \U0001f600",
    ],
)
def test_legitimate_catalog_text_is_accepted_by_clean_text(value: str) -> None:
    assert clean_text(value, 120) == value


def test_clean_text_allows_newlines_only_when_multiline() -> None:
    assert clean_text("a\nb", 10, multiline=True) == "a\nb"
    assert clean_text("a\r\nb", 10, multiline=True) == "a\nb"
    with pytest.raises(CatalogError):
        clean_text("a\nb", 10)
    with pytest.raises(CatalogError):
        clean_text("a\tb", 10, multiline=True)


@pytest.mark.parametrize("char", ["‮", "​", "ㅤ"])
def test_clean_text_rejects_hidden_chars_even_when_multiline(char: str) -> None:
    with pytest.raises(CatalogError):
        clean_text(f"a\n{char}b", 10, multiline=True)


@pytest.mark.parametrize("filler", FILLERS + ["​", "‮"])
def test_clean_text_with_nothing_visible_is_an_error_when_required(filler: str) -> None:
    with pytest.raises(CatalogError):
        clean_text(filler, 10)
    with pytest.raises(CatalogError):
        clean_text(f"  {filler}  ", 10)


def test_an_empty_optional_text_is_still_empty_not_an_error() -> None:
    assert clean_text("   ", 10, required=False) == ""


def test_the_alt_of_a_valid_upload_is_still_accepted_with_accents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = OneProduct(make_product())
    client = make_client(monkeypatch, repo, InMemoryStorage())

    response = upload(
        client, tiny_png(), alt="Vista frontal — esfera azul", product_id=repo.product.id
    )

    assert response.status_code == 201, response.text
    assert response.json()["alt"] == "Vista frontal — esfera azul"


@pytest.mark.parametrize("value", ["\ue000", "\u0378\u0378", " \ue000 "])
def test_a_required_text_without_any_visible_char_that_is_not_unsafe_is_422(
    client: TestClient, value: str
) -> None:
    # Uso privado (Co) y sin asignar (Cn): no son Cf ni relleno, pero no se ven.
    for path, body, field in (
        ("/products", VALID_PRODUCT | {"name": value}, "name"),
        ("/categories", {"name": value}, "name"),
    ):
        assert_rejected(call(client, "POST", path, body, user=ADMIN), ["body", field])
    with pytest.raises(CatalogError):
        clean_text(value, 10)
    assert clean_text(value, 10, required=False) is not None  # opcional: no se exige
