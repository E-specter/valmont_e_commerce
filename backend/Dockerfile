# Backend de Valmont: FastAPI con uv (D-007, D-029). Multietapa según la guía oficial de uv:
# https://docs.astral.sh/uv/guides/integration/docker/
# Sin variables de entorno de la aplicación ni secretos: llegan al arrancar (deploy/compose.yml).
# Migraciones (con el rol propietario, solo en ese comando): deploy/scripts/migrate.sh.

FROM python:3.14.7-slim-trixie AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /bin/uv
# Bytecode precompilado (el usuario final no puede escribir __pycache__), copia en vez de enlaces
# y el Python de la imagen, nunca uno descargado.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0
WORKDIR /app
# Primero solo las dependencias: esta capa se reutiliza mientras no cambien pyproject.toml ni uv.lock.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
# --no-editable: el paquete valmont queda dentro de .venv y la imagen final no necesita src/.
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.14.7-slim-trixie AS runtime
RUN groupadd --system --gid 10001 valmont \
    && useradd --system --uid 10001 --gid valmont --no-create-home --shell /usr/sbin/nologin valmont
WORKDIR /app
COPY --from=build /app/.venv ./.venv
# alembic y sus migraciones van en la imagen para migrar con `docker compose run --rm`.
COPY alembic.ini ./
COPY migrations ./migrations
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1
# Archivos de root y de solo lectura para valmont: el servidor no escribe en disco.
USER valmont
EXPOSE 8000
# La imagen slim no trae curl: comprobación con urllib (urlopen falla si no es 2xx).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]
# Detrás de Caddy, en una red interna sin puertos publicados: se aceptan sus X-Forwarded-*.
CMD ["fastapi", "run", "--entrypoint", "valmont.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
