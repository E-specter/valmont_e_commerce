---
name: database-migration-review
description: Revisa esquemas, tablas y migraciones de PostgreSQL/Supabase de Valmont por integridad, reversibilidad, rendimiento y riesgo destructivo. Úsala antes de crear, modificar o aplicar una migración, al diseñar la sección de persistencia de una SPEC, o cuando un cambio toque restricciones, índices, datos existentes o permisos de la base de datos.
---

# Revisión de esquema y migraciones

La herramienta de migraciones depende de **D-010** (propuesta: Alembic) y el entorno, de **D-011**. Esta lista aplica sea cual sea la herramienta.

## 1. Lista de revisión de esquema

- [ ] Cada tabla tiene PK (UUID propuesto) y la escribe solo su módulo dueño (`docs/modules.md` §3).
- [ ] Las FK tienen `ON DELETE` explícito (`RESTRICT` por defecto en los datos comerciales: pedidos y pagos nunca se borran en cascada).
- [ ] `NOT NULL` en todo lo obligatorio.
- [ ] `UNIQUE` en las reglas de unicidad: p. ej. `wishlist_items (customer_id, product_id)` (RN-03) y un carrito activo por cliente (RN-02, índice único parcial).
- [ ] `CHECK` en los invariantes: `stock >= 0` (RN-06), `quantity > 0`, importes `>= 0`, estados dentro del conjunto permitido.
- [ ] Índices en las FK y en las columnas de filtro y orden del catálogo (RF02.03–RF02.04).
- [ ] Dinero con la misma representación que el contrato (skill `api-contract-review` §5).
- [ ] Fechas en `timestamptz` con `default now()`.
- [ ] Los estados se guardan como `text` + `CHECK` (más fácil de migrar que un `enum` de Postgres).
- [ ] Las líneas de pedido guardan una instantánea comercial y no dependen del producto vivo (RN-04).
- [ ] La auditoría es de solo inserción (RF14.02): sin `UPDATE`/`DELETE` para el rol de la aplicación.

## 2. Supabase: exposición de tablas

Supabase publica el esquema `public` a través de su API de datos. Como el acceso de la aplicación va por FastAPI, cada tabla nueva debe cumplir una de estas dos condiciones:
- estar en un esquema **no expuesto** (p. ej. `app`), o
- tener **RLS activado** sin políticas para `anon`/`authenticated` (deniega todo), o con políticas revisadas.

La elección se registra en `docs/decisions.md` con la primera migración. Una tabla en `public` sin RLS es un hallazgo de seguridad bloqueante.

## 3. Lista de revisión de la migración

- [ ] Una migración = un cambio coherente, con nombre descriptivo.
- [ ] Tiene `downgrade`, o se documenta por qué no es posible.
- [ ] **Destructivo** (`DROP`, estrechar tipos, `NOT NULL` sobre datos existentes, `UPDATE`/`DELETE` masivos): requiere aprobación **del usuario**. Se propone el patrón expandir → migrar datos → contraer.
- [ ] Tablas grandes: `CREATE INDEX CONCURRENTLY` (fuera de transacción) y nada de reescrituras con bloqueo largo.
- [ ] Los datos semilla no contienen datos personales reales.
- [ ] Aplicada sobre una BD de pruebas: subir → bajar → subir, y después las pruebas de integración del módulo.
- [ ] Cada tabla, vista o secuencia nueva en `app` se concede de forma explícita al rol `valmont_app` (T-101, D-029). Las tablas de solo inserción, como `audit_log` y `stock_movements`, solo reciben `SELECT, INSERT`. Además se añade al mapa de `backend/tests/test_app_role.py`; si no, esa prueba falla. Nunca se usan `GRANT` por columna.

## 4. Prohibido para agentes

- Ejecutar migraciones contra producción.
- Usar un MCP de base de datos con permisos de escritura fuera de `dev` o sin aprobación.
- Editar una migración ya aplicada en un entorno compartido: se crea una nueva.

## 5. Evidencia en el traspaso

Archivo de migración, salida de subir/bajar/subir, resultado de las pruebas de integración y la lista anterior marcada.
