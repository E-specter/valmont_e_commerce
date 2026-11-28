"""Administrador de revisión local (T-150, D-050 D-AB3).

    SUPABASE_SERVICE_ROLE_KEY=… uv run python -m valmont.scripts.review_admin

Crea `admin.demo@example.com` en Auth local y deja su perfil con role='admin'. Idempotente: si el
usuario ya existe solo asegura el rol. Se niega a correr si la URL de Supabase no es local o con
ENVIRONMENT=prod. La clave de servicio llega por entorno desde `review-up.sh` y no se imprime
ni se guarda. Revertir: `update app.profiles set role='customer' …` o borrar el usuario.
"""

import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import text

from valmont.shared.config import get_settings
from valmont.shared.db import get_engine

EMAIL = "admin.demo@example.com"
ENV_FILE = Path(__file__).resolve().parents[3] / ".env"
ENV_KEY = "REVIEW_ADMIN_PASSWORD"
PRIVACY_VERSION = "2026-10"


def _password() -> str:
    """La lee de backend/.env; si falta, la genera y la añade ahí (no se versiona ni se imprime)."""
    text_ = ""
    if ENV_FILE.exists():
        with ENV_FILE.open(
            "r", encoding="utf-8", newline=""
        ) as f:  # newline="": conserva los finales
            text_ = f.read()
    match = re.search(rf"^{ENV_KEY}=([^\r\n]*)", text_, re.MULTILINE)
    if match and match.group(1).strip():
        return match.group(1).strip()
    value = secrets.token_urlsafe(18)
    eol = "\r\n" if "\r\n" in text_ else "\n"
    if match:  # línea vacía copiada de .env.example: solo se rellena su valor
        text_ = text_[: match.start(1)] + value + text_[match.end(1) :]
    else:
        text_ += ("" if not text_ or text_.endswith("\n") else eol) + f"{ENV_KEY}={value}{eol}"
    with ENV_FILE.open("w", encoding="utf-8", newline="") as f:
        f.write(text_)
    return value


def main() -> None:
    settings = get_settings()
    url = settings.supabase_url or ""
    if settings.environment == "prod" or urlparse(url).hostname not in {"127.0.0.1", "localhost"}:
        sys.exit(
            "review_admin: solo en local (ENVIRONMENT != prod, Supabase en 127.0.0.1); nada escrito"
        )
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        sys.exit("review_admin: falta SUPABASE_SERVICE_ROLE_KEY en el entorno.")

    password = _password()
    base = f"{url.rstrip('/')}/auth/v1/admin/users"
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def call(method: str, target: str, payload: dict[str, object]) -> None:
        req = urllib.request.Request(
            target, data=json.dumps(payload).encode(), method=method, headers=headers
        )
        urllib.request.urlopen(req, timeout=10).close()

    try:
        call("POST", base, {"email": EMAIL, "password": password, "email_confirm": True})
    except urllib.error.HTTPError as exc:
        if exc.code != 422:  # 422 = el correo ya existe: se alinea su contraseña con .env
            sys.exit(f"review_admin: Auth respondió {exc.code}.")
        with get_engine().connect() as conn:
            uid = conn.execute(
                text("select id from auth.users where email = :e"), {"e": EMAIL}
            ).scalar_one()
        try:
            call("PUT", f"{base}/{uid}", {"password": password})
        except urllib.error.HTTPError as exc2:
            sys.exit(f"review_admin: Auth respondió {exc2.code}.")

    with get_engine().begin() as conn:
        user_id = conn.execute(
            text("select id from auth.users where email = :e"), {"e": EMAIL}
        ).scalar_one()
        conn.execute(
            text(
                "insert into app.profiles "
                "(user_id, role, birth_date, privacy_version, privacy_accepted_at) "
                "values (:u, 'admin', date '1990-01-01', :p, now()) "
                "on conflict (user_id) do update set role = 'admin'"
            ),
            {"u": user_id, "p": PRIVACY_VERSION},
        )
    print(f"review_admin: {EMAIL} listo (role=admin)")


if __name__ == "__main__":
    main()
