"""Ayudas de prueba de identity: repositorio en memoria, JWKS falso y tokens ES256 de prueba."""

import hashlib
import hmac
import json
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from jwt.algorithms import ECAlgorithm
from jwt.utils import base64url_encode

from valmont.modules.identity.domain import Profile, Role
from valmont.shared import auth
from valmont.shared.config import Settings

T0 = datetime(2026, 10, 26, 19, 58, tzinfo=UTC)
SUPABASE_URL = "http://supabase.test"
ISSUER = f"{SUPABASE_URL}/auth/v1"
KID = "test-key"
# Claves EC P-256 generadas para la sesión de pruebas: nunca las de Supabase.
SIGNING_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())
JWKS = {
    "keys": [
        ECAlgorithm.to_jwk(SIGNING_KEY.public_key(), as_dict=True)
        | {"kid": KID, "alg": "ES256", "use": "sig"}
    ]
}


class InMemoryProfiles:
    def __init__(self) -> None:
        self.rows: dict[UUID, Profile] = {}

    def add_if_absent(self, user_id: UUID) -> None:
        self.rows.setdefault(user_id, Profile(user_id, Role.CUSTOMER, T0, T0))

    def get(self, user_id: UUID) -> Profile:
        return self.rows[user_id]

    def update(self, user_id: UUID, values: Mapping[str, object]) -> Profile:
        self.rows[user_id] = replace(self.rows[user_id], **values)
        return self.rows[user_id]


class StaticJWKClient(jwt.PyJWKClient):
    """El cliente real de PyJWT con el JWKS en memoria; jwks=None simula Auth caído."""

    def __init__(self, jwks: dict[str, Any] | None) -> None:
        super().__init__(f"{ISSUER}/.well-known/jwks.json", cache_keys=True)
        self._jwks = jwks

    def fetch_data(self) -> Any:
        if self._jwks is None:
            raise jwt.PyJWKClientConnectionError("Fail to fetch data from the url")
        return self._jwks


def claims_for(sub: object, **claims: object) -> dict[str, object]:
    """Claims al estilo Supabase; un claim con valor None se omite."""
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "iss": ISSUER,
        "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
        "role": "authenticated",
        "email": "ana@example.com",
    } | claims
    return {k: v for k, v in payload.items() if v is not None}


def make_token(
    sub: object,
    *,
    key: Any = SIGNING_KEY,
    algorithm: str = "ES256",
    kid: str = KID,
    **claims: object,
) -> str:
    return jwt.encode(claims_for(sub, **claims), key, algorithm, headers={"kid": kid})


def hs256_signed_with_public_key(sub: object) -> str:
    """Ataque de confusión de algoritmo: HS256 con la clave pública (PEM) como secreto.

    PyJWT se niega a firmarlo, así que se arma a mano.
    """
    secret = SIGNING_KEY.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    header = {"alg": "HS256", "typ": "JWT", "kid": KID}
    signing_input = b".".join(
        base64url_encode(json.dumps(part).encode()) for part in (header, claims_for(sub))
    )
    signature = hmac.new(secret, signing_input, hashlib.sha256).digest()
    return (signing_input + b"." + base64url_encode(signature)).decode()


def use_test_auth(
    monkeypatch: pytest.MonkeyPatch,
    jwks: dict[str, Any] | None = JWKS,
    **settings: str | None,
) -> None:
    """Sustituye Settings y el cliente JWKS de shared/auth; nunca usa backend/.env."""
    values = {"supabase_url": SUPABASE_URL, "supabase_jwt_issuer": None} | settings
    test_settings = Settings(_env_file=None, **values)
    monkeypatch.setattr(auth, "get_settings", lambda: test_settings)
    monkeypatch.setattr(auth, "get_jwks_client", lambda: StaticJWKClient(jwks))
