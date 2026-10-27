# inventory — Estado
> Fase: 2 · Estado del módulo: SPECIFICATION · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-040 | SPEC de inventory | claude-leader | D-017, D-023, D-027 | DONE |
| T-041 | Esquema `0005`, dominio, repositorios, settings y vista `product_availability` | backend-dev | T-026 | READY (tras T-031, para no cruzar pruebas de integración) |
| T-042 | Casos de uso internos `ReserveStock`, `ConsumeReservations`, `ReleaseReservations` con pruebas de concurrencia | backend-dev + qa-reviewer | T-041 | BACKLOG |
| T-043 | API de administración (stock, movimientos, settings) con auditoría | backend-dev | T-041 | BACKLOG |

IDs reservados del módulo: T-040–T-049 (libres: T-044–T-049). T-030 (catalog) consumirá la vista de T-041.

## Paquetes de tarea

### T-041 — Esquema, dominio, repositorios y vista de disponibilidad
- Objetivo: las tablas y la vista de inventory existen con sus restricciones; el dominio calcula el estado (INVENTORY-R2) y los repositorios leen y escriben stock, movimientos y settings.
- Responsable: backend-dev (revisa claude-leader) · Módulo: inventory · Requisitos: RF06.04, RF06.06, RF02.08 (cálculo) · Decisiones: D-017, D-023, D-027 · **Commit: sí** (skill `version-control`)
- Leer: `docs/modules/inventory/SPEC.md` (completa); `docs/modules.md` §3–§4; skills `backend-module-implementation` y `database-migration-review`; como referencia, `backend/src/valmont/modules/catalog/` y `audit/`.
- Puede modificar: `backend/src/valmont/modules/inventory/**` (nuevo), `backend/migrations/env.py` (registro), `backend/migrations/versions/0005_*.py` (nuevo, `--rev-id 0005`), `backend/tests/inventory/**` (nuevo, con `__init__.py`), y `docs/modules/inventory/STATUS.md` (solo tu traspaso).
- Protegido: lo demás; sin endpoints (T-043) ni casos de uso de reserva (T-042) en esta tarea.
- Resultado esperado: esquema de la SPEC §6 exacto (fila única de settings insertada por la migración; vista con INVENTORY-R1 y R2); dominio puro con la función de estado y la validación de movimientos (R5, R6); repositorios de stock (con `lock(product_id)` = `FOR UPDATE`, creando la fila si no existe sin carreras: `INSERT … ON CONFLICT DO NOTHING` y después `SELECT … FOR UPDATE`), movimientos, settings y lectura de la vista.
- Criterios: CA-INVENTORY-05 contra la BD (tabla de casos de R2 con políticas, umbral y reservas vencidas); CHECK de la BD; migración reversible; `alembic check` limpio.
- Pruebas obligatorias: format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check`.
- Escalar si: la vista no puede expresar R2 de forma eficiente o hace falta tocar catalog.

## Traspasos

_(ninguno todavía)_

## Discrepancias y riesgos

- `stock_reservations.order_id` no tiene FK hasta que exista `app.orders` (la añadirá la migración de orders).
- INVENTORY-R4 refina la letra de D-017 ("una única sentencia UPDATE") por un bloqueo de fila + suma + inserción, necesario para que las reservas venzan solas; la garantía (sin carreras) es la misma.
