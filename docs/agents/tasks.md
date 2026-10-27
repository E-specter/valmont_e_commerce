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
| T-101 | Rol de BD `valmont_app` con privilegios mínimos (migración 0006) | backend, seguridad | backend-dev + qa-reviewer | D-029, RNF02 | paquete abajo | DONE | `b8eb2f9`; APROBADA por qa-reviewer con D-028 (704 + 267, 3 mutantes detectados). Los dos MENOR: uno en la skill de migraciones y otro en T-100 |
| T-102 | Imagen del frontend: `@astrojs/node` (D-024), `output: 'server'` y `frontend/Dockerfile` | frontend, arquitectura | frontend-dev + qa-reviewer | D-024, D-029 | — | BACKLOG | Puerta Docker para los archivos |
| T-100 | Imagen del backend y stack de despliegue `deploy/`: compose, Caddyfile, Supabase autohospedado fijado, `.env.example` y alta de la contraseña de `valmont_app` | backend, arquitectura | backend-dev + qa-reviewer | D-011, D-018, D-029 | — | BACKLOG | Puerta Docker para los archivos; riesgo ES256. Pendiente de T-101: `ALTER ROLE valmont_app LOGIN PASSWORD` con el rol propietario (que necesita `CREATEROLE`); decidir si se revoca `CONNECT` en las BD ajenas; y su MENOR-1, que la prueba del mapa use `has_any_column_privilege` para SELECT, INSERT, UPDATE y REFERENCES |
| T-103 | Copias de seguridad: `pg_dump` diario y restauración probada (RNF12) | arquitectura | backend-dev + qa-reviewer | D-029, RNF12 | — | BACKLOG | — |
| T-104 | Prueba de lanzamiento en este Windows 11 (`https://localhost`) y sección C de la ficha verificada | arquitectura | claude-leader + qa-reviewer | D-029 | docs/deploy.md §C | BACKLOG | Build y arranque con puerta Docker |
| T-019 | Ajustes de contrato de identity tras la revisión de frontend-lead: `validation_error.details` sin `url` (solo `loc`, `type`, `msg`) y `Money.currency` obligatorio en el OpenAPI | backend | backend-dev | RF01.06 | docs/modules/identity/SPEC.md §7 | DONE | Hecho con T-027: `Money-Output` exige `amount` y `currency`; `details` = `loc`, `type`, `msg` |
| T-018 | Endurecimiento antes del lanzamiento: limpieza periódica de archivos huérfanos en Storage (T-029); JWKS no-JSON → 503 con aviso; no registrar el `DETAIL` de PostgreSQL (solo `sqlstate` y restricción); rechazar controles bidireccionales y nombres invisibles; límites de longitud documentados en el OpenAPI | backend, seguridad | backend-dev + qa-reviewer | RNF02, RNF10 | docs/modules/identity/STATUS.md | BACKLOG | Hallazgos menores de qa-reviewer en T-016; antes del hito M1 |

| T-020 | SPEC de audit | requisitos, backend | claude-leader | RF14 | docs/modules/audit/SPEC.md | DONE | Sin preguntas de negocio bloqueantes |
| T-021 | `app.audit_log` de solo inserción, `AuditRecorder` y `AuditRecorderDep` | backend | backend-dev (revisa claude-leader) | RF14.01, RF14.02 | docs/modules/audit/STATUS.md | DONE | 147 pruebas unitarias + 22 de integración; migración 0003 |
| T-025 | SPEC de catalog | requisitos, backend | claude-leader | RF02, RF06.01–03, RF06.07, D-019…D-023 | docs/modules/catalog/SPEC.md | DONE | Contrato revisado por frontend-lead; cambios incorporados |
| T-026…T-031 | Implementación de catalog | backend | backend-dev (+ qa-reviewer en T-028) | ver STATUS de catalog | docs/modules/catalog/STATUS.md | DONE | T-026…T-031 DONE (T-030: `cf22744`, verificada por qa-reviewer con D-028); queda un MENOR de pruebas para la próxima tarea de catalog |
| T-040 | SPEC de inventory | requisitos, backend | claude-leader | RF06.04–06, D-017, D-023, D-027 | docs/modules/inventory/SPEC.md | DONE | Decisiones del usuario D-027 |
| T-041…T-044 | Implementación de inventory | backend | backend-dev + qa-reviewer | ver STATUS de inventory | docs/modules/inventory/STATUS.md | DONE | T-041…T-044 DONE (última: `08cefce`); verificadas por qa-reviewer con D-028 desde T-042 |

**Rangos reservados para la Fase 2** (PROTOCOL §6): audit T-020–T-024 · catalog T-025–T-039 · inventory T-040–T-049 · promotions T-050–T-054 · cart T-055–T-064 · wishlist T-065–T-069 · orders T-070–T-089 · payments T-090–T-099 · hito M1 de lanzamiento T-100–T-104.

Estados válidos: `BACKLOG` · `SPECIFICATION` · `READY` · `IN_PROGRESS` · `BLOCKED` · `IN_REVIEW` · `INTEGRATION` · `DONE` · `CANCELLED`.

## Paquetes de tareas transversales

### T-101 — Rol de BD `valmont_app` con privilegios mínimos
- **Objetivo:** el backend desplegado se conecta con un rol que no puede cambiar el esquema ni alterar el registro de auditoría (defensa en profundidad, además de los triggers de `audit_log`).
- **Responsable:** backend-dev (verifica qa-reviewer, acepta claude-leader) · Requisitos: RNF02 · Decisiones: D-010, D-028, D-029 · **Entrega:** preparada sin commit, con el mensaje propuesto (PROTOCOL §11.2).
- **Leer:**
  - `backend/migrations/versions/` (0001–0005; sobre todo 0001, por el `REVOKE` y los `IF EXISTS` en `pg_roles`).
  - La skill `database-migration-review`.
  - `backend/tests/conftest.py` (el fixture de la BD de pruebas).
- **Puede modificar:**
  - `backend/migrations/versions/0006_*.py` (nueva, `--rev-id 0006`);
  - `backend/tests/**` (archivo de pruebas nuevo);
  - tu traspaso debajo de este paquete.
- **Resultado esperado** (migración 0006):
  - **Rol:** crea `valmont_app NOLOGIN` si no existe. Los roles son del clúster y la BD de pruebas comparte clúster, así que debe ser idempotente. La contraseña y el `LOGIN` se fijan al desplegar (T-100), **nunca** en la migración.
  - **Permisos:**
    - `USAGE` en el esquema `app`.
    - `SELECT, INSERT, UPDATE, DELETE` en las tablas de `app` que escribe el backend.
    - En `app.audit_log`, **solo** `SELECT, INSERT`.
    - `SELECT` en las vistas (`product_availability`).
    - `USAGE, SELECT` en las secuencias.
    - Lo necesario para ejecutar `app.f_unaccent` (comprueba si hace falta `USAGE` en el esquema `extensions`).
  - **Sin poder de esquema:** sin `CREATE` en `app` y sin ser dueño de nada. `alembic_version` solo la toca el rol de migraciones.
  - **Tablas futuras:** una tabla nueva sin permisos para `valmont_app` debe hacer **fallar una prueba**, que compara los privilegios reales de cada tabla de `app` con un mapa esperado. Así cada módulo nuevo tiene que concederlos de forma explícita.
  - **`downgrade`:** retira los permisos de esta BD sin romper las demás del clúster.
- **Criterios** (integración, con `SET ROLE valmont_app` dentro de la transacción de prueba):
  - Lee y escribe las tablas del backend.
  - `UPDATE`/`DELETE` en `audit_log` dan `permission denied`, antes de llegar al trigger.
  - `CREATE TABLE` y `ALTER TABLE` en `app` fallan.
  - La prueba del mapa de privilegios cubre todas las tablas.
  - `alembic downgrade 0005` y después `upgrade head` funcionan.
  - En desarrollo el backend sigue conectándose como hoy: no cambia `.env`.
- **Pruebas obligatorias:** las escribe backend-dev; qa-reviewer ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y las migraciones reversibles (D-028).
- **Estado inicial:** READY · IDs reservados: ninguno (tarea hoja).

#### Traspaso T-101 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (pendiente de qa-reviewer, D-028).
2. Cambios:
   - Migración `0006`, escrita a mano con el formato de 0005: crea `valmont_app NOLOGIN` solo si no existe, con un bloque `DO` sobre `pg_roles` como en 0001. Concede:
     - `USAGE` en `app`;
     - CRUD en las 9 tablas que escribe el backend;
     - `SELECT, INSERT` en `audit_log` y en `stock_movements` (decisión del Leader, punto 9);
     - `SELECT` en `product_availability`;
     - `USAGE, SELECT` en las secuencias;
     - `EXECUTE` en `app.f_unaccent(text)`.
   - El `downgrade` revoca todo eso en esta BD (con guarda `IF EXISTS`) y **no** hace `DROP ROLE`.
   - Pruebas de integración nuevas en `tests/test_app_role.py`.
3. Archivos modificados: `backend/migrations/versions/0006_app_role.py` (nuevo), `backend/tests/test_app_role.py` (nuevo) y `docs/agents/tasks.md` (fila y este traspaso).
4. Decisiones tomadas (técnicas, dentro del paquete; ninguna D-xxx nueva):
   - **Sin `DROP ROLE` en el `downgrade`.** El rol es del clúster: si la otra BD (desarrollo o `valmont_test`) conserva permisos, `DROP ROLE` falla (2BP01) y rompe el `downgrade`. En despliegue, además, se perderían el `LOGIN` y la contraseña de T-100. Sin permisos, el rol no alcanza nada de `app`.
   - **Sin `USAGE` en `extensions`.** `f_unaccent` tiene cuerpo SQL estándar (`RETURN`), enlazado al crearse, así que no busca `extensions.unaccent` por nombre. El `EXECUTE` en `unaccent` llega por `PUBLIC`. El `EXECUTE` en `app.f_unaccent` se concede de forma explícita. La prueba de lectura y escritura lo ejercita: inserta un producto (columna generada) y busca con `f_unaccent`.
   - **El fixture `app_session` se concede `SET` a sí mismo.** En PostgreSQL 16+, quien crea un rol sin ser superusuario recibe `ADMIN`, pero no `SET`, y `SET ROLE` lo exige. Solo lo hace si `pg_has_role('valmont_app', 'SET')` es falso, y el rollback de `db_session` lo deshace junto con el `SET LOCAL ROLE`.
   - **No se prueba `rolcanlogin`:** lo fija el despliegue. Sí se prueba que el rol no tiene `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` ni `BYPASSRLS`, y que no es dueño de nada (`pg_shdepend`).
5. Pruebas ejecutadas → resultado observado (solo análisis estático, desde `backend/`):
   - `uv run ruff format .` → 93 files left unchanged
   - `uv run ruff check .` → All checks passed!
   - capas (grep) → vacío
6. Pruebas no ejecutadas y motivo: NO EJECUTADO: pruebas ni migraciones (D-028). Esperado, sobre la base de la verificación de T-030 (704 + 256):
   - `pytest -q` → 704 passed (sin unitarias nuevas).
   - `pytest -m integration -q` → 267 passed (+11: atributos y propiedad, mapa de privilegios, lectura y escritura, 3 de `audit_log` con `UPDATE`/`DELETE`/`TRUNCATE`, 2 de `stock_movements` con `UPDATE`/`DELETE`, 2 de esquema, `downgrade 0005` → `upgrade head`).
   - `alembic check` → sin operaciones nuevas (los `GRANT` no están en los metadatos).
   - Migraciones reversibles en desarrollo, incluido `downgrade 0005` → `upgrade head`.
7. Dependencias pendientes:
   - T-100: `ALTER ROLE valmont_app LOGIN PASSWORD …` con el rol que lo creó (tiene `ADMIN`), y la `DATABASE_URL` del backend con `valmont_app`. Las migraciones siguen con el propietario.
   - `CONNECT` llega por `PUBLIC`: si la BD de despliegue lo revoca, T-100 debe concederlo.
8. Riesgos conocidos:
   - El `EXECUTE` de `extensions.unaccent` por `PUBLIC` solo queda probado en `valmont_test`. La prueba de humo de T-104 debería crear un producto y buscar como `valmont_app`.
   - Si `valmont_app` lo creó otro rol, el usuario de pruebas no tiene `ADMIN`, el `GRANT` del fixture falla y las 8 pruebas con `app_session` dan error (no pasan en falso).
   - Cada migración futura con tablas o secuencias en `app` debe concederlas y añadirlas al mapa; si no, la prueba del mapa falla. Es lo buscado.
   - Si la prueba de `downgrade` falla a mitad, deja `valmont_test` en 0005, igual que `test_migrations.py`.
9. Preguntas que requieren decisión: ninguna abierta. Resuelta por claude-leader el 2026-10-27:
   - `app.stock_movements` es un libro de movimientos y queda en `SELECT, INSERT`. Hay 2 pruebas nuevas: `UPDATE` y `DELETE` dan `permission denied` con una fila que casa.
   - El resto de tablas mantiene CRUD. Las pruebas del backend no corren como `valmont_app`, así que quitar un `DELETE` hoy sin uso podría romper producción sin que nada lo detecte. El mapa de privilegios obliga a decidirlo tabla a tabla.
   - El `downgrade` no cambia: `REVOKE ALL ON ALL TABLES IN SCHEMA app` ya cubre `stock_movements`.
10. Documentación actualizada: `docs/agents/tasks.md` (fila T-101 y este traspaso).
11. Siguiente acción recomendada: qa-reviewer ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y las migraciones reversibles sobre lo preparado.
12. Commits: ninguno — preparado.
    - Rutas: `backend/migrations/versions/0006_app_role.py`, `backend/tests/test_app_role.py`, `docs/agents/tasks.md`.
    - Mensaje propuesto: `feat(db): rol valmont_app con privilegios mínimos (T-101)`.

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
