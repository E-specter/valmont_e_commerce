import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import uuid4

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from tests.identity.identity_helpers import (
    JWKS,
    KID,
    OTHER_KEY,
    T0,
    InMemoryProfiles,
    hs256_signed_with_public_key,
    make_token,
    use_test_auth,
)
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository, require_admin
from valmont.modules.identity.domain import CurrentUser, Preferences, Profile, Role
from valmont.shared import auth
from valmont.shared.config import Settings

USER_ID = uuid4()
ME = "/api/v1/identity/me"
PROFILE_KEYS = {
    "user_id",
    "role",
    "full_name",
    "phone",
    "preferences",
    "privacy_version",
    "privacy_accepted_at",
    "marketing_opt_in",
    "created_at",
    "updated_at",
}


@pytest.fixture
def profiles() -> InMemoryProfiles:
    return InMemoryProfiles()


@pytest.fixture
def client(profiles: InMemoryProfiles, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    @app.get("/test/admin")
    def admin_only(user: Annotated[CurrentUser, Depends(require_admin)]) -> dict[str, str]:
        return {"user_id": str(user.user_id)}

    return TestClient(app, raise_server_exceptions=False)


def auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def raw_patch(client: TestClient, body: str) -> int:
    """PATCH con el JSON tal cual: httpx no puede serializar un sustituto suelto."""
    headers = auth_header(make_token(str(USER_ID))) | {"Content-Type": "application/json"}
    return client.patch(ME, headers=headers, content=body).status_code


def test_get_me_returns_profile_in_contract_format(
    client: TestClient, profiles: InMemoryProfiles, caplog: pytest.LogCaptureFixture
) -> None:
    token = make_token(str(USER_ID))
    profiles.add_if_absent(USER_ID)
    profiles.update(USER_ID, {"preferences": Preferences(budget_min=300000, budget_max=900000)})

    response = client.get(ME, headers=auth_header(token))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == PROFILE_KEYS  # sin email (IDENTITY-R4)
    assert (body["user_id"], body["role"]) == (str(USER_ID), "customer")
    assert body["preferences"] == {
        "style": None,
        "budget_min": {"amount": 300000, "currency": "PEN"},
        "budget_max": {"amount": 900000, "currency": "PEN"},
        "materials": [],
    }
    assert body["created_at"] == "2026-10-26T19:58:00Z"
    assert token not in caplog.text


def test_get_me_creates_a_customer_profile_once(
    client: TestClient, profiles: InMemoryProfiles
) -> None:
    headers = auth_header(make_token(str(USER_ID)))

    assert client.get(ME, headers=headers).status_code == 200
    assert client.get(ME, headers=headers).status_code == 200
    assert list(profiles.rows) == [USER_ID]
    assert profiles.get(USER_ID).role is Role.CUSTOMER


def test_explicit_issuer_is_the_one_checked(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    public_issuer = "https://valmont.example/auth/v1"
    use_test_auth(monkeypatch, supabase_jwt_issuer=public_issuer)

    good = client.get(ME, headers=auth_header(make_token(str(USER_ID), iss=public_issuer)))
    derived = client.get(ME, headers=auth_header(make_token(str(USER_ID))))

    assert (good.status_code, derived.status_code) == (200, 401)


EXPIRED = int((datetime.now(UTC) - timedelta(minutes=1)).timestamp())
SUB = str(USER_ID)


@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({}, id="sin-cabecera"),
        pytest.param({"Authorization": "Bearer"}, id="sin-token"),
        pytest.param({"Authorization": f"Basic {make_token(SUB)}"}, id="otro-esquema"),
        pytest.param(auth_header("no-es-un-jwt"), id="mal-formado"),
        pytest.param(auth_header(make_token(SUB, key=OTHER_KEY)), id="otra-clave"),
        pytest.param(auth_header(make_token(SUB, kid="desconocido")), id="kid-desconocido"),
        pytest.param(auth_header(make_token(SUB, key="x" * 64, algorithm="HS256")), id="hs256"),
        pytest.param(auth_header(hs256_signed_with_public_key(SUB)), id="confusion-de-alg"),
        pytest.param(auth_header(make_token(SUB, key=None, algorithm="none")), id="alg-none"),
        pytest.param(auth_header(make_token(SUB, exp=EXPIRED)), id="caducado"),
        pytest.param(auth_header(make_token(SUB, aud="anon")), id="aud-incorrecto"),
        pytest.param(auth_header(make_token(SUB, iss="http://otro/auth/v1")), id="iss-incorrecto"),
        pytest.param(auth_header(make_token(None)), id="sin-sub"),
        pytest.param(auth_header(make_token(SUB, exp=None)), id="sin-exp"),
        pytest.param(auth_header(make_token(SUB, iss=None)), id="sin-iss"),
        pytest.param(auth_header(make_token("no-uuid")), id="sub-no-uuid"),
    ],
)
def test_invalid_credentials_return_generic_401(
    client: TestClient, profiles: InMemoryProfiles, headers: dict[str, str]
) -> None:
    response = client.get(ME, headers=headers)

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert response.json() == {
        "error": {"code": "unauthenticated", "message": "Autenticación requerida.", "details": None}
    }
    assert profiles.rows == {}


def test_patch_me_without_token_is_401(client: TestClient) -> None:
    response = client.patch(ME, json={"full_name": "Ana"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_unreachable_jwks_is_503_without_details(
    client: TestClient, profiles: InMemoryProfiles, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_test_auth(monkeypatch, jwks=None)

    response = client.get(ME, headers=auth_header(make_token(SUB)))

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "auth_unavailable",
            "message": "Autenticación no disponible.",
            "details": None,
        }
    }
    assert profiles.rows == {}


def test_missing_supabase_url_is_a_500_without_details(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_test_auth(monkeypatch, supabase_url=None)

    response = client.get(ME, headers=auth_header(make_token(SUB)))

    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "internal_error",
        "message": "Error interno del servidor.",
        "details": None,
    }


def test_jwks_client_reads_supabase_auth_jwks(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(_env_file=None, supabase_url="http://127.0.0.1:54321/")
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    auth.get_jwks_client.cache_clear()
    try:
        assert auth.get_jwks_client().uri == "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json"
    finally:
        auth.get_jwks_client.cache_clear()


def test_test_jwks_publishes_only_the_public_key() -> None:
    [key] = JWKS["keys"]
    assert (key["kid"], key["kty"], key["crv"]) == (KID, "EC", "P-256")
    assert "d" not in key  # la parte privada nunca sale


def test_patch_me_changes_only_sent_fields(client: TestClient) -> None:
    headers = auth_header(make_token(SUB))
    client.patch(
        ME, headers=headers, json={"full_name": "  Ana   Torres ", "phone": "+51 987 654 321"}
    )

    response = client.patch(
        ME,
        headers=headers,
        json={"preferences": {"style": " clásico ", "budget_max": {"amount": 900000}}},
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == PROFILE_KEYS
    assert (body["full_name"], body["phone"]) == ("Ana Torres", "+51987654321")
    assert body["preferences"]["style"] == "clásico"
    assert body["preferences"]["budget_max"] == {"amount": 900000, "currency": "PEN"}
    assert body["privacy_accepted_at"] is None


def test_accept_privacy_version_sets_server_time(client: TestClient) -> None:
    before = datetime.now(UTC)

    response = client.patch(
        ME, headers=auth_header(make_token(SUB)), json={"accept_privacy_version": " 2026-10 "}
    )

    body = response.json()
    accepted_at = datetime.fromisoformat(body["privacy_accepted_at"])
    assert body["privacy_version"] == "2026-10"
    assert body["privacy_accepted_at"].endswith("Z")
    assert before <= accepted_at <= datetime.now(UTC)


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"role": "admin"}, id="role"),
        pytest.param({"user_id": str(uuid4())}, id="user_id"),
        pytest.param({"privacy_version": "2026-10"}, id="privacy_version"),
        pytest.param({"privacy_accepted_at": "2026-10-26T20:00:00Z"}, id="privacy_accepted_at"),
        pytest.param({"phone": "12-34"}, id="telefono"),
        pytest.param({"full_name": "   "}, id="nombre-vacio"),
        pytest.param(
            {"preferences": {"budget_min": {"amount": 2}, "budget_max": {"amount": 1}}},
            id="presupuesto-invertido",
        ),
        pytest.param({"preferences": {"budget_min": {"amount": -1}}}, id="importe-negativo"),
        pytest.param({"preferences": {"budget_min": {"amount": 1.5}}}, id="importe-decimal"),
        pytest.param({"preferences": {"budget_min": {"amount": 1, "currency": "USD"}}}, id="usd"),
        pytest.param({"preferences": {"style": "   "}}, id="estilo-vacio"),
        pytest.param({"preferences": {"style": "a" * 41}}, id="estilo-largo"),
        pytest.param({"preferences": {"materials": ["  "]}}, id="material-vacio"),
        pytest.param({"preferences": {"materials": ["x"] * 11}}, id="demasiados-materiales"),
        pytest.param({"preferences": None}, id="preferencias-null"),
        pytest.param({"marketing_opt_in": None}, id="marketing-null"),
        pytest.param({"marketing_opt_in": "yes"}, id="marketing-yes"),
        pytest.param({"marketing_opt_in": "true"}, id="marketing-texto"),
        pytest.param({"accept_privacy_version": "   "}, id="version-vacia"),
        pytest.param({"accept_privacy_version": "x" * 21}, id="version-larga"),
    ],
)
def test_patch_me_rejects_invalid_or_forbidden_fields(
    client: TestClient, profiles: InMemoryProfiles, payload: dict[str, object]
) -> None:
    response = client.patch(ME, headers=auth_header(make_token(SUB)), json=payload)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert profiles.get(USER_ID) == Profile(USER_ID, Role.CUSTOMER, T0, T0)  # sin cambios


# Cada texto de entrada con \u escapes en el JSON: NUL, un Cc que un split ocultaría y un
# sustituto suelto. Sin el rechazo, el NUL y el sustituto acaban en un 500 de PostgreSQL.
TEXT_FIELDS = {
    "full_name": {"full_name": "Ana{}"},
    "phone": {"phone": "987654321{}"},
    "style": {"preferences": {"style": "clásico{}"}},
    "materials": {"preferences": {"materials": ["acero{}"]}},
    "accept_privacy_version": {"accept_privacy_version": "2026-10{}"},
}


@pytest.mark.parametrize("escape", ["\\u0000", "\\t", "\\ud800"], ids=["nul", "tab", "sustituto"])
@pytest.mark.parametrize("template", TEXT_FIELDS.values(), ids=TEXT_FIELDS.keys())
def test_patch_me_rejects_control_characters_in_every_text(
    client: TestClient, profiles: InMemoryProfiles, template: dict[str, object], escape: str
) -> None:
    body = json.dumps(template, ensure_ascii=False).replace("{}", escape)

    assert raw_patch(client, body) == 422
    assert profiles.get(USER_ID) == Profile(USER_ID, Role.CUSTOMER, T0, T0)


def test_openapi_declares_the_common_error_format() -> None:
    operations = create_app().openapi()["paths"][ME]

    assert set(operations["get"]["responses"]) == {"200", "401", "503"}
    assert set(operations["patch"]["responses"]) == {"200", "401", "422", "503"}
    for operation in operations.values():
        for status, response in operation["responses"].items():
            if status != "200":
                schema = response["content"]["application/json"]["schema"]
                assert schema == {"$ref": "#/components/schemas/ErrorOut"}
    assert "HTTPValidationError" not in json.dumps(operations)


def test_require_admin_rejects_customer_with_403(client: TestClient) -> None:
    response = client.get("/test/admin", headers=auth_header(make_token(SUB)))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_require_admin_lets_admin_through(client: TestClient, profiles: InMemoryProfiles) -> None:
    profiles.add_if_absent(USER_ID)
    profiles.rows[USER_ID] = replace(profiles.rows[USER_ID], role=Role.ADMIN)

    response = client.get("/test/admin", headers=auth_header(make_token(SUB)))

    assert response.status_code == 200
    assert response.json() == {"user_id": SUB}


def test_require_admin_without_token_is_401(client: TestClient) -> None:
    assert client.get("/test/admin").status_code == 401
