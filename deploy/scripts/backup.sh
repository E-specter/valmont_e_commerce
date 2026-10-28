#!/bin/sh
# Copia de seguridad CIFRADA del stack desplegado (T-103, RNF12, D-030). Requiere el stack arrancado y migrado.
#   BACKUP_GPG_RECIPIENT=<clave> sh deploy/scripts/backup.sh [-p proyecto]
# Variables: BACKUP_GPG_RECIPIENT (obligatoria), BACKUP_DIR (por defecto deploy/backups; mejor otro disco),
# BACKUP_KEEP_DAYS (14), GNUPGHOME (llavero) y TMPDIR (dónde va el temporal en claro).
# Crea en BACKUP_DIR, con marca UTC:
#   valmont-<AAAAMMDDTHHMMSSZ>.tar.gpg         la copia, cifrada
#   valmont-<AAAAMMDDTHHMMSSZ>.tar.gpg.sha256  la suma del archivo cifrado: se comprueba sin la clave
# Dentro del tar cifrado van:
#   db-app.dump             pg_dump -Fc del esquema app, con la extensión unaccent que crean sus migraciones
#   db-supabase-data.dump   pg_dump -Fc --data-only de auth (usuarios) y storage (metadatos de los objetos)
#   storage-objects.tar.gz  los archivos del volumen storage-data, con sus atributos extendidos
#   MANIFEST y SHA256SUMS (la suma de los cuatro anteriores)
# Se restaura con scripts/restore.sh en un stack nuevo.
#
# Cifrado (D-030): a la clave PÚBLICA de BACKUP_GPG_RECIPIENT; la privada se guarda fuera del servidor y
# solo hace falta para restaurar. Sin destinatario, sin gpg o sin una clave pública utilizable el script
# falla antes de tocar Docker. --trust-model always: gpg --batch no cifra a claves sin confianza asignada;
# es aceptable porque el operador importa esa clave a propósito (compara su huella con gpg --fingerprint).
# El texto en claro solo existe en un temporal mktemp -d (permisos 700, en TMPDIR, con sitio para la copia
# sin cifrar) que se borra al salir, también con INT, TERM y HUP; en BACKUP_DIR nunca queda texto en claro.
# Un kill -9 no se puede interceptar: dejaría el temporal, y habría que borrarlo a mano.
#
# Qué incluye y por qué (guía "Restore a Platform Project to Self-Hosted" de Supabase, que usa
# `supabase db dump`; storage-api v1.81.0, src/storage/backend/file.ts):
#   - app: esquema completo (tablas, datos y permisos de valmont_app); lo crean las migraciones de Valmont.
#   - auth y storage: solo los datos. Sus tablas las crean Auth y Storage al arrancar, con sus propietarios
#     y permisos, y `supabase db dump` hace igual. Se excluyen auth.schema_migrations y storage.migrations
#     (cada servicio las rellena al arrancar).
#   - Sin roles: los reservados los crea la imagen (con POSTGRES_PASSWORD) y valmont_app, la migración 0006
#     más scripts/migrate.sh. Volcar roles arrastraría hashes y roles internos que fallan al restaurar.
#   - Archivos de Storage: el volcado SQL no los lleva. Storage guarda content-type y cache-control como
#     atributos extendidos (user.supabase.*) y sin ellos sirve todo como application/octet-stream; solo
#     GNU tar los conserva (--xattrs). Por eso un contenedor Debian de apoyo y no las imágenes de db o
#     storage, que no garantizan GNU tar. Leer un volumen con nombre exige Docker (D-011).
#   - No incluye deploy/.env (son secretos): guárdalo aparte, sin copiarlo junto a las copias.
#   - Los volcados se hacen uno tras otro (no en una sola instantánea) y los archivos al final: una subida
#     nueva puede dejar archivos sin fila en storage.objects (huérfanos, inofensivos), pero un borrado o un
#     reemplazo concurrente puede dejar una fila sin archivo, o con el archivo anterior.
# La copia lleva datos personales, hashes de contraseñas, refresh tokens y secretos MFA; por eso va cifrada.
set -eu
# Git Bash (Windows) convertiría rutas como /data en los argumentos de docker.exe.
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV
umask 077

here=$(cd "$(dirname "$0")/.." && pwd)
out_root=${BACKUP_DIR:-$here/backups}
case $out_root in /* | ?:*) ;; *) out_root=$PWD/$out_root ;; esac
keep_days=${BACKUP_KEEP_DAYS:-14}
[ "$keep_days" -ge 1 ] 2>/dev/null || { echo "BACKUP_KEEP_DAYS debe ser un entero positivo." >&2; exit 1; }
# Mismo tag que frontend/Dockerfile y generate-env.sh: Debian con GNU tar, ya presente tras construir el stack.
helper_img=${BACKUP_HELPER_IMAGE:-node:26.12.1-trixie-slim}
recipient=${BACKUP_GPG_RECIPIENT:-}

while [ $# -gt 0 ]; do
  case $1 in
    -p)
      [ $# -ge 2 ] || { echo "Falta el nombre del proyecto tras -p." >&2; exit 2; }
      COMPOSE_PROJECT_NAME=$2
      export COMPOSE_PROJECT_NAME
      shift 2
      ;;
    *) echo "Uso: BACKUP_GPG_RECIPIENT=<clave> sh deploy/scripts/backup.sh [-p proyecto]" >&2; exit 2 ;;
  esac
done

# D-030: sin cifrado no hay copia. Todo esto falla antes de tocar Docker.
[ -n "$recipient" ] || { echo "Falta BACKUP_GPG_RECIPIENT: la copia solo se hace cifrada (D-030)." >&2; exit 1; }
command -v gpg >/dev/null 2>&1 || { echo "No encuentro gpg: instala GnuPG (viene con Git para Windows)." >&2; exit 1; }
# Un cifrado de prueba comprueba que la clave pública está en el llavero y se puede usar (no caducada ni revocada).
printf 'prueba' | gpg --batch --yes --trust-model always --encrypt --recipient "$recipient" >/dev/null 2>&1 \
  || { echo "No puedo cifrar a '$recipient': importa su clave pública (gpg --import) y revisa gpg --list-keys." >&2; exit 1; }

cd "$here"
[ -f .env ] || { echo "Falta deploy/.env: genéralo con scripts/generate-env.sh." >&2; exit 1; }
compose() { docker compose -f compose.yml --env-file .env "$@"; }
# Dentro del contenedor db, PGPASSWORD ya está en el entorno: ningún secreto viaja en argumentos.
db() { compose exec -T db "$@" </dev/null; }

db_id=$(compose ps -q db)
st_id=$(compose ps -q storage)
if [ -z "$db_id" ] || [ -z "$st_id" ]; then
  echo "El stack no está arrancado: db y storage deben estar en marcha." >&2
  exit 1
fi
# El contenedor debe pertenecer al proyecto pedido (Compose guarda el nombre normalizado en minúsculas).
proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db_id")
if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
  want=$(printf '%s' "$COMPOSE_PROJECT_NAME" | tr 'A-Z' 'a-z')
  [ "$proj" = "$want" ] || { echo "El contenedor db es del proyecto '$proj', no de '$COMPOSE_PROJECT_NAME'." >&2; exit 1; }
fi
echo "Proyecto Compose: $proj"
vol=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/storage"}}{{.Name}}{{end}}{{end}}' "$st_id")
[ -n "$vol" ] || { echo "No encuentro el volumen de Storage." >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name=valmont-$stamp
final=$out_root/$name.tar.gpg
[ ! -e "$final" ] || { echo "Ya existe $final." >&2; exit 1; }
mkdir -p "$out_root"
# Lo cifrado se escribe en archivos ocultos .partial y se renombra al final: nunca queda una copia a medias
# con nombre válido.
part_gpg=$out_root/.$name.tar.gpg.partial
part_sum=$out_root/.$name.tar.gpg.sha256.partial
work=$(mktemp -d)
cleanup() { rm -rf "$work"; rm -f "$part_gpg" "$part_sum"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
p=$work/payload
mkdir "$p"

echo "1/5 Esquema app..."
db pg_dump -h localhost -U postgres -d postgres -Fc -n app -e unaccent >"$p/db-app.dump"
# shortcut: -e unaccent es la única extensión que crean las migraciones (0004); si una nueva crea otra,
# añade su -e aquí (y su comprobación de abajo), o restore.sh fallará al crear lo que la usa.
toc=$(compose exec -T db pg_restore -l <"$p/db-app.dump")
case $toc in
  *"EXTENSION - unaccent"*) ;;
  *) echo "db-app.dump no incluye la extensión unaccent: sin ella no se podría restaurar app." >&2; exit 1 ;;
esac

echo "2/5 Usuarios (auth) y metadatos de Storage (storage)..."
db pg_dump -h localhost -U postgres -d postgres -Fc --data-only -n auth -n storage \
  -T auth.schema_migrations -T storage.migrations >"$p/db-supabase-data.dump"
# Comprueba que el archivo es legible (lista su contenido sin restaurar nada).
compose exec -T db pg_restore -l <"$p/db-supabase-data.dump" >/dev/null

echo "3/5 Archivos de Storage..."
tar_storage() {
  docker run --rm --network none -u 0 --entrypoint tar -v "$vol:/data:ro" "$helper_img" \
    --xattrs --xattrs-include='user.*' --numeric-owner --format=posix -czf - -C /data . >"$p/storage-objects.tar.gz"
}
rc=0
tar_storage || rc=$?
if [ "$rc" -eq 1 ]; then
  # GNU tar sale con 1 si un archivo cambió mientras lo leía (una subida o un borrado en curso): un reintento.
  echo "Un archivo cambió mientras se leía: reintento una vez." >&2
  rc=0
  tar_storage || rc=$?
fi
[ "$rc" -eq 0 ] || { echo "Falló el tar de Storage (código $rc)." >&2; exit 1; }
gzip -t "$p/storage-objects.tar.gz"

echo "4/5 MANIFEST y sumas internas..."
pg_version=$(db psql -h localhost -U postgres -d postgres -qAt -c 'show server_version')
alembic_rev=$(db psql -h localhost -U postgres -d postgres -qAt -c 'select version_num from app.alembic_version')
commit=$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo desconocido)
{
  echo "fecha_utc=$stamp"
  echo "commit=$commit"
  echo "postgres=$pg_version"
  echo "alembic=$alembic_rev"
} >"$p/MANIFEST"
(cd "$p" && sha256sum db-app.dump db-supabase-data.dump storage-objects.tar.gz MANIFEST >SHA256SUMS)
tar -cf "$work/valmont.tar" -C "$p" db-app.dump db-supabase-data.dump storage-objects.tar.gz MANIFEST SHA256SUMS
rm -rf "$p"

echo "5/5 Cifrado, suma del archivo cifrado y retención..."
gpg --batch --yes --trust-model always --encrypt --recipient "$recipient" --output "$part_gpg" "$work/valmont.tar"
[ -s "$part_gpg" ] || { echo "gpg no produjo el archivo cifrado." >&2; exit 1; }
mv "$part_gpg" "$final"
(cd "$out_root" && sha256sum "$name.tar.gpg" >"$part_sum")
mv "$part_sum" "$final.sha256"

# Solo tras una copia correcta, para que una racha de fallos no vaya borrando las copias buenas.
find "$out_root" -mindepth 1 -maxdepth 1 -type f \
  \( -name 'valmont-????????T??????Z.tar.gpg' -o -name 'valmont-????????T??????Z.tar.gpg.sha256' -o -name '.valmont-*.partial' \) \
  -mtime "+$keep_days" -exec rm -f {} +

echo "Copia cifrada creada: $final"
