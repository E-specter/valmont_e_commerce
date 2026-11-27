#!/usr/bin/env bash
# Revisión manual (D-034): levanta el stack de desarrollo desde la copia de `main` e imprime las URLs.
# Idempotente: Supabase y el frontend no se reinician si ya están en marcha; el backend sí (ver abajo).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

[ "$(git branch --show-current)" = main ] || { echo "Ejecútalo en la copia de main (D-034)." >&2; exit 1; }
[ -f backend/.env ] || { echo "Falta backend/.env (se crea desde backend/.env.example; setup.md §3)." >&2; exit 1; }

up() { curl -s -o /dev/null --max-time 2 "$1"; }
logs="${TMPDIR:-/tmp}"

npm install --no-audit --no-fund --silent   # CLI de Supabase fijada en el package.json raíz (D-011)
npx --no-install supabase status >/dev/null 2>&1 || npm run db:start

(cd backend && uv sync --quiet && uv run alembic upgrade head)
# El backend se reinicia siempre: tras un fast-forward, el reloader de `fastapi dev` puede seguir con el código anterior.
case "$(uname -s)" in
  # Sin redirigir, PowerShell recibe la tubería de quien llama y el backend la hereda: el script no terminaría.
  MINGW* | MSYS* | CYGWIN*) powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-backend.ps1 >/dev/null 2>&1 </dev/null ;;
  *)
    pkill -f "$PWD/backend/.venv/bin/fastapi" || true
    (cd backend && nohup uv run fastapi dev src/valmont/main.py >"$logs/valmont-backend.log" 2>&1 </dev/null &)
    ;;
esac
sleep 2

(cd frontend && npm install --no-audit --no-fund --silent)
# Sin stderr redirigido, el proceso de astro hereda la tubería y quien llama nunca ve el EOF.
up http://localhost:4321 || (cd frontend && npx astro dev --background >/dev/null 2>&1)

for i in $(seq 1 30); do up http://127.0.0.1:8000/health && up http://localhost:4321 && break; sleep 2; done

echo "main @ $(git log -1 --format='%h %s')"
up http://127.0.0.1:8000/health && echo "API      http://127.0.0.1:8000/docs" || echo "API      NO RESPONDE (log: valmont-backend.log en %TEMP% o $logs)"
up http://localhost:4321 && echo "Tienda   http://localhost:4321" || echo "Tienda   NO RESPONDE (cd frontend && npx astro dev logs)"
echo "Studio   http://127.0.0.1:54323 (Table Editor → esquema app) · Mailpit http://127.0.0.1:54324"
