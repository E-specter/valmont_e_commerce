# Ficha de lanzamiento — Valmont_E_Commerce

> Pasos para poner el sistema en marcha en un equipo **Windows 11** o **Linux** (D-011).
> Leyenda: ✅ verificado en el equipo de desarrollo (A: 2026-10-26; C: 2026-10-27, T-104) · 🕒 se verifica al terminar la tarea indicada · 🧭 previsto, aún sin verificar.
> Comandos detallados: [setup.md](setup.md) §3. Nunca pegues claves ni secretos en chats, tickets ni en este documento.

## A. Desarrollo en Windows 11

| # | Paso | Comando / acción | Estado |
|---|---|---|---|
| 1 | Requisitos | Windows 11 con virtualización activa y WSL2; ≥ 8 GB de RAM (16 recomendados); ~15 GB libres; Git, Node ≥ 22.23 y uv ≥ 0.12 | ✅ |
| 2 | Instalar Docker Desktop | `winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements` → abrir Docker Desktop → aceptar términos → esperar "Engine running" | ✅ |
| 3 | Comprobar Docker | Terminal **nueva**: `docker run --rm hello-world` → "Hello from Docker!" | ✅ |
| 4 | Clonar e instalar la CLI de Supabase | `git clone <repo>` → `cd valmont_e_commerce` → `git config core.hooksPath .githooks` (hooks de commits, D-026) → `npm install` (instala la CLI 2.120.0 fijada) | ✅ |
| 5 | Arrancar la BD local | `npm run db:start` (la 1.ª vez descarga ~3–5 GB) → `npm run db:status` | ✅ |
| 6 | Configurar el backend | `cd backend` → `Copy-Item .env.example .env` (los valores por defecto apuntan a Supabase local; los tokens se verifican con el JWKS público, D-018). Único secreto: `SUPABASE_SERVICE_ROLE_KEY` = `SERVICE_ROLE_KEY` de `npx supabase status -o env`, para subir imágenes (D-019); solo en tu `.env` | ✅ |
| 7 | Instalar y probar el backend | `uv sync` → `uv run pytest -q` | ✅ |
| 8 | Crear las tablas | `uv run alembic upgrade head` → `uv run alembic current` muestra `(head)` | ✅ |
| 9 | Levantar la API | `uv run fastapi dev src/valmont/main.py` → http://127.0.0.1:8000/docs | ✅ |
| 10 | Levantar el frontend | `cd frontend` → `npm install` → `npx astro dev` → http://localhost:4321 | ✅ build verificado (`astro dev` aún sin abrir) |
| 11 | Primer administrador | Registrar el usuario desde la app (o Studio → Authentication → Add user), llamar una vez a `GET /api/v1/identity/me` para crear su perfil, y en Studio → SQL: `update app.profiles set role = 'admin' where user_id = '<uuid>';` | ✅ perfil al vuelo (T-016) y promoción probada con rutas de administración reales (C-8, T-104) |
| 12 | Apagar | `npm run db:stop` (conserva los datos) | ✅ |

**Servicios locales:** API y Auth `:54321` · Postgres `:54322` · Studio `:54323` · Mailpit `:54324` (aquí llegan los correos de registro y recuperación).

## B. Desarrollo en Linux (Ubuntu 24.04 LTS u otra distribución)

| # | Paso | Comando / acción | Estado |
|---|---|---|---|
| 1 | Docker Engine | Instalar según https://docs.docker.com/engine/install/ (repositorio oficial de tu distribución) → `sudo usermod -aG docker $USER` → cerrar sesión y volver a entrar | 🕒 sin verificar aún |
| 2 | Node y uv | Node ≥ 22.23 (repositorio de NodeSource o `nvm`) · `curl -LsSf https://astral.sh/uv/install.sh \| sh` | 🕒 sin verificar aún |
| 3 | Resto | Los pasos 4–12 de la sección A son idénticos; en el paso 6 usa `cp .env.example .env` | 🕒 sin verificar aún |

## C. Lanzamiento en un equipo (Windows 11 o Linux)

Los mismos archivos de Docker Compose sirven en los dos sistemas (D-029). **Verificado de punta a punta en este Windows 11 el 2026-10-27 (T-104)**, con puertos poco comunes a petición del usuario: `127.0.0.1:18080/18443` y Mailpit en `18025`.

```
navegador ──HTTPS──► Caddy (D-029; el único que publica puertos)
                        ├── /api/v1/...     → backend (FastAPI, rol de BD valmont_app)
                        ├── /auth/v1/...    → Kong → Supabase Auth (tokens ES256, JWKS)
                        ├── /storage/v1/... → Kong → Supabase Storage (bucket products)
                        └── /               → frontend (Astro con @astrojs/node)
                       backend ──────────────► Postgres de Supabase autohospedado (esquema app)
```

| # | Paso | Detalle | Estado |
|---|---|---|---|
| 1 | Requisitos del equipo | Mínimo 4 GB de RAM, 2 núcleos y 40 GB SSD; recomendado 8 GB, 4 núcleos y 80 GB (documentación de Supabase autohospedado). Las imágenes ocupan unos 3–4 GB. | 🧭 |
| 2 | Docker | Windows 11: Docker Desktop (sección A, pasos 2–3). Linux: Docker Engine (sección B, paso 1). | ✅ Windows 11 |
| 3 | Código | `git clone <repo>` en la rama de la versión a lanzar → `git config core.hooksPath .githooks`. | 🧭 |
| 4 | Secretos | `sh deploy/scripts/generate-env.sh` (en Windows, desde Git Bash o WSL; necesita Node ≥ 16 o Docker), o `node deploy/scripts/generate-env.mjs deploy/.env.example deploy/.env`. Genera contraseñas aleatorias y la clave EC P-256 de Auth (ES256, D-018) sin imprimirlas.<br>- **No sobrescribe** un `deploy/.env` existente, y no se puede regenerar después del primer arranque: la BD ya creada dejaría de aceptar a Auth y a Storage.<br>- Antes de arrancar, revisa `SITE_ADDRESS`, `BIND_ADDRESS`, `HTTP_PORT`, `HTTPS_PORT`, `MAILPIT_PORT`, `PUBLIC_URL` y `SMTP_*`.<br>- `PUBLIC_URL` lleva el puerto cuando no es el 443 (por ejemplo `https://localhost:18443`).<br>- **Nunca** reutilices los valores de desarrollo. | ✅ |
| 5 | Arrancar | `docker compose -f deploy/compose.yml --profile local up -d --build --wait`. Sin `--profile local` no hay Mailpit y hace falta un SMTP real para los correos de confirmación. Resultado esperado: 7 servicios en `healthy`, más Caddy en marcha (no tiene healthcheck). | ✅ |
| 6 | Migraciones | `sh deploy/scripts/migrate.sh`. Aplica las migraciones con el rol propietario, da `LOGIN` y contraseña a `valmont_app` y crea el bucket `products` (público, 5 MiB, jpeg/png/webp). **No** uses `run --rm backend alembic upgrade head`: correría como `valmont_app`, que no puede cambiar el esquema. | ✅ 0001 → 0006 |
| 7 | Rol de BD de la app | El backend se conecta como `valmont_app` (T-101): sin poder de esquema, y solo `SELECT, INSERT` en `audit_log` y `stock_movements`. Para comprobarlo: `docker compose -f deploy/compose.yml exec -T db psql -U postgres -d postgres -c "select usename, count(*) from pg_stat_activity group by 1;"`. | ✅ |
| 8 | Primer administrador | El usuario se registra en la app y llama una vez a `GET /api/v1/identity/me`. Después, como no hay Studio: `docker compose -f deploy/compose.yml exec -T db psql -U postgres -d postgres -c "update app.profiles set role = 'admin' where user_id = '<uuid>';"` | ✅ |
| 9 | Comprobar | 1. `docker compose -f deploy/compose.yml ps` → todos en `healthy`.<br>2. `https://<sitio>/` → 200.<br>3. `/api/v1/catalog/products` → 200.<br>4. `/auth/v1/.well-known/jwks.json` → una clave EC.<br>5. Registro → correo (Mailpit en `http://127.0.0.1:<MAILPIT_PORT>`) → login → `/api/v1/identity/me` → 200.<br>Caddy no expone `/health`, a propósito. | ✅ |
| 10 | Copias de seguridad | `pg_dump` diario a un disco distinto (Linux: `cron`; Windows: Programador de tareas) y una restauración probada antes de abrir al público (RNF12). | 🕒 T-103 |
| 11 | Actualizar | `git pull` → `docker compose -f deploy/compose.yml up -d --build --wait` → `sh deploy/scripts/migrate.sh`. | 🧭 |
| 12 | Proxy y subida de imágenes | Caddy conserva `Content-Length` (el backend rechaza con 413 los cuerpos sin ella, T-029). Verificado: HTTP/1.1 y HTTP/2 con la cabecera → 201; `chunked` → 413; exactamente 5 MiB → 201; 5 MiB + 1 → 413. | ✅ |
| 13 | Rotar o revocar claves de firma de Auth | Tras revocar una clave, reinicia el backend: cachea las claves públicas por `kid` sin caducidad (D-018). | 🧭 |
| 14 | Apagar | `docker compose -f deploy/compose.yml --profile local down` conserva los datos. Cada contenedor se detiene en menos de 1 s (`init: true`). **`down -v` borra la BD y las imágenes subidas**: pasa la puerta D-011. | ✅ |

**Notas de la prueba local:**
- El certificado de `localhost` lo emite la CA interna de Caddy. El navegador avisa: acepta el aviso o importa la raíz desde el volumen `valmont_caddy-data`.
- Con puertos no estándar, entra directamente por `https://localhost:<HTTPS_PORT>`. La redirección desde HTTP apunta al 443 sin el puerto; en producción, con 80/443, es correcta.
- Las filas de `app.audit_log` no se pueden borrar ni siquiera en pruebas (triggers de solo inserción). Un stack de prueba limpio exige recrear el volumen `valmont_db-data` (puerta D-011).

## D. Windows 11 frente a Linux para el lanzamiento

| Aspecto | Windows 11 + Docker Desktop | Linux + Docker Engine |
|---|---|---|
| Arranque sin intervención | Docker Desktop necesita una **sesión de usuario iniciada**; tras un reinicio de Windows Update el sitio queda caído hasta que alguien inicie sesión | Servicio `systemd`: arranca solo con el equipo |
| Licencia | Términos de Docker Desktop (gratis para uso personal y empresas de menos de 250 empleados y menos de 10 M USD) | Docker Engine es libre |
| Rendimiento | Capa extra (VM de WSL2) | Nativo |
| Uso recomendado | Demos y pruebas en la oficina | **Producción** |

## E. Estado actual

- **Funciona hoy:** sección A completa y sección C verificada de punta a punta en Windows 11 (T-104, 2026-10-27): stack con Caddy, frontend, backend con `valmont_app` y Supabase autohospedado; tokens ES256; subida de imágenes; disponibilidad y búsqueda.
- **Pendiente:**
  - sección B (verificar en un equipo Linux);
  - C-10, las copias de seguridad (T-103);
  - el endurecimiento antes de abrir al público (T-018): cabeceras de seguridad y error 502 con el formato común, entre otros.
- **Puertos de Supabase en desarrollo:** Docker los publica en todas las interfaces (`0.0.0.0`). En Windows 11 se bloquean desde la red con `New-NetFirewallRule -DisplayName 'Valmont Supabase dev' -Direction Inbound -Protocol TCP -LocalPort 54321-54324 -Action Block` (como administrador; aplicada en el equipo de desarrollo el 2026-10-27). En Linux, el equivalente con `ufw` o `nftables`.
