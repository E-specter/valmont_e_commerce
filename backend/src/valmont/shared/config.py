from functools import cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # extra="ignore": el .env lleva claves que aún no son campos (p. ej. las de otras tareas).
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["dev", "test", "prod"] = "dev"
    log_level: str = "INFO"
    database_url: str | None = None
    test_database_url: str | None = None


@cache
def get_settings() -> Settings:
    return Settings()
