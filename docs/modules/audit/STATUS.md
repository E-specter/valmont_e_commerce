# audit — Estado
> Fase: 2 · Estado del módulo: DONE en backend · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-020 | SPEC de audit | claude-leader | — | DONE |
| T-021 | `app.audit_log` de solo inserción, puerto `AuditRecorder` y `AuditRecorderDep` | backend-dev (revisa claude-leader) | T-015 | DONE |

IDs reservados del módulo: T-020–T-024 (libres: T-022–T-024).

## Paquetes de tarea

### T-021 — Registro de auditoría de solo inserción
- Objetivo: cualquier módulo puede registrar una operación crítica en `app.audit_log` dentro de su propia transacción, y nadie puede modificar ni borrar el registro.
- Responsable: backend-dev (revisa claude-leader) · Módulo: audit · Requisitos: RF14.01, RF14.02 · Decisiones: D-010
- Leer: `docs/modules/audit/SPEC.md` (completa); `docs/modules.md` §3 y §4; `.claude/skills/backend-module-implementation/SKILL.md`; `.claude/skills/database-migration-review/SKILL.md`; como referencia de estilo y estructura, el módulo `backend/src/valmont/modules/identity/` y sus pruebas en `backend/tests/identity/`.
- Contratos aplicables: ninguno HTTP; el puerto `AuditRecorder` y la dependencia `AuditRecorderDep` de la SPEC §8.
- Dependencias: T-015 (hecha).
- Puede modificar: `backend/src/valmont/modules/audit/**` (nuevo: `__init__.py`, `domain.py`, `application.py`, `adapters/__init__.py`, `adapters/persistence.py`, `adapters/http.py` solo con la dependencia), `backend/migrations/env.py` (solo la línea de registro del módulo), `backend/migrations/versions/0003_*.py` (nuevo, `--rev-id 0003`), `backend/tests/audit/**` (nuevo, con `__init__.py`).
- Protegido: todo lo demás (`docs/**`, `shared/**`, otros módulos, `main.py`, `pyproject.toml`). Sin dependencias nuevas.
- Resultado esperado: `AuditEntry` con sus validaciones (dominio puro); puerto `AuditRecorder`; `SqlAuditRecorder(session)`, que inserta en la sesión recibida (sin commit propio) y toma el `request_id` de `valmont.shared.logs.request_id_var` (`None` si vale `"-"`); `AuditRecorderDep = Annotated[AuditRecorder, Depends(...)]` sobre `SessionDep`; migración `0003` con la tabla, los CHECK, los índices, la función y los dos triggers de la SPEC §6, revisada a mano (Alembic no autogenera triggers ni funciones: van con `op.execute`, y el `downgrade` los elimina en orden inverso).
- Criterios de aceptación: CA-AUDIT-01 a CA-AUDIT-05 de la SPEC §10.
- Pruebas obligatorias (desde `backend/`): `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, `uv run pytest -m integration -q`, la comprobación de capas (`grep -rnE "^(from|import) (fastapi|pydantic|sqlalchemy|httpx|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*` → vacío), `uv run alembic upgrade head` + `uv run alembic check` contra la BD de desarrollo.
- Seguridad: no registrar en logs el contenido de `before` y `after`; la prueba de inmutabilidad debe ejecutarse con el usuario de la conexión de pruebas. Corrección: en Supabase local `postgres` no es superusuario, sino propietario de la tabla; es el rol más fuerte disponible.
- Estado inicial: READY · IDs reservados: ninguno (tarea hoja)
- Escalar si: hace falta tocar `shared/`, añadir una dependencia, o el diseño del puerto no encaja con cómo lo usarán catalog e inventory.

## Traspasos

#### Traspaso T-021 — 2026-10-27 — backend-dev (revisado por claude-leader)
1. Estado final: DONE (aceptado por claude-leader).
2. Cambios: `AuditEntry` (dominio puro con AUDIT-R3 y AUDIT-R6); puerto `AuditRecorder`; `SqlAuditRecorder` (un INSERT en la sesión recibida, sin commit propio; `request_id` del contexto); `AuditRecorderDep` sobre `SessionDep`; migración `0003` (tabla, CHECK, índices, función y triggers de UPDATE/DELETE y TRUNCATE; `downgrade` en orden inverso). `JSONB(none_as_null=True)` para que `None` sea NULL de SQL y no burle el CHECK.
3. Pruebas (reejecutadas por el Leader): `ruff format --check` → 45 files already formatted · `ruff check` → All checks passed! · `pytest -q` → 147 passed · `pytest -m integration -q` → 22 passed · `alembic check` → No new upgrade operations detected. Integración: todos los campos y el `request_id`, rollback sin filas, UPDATE/DELETE/TRUNCATE rechazados, CHECK de la BD, bajada y subida pasando por `0003`.
4. No ejecutado: bajar y subir en la BD de desarrollo (borraría `app.profiles`; cubierto en `valmont_test`).
5. Riesgos: ver la sección siguiente.

## Discrepancias y riesgos

- El propietario de la tabla (en local, `postgres`) o un superusuario pueden desactivar los triggers (`ALTER TABLE … DISABLE TRIGGER`). La garantía completa llega en producción con el rol `valmont_app`, que no es propietario (hito M1).
- AUDIT-R1 depende de que los endpoints consumidores pidan la sesión con `SessionDep` (`docs/modules.md` §4.5).
- Un `entity_id` hecho solo de espacios pasa la validación (riesgo bajo: los consumidores pasan identificadores reales).
