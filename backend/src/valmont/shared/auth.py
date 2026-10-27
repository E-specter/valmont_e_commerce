import logging
from dataclasses import dataclass
from functools import cache
from uuid import UUID

import jwt
from fastapi import HTTPException

from valmont.shared.config import get_settings
from valmont.shared.errors import AppError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TokenClaims:
    user_id: UUID
    email: str | None


def unauthenticated() -> HTTPException:
    # HTTPException y no AppError: AppError no lleva cabeceras. El manejador común la
    # responde como 401 "unauthenticated". Mensaje genérico: no dice qué comprobación falló.
    return HTTPException(401, "Autenticación requerida.", headers={"WWW-Authenticate": "Bearer"})


def _supabase_url() -> str:
    url = get_settings().supabase_url
    if not url:
        raise RuntimeError("Falta SUPABASE_URL en el entorno (backend/.env).")
    return url.rstrip("/")


@cache
def get_jwks_client() -> jwt.PyJWKClient:
    """Claves públicas de Supabase Auth, cacheadas por PyJWT. Las pruebas lo sustituyen."""
    # timeout: sin él urllib espera 30 s por solicitud si Auth no responde.
    url = f"{_supabase_url()}/auth/v1/.well-known/jwks.json"
    return jwt.PyJWKClient(url, cache_keys=True, timeout=5)


def verify_token(token: str) -> TokenClaims:
    """Access token de Supabase Auth. Su claim `role` no es el rol de la app (va en el perfil)."""
    issuer = get_settings().supabase_jwt_issuer or f"{_supabase_url()}/auth/v1"
    try:
        signing_key = get_jwks_client().get_signing_key_from_jwt(token)
        # Solo ES256: un token HS256 firmado con la clave pública como secreto no pasa.
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            issuer=issuer,
            options={"require": ["exp", "sub", "iss"]},
        )
        user_id = UUID(str(claims["sub"]))
    except jwt.PyJWKClientConnectionError as exc:  # antes que PyJWTError: es una subclase
        logger.warning("JWKS de Supabase Auth inalcanzable: %s", exc)
        raise AppError("auth_unavailable", "Autenticación no disponible.", 503) from None
    except jwt.PyJWTError, ValueError:
        raise unauthenticated() from None
    return TokenClaims(user_id, claims.get("email"))
