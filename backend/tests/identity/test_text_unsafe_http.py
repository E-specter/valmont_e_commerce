"""`PATCH /api/v1/identity/me` rechaza bidi e invisibles en cada texto (T-018d, D-047 D-H2). Sin BD:
422 `validation_error` con el `loc` del campo, el perfil intacto y sin eco del valor."""

import json
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
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role

USER_ID = uuid4()
ME = "/api/v1/identity/me"
MARK = "Marcador"  # parte legible del valor: no puede volver en la respuesta
HIDDEN = ["‮", "‪", "⁦", "​", "‍", "﻿", "­", "؜", "⁠"]

# (campo del cuerpo, plantilla, loc esperado; preferences se valida como un bloque)
FIELDS = [
    ("full_name", {"full_name": f"Ana{MARK}{{}}"}, ["body", "full_name"]),
    ("phone", {"phone": "987654321{}"}, ["body", "phone"]),
    ("style", {"preferences": {"style": f"clásico {MARK}{{}}"}}, ["body", "preferences"]),
    (
        "materials",
        {"preferences": {"materials": [f"acero {MARK}{{}}"]}},
        ["body", "preferences"],
    ),
    (
        "privacy",
        {"accept_privacy_version": f"2026-10{MARK}{{}}"},
        ["body", "accept_privacy_version"],
    ),
]


@pytest.fixture
def profiles() -> InMemoryProfiles:
    return InMemoryProfiles()


@pytest.fixture
def client(profiles: InMemoryProfiles, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    return TestClient(app, raise_server_exceptions=False)


def patch(client: TestClient, body: dict[str, Any]) -> Any:
    headers = {"Authorization": f"Bearer {make_token(str(USER_ID))}"}
    return client.patch(ME, headers=headers, json=body)


def fill(template: dict[str, Any], value: str) -> dict[str, Any]:
    return json.loads(json.dumps(template, ensure_ascii=False).replace("{}", value))


def assert_no_echo(response: Any, char: str) -> None:
    assert MARK not in response.text
    assert char not in response.text
    assert f"\\u{ord(char):04x}" not in response.text.lower()


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize(("name", "template", "loc"), FIELDS, ids=[f[0] for f in FIELDS])
def test_a_hidden_char_in_any_profile_text_is_422_without_effects_or_echo(
    client: TestClient,
    profiles: InMemoryProfiles,
    name: str,
    template: dict[str, Any],
    loc: list[Any],
    char: str,
) -> None:
    response = patch(client, fill(template, char))

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert loc in [d["loc"] for d in error["details"]]
    assert all(set(d) <= {"loc", "type", "msg"} for d in error["details"])  # sin "input"
    assert_no_echo(response, char)
    assert profiles.get(USER_ID) == Profile(USER_ID, Role.CUSTOMER, T0, T0)


@pytest.mark.parametrize("char", ["‮", "​"])
def test_a_hidden_char_at_the_edges_of_the_name_is_422(client: TestClient, char: str) -> None:
    # Se comprueba antes de recortar: ni al principio ni al final pasa desapercibido.
    assert patch(client, {"full_name": f"{char}Ana"}).status_code == 422
    assert patch(client, {"full_name": f"Ana{char}"}).status_code == 422


@pytest.mark.parametrize("filler", ["ㅤ", "⠀", "ﾠ", "ᅟ", "͏", "឴"])
@pytest.mark.parametrize("count", [1, 5])
def test_a_name_made_only_of_an_invisible_filler_is_422_on_full_name(
    client: TestClient, profiles: InMemoryProfiles, filler: str, count: int
) -> None:
    response = patch(client, {"full_name": filler * count})

    assert response.status_code == 422, response.text
    assert ["body", "full_name"] in [d["loc"] for d in response.json()["error"]["details"]]
    assert profiles.get(USER_ID) == Profile(USER_ID, Role.CUSTOMER, T0, T0)


def test_a_filler_next_to_visible_text_is_also_rejected(client: TestClient) -> None:
    assert patch(client, {"full_name": "Anaㅤ"}).status_code == 422


@pytest.mark.parametrize(
    "name",
    [
        "José Núñez",
        "Ana é Pérez",  # e + U+0301
        "O’Brien – D’Angelo",
        "李小龍",
        "Ελένη Παπά",
        "Иван Петров",
        "محمد علي",
        "\U0001f600 Ana",
    ],
)
def test_legitimate_names_are_still_saved(
    client: TestClient, profiles: InMemoryProfiles, name: str
) -> None:
    response = patch(client, {"full_name": name})

    assert response.status_code == 200, response.text
    assert response.json()["full_name"] == name
    assert profiles.get(USER_ID).full_name == name


def test_a_name_with_a_zwj_compound_emoji_is_422(client: TestClient) -> None:
    # Decisión del Leader (T-018d): ZWJ siempre se rechaza, también dentro de un emoji compuesto.
    response = patch(client, {"full_name": "Ana \U0001f469‍\U0001f4bb"})

    assert response.status_code == 422


def test_a_newline_is_still_rejected_in_the_profile_texts(client: TestClient) -> None:
    assert patch(client, {"full_name": "Ana\nTorres"}).status_code == 422
    assert patch(client, {"preferences": {"style": "a\nb"}}).status_code == 422


@pytest.mark.parametrize("value", ["\ue000", "\u0378\u0378", " \ue000 "])
def test_a_name_without_any_visible_char_that_is_not_unsafe_is_422(
    client: TestClient, profiles: InMemoryProfiles, value: str
) -> None:
    # Uso privado (Co) y sin asignar (Cn): no son Cf ni relleno, pero no se ven.
    response = patch(client, {"full_name": value})

    assert response.status_code == 422, response.text
    assert ["body", "full_name"] in [d["loc"] for d in response.json()["error"]["details"]]
    assert profiles.get(USER_ID) == Profile(USER_ID, Role.CUSTOMER, T0, T0)
