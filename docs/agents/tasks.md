# Tablero de tareas

> Escritura aditiva: cada agente agrega o actualiza solo sus filas (skill `coordinador-multiagente` §6).
> Estados y plantillas: [PROTOCOL.md](PROTOCOL.md) §3, §5, §6. Los paquetes de las tareas de módulo viven en `docs/modules/<módulo>/STATUS.md`; los de tareas transversales, abajo.

| ID | Descripción | Rol | Agente | RF / D | Documentos | Estado | Notas de continuidad |
|---|---|---|---|---|---|---|---|
| T-001 | Base documental `docs/` desde cero | docs, arquitectura | claude-leader | OE07 | requirements, modules, planning, setup, decisions | DONE | — |
| T-002 | Protocolo de agentes, subagentes y skills | docs, arquitectura | claude-leader | OE07, D-004 | agents/PROTOCOL.md, skills/README.md | DONE | Validado con T-007: backend-dev cargó sus skills y entregó el traspaso de 11 puntos |
| T-003 | Configuración de Kombai y flujo Figma | ui | claude-leader | D-006 | design_ui/DESIGN.md, `.kombai/rules/` | DONE | Generar el `.ds` en T-010 |
| T-004 | Esqueleto backend FastAPI + uv con `/health` | arquitectura | claude-leader | D-007 | modules.md §4, setup.md §3 | DONE | ruff, pytest (1/1) y servidor con `curl` verificados |
| T-005 | Esqueleto frontend Astro 7 | arquitectura | claude-leader | D-008 | modules.md §5, setup.md §3 | DONE | `astro check` 0 errores, build OK |
| T-006 | Supabase local (CLI vía npx + `supabase/config.toml`) | arquitectura | claude-leader | D-011 | setup.md §3 | DONE | 7 contenedores sanos; Postgres 17.11; Auth y Mailpit responden 200; `backend/.env` creado (ignorado) |
| T-007 | Base del backend: configuración por entorno, errores centralizados, logging con id de solicitud | backend | backend-dev (revisa claude-leader) | RNF09, RNF05 | modules.md §4 | DONE | Traspaso abajo; 15 pruebas en verde |
| T-008 | SPEC del módulo `identity` | requisitos, backend | claude-leader | RF01, RF11.02, RF13, D-009 | docs/modules/identity/SPEC.md | IN_REVIEW | Perfil mínimo aprobado por el usuario; falta que el frontend revise el contrato |
| T-009 | SPEC del módulo `catalog` | requisitos | module-coordinator | RF02, RF06.01–03 | requirements.md RF02, RF06 | CANCELLED | Sustituida por T-025 (rango del módulo) |
| T-010 | Sistema de diseño Kombai (`.ds`) y primer componente desde Figma | ui | frontend-lead + Kombai | D-006, D-012 | design_ui/DESIGN.md | BLOCKED | Requiere D-012 y la URL del frame de Figma |
| T-011 | Inicializar git y commit base | — | usuario | D-013 | decisions.md D-013 | CANCELLED | Fusionada en T-012 |
| T-012 | Credenciales fuera del proyecto + `git init` + commit base | — | claude-leader + usuario | D-013 | decisions.md D-013 | DONE | Credenciales en `%USERPROFILE%\.claude-valmont`; commit base `f931a54` en `main`; trabajo en la rama `worktree-fase1-backend-db` |
| T-013 | Documentación al día con D-009…D-017 y correcciones de la auditoría | docs | claude-leader | D-009…D-017 | decisions, requirements, modules, skills | DONE | — |
| T-014 | Instalar Docker Desktop | arquitectura | claude-leader | D-011 | setup.md §1 | DONE | Docker Desktop 29.9.2 + Compose v5.6.1; `hello-world` OK |
| T-015 | Capa de datos: SQLAlchemy + Alembic, esquema `app`, BD de pruebas | backend | backend-dev (revisa claude-leader) | D-010 | modules.md §4 | DONE | Traspaso abajo; 17 pruebas unitarias + 5 de integración |
| T-016 | Autenticación: verificación del JWT, `app.profiles`, `current_user` / `require_admin` | backend, seguridad | backend-dev + qa-reviewer | RF01.05, RF13.01, RF13.02, D-009, D-018 | docs/modules/identity/STATUS.md | DONE | 2 rondas; qa-reviewer APROBADO; E2E con token ES256 real OK |
| T-017 | Ficha de lanzamiento `docs/deploy.md` (Windows 11 / Linux) | docs, arquitectura | claude-leader | D-011 | docs/deploy.md | IN_PROGRESS | Sección A verificada (A-11 parcial hasta la Fase 5); B pendiente de un equipo Linux; C en el hito M1 |
| T-105 | Protocolo de control de versiones: PROTOCOL §11, skill `version-control` y hooks de `.githooks/` (petición del usuario) | docs, arquitectura | claude-leader | D-026 | docs/agents/PROTOCOL.md §11 | DONE | Hooks probados (9/9 casos) y activos con `core.hooksPath` |
| T-106 | Las pruebas las ejecuta solo qa-reviewer, y el Leader hace el commit tras su APROBADO (petición del usuario) | docs, arquitectura | claude-leader | D-028 | docs/agents/PROTOCOL.md §1, §3, §5, §11 | DONE | Rige desde 2026-10-27; la ronda 2 de T-042 (`615189d`) es anterior |
| T-019 | Ajustes de contrato de identity tras la revisión de frontend-lead: `validation_error.details` sin `url` (solo `loc`, `type`, `msg`) y `Money.currency` obligatorio en el OpenAPI | backend | backend-dev | RF01.06 | docs/modules/identity/SPEC.md §7 | DONE | Hecho con T-027: `Money-Output` exige `amount` y `currency`; `details` = `loc`, `type`, `msg` |
| T-018 | Endurecimiento antes del lanzamiento: limpieza periódica de archivos huérfanos en Storage (T-029); JWKS no-JSON → 503 con aviso; no registrar el `DETAIL` de PostgreSQL (solo `sqlstate` y restricción); rechazar controles bidireccionales y nombres invisibles; límites de longitud documentados en el OpenAPI | backend, seguridad | backend-dev + qa-reviewer | RNF02, RNF10 | docs/modules/identity/STATUS.md | BACKLOG | Hallazgos menores de qa-reviewer en T-016; antes del hito M1 |

| T-020 | SPEC de audit | requisitos, backend | claude-leader | RF14 | docs/modules/audit/SPEC.md | DONE | Sin preguntas de negocio bloqueantes |
| T-021 | `app.audit_log` de solo inserción, `AuditRecorder` y `AuditRecorderDep` | backend | backend-dev (revisa claude-leader) | RF14.01, RF14.02 | docs/modules/audit/STATUS.md | DONE | 147 pruebas unitarias + 22 de integración; migración 0003 |
| T-025 | SPEC de catalog | requisitos, backend | claude-leader | RF02, RF06.01–03, RF06.07, D-019…D-023 | docs/modules/catalog/SPEC.md | DONE | Contrato revisado por frontend-lead; cambios incorporados |
| T-026…T-031 | Implementación de catalog | backend | backend-dev (+ qa-reviewer en T-028) | ver STATUS de catalog | docs/modules/catalog/STATUS.md | IN_PROGRESS | T-026…T-029 y T-031 DONE; T-030 espera a inventory (T-041) |
| T-040 | SPEC de inventory | requisitos, backend | claude-leader | RF06.04–06, D-017, D-023, D-027 | docs/modules/inventory/SPEC.md | DONE | Decisiones del usuario D-027 |
| T-041…T-044 | Implementación de inventory | backend | backend-dev + qa-reviewer | ver STATUS de inventory | docs/modules/inventory/STATUS.md | IN_PROGRESS | T-041, T-042 y T-043 DONE (`327828c`); T-044 (seguimiento menor de QA) en curso |

**Rangos reservados para la Fase 2** (PROTOCOL §6): audit T-020–T-024 · catalog T-025–T-039 · inventory T-040–T-049 · promotions T-050–T-054 · cart T-055–T-064 · wishlist T-065–T-069 · orders T-070–T-089 · payments T-090–T-099 · hito M1 de lanzamiento T-100–T-104.

Estados válidos: `BACKLOG` · `SPECIFICATION` · `READY` · `IN_PROGRESS` · `BLOCKED` · `IN_REVIEW` · `INTEGRATION` · `DONE` · `CANCELLED`.

## Paquetes de tareas transversales

### T-007 — Base del backend (configuración, errores, logging)
- Objetivo: el backend carga su configuración por entorno, responde a cualquier error con un formato JSON único y registra cada solicitud con un id.
- Responsable: backend-dev (revisa claude-leader) · Módulo: plataforma (`shared/`) · Requisitos: RNF09, RNF05, RNF02
- Leer: `docs/modules.md` §4 y §7; `backend/src/valmont/main.py`; `backend/tests/test_health.py`
- Contratos aplicables: formato de error de `modules.md` §4.4
- Dependencias: ninguna
- Puede modificar: `backend/src/valmont/main.py`, `backend/src/valmont/shared/**`, `backend/tests/**`, `backend/.env.example`, y `backend/pyproject.toml` + `backend/uv.lock` solo para dos cosas: `uv add pydantic-settings` (hoy llega de forma transitiva) y cambiar `fastapi[standard]` por `fastapi[standard-no-fastapi-cloud-cli]` (auditoría #16)
- Protegido: `frontend/**`, `docs/**` (salvo el traspaso en este archivo)
- Resultado esperado: `shared/config.py` (Settings con `ENVIRONMENT`), `shared/errors.py` (excepción base de la app + handlers), middleware de id de solicitud (`X-Request-ID`), `.env.example`
- Criterios de aceptación: (1) un error de dominio de prueba devuelve `{"error": {"code", "message", "details"}}` con el código HTTP correcto; (2) un error no controlado devuelve 500 con el mismo formato y sin traza; (3) toda respuesta incluye `X-Request-ID`: se reutiliza el entrante solo si cumple `^[A-Za-z0-9-]{1,64}$` (si no, se genera un UUID4, para evitar inyección en logs), y cada línea de log de la solicitud lleva ese id; (4) `/health` sigue funcionando y `uv run fastapi dev src/valmont/main.py` arranca
- Pruebas obligatorias: `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, con pruebas nuevas para (1)–(3)
- Seguridad: no exponer trazas ni datos internos en las respuestas; no registrar cabeceras de autorización
- Estado inicial: READY
- IDs reservados: ninguno (tarea hoja)
- Escalar si: hace falta otra dependencia, o el formato de error no cubre un caso

#### Traspaso T-007 — 2026-10-26 — backend-dev (revisado por claude-leader)
1. Estado final: DONE (aceptado por claude-leader).
2. Cambios: `shared/config.py` (Settings + `get_settings()` cacheada), `shared/errors.py` (AppError y formato común), `shared/logs.py` (middleware `X-Request-ID` + logging con `request_id`; el 500 se gestiona en el middleware para conservar la cabecera); `fastapi[standard-no-fastapi-cloud-cli]` y `pydantic-settings` como dependencias directas.
3. Revisión del Leader (añadido): `extra="ignore"` en Settings (si no, el `.env` de T-006 rompería el arranque); handler de `HTTPException` con códigos `unauthenticated`/`forbidden`/`not_found`/`method_not_allowed`/`http_error`; el 422 ya no devuelve `input`. Tres pruebas nuevas.
4. Pruebas: `uv run ruff format --check .` → 10 files already formatted · `uv run ruff check .` → All checks passed! · `uv run pytest -q` → 15 passed · humo `fastapi dev` + `curl /health` → 200 con `x-request-id` (hecho por backend-dev).
5. No ejecutadas: integración (sin BD en esta tarea), capas (aún no hay módulos), tipos (sin herramienta).
6. Riesgos aceptados: el access log de uvicorn duplica la línea de cada solicitud sin el id (en producción se usará `--no-access-log`, hito M1); `LOG_LEVEL` inválido aborta el arranque a propósito.

#### Traspaso T-015 — 2026-10-26 — backend-dev (revisado por claude-leader)
1. Estado final: DONE (aceptado por claude-leader).
2. Cambios: `shared/db.py` (`Base` en el esquema `app` con convención de nombres, `get_engine()` perezoso, `get_session()` + alias `SessionDep` con `scope="function"`); Alembic (`alembic.ini`, `migrations/env.py` limitado al esquema `app`, `version_table_schema="app"`, modo `--sql` rechazado); migración `0001` (REVOKE a `anon` y `authenticated`); `tests/conftest.py` (crea `valmont_test`, `upgrade head`, `db_session` con savepoint; exige el sufijo `_test`); marcador `integration`. Dependencias: sqlalchemy 2.1.6, psycopg[binary] 3.3.6, alembic 1.20.1.
3. Pruebas (reejecutadas por el Leader): `ruff format --check` → 16 files already formatted · `ruff check` → All checks passed! · `pytest -q` → 17 passed, 5 deselected · `pytest -m integration -q` → 5 passed · `alembic current` → 0001 (head) · `alembic check` → No new upgrade operations detected. backend-dev demostró además que sin `scope="function"` un fallo de commit devolvía 200.
4. Convenciones adoptadas (docs/modules.md §4.5 y §4.7): `SessionDep` obligatorio; `--rev-id` secuencial.
5. Riesgos: un `GRANT … TO PUBLIC` futuro sobre `app` anularía el REVOKE (la prueba de privilegios lo detectaría); las URLs de BD no son `SecretStr` (no registrar el objeto `Settings`).
