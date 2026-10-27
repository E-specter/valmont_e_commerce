#!/bin/sh
# Migraciones y pasos posteriores del despliegue (T-100, D-029). Idempotente: se repite tras cada
# actualización. Requiere el stack arrancado (docker compose -f deploy/compose.yml up -d).
#   sh deploy/scripts/migrate.sh
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Falta deploy/.env: genéralo con scripts/generate-env.sh." >&2; exit 1; }
# Lectura puntual de deploy/.env: no se hace `source` (los JSON y los textos con espacios no son sh).
env_get() { grep "^$1=" .env | cut -d= -f2- | tr -d '\r'; }
compose() { docker compose -f compose.yml --env-file .env "$@"; }

owner_pw=$(env_get POSTGRES_PASSWORD)
app_pw=$(env_get VALMONT_APP_DB_PASSWORD)
if [ -z "$owner_pw" ] || [ -z "$app_pw" ]; then
  echo "Faltan POSTGRES_PASSWORD o VALMONT_APP_DB_PASSWORD en deploy/.env." >&2
  exit 1
fi
# Solo hexadecimal (generate-env.sh): así van sin escapar en la URL y entre comillas en SQL.
case "$owner_pw$app_pw" in
  *[!0-9a-f]*) echo "Las contraseñas de deploy/.env deben ser hexadecimales." >&2; exit 1 ;;
esac

# 1. Migraciones con el rol propietario (postgres), solo en este comando: el servicio backend usa
#    valmont_app. La URL viaja en el entorno (-e sin valor), no en los argumentos de `docker`.
DATABASE_URL="postgresql+psycopg://postgres:${owner_pw}@db:5432/postgres"
export DATABASE_URL
compose run --rm -e DATABASE_URL backend alembic upgrade head

# 2. Pasos posteriores, con el mismo rol propietario, por psql dentro del contenedor db (PGPASSWORD
#    ya está en su entorno). La contraseña de valmont_app entra por stdin, nunca en argumentos, y
#    el servidor no la registra (log_min_messages=fatal en compose.yml).
#
#    CONNECT en las BD ajenas: no se revoca. En este stack la única BD con datos es `postgres`, la
#    de la app, donde valmont_app lo necesita (lo comprueba el bloque de abajo). No se crea
#    `_supabase` (sin analytics ni supavisor), template0 no admite conexiones y en template1 el rol
#    no tiene nada que leer. Revocar CONNECT a PUBLIC en `postgres` cortaría a los roles de Supabase
#    que entran por PUBLIC (authenticator, supabase_auth_admin, supabase_storage_admin). Si algún día
#    se añade otra BD al clúster: REVOKE CONNECT ON DATABASE <bd> FROM PUBLIC y GRANT a sus roles.
{
  printf '%s\n' "\\set pw '$app_pw'"
  cat <<'SQL'
DO $$
BEGIN
    IF to_regrole('valmont_app') IS NULL THEN
        RAISE EXCEPTION 'No existe el rol valmont_app: falta la migración 0006.';
    END IF;
    -- PostgreSQL 16+: cambiar LOGIN o la contraseña de otro rol exige CREATEROLE y ADMIN sobre él.
    -- Quien lo creó (el propietario, al correr la migración 0006) recibe ADMIN automáticamente.
    IF NOT (SELECT rolsuper OR (rolcreaterole
                AND pg_has_role(current_user, 'valmont_app', 'MEMBER WITH ADMIN OPTION'))
            FROM pg_roles WHERE rolname = current_user) THEN
        RAISE EXCEPTION '% necesita CREATEROLE y ADMIN sobre valmont_app.', current_user;
    END IF;
    IF NOT has_database_privilege('valmont_app', current_database(), 'CONNECT') THEN
        RAISE EXCEPTION 'valmont_app no tiene CONNECT en la BD %.', current_database();
    END IF;
    IF to_regclass('storage.buckets') IS NULL THEN
        RAISE EXCEPTION 'Storage aún no creó su esquema: espera a que el servicio storage esté healthy.';
    END IF;
END $$;

ALTER ROLE valmont_app LOGIN PASSWORD :'pw';

-- Bucket de las imágenes de producto, igual que [storage.buckets.products] de supabase/config.toml
-- (D-019): público, 5 MiB, JPEG, PNG o WebP.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('products', 'products', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
SQL
} | compose exec -T db psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q

echo "Migraciones aplicadas; valmont_app con LOGIN y el bucket products listos."
