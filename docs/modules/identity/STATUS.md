# identity — Estado
> Fase: 1 · Estado del módulo: DONE en backend (falta que el frontend revise el contrato) · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-008 | SPEC de identity | claude-leader | D-009 | IN_REVIEW (falta que el frontend revise el contrato) |
| T-016 | Verificación del JWT, `app.profiles`, `current_user` / `require_admin`, `GET` y `PATCH /me` | backend-dev + qa-reviewer | T-007, T-015 | DONE |

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

#### Revisión T-016 — 2026-10-27 — qa-reviewer + claude-leader
- **E2E con Supabase real (claude-leader):** registro 200 → login sin confirmar 400 `email_not_confirmed` → correo en Mailpit → enlace 303 → login 200 → token **ES256** → `GET /me` **401**. Causa: la verificación solo aceptaba HS256. Decisión del usuario: D-018 (JWKS).
- **qa-reviewer: CAMBIOS REQUERIDOS.** BLOQUEANTE-1: un `\x00` en textos de entrada → 500 y nombre y teléfono en el log. IMPORTANTE-1: `create_engine` sin `hide_parameters`. IMPORTANTE-2: el OpenAPI no declara el formato real de los errores. Menores M1–M6 (strip y min_length, bool estricto, invariantes en el dominio, pruebas que faltan). Verificado sin problemas: aislamiento por usuario, `extra="forbid"`, `require_admin`, `ON CONFLICT` concurrente, CHECKs y downgrade de `0002`, ausencia de email y de tokens en los logs.
- **Ronda 1 (backend-dev):** 64 pruebas unitarias + 11 de integración en verde; migración `0002` aplicada; puertas limpias. Interpretaciones aceptadas por el Leader: 401 vía `HTTPException` (para llevar `WWW-Authenticate`); `null` en `full_name` y `phone` borra el valor y en los demás campos → 422; `Money.currency` por defecto `PEN`.
- **Ronda 2 (backend-dev):** JWKS con PyJWKClient (`algorithms=["ES256"]`, `aud`, `iss`, `exp`, `sub`; 503 `auth_unavailable` si Auth no responde; `pyjwt[crypto]`); rechazo de caracteres Cc/Cs en el dominio; `hide_parameters=True`; `ErrorOut`/`ERROR_RESPONSES` en el OpenAPI; M1–M3, M5 y M6; `__init__.py` en `tests/`. Pruebas de mutación: sin el rechazo de controles fallan 13/15; con `hide_parameters=False` falla la prueba del log.
- **Verificación del Leader:** `ruff format --check` → 34 files already formatted · `ruff check` → All checks passed! · `pytest -q` → 133 passed · `pytest -m integration -q` → 12 passed · JWKS real: 1 clave EC P-256 `ES256`/`sig` con `kid` · **E2E (CA-IDENTITY-06):** registro 200 → login sin confirmar 400 → Mailpit → confirmación 303 → login 200 → token ES256 → `GET /me` ×2 200/200 `customer` (1 fila en BD) → `PATCH` 200 (nombre normalizado, privacidad aceptada) → `role` en el cuerpo 422 → token basura 401.
- **Re-verificación de qa-reviewer: APROBADO.** Cerrados BLOQUEANTE-1, IMPORTANTE-1 e IMPORTANTE-2. Ataques al JWKS real (otra clave, confusión de algoritmo, secreto heredado de la CLI, `none`) → 401; JWKS caído con clave en caché → 200 y sin caché → 503; PyJWT 2.15.1 limita el refresco por `kid` desconocido a uno cada 30 s. Menores pendientes → T-018.

## Discrepancias y riesgos

- No hay FK a `auth.users` (decisión de la SPEC §6): un perfil puede quedar huérfano si se borra el usuario en Supabase Auth. Se trata junto con P-IDENTITY-1 (cancelación de cuenta).
- Las claves públicas del JWKS se cachean por `kid` sin caducidad: tras revocar una clave en Supabase hay que reiniciar el backend (anotado en `docs/deploy.md` §C).
- `current_user` ejecuta un `INSERT … ON CONFLICT DO NOTHING` por solicitud autenticada (no escribe si el perfil existe). Revisar si la carga lo exige.
- El contrato de la SPEC §7 está implementado pero sigue en PROPUESTO hasta que lo revise el consumidor frontend (T-008).
