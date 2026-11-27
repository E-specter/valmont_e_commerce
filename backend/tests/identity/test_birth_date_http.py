"""GET y PATCH /api/v1/identity/me con birth_date (T-138; CA-IDENTITY-07, 08, 09, 11, 12, 13)."""

import json
import logging
from dataclasses import replace
from datetime import date
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from tests.identity.birth_date_helpers import (
    OTHER_BIRTH,
    VALID_BIRTH,
    BirthDateProfiles,
    lima_today_from_wall_clock,
)
from tests.identity.identity_helpers import make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Role

ME = "/api/v1/identity/me"
USER_ID = uuid4()
LOCKED = {
    "error": {
        "code": "birth_date_locked",
        "message": "La fecha de nacimiento ya está registrada y no se puede cambiar.",
        "details": None,
    }
}


@pytest.fixture
def profiles() -> BirthDateProfiles:
    return BirthDateProfiles()


@pytest.fixture
def client(profiles: BirthDateProfiles, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    return TestClient(app, raise_server_exceptions=False)


def headers_for(user_id: UUID = USER_ID) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(str(user_id))}"}


def patch_birth(client: TestClient, value: object, as_user: UUID = USER_ID, **extra: object):
    return client.patch(ME, headers=headers_for(as_user), json={"birth_date": value, **extra})


def stored_birth(profiles: BirthDateProfiles, user_id: UUID = USER_ID) -> date | None:
    return profiles.rows[user_id].birth_date if user_id in profiles.rows else None


def years_ago(years: int) -> date:
    today = lima_today_from_wall_clock()
    return today.replace(year=today.year - years)  # sin 29-feb en las fechas de prueba


# --- CA-IDENTITY-07 ---


def test_patch_sets_birth_date_and_get_returns_it(client: TestClient) -> None:
    response = patch_birth(client, "1990-05-17")

    assert response.status_code == 200
    assert response.json()["birth_date"] == "1990-05-17"
    reread = client.get(ME, headers=headers_for())
    assert reread.status_code == 200
    assert reread.json()["birth_date"] == "1990-05-17"


def test_get_without_birth_date_returns_null(client: TestClient) -> None:
    body = client.get(ME, headers=headers_for()).json()

    assert "birth_date" in body
    assert body["birth_date"] is None


def test_patch_without_birth_date_returns_null_and_does_not_touch_it(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    first = client.patch(ME, headers=headers_for(), json={"full_name": "Ana Torres"})
    assert first.json()["birth_date"] is None
    patch_birth(client, "1990-05-17")
    profiles.set_calls.clear()

    second = client.patch(ME, headers=headers_for(), json={"phone": "987654321"})

    assert second.status_code == 200
    assert second.json()["birth_date"] == "1990-05-17"
    assert profiles.set_calls == []


def test_patch_birth_date_with_other_fields_in_one_request(client: TestClient) -> None:
    response = patch_birth(client, "1990-05-17", full_name=" Ana  Torres ", phone="987 654 321")

    body = response.json()
    assert response.status_code == 200
    assert (body["birth_date"], body["full_name"], body["phone"]) == (
        "1990-05-17",
        "Ana Torres",
        "987654321",
    )


# --- CA-IDENTITY-08 (R6) ---

INVALID_FORMATS = [
    pytest.param("17/05/1987", id="dd-mm-aaaa"),
    pytest.param("1987-5-17", id="sin-cero-mes"),
    pytest.param("19870517", id="compacto"),
    pytest.param("1987-05-17T00:00:00", id="con-hora"),
    pytest.param("1987-05-17T00:00:00Z", id="con-zona"),
    pytest.param("2001-02-29", id="inexistente"),
    pytest.param("", id="vacia"),
    pytest.param(" 1987-05-17", id="espacio-inicial"),
    pytest.param("1987-05-17 ", id="espacio-final"),
    pytest.param("1987-05-17\n", id="salto-de-linea"),
    pytest.param("１９８７-05-17", id="digitos-anchos"),
    pytest.param(19870517, id="numero"),
    pytest.param(True, id="booleano"),
    pytest.param(None, id="null"),
    pytest.param(["1987-05-17"], id="lista"),
    pytest.param({"year": 1987}, id="objeto"),
]


@pytest.mark.parametrize("value", INVALID_FORMATS)
def test_invalid_format_is_422_without_echoing_the_value_and_without_effects(
    client: TestClient,
    profiles: BirthDateProfiles,
    caplog: pytest.LogCaptureFixture,
    value: object,
) -> None:
    caplog.set_level(logging.DEBUG)
    client.get(ME, headers=headers_for())  # crea el perfil

    response = patch_birth(client, value)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert any(d["loc"][:2] == ["body", "birth_date"] for d in error["details"])
    fragments = ["1987", "17/05", "05-17"] + ([value] if isinstance(value, str) and value else [])
    for text in (response.text, caplog.text):
        for fragment in fragments:
            assert fragment not in text, fragment
    assert stored_birth(profiles) is None
    assert profiles.set_calls == []


def test_unknown_or_foreign_fields_next_to_birth_date_are_422(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    client.get(ME, headers=headers_for())

    for extra in ({"user_id": str(uuid4())}, {"role": "admin"}, {"age": 30}):
        assert patch_birth(client, "1990-05-17", **extra).status_code == 422

    assert stored_birth(profiles) is None


def test_invalid_other_field_with_valid_birth_date_writes_nothing(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    client.get(ME, headers=headers_for())

    response = patch_birth(client, "1990-05-17", full_name="   ")

    assert response.status_code == 422  # CA-12
    assert stored_birth(profiles) is None
    assert profiles.rows[USER_ID].full_name is None


# --- CA-IDENTITY-09 (R7, con el reloj real: el reloj fijo está en test_birth_date_application) ---


def error_detail(response) -> dict[str, object]:
    [detail] = response.json()["error"]["details"]
    return detail


@pytest.mark.parametrize(
    ("value", "kind"),
    [
        pytest.param("2999-01-01", "birth_date_future", id="muy-futura"),
        pytest.param(None, "birth_date_future", id="manana"),
        pytest.param(None, "birth_date_too_old", id="121-anios"),
        pytest.param("1899-12-31", "birth_date_too_old", id="antes-de-1900"),
        pytest.param("1850-06-15", "birth_date_too_old", id="siglo-xix"),
    ],
)
def test_out_of_range_birth_date_is_422_with_its_type(
    client: TestClient, profiles: BirthDateProfiles, value: str | None, kind: str
) -> None:
    if value is None:
        today = lima_today_from_wall_clock()
        value = (
            date.fromordinal(today.toordinal() + 1).isoformat()
            if kind == "birth_date_future"
            else years_ago(121).isoformat()
        )
    client.get(ME, headers=headers_for())

    response = patch_birth(client, value)

    assert response.status_code == 422
    body = response.json()["error"]
    assert (body["code"], body["message"]) == ("validation_error", "Datos de entrada no válidos.")
    detail = error_detail(response)
    assert detail["loc"] == ["body", "birth_date"]
    assert detail["type"] == kind
    assert value not in response.text
    assert value[:4] not in str(detail["msg"])
    assert stored_birth(profiles) is None


def test_exactly_120_years_is_accepted(client: TestClient) -> None:
    assert patch_birth(client, years_ago(120).isoformat(), uuid4()).status_code == 200


# --- IDENTITY-R7b: menores (reloj real; los bordes con reloj fijo están en aplicación) ---


def day_after(value: date) -> date:
    return date.fromordinal(value.toordinal() + 1)


MINOR_DATES = [
    pytest.param(lima_today_from_wall_clock, id="hoy-de-lima"),
    pytest.param(lambda: years_ago(5), id="5-anios"),
    pytest.param(lambda: day_after(years_ago(18)), id="18-anios-manana"),
]


@pytest.mark.parametrize("make_date", MINOR_DATES)
def test_minor_birth_date_is_422_underage_with_no_effects_and_no_echo(
    client: TestClient,
    profiles: BirthDateProfiles,
    caplog: pytest.LogCaptureFixture,
    make_date,
) -> None:
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="valmont")
    value = make_date().isoformat()
    client.patch(ME, headers=headers_for(), json={"full_name": "Ana Torres"})
    profiles.set_calls.clear()

    response = patch_birth(client, value, full_name="Otro Nombre", phone="987654321")

    assert response.status_code == 422
    error = response.json()["error"]
    assert (error["code"], error["message"]) == ("validation_error", "Datos de entrada no válidos.")
    detail = error_detail(response)
    assert detail["loc"] == ["body", "birth_date"]
    assert detail["type"] == "birth_date_underage"
    assert not any(char.isdigit() for char in str(detail["msg"]))
    assert value not in response.text and value[:7] not in response.text
    assert value not in caplog.text
    assert stored_birth(profiles) is None
    assert profiles.rows[USER_ID].full_name == "Ana Torres"  # el resto del PATCH tampoco se escribe
    assert profiles.rows[USER_ID].phone is None
    assert profiles.set_calls == []


def test_exactly_18_years_completed_today_is_accepted(client: TestClient) -> None:
    value = years_ago(18)

    response = patch_birth(client, value.isoformat())

    assert response.status_code == 200
    assert response.json()["birth_date"] == value.isoformat()


def test_a_minor_date_after_a_fixed_one_is_422_underage_and_the_original_stays(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    # Orden actual (rango -> menor -> fijación): 422 birth_date_underage, no 409.
    patch_birth(client, "1990-05-17")

    response = patch_birth(client, years_ago(10).isoformat())

    assert response.status_code == 422
    assert error_detail(response)["type"] == "birth_date_underage"
    assert stored_birth(profiles) == VALID_BIRTH


def test_the_server_clock_decides_not_the_client(client: TestClient) -> None:
    # Una cabecera de fecha del cliente no cambia "hoy".
    tomorrow = date.fromordinal(lima_today_from_wall_clock().toordinal() + 1)

    response = client.patch(
        ME,
        headers=headers_for() | {"Date": "Fri, 01 Jan 2100 00:00:00 GMT", "X-Now": "2100-01-01"},
        json={"birth_date": tomorrow.isoformat()},
    )

    assert response.status_code == 422


# --- CA-IDENTITY-11 (R10) ---


def test_second_different_birth_date_is_409_and_original_is_kept(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    assert patch_birth(client, "1990-05-17").status_code == 200

    response = patch_birth(client, "1991-01-01")

    assert response.status_code == 409
    assert response.json() == LOCKED
    assert client.get(ME, headers=headers_for()).json()["birth_date"] == "1990-05-17"
    assert stored_birth(profiles) == VALID_BIRTH


def test_same_birth_date_again_is_200(client: TestClient) -> None:
    patch_birth(client, "1990-05-17")

    response = patch_birth(client, "1990-05-17")

    assert response.status_code == 200
    assert response.json()["birth_date"] == "1990-05-17"


def test_locked_birth_date_with_new_full_name_is_409_and_full_name_unchanged(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    client.patch(ME, headers=headers_for(), json={"full_name": "Ana Torres"})
    patch_birth(client, "1990-05-17")

    response = patch_birth(client, "1991-01-01", full_name="Otra Persona")

    assert response.status_code == 409
    assert response.json() == LOCKED
    assert profiles.rows[USER_ID].full_name == "Ana Torres"  # CA-12
    assert stored_birth(profiles) == VALID_BIRTH


def test_a_lock_applies_per_user(client: TestClient, profiles: BirthDateProfiles) -> None:
    other = uuid4()
    patch_birth(client, "1990-05-17")

    assert patch_birth(client, "1991-01-01", other).status_code == 200
    assert stored_birth(profiles, other) == OTHER_BIRTH
    assert stored_birth(profiles) == VALID_BIRTH


def test_birth_date_with_a_foreign_user_id_in_the_body_is_422_and_writes_nothing(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    victim = uuid4()
    profiles.with_birth_date(victim, None)

    response = client.patch(
        ME,
        headers=headers_for(),
        json={"birth_date": "1990-05-17", "user_id": str(victim)},
    )

    assert response.status_code == 422
    assert stored_birth(profiles, victim) is None
    assert stored_birth(profiles) is None


def test_patch_birth_date_requires_authentication(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    response = client.patch(ME, json={"birth_date": "1990-05-17"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"
    assert profiles.rows == {}


# --- CA-IDENTITY-13 (R9, privacidad) ---


def test_get_and_patch_are_never_cached(client: TestClient) -> None:
    assert client.get(ME, headers=headers_for()).headers["Cache-Control"] == "no-store"
    patched = patch_birth(client, "1990-05-17")
    assert patched.headers["Cache-Control"] == "no-store"
    again = patch_birth(client, "1990-05-17")
    assert again.headers["Cache-Control"] == "no-store"


def test_get_returns_only_the_birth_date_of_the_token_owner(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    ana, luis = uuid4(), uuid4()
    patch_birth(client, "1990-05-17", ana)
    patch_birth(client, "1985-12-24", luis)

    ana_body = client.get(ME, headers=headers_for(ana)).json()
    luis_body = client.get(ME, headers=headers_for(luis)).json()
    stranger = client.get(ME, headers=headers_for(uuid4())).json()

    assert (ana_body["birth_date"], luis_body["birth_date"]) == ("1990-05-17", "1985-12-24")
    assert stranger["birth_date"] is None


def test_an_admin_sees_only_their_own_birth_date_on_me(
    client: TestClient, profiles: BirthDateProfiles
) -> None:
    admin, customer = uuid4(), uuid4()
    patch_birth(client, "1990-05-17", customer)
    profiles.with_birth_date(admin, date(1980, 2, 2))
    profiles.rows[admin] = replace(profiles.rows[admin], role=Role.ADMIN)

    body = client.get(ME, headers=headers_for(admin)).json()

    assert (body["role"], body["birth_date"]) == ("admin", "1980-02-02")
    assert "1990-05-17" not in json.dumps(body)


@pytest.mark.parametrize(
    "sent",
    [
        pytest.param(["1987-03-21"], id="ok"),
        pytest.param(["21/03/1987"], id="formato"),
        pytest.param(["2999-12-31"], id="futura"),
        pytest.param(["1987-03-21", "1993-08-14"], id="bloqueada"),
    ],
)
def test_birth_date_never_reaches_the_logs(
    client: TestClient, caplog: pytest.LogCaptureFixture, sent: list[str]
) -> None:
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="valmont")

    for value in sent:
        patch_birth(client, value)
    client.get(ME, headers=headers_for())

    for fragment in (*sent, "1987-03", "03-21", "21/03", "2999-12", "1993-08", "08-14"):
        assert fragment not in caplog.text, fragment


def test_no_error_body_carries_the_stored_or_the_sent_date(client: TestClient) -> None:
    patch_birth(client, "1987-03-21")

    locked = patch_birth(client, "1993-08-14")

    for fragment in ("1987", "03-21", "1993", "08-14"):
        assert fragment not in locked.text


def test_openapi_declares_birth_date_and_the_409(client: TestClient) -> None:
    schema = create_app().openapi()
    patch = schema["paths"][ME]["patch"]
    components = schema["components"]["schemas"]

    assert set(patch["responses"]) == {"200", "401", "409", "422", "503"}
    assert patch["responses"]["409"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ErrorOut"
    }
    assert "409" not in schema["paths"][ME]["get"]["responses"]
    out = components["ProfileOut"]["properties"]["birth_date"]
    assert {"type": "string", "format": "date"} in out["anyOf"]
    assert {"type": "null"} in out["anyOf"]
    incoming = components["ProfileUpdateIn"]["properties"]["birth_date"]
    assert "null" not in json.dumps(incoming)  # opcional pero no nulo (R11)
    assert "birth_date" not in components["ProfileUpdateIn"].get("required", [])


def test_only_the_profile_schemas_expose_birth_date() -> None:
    schema = create_app().openapi()

    holders = {
        name
        for name, definition in schema["components"]["schemas"].items()
        if "birth_date" in definition.get("properties", {})
    }

    assert holders == {"ProfileOut", "ProfileUpdateIn"}
    leaking_paths = {
        path
        for path, operations in schema["paths"].items()
        if path != ME and any(n in json.dumps(operations) for n in ("birth_date", *holders))
    }
    assert leaking_paths == set()
