# Ficha de lanzamiento — Valmont_E_Commerce

> Pasos para poner el sistema en marcha en un equipo **Windows 11** o **Linux** (D-011).
> Leyenda: ✅ verificado en el equipo de desarrollo (2026-10-26) · 🕒 se verifica al terminar la tarea indicada · 🧭 diseño previsto para el hito M1 (T-100–T-104), aún no construido.
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
| 11 | Primer administrador | Registrar el usuario desde la app (o Studio → Authentication → Add user), llamar una vez a `GET /api/v1/identity/me` para crear su perfil, y en Studio → SQL: `update app.profiles set role = 'admin' where user_id = '<uuid>';` | ✅ perfil al vuelo (T-016) · 🕒 la promoción se prueba con la primera ruta de administración (Fase 5) |
| 12 | Apagar | `npm run db:stop` (conserva los datos) | ✅ |

**Servicios locales:** API y Auth `:54321` · Postgres `:54322` · Studio `:54323` · Mailpit `:54324` (aquí llegan los correos de registro y recuperación).

## B. Desarrollo en Linux (Ubuntu 24.04 LTS u otra distribución)

| # | Paso | Comando / acción | Estado |
|---|---|---|---|
| 1 | Docker Engine | Instalar según https://docs.docker.com/engine/install/ (repositorio oficial de tu distribución) → `sudo usermod -aG docker $USER` → cerrar sesión y volver a entrar | 🕒 sin verificar aún |
| 2 | Node y uv | Node ≥ 22.23 (repositorio de NodeSource o `nvm`) · `curl -LsSf https://astral.sh/uv/install.sh \| sh` | 🕒 sin verificar aún |
| 3 | Resto | Los pasos 4–12 de la sección A son idénticos; en el paso 6 usa `cp .env.example .env` | 🕒 sin verificar aún |

## C. Lanzamiento en un equipo (Windows 11 o Linux) 🧭

Arquitectura prevista, con los mismos archivos de Docker Compose en los dos sistemas:

```
navegador ──HTTPS──► proxy inverso (por decidir en M1)
                        ├── /            → frontend (build de Astro)
                        ├── /api/v1/...  → backend (FastAPI, contenedor propio)
                        └── /auth/v1/... → Supabase Auth (vía su gateway)
                                              │
                       backend ──────────────► Postgres de Supabase autohospedado (esquema app)
```

| # | Paso | Detalle | Estado |
|---|---|---|---|
| 1 | Requisitos del equipo | Mínimo 4 GB RAM, 2 núcleos y 40 GB SSD; recomendado 8 GB, 4 núcleos y 80 GB (documentación de Supabase autohospedado) | 🧭 |
| 2 | Docker | Windows 11: Docker Desktop (sección A, pasos 2–3). Linux: Docker Engine (sección B, paso 1) | 🧭 |
| 3 | Código | `git clone <repo>` en la rama de la versión a lanzar | 🧭 |
| 4 | Secretos | `deploy/.env` generado con los scripts de claves de Supabase (`generate-keys.sh`; en Windows, desde Git Bash o WSL): contraseña de Postgres, secreto JWT, claves de API. **Nunca** los valores de desarrollo | 🧭 |
| 5 | Arrancar | `docker compose -f deploy/compose.yml up -d` | 🧭 |
| 6 | Migraciones | `docker compose -f deploy/compose.yml run --rm backend alembic upgrade head` | 🧭 |
| 7 | Rol de BD de la app | El backend se conecta con el rol `valmont_app`, con privilegios mínimos (sin UPDATE/DELETE en `audit_log`) | 🧭 |
| 8 | Primer administrador | Como en el paso A-11, pero contra la BD del servidor | 🧭 |
| 9 | Comprobar | `GET /health` → 200; registro de prueba; `GET /api/v1/identity/me` → 200 | 🧭 |
| 10 | Copias de seguridad | `pg_dump` diario a un disco distinto (Linux: `cron`; Windows: Programador de tareas) y una restauración probada antes de abrir al público (RNF12) | 🧭 |
| 11 | Actualizar | `git pull` → `docker compose … up -d --build` → paso 6 | 🧭 |
| 13 | Proxy y subida de imágenes | El proxy inverso debe conservar `Content-Length` en las subidas; el backend rechaza con 413 los cuerpos sin esa cabecera (T-029) | 🧭 |
| 12 | Rotar o revocar claves de firma de Auth | Tras revocar una clave en Supabase, reiniciar el backend: cachea las claves públicas por `kid` sin caducidad (D-018) | 🧭 |

## D. Windows 11 frente a Linux para el lanzamiento

| Aspecto | Windows 11 + Docker Desktop | Linux + Docker Engine |
|---|---|---|
| Arranque sin intervención | Docker Desktop necesita una **sesión de usuario iniciada**; tras un reinicio de Windows Update el sitio queda caído hasta que alguien inicie sesión | Servicio `systemd`: arranca solo con el equipo |
| Licencia | Términos de Docker Desktop (gratis para uso personal y empresas de menos de 250 empleados y menos de 10 M USD) | Docker Engine es libre |
| Rendimiento | Capa extra (VM de WSL2) | Nativo |
| Uso recomendado | Demos y pruebas en la oficina | **Producción** |

## E. Estado actual

- **Funciona hoy:** sección A completa, salvo la promoción a administrador (A-11 parcial), y el flujo de registro → confirmación → token → perfil verificado de punta a punta con Supabase real.
- **Pendiente:** promoción a admin por SQL (Fase 5), sección B (verificar en un equipo Linux) y sección C completa (hito M1, tras catalog + inventory).
- **Puertos de Supabase en desarrollo:** Docker los publica en todas las interfaces (`0.0.0.0`). En Windows 11 se bloquean desde la red con `New-NetFirewallRule -DisplayName 'Valmont Supabase dev' -Direction Inbound -Protocol TCP -LocalPort 54321-54324 -Action Block` (como administrador; aplicada en el equipo de desarrollo el 2026-10-27). En Linux, el equivalente con `ufw` o `nftables`.
