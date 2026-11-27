# Entorno y operación — Valmont_E_Commerce

> Fuente canónica de herramientas, estructura del repositorio, comandos, entornos y problemas conocidos.
> Las versiones marcadas como "verificada" se comprobaron ejecutándolas el 2026-10-26.

## 1. Herramientas de la máquina de desarrollo

| Herramienta | Versión verificada | Uso |
|---|---|---|
| git | 2.56.0 | Control de versiones (rama `main`, hooks en `.githooks`, D-013, D-026) |
| Node.js / npm | 26.12.1 / 12.2.1 | Frontend |
| uv | 0.12.1 | Backend: intérprete, dependencias y ejecución |
| Python (gestionado por uv) | 3.14.7 | Backend (`backend/.python-version`) |
| VS Code | 1.143.1 | Extensiones: Astro 2.16.20, Figma 0.4.8 |
| Docker Desktop / Compose | 29.9.2 / v5.6.1 | Contenedores de Supabase local (D-011) |
| CLI de Supabase | 2.120.0 (fijada en el `package.json` raíz, vía `npx`) | Supabase local |
| psql | no instalado en Windows | `docker exec -it supabase_db_valmont psql -U postgres` |
| WSL2 (Ubuntu) | presente | Candidato para Docker Engine (D-011) |

## 2. Estructura del repositorio

```
valmont_e_commerce/
├── AGENTS.md                 instrucciones comunes a TODOS los agentes (Claude, Codex…)
├── CLAUDE.md                 importa AGENTS.md + específico de Claude Code
├── backend/                  API FastAPI (uv)
├── frontend/                 sitio Astro (npm); frontend/AGENTS.md = guía oficial de Astro
├── docs/                     fuente de verdad (ver docs/agents/_registry.md)
├── .claude/
│   ├── agents/               subagentes de Claude Code (jerarquía, D-004)
│   └── skills/               skills del proyecto (catálogo: docs/skills/README.md)
├── .claude/settings.json     plugins del proyecto (D-035); .mcp.json: MCP astro-docs y supabase-local
├── scripts/review-up.sh      levanta el stack local para la revisión manual (D-034)
├── .vscode/settings.json     fija CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-valmont (credenciales FUERA del proyecto, D-013)
└── valmont_e_commerce.code-workspace
```

## 3. Comandos

### Git (una vez por clon)

| Acción | Comando |
|---|---|
| Activar los hooks del protocolo de commits (D-026) | `git config core.hooksPath .githooks` |
| Commits pendientes de subir | `git log --reverse --format="%h %ad %s" --date=short origin/main..main` (sin remoto: `… main`) |
| Ramas de trabajo sin integrar | `git branch --no-merged main` |

Procedimiento completo: skill `version-control`.

### Datos de demostración (solo desarrollo)

`cd backend` → `uv run python -m valmont.scripts.seed_dev`: crea 4 categorías `demo-…`, movimientos, materiales y 12 relojes ficticios `DEMO-001…012` publicados con imagen de marcador (P-CATALOG-1). Es idempotente y se niega a correr con `ENVIRONMENT=prod`.

### Base de datos local (raíz del repo)

| Acción | Comando |
|---|---|
| Arrancar Supabase (la 1.ª vez descarga ~3–5 GB; crea también el bucket `products`) | `npm run db:start` |
| Estado y URLs | `npm run db:status` (las claves, con `npx supabase status -o env`; nunca pegarlas en chats ni en docs) |
| Detener (conserva los datos) | `npm run db:stop` |
| Consola SQL | `docker exec -it supabase_db_valmont psql -U postgres` |
| Studio · Mailpit (correos de Auth) | http://127.0.0.1:54323 · http://127.0.0.1:54324 |

Servicios activos: Postgres 17, Auth (GoTrue), Kong, PostgREST, Storage (bucket público `products`, 5 MiB, JPEG/PNG/WebP; D-019), Studio, pg-meta y Mailpit. Apagados en `supabase/config.toml`: realtime, edge runtime y analytics. `backend/.env` se crea a partir de `backend/.env.example`. `frontend/.env` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `API_BASE_URL`; nunca la `service_role`) lo genera `scripts/review-up.sh` si no existe, a partir de `frontend/.env.example` y `npx supabase status`; sin él, el sitio público funciona y las rutas con sesión responden 500 genérico (T-126).

### Backend (`cd backend`)

| Acción | Comando |
|---|---|
| Instalar o sincronizar dependencias | `uv sync` |
| Servidor de desarrollo | `uv run fastapi dev src/valmont/main.py` → http://127.0.0.1:8000/docs |
| Pruebas unitarias | `uv run pytest -q` |
| Pruebas de integración (con `npm run db:start`) | `uv run pytest -m integration -q` (usa la BD `valmont_test`, que se crea sola) |
| Aplicar migraciones (BD de desarrollo) | `uv run alembic upgrade head` |
| Nueva migración | `uv run alembic revision --autogenerate --rev-id 00NN -m "<cambio>"` → revisar → `upgrade head` |
| ¿Modelos y BD sincronizados? | `uv run alembic check` |
| Lint | `uv run ruff check .` |
| Formato (verificar / aplicar) | `uv run ruff format --check .` / `uv run ruff format .` |
| Añadir dependencia | `uv add <paquete>` (requiere aprobación de backend-lead) |

### Frontend (`cd frontend`)

| Acción | Comando |
|---|---|
| Instalar dependencias | `npm install` |
| Servidor de desarrollo | `npx astro dev --background` (gestión: `astro dev stop` / `status` / `logs`) |
| Verificación de tipos | `npm run check` |
| Build | `npm run build` |
| Vista previa del build | `npm run preview` |

### Revisión manual en main (D-034)

Tras el APROBADO de QA, el Leader integra en `main` con fast-forward y ejecuta, desde la copia de `main`: `bash scripts/review-up.sh`. El script es idempotente y exige `backend/.env`. Hace, en orden: arranca Supabase local si no está en marcha, `uv sync`, `alembic upgrade head`, backend de desarrollo en :8000, `npm install` y `astro dev` en :4321. Arrancar y detener el stack local de desarrollo está autorizado; instalar, configurar, borrar volúmenes o desplegar siguen bajo la puerta Docker (D-011).

Qué se ve en cada servicio:
- **Studio** (http://127.0.0.1:54323): las tablas de Valmont están en el esquema **`app`** (D-010), no en `public`. En Table Editor, cambia el selector "schema: public" por `app`. La BD de desarrollo es `postgres`; las pruebas de QA usan `valmont_test` y la dejan vacía, así que no dejan datos visibles.
- **Mailpit** (http://127.0.0.1:54324): solo llegan los correos que envía Auth (confirmación de registro, recuperación). Un usuario creado con la API de administración y `email_confirm: true` no genera correo.
- **API** (http://127.0.0.1:8000/docs): para las rutas protegidas, "Authorize" con el `access_token` de un usuario (`POST /auth/v1/token?grant_type=password` en http://127.0.0.1:54321).
- **Tienda** (http://localhost:4321): hasta que se implementen las pantallas de `docs/design_ui/VIEWS.md`, solo existe la portada esqueleto.
- **Datos de demostración:** `seed_dev` (catálogo, arriba). Para ver pedidos, crea uno por la API con un cliente confirmado (carrito → `POST /api/v1/orders` con `Idempotency-Key`).

### Herramientas de agentes

Los plugins viven en `.claude/settings.json`. Las skills de terceros (`find-skills`, `modern-web-guidance`) se instalan con la CLI `skills`; su lock es `skills-lock.json` y sus carpetas están ignoradas por git. Para restaurarlas: `npm run skills:install`.

Las puertas de calidad completas están en la skill `testing-and-quality-gates`.

## 4. Entornos (PROPUESTO)

| Entorno | Propósito | Base de datos | Secretos |
|---|---|---|---|
| `dev` | Desarrollo local | Supabase local vía CLI (`npm run db:start`) | `backend/.env`, fuera de git |
| `test` | Pruebas automatizadas | BD efímera o esquema aislado | Variables del runner |
| `prod` | Producción | Supabase self-hosted del servidor | Gestor de secretos del servidor |

Cada componente tendrá un `.env.example` sin valores reales cuando aparezca la primera variable.

## 5. MCP y herramientas de agentes

| Herramienta | Estado | Notas |
|---|---|---|
| Figma (plugin `figma` / conector claude.ai) | configurado | Flujo principal de diseño (D-031). OAuth con `/mcp` |
| Kombai | eliminado (D-031) | Reemplazado por el MCP de Figma |
| Astro docs MCP | configurado en `.mcp.json` | `https://mcp.docs.astro.build/mcp` |
| Supabase MCP local | configurado en `.mcp.json` | `http://127.0.0.1:54321/mcp`, con Supabase en marcha. Solo `dev`, lectura y diagnóstico |
| Playwright | plugin (D-035) | E2E y capturas (QA); fidelidad visual (frontend-lead) |
| context7 | plugin (D-035), OAuth | Documentación de FastAPI, SQLAlchemy, Alembic, Pydantic y Astro |
| GitHub MCP | desactivado en el proyecto | Falla con HTTP 400 (cabecera de autorización) |

## Problemas conocidos

| Problema | Causa | Cómo evitarlo |
|---|---|---|
| Studio no muestra ninguna tabla | Abre el esquema `public`; las tablas están en `app` (D-010) | Table Editor → selector de esquema → `app` (ver §3, Revisión manual) |
| Mailpit vacío | Los usuarios creados por la API de administración ya confirmados no reciben correo | Registrar por el flujo normal (`/auth/v1/signup` o la pantalla de registro) para ver la confirmación |
| `EnterWorktree` falla | El repo no tiene commits (o no es repo git) | Resuelto con el commit base (D-013); si reaparece, comprobar `git log` |
| "Device or resource busy" al mover carpetas | Windows bloquea archivos abiertos (VS Code, `.venv`, terminales) | No mover `backend/` ni `frontend/`; cerrar los procesos o copiar en vez de mover |
| `docker` no se encuentra justo después de instalar | La terminal abierta antes de instalar no tiene el PATH nuevo | Abrir una terminal nueva (o anteponer `C:\Program Files\Docker\Docker\resources\bin` al PATH) |
| PowerShell 5.1 marca como error la salida de `docker` | Trata como error todo lo que un programa escribe en stderr | Usar Git Bash, o fiarse del código de salida |
| Puertos de Supabase publicados en `0.0.0.0` | Docker Desktop publica en todas las interfaces | Resuelto el 2026-10-27: la regla de entrada `Valmont Supabase dev` bloquea TCP 54321–54324 desde la red (localhost sigue funcionando). Revertir: `Remove-NetFirewallRule -DisplayName 'Valmont Supabase dev'` |
| Plugins o skills que faltan con `CLAUDE_CONFIG_DIR=.claude-valmont` | La config de usuario está fuera del proyecto | Aceptar la confianza del proyecto al abrir Claude Code (`.claude/settings.json`) y ejecutar `npm run skills:install` |
