"""Nombre de la promoción con bidi o invisibles, por HTTP contra PostgreSQL (T-018d, D-047 D-H2).
Alta y edición: 422 `validation_error` con `loc` ["body", "name"], sin promoción ni auditoría,
sin cambiar la existente y sin devolver el valor. Datos ficticios."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.promotions.promotions_helpers import add_promotion
from tests.promotions.test_admin_db import BASE, counts
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ADMIN = uuid4()
MARK = "Marcador"
HIDDEN = ["‮", "⁧", "​", "‍", "﻿", "­", "⁠", "‏"]
FILLERS = ["ㅤ", "⠀", "ﾠ", "ᅟ", "͏"]
NOW = datetime.now(UTC)
CATALOG = {
    "name": "Temporada de prueba",
    "kind": "percent",
    "percent_off": 15,
    "scope": "catalog",
    "starts_at": (NOW - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
    "ends_at": (NOW + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
}


@pytest.fixture
def client(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    profiles = InMemoryProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    return TestClient(
        app,
        headers={"Authorization": f"Bearer {make_token(str(ADMIN))}"},
        raise_server_exceptions=False,
    )


def assert_name_rejected(response: Any, char: str | None = None) -> None:
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"][:2] for d in error["details"]] == [["body", "name"]]
    assert MARK not in response.text
    if char is not None:
        assert char not in response.text
        assert f"\\u{ord(char):04x}" not in response.text.lower()


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
def test_a_hidden_char_in_the_name_on_create_is_422_and_leaves_nothing(
    client: TestClient, db_session: Session, char: str
) -> None:
    before = counts(db_session)

    response = client.post(
        f"{BASE}/promotions", json=CATALOG | {"name": f"Oferta {MARK}{char} Otoño"}
    )

    assert_name_rejected(response, char)
    assert counts(db_session) == before


@pytest.mark.parametrize("char", ["‮", "​", "﻿"])
def test_a_hidden_char_at_the_edges_of_the_name_is_422(
    client: TestClient, db_session: Session, char: str
) -> None:
    before = counts(db_session)

    for name in (f"{char}Oferta", f"Oferta{char}"):
        assert_name_rejected(client.post(f"{BASE}/promotions", json=CATALOG | {"name": name}))
    assert counts(db_session) == before


@pytest.mark.parametrize("filler", FILLERS, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize("count", [1, 6])
def test_a_name_made_only_of_a_filler_is_422(
    client: TestClient, db_session: Session, filler: str, count: int
) -> None:
    before = counts(db_session)

    assert_name_rejected(client.post(f"{BASE}/promotions", json=CATALOG | {"name": filler * count}))
    assert counts(db_session) == before


def test_a_zwj_compound_emoji_in_the_name_is_422(client: TestClient) -> None:
    response = client.post(
        f"{BASE}/promotions", json=CATALOG | {"name": "Oferta \U0001f469‍\U0001f4bb"}
    )

    assert_name_rejected(response)


@pytest.mark.parametrize("char", ["‮", "​", "‍"])
def test_a_hidden_char_in_the_name_on_edit_is_422_and_keeps_the_promotion(
    client: TestClient, db_session: Session, char: str
) -> None:
    promotion_id = add_promotion(db_session)
    shown = client.get(f"{BASE}/promotions/{promotion_id}")
    assert shown.status_code == 200, shown.text
    before = counts(db_session)

    response = client.patch(
        f"{BASE}/promotions/{promotion_id}", json={"name": f"Nuevo {MARK}{char}"}
    )

    assert_name_rejected(response, char)
    assert counts(db_session) == before
    assert client.get(f"{BASE}/promotions/{promotion_id}").json() == shown.json()


@pytest.mark.parametrize(
    "name",
    [
        "Temporada de Otoño",
        "Relojería — edición 1925 “Clásico”",
        "Peña Über O’Hara é",
        "秋のセール",
        "Распродажа",
        "Oferta \U0001f600",
    ],
)
def test_legitimate_names_are_still_accepted(client: TestClient, name: str) -> None:
    response = client.post(f"{BASE}/promotions", json=CATALOG | {"name": name})

    assert response.status_code == 201, response.text
    assert response.json()["name"] == name


@pytest.mark.parametrize("value", ["\ue000", "\u0378\u0378"])
def test_a_name_without_any_visible_char_that_is_not_unsafe_is_422(
    client: TestClient, db_session: Session, value: str
) -> None:
    # Uso privado (Co) y sin asignar (Cn): no son Cf ni relleno, pero no se ven.
    before = counts(db_session)

    assert_name_rejected(client.post(f"{BASE}/promotions", json=CATALOG | {"name": value}))
    assert counts(db_session) == before
