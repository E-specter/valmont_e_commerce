"""Nota de un movimiento de inventario con bidi o invisibles, por HTTP contra PostgreSQL (T-018d,
D-047 D-H2). 422 `validation_error` con `loc` ["body", "note"], sin movimiento, sin cambio de stock
ni auditoría, y sin devolver el valor. Datos ficticios."""

from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.inventory.test_admin_db import BASE, audit, movement_url, movements, on_hand, product
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ADMIN = uuid4()
MARK = "Marcador"
HIDDEN = ["‮", "⁧", "​", "‍", "﻿", "­", "⁠", "‏"]
FILLERS = ["ㅤ", "⠀", "ﾠ", "ᅟ", "͏"]


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


def assert_untouched(session: Session, product_id: Any) -> None:
    assert on_hand(session, product_id) == 3
    assert movements(session, product_id) == []
    assert audit(session, "product", product_id) == []


@pytest.mark.parametrize("char", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
@pytest.mark.parametrize("kind", ["entrada", "merma", "ajuste_inventario"])
def test_a_hidden_char_in_the_note_is_422_without_effects_or_echo(
    client: TestClient, db_session: Session, kind: str, char: str
) -> None:
    product_id = product(db_session, 3)

    response = client.post(
        movement_url(product_id),
        json={"kind": kind, "quantity": 1, "note": f"Rotura {MARK}{char} vitrina"},
    )

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"] for d in error["details"]] == [["body", "note"]]
    assert MARK not in response.text and char not in response.text
    assert f"\\u{ord(char):04x}" not in response.text.lower()
    assert_untouched(db_session, product_id)


@pytest.mark.parametrize("char", ["‮", "​"])
def test_a_hidden_char_at_the_edges_of_the_note_is_422(
    client: TestClient, db_session: Session, char: str
) -> None:
    product_id = product(db_session, 3)

    for note in (f"{char}Rotura", f"Rotura{char}", f"Línea 1\n{char}"):
        response = client.post(
            movement_url(product_id), json={"kind": "merma", "quantity": 1, "note": note}
        )
        assert response.status_code == 422, response.text
        assert [d["loc"] for d in response.json()["error"]["details"]] == [["body", "note"]]
    assert_untouched(db_session, product_id)


@pytest.mark.parametrize("filler", FILLERS, ids=lambda c: f"U+{ord(c):04X}")
def test_a_note_made_only_of_a_filler_is_422(
    client: TestClient, db_session: Session, filler: str
) -> None:
    product_id = product(db_session, 3)

    response = client.post(
        movement_url(product_id), json={"kind": "merma", "quantity": 1, "note": filler * 4}
    )

    assert response.status_code == 422, response.text
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["body", "note"]]
    assert_untouched(db_session, product_id)


def test_a_zwj_compound_emoji_in_the_note_is_422(client: TestClient, db_session: Session) -> None:
    product_id = product(db_session, 3)

    response = client.post(
        movement_url(product_id),
        json={"kind": "merma", "quantity": 1, "note": "Caja \U0001f469‍\U0001f4bb"},
    )

    assert response.status_code == 422, response.text
    assert_untouched(db_session, product_id)


@pytest.mark.parametrize(
    "note",
    [
        "Cristal rayado en vitrina",
        "Línea 1\nLínea 2",  # el salto de línea sigue permitido en la nota
        "Reposición — lote Peña “25”, Núñez",
        "Caja é 李小龍 \U0001f600",
    ],
)
def test_legitimate_notes_are_still_accepted_and_stored(
    client: TestClient, db_session: Session, note: str
) -> None:
    product_id = product(db_session, 3)

    response = client.post(
        movement_url(product_id), json={"kind": "entrada", "quantity": 1, "note": note}
    )

    assert response.status_code == 201, response.text
    assert response.json()["note"] == note
    assert on_hand(db_session, product_id) == 4


@pytest.mark.parametrize("control", ["\t", "\r", "\x00"])
def test_other_controls_are_still_rejected_in_the_note(
    client: TestClient, db_session: Session, control: str
) -> None:
    product_id = product(db_session, 3)

    response = client.post(
        movement_url(product_id),
        json={"kind": "entrada", "quantity": 1, "note": f"a{control}b"},
    )

    assert response.status_code == 422, response.text
    assert_untouched(db_session, product_id)


# --- Filtro de búsqueda `q` (aceptado como más estricto por el Leader: rechaza también Cf) ---


@pytest.mark.parametrize("char", HIDDEN + FILLERS, ids=lambda c: f"U+{ord(c):04X}")
def test_a_hidden_char_in_the_search_q_is_422_on_query_q(
    client: TestClient, db_session: Session, char: str
) -> None:
    response = client.get(f"{BASE}/stock", params={"q": f"rel{char}oj"})

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"] for d in error["details"]] == [["query", "q"]]
    assert char not in response.text


@pytest.mark.parametrize(
    "q", ["Núñez", "reloj", "Pe\u00f1a e\u0301", "\u674e", "Ελένη", "\U0001f600"]
)
def test_a_legitimate_search_q_with_accents_is_still_accepted(
    client: TestClient, db_session: Session, q: str
) -> None:
    response = client.get(f"{BASE}/stock", params={"q": q})

    assert response.status_code == 200, response.text
    assert "items" in response.json()
