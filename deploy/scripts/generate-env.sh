#!/bin/sh
# Genera deploy/.env con secretos aleatorios y las claves de Supabase Auth (ES256), sin imprimirlos.
# Necesita node >= 16 o, si no lo hay, Docker (como utils/add-new-auth-keys.sh de Supabase).
#   sh deploy/scripts/generate-env.sh
set -eu
cd "$(dirname "$0")/.."

if [ -e .env ]; then
  echo "deploy/.env ya existe y no se sobrescribe: con otra POSTGRES_PASSWORD la BD ya creada" >&2
  echo "deja de aceptar a Auth y Storage. Bórralo a mano solo si no hay datos que conservar." >&2
  exit 1
fi

umask 077
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 16 ]; then
  node scripts/generate-env.mjs .env.example .env
else
  # Misma imagen que la del frontend (frontend/Dockerfile); pasa la puerta D-011.
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/deploy" -w /deploy \
    node:26.12.1-trixie-slim node scripts/generate-env.mjs .env.example .env
fi

echo "deploy/.env generado. Revisa SITE_ADDRESS, BIND_ADDRESS, PUBLIC_URL y SMTP_* antes de arrancar."
