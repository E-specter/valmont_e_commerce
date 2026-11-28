"""Unitarias de `valmont.scripts.review_admin` (T-150, D-050 D-AB3): sin red ni BD.

Transporte HTTP y motor de BD simulados; `.env` en un directorio temporal.
"""

import json
import logging
import urllib.error
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from valmont.scripts import review_admin as ra

EMAIL = "admin.demo@example.com"
LOCAL_URL = "http://127.0.0.1:54321"
SERVICE_KEY = "svc-role-fake-0000-aaaa-bbbb"
PW_KEY = b"REVIEW_ADMIN_PASSWORD="
STORED_PW = "stored-fake-pw-1234"
UID = "11111111-1111-1111-1111-111111111111"
OTHER_LINES = [
    "ENVIRONMENT=dev",
    "LOG_LEVEL=INFO",
    "# comentario",
    "SUPABASE_URL=http://127.0.0.1:54321",
]


class FakeHttp:
    """Sustituye a `urllib.request.urlopen`: registra cada petición y responde en cola."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.errors: list[int | None] = []  # un código por llamada; None = 200

    def __call__(self, req, timeout=None):
        body = json.loads(req.data) if req.data else None
        self.calls.append(
            {
                "method": req.get_method(),
                "url": req.full_url,
                "headers": {k.lower(): v for k, v in req.header_items()},
                "body": body,
            }
        )
        code = self.errors.pop(0) if self.errors else None
        if code is not None:
            raise urllib.error.HTTPError(req.full_url, code, "fake", {}, None)  # type: ignore[arg-type]
        return SimpleNamespace(close=lambda: None)


class FakeEngine:
    """Registra las sentencias; `select id from auth.users` devuelve UID."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict]] = []

    @contextmanager
    def _conn(self):
        outer = self

        class Conn:
            def execute(self, stmt, params=None):
                outer.statements.append((str(stmt), dict(params or {})))
                return SimpleNamespace(scalar_one=lambda: UID)

        yield Conn()

    connect = _conn
    begin = _conn


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    monkeypatch.setattr(ra, "ENV_FILE", path)
    return path


@pytest.fixture
def http(monkeypatch):
    fake = FakeHttp()
    monkeypatch.setattr(ra.urllib.request, "urlopen", fake)
    return fake


@pytest.fixture
def engine(monkeypatch):
    fake = FakeEngine()
    monkeypatch.setattr(ra, "get_engine", lambda: fake)
    return fake


@pytest.fixture
def configure(monkeypatch):
    def _set(environment="dev", url=LOCAL_URL):
        monkeypatch.setattr(
            ra, "get_settings", lambda: SimpleNamespace(environment=environment, supabase_url=url)
        )

    _set()
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)
    return _set


def _write_env(path, lines):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _env_lines(path):
    return path.read_text(encoding="utf-8").splitlines()


def _pw_from_env(path):
    values = [
        ln.split("=", 1)[1] for ln in _env_lines(path) if ln.startswith("REVIEW_ADMIN_PASSWORD=")
    ]
    assert len(values) == 1
    return values[0]


def _assert_untouched(http, engine, env_file):
    assert http.calls == []
    assert engine.statements == []
    assert not env_file.exists()


# --- 1. Solo local ---------------------------------------------------------------------------


def test_refuses_in_prod(configure, http, engine, env_file):
    configure(environment="prod")
    with pytest.raises(SystemExit) as exc:
        ra.main()
    assert exc.value.code not in (0, None)
    _assert_untouched(http, engine, env_file)


@pytest.mark.parametrize(
    "url",
    [
        "https://x.supabase.co",
        "http://10.0.0.5",
        "http://localhost.evil.com",
        "http://127.0.0.1.evil.com",
        "http://127.0.0.1@evil.com",
        "http://evil.com/127.0.0.1",
        "",
        None,
    ],
)
def test_refuses_non_local_host(configure, http, engine, env_file, url):
    configure(url=url)
    with pytest.raises(SystemExit) as exc:
        ra.main()
    assert exc.value.code not in (0, None)
    _assert_untouched(http, engine, env_file)


@pytest.mark.parametrize("url", ["http://127.0.0.1:54321", "http://localhost:54321"])
def test_accepts_local_hosts(configure, http, engine, env_file, url):
    configure(url=url)
    ra.main()
    assert http.calls[0]["url"] == f"{url}/auth/v1/admin/users"


def test_refuses_without_service_key(configure, http, engine, env_file, monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    with pytest.raises(SystemExit) as exc:
        ra.main()
    assert exc.value.code not in (0, None)
    _assert_untouched(http, engine, env_file)


# --- 2. Contraseña en .env -------------------------------------------------------------------


def test_generates_password_when_env_file_missing(configure, http, engine, env_file):
    ra.main()
    generated = _pw_from_env(env_file)
    assert len(generated) >= 20
    assert http.calls[0]["body"]["password"] == generated


def test_generates_when_missing_and_keeps_other_lines(configure, http, engine, env_file):
    _write_env(env_file, OTHER_LINES)
    ra.main()
    lines = _env_lines(env_file)
    assert lines[: len(OTHER_LINES)] == OTHER_LINES
    assert len(lines) == len(OTHER_LINES) + 1
    assert lines[-1].startswith("REVIEW_ADMIN_PASSWORD=")
    assert http.calls[0]["body"]["password"] == _pw_from_env(env_file)


def test_empty_placeholder_is_replaced_not_duplicated(configure, http, engine, env_file):
    _write_env(env_file, [*OTHER_LINES[:2], "REVIEW_ADMIN_PASSWORD=", OTHER_LINES[2]])
    ra.main()
    lines = _env_lines(env_file)
    assert _pw_from_env(env_file) != ""
    assert [ln for ln in lines if not ln.startswith("REVIEW_ADMIN_PASSWORD")] == [
        *OTHER_LINES[:2],
        OTHER_LINES[2],
    ]


def test_existing_password_is_reused_and_file_not_rewritten(configure, http, engine, env_file):
    _write_env(env_file, [*OTHER_LINES, f"REVIEW_ADMIN_PASSWORD={STORED_PW}"])
    before = env_file.read_bytes()
    ra.main()
    assert env_file.read_bytes() == before
    assert http.calls[0]["body"]["password"] == STORED_PW


def test_two_runs_generate_once_and_keep_env_identical(configure, http, engine, env_file):
    _write_env(env_file, OTHER_LINES)
    ra.main()
    after_first = env_file.read_bytes()
    ra.main()
    assert env_file.read_bytes() == after_first
    bodies = [c["body"]["password"] for c in http.calls if c["method"] == "POST"]
    assert len(bodies) == 2 and bodies[0] == bodies[1]


def test_generated_passwords_differ_between_environments(
    configure, http, engine, env_file, tmp_path, monkeypatch
):
    ra.main()
    first = _pw_from_env(env_file)
    other = tmp_path / "otro.env"
    monkeypatch.setattr(ra, "ENV_FILE", other)
    ra.main()
    assert _pw_from_env(other) != first


# --- 3. Alta y usuario existente -------------------------------------------------------------


def test_new_user_is_created_confirmed_and_profile_upserted_as_admin(
    configure, http, engine, env_file
):
    ra.main()
    assert [c["method"] for c in http.calls] == ["POST"]
    call = http.calls[0]
    assert call["url"] == f"{LOCAL_URL}/auth/v1/admin/users"
    assert call["body"]["email"] == EMAIL
    assert call["body"]["email_confirm"] is True
    upserts = [s for s in engine.statements if "app.profiles" in s[0]]
    assert len(upserts) == 1
    sql, params = upserts[0]
    assert "'admin'" in sql and "on conflict (user_id) do update set role = 'admin'" in sql
    assert params["u"] == UID


def test_existing_user_422_leads_to_put_with_password(configure, http, engine, env_file):
    _write_env(env_file, [f"REVIEW_ADMIN_PASSWORD={STORED_PW}"])
    http.errors = [422]
    ra.main()
    assert [c["method"] for c in http.calls] == ["POST", "PUT"]
    put = http.calls[1]
    assert put["url"] == f"{LOCAL_URL}/auth/v1/admin/users/{UID}"
    assert put["body"] == {"password": STORED_PW}
    lookups = [s for s in engine.statements if "from auth.users" in s[0]]
    assert lookups and all(p == {"e": EMAIL} for _, p in lookups)
    assert any("app.profiles" in s[0] for s in engine.statements)


@pytest.mark.parametrize("code", [400, 401, 403, 500])
def test_other_auth_errors_abort_without_profile_write(configure, http, engine, env_file, code):
    http.errors = [code]
    with pytest.raises(SystemExit) as exc:
        ra.main()
    assert exc.value.code not in (0, None)
    assert [c["method"] for c in http.calls] == ["POST"]
    assert not any("app.profiles" in s[0] for s in engine.statements)


def test_put_failure_aborts_without_profile_write(configure, http, engine, env_file):
    http.errors = [422, 500]
    with pytest.raises(SystemExit) as exc:
        ra.main()
    assert exc.value.code not in (0, None)
    assert not any("app.profiles" in s[0] for s in engine.statements)


# --- 4. Ningún secreto sale ------------------------------------------------------------------


def _assert_no_secret(capsys, caplog, secrets, exit_text=""):
    out, err = capsys.readouterr()
    haystacks = [out, err, caplog.text, exit_text]
    for secret in secrets:
        assert all(secret not in h for h in haystacks)


@pytest.mark.parametrize("scenario", ["new", "existing", "generated", "post_500", "put_500"])
def test_no_password_nor_service_key_in_outputs(
    configure, http, engine, env_file, capsys, caplog, scenario
):
    caplog.set_level(logging.DEBUG)
    if scenario != "generated":
        _write_env(env_file, [f"REVIEW_ADMIN_PASSWORD={STORED_PW}"])
    http.errors = {"existing": [422], "post_500": [500], "put_500": [422, 500]}.get(scenario, [])
    exit_text = ""
    try:
        ra.main()
    except SystemExit as exc:
        exit_text = str(exc.code)
    password = _pw_from_env(env_file)
    _assert_no_secret(capsys, caplog, [password, SERVICE_KEY], exit_text)


def test_refusal_messages_do_not_leak(configure, http, engine, env_file, capsys, caplog):
    configure(environment="prod")
    with pytest.raises(SystemExit) as exc:
        ra.main()
    _assert_no_secret(capsys, caplog, [SERVICE_KEY], str(exc.value.code))


def test_service_key_only_sent_to_local_auth(configure, http, engine, env_file):
    ra.main()
    for call in http.calls:
        assert call["url"].startswith(f"{LOCAL_URL}/auth/v1/admin/users")
        assert call["headers"]["authorization"] == f"Bearer {SERVICE_KEY}"
        assert call["headers"]["apikey"] == SERVICE_KEY


def test_service_key_not_written_to_env_file(configure, http, engine, env_file):
    _write_env(env_file, OTHER_LINES)
    ra.main()
    assert SERVICE_KEY not in env_file.read_text(encoding="utf-8")


# --- 5. Solo toca admin.demo -----------------------------------------------------------------


def test_only_touches_admin_demo(configure, http, engine, env_file):
    http.errors = [422]
    ra.main()
    for call in http.calls:
        if call["method"] == "POST":
            assert call["body"]["email"] == EMAIL
        else:
            assert call["url"].endswith(f"/{UID}")  # el id sale de buscar EMAIL
            assert set(call["body"]) == {"password"}
    for sql, params in engine.statements:
        low = sql.lower()
        assert "delete" not in low and "truncate" not in low and "drop" not in low
        assert set(params) <= {"e", "u", "p"}
        if "from auth.users" in low:
            assert low.count("where email = :e") == 1 and params == {"e": EMAIL}
        else:
            assert "app.profiles" in low and params["u"] == UID
            assert low.count("insert into") == 1 and "update app.profiles" not in low


# --- 6. Finales de línea del .env (bytes) ----------------------------------------------------


def _bytes_env(env_file, eol: bytes, *, trailing=True, placeholder_at=None):
    lines = [ln.encode() for ln in OTHER_LINES]
    if placeholder_at is not None:
        lines.insert(placeholder_at, PW_KEY)
    env_file.write_bytes(eol.join(lines) + (eol if trailing else b""))
    return lines


@pytest.mark.parametrize("eol", [b"\n", b"\r\n"], ids=["LF", "CRLF"])
@pytest.mark.parametrize("trailing", [True, False], ids=["eol-final", "sin-eol-final"])
def test_generation_keeps_other_bytes_and_eol_style(
    configure, http, engine, env_file, eol, trailing
):
    original = _bytes_env(env_file, eol, trailing=trailing)
    ra.main()
    data = env_file.read_bytes()
    head = eol.join(original) + eol
    assert data.startswith(head)  # las demás líneas, byte a byte
    tail = data[len(head) :]
    assert tail.startswith(PW_KEY) and tail.endswith(eol)
    assert tail.count(b"\n") == 1  # solo se añadió esa línea
    assert data.count(b"\r\n") == (data.count(b"\n") if eol == b"\r\n" else 0)  # sin mezclar
    assert http.calls[0]["body"]["password"].encode() == tail[len(PW_KEY) : -len(eol)]


@pytest.mark.parametrize("eol", [b"\n", b"\r\n"], ids=["LF", "CRLF"])
def test_empty_placeholder_only_fills_its_value(configure, http, engine, env_file, eol):
    original = _bytes_env(env_file, eol, placeholder_at=2)
    ra.main()
    value = http.calls[0]["body"]["password"].encode()
    expected = [PW_KEY + value if ln == PW_KEY else ln for ln in original]
    assert env_file.read_bytes() == eol.join(expected) + eol


def test_empty_placeholder_at_end_without_final_eol(configure, http, engine, env_file):
    env_file.write_bytes(b"A=1\nREVIEW_ADMIN_PASSWORD=")
    ra.main()
    assert env_file.read_bytes() == b"A=1\nREVIEW_ADMIN_PASSWORD=" + (
        http.calls[0]["body"]["password"].encode()
    )
