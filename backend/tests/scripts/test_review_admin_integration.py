"""Integración de `review_admin` contra el stack local (T-150): Auth real y BD de desarrollo.

Requiere `npm run db:start` y SUPABASE_SERVICE_ROLE_KEY en backend/.env. No toca el `.env` real:
usa una copia temporal sembrada con REVIEW_ADMIN_PASSWORD (si ya existe) para no cambiar la
contraseña de un admin.demo previo. No toca a ningún otro usuario (se comprueba).
"""

import json
import os
import urllib.request

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from valmont.main import app
from valmont.scripts import review_admin as ra
from valmont.shared.config import get_settings
from valmont.shared.db import get_engine

pytestmark = pytest.mark.integration

HINT = "Arranca Supabase: npm run db:start; y SUPABASE_SERVICE_ROLE_KEY en backend/.env"


def _real_password() -> str | None:
    if not ra.ENV_FILE.exists():
        return None
    for line in ra.ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{ra.ENV_KEY}=") and line.partition("=")[2].strip():
            return line.partition("=")[2].strip()
    return None


def _login(base: str, apikey: str, password: str) -> urllib.request.addinfourl:
    req = urllib.request.Request(
        f"{base}/auth/v1/token?grant_type=password",
        data=json.dumps({"email": ra.EMAIL, "password": password}).encode(),
        method="POST",
        headers={"apikey": apikey, "Content-Type": "application/json"},
    )
    return urllib.request.urlopen(req, timeout=10)  # type: ignore[return-value]


def test_review_admin_is_idempotent_and_yields_a_working_admin(tmp_path, monkeypatch):
    settings = get_settings()
    key = settings.supabase_service_role_key
    if not (key and settings.supabase_url):
        pytest.fail(HINT, pytrace=False)
    service_key = key.get_secret_value()
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", service_key)

    env_copy = tmp_path / ".env"
    existing = _real_password()
    env_copy.write_text(
        "ENVIRONMENT=dev\n" + (f"REVIEW_ADMIN_PASSWORD={existing}\n" if existing else ""),
        encoding="utf-8",
    )
    monkeypatch.setattr(ra, "ENV_FILE", env_copy)

    others_sql = text("select id, email, updated_at from auth.users where email <> :e order by id")
    with get_engine().connect() as conn:
        others_before = conn.execute(others_sql, {"e": ra.EMAIL}).all()

    ra.main()
    after_first = env_copy.read_bytes()
    ra.main()

    # Idempotencia: el .env no cambia en la segunda ejecución
    assert env_copy.read_bytes() == after_first
    password = next(
        ln.partition("=")[2]
        for ln in env_copy.read_text(encoding="utf-8").splitlines()
        if ln.startswith("REVIEW_ADMIN_PASSWORD=")
    )
    assert password

    with get_engine().connect() as conn:
        rows = conn.execute(
            text(
                "select u.id, p.role from auth.users u "
                "left join app.profiles p on p.user_id = u.id where u.email = :e"
            ),
            {"e": ra.EMAIL},
        ).all()
        others_after = conn.execute(others_sql, {"e": ra.EMAIL}).all()
    assert len(rows) == 1  # una sola fila en auth.users
    assert rows[0].role == "admin"
    assert others_after == others_before  # ningún otro usuario cambió

    # Inicio de sesión con la contraseña del .env
    apikey = os.environ.get("SUPABASE_ANON_KEY") or service_key
    with _login(settings.supabase_url, apikey, password) as resp:
        assert resp.status == 200
        access = json.loads(resp.read())["access_token"]

    # La API lo reconoce como admin
    me = TestClient(app).get("/api/v1/identity/me", headers={"Authorization": f"Bearer {access}"})
    assert me.status_code == 200
    assert me.json()["role"] == "admin"
