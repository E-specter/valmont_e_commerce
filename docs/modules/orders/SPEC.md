# orders — Especificación
> Estado: APROBADA (contrato §7 implementado y verificado en T-074…T-080; ajustes de D-041 incorporados; las preguntas de negocio están resueltas en D-040, §12; el recojo en tienda se apoya en las hipótesis H-1…H-6) · Requisitos: RF04.01–RF04.07, RF11.01, RF12.01, RF12.02, RF13.03 · Reglas: RN-01, RN-04…RN-10, RN-15, RN-16 · Decisiones: D-040 · Dueño: backend · Última actualización: 2026-11-26 module-coordinator (T-070; D-040 incorporada)

## 1. Problema y alcance

Convertir los artículos seleccionados de un carrito validado en un pedido con su importe exacto, su stock reservado y su entrega, y llevar ese pedido por una máquina de estados trazable hasta la entrega, sin vender dos veces la misma unidad, sin perder dinero ni datos de clientes y sin que el cliente toque importes ni estados.

- **Incluye:**
  - Crear el pedido desde el carrito (UC-01): instantánea comercial por línea, reserva de stock, datos de entrega (envío a domicilio o recojo en tienda, D-040), idempotencia.
  - Consultar los pedidos propios, su detalle y su historial (UC-02, UC-03).
  - Cancelar un pedido propio sin pagar (UC-04) y caducar el pedido no pagado a los 30 minutos (UC-05).
  - El puerto que payments usa para saber qué debe cobrar y para marcar el pedido como pagado (UC-06).
  - Administración: listar, ver y cambiar el estado por transiciones válidas, incluida la cancelación de un pedido pagado con reembolso simulado (UC-07…UC-10).
  - Historial de estados (`order_status_history`) y auditoría (RF14) de cada cambio.
- **No incluye:**
  - Cobrar o registrar intentos de pago: es `payments` (T-090…). Orders solo expone el puerto de §8.
  - Pagos reales, logística externa (operadores, etiquetas, cotizaciones), comprobantes electrónicos y el desglose del IGV (D-022).
  - Correos o notificaciones al cliente (no existe servicio de correo en el MVP).
  - Libreta de direcciones, devoluciones posteriores a la entrega, cambios del pedido ya creado (dirección, líneas), cupones, propinas y pedidos de invitado (D-038.5).
  - Pantallas: paquetes aparte en BACKLOG hasta tener Figma (T-111).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Cliente (`current_user`) | Crear un pedido desde su carrito; listar, ver y cancelar **sus** pedidos sin pagar | Ver, cancelar o pagar pedidos ajenos (404); fijar precios, totales, estados o `user_id`; cancelar un pedido pagado (RN-08) |
| Administrador (`require_admin`) | Listar y ver cualquier pedido; hacer las transiciones de §5; cancelar un pedido pagado antes de `enviado` o `listo_para_recojo` con reembolso simulado (D-016) | Marcar `pagado` o `expirado` a mano; saltarse estados; cancelar uno enviado, listo para recojo o entregado; borrar o editar el historial |
| Módulo payments (casos de uso `GetPayableOrder`, `ConfirmOrderPayment`) | Leer lo que debe cobrar de un pedido **del cliente autenticado** y marcarlo pagado | Cambiar importes, estados distintos de `pagado` o escribir en las tablas de orders |
| Módulo assistant (futuro) | Reutilizar `ListMyOrders` y `GetMyOrder` con el cliente autenticado (RF08, RN-14) | Recibir la dirección ni el teléfono (RNF10): su SPEC define una vista mínima |
| Sistema (lectura de un pedido vencido) | Pasar `pendiente_pago` a `expirado` y liberar la reserva (UC-05) | Cualquier otra transición |
| Visitante | Nada: toda ruta exige sesión | — |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-ORDERS-01 | Cliente | `POST /orders` con `Idempotency-Key` y la entrega (`delivery_method` `shipping` o `pickup`) | Pedido `pendiente_pago` con instantánea por línea, stock reservado (30 min), entrega, importe calculado por el servidor y carrito sin los comprados; 201 (200 si repite la clave) | 401, 409 `empty_selection` / `checkout_blocked` / `insufficient_stock` / `too_many_pending_orders` / `pickup_unavailable` / `idempotency_conflict`, 422 | RF04.01, RF04.02, RF04.03, RF04.05, RF04.07 |
| UC-ORDERS-02 | Cliente | `GET /orders?status&page&page_size` | Sus pedidos, el más reciente primero | 401, 422 | RF11.01 |
| UC-ORDERS-03 | Cliente | `GET /orders/{id}` | Detalle: líneas, entrega, importes, `can_cancel`, tiempo restante e historial | 401, 404, 422 | RF12.01, RF12.02 |
| UC-ORDERS-04 | Cliente | `POST /orders/{id}/cancel` | Pedido `cancelado`, reservas liberadas, historial y auditoría | 401, 404, 409 `not_cancellable` | RF04.04, RF12.02 |
| UC-ORDERS-05 | Sistema | Cualquier lectura de pedidos vencidos (UC-02, 03, 06, 07, 08) | `pendiente_pago` con `expires_at ≤ now` pasa a `expirado`, reservas liberadas, historial y auditoría sin actor | — | RF04.06, RF12.02 |
| UC-ORDERS-06 | payments | `GetPayableOrder(user_id, order_id)`; `ConfirmOrderPayment(user_id, order_id)` | Importe y estado a cobrar; pedido `pagado` con reservas consumidas (descuenta stock) o resultado `already_paid` / `expired` | `OrderNotFound`, `OrderNotPayable` | RF12.02 (RN-06; RF05.03 del lado de payments) |
| UC-ORDERS-07 | Admin | `GET /orders/admin?status&q&created_from&created_to&page&page_size` | Página de pedidos con estado y datos de entrega resumidos | 401, 403, 422 | RF13.03 |
| UC-ORDERS-08 | Admin | `GET /orders/admin/{id}` | Detalle completo con `user_id`, notas internas y `can_transition_to` | 401, 403, 404, 422 | RF13.03, RF12.01 |
| UC-ORDERS-09 | Admin | `POST /orders/admin/{id}/transitions` a `en_preparacion`, `enviado` (solo `shipping`), `listo_para_recojo` (solo `pickup`) o `entregado` | Estado nuevo con historial y auditoría; al enviar, transportista y código de seguimiento opcionales | 401, 403, 404, 409 `invalid_transition`, 422 | RF13.03, RF12.02 |
| UC-ORDERS-10 | Admin | La misma ruta con `to = cancelado` y `note` | Cancelado; si estaba pagado, reembolso simulado total registrado; si no, sin reembolso; reservas liberadas | 401, 403, 404, 409 `invalid_transition`, 422 | RF13.03, RF04.04 (D-016, RN-08) |

## 4. Reglas de negocio

- **Globales:** RN-01 (un cliente, muchos pedidos; "compra" no es entidad), RN-04 (instantánea), RN-05 (selección), RN-06 y D-017 (reserva atómica de 30 min), RN-07 (transiciones solo las de §5), RN-08 y D-016 (cancelación), RN-09 (importes en el servidor), RN-10 (solo datos propios), RN-14, RN-15 y D-015 (PEN en céntimos, UTC, `America/Lima`), RN-16 y D-023 (Bajo pedido), D-022 (IGV incluido), D-037 (precio vigente), D-038 (carrito).
- **ORDERS-R1 (estados y transiciones, RN-07):** los estados y las únicas transiciones válidas están en §5. Toda transición pasa por una sola función de dominio; la capa HTTP no decide.
- **ORDERS-R2 (importes, RN-09, RN-15):** el único origen del precio es `CheckoutLine.price` que devuelve `PrepareCheckout` **en la misma transacción** (precio vigente de promotions, D-037). `unit_price` = `price`; `line_total = unit_price × quantity`; `subtotal = Σ line_total`; `shipping_amount = 0` en el MVP (D-040, P-2); `total = subtotal + shipping`. Todo en enteros, calculado en Python (puede superar 2³¹; columnas `bigint`). El cuerpo de la solicitud **no** admite campos de importe (`extra="forbid"`). El cliente ve el importe final en el pedido `pendiente_pago`, antes de pagar y pudiendo cancelar gratis (obligación CART-R12): por eso no se acepta un "total esperado" del cliente.
- **ORDERS-R3 (instantánea, RN-04, RF04.02):** cada línea guarda `sku`, `name`, `quantity`, `list_price`, `unit_price`, `discount_amount` (por unidad = `list_price − unit_price`, como lo entrega cart), `promotion_id` (sin FK: es dato histórico) y la política con que se trató (`fulfillment`, R5) con su `lead_time_days`. Ningún cambio posterior de catalog, promotions o inventory altera un pedido existente.
- **ORDERS-R4 (una transacción y orden de bloqueos):** UC-01 corre en **una** transacción (`SessionDep`): o existe el pedido con sus reservas y el carrito sin los comprados, o no cambia nada. Orden de bloqueos para todo el módulo: **carrito → fila del pedido → reservas del pedido → filas de stock por `product_id`**. UC-01 bloquea carrito y luego stock (el pedido nuevo aún no es visible para nadie); las demás operaciones bloquean pedido y luego reservas (`ReleaseReservations`, `ConsumeReservations`, que a su vez ordenan por `product_id`, INVENTORY-R4/R12). Nadie bloquea en sentido inverso: sin interbloqueos. Los casos de uso de otros módulos **no hacen commit**.
- **ORDERS-R5 (reserva y Bajo pedido, RN-06, RN-16, RF04.07):** `ReserveStock(order_id, líneas, now)` decide por línea (INVENTORY-R10). Las líneas que devuelve en `reservations` van con `fulfillment = stock`; las de `on_request`, con `made_to_order` y su `lead_time_days`. Un pedido mixto reserva solo las de stock; uno solo con líneas Bajo pedido no reserva nada y igualmente caduca (R6). `estimated_delivery_on` = fecha en `America/Lima` de `created_at` + el **mayor** `lead_time_days` de las líneas `made_to_order` (días naturales); `NULL` si no hay ninguna o ninguna trae plazo. Un pedido mixto se entrega o se recoge junto cuando todo esté listo (D-040, P-5); para `pickup`, `estimated_delivery_on` es la fecha estimada de disponibilidad en la boutique (misma fórmula, H-6). *Atajo: Perú no tiene horario de verano, así que se usa el desfase fijo UTC−5 en lugar de `zoneinfo` y no hace falta `tzdata`; revisar si cambia la regla horaria.*
- **ORDERS-R6 (ventana de pago, RF04.06):** `expires_at = created_at + 30 min`, igual que el vencimiento de las reservas: ambos salen del mismo `now` de la BD (`SELECT now()` al empezar la transacción; obligación I-8 de inventory). La constante del dominio de orders es propia (`PAYMENT_WINDOW_MINUTES = 30`; no se importa el dominio de inventory) y una prueba comprueba que coincide con la de la reserva. Un pedido está vencido si `expires_at ≤ now`; solo `pendiente_pago` vence.
- **ORDERS-R7 (caducidad perezosa, D-017):** no hay proceso en segundo plano. Todo caso de uso que lee pedidos materializa antes los vencidos: `UPDATE orders SET status='expirado' … WHERE status='pendiente_pago' AND expires_at <= now` sobre las filas pedidas (las propias en UC-02; la del id en UC-03, UC-06 y UC-08; hasta 200 de cualquier cliente en UC-07), con `FOR UPDATE SKIP LOCKED` y máximo 200 por llamada (*atajo: con más vencidos, el resto se materializa en la siguiente lectura; la disponibilidad ya es correcta porque la vista ignora reservas vencidas*). Solo quien cambia la fila (comparar y cambiar) escribe el historial (`system`, sin actor), audita y llama a `ReleaseReservations`. Un pago o una cancelación que ya tenga la fila bloqueada gana; el vencimiento se salta esa fila. Repetir la lectura no duplica nada.
- **ORDERS-R8 (idempotencia de creación, RF04.01):** `Idempotency-Key` es obligatoria (un UUID de 36 caracteres, normalizado a minúsculas (`shared/idempotency.py`, D-047, T-018c); la genera el cliente con `crypto.randomUUID()` por intento de compra) y única por cliente (`UNIQUE(user_id, idempotency_key)`). Flujo: (1) buscar el pedido de `(user, key)`: si existe, devolverlo con 200 sin tocar nada; (2) `PrepareCheckout`; si lanza `EmptySelection`, **volver a buscar** la clave (otra solicitud de la misma clave pudo confirmar mientras esta esperaba el bloqueo del carrito) y, si existe, devolverlo; si no, `empty_selection`; (3) al insertar, una violación del `UNIQUE` (carrera extrema) se traduce a 409 `idempotency_conflict` ("reintente") tras deshacer todo. Reintentar con la misma clave y **otro cuerpo** devuelve el pedido original (*limitación: no se compara la huella de la solicitud; si se quiere, añadir `request_hash` sin tocar el resto*).
- **ORDERS-R9 (tope de pedidos sin pagar, D-040):** un cliente puede tener como máximo **3** pedidos `pendiente_pago` vigentes; el 4.º → 409 `too_many_pending_orders` con `details {"max": 3}`. Se cuenta con el carrito bloqueado (las solicitudes del mismo cliente se serializan), así que es exacto. Evita acaparar stock a base de pedidos sin pagar.
- **ORDERS-R10 (cancelación, RN-08, D-016):**
  - El cliente solo cancela `pendiente_pago` propio y vigente (R7 antes): cualquier otro estado → 409 `not_cancellable` con `details {"status"}`; ya `cancelado` → 200 sin cambios (idempotente). Libera las reservas.
  - El administrador cancela `pendiente_pago`, `pagado` o `en_preparacion` (antes de `enviado` o `listo_para_recojo`; H-4), con `note` obligatoria (1–500). Si estaba pagado o en preparación se registra un **reembolso simulado total** (`refunded_amount = total_amount`, `refunded_at`); si estaba `pendiente_pago`, ninguno y se liberan las reservas. No hay reembolsos parciales.
  - El reembolso es un dato del pedido (D-040, P-8): no hay pasarela y RN-11 prohíbe datos de tarjeta; los reportes (RF07, D-016) restan `refunded_amount`.
- **ORDERS-R11 (historial y auditoría, RF12.02, RF14.01):** cada cambio de estado, incluida la creación, inserta una fila de `order_status_history` (`from_status`, `to_status`, `actor_kind`, `actor_id`, `note`, `created_at`) **en la misma transacción** y una entrada de auditoría: `orders.created` (after: `status`, `number`, `total_amount`, `line_count`) y `orders.status_changed` (before/after: `status`, y `refunded_amount` si lo hay). Sin datos personales de entrega en la auditoría (RNF10). El historial es de solo inserción también en la BD (sin `UPDATE` ni `DELETE` para `valmont_app`). La `note` es interna: solo la ve el administrador.
- **ORDERS-R12 (aislamiento, RN-10):** toda consulta del cliente filtra por el `user_id` del token. Un pedido ajeno y uno inexistente responden **el mismo 404 `not_found`** (sin revelar existencia). Ningún cuerpo, ruta o parámetro lleva `user_id`.
- **ORDERS-R13 (entrega, RF04.03, D-040):** el cliente elige `delivery_method` ∈ {`shipping`, `pickup`}; el resto de campos depende de la modalidad y el esquema es cerrado (`extra="forbid"`: un campo de la otra modalidad → 422).
  - **Ambas:** `recipient_name` (2–80; en `pickup`, quien recoge) y `phone` (6–15 dígitos con `+` opcional, misma regla que identity, duplicada porque no se importa su dominio).
  - **`shipping`:** además `department`, `province`, `district` (2–40 cada uno, texto libre: sin lista de ubigeo en el MVP), `address_line` (5–150) y `reference` (opcional, hasta 150). Envío gratis a todo el Perú (`shipping_amount = 0`).
  - **`pickup` (H-2):** no se piden ni se aceptan ubigeo, dirección ni referencia.
  - Texto plano: se recortan espacios, se colapsan los repetidos en nombre y ubicación y se rechaza cualquier carácter de control (categorías `Cc` y `Cs`; `
` no se admite). No se pide DNI.
- **ORDERS-R20 (recojo en tienda, hipótesis H-1…H-6 del Leader):** H-1: hay una sola boutique y sus datos (nombre, dirección, horario) viven en `Settings` (`pickup_store_name`, `pickup_store_address`, `pickup_store_hours`), no en una tabla. H-2: ver R13. H-3: las transiciones por modalidad son las de §5 (`en_preparacion → listo_para_recojo → entregado` en `pickup`; `en_preparacion → enviado → entregado` en `shipping`) y una transición de la otra modalidad es 409 `invalid_transition`. H-4: la cancelación de D-016 aplica igual hasta antes de `enviado` o `listo_para_recojo`. H-5: si la boutique no está configurada, elegir `pickup` → 409 `pickup_unavailable`; el detalle del pedido `pickup` muestra la boutique **vigente** en `Settings` (no se congela en el pedido, a diferencia de la instantánea de precios). H-6: `estimated_delivery_on` en `pickup` es la fecha estimada en que el pedido está disponible en la boutique.
- **ORDERS-R14 (número visible):** `order_number bigint` de una secuencia de la BD, mostrado como `VAL-000123` (`VAL-` + 6 dígitos con ceros; crece sin tope). Puede haber huecos (una transacción deshecha consume número). La identidad real es el UUID; el número no da acceso a nada.
- **ORDERS-R15 (stock tras cancelar un pedido pagado):** `ConsumeReservations` ya descontó `on_hand` al pagar. Cancelar un pedido pagado **no repone** el stock: el administrador registra una `devolucion` en inventory (UC-INVENTORY-01) si la pieza vuelve a la tienda (D-040, P-7). Es seguro: el error posible es vender de menos, nunca de más.
- **ORDERS-R16 (confirmar pago, para payments):** `ConfirmOrderPayment` bloquea el pedido (R4) y, con la fila bloqueada: si está pagado o posterior (`pagado`, `en_preparacion`, `enviado`, `listo_para_recojo`, `entregado`) → `already_paid` sin efectos (RF05.03); si es `cancelado` o `expirado` → `OrderNotPayable(status)`; si es `pendiente_pago` pero vencido → lo expira (R7) y devuelve `expired`; si no, llama a `ConsumeReservations` **antes** de cambiar el estado: con éxito → `pagado` (`paid_at`, historial, auditoría) y `paid`; con `ReservationExpired` (también si las reservas fueron liberadas o ya no las cubre el stock, INVENTORY-R11) → expira el pedido y devuelve `expired`. En `expired` la transacción debe confirmarse (el consumo falló sin escribir) y **no hay cobro**: payments registra el intento como rechazado.
- **ORDERS-R17 (lecturas):** listados: más reciente primero (`created_at desc, id desc`); `page` 1–1000, `page_size` 1–50 (20 por defecto); una página más allá de la última devuelve `items: []` con el `total` real. El servidor calcula `can_cancel`, `expires_in_seconds` y `can_transition_to` (la interfaz no decide, RN-09). Fechas en UTC ISO 8601; `created_from` y `created_to` son fechas `YYYY-MM-DD` en `America/Lima`, ambas incluidas (D-015).
- **ORDERS-R18 (datos personales, RNF10, Ley 29733):** nombre, teléfono y dirección solo los ven el cliente dueño y los administradores; no van a logs, a la auditoría ni a ningún proveedor externo. Los logs de errores no incluyen el cuerpo de la solicitud.
- **ORDERS-R19 (el administrador no crea ni paga):** `pagado` solo lo pone `ConfirmOrderPayment` y `expirado` solo R7; la ruta de transiciones del administrador rechaza esos destinos con 422.

## 5. Modelo de dominio

**Estados** (`OrderStatus`, valores en la BD y en la API): `pendiente_pago`, `pagado`, `en_preparacion`, `enviado`, `listo_para_recojo`, `entregado`, `cancelado`, `expirado` (ocho). `enviado` solo existe en pedidos `shipping` y `listo_para_recojo` solo en `pickup`. Terminales: `entregado`, `cancelado`, `expirado`.

| De | A | Quién | Condición | Efectos |
|---|---|---|---|---|
| (ninguno) | `pendiente_pago` | Cliente (UC-01) | carrito válido y stock reservado | reservas, carrito sin los comprados |
| `pendiente_pago` | `pagado` | payments (UC-06) | `now < expires_at`; consumo de reservas correcto | consume reservas (descuenta stock), `paid_at` |
| `pendiente_pago` | `expirado` | Sistema (UC-05) | `expires_at ≤ now` | libera reservas |
| `pendiente_pago` | `cancelado` | Cliente dueño (UC-04) o administrador (UC-10) | vigente | libera reservas; sin reembolso |
| `pagado` | `en_preparacion` | Administrador (UC-09) | — | — |
| `pagado` | `cancelado` | Administrador (UC-10) | `note` | reembolso simulado total |
| `en_preparacion` | `enviado` | Administrador (UC-09) | solo `shipping` | `shipped_at`, transportista y seguimiento opcionales |
| `en_preparacion` | `listo_para_recojo` | Administrador (UC-09) | solo `pickup` | — |
| `en_preparacion` | `cancelado` | Administrador (UC-10) | `note` | reembolso simulado total |
| `listo_para_recojo` | `entregado` | Administrador (UC-09) | solo `pickup`: se entrega al retirarlo | — |
| `enviado` | `entregado` | Administrador (UC-09) | solo `shipping` | — |

Cualquier otro par es inválido (409 `invalid_transition` con `details {"from", "to", "allowed"}`). Un pedido enviado, listo para recojo o entregado no se cancela (D-016, H-4).

**Entidades y objetos de valor** (dominio puro, sin `fastapi`, `pydantic` ni `sqlalchemy`):
- `Order`: `id`, `number`, `user_id`, `status`, `lines`, `delivery`, `subtotal_amount`, `shipping_amount`, `total_amount`, `created_at`, `expires_at`, `estimated_delivery_on`, `paid_at`, `refunded_amount`, `refunded_at`, `history`. Invariantes: `total = subtotal + shipping`; al menos una línea; `refunded_amount` solo en `cancelado` y igual al total.
- `OrderLine`: instantánea de R3 con `line_total`; `quantity` ≥ 1; precios ≥ 1; `fulfillment ∈ {stock, made_to_order}`.
- `DeliveryMethod` (`shipping`, `pickup`) y `DeliveryDetails`: R13, valida al construirse según la modalidad (en `pickup` los campos de dirección son `None`). `Delivery` añade `carrier`, `tracking_code`, `shipped_at`.
- `StatusChange`: `from_status | None`, `to_status`, `actor_kind ∈ {customer, admin, system}`, `actor_id | None`, `note | None`, `at`.
- Funciones puras: `check_admin_transition(from, to, method)`, `admin_targets(status, method)`, `can_customer_cancel(status)`, `format_order_number(n)`, `estimated_delivery_on(created_at, lead_times)`.
- Errores: `InvalidTransition`, `NotCancellable`, `DeliveryInvalid(field, message)` (hereda de `ValueError`), `PickupUnavailable`, `TooManyPendingOrders`, `IdempotencyConflict`, `OrderNotFound`, `OrderNotPayable`.

## 6. Persistencia

Migración `0010` (`--rev-id 0010`, sigue a `0009`). Revisar con la skill `database-migration-review`. Importes en `bigint`; una sola moneda (PEN, RN-15), sin columna de moneda.

```
app.orders
  id uuid PK · order_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE
  user_id uuid NOT NULL FK → app.profiles(user_id) ON DELETE RESTRICT
  status text NOT NULL CHECK IN ('pendiente_pago','pagado','en_preparacion','enviado','listo_para_recojo','entregado','cancelado','expirado')
  idempotency_key text NOT NULL CHECK (char_length BETWEEN 16 AND 64)
  subtotal_amount bigint NOT NULL CHECK (> 0) · shipping_amount bigint NOT NULL DEFAULT 0 CHECK (>= 0)
  total_amount bigint NOT NULL · CHECK (total_amount = subtotal_amount + shipping_amount)
  expires_at timestamptz NOT NULL · CHECK (expires_at > created_at)
  estimated_delivery_on date NULL
  paid_at timestamptz NULL · CHECK (status NOT IN ('pagado','en_preparacion','enviado','listo_para_recojo','entregado') OR paid_at IS NOT NULL)
  refunded_amount bigint NULL · refunded_at timestamptz NULL
    CHECK ((refunded_amount IS NULL) = (refunded_at IS NULL))
    CHECK (refunded_amount IS NULL OR (status = 'cancelado' AND refunded_amount = total_amount))
  created_at timestamptz NOT NULL DEFAULT now() · updated_at timestamptz NOT NULL DEFAULT now()
  UNIQUE (user_id, idempotency_key)
  INDEX (user_id, created_at DESC, id DESC) · INDEX (status, created_at DESC) · INDEX (expires_at) WHERE status = 'pendiente_pago'

app.order_lines
  id uuid PK · order_id uuid NOT NULL FK → app.orders(id) ON DELETE CASCADE · position smallint NOT NULL CHECK (>= 1)
  product_id uuid NOT NULL FK → app.products(id) ON DELETE RESTRICT
  sku text NOT NULL · name text NOT NULL · quantity smallint NOT NULL CHECK (BETWEEN 1 AND 100)
  list_price_amount bigint NOT NULL CHECK (> 0) · unit_price_amount bigint NOT NULL CHECK (> 0)
  discount_amount bigint NOT NULL CHECK (>= 0) · CHECK (discount_amount = list_price_amount - unit_price_amount)
  line_total_amount bigint NOT NULL · CHECK (line_total_amount = unit_price_amount * quantity)
  promotion_id uuid NULL (sin FK: dato histórico) · fulfillment text NOT NULL CHECK IN ('stock','made_to_order')
  lead_time_days integer NULL CHECK (> 0)
  UNIQUE (order_id, product_id) · UNIQUE (order_id, position) · INDEX (product_id)

app.deliveries   (1:1)
  order_id uuid PK FK → app.orders(id) ON DELETE CASCADE
  delivery_method text NOT NULL CHECK IN ('shipping','pickup')
  recipient_name text NOT NULL · phone text NOT NULL            (en pickup: quien recoge)
  department text NULL · province text NULL · district text NULL · address_line text NULL · reference text NULL
  carrier text NULL · tracking_code text NULL · shipped_at timestamptz NULL
  CHECK (delivery_method <> 'shipping' OR (department IS NOT NULL AND province IS NOT NULL AND district IS NOT NULL AND address_line IS NOT NULL))
  CHECK (delivery_method <> 'pickup' OR (department IS NULL AND province IS NULL AND district IS NULL AND address_line IS NULL
         AND reference IS NULL AND carrier IS NULL AND tracking_code IS NULL AND shipped_at IS NULL))
  (la coherencia de método y estado —`enviado` solo en shipping, `listo_para_recojo` solo en pickup— cruza tablas y la impone el dominio)

app.order_status_history   (solo inserción)
  id bigint GENERATED ALWAYS AS IDENTITY PK · order_id uuid NOT NULL FK → app.orders(id) ON DELETE CASCADE
  from_status text NULL · to_status text NOT NULL (ambos con el CHECK de estados)
  actor_kind text NOT NULL CHECK IN ('customer','admin','system') · actor_id uuid NULL · note text NULL
  created_at timestamptz NOT NULL DEFAULT now()
  CHECK (from_status IS NOT NULL OR to_status = 'pendiente_pago') · CHECK ((actor_kind = 'system') = (actor_id IS NULL))
  INDEX (order_id, id)
```

- Permisos (D-029, como `0008`/`0006`): `GRANT SELECT, INSERT, UPDATE ON app.orders, app.deliveries TO valmont_app`; `GRANT SELECT, INSERT ON app.order_lines, app.order_status_history TO valmont_app` (sin `UPDATE` ni `DELETE`: el historial y las líneas no se editan; nada de orders se borra). Las secuencias ya tienen `USAGE` por `0006`; `test_app_role` debe cubrir las tablas nuevas.
- `downgrade`: destructivo (borra pedidos); solo en BD locales o de pruebas. Orden: historial, entrega, líneas, pedidos.
- **No se añade en esta migración la FK `stock_reservations.order_id → orders`** que la `0005` anunciaba: ver D-040 (P-11).
- Se añade el registro de `adapters/persistence` en `migrations/env.py`.

## 7. Contrato API (APROBADO, implementado en T-074…T-079)

> Ajustes posteriores al texto original de esta sección: (1) D-041 P-6, `GET /orders` admite varios `status` (parámetro repetido); (2) D-041 P-7, `OrderLineOut.image` (`url`, `alt`) se lee del lector compartido y es `null` si el producto no está publicado; (3) T-085, `carrier` y `tracking_code` se recortan y rechazan caracteres de control, y `created_from`/`created_to` se acotan a 2000-01-01…2100-12-31 (422 fuera de rango; el OpenAPI no publica ese límite). La fuente de verdad del contrato es el OpenAPI generado.

Prefijo `/api/v1/orders`. Las rutas con prefijo `admin` se declaran **antes** que `/{order_id}`. Todas exigen sesión: 401 `unauthenticated` y 503 `auth_unavailable`; las de administración, además `require_admin` (403 `forbidden`). Errores en el formato común y declarados en el OpenAPI (`ERROR_RESPONSES`). Importes como `Money` (`{"amount": int, "currency": "PEN"}`); ids como UUID en texto; fechas en UTC.

| Método | Ruta | Auth | Request | Response | Errores |
|---|---|---|---|---|---|
| POST | `/` | cliente | cabecera `Idempotency-Key`; `CreateOrderIn` | 201 `OrderDetailOut` (200 si repite la clave) | 409 `empty_selection` / `checkout_blocked` / `insufficient_stock` / `too_many_pending_orders` / `idempotency_conflict`, 422 |
| GET | `/?status&page&page_size` | cliente | — | `OrderPageOut` | 422 |
| GET | `/{order_id}` | cliente | — | `OrderDetailOut` | 404, 422 |
| POST | `/{order_id}/cancel` | cliente | — | `OrderDetailOut` | 404, 409 `not_cancellable`, 422 |
| GET | `/admin?status&q&created_from&created_to&page&page_size` | admin | — | `AdminOrderPageOut` | 422 |
| GET | `/admin/{order_id}` | admin | — | `AdminOrderDetailOut` | 404, 422 |
| POST | `/admin/{order_id}/transitions` | admin | `TransitionIn` | `AdminOrderDetailOut` | 404, 409 `invalid_transition`, 422 |

```jsonc
// CreateOrderIn (extra="forbid": ni importes, ni user_id, ni líneas; las líneas salen del carrito)
// `delivery` es una unión discriminada por `delivery_method`; cada variante tiene el esquema cerrado.
{"delivery": {"delivery_method": "shipping",
              "recipient_name": "Ana Torres", "phone": "+51987654321",
              "department": "Lima", "province": "Lima", "district": "Miraflores",
              "address_line": "Av. Larco 345, piso 4", "reference": "Frente al parque"}}   // reference opcional
{"delivery": {"delivery_method": "pickup", "recipient_name": "Ana Torres", "phone": "+51987654321"}}   // sin dirección (H-2)

// OrderSummaryOut
{"id": "uuid", "number": "VAL-000123", "status": "pendiente_pago", "total": Money, "item_count": 3,   // Σ cantidades
 "created_at": "…Z", "expires_at": "…Z" /* solo pendiente_pago; si no null */, "estimated_delivery_on": "2026-12-10" /* o null */}
// OrderPageOut: {"items": [OrderSummaryOut], "total": 12, "page": 1, "page_size": 20}

// OrderDetailOut = OrderSummaryOut + 
{"paid_at": null, "expires_in_seconds": 1500 /* solo pendiente_pago, ≥ 0 */,
 "subtotal": Money, "shipping": Money, "total": Money,
 "lines": [{"product_id": "uuid", "sku": "DEMO-H38", "name": "Heritage 38", "quantity": 1,
            "list_price": Money, "unit_price": Money, "discount_amount": Money /* por unidad */, "line_total": Money,
            "fulfillment": "stock" /* | "made_to_order" */, "lead_time_days": null}],
 "delivery": {"delivery_method": "shipping", "recipient_name": "…", "phone": "…",
              "department": "…", "province": "…", "district": "…", "address_line": "…", "reference": null,   // null en pickup
              "pickup_store": null /* en pickup: {"name": "…", "address": "…", "hours": "…"} de Settings (H-1, H-5) */,
              "carrier": null, "tracking_code": null, "shipped_at": null},
 "refund": null /* o {"amount": Money, "at": "…Z"} */,
 "history": [{"from_status": null, "status": "pendiente_pago", "at": "…Z", "actor": "customer"}],   // el más antiguo primero; actor: customer | admin | system
 "can_cancel": true}

// AdminOrderSummaryOut = OrderSummaryOut + {"user_id": "uuid", "recipient_name": "Ana Torres", "district": "Miraflores"}
// AdminOrderPageOut: igual que OrderPageOut con AdminOrderSummaryOut
// AdminOrderDetailOut = OrderDetailOut + {"user_id": "uuid",
//    "history": [{"from_status", "status", "at", "actor", "actor_id": "uuid|null", "note": "texto|null"}],
//    "can_transition_to": ["en_preparacion", "cancelado"]}

// TransitionIn (extra="forbid")
{"to": "enviado",                  // en_preparacion | enviado | listo_para_recojo | entregado | cancelado; pagado, expirado o pendiente_pago → 422
 "note": "Motivo interno",         // 1–500; obligatoria si to = cancelado; si no, opcional
 "carrier": "Olva", "tracking_code": "OL-123"}   // opcionales, solo si to = enviado (1–60 cada uno); en otro destino → 422
```

**Detalles que cierran el contrato**
- **Crear (`POST /`):**
  - Sin `Idempotency-Key` o con formato inválido → 422 con `loc ["header", "idempotency-key"]`. Un campo de `delivery` inválido, un `delivery_method` desconocido o un campo de la otra modalidad (p. ej. `address_line` con `pickup`) → 422 `validation_error` con `loc ["body", "delivery", …, "<campo>"]`. Un campo extra (`total`, `price`, `user_id`, `lines`) → 422.
  - 409 `empty_selection`: no hay artículos seleccionados. 409 `checkout_blocked` con `details {"issues": [{"product_id", "status"}]}` (`status ∈ out_of_stock | insufficient_stock | unavailable`, como en el carrito). 409 `insufficient_stock` con `details {"product_ids": [...]}`: otro cliente reservó antes. 409 `too_many_pending_orders` con `details {"max": 3}`. 409 `pickup_unavailable` (`pickup` sin boutique configurada, H-5). 409 `idempotency_conflict` (carrera extrema de R8; reintentar).
  - Ninguna respuesta de error deja efectos: ni pedido, ni reservas, ni cambios en el carrito.
- **Listado del cliente:** `status` es uno de los ocho estados (otro → 422). Los vencidos se materializan antes (R7), así que `status` filtra con el estado real.
- **Detalle:** el mismo 404 para ajeno e inexistente (R12). `history` y `refund` son visibles para el cliente; las notas, no.
- **Cancelar:** 409 `not_cancellable` con `details {"status": "pagado"}`. Repetir sobre un pedido ya cancelado → 200 sin cambios.
- **Listado de administración:** `q` hasta 100 caracteres: coincide con el número (`VAL-000123` o `123`) o contiene el nombre del destinatario (sin distinguir mayúsculas; las tildes sí distinguen, *limitación*; `%` y `_` se escapan). `created_from`/`created_to` (R17). `status` admite un solo valor. Orden R17.
- **Transiciones:** 409 `invalid_transition` con `details {"from", "to", "allowed": [...]}`; el destino inválido por tipo (p. ej. `pagado`) es 422 y no 409. `enviado` en un pedido `pickup` y `listo_para_recojo` en uno `shipping` son 409 `invalid_transition` (R20); `cancelado` de un pedido pagado o en preparación devuelve `refund` (R10). Después de un 200 la interfaz usa el cuerpo recibido; nunca calcula estados.
- **Seguridad del contrato:** ninguna ruta, cuerpo o parámetro acepta `user_id` salvo la salida de administración; las cabeceras no confiables no se usan para identidad.

## 8. Dependencias

- **Consume:**
  - `cart.application`: `PrepareCheckout`, `RemoveCheckedOutItems`, `CheckoutCart`, `CheckoutLine`, `EmptySelection`, `CheckoutBlocked`, `CartIssue` (cart SPEC §8; firmas leídas del código).
  - `inventory.application`: `ReserveStock`, `ConsumeReservations`, `ReleaseReservations`, `OrderLine`, `ReservationExpired` y `ReservedOrder` (inventory SPEC §4 UC-04…06 y §8). Obligaciones que cumple orders: los productos los valida `PrepareCheckout` en la misma transacción (I-5); las líneas llegan agrupadas por producto porque el carrito tiene una por producto (I-7); `now` sale de la BD (I-8); `ReservationExpired` se trata como `expired` sin cobro (I-6).
  - `audit.application.AuditRecorder` (`AuditRecorderDep` en HTTP), `identity` (`current_user`, `require_admin`).
- **Expone** (en `valmont.modules.orders.application`):
  - Para payments: `GetPayableOrder(user_id, order_id) -> PayableOrder` y `ConfirmOrderPayment(user_id, order_id) -> PaymentOutcome` (R16, firmas en el STATUS, T-077). Sin HTTP propio: payments lo llama dentro de su transacción.
  - Para reports (RF07): las tablas `orders`, `order_lines` y las columnas `refunded_amount`/`paid_at` son su contrato de lectura (lo cierra su SPEC; reports puede necesitar una vista y una excepción de `modules.md` §3).
  - Para assistant (RF08): `ListMyOrders` y `GetMyOrder` con el cliente autenticado; su SPEC define la vista mínima sin dirección ni teléfono.
- **Cambios a otros módulos y a `docs/modules.md` (ADOPTADOS en D-040; los registra el Leader y se implementan en las tareas indicadas):**
  - **E-1, composición entre módulos.** `PrepareCheckout`, `RemoveCheckedOutItems`, `ReserveStock`, `ConsumeReservations` y `ReleaseReservations` necesitan repositorios SQL de cart e inventory, que orders no puede importar (`modules.md` §3). Adoptado: nueva **excepción (7)**: cada módulo que ofrece casos de uso internos expone un `adapters/wiring.py` con proveedores FastAPI que construyen esos casos de uso con la sesión (`get_prepare_checkout(session: SessionDep) -> PrepareCheckout`, etc.), y cualquier router puede importar los `wiring.py` de otros módulos, igual que `AuditRecorderDep` en la excepción (2): nunca otros adapters ni dominio. Más un cambio aditivo: `inventory.application` reexporta `InsufficientStock` (hoy solo vive en su dominio y orders debe capturarla). Es la tarea T-071; sin ella no empieza T-074.
  - **E-2, claves foráneas.** Orders tiene FK a `app.profiles` y `app.products` y no lee ninguna de las dos (mismo patrón que la excepción (6) de cart y que wishlist). Adoptado: se añade a la excepción (6).
  - **E-4, configuración de la boutique (H-1).** `shared/config.py` (`Settings`) añade `pickup_store_name`, `pickup_store_address` y `pickup_store_hours` (`str | None`, sin secretos) y `backend/.env.example` los documenta; es un cambio aditivo de un archivo compartido, que hace T-071. Orders los lee por el puerto `PickupStoreProvider` (STATUS T-074); si falta alguno, `pickup` no está disponible.
  - **E-3, RF05.05** (P-8): `modules.md` §3 asigna RF05 a payments; D-040 adopta que el reembolso simulado sea un dato de orders.

## 9. Seguridad

- **Identidad solo del token:** `user_id` sale de `current_user`; ninguna consulta de cliente lo recibe de la solicitud (RN-10). Un pedido ajeno es indistinguible de uno inexistente (R12). Los casos de uso para payments reciben el `user_id` del token de payments y filtran igual.
- **Importes y estados solo en el servidor** (RN-09, RN-14): la interfaz envía la entrega y la clave; los precios salen de promotions en la misma transacción; las transiciones las valida el dominio; `can_cancel` y `can_transition_to` los calcula el servidor.
- **Integridad:** una transacción por solicitud; reserva atómica de inventory; `CHECK` de importes y estados, `UNIQUE (user_id, idempotency_key)`, historial sin `UPDATE`/`DELETE` para el rol de la aplicación; comparar-y-cambiar en las transiciones, con la fila bloqueada. Sin "comprobar y después escribir" (`modules.md` §4.8).
- **Abuso:** tope de 3 pedidos sin pagar (R9), caducidad a 30 minutos, límites de longitud de la entrega, `extra="forbid"`; el tope de líneas es el del carrito (20 artículos × 5 unidades).
- **Datos personales** (R18): minimización, sin PII en auditoría ni logs, solo dueño y administradores.
- **Auditoría** (RF14): R11.
- **SQL** parametrizado u ORM; `note`, nombres y direcciones son texto plano que la interfaz nunca inyecta como HTML.
- **Pendiente para la auditoría final de seguridad** (decisiones.md, QA con Opus en orders): pruebas de carrera pago/expiración/cancelación y de aislamiento (CA-ORDERS-15, 22).

## 10. Criterios de aceptación

- [ ] CA-ORDERS-01 (UC-01, RF04.01, RN-05): con dos artículos seleccionados y uno no, `POST /orders` → 201 con `status = pendiente_pago`, una línea por seleccionado con su cantidad; en el carrito quedan solo los no seleccionados; sin sesión → 401; con el carrito sin seleccionados → 409 `empty_selection` y sin filas nuevas.
- [ ] CA-ORDERS-02 (UC-01, RF04.02, RN-04, R3): cada línea guarda `sku`, `name`, `quantity`, `list_price`, `unit_price`, `discount_amount` y `promotion_id` del instante de la compra; tras cambiar precio y nombre en catalog y vencer o cambiar la promoción, `GET /orders/{id}` devuelve lo mismo.
- [ ] CA-ORDERS-03 (UC-01, RF04.05, RN-09, R2): `unit_price` = precio vigente de promotions (con y sin promoción), `line_total = unit_price × quantity`, `subtotal`, `shipping = 0` y `total` son enteros correctos, también por encima de 2³¹; un cuerpo con `total`, `price`, `unit_price`, `lines`, `user_id` o `status` → 422 y sin efectos.
- [ ] CA-ORDERS-04 (UC-01, RF04.03, R13): `delivery` obligatoria con `delivery_method` `shipping` o `pickup` (otro valor → 422); en `shipping`, cada campo respeta su longitud y `reference` es opcional; en ambos, el teléfono su formato; espacios recortados; control (incluido `\n`) → 422 con `loc ["body","delivery",…,"<campo>"]`; en `pickup`, `department`, `province`, `district`, `address_line` o `reference` → 422, y en `shipping` faltar uno de los cuatro obligatorios → 422; `shipping_amount` es 0 en ambos.
- [ ] CA-ORDERS-05 (UC-01, RF04.01, RN-06, R4): con un seleccionado agotado, insuficiente o despublicado → 409 `checkout_blocked` con sus `issues`; con otro cliente que se quedó con la última unidad → 409 `insufficient_stock` con los `product_ids`; en ambos no existe el pedido, no hay reservas nuevas y el carrito sigue igual.
- [ ] CA-ORDERS-06 (UC-01, RN-06, D-017, R5, R6): cada línea `stock` crea una reserva `active` con `expires_at` igual a `order.expires_at = created_at + 30 min`; `available` baja en la cantidad; con la última unidad pedida a la vez por dos clientes (dos conexiones reales), exactamente uno recibe 201 y el otro 409, sin 500 y con `on_hand` intacto.
- [ ] CA-ORDERS-07 (UC-01, RF04.07, RN-16, R5): un pedido con una línea `made_to_order` no crea reserva para ella, guarda `fulfillment = made_to_order` y su `lead_time_days`, y `estimated_delivery_on` = fecha de Lima de `created_at` + el mayor plazo; un pedido mixto reserva solo las de stock; un `backorder` con stock insuficiente va entero bajo pedido; un pedido solo Bajo pedido también vence a los 30 minutos.
- [ ] CA-ORDERS-08 (UC-01, R8): repetir la solicitud con la misma clave → 200 con el mismo `id`, un solo pedido, una sola reserva y el carrito sin cambios; la misma clave de otro cliente crea su propio pedido; dos solicitudes simultáneas con la misma clave (dos conexiones) dejan un solo pedido y ninguna recibe 500 (201 + 200, o 201 + 409 `idempotency_conflict`); sin cabecera o con formato inválido → 422.
- [ ] CA-ORDERS-09 (UC-01, R9): con 3 pedidos `pendiente_pago` vigentes, el 4.º → 409 `too_many_pending_orders` con `max` 3 y sin efectos; uno vencido o cancelado no cuenta.
- [ ] CA-ORDERS-10 (UC-02, RF11.01): `GET /orders` devuelve solo los pedidos del cliente, el más reciente primero, con `total`, `page`, `page_size`; `status` filtra; una página fuera de rango da `items: []`; con dos clientes cada uno ve los suyos; sin sesión → 401.
- [ ] CA-ORDERS-11 (UC-03, RF12.01, R12, R17): `GET /orders/{id}` devuelve líneas, entrega, importes, historial (más antiguo primero), `can_cancel` y `expires_in_seconds` coherentes con el estado; el pedido de otro cliente y uno inexistente dan **la misma** respuesta 404; un `order_id` mal formado → 422; la respuesta del cliente no trae `user_id` ni notas.
- [ ] CA-ORDERS-12 (UC-04, RF04.04, RN-08, R10): cancelar un `pendiente_pago` propio → 200 `cancelado`, reservas `released` (el disponible vuelve), historial con `actor = customer` y auditoría; un pedido `pagado` (o posterior) → 409 `not_cancellable` con su `status` y sin cambios; repetir sobre uno ya cancelado → 200 sin filas nuevas; el de otro cliente → 404.
- [ ] CA-ORDERS-13 (UC-05, RF04.06, D-017, R6, R7): un pedido `pendiente_pago` con `expires_at` en el pasado pasa a `expirado` al leerlo (detalle, listado propio, listado y detalle de administración, `GetPayableOrder`), con reservas `released`, historial `system` sin actor y auditoría sin actor; antes de los 30 minutos no cambia; un pedido pagado nunca vence; leer varias veces no duplica historial ni auditoría; la reserva vencida no cuenta en la disponibilidad aunque nadie lea el pedido.
- [ ] CA-ORDERS-14 (UC-06, R16): `ConfirmOrderPayment` sobre `pendiente_pago` vigente → `paid`, estado `pagado`, `paid_at`, `on_hand` baja en lo reservado con un movimiento `venta`, reservas `consumed`, historial y auditoría; repetirlo → `already_paid` sin efectos (también con `en_preparacion`, `enviado` o `listo_para_recojo`); sobre `cancelado` o `expirado` → `OrderNotPayable(status)`; sobre un vencido sin materializar → `expired`, pedido `expirado` y sin consumo; con `ReservationExpired` → `expired` y el pedido `expirado`; de otro cliente → `OrderNotFound`; un pedido solo Bajo pedido se paga sin consumo; `GetPayableOrder` devuelve `total`, `status` y `expires_at` del pedido propio.
- [ ] CA-ORDERS-15 (R4, R7, R16, concurrencia): pago y cancelación del cliente simultáneos del mismo pedido (dos conexiones): gana exactamente uno, el otro recibe `OrderNotPayable` o 409 `not_cancellable`, nunca hay stock descontado en un pedido cancelado ni un pedido pagado con reservas liberadas; pago y lectura que expira en el límite: estado final único y `on_hand` correcto; dos pagos simultáneos: un solo descuento.
- [ ] CA-ORDERS-16 (UC-07, RF13.03): `GET /orders/admin` exige administrador (cliente → 403, sin token → 401); filtra por `status`, `q` (número con y sin `VAL-`, nombre del destinatario, comodines escapados) y fechas de Lima inclusivas; pagina; devuelve pedidos de todos los clientes con `user_id` y destinatario.
- [ ] CA-ORDERS-17 (UC-08, RF13.03, RF12.01): `GET /orders/admin/{id}` devuelve todo el detalle con `user_id`, notas del historial con `actor_id` y `can_transition_to` correcto para cada estado; 404 si no existe; 403 a un cliente.
- [ ] CA-ORDERS-18 (UC-09, RF13.03, RN-07, R1, R19, R20): matriz completa por modalidad: cada transición válida de §5 se acepta (`shipping`: `pagado → en_preparacion → enviado → entregado`; `pickup`: `pagado → en_preparacion → listo_para_recojo → entregado`) y el resto de los 64 pares estado × destino, para cada modalidad, → 409 `invalid_transition` con `from`, `to` y `allowed` (incluidos `enviado` en `pickup` y `listo_para_recojo` en `shipping`); `pagado`, `expirado` y `pendiente_pago` como destino → 422; `carrier` y `tracking_code` solo con `enviado` (si no, 422) y se guardan con `shipped_at`; cada transición añade una fila de historial con `actor = admin` y `actor_id` y una entrada de auditoría.
- [ ] CA-ORDERS-19 (UC-10, D-016, RN-08, R10, R15): el administrador cancela un `pagado` y uno `en_preparacion` (de cualquier modalidad) → `cancelado` con `refunded_amount = total_amount`, `refund` en la respuesta, historial con la nota y auditoría con el reembolso; un `pendiente_pago` → cancelado sin reembolso y con reservas liberadas; `enviado`, `listo_para_recojo`, `entregado`, `cancelado` y `expirado` → 409; sin `note` → 422; el `on_hand` **no** cambia al cancelar un pagado.
- [ ] CA-ORDERS-20 (RF12.02, R11): toda creación y todo cambio de estado deja exactamente una fila de historial con `from_status`, `to_status`, `actor_kind`, `actor_id` y fecha (más antigua primero); con el rol `valmont_app`, `UPDATE` y `DELETE` sobre `order_status_history` y `order_lines` fallan y las tablas nuevas tienen los permisos de §6.
- [ ] CA-ORDERS-21 (RF14.01, R11, R18): `orders.created` y `orders.status_changed` con actor, entidad, antes y después, también en la caducidad (sin actor); ninguna entrada ni log contiene nombre, teléfono o dirección del destinatario.
- [ ] CA-ORDERS-22 (RN-10, R12, seguridad): con dos clientes, ninguna ruta de cliente (listado, detalle, cancelar, `GetPayableOrder`, `ConfirmOrderPayment`) toca el pedido del otro; las rutas de administración devuelven 403 a un cliente y 401 sin token; ningún cuerpo ni parámetro acepta `user_id` (campo extra → 422); el 404 no revela existencia.
- [ ] CA-ORDERS-23 (RNF08, RN-15, §6): la migración `0010` sube y baja (`alembic upgrade head`, `alembic check`, `downgrade -1`, `upgrade head`); los `CHECK` de importes, estados, reembolso y `paid_at` rechazan filas inválidas; `UNIQUE (user_id, idempotency_key)`; los `CHECK` de coherencia de `deliveries` (un `shipping` sin dirección, o un `pickup` con dirección, transportista, seguimiento o `shipped_at`, se rechazan en la BD); FK `RESTRICT` a productos; importes `bigint` sin pérdida por encima de 2³¹.
- [ ] CA-ORDERS-24 (R4, sin interbloqueos): dos pedidos simultáneos de clientes distintos con los mismos productos en distinto orden, y un pago concurrente con un vencimiento sobre los mismos productos, terminan sin interbloqueo ni 500.
- [ ] CA-ORDERS-25 (contrato, §7): el OpenAPI declara cada ruta, cada error de §7 (incluido `pickup_unavailable`) con su `code` y `details`, `Money` en la salida, `Idempotency-Key` como cabecera obligatoria y `extra="forbid"` en las entradas; las pruebas de contrato fallan si cambia un campo.
- [ ] CA-ORDERS-26 (UC-01, UC-09, RF04.03, R13, R20; H-1…H-6): con `pickup`: se crea el pedido sin dirección y con los datos de quien recoge, `shipping_amount` 0, y la respuesta trae `pickup_store` con los valores de `Settings` (cambiar `Settings` cambia lo que muestra el detalle); sin boutique configurada → 409 `pickup_unavailable` y sin efectos; el pedido se paga y recorre `en_preparacion → listo_para_recojo → entregado`; cancelar un `pickup` pagado o en preparación reembolsa igual que uno `shipping`; `can_transition_to` del administrador depende de la modalidad.

## 11. Plan de pruebas

Las escribe `qa-reviewer` (D-033) en `backend/tests/orders/` (y `backend/tests/test_app_role.py` para los permisos); quien implementa no escribe pruebas.

- **Unitarias (sin BD):**
  - Dominio: matriz estado × destino de R1/§5 completa; `can_customer_cancel`; `format_order_number`; `estimated_delivery_on` (sin plazos, con `None`, con varios, borde de medianoche en Lima); `DeliveryDetails` (ambas modalidades: longitudes, teléfono, controles, `\n`, campos prohibidos en `pickup`); invariantes de `Order`.
  - Casos de uso con repositorio y puertos falsos: UC-01 (idempotencia, tope, "ningún cambio" tras cada error), UC-04, UC-05, UC-06 (los tres resultados y los errores), UC-09 y UC-10.
- **Integración (BD real, dos conexiones/hilos donde se indica):**
  - UC-01 completo con cart, inventory y promotions reales: instantánea, reservas con `expires_at` igual, rollback total ante cada 409.
  - Concurrencia: última unidad (CA-06), misma clave (CA-08), pago contra cancelación, pago contra expiración, dos pagos, mismos productos en orden distinto (CA-15, 24).
  - Caducidad por lectura con `expires_at` en el pasado (se manipula la BD o el reloj de la prueba); `SKIP LOCKED` con una fila bloqueada por otra conexión.
  - Migración, restricciones, `GRANT` del rol de la aplicación (`test_app_role`), historial sin `UPDATE`/`DELETE`.
- **Contrato (HTTP con la app real):** formas de §7, códigos y `details`, 401/403/404/409/422, `loc` por campo, OpenAPI de cada ruta, `Idempotency-Key`.
- **Seguridad:** aislamiento entre dos clientes en cada ruta, cliente contra rutas de administración, campos extra, ausencia de PII en logs y auditoría (`caplog`), 404 indistinguible.
- **E2E (Playwright, cuando existan las pantallas, T-082…T-084):** carrito → entrega → pedido pendiente → cancelar y volver a comprar; vencimiento visible; el administrador recorre el pedido hasta `entregado`; cancela uno pagado.
- **Casos de borde obligatorios:** `pickup` sin boutique configurada; transición de la otra modalidad; línea con importe por encima de 2³¹; pedido de una sola línea Bajo pedido; carrito con producto despublicado entre la lectura y la compra; reintento tras un timeout; reloj: pedido con `expires_at` igual a `now` (vencido) y un segundo antes (vigente); lectura de administración de 200+ vencidos.

## 12. Decisiones tomadas (D-040, 2026-11-26)

Las respondió el usuario (P-1, P-2, P-3, P-5) o las adoptó el Leader con la recomendación de esta SPEC; las registra el Leader como D-040. No quedan preguntas abiertas de negocio; lo que sigue son hipótesis revisables.

| ID | Tema | Decisión | Quién |
|---|---|---|---|
| P-1 | Modalidades de entrega | Las dos: `shipping` (a domicilio) y `pickup` (recojo en tienda); el cliente elige `delivery_method` | usuario |
| P-2 | Costo y cobertura | Envío gratis a todo el Perú; `shipping_amount = 0` (columna ya modelada) | usuario |
| P-3 | Datos de envío | Nombre, teléfono, departamento, provincia, distrito, dirección y referencia opcional; sin DNI | usuario |
| P-4 | Número visible | Secuencial `VAL-000123` (R14) | Leader |
| P-5 | Bajo pedido | Pago completo al crear, mismas reglas de cancelación, entrega o recojo conjunto del pedido mixto | usuario |
| P-6 | Recuperar la compra | Botón "volver a comprar" en la interfaz con la API del carrito (T-083) | Leader |
| P-7 | Stock al cancelar un pedido pagado | El administrador registra una `devolucion` en inventory (R15); sin puerto nuevo | Leader |
| P-8 / E-3 | Reembolso simulado | Dato de orders (`refunded_amount`, `refunded_at`); payments no necesita puerto | Leader |
| P-9 | Pedidos sin pagar por cliente | Máximo 3 (R9) | Leader |
| P-10 | Estado `en_preparacion` | Incluido | Leader |
| P-11 | FK `stock_reservations.order_id` | No en el MVP | Leader |
| E-1 | Composición entre módulos | Excepción (7): `adapters/wiring.py` por módulo; `inventory.application` reexporta `InsufficientStock` (T-071) | Leader |
| E-2 | Claves foráneas | FK de orders a `app.profiles` y `app.products`, sin lectura | Leader |

**Hipótesis del recojo en tienda (Leader, salvo H-5 y H-6; se invierten sin tocar el resto del modelo):**
- **H-1:** una sola boutique; nombre, dirección y horario en `Settings` (E-4), no en tabla.
- **H-2:** en `pickup` se exigen nombre y teléfono de quien recoge; no se piden ni se aceptan ubigeo, dirección ni referencia.
- **H-3:** transiciones: `pagado → en_preparacion → listo_para_recojo → entregado` (`pickup`) y `pagado → en_preparacion → enviado → entregado` (`shipping`).
- **H-4:** la cancelación de D-016 aplica igual: hasta antes de `enviado` o `listo_para_recojo`.
- **H-5** (de esta SPEC): sin boutique configurada, `pickup` → 409 `pickup_unavailable`; el detalle muestra la boutique vigente, no una copia congelada.
- **H-6** (de esta SPEC): `estimated_delivery_on` en `pickup` es la fecha estimada de disponibilidad en la boutique.
