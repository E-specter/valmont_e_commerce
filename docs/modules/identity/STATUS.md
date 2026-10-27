# identity — Estado
> Fase: 1 · Estado del módulo: IN_PROGRESS · Última actualización: 2026-10-26 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-008 | SPEC de identity | claude-leader | D-009 | IN_REVIEW (falta que el frontend revise el contrato) |
| T-016 | Verificación del JWT, `app.profiles`, `current_user` / `require_admin`, `GET` y `PATCH /me` | backend-dev + qa-reviewer | T-007, T-015 | IN_PROGRESS |

## Paquetes de tarea

### T-016 — Autenticación y perfil (identity)
- Objetivo: cada solicitud protegida conoce `CurrentUser(user_id, role)` a partir del token de Supabase, y el cliente lee y edita su perfil (`GET` y `PATCH /api/v1/identity/me`).
- Responsable: backend-dev (revisan claude-leader y qa-reviewer) · Módulo: identity · Requisitos: RF01.05, RF01.06, RF11.02, RF13.01, RF13.02, RNF10 · Decisiones: D-009, D-010, D-015
- Leer: `docs/modules/identity/SPEC.md` (completa: es el contrato); `docs/modules.md` §3 (excepción de auth) y §4; `.claude/skills/backend-module-implementation/SKILL.md`; `.claude/skills/database-migration-review/SKILL.md`; `backend/src/valmont/shared/{config,errors,db}.py`; `backend/migrations/env.py`; `backend/tests/conftest.py`.
- Contratos aplicables: SPEC §7 (ProfileOut, ProfileUpdateIn, códigos `unauthenticated`/`forbidden`/`validation_error`) y formato de error de `modules.md` §4.4.
- Dependencias: T-007 y T-015 (hechas).
- Puede modificar: `backend/src/valmont/shared/auth.py` (nuevo), `backend/src/valmont/shared/money.py` (nuevo: `Money` = `{amount: int ≥ 0, currency: "PEN"}`, reutilizable por otros módulos), `backend/src/valmont/shared/config.py` (añadir `supabase_jwt_secret: SecretStr | None = None`), `backend/src/valmont/modules/__init__.py` y `backend/src/valmont/modules/identity/**` (nuevos), `backend/src/valmont/main.py` (registrar el router), `backend/migrations/env.py` (solo la línea de registro del módulo), `backend/migrations/versions/0002_*.py` (nuevo, `--rev-id 0002`), `backend/tests/**`, `backend/pyproject.toml` + `backend/uv.lock` (solo `uv add pyjwt`).
- Protegido: `docs/**`, `frontend/**`, `supabase/**`, `.claude/**`, `backend/.env` (no leas ni imprimas el secreto real).
- Resultado esperado:
  1. `shared/auth.py`: `verify_token(token) -> TokenClaims(user_id: UUID, email: str | None)` con PyJWT: `algorithms=["HS256"]` (solo ese), `audience="authenticated"`, `options={"require": ["exp", "sub"]}`; `sub` debe ser un UUID válido; cualquier fallo → `AppError("unauthenticated", …, 401)` con la cabecera `WWW-Authenticate: Bearer`. El secreto viene de `Settings.supabase_jwt_secret`; si falta, error de configuración (500, sin revelar el motivo al cliente). El `role` del token de Supabase (`authenticated`) **no** es el rol de la app.
  2. `modules/identity/domain.py`: `Profile`, `Preferences` (invariante `budget_min ≤ budget_max`), `Role` (`customer` | `admin`), normalización de `full_name` (1–120, sin espacios sobrantes) y `phone` (`^\+?[0-9]{6,15}$` tras quitar espacios). Python puro.
  3. `modules/identity/application.py`: puerto `ProfileRepository` (Protocol) y casos de uso `EnsureProfile` (idempotente) y `UpdateProfile` (solo los campos enviados; `preferences` se reemplaza completo; `accept_privacy_version` fija `privacy_version` y `privacy_accepted_at` con la hora del servidor).
  4. `modules/identity/adapters/persistence.py`: `ProfileRow(Base)` = `app.profiles` exactamente como la SPEC §6 (CHECK de rol y de `jsonb_typeof`, defaults de servidor); creación con `INSERT … ON CONFLICT (user_id) DO NOTHING` + lectura (nunca "comprobar y luego insertar").
  5. `modules/identity/adapters/http.py`: `current_user` (cabecera `Authorization: Bearer` → `verify_token` → `EnsureProfile` → `CurrentUser`), `require_admin` (403 `forbidden`), router `/api/v1/identity` con `GET /me` y `PATCH /me`; esquemas Pydantic con `extra="forbid"` en la entrada (un `role` o `user_id` en el cuerpo → 422); salida con dinero en el formato `Money` y fechas ISO 8601 UTC. La sesión, siempre con `SessionDep`.
  6. Migración `0002` generada con `uv run alembic revision --autogenerate --rev-id 0002 -m "identity profiles"` y revisada a mano (CHECK, defaults y downgrade que borra la tabla).
- Criterios de aceptación: CA-IDENTITY-01 a CA-IDENTITY-05 de la SPEC §10 (el 06 E2E lo ejecuta el Leader con Supabase real). Además: tokens firmados con otro secreto, con `alg` distinto de HS256 (p. ej. `none`), caducados, con `aud` incorrecto o sin `sub` → 401; dos llamadas a `GET /me` con el mismo token → una sola fila en `app.profiles`.
- Pruebas obligatorias (desde `backend/`): `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, `uv run pytest -m integration -q`, la comprobación de capas de la skill de puertas (`grep … src/valmont/modules/*/domain* src/valmont/modules/*/application*` vacía), `uv run alembic upgrade head` + `uv run alembic check` contra la BD de desarrollo, y `downgrade` a `0001` + `upgrade head` sobre `valmont_test` (la prueba de reversibilidad existente). Los tokens de prueba se fabrican con PyJWT y un secreto de prueba; `get_settings` está cacheado (`cache_clear` o `dependency_overrides` en las pruebas).
- Seguridad: no registrar tokens, cabeceras de autorización ni cuerpos; el `user_id` sale solo del token; mensajes 401 genéricos (no revelar si falló la firma o la caducidad).
- Estado inicial: READY · IDs reservados: ninguno (tarea hoja)
- Escalar si: el contrato de la SPEC no cubre un caso, hace falta otra dependencia, o algo exige tocar el esquema `auth` de Supabase.

## Traspasos

_(ninguno todavía)_

## Discrepancias y riesgos

- No hay FK a `auth.users` (decisión de la SPEC §6): un perfil puede quedar huérfano si se borra el usuario en Supabase Auth. Se trata junto con P-IDENTITY-1 (cancelación de cuenta).
