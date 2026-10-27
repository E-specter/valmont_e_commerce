# inventory — Estado
> Fase: 2 · Estado del módulo: SPECIFICATION · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-040 | SPEC de inventory | claude-leader | D-017, D-023, D-027 | DONE |
| T-041 | Esquema `0005`, dominio, repositorios, settings y vista `product_availability` | backend-dev | T-026 | DONE (`84d60d8`; verificado por claude-leader: 597 unitarias + 182 integración) |
| T-042 | Casos de uso internos `ReserveStock`, `ConsumeReservations`, `ReleaseReservations` con pruebas de concurrencia | backend-dev + qa-reviewer | T-041 | IN_REVIEW (ronda 3 preparada sin commit, D-028: prueba concurrente de R11, reloj efectivo e I-1 con ambos ganadores; pendiente de ejecución por qa-reviewer) |
| T-043 | API de administración (stock, movimientos, settings) con auditoría | backend-dev + qa-reviewer | T-041 | BACKLOG |

IDs reservados del módulo: T-040–T-049 (libres: T-044–T-049). T-030 (catalog) consumirá la vista de T-041.

## Paquetes de tarea

### T-043 — API de administración de inventory
- Objetivo: el admin consulta el stock (con reservado, disponible y estado), registra movimientos con su motivo y cambia el umbral, por la API de la SPEC §7, con auditoría.
- Responsable: backend-dev (verifica qa-reviewer, acepta claude-leader) · Módulo: inventory · Requisitos: RF06.04, RF06.06, RF14.01 · Decisiones: D-027, D-028 · **Entrega:** preparada sin commit, con el mensaje propuesto (PROTOCOL §11.2)
- Leer: `docs/modules/inventory/SPEC.md` §3 (UC-01…03), §4 (R5, R6, R7, R9), §7; patrones de `catalog/adapters/admin_http.py` (router con `require_admin`, `_domain_errors`, `ERROR_RESPONSES`, 409 por ruta) y `AuditRecorderDep`.
- Puede modificar: `backend/src/valmont/modules/inventory/**`, `backend/src/valmont/main.py` (registrar el router), `backend/tests/inventory/**`, tu traspaso en este STATUS.
- Resultado esperado: router `/api/v1/inventory/admin` con las 5 rutas de §7; `POST …/movements` bajo `lock()` del producto: R5 (delta del ajuste calculado por el servidor, nota obligatoria), R6 (409 `insufficient_stock` / `stock_reserved`, con lo reservado leído tras el bloqueo), R9 (422 `no_change`); producto inexistente → 404; auditoría `inventory.stock_adjusted` (before/after `on_hand`, `kind`) y `inventory.threshold_changed` en la misma transacción, con el actor del token; listado con `q` (SKU o nombre), filtro `status` y paginación como en catalog.
- Criterios: CA-INVENTORY-01 y 05 por HTTP contra `valmont_test`; 401/403 en todas las rutas; OpenAPI con `ErrorOut`.
- Pruebas obligatorias: las escribe backend-dev; qa-reviewer ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y OpenAPI (D-028).

### T-042 — Reservas de stock para orders (con concurrencia)
- Objetivo: orders puede reservar, consumir y liberar stock de un pedido sin vender nunca dos veces la misma unidad y sin interbloqueos (RN-06, RN-16, D-017).
- Responsable: backend-dev (revisan claude-leader y qa-reviewer) · Módulo: inventory · Requisitos: RF06.05, RF06.06 · Reglas: INVENTORY-R1, R4, R8, R10 · **Commit: sí**
- Leer: `docs/modules/inventory/SPEC.md` §3 (UC-04…06), §4, §5; tu código de T-041.
- Puede modificar: `backend/src/valmont/modules/inventory/**`, `backend/tests/inventory/**` y tu traspaso en este STATUS. Sin migraciones (el esquema ya existe); si hace falta una, escala.
- Resultado esperado:
  1. Dominio: `Reservation` y las reglas de R10 (qué líneas reservan según `order_policy` y disponible).
  2. Repositorio de reservas (insertar, listar activas por pedido, cambiar estado) y lectura de `order_policy`/`lead_time_days` de `app.products` (solo esas columnas, como la vista).
  3. `ReserveStock(order_id, líneas, now)`: bloquea las filas de stock **ordenadas por `product_id`** (`lock()`), suma las reservas vigentes en una sentencia posterior, decide por R10 y, si alguna línea de stock no alcanza, falla entera con `InsufficientStock(product_ids)` sin dejar nada; vencimiento = `now + 30 min`; devuelve qué líneas reservaron y cuáles van bajo pedido (con `lead_time_days`).
  4. `ConsumeReservations(order_id, now)`: con las filas bloqueadas en el mismo orden, si alguna reserva activa venció → `ReservationExpired` (sin cambios); si no, descuenta `on_hand`, registra un movimiento `venta` por línea (con `order_id`) y marca `consumed`. Idempotente si ya estaban consumidas.
  5. `ReleaseReservations(order_id)`: activas → `released`; idempotente.
- Criterios: CA-INVENTORY-02, 03, 04 y 06 de la SPEC. Pruebas de concurrencia **con dos conexiones reales en hilos** contra `valmont_test`: (a) dos pedidos por la última unidad → exactamente uno reserva; (b) dos pedidos con los productos A y B en orden inverso → ambos terminan sin interbloqueo; (c) una reserva vencida no cuenta y se puede volver a reservar esa unidad. Para limpiar filas confirmadas en estas pruebas usa una base propia de la prueba o borra al final (las tablas de inventory sí permiten borrar; `audit_log` no se toca porque estos casos de uso no auditan).
- Pruebas obligatorias: format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check`.
- Escalar si: hace falta otra tabla o columna, o R10 no cubre un caso.

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

#### Revisión T-042 ronda 2 — 2026-10-27 — qa-reviewer (anotada por claude-leader)
- **Veredicto:** APROBADO sobre `615189d`. Las puertas coinciden: 621 unitarias, 199 de integración, `ruff`, capas y `alembic check`. `test_concurrency` pasó ×10 y la simulación aleatoria 8/8.
- **IMPORTANTE:** ninguna prueba detecta que R11 lea los totales antes de bloquear el stock. Con el mutante, pasan 131/131. La sonda P1b (Consume esperando el stock de un Reserve que confirma después) sí lo detecta.
- **MENOR P7:** R11 podía rechazar un pedido vigente cuando otros dos coinciden en el límite. El Leader decide el reloj efectivo (SPEC R11).
- **MENOR:** la prueba de I-1 solo ejercita el caso en que gana Consume, y el docstring de `ReservationExpired` no cita R11.
- **Siguiente:** ronda 3 con backend-dev, ya con D-028 (sin ejecutar pruebas, entrega preparada).

#### Traspaso T-042 (ronda 3: B-1 concurrente, reloj efectivo de R11 e I-1 con ambos ganadores) — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW. Pendiente de que qa-reviewer ejecute las pruebas (D-028); revisa también claude-leader.
2. Cambios:
   - **Reloj efectivo (SPEC R11, P7).** En `ConsumeReservations`:
     1. Bloquea las reservas del pedido y hace la comprobación temprana `to_consume(…, now)`.
     2. Bloquea el stock en orden de `product_id`.
     3. Después de los bloqueos, `latest_expiry(product_ids)` y `effective = max(now, latest − 30 min)`; si `latest` es `None`, `now`.
     4. Con `effective`, y no con `now`, se calculan `to_consume` (R8) y `active_totals` (R11).
     - Método nuevo del puerto `ReservationRepository.latest_expiry(product_ids) -> datetime | None`. Su adaptador hace una sola consulta: `max(expires_at)` de las reservas `active` de cualquier pedido.
   - **Docstring de `ReservationExpired`:** añade "o ya no está cubierta por el stock (INVENTORY-R11)".
   - **Pruebas nuevas o cambiadas, sin ejecutar** (D-028):
     - `test_concurrency.py::test_consume_that_waited_for_a_reservation_at_the_edge_loses`. Es la sonda P1b de QA: on_hand 1 y Reserve(O, T0) confirmado. Reserve(X, T0+30m+1s) retiene su commit hasta que Consume(O, T0+30m−1s) aparece en `pg_stat_activity` esperando un `Lock`. Se espera: X ok, O `ReservationExpired`, on_hand 1, 0 ventas, y O y X `active`.
     - `test_concurrency.py::test_consume_and_release_of_the_same_order_do_not_deadlock`, parametrizada con `first ∈ {consume, release}`. Cada uno arranca cuando el anterior ya espera.
       - Si espera primero Consume: los dos sin error, todo `consumed`, on_hand [0, 0] y 2 ventas.
       - Si espera primero Release: Release sin error y Consume `ReservationExpired` (R8); todo `released`, on_hand [1, 1] y 0 ventas.
     - `test_reservations.py::test_a_valid_order_is_not_beaten_by_two_others_at_the_edge` (P7, determinista, on_hand 2):
       - Y reserva en T0, O en T0+10m y Z en T0+30m+1s (obtiene reserva).
       - Consume(O, T0+30m−1s) → on_hand 1, una `venta` de O, O `consumed` y Z `active`.
       - Después Consume(Y, T0+30m−1s) → `ReservationExpired`, sin cambios.
     - `test_reservations.py::test_reservations_round_trip` comprueba además `latest_expiry`: devuelve la activa aunque haya vencido, ignora una liberada posterior y da `None` sin reservas.
     - `test_application.py`: el fake gana `latest_expiry`, y hay tres unitarias nuevas.
       - El reloj efectivo en R8: on_hand 5, Y en T0 y otra reserva en T0+30m+1s → `ReservationExpired` sin escrituras.
       - El reloj efectivo en los totales: P7 con fakes, O se vende y solo se cierra su id.
       - La red de seguridad de R11: dos reservas vigentes al reloj efectivo con on_hand 1 → `ReservationExpired` sin escrituras.
     - La B-1 secuencial existente sigue siendo coherente: O falla ahora por R8 (al reloj efectivo su reserva ya venció), la aserción `ReservationExpired` se mantiene y solo cambia el comentario. Después, Consume(X, T0+30m+2s) usa effective = T0+30m+2s; la reserva de O no cuenta y X se vende.
   - **Mutantes que deberían detectar estas pruebas** (los he comprobado a mano, no ejecutando):
     - Leer los totales y el reloj antes de bloquear el stock (el `mut_order.py` de QA) → falla la P1b concurrente.
     - Usar `now` en `active_totals` → fallan la unitaria de totales y la P7 de integración.
     - Usar `now` en el `to_consume` final → falla la unitaria de R8.
     - Quitar la comprobación de R11 → falla la unitaria de la red de seguridad.
     - Release sin `lock=True` → falla la I-1 (las dos variantes).
3. Archivos modificados: `backend/src/valmont/modules/inventory/{domain,application}.py`, `backend/src/valmont/modules/inventory/adapters/persistence.py`, `backend/tests/inventory/{test_application,test_reservations,test_concurrency}.py` y este STATUS (fila de T-042 y este traspaso).
4. Decisiones tomadas: ninguna; aplico la SPEC R11 "Reloj efectivo" (84403e2) y D-028.
5. Pruebas ejecutadas → resultado observado (solo análisis estático, D-028, desde `backend/`):
   - `uv run ruff format .` → 87 files left unchanged.
   - `uv run ruff check .` → All checks passed!
   - `uv run ruff format --check .` → 87 files already formatted.
   - Capas: `grep -rnE "^(from|import) (fastapi|pydantic|sqlalchemy|httpx|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*` → sin salida (exit 1).
6. Pruebas no ejecutadas y motivo: NO EJECUTADO: pruebas (D-028). Tampoco `pytest -q`, `pytest -m integration -q` ni `alembic check`. Recuento esperado: +3 unitarias (624) y +3 de integración (202: la P1b, la segunda variante de I-1 y la P7).
7. Dependencias pendientes: ejecución por qa-reviewer; las de las rondas anteriores (orders, T-043).
8. Riesgos conocidos:
   - Pruebas sin ejecutar: podrían tener errores que el análisis estático no ve.
   - El reloj efectivo puede hacer fallar un pago 1 s antes del límite si otro pedido ya reservó con un reloj posterior. Es lo que decide R11: pierde quien paga en el límite.
9. Preguntas que requieren decisión: ninguna nueva (I-5 e I-6 siguen abiertas).
10. Documentación actualizada: este STATUS.
11. Siguiente acción recomendada: que qa-reviewer ejecute las puertas y sus mutantes (incluido `mut_order.py`) sobre este cambio preparado.
12. Commits: ninguno — preparado (D-028). Rutas: las del punto 3. Mensaje propuesto: `test(inventory): B-1 concurrente, reloj efectivo de R11 y ambos ganadores de I-1 (T-042)`.

#### Traspaso T-042 (ronda 2: B-1, I-1, M-1 de qa-reviewer) — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (revisan claude-leader y qa-reviewer).
2. Cambios:
   - B-1 (INVENTORY-R11): `ConsumeReservations` bloquea primero las reservas del pedido y comprueba `to_consume`. Después bloquea con `_lock` el stock de todos sus productos, sin duplicados y en orden de `product_id`. Con todo bloqueado, `active_totals` (reservas propias y ajenas) y, si algún `on_hand < total`, `ReservationExpired` antes de escribir. Solo entonces `update`, la `venta` por reserva y el cierre.
   - I-1 (INVENTORY-R12): `ReleaseReservations` llama primero a `for_order(order_id, lock=True)`, en el mismo orden `(product_id, id)` que Consume, y cierra solo si hay activas.
   - M-1: el puerto `close_active(order_id, status)` pasa a `close(reservation_ids, status)`; el adaptador hace `UPDATE … WHERE id IN (…)`. Consume cierra exactamente los ids de `consumed`, y Release los ids activos que devolvió `for_order`.
   - Fakes nuevos en `test_application.py`, que antes no existía.
3. Archivos modificados: `backend/src/valmont/modules/inventory/application.py`, `backend/src/valmont/modules/inventory/adapters/persistence.py`, `backend/tests/inventory/test_application.py` (nuevo), `backend/tests/inventory/test_reservations.py`, `backend/tests/inventory/test_concurrency.py` y este STATUS (fila de T-042 y traspaso). La SPEC no se ha tocado.
4. Decisiones tomadas: ninguna; aplico R11 y R12 de la SPEC (7d8ba10).
5. Pruebas ejecutadas → resultado observado (desde `backend/`):
   - `uv run ruff format --check .` → 87 files already formatted.
   - `uv run ruff check .` → All checks passed!
   - `uv run pytest -q` → 621 passed, 199 deselected in 8.09s (+4 de `test_application.py`).
   - `uv run pytest -m integration -q` → 199 passed, 621 deselected in 10.71s (+1 de B-1 en `test_reservations.py` y +1 de I-1 en `test_concurrency.py`).
   - Capas: `grep -rnE "^(from|import) (fastapi|pydantic|sqlalchemy|httpx|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*` → sin salida (exit 1).
   - `uv run alembic check` → No new upgrade operations detected.
   - Repetición de `test_concurrency.py` cinco veces (`--keep-duplicates`) → 20 passed in 6.52s.
   - Pruebas nuevas:
     - B-1 unitaria con fakes: `ReservationExpired` sin `update`, sin movimientos y sin `close`.
     - B-1 de integración, determinista: la secuencia de la sonda con on_hand 1 da `ReservationExpired`, on_hand sigue en 1, no hay `venta` y la reserva de O sigue `active`; después `Consume(X)` deja on_hand 0 y X `consumed`.
     - M-1 unitarias: se cierran exactamente los ids consumidos o liberados, una sola vez, y no se tocan las reservas de otro pedido.
     - Orden de bloqueo de Consume: `[A, B]`, cada producto una vez.
     - I-1 con hilos: reservas en orden físico [B, A] y un tercero que retiene la de A hasta ver esperando (`pg_stat_activity`, `Lock`) a Consume y después a Release. Al soltarla, los dos terminan sin `DeadlockDetected`, y el estado queda coherente: todo `consumed` con on_hand 0 y 2 ventas, o todo `released` con on_hand 1 y 0 ventas.
   - Mutaciones (cambio temporal y revertido; `MUTANTE` → 0 coincidencias):
     - Sin la comprobación de R11 → fallan las dos pruebas de B-1 (unitaria e integración).
     - Release sin `lock=True` → la de I-1 falla con `psycopg.errors.DeadlockDetected … while locking tuple … in relation "stock_reservations"`, el fallo que encontró QA.
   - Limpieza: tras la suite, en `valmont_test` hay 0 productos `TST-INV-%`, 0 categorías `inventario-%` y 0 filas en las tablas de inventory, también después de la ejecución con el mutante que falló.
   - Incidencia: a mitad de la tarea, Postgres local dejó de aceptar conexiones (`connection timeout expired`; TCP a 127.0.0.1:54322 → 10061, conexión rechazada). No toqué Docker ni la CLI. Al rato el puerto volvió solo (TCP → 0), y todas las pruebas de arriba se ejecutaron después.
6. Pruebas no ejecutadas y motivo: ninguna de las obligatorias.
7. Dependencias pendientes: las de la ronda 1 (orders valida productos y usa un único reloj; T-043).
8. Riesgos conocidos:
   - En la prueba de I-1 gana Consume porque espera primero. La prueba acepta los dos ganadores, pero en la práctica solo ejercita ese caso.
   - Postgres local se cayó una vez durante la tarea.
9. Preguntas que requieren decisión: I-5 e I-6 siguen abiertas (ronda 1).
10. Documentación actualizada: este STATUS.
11. Siguiente acción recomendada: que qa-reviewer vuelva a pasar su sonda de B-1 y su prueba de I-1 sobre este commit.
12. Commits: el que contiene este traspaso, `fix(inventory): consumo en el límite del vencimiento y orden de bloqueo con release (T-042)` (el hash va en el traspaso al Leader).

#### Traspaso T-042 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (revisan claude-leader y qa-reviewer).
2. Cambios:
   - Dominio:
     - `Reservation`, `ReservationStatus`, `RESERVATION_MINUTES = 30`, `OrderLine` y `ProductPolicy`.
     - `OnRequestLine` y `ReservationExpired`. `InsufficientStock` lleva ahora `product_ids`.
     - `plan_reservations` (R10 + todo o nada): `made_to_order` nunca reserva; `backorder` reserva si alcanza y, si no, la línea entera va bajo pedido; una línea `stock` que no alcanza hace fallar el pedido con todos los productos que faltan. Las líneas repetidas de un producto se descuentan en orden.
     - `to_consume` (R8): lista vacía si no hay reservas o ya se consumieron. Si alguna activa venció o alguna está liberada, `ReservationExpired`.
   - Casos de uso en `application.py`. No hacen commit: corren en la transacción de orders.
     - `ReserveStock(order_id, lines, now) → ReservedOrder(reservations, on_request)`: lee las políticas y bloquea con `lock()` las filas de los productos no `made_to_order` en orden de `product_id`. Después suma las reservas vigentes de todos en **una** sentencia, planifica e inserta las reservas, que vencen a `now + 30 min`.
     - `ConsumeReservations(order_id, now)`: primero bloquea las reservas del pedido (`FOR UPDATE`) y luego el stock en orden de `product_id`. Descuenta `on_hand` y registra un movimiento `venta` por reserva (con `order_id`); después marca las reservas `consumed`.
     - `ReleaseReservations(order_id)`: activas → `released`.
   - Adaptadores: `SqlReservationRepository` (`add`, `active_totals`, `for_order(lock)`, `close_active`) y `SqlProductPolicies`, que lee de `app.products` solo `id`, `order_policy` y `lead_time_days`, las mismas columnas que la vista. Sin migraciones.
3. Archivos modificados:
   - `backend/src/valmont/modules/inventory/{domain,application}.py` y `adapters/persistence.py`.
   - `backend/tests/inventory/test_domain.py`, `test_persistence.py` (los ayudantes pasan al módulo nuevo), `inventory_helpers.py` (nuevo), `test_reservations.py` (nuevo) y `test_concurrency.py` (nuevo).
   - Este STATUS: fila de T-042, traspaso e I-5…I-8.
4. Decisiones tomadas: ninguna nueva. Interpretaciones en I-5…I-8.
5. Pruebas ejecutadas → resultado observado (desde `backend/`):
   - Línea base: `uv run pytest -q` → 597 passed, 182 deselected; `uv run pytest -m integration -q` → 182 passed, 597 deselected.
   - `uv run pytest -q tests/inventory/test_domain.py` → antes del dominio, 1 error de colección (rojo esperado); después, 69 passed.
   - `uv run ruff format --check .` → 86 files already formatted.
   - `uv run ruff check .` → All checks passed!
   - `uv run pytest -q` → 617 passed, 197 deselected in 8.38s.
   - `uv run pytest -m integration -q` → 197 passed, 617 deselected in 12.80s. Incluye las 12 de `test_reservations.py` (CA-03, CA-04, todo o nada, vencida que no cuenta, idempotencias, liberada que no se cobra) y las 3 de `test_concurrency.py`.
   - Concurrencia (`test_concurrency.py`; cada transacción en su conexión, con commit y borrado al final):
     - (a) Dos pedidos por la última unidad. La segunda transacción se lanza mientras la primera retiene su bloqueo, y la prueba espera a verla en `pg_stat_activity` con `wait_event_type = 'Lock'` → exactamente una reserva; la otra recibe `InsufficientStock((product_id,))`.
     - (b) Pedidos A+B y B+A en hilos, con una barrera tras el primer bloqueo de cada uno → los dos reservan sin interbloqueo.
     - (c) Una reserva de hace 31 min sin liberar → otro pedido reserva la unidad; consumir la vencida da `ReservationExpired` y consumir la nueva deja `on_hand` 0. Va en conexiones separadas, secuencial: el vencimiento no depende del entrelazado.
   - Pruebas de mutación (cambio temporal y revertido; `grep MUTANTE` → nada):
     - Bloquear en el orden de las líneas en vez de ordenado → (b) falla con `psycopg.errors.DeadlockDetected`.
     - Quitar `FOR UPDATE` de `lock()` → (a) falla ("La segunda transacción nunca esperó el bloqueo de la primera").
   - Limpieza: tras la suite, en `valmont_test` hay 0 productos `TST-INV-%`, 0 categorías `inventario-%` y 0 filas en `inventory_items`, `stock_reservations` y `stock_movements`.
   - Capas: `grep -rnE "^(from|import) (fastapi|pydantic|sqlalchemy|httpx|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*` → sin salida.
   - `uv run alembic check` → No new upgrade operations detected; `uv run alembic current` → 0005 (head).
   - Incidencia: una ejecución intermedia de `pytest -m integration -q tests/inventory` falló en la preparación (41 errors in 53.94s, `pytest.fail` del fixture `alembic_config`; lo más probable, un corte momentáneo de Supabase local). Repetida sin cambios → 41 passed, y la suite completa posterior pasó.
6. Pruebas no ejecutadas y motivo:
   - `Consume` concurrente con `Consume` o con `Release` del mismo pedido: no lo pide el paquete. Lo cubre el diseño (`for_order(lock=True)` serializa), pero no hay prueba con hilos.
   - Pruebas de aplicación con fakes en memoria: los casos de uso se prueban contra la BD real (`test_reservations.py`), y su lógica pura está en el dominio con pruebas unitarias.
7. Dependencias pendientes: orders (Fase 4) debe validar los productos con catalog antes de `ReserveStock` (I-5) y pasar un único reloj (I-8). T-043 sigue en BACKLOG.
8. Riesgos conocidos: ver I-6 e I-8.
9. Preguntas que requieren decisión: I-5 e I-6 (decide claude-leader).
10. Documentación actualizada: este STATUS.
11. Siguiente acción recomendada: revisión de qa-reviewer centrada en `test_concurrency.py` y en el orden de bloqueos de `ConsumeReservations`.
12. Commits: el que contiene este traspaso, `feat(inventory): reservas de stock para pedidos (T-042)` (el hash va en el traspaso al Leader).

#### Traspaso T-041 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (revisa claude-leader).
2. Cambios: migración `0005` con las cuatro tablas de la SPEC §6 (CHECK, FK `RESTRICT` a `app.products`, índices), la fila única de ajustes (umbral 2) y la vista `app.product_availability` (INVENTORY-R1 y R2; de `app.products` solo lee `id`, `order_policy` y `lead_time_days`; la suma de reservas vigentes va en un `LATERAL` que usa el índice `(product_id, status, expires_at)`). Dominio puro: `availability_status` (R2), `admin_movement` (R5 y R6: delta calculado en el ajuste, nota obligatoria 1–500 sin caracteres de control, `venta` reservada al sistema, `insufficient_stock` gana a `stock_reserved`), `StockItem`, `StockMovement` (mismos invariantes que los CHECK), `InventorySettings`, `Availability`. Puertos en `application.py` (sin casos de uso). Repositorios SQL: `SqlStockRepository.lock` (`INSERT … SELECT id FROM app.products … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE`; `None` si el producto no existe, sin violar la FK) y `update`; `SqlMovementRepository.add` (devuelve `id` y `created_at`) y `list_recent`; `SqlSettingsRepository.get(lock)` y `update`; `SqlAvailabilityReader.get`. Sin endpoints ni casos de uso de reserva.
3. Archivos modificados: `backend/src/valmont/modules/inventory/{__init__,domain,application}.py`, `backend/src/valmont/modules/inventory/adapters/{__init__,persistence}.py`, `backend/migrations/versions/0005_inventory.py`, `backend/migrations/env.py` (una línea de registro), `backend/tests/inventory/{__init__,test_domain,test_persistence}.py`, este STATUS (fila de T-041 y traspaso).
4. Decisiones tomadas: ninguna nueva. Interpretaciones anotadas en "Discrepancias y riesgos" (I-1…I-4).
5. Pruebas ejecutadas → resultado observado (desde `backend/`):
   - línea base `uv run pytest -q` → 548 passed, 141 deselected; `uv run pytest -m integration -q` → 141 passed, 548 deselected
   - `uv run pytest -q tests/inventory` antes de `domain.py` → 1 error de colección (rojo esperado); después → 49 passed
   - `uv run ruff format --check .` → 83 files already formatted
   - `uv run ruff check .` → All checks passed!
   - `uv run pytest -q` → 597 passed, 182 deselected in 7.15s
   - `uv run pytest -m integration -q` → 182 passed, 597 deselected in 8.08s (incluye `test_migrations`: base → head → base → head con `0005` en `valmont_test`, y la tabla de CA-INVENTORY-05 con 19 casos: políticas, sin fila de stock, reservas vigentes, vencidas, consumidas y liberadas, umbral 5 y 1; cada caso compara además la vista con `availability_status`)
   - capas `grep -rnE "^(from|import) (fastapi|pydantic|sqlalchemy|httpx|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*` → sin salida (exit 1)
   - BD de desarrollo: `uv run alembic upgrade head` → `Running upgrade 0004 -> 0005`; `uv run alembic check` → No new upgrade operations detected; `uv run alembic downgrade 0004` + `uv run alembic upgrade head` → `0005 (head)` y `alembic check` limpio otra vez
   - vista en desarrollo (12 productos de demostración, sin stock): backorder → on_request 3, made_to_order → on_request 2, stock → out_of_stock 7; `inventory_settings` = una fila (1, 2)
6. Pruebas no ejecutadas y motivo: `alembic downgrade base` contra la BD de desarrollo (borraría las semillas de catalog; el ida y vuelta completo se hizo en `valmont_test`); prueba de concurrencia de `lock()` con dos conexiones reales (es de T-042, con qa-reviewer; aquí solo se comprueba que emite `ON CONFLICT (product_id) DO NOTHING` y `FOR UPDATE`).
7. Dependencias pendientes: T-042 (reservas: la entidad `Reservation` del dominio y el repositorio de reservas se crean allí), T-043 (API de administración), T-030 (catalog lee la vista). Las semillas de desarrollo no crean stock: todos los productos de demostración salen `out_of_stock` u `on_request` hasta que alguien registre entradas.
8. Riesgos conocidos: ver I-1…I-4. La vista calcula todo el catálogo si se filtra por `status` sin acotar productos; con el volumen de una relojería es aceptable (cada suma es un escaneo de índice).
9. Preguntas que requieren decisión: I-1 (respuesta de la API a un recuento igual a `on_hand`) — decide claude-leader antes de T-043; I-2 (mostrar `lead_time_days` solo en `on_request`) — decide claude-leader en T-030.
10. Documentación actualizada: este STATUS.
11. Siguiente acción recomendada: revisar y aceptar T-041 y lanzar T-042 (reservas con pruebas de concurrencia de dos conexiones) usando `SqlStockRepository.lock`.
12. Commits: el que contiene este traspaso, `feat(inventory): esquema, dominio y vista de disponibilidad (T-041)` (el hash va en el traspaso al Leader).

## Discrepancias y riesgos

- `stock_reservations.order_id` no tiene FK hasta que exista `app.orders` (la añadirá la migración de orders).
- INVENTORY-R4 refina la letra de D-017 ("una única sentencia UPDATE") por un bloqueo de fila + suma + inserción, necesario para que las reservas venzan solas; la garantía (sin carreras) es la misma.
- I-1 (T-041): un `ajuste_inventario` con la cantidad contada igual a `on_hand` da delta 0, que prohíbe `CHECK (quantity_delta <> 0)`; el dominio lo rechaza con `InvalidMovement`. La SPEC no dice si la API responde 422 o 200 sin movimiento — decide claude-leader antes de T-043.
- I-2 (T-041): la vista devuelve `lead_time_days` del producto tal cual, también cuando el estado no es `on_request` (p. ej. un `backorder` con stock); catalog decide en T-030 si solo lo muestra con "Bajo pedido".
- I-3 (T-041): `available` es `on_hand − reservas vigentes` sin recortar a 0; R4 y R6 lo mantienen ≥ 0, y si no, el estado cae en `out_of_stock`/`on_request`.
- I-4 (T-041): `SqlStockRepository.lock` lee `app.products.id` (la misma columna que la vista) para no violar la FK con un producto inexistente. Para R6, T-043 puede obtener lo reservado como `on_hand − available` leyendo la vista tras `lock()` en la misma transacción.
- I-5 (T-042): `ReserveStock` con un producto inexistente lanza `LookupError`, como error de programación, porque orders valida los productos con catalog antes. La SPEC no lo define — decide claude-leader si orders necesita un error de negocio.
- I-6 (T-042): `ConsumeReservations` sobre un pedido con reservas liberadas lanza `ReservationExpired`. Un no-op silencioso cobraría unidades sin reserva (RN-06). La idempotencia solo cubre reservas ya consumidas o pedidos sin reservas — decide claude-leader si lo confirma.
- I-7 (T-042): las líneas repetidas de un mismo producto se acumulan y cada una tiene su reserva; R10 se aplica línea a línea en el orden recibido.
- I-8 (T-042): `now` lo pasa quien llama (reloj de la aplicación), mientras que la vista usa `now()` de la BD. Con varias instancias del backend, un desfase de reloj puede hacer que reservar y consumir discrepen sobre el vencimiento en ese margen. No se vende de más: `StockItem` y el CHECK `on_hand >= 0` hacen fallar la operación. Recomendación para orders: un único reloj, por ejemplo `now()` de la BD.
