"""`scripts/review-up.sh` (T-150): el paso del admin no aborta y no filtra la service_role.

Se extrae el bloque real (de `sr="$(` a `unset sr`) y se ejecuta con `npx` y `uv` falsos.
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "review-up.sh"
FAKE_KEY = "svc-fake-key-0000"
# Salida de `supabase status -o env` en Windows: valor entre comillas y CRLF
STATUS_CRLF = "printf 'SERVICE_ROLE_KEY=\"" + FAKE_KEY + "\"\\r\\n'"
UV_RECORDS_KEY = 'printf "%s" "${SUPABASE_SERVICE_ROLE_KEY:-}" > "$UV_SEEN"'
TAIL = 'echo CONTINUA\necho "global=[${SUPABASE_SERVICE_ROLE_KEY:-}]"'


def _block() -> str:
    src = SCRIPT.read_text(encoding="utf-8")
    match = re.search(r'^sr="\$\(.*?^unset sr$', src, re.MULTILINE | re.DOTALL)
    assert match, "no se encontró el bloque del admin de revisión en review-up.sh"
    return match.group(0)


def _fake_bin(directory: Path, name: str, body: str) -> None:
    path = directory / name
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8", newline="\n")
    path.chmod(0o755)


def _run(tmp_path, npx_body: str, uv_body: str = UV_RECORDS_KEY):
    bash = shutil.which("bash")
    if not bash:
        pytest.fail("Hace falta bash (Git Bash) para probar review-up.sh", pytrace=False)
    fake = tmp_path / "bin"
    fake.mkdir()
    _fake_bin(fake, "npx", npx_body)
    _fake_bin(fake, "uv", uv_body)
    work = tmp_path / "work"
    (work / "backend").mkdir(parents=True)
    seen = tmp_path / "uv_seen"
    script = f"set -euo pipefail\n{_block()}\n{TAIL}\n"
    env = {**os.environ, "PATH": f"{fake}{os.pathsep}{os.environ['PATH']}", "UV_SEEN": str(seen)}
    env.pop("SUPABASE_SERVICE_ROLE_KEY", None)
    proc = subprocess.run(
        [bash, "-c", script], cwd=work, env=env, capture_output=True, text=True, timeout=60
    )
    return proc, seen


def test_failed_supabase_status_warns_and_script_continues(tmp_path):
    proc, seen = _run(tmp_path, "exit 1")
    assert proc.returncode == 0
    assert "CONTINUA" in proc.stdout
    assert "sin SERVICE_ROLE_KEY" in proc.stderr
    assert not seen.exists()  # review_admin no se lanzó


def test_status_without_key_warns_and_continues(tmp_path):
    proc, _ = _run(tmp_path, 'echo "API_URL=http://127.0.0.1:54321"')
    assert proc.returncode == 0 and "CONTINUA" in proc.stdout
    assert "sin SERVICE_ROLE_KEY" in proc.stderr


def test_key_reaches_child_only_and_never_the_output(tmp_path):
    proc, seen = _run(tmp_path, STATUS_CRLF)
    assert proc.returncode == 0 and "CONTINUA" in proc.stdout
    assert seen.read_text() == FAKE_KEY  # el hijo la recibió, sin comillas ni \r
    assert "global=[]" in proc.stdout  # no queda exportada ni definida
    assert FAKE_KEY not in proc.stdout + proc.stderr


def test_review_admin_failure_warns_and_continues(tmp_path):
    proc, _ = _run(tmp_path, STATUS_CRLF, uv_body="exit 1")
    assert proc.returncode == 0 and "CONTINUA" in proc.stdout
    assert "no se pudo crear" in proc.stderr
    assert FAKE_KEY not in proc.stdout + proc.stderr


def test_script_has_no_trace_export_or_key_echo():
    src = SCRIPT.read_text(encoding="utf-8")
    assert not re.search(r"set\s+-\w*x|xtrace|^\s*export\s", src, re.MULTILINE)
    assert not re.search(r"echo[^\n]*\$\{?sr\b|\$\{?sr\}?\s*>", src)
