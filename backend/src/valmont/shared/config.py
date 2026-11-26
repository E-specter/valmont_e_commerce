from functools import cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # extra="ignore": el .env lleva claves que aún no son campos (p. ej. las de otras tareas).
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["dev", "test", "prod"] = "dev"
    log_level: str = "INFO"
    database_url: str | None = None
    test_database_url: str | None = None
    # Dónde el backend alcanza Supabase Auth (su JWKS) y qué `iss` llevan los tokens. Son dos
    # porque en producción Auth se alcanza por la red interna y el emisor es la URL pública.
    supabase_url: str | None = None
    supabase_jwt_issuer: str | None = None  # None → f"{supabase_url}/auth/v1"
    # Base de las URL públicas de Storage que ve el navegador (SPEC catalog §6). None → supabase_url
    storage_public_url: str | None = None
    # Sube y borra imágenes (D-019). Salta RLS: SecretStr para que no salga en repr ni en logs.
    supabase_service_role_key: SecretStr | None = None
    # Boutique del recojo en tienda (orders, H-1). Sin secretos; si falta alguno, no hay recojo.
    pickup_store_name: str | None = None
    pickup_store_address: str | None = None
    pickup_store_hours: str | None = None


@cache
def get_settings() -> Settings:
    return Settings()
