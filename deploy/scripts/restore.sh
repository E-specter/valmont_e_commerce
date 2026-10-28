#!/bin/sh
# Restaura una copia CIFRADA de scripts/backup.sh en un stack NUEVO (T-103, RNF12, D-030). Es destructivo.
#   1. Crea el stack vacío, sin migrate.sh:
#        docker compose -p <proyecto> -f deploy/compose.yml up -d --wait
#      Para probar en paralelo con otro proyecto, usa otros HTTP_PORT, HTTPS_PORT, MAILPIT_PORT y un
#      PUBLIC_URL con el puerto nuevo (variables de entorno, que pesan más que deploy/.env), y el mismo
#      deploy/.env. Expórtalas también para este script.
#   2. sh deploy/scripts/restore.sh [-p proyecto] [--sobrescribir] --confirmo-restaurar <valmont-MARCA.tar.gpg>
#      -p                     proyecto de Compose del stack de destino (por defecto, el name: de compose.yml)
#      --confirmo-restaurar   obligatorio: sin él no se toca nada
#      --sobrescribir         permite restaurar sobre un destino con datos: BORRA el esquema app y los
#                             datos de auth y storage del destino (las tablas donde postgres puede hacer
#                             TRUNCATE) antes de cargar la copia
#      Junto a la copia debe estar valmont-MARCA.tar.gpg.sha256 (no renombres ninguno de los dos). Hace falta
#      la clave PRIVADA de BACKUP_GPG_RECIPIENT en el llavero (GNUPGHOME): gpg puede pedir su frase de paso.
# Todo lo que puede fallar se comprueba ANTES de la primera escritura en el destino: suma del archivo cifrado,
# proyecto de Compose, volumen de Storage, imagen de apoyo, permiso para session_replication_role, destino
# vacío, contraseñas de deploy/.env, descifrado, sumas internas y versión de Postgres igual a la del MANIFEST.
# Las imágenes del MANIFEST que difieran de las del destino solo dan un aviso.
# Orden de la carga (guía "Restore a Platform Project to Self-Hosted" de Supabase: esquema, luego datos con
# `SET session_replication_role = replica`, todo con --single-transaction y ON_ERROR_STOP):
#   a. crea el rol valmont_app (como la migración 0006), para que los permisos de la copia lo encuentren;
#   b. esquema app completo, desde db-app.dump (--no-owner: los objetos son del usuario postgres), sin las
#      ACL de la extensión unaccent, que son de supabase_admin;
#   c. datos de auth y storage, con los disparadores desactivados (replica), como indica la guía de
#      Supabase, para que cargar filas ya existentes no vuelva a ejecutar los disparadores de esas tablas;
#   d. archivos de Storage en el volumen, con sus atributos extendidos (ver backup.sh);
#   e. scripts/migrate.sh: migraciones pendientes (ninguna si la copia es de la misma versión),
#      LOGIN y contraseña de valmont_app desde deploy/.env y bucket products.
# Usa las mismas versiones de imagen que la copia (MANIFEST: commit). No restaura deploy/.env: los usuarios
# conservan su contraseña y, con otras claves de firma, los access tokens ya emitidos dejan de valer; pero la
# copia lleva refresh tokens vigentes y secretos MFA (auth.refresh_tokens, auth.mfa_factors) que siguen
# sirviendo tras restaurar. Trata la copia, y el stack restaurado, como credenciales.
# El texto en claro vive solo en un temporal mktemp -d (700, en TMPDIR) que se borra al salir, también con
# INT, TERM y HUP. Si falla tras la primera escritura avisa de que la restauración quedó incompleta: recrea
# el stack vacío (puerta D-011) y repite; no hay vuelta atrás parcial.
# La copia va cifrada, no firmada: quien pudiera escribir en el destino de copias y tuviera la clave pública
# podría fabricar una. Las sumas detectan corrupción, no autoría.
set -eu
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV
umask 077

here=$(cd "$(dirname "$0")/.." && pwd)
helper_img=${BACKUP_HELPER_IMAGE:-node:26.12.1-trixie-slim}
confirmed=0
overwrite=0
src=
work=
touched=0
phase=
staged=0
stage=/tmp/valmont-restore

usage() {
  echo "Uso: sh deploy/scripts/restore.sh [-p proyecto] [--sobrescribir] --confirmo-restaurar <valmont-MARCA.tar.gpg>" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case $1 in
    -p)
      [ $# -ge 2 ] || usage
      COMPOSE_PROJECT_NAME=$2
      export COMPOSE_PROJECT_NAME
      shift 2
      ;;
    --confirmo-restaurar) confirmed=1; shift ;;
    --sobrescribir) overwrite=1; shift ;;
    -*) usage ;;
    *) [ -z "$src" ] || usage; src=$1; shift ;;
  esac
done
[ -n "$src" ] || usage
[ -f "$src" ] || { echo "No existe el archivo de la copia: $src" >&2; exit 1; }
[ -f "$src.sha256" ] || { echo "Falta $src.sha256 junto a la copia." >&2; exit 1; }
src_dir=$(cd "$(dirname "$src")" && pwd)
src_name=$(basename "$src")
if [ "$confirmed" -ne 1 ]; then
  echo "Restaurar es destructivo: carga la copia $src_name en la BD y el volumen de Storage del destino." >&2
  echo "Repite con --confirmo-restaurar." >&2
  exit 2
fi
command -v gpg >/dev/null 2>&1 || { echo "No encuentro gpg: instala GnuPG (viene con Git para Windows)." >&2; exit 1; }

cd "$here"
[ -f .env ] || { echo "Falta deploy/.env: debe ser el del stack de destino." >&2; exit 1; }
compose() { docker compose -f compose.yml --env-file .env "$@"; }
psql_db() { compose exec -T db psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

# Tras la primera escritura, una salida con error deja el destino a medias y se avisa. Las señales se
# convierten en salida para que este trap también borre el temporal en claro.
cleanup() {
  rc=$?
  [ -z "$work" ] || rm -rf "$work"
  if [ "$staged" -eq 1 ]; then
    compose exec -T db rm -rf "$stage" </dev/null >/dev/null 2>&1 || true
  fi
  if [ "$rc" -ne 0 ] && [ "$touched" -eq 1 ]; then
    if [ "$phase" = borrado ]; then
      # El borrado va en una sola transacción: si falla, el destino sigue como estaba.
      echo "FALLÓ EL BORRADO de --sobrescribir y se revirtió: el destino no ha cambiado." >&2
      echo "Corrige la causa que indica el error o recrea el stack vacío (puerta D-011)." >&2
    else
      echo "RESTAURACIÓN INCOMPLETA: el destino quedó a medias. Recrea el stack vacío (puerta D-011) o repite con --sobrescribir." >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Copia: $src_name"
echo "Comprobando la suma SHA-256 del archivo cifrado..."
(cd "$src_dir" && sha256sum -c --quiet "$src_name.sha256")

# --- Pre-vuelo del destino: solo lecturas ---
db_id=$(compose ps -q db)
st_id=$(compose ps -q storage)
if [ -z "$db_id" ] || [ -z "$st_id" ]; then
  echo "El stack de destino no está arrancado: db y storage deben estar en marcha." >&2
  exit 1
fi
# El contenedor debe pertenecer al proyecto pedido (Compose guarda el nombre normalizado en minúsculas).
proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db_id")
if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
  want=$(printf '%s' "$COMPOSE_PROJECT_NAME" | tr 'A-Z' 'a-z')
  [ "$proj" = "$want" ] || { echo "El contenedor db es del proyecto '$proj', no de '$COMPOSE_PROJECT_NAME'." >&2; exit 1; }
fi
echo "Destino: proyecto Compose $proj"
vol=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/storage"}}{{.Name}}{{end}}{{end}}' "$st_id")
[ -n "$vol" ] || { echo "No encuentro el volumen de Storage del destino." >&2; exit 1; }
# migrate.sh, al final, necesita estas dos contraseñas; mejor saberlo antes de escribir nada.
for v in POSTGRES_PASSWORD VALMONT_APP_DB_PASSWORD; do
  grep -q "^$v=." .env || { echo "Falta $v en deploy/.env: lo necesita migrate.sh al final." >&2; exit 1; }
done
docker image inspect "$helper_img" >/dev/null 2>&1 || docker pull -q "$helper_img"
# Sonda sin efectos: la carga de auth y storage necesita poder desactivar los disparadores.
psql_db -c 'SET session_replication_role = replica' </dev/null >/dev/null
ready=$(psql_db -c "select to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null" </dev/null)
[ "$ready" = t ] || { echo "Auth y Storage aún no crearon sus tablas: espera a que estén healthy (docker compose ps)." >&2; exit 1; }
used=$(psql_db -c "select to_regnamespace('app') is not null or exists (select 1 from auth.users) or exists (select 1 from storage.buckets) or exists (select 1 from storage.objects)" </dev/null)
# Solo "f" cuenta como vacío: cualquier otro valor se trata como destino con datos.
if [ "$used" != f ] && [ "$overwrite" -ne 1 ]; then
  echo "El destino ya tiene datos (esquema app, usuarios o Storage; ¿ejecutaste migrate.sh?)." >&2
  echo "Restaura en un stack recién creado. Para sobrescribir a propósito, añade --sobrescribir." >&2
  exit 1
fi

# --- Descifrado y comprobaciones de la copia ---
work=$(mktemp -d)
# El texto en claro nunca debe quedar junto a las copias: si TMPDIR apunta a su carpeta, aborta.
case $work/ in
  "${src_dir%/}"/*) echo "El temporal en claro ($work) cae dentro de la carpeta de las copias: cambia TMPDIR." >&2; exit 1 ;;
esac
p=$work/payload
mkdir "$p"
echo "Descifrando (gpg puede pedir la frase de paso de la clave privada)..."
gpg --decrypt --output "$work/valmont.tar" "$src"
# Solo estos cinco nombres: tar rechaza rutas absolutas y con .., pero así no extrae nada más.
tar -xf "$work/valmont.tar" -C "$p" db-app.dump db-supabase-data.dump storage-objects.tar.gz MANIFEST SHA256SUMS
rm -f "$work/valmont.tar"
# Los cinco miembros deben ser archivos regulares: un enlace simbólico podría apuntar fuera del temporal.
for f in db-app.dump db-supabase-data.dump storage-objects.tar.gz MANIFEST SHA256SUMS; do
  { [ -f "$p/$f" ] && [ ! -L "$p/$f" ]; } || { echo "La copia trae '$f' y no es un archivo regular." >&2; exit 1; }
done
echo "Comprobando las sumas internas..."
(cd "$p" && sha256sum -c --quiet SHA256SUMS)
cat "$p/MANIFEST"
want_pg=$(sed -n 's/^postgres=//p' "$p/MANIFEST")
have_pg=$(psql_db -c 'show server_version' </dev/null)
if [ -z "$want_pg" ] || [ "$have_pg" != "$want_pg" ]; then
  echo "Versión de Postgres distinta: la copia es de '$want_pg' y el destino de '$have_pg'." >&2
  echo "Levanta el destino con las mismas imágenes que la copia (MANIFEST: commit)." >&2
  exit 1
fi
# Solo un aviso: la misma versión de Postgres no garantiza las mismas de Auth y Storage (sus tablas cambian).
want_img=$(sed -n 's/^imagen=//p' "$p/MANIFEST" | sort)
have_img=$(compose config --images | sort)
if [ "$want_img" != "$have_img" ]; then
  echo "AVISO: las imágenes del destino difieren de las de la copia; sigo adelante." >&2
  echo "Copia:" >&2
  echo "${want_img:-(la copia no registra imágenes)}" >&2
  echo "Destino:" >&2
  echo "$have_img" >&2
fi

# --- Primera escritura ---
touched=1
if [ "$used" != f ]; then
  echo "--sobrescribir: borrando el esquema app y los datos de auth y storage del destino..."
  phase=borrado
  # Los archivos que ya hubiera en el volumen de Storage no se borran: solo se pisan los de igual ruta.
  # Sin CASCADE ni RESTART IDENTITY: las secuencias las fija el setval de la copia (y postgres no es dueño
  # de ellas). Solo se vacían las tablas donde postgres tiene TRUNCATE: las de vectores, que Valmont no usa,
  # quedan fuera. El resto de storage (s3_multipart_*, iceberg_*) sí entra, porque tiene FK a buckets.
  psql_db -1 <<'SQL'
DROP SCHEMA IF EXISTS app CASCADE;
DO $$
DECLARE
    t text;
BEGIN
    SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO t FROM pg_tables
    WHERE ((schemaname = 'auth' AND tablename <> 'schema_migrations')
        OR (schemaname = 'storage' AND tablename <> 'migrations'))
      AND has_table_privilege(format('%I.%I', schemaname, tablename), 'TRUNCATE');
    EXECUTE 'TRUNCATE ' || t;
END $$;
SQL
  phase=
fi

# Mismo rol y mismo criterio que la migración 0006: NOLOGIN; migrate.sh le da LOGIN y contraseña.
psql_db <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valmont_app') THEN
        CREATE ROLE valmont_app NOLOGIN;
    END IF;
END $$;
SQL

# Los volcados pasan por /tmp del contenedor db (con permisos 700) y se borran al terminar, falle o no.
staged=1
compose exec -T db sh -c "rm -rf $stage && mkdir -m 700 $stage" </dev/null
for f in db-app.dump db-supabase-data.dump; do
  compose exec -T db sh -c "cat > $stage/$f" <"$p/$f"
done

echo "Restaurando el esquema app..."
# -e unaccent arrastra las ACL de sus funciones (extensions FUNCTION unaccent...), que son de supabase_admin y
# no se pueden reconceder como postgres ("grant options cannot be granted back to your own grantor"). Se quitan
# de la lista del archivo; la ACL de app.f_unaccent se conserva. Sin tuberías: cada paso es un comando.
compose exec -T db sh -c "pg_restore -l $stage/db-app.dump > $stage/app.all" </dev/null
compose exec -T db sh -c "grep -v ' ACL extensions ' $stage/app.all > $stage/app.list" </dev/null
compose exec -T db pg_restore -h localhost -U postgres -d postgres \
  --single-transaction --exit-on-error --no-owner -L "$stage/app.list" "$stage/db-app.dump" </dev/null

echo "Restaurando usuarios (auth) y metadatos de Storage (storage)..."
compose exec -T db pg_restore --data-only -f "$stage/supabase-data.sql" "$stage/db-supabase-data.dump" </dev/null
# -o /dev/null descarta el ruido de set_config y setval; los errores siguen saliendo por stderr.
compose exec -T db psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q -o /dev/null --single-transaction \
  -c 'SET session_replication_role = replica' -f "$stage/supabase-data.sql" </dev/null

echo "Restaurando los archivos de Storage..."
docker run --rm -i --network none -u 0 --entrypoint tar -v "$vol:/data" "$helper_img" \
  --xattrs --xattrs-include='user.*' --numeric-owner -xzf - -C /data <"$p/storage-objects.tar.gz"

echo "Ejecutando migrate.sh (migraciones pendientes, LOGIN de valmont_app y bucket products)..."
sh "$here/scripts/migrate.sh"

echo "Restauración terminada. Comprueba: inicio de sesión de un usuario de la copia, un producto con su"
echo "imagen (Content-Type image/*, no application/octet-stream) y las filas de app.audit_log."
