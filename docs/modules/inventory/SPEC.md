# inventory — Especificación
> Estado: PROPUESTO (decisiones de negocio aprobadas por el usuario en D-017, D-023 y D-027) · Requisitos: RF06.04, RF06.05, RF06.06 (y el cálculo de RF02.08) · Reglas: RN-06, RN-16 · Dueño: backend · Última actualización: 2026-10-27 claude-leader

## 1. Problema y alcance

Saber cuántas unidades de cada reloj se pueden vender, sin vender nunca dos veces la misma, y registrar cada cambio de stock.

- **Incluye:** stock por producto en un único almacén (D-027); movimientos con motivo; reservas con vencimiento (D-017); cálculo del estado de disponibilidad (D-023) con umbral configurable; API de administración; casos de uso internos para orders (reservar, consumir, liberar).
- **No incluye:** la máquina de estados del pedido (orders), la exposición pública de la disponibilidad (la sirve catalog en T-030 leyendo la vista de §6), ni varias ubicaciones.

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Administrador (`require_admin`) | Consultar stock y movimientos; registrar entradas, ajustes, mermas y devoluciones; cambiar el umbral | Dejar el stock por debajo de lo reservado ni en negativo |
| Módulo orders (casos de uso internos) | Reservar, consumir y liberar reservas de sus pedidos | Escribir en las tablas de inventory |
| Módulo catalog (lectura) | Leer la vista `app.product_availability` en sus consultas | Escribir en inventory |
| Visitante | Ver la disponibilidad a través de catalog | Ver cantidades |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-INVENTORY-01 | Admin | Movimiento `entrada`, `ajuste_inventario` (cantidad contada), `merma` o `devolucion` + nota | Stock actualizado, movimiento y auditoría | 401, 403, 404, 409 `stock_reserved` / `insufficient_stock`, 422 | RF06.04, RF06.06 |
| UC-INVENTORY-02 | Admin | Listado y detalle de stock | `on_hand`, reservado vigente, disponible, estado y últimos movimientos | 401, 403, 404 | RF06.04 |
| UC-INVENTORY-03 | Admin | Cambiar `low_stock_threshold` | Umbral nuevo (≥ 1), auditado | 401, 403, 422 | D-027 |
| UC-INVENTORY-04 | orders | `ReserveStock(order_id, líneas, now) → ReservedOrder(reservations, on_request)`; una sola vez por pedido (no es idempotente) | Una reserva por línea con stock, todas o ninguna, que vence a los 30 min; las líneas bajo pedido no reservan | `InsufficientStock(product_ids)` | RF06.05 |
| UC-INVENTORY-05 | orders | `ConsumeReservations(order_id, now)` al pagar | Descuenta `on_hand`, movimiento `venta`, reservas `consumed` | `ReservationExpired` si alguna venció, fue liberada o ya no está cubierta por el stock (INVENTORY-R11) | RF06.05 |
| UC-INVENTORY-06 | orders | `ReleaseReservations(order_id)` al cancelar o vencer | Reservas `released` (idempotente) | — | RF06.05 |
| UC-INVENTORY-07 | catalog | Consulta con la vista de disponibilidad | Estado `in_stock` / `low_stock` / `out_of_stock` / `on_request` + `lead_time_days` | — | RF02.08 |

## 4. Reglas de negocio

- **Globales:** RN-06 (stock nunca negativo; reserva de 30 min; no vender dos veces), RN-16 (bajo pedido no reserva), D-023 (estados y política de venta), D-027.
- **INVENTORY-R1 (disponible):** `disponible = on_hand − Σ reservas activas no vencidas`. Una reserva vencida deja de contar aunque nadie la haya liberado.
- **INVENTORY-R2 (estado, D-023):** si `order_policy = made_to_order` → `on_request`; si no, con `disponible > umbral` → `in_stock`; con `1 ≤ disponible ≤ umbral` → `low_stock` ("Últimas unidades"); con `disponible = 0` → `on_request` si `order_policy = backorder`, si no `out_of_stock`. Sin fila de stock = `on_hand` 0.
- **INVENTORY-R3 (umbral, D-027):** global, por defecto 2, entero ≥ 1, editable por el admin sin desplegar.
- **INVENTORY-R4 (reserva atómica):** se bloquea la fila de stock del producto (`FOR UPDATE`), se suman las reservas vigentes en una sentencia posterior y, si alcanza, se inserta la reserva; varias líneas se bloquean **ordenadas por `product_id`** (sin interbloqueos) y la operación es todo o nada. Cumple la intención de D-017 (sin carreras) con reservas que vencen solas.
- **INVENTORY-R5 (motivos, D-027):** el admin elige entre `entrada` (+q), `ajuste_inventario` (cantidad contada; el delta lo calcula el servidor), `merma` (−q) y `devolucion` (+q); `ajuste_inventario` y `merma` exigen nota (1–500). El sistema registra `venta` al consumir reservas.
- **INVENTORY-R6:** ningún movimiento deja `on_hand` por debajo de 0 (409 `insufficient_stock`) ni por debajo de lo reservado vigente (409 `stock_reserved`): no se pueden incumplir pedidos ya reservados.
- **INVENTORY-R7 (auditoría, RF14.01):** se auditan `inventory.stock_adjusted` (before/after `on_hand`, motivo) y `inventory.threshold_changed`.
- **INVENTORY-R8:** consumir una reserva vencida falla (`ReservationExpired`): orders decide (el pedido pasa a `expirado`, RF04.06).
- **INVENTORY-R9 (decisión del Leader, I-1 de T-041):** un `ajuste_inventario` cuya cantidad contada coincide con `on_hand` responde 422 `no_change` (no hay movimiento que registrar; la BD prohíbe deltas 0).
- **INVENTORY-R10 (líneas `backorder`, para T-042):** si hay disponible ≥ cantidad, se reserva como una línea de stock; si no, la línea entera va bajo pedido sin reserva (no se parten líneas en el MVP). Las líneas `made_to_order` nunca reservan (RN-16).
- **INVENTORY-R11 (consumo en el límite del vencimiento, B-1 de QA en T-042):** al consumir, con todo el stock implicado bloqueado (en orden de `product_id`) y antes de escribir, se comprueba que `on_hand` cubre las reservas vigentes (incluidas las propias); si no, otra transacción ya dio por vencida la reserva y el consumo falla con `ReservationExpired` sin cambios. Pierde el pedido que paga en el límite; el que reservó de forma válida queda protegido (RN-06, INVENTORY-R6).
  - **Reloj efectivo (P7 de QA en la ronda 2 de T-042):** el consumo juzga, tanto sus reservas (R8) como los totales, con el mayor entre `now` y la creación de la última reserva activa de esos productos (`max(expires_at) − 30 min`), leído después de los bloqueos. Una transacción que esperó un bloqueo no puede juzgar con un reloj anterior a una reserva que ya existe. Sin él, un pedido vigente podría perder frente a dos pedidos ajenos que coinciden en el límite.
  - **Comportamiento esperado (Nota 1 de QA en la ronda 3):** un pago cuya transacción empezó antes del vencimiento de su reserva, pero que se ejecuta después de que otra reserva demuestre que ese vencimiento ya pasó, recibe `ReservationExpired`. Aunque sobre stock, es correcto: el pago llega tarde de verdad. orders debe consumir antes de confirmar el cobro simulado y tratar `ReservationExpired` como pedido `expirado` sin cobro (I-6).
- **INVENTORY-R12 (orden de bloqueo, I-1 de QA en T-042):** consumir y liberar el mismo pedido bloquean sus reservas en el mismo orden (`product_id`, `id`) antes de escribir, así que no se interbloquean.

## 5. Modelo de dominio

- **StockItem:** `product_id`, `on_hand` (≥ 0).
- **Reservation:** `id`, `product_id`, `order_id`, `quantity` (> 0), `status` (`active` | `consumed` | `released`), `expires_at`.
- **StockMovement:** `id`, `product_id`, `kind` (INVENTORY-R5 + `venta`), `quantity_delta` (≠ 0), `on_hand_after` (≥ 0), `note?`, `actor_id?`, `order_id?`, `created_at`.
- **AvailabilityStatus** (D-023) y la función pura de INVENTORY-R2.

## 6. Persistencia

```
app.inventory_items      product_id uuid PK FK → products ON DELETE RESTRICT · on_hand integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0) · updated_at
app.stock_reservations   id uuid PK · product_id uuid FK → products · order_id uuid NOT NULL (FK a orders cuando exista)
                         quantity integer CHECK (> 0) · status text CHECK IN ('active','consumed','released') DEFAULT 'active'
                         expires_at timestamptz NOT NULL · created_at
                         INDEX (product_id, status, expires_at) · INDEX (order_id)
app.stock_movements      id bigint IDENTITY PK · product_id uuid FK → products · kind text CHECK IN ('entrada','ajuste_inventario','merma','devolucion','venta')
                         quantity_delta integer CHECK (<> 0) · on_hand_after integer CHECK (>= 0) · note text NULL
                         CHECK (kind NOT IN ('ajuste_inventario','merma') OR note IS NOT NULL)
                         actor_id uuid NULL · order_id uuid NULL · created_at · INDEX (product_id, created_at)
app.inventory_settings   id smallint PK CHECK (id = 1) · low_stock_threshold integer NOT NULL DEFAULT 2 CHECK (>= 1) · updated_at
                         (una sola fila, insertada por la migración)
VIEW app.product_availability (product_id, available, status, lead_time_days)
                         = products ⟕ inventory_items ⟕ Σ reservas activas no vencidas, con INVENTORY-R2 y el umbral de settings
```

- Migración `0005`. La vista es el **contrato de lectura** de inventory para catalog (excepción documentada en `docs/modules.md` §3).

## 7. Contrato API (APROBADO 2026-10-27 por frontend-lead, con sus opcionales O1 y O3 recomendados)

Prefijo `/api/v1/inventory/admin`. Todas las rutas van con `require_admin`, que añade 401 `unauthenticated`, 403 `forbidden` y 503 `auth_unavailable`.

Esquemas. Las fechas van en UTC ISO 8601, como `UtcDatetime` de catalog. Un campo extra en el cuerpo → 422.

```jsonc
// StockItemOut
{"product_id": "uuid", "sku": "DEMO-H38", "name": "Heritage 38",
 "product_status": "published", // "draft" | "published" (estado en catalog; O3)
 "on_hand": 5,           // int ≥ 0; sin fila de stock = 0
 "reserved": 2,          // int ≥ 0; Σ reservas activas no vencidas (INVENTORY-R1)
 "available": 3,         // int ≥ 0; max(on_hand − reserved, 0). reserved > on_hand solo con el desfase de I-8, y se ve en esos dos campos
 "status": "in_stock"}   // "in_stock" | "low_stock" | "out_of_stock" | "on_request"; lo calcula el servidor (INVENTORY-R2)
// StockItemDetailOut = StockItemOut + {"movements": [StockMovementOut]}   // de 0 a 50, el más reciente primero (created_at desc, id desc)
// StockMovementOut
{"id": 1234,                  // int (bigint de §6; excepción documentada a "UUID en texto")
 "product_id": "uuid",
 "kind": "merma",             // "entrada" | "ajuste_inventario" | "merma" | "devolucion" | "venta"
 "quantity_delta": -1,        // int ≠ 0, con signo: cuánto cambió on_hand
 "on_hand_after": 4,          // int ≥ 0
 "note": "Cristal rayado",    // texto plano (puede llevar \n) o null
 "actor_id": "uuid",          // admin que lo registró; null en venta
 "order_id": null,            // pedido de la venta; null en los movimientos del admin
 "created_at": "2026-10-27T15:04:05Z"}
// MovementIn                  {"kind": "merma", "quantity": 1, "note": "Cristal rayado"}
// SettingsOut / SettingsIn    {"low_stock_threshold": 2}
```

| Método | Ruta | Request | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/stock?q&status&page&page_size` | — | `{items: [StockItemOut], total, page, page_size}` | 422 |
| GET | `/stock/{product_id}` | — | `StockItemDetailOut` | 404, 422 |
| POST | `/stock/{product_id}/movements` | `MovementIn` | 201 `StockMovementOut` | 404, 409 `insufficient_stock` / `stock_reserved`, 422 `validation_error` / `no_change` |
| GET | `/settings` | — | `SettingsOut` | — |
| PATCH | `/settings` | `SettingsIn` | `SettingsOut` | 422 |

**Listado (`GET /stock`)**
- Incluye todos los productos de catalog, en borrador o publicados, tengan o no fila de stock.
- `q`: hasta 100 caracteres; vacío equivale a no buscar. Coincidencia parcial en el SKU o el nombre, sin distinguir tildes ni mayúsculas. `%` y `_` se escapan en el `LIKE`.
- `status`: uno de los cuatro valores de `StockItemOut.status`; cualquier otro → 422.
- Orden: `sku` ascendente. Es único, así que la paginación es estable.
- Paginación como en el listado de administración de catalog: `page` de 1 a 1000 y `page_size` de 1 a 48, con 24 por defecto. Una página más allá de la última devuelve `items: []` con el `total` real.

**Detalle (`GET /stock/{product_id}`)**
- 404 `not_found` solo si el producto no existe.
- Un producto sin fila de stock responde con `on_hand` 0, `reserved` 0 y `movements: []`.
- Un `product_id` mal formado → 422.

**Cuerpo del movimiento (`MovementIn`)**
- `kind` ∈ {`entrada`, `ajuste_inventario`, `merma`, `devolucion`}; `venta` → 422.
- `quantity` es un entero estricto:
  - En `ajuste_inventario` es la cantidad contada, de 0 a 2 147 483 647. El servidor calcula el delta (INVENTORY-R5).
  - En los demás motivos son las unidades que entran (`entrada`, `devolucion`) o salen (`merma`), de 1 a 2 147 483 647.
  - Si el `on_hand` resultante supera 2 147 483 647 → 422.
- `note` es texto plano de 1 a 500 caracteres después de recortar los espacios:
  - `\r\n` se normaliza a `\n`; cualquier otro carácter de control → 422.
  - Una nota vacía cuenta como ausente.
  - Es obligatoria en `ajuste_inventario` y `merma`.

**Errores de `POST …/movements`**
- 422 `validation_error`, con `details[].loc` = `["body", "<campo>"]` (`kind`, `quantity` o `note`) para que el formulario marque el campo.
- 409 `insufficient_stock` si `on_hand` quedaría por debajo de 0. Tiene prioridad sobre el siguiente.
- 409 `stock_reserved` si `on_hand` quedaría por debajo de lo reservado vigente (INVENTORY-R6).
- Los dos 409 llevan `details: {"on_hand": int, "reserved": int}`, leídos bajo el bloqueo (O1), para que la interfaz diga cuánto se puede retirar como máximo.
- 422 `no_change` (código propio, `details: null`) si la cantidad contada de un `ajuste_inventario` coincide con `on_hand` (INVENTORY-R9).

**Después de un 201**, la interfaz vuelve a leer `GET /stock/{product_id}` para obtener `reserved`, `available` y `status`; nunca los calcula ella.

**Umbral (`SettingsIn`)**
- `low_stock_threshold` es obligatorio: entero estricto de 1 a 2 147 483 647 (INVENTORY-R3).
- Enviar el mismo valor → 200 sin entrada de auditoría.

**Formato**
- Los errores usan el formato común y se declaran en el OpenAPI (`ERROR_RESPONSES`). El 409 de cada ruta lista solo sus propios códigos.
- `note` es texto plano: la interfaz nunca la inyecta como HTML.

**Sin endpoints:** UC-04 a UC-06 son internos; los llama orders dentro de su transacción.

**Pendientes de una versión posterior** (compatibles con este contrato): O2 `order_policy` en `StockItemOut`, O4 `status` repetible, O5 actor legible y O6 historial paginado.

## 8. Dependencias

- **Consume:** `catalog` (productos y su `order_policy`/`lead_time_days`, por la vista y el caso de uso público de catalog), `identity` (`require_admin`), `audit`.
- **Expone:** casos de uso `ReserveStock`, `ConsumeReservations`, `ReleaseReservations` (para orders) y la vista `app.product_availability` (para catalog, T-030).
- **Obligaciones de orders al usarlos (decisiones del Leader tras T-042):** validar antes con catalog que los productos existen y están publicados (un producto inexistente es un error de programación, I-5); agrupar las líneas por producto antes de reservar (I-7); obtener `now` de la BD en la misma transacción (`SELECT now()`), la misma fuente que usa la vista (I-8); y tratar `ReservationExpired` también cuando las reservas fueron liberadas, porque cobrar sin reserva no está permitido (I-6).

## 9. Seguridad

- Cantidades solo para el admin; el público ve el estado.
- Toda escritura de stock bajo bloqueo de fila; nunca "comprobar y después escribir" sin bloqueo.
- Auditoría de ajustes y del umbral.

## 10. Criterios de aceptación

- [ ] CA-INVENTORY-01 (RF06.04, RF06.06): cada motivo actualiza `on_hand` con su movimiento y auditoría; nota obligatoria donde toca; nunca negativo ni por debajo de lo reservado (409).
- [ ] CA-INVENTORY-02 (RF06.05, RN-06): con dos solicitudes concurrentes por la última unidad, exactamente una reserva y la otra recibe `InsufficientStock`; una reserva vencida deja de contar sin procesos en segundo plano.
- [ ] CA-INVENTORY-03 (RN-16): las líneas bajo pedido no reservan; un pedido mixto reserva solo las de stock.
- [ ] CA-INVENTORY-04 (RF06.05): consumir descuenta `on_hand` y registra `venta`; liberar es idempotente; consumir una vencida falla.
- [ ] CA-INVENTORY-05 (RF02.08, D-023, D-027): la vista devuelve el estado correcto en todos los casos de INVENTORY-R2, incluido el umbral modificado.
- [ ] CA-INVENTORY-06: sin interbloqueos al reservar pedidos con los mismos productos en distinto orden.

## 11. Plan de pruebas

- **Unitarias:** INVENTORY-R2 (tabla de casos), validación de movimientos.
- **Integración:** reservas concurrentes con dos conexiones reales (hilos), vencimiento con `expires_at` en el pasado, vista contra la BD, CHECK de la tabla.
- **qa-reviewer** en T-042 (concurrencia).

## 12. Preguntas abiertas

| ID | Pregunta | Hipótesis conservadora | Decide |
|---|---|---|---|
| P-INVENTORY-1 | ¿Se avisa al admin cuando un producto entra en "Últimas unidades" o se agota? | No en el MVP; el listado admin filtra por estado | usuario |
