# catalog — Estado
> Fase: 2 · Estado del módulo: SPECIFICATION · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-025 | SPEC de catalog | claude-leader | D-019…D-023 | DONE (contrato aprobado por frontend-lead con cambios incorporados) |
| T-026 | Esquema `0004`, dominio y repositorios de catalog | backend-dev | T-021 | IN_PROGRESS |
| T-027 | API pública: listado con filtros, búsqueda, orden y paginación; ficha con relacionados; categorías y atributos | backend-dev | T-026 | BACKLOG |
| T-028 | API de administración: productos, publicación, categorías y listas de valores, con auditoría | backend-dev + qa-reviewer | T-026, T-021 | BACKLOG |
| T-029 | Activar Supabase Storage (puerta Docker) e imágenes: subida, orden y retirada | claude-leader + backend-dev | T-028 | BACKLOG |
| T-030 | Conectar la disponibilidad con inventory (`AvailabilityReader`) | backend-dev | módulo inventory | BACKLOG |
| T-031 | Semillas de demostración para `dev` (aprobadas por el usuario, P-CATALOG-1) | backend-dev | T-026 | BACKLOG |

IDs reservados del módulo: T-025–T-039 (libres: T-032–T-039).

## Paquetes de tarea

### T-026 — Esquema, dominio y repositorios de catalog
- Objetivo: las tablas de catalog existen con todas sus restricciones e índices, el dominio aplica sus reglas y los repositorios leen y escriben productos, categorías, listas de valores e imágenes.
- Responsable: backend-dev (revisa claude-leader) · Módulo: catalog · Requisitos: RF02.07, RF06.01, RF06.02 (base de datos y dominio; las API son T-027 y T-028) · Decisiones: D-010, D-020, D-021, D-022
- Leer: `docs/modules/catalog/SPEC.md` §4–§6 y §9; `docs/modules.md` §3–§4; `.claude/skills/backend-module-implementation/SKILL.md`; `.claude/skills/database-migration-review/SKILL.md`; como referencia de estilo, `backend/src/valmont/modules/identity/` y `audit/`, con sus pruebas.
- Dependencias: T-021 (audit) integrada, porque su migración `0003` debe ser la anterior a `0004`.
- Puede modificar: `backend/src/valmont/modules/catalog/**` (nuevo: `domain.py`, `application.py` con los puertos `ProductRepository`, `CategoryRepository` y `AttributeRepository`, y `adapters/persistence.py`), `backend/migrations/env.py` (solo la línea de registro), `backend/migrations/versions/0004_*.py` (nuevo, `--rev-id 0004`), `backend/tests/catalog/**` (nuevo, con `__init__.py`).
- Protegido: todo lo demás. Sin dependencias nuevas. Sin endpoints en esta tarea.
- Resultado esperado: el esquema de la SPEC §6 exacto, con la columna `search` generada y su índice GIN; dominio puro con `Product`, `Category`, `AttributeValue` y `ProductImage`, la generación de slug (CATALOG-R3) y la validación de publicación (CATALOG-R2); los textos rechazan caracteres de control como en identity; repositorios SQL con la consulta del listado (filtros, orden, paginación y búsqueda con `websearch_to_tsquery('spanish', :q)` parametrizado) y la de relacionados (CATALOG-R6); la unicidad de SKU y slug resuelta por los UNIQUE de la BD (el repositorio traduce la violación a un error de dominio "conflicto").
- Criterios de aceptación: migración `0004` reversible y `alembic check` limpio; pruebas de integración que demuestran cada filtro, cada orden, la paginación con `total`, la búsqueda por nombre, SKU y descripción, los relacionados, la unicidad (409 de dominio) y que un borrador no aparece en las consultas públicas; `EXPLAIN` de la búsqueda con el índice GIN (al menos con `enable_seqscan = off` en la prueba).
- Pruebas obligatorias (desde `backend/`): `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, `uv run pytest -m integration -q`, la comprobación de capas y `uv run alembic upgrade head` + `uv run alembic check`.
- Seguridad: SQL siempre parametrizado; ningún dato de prueba con apariencia de dato real.
- Estado inicial: READY · IDs reservados: ninguno (tarea hoja)
- Escalar si: la SPEC no cubre un caso, hace falta una dependencia, o hay que tocar `shared/` u otro módulo.

## Traspasos

_(ninguno todavía)_

## Discrepancias y riesgos

- Mientras T-030 no esté hecha, la API pública no puede filtrar por disponibilidad (RF02.03) ni mostrarla (RF02.05).
- El precio con promoción (RF09.02) llega con el módulo promotions; hasta entonces se muestra el precio base.
