# payments — Especificación
> Estado: APROBADA (D-043: P-1…P-6 resueltas por el usuario el 2026-11-27; contrato §7 aprobado por el Leader) · Requisitos: RF05.01–RF05.05 · Reglas: RN-08, RN-09, RN-10, RN-11, RN-15 · Decisiones: D-016, D-017, D-040 (E-3), D-041 (P-4) · Dueño: backend · Última actualización: 2026-11-27 module-coordinator (T-090)

## 1. Problema y alcance

Cobrar de forma **simulada** un pedido `pendiente_pago`, dejar constancia inmutable de cada intento y de su resultado, y marcar el pedido como pagado una sola vez, sin tocar jamás un dato de tarjeta en el servidor. El módulo se diseña alrededor de un **puerto de pasarela** con un adaptador simulado, de modo que un proveedor real (tokenización o campos alojados, PCI DSS) lo sustituya sin cambiar orders ni la interfaz (D-041, P-4).

- **Incluye:**
  - Pagar un pedido propio: crear el intento, obtener el resultado de la pasarela, registrarlo y, si se aprobó, marcar el pedido como pagado por el puerto de orders (UC-01).
  - Consultar los intentos de un pedido propio y si se puede volver a pagar (UC-02).
  - El puerto `PaymentGateway`, su adaptador simulado con una regla determinista (R12) y su proveedor de FastAPI.
  - Idempotencia del pago (RF05.03), auditoría (RF14) y la tabla inmutable `app.payment_attempts` (migración `0011`).
  - La costura de orders `adapters/wiring.py` (R-13 de orders), que habilita a payments.
- **No incluye:**
  - Pagos reales, cobro a un proveedor externo, 3-D Secure, webhooks, conciliación, comprobantes o facturación (D-022), y el procesamiento de datos de tarjeta de cualquier clase en el servidor.
  - Adelantos, pagos parciales, pagos divididos y reembolsos parciales (D-040: pago completo al crear; reembolso solo total).
  - El **reembolso simulado** (RF05.05): es un dato de orders (`refunded_amount`, D-040 E-3). Payments no tiene caso de uso ni puerto para él (ver R14); lo cubre ORDERS-R10 (CA-ORDERS-19).
  - Rutas de administración de pagos (P-6) y reportes de pagos (RF07 lee orders).
  - Cambios en orders más allá de su `wiring.py` (las mejoras propuestas están en §8, E-P3 y E-P4).
  - La pantalla de pago: tareas de frontend T-097 y T-098 de este módulo (la pista de `ui` las coordina como T-082b).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Cliente (`current_user`) | Pagar **sus** pedidos `pendiente_pago`; ver los intentos de **sus** pedidos | Pagar o ver pedidos ajenos (404 idéntico al inexistente); fijar importe, resultado, estado o `user_id`; enviar número, vencimiento, titular o CVV (422); editar o borrar un intento |
| Administrador | Nada propio en payments (MVP, P-6): ve el estado y el reembolso del pedido en orders y la auditoría | Pagar por un cliente; crear o borrar intentos |
| Módulo orders (puerto) | Servir `GetPayableOrder` y `ConfirmOrderPayment` | Conocer intentos ni datos de tarjeta |
| Pasarela simulada (adaptador) | Devolver aprobado o rechazado con un código | Recibir número o CVV; decidir sobre el pedido |
| Visitante | Nada: toda ruta exige sesión (401) | — |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-PAYMENTS-01 | Cliente | `POST /payments/orders/{order_id}/attempts` con `Idempotency-Key` y `{"card_last4"}` | Se crea el intento con el importe del pedido, la pasarela devuelve el resultado y queda registrado `approved` (el pedido pasa a `pagado`, reservas consumidas) o `rejected` con `failure_code` (el pedido sigue `pendiente_pago`); 201 (200 si repite la clave) | 401, 404 `not_found`, 409 `order_not_payable` / `order_already_paid` / `too_many_attempts` / `idempotency_key_reused`, 422, 503 `payment_gateway_unavailable` | RF05.01, RF05.02, RF05.03, RF05.04 |
| UC-PAYMENTS-02 | Cliente | `GET /payments/orders/{order_id}/attempts` | Intentos del pedido (el más reciente primero), `can_pay` y `attempts_left` calculados por el servidor | 401, 404, 422 | RF05.01, RF05.02 |
| UC-PAYMENTS-03 | Sistema (adaptador) | `PaymentGateway.authorize(GatewayCharge)` | Resultado `approved` o `rejected` con código, sin efectos fuera de la pasarela | `GatewayUnavailable` | RF05.01, RF05.04 |
| UC-PAYMENTS-04 | Cliente | Repetir el mismo `POST` (doble clic, reintento tras un corte) con la misma clave | El **mismo** intento, sin segunda llamada a la pasarela, ni segundo cobro, ni segundo descuento de stock; 200 | los de UC-01 si la clave es de otro pedido | RF05.03 |
| UC-PAYMENTS-05 | Administrador (vía orders) | Cancelar un pedido pagado (UC-ORDERS-10) | Reembolso simulado total en el pedido; los intentos de payments no cambian | los de orders | RF05.05 |

UC-03 y UC-04 no tienen ruta propia: son el comportamiento del puerto y de la idempotencia dentro de UC-01. UC-05 vive en orders.

## 4. Reglas de negocio

- **Globales:** RN-08 y D-016 (el reembolso es de orders), RN-09 (el importe lo calcula el servidor), RN-10 (solo datos propios), RN-11 (sin datos sensibles de tarjeta), RN-15 y D-015 (PEN en céntimos enteros, fechas en UTC), D-017 (reserva de 30 minutos), D-040 (E-3: reembolso sin puerto en payments; excepción (7): `wiring.py`), D-041 P-4 (pago simulado sin número ni CVV).
- **PAYMENTS-R1 (intento y resultado, RF05.01, RF05.02):** cada `POST` válido crea **un** intento que nace con su resultado final en la misma transacción: `approved` o `rejected`. No existe estado `pending` persistido (*atajo: con una pasarela real y asíncrona —3-D Secure, webhooks— se añade `pending` con una migración del `CHECK`; la SPEC de ese cambio lo diseñaría*). Un intento nunca se edita ni se borra (inmutable también en la BD, §6).
- **PAYMENTS-R2 (importe, RN-09, RN-15):** el único origen del importe es `PayableOrder.total_amount` que devuelve `GetPayableOrder` en la misma transacción. El cuerpo no admite importe (`extra="forbid"`). El intento guarda ese `amount` (céntimos `bigint`).
- **PAYMENTS-R3 (idempotencia, RF05.03):**
  - `Idempotency-Key` obligatoria (16–64 caracteres `[A-Za-z0-9_-]`; la genera el cliente por intento de pago, no por pedido: tras un rechazo se usa una nueva) y única por cliente (`UNIQUE (user_id, idempotency_key)`).
  - Flujo: (1) buscar el intento de `(user, key)`: si existe y es del mismo pedido, devolverlo con 200 sin tocar nada (ni pasarela, ni orders, ni auditoría); si es de **otro** pedido → 409 `idempotency_key_reused`; (2) seguir el flujo de R4; (3) al insertar, `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING`: si no inserta (carrera con la misma clave), se vuelve a buscar el intento y se devuelve con 200.
  - Si `ConfirmOrderPayment` devuelve `ALREADY_PAID`, primero se vuelve a buscar la clave (otra solicitud con la misma clave pudo pagar mientras esta esperaba el bloqueo del pedido) y, si existe, se devuelve con 200; si no existe, `order_already_paid`.
  - *Limitación aceptada (como ORDERS-R8):* no se compara la huella de la solicitud; la misma clave con otro `card_last4` devuelve el intento original.
  - El efecto sobre el pedido es idempotente además por orders (R16: `already_paid` sin efectos) y por la BD (R4: un solo intento `approved` por pedido).
- **PAYMENTS-R4 (efecto sobre el pedido, RF05.02):** solo se llama a `ConfirmOrderPayment` si la pasarela **aprobó**. Resultado: `PAID` → intento `approved`; `EXPIRED` → intento `rejected` con `failure_code = order_expired` (la transacción **se confirma**, orders ya expiró el pedido sin consumir stock y no hubo cobro); `ALREADY_PAID` → ver R3 y, si no hay intento propio, 409 `order_already_paid`, sin intento nuevo; `OrderNotPayable` (el pedido se canceló entre la lectura y la confirmación) → 409 `order_not_payable`. Si la pasarela **rechazó**, orders no se toca y el pedido sigue `pendiente_pago` con sus reservas. Una restricción de la BD impide dos intentos `approved` del mismo pedido (§6); su violación se traduce a `order_already_paid`.
- **PAYMENTS-R5 (qué pedidos se pueden pagar):** según `PayableOrder.status`:

  | Estado del pedido | Respuesta |
  |---|---|
  | `pendiente_pago` (vigente) | se continúa |
  | `pagado`, `en_preparacion`, `enviado`, `listo_para_recojo`, `entregado` | 409 `order_already_paid` (sin intento nuevo) |
  | `cancelado`, `expirado` (incluido el que `GetPayableOrder` acaba de expirar por vencido) | 409 `order_not_payable` con `details {"status"}` (sin intento nuevo) |
  | ajeno o inexistente | 404 `not_found` idéntico |

  Se decide con `status in (cancelado, expirado)` y `status != pendiente_pago`, sin copiar el conjunto de estados pagados de orders (los ocho estados quedan cubiertos). Un 409 deshace la transacción: la materialización del vencimiento se guarda en la siguiente lectura (R7 de orders, R-12).
- **PAYMENTS-R6 (el pedido vence durante el pago, D-017):** (a) vencido antes de empezar: `GetPayableOrder` lo expira y el pago responde 409 `order_not_payable {status: expirado}`, sin intento; (b) vence después de leerlo (por milisegundos o porque las reservas ya no cubren el stock, INVENTORY-R11): `ConfirmOrderPayment` lo expira y devuelve `EXPIRED`; payments registra el intento `rejected` con `order_expired` y responde **201 con `status: rejected`** (no 4xx, para que la transacción se confirme y orders conserve su expiración). En ningún caso se descuenta stock ni se cobra. El cliente ve que debe volver a comprar.
- **PAYMENTS-R7 (sin datos de tarjeta, RF05.04, RN-11, D-041 P-4):**
  - El número, el vencimiento, el titular y el CVV **nunca salen del navegador**. Al servidor solo llega `card_last4` (4 dígitos que el navegador deriva del número; ver P-1, que el usuario confirma).
  - `PayOrderIn` tiene `extra="forbid"` y `card_last4` con patrón `^[0-9]{4}$` exacto: cualquier campo extra (`card_number`, `cvv`, `expiry`, `holder`) o un `card_last4` más largo → 422 `validation_error` **sin devolver el valor recibido** (`shared/errors.py`).
  - Nada de la solicitud va a logs (el middleware solo registra método, ruta y estado), ni a la auditoría, ni a una excepción. La tabla solo tiene `card_last4` con `CHECK (~ '^[0-9]{4}$')`: la BD rechaza un número largo.
  - Las respuestas de payments llevan `Cache-Control: no-store` (se pone en el propio router, sin esperar el middleware transversal de orders R-14).
  - La interfaz no persiste ni registra esos campos (§9, CA-PAYMENTS-17).
- **PAYMENTS-R8 (identidad y dueño, RN-10):** `user_id` sale de `current_user`; el pedido se lee con `GetPayableOrder(user_id, order_id)`, que filtra por dueño. Ningún cuerpo, ruta o parámetro lleva `user_id`. Pedido ajeno e inexistente: el mismo 404.
- **PAYMENTS-R9 (tope de rechazos):** un pedido admite como máximo `MAX_REJECTED_ATTEMPTS = 5` intentos `rejected`; el siguiente → 409 `too_many_attempts` con `details {"max": 5}` (el valor lo fija P-2). No cuenta el rechazo `order_expired` (el pedido ya no es pagable). Se cuenta sin bloquear el pedido, así que es un **límite blando**: dos solicitudes simultáneas pueden pasar de 5 en uno (aceptado; E-P3 lo haría exacto). Repetir una clave ya registrada sigue devolviendo 200 aunque se haya alcanzado el tope.
- **PAYMENTS-R10 (transacción y orden de bloqueos, coherente con ORDERS-R4):**
  - Una transacción por solicitud (`SessionDep`); solo una respuesta 2xx la confirma, por eso un rechazo de la pasarela y `order_expired` son **2xx con el resultado en el cuerpo**.
  - Orden: lectura y vencimiento por orders (`GetPayableOrder`: pedido → reservas) → pasarela (sin BD) → `ConfirmOrderPayment` (pedido → reservas → stock, R4 de orders) → `INSERT` del intento. Payments no bloquea filas de orders ni de stock por su cuenta.
  - El `INSERT` del intento va **después** de la confirmación: su FK toma un `FOR KEY SHARE` sobre el pedido, que chocaría con el `FOR UPDATE` de `ConfirmOrderPayment` si se tomara antes (dos pagos simultáneos se bloquearían entre sí). En la ruta de rechazo no hay `ConfirmOrderPayment` y el `KEY SHARE` es compatible con el resto.
  - *Caso residual (aceptado, R-5):* dos solicitudes simultáneas con la **misma clave y distinto `card_last4`** (un error del cliente) pueden bloquearse entre sí; PostgreSQL aborta una (500 `internal_error`, sin datos corruptos) y el reintento con la misma clave devuelve el resultado ya guardado.
- **PAYMENTS-R11 (puerto de pasarela, D-041 P-4):** el caso de uso solo conoce `PaymentGateway` (§5); no importa ningún adaptador. El adaptador se elige en un único proveedor, `get_payment_gateway()` de `adapters/http.py` (hoy `SimulatedGateway`). Para cambiarlo por un proveedor real: (a) un adaptador nuevo que implemente el puerto con el token o el campo alojado del proveedor, (b) una variante nueva de `PayOrderIn` (p. ej. `payment_token`) añadida de forma compatible, (c) los `failure_code` del proveedor mapeados a los de §5, y (d) `pending` y webhooks si el proveedor es asíncrono (R1). Orders no cambia: sigue recibiendo `ConfirmOrderPayment`. `GatewayCharge.reference` (el id del intento) es la referencia de idempotencia que un proveedor real exigiría.
- **PAYMENTS-R12 (simulación determinista):** `SimulatedGateway` decide solo con `card_last4` (no sensible), sin azar y sin reloj, como las tarjetas de prueba de los proveedores:

  | `card_last4` | Resultado |
  |---|---|
  | `0002` | rechazado `card_declined` |
  | `9995` | rechazado `insufficient_funds` |
  | `0069` | rechazado `expired_card` |
  | `0119` | lanza `GatewayUnavailable` (sirve para probar el 503) |
  | cualquier otro | aprobado |

  *Es un simulador: el cliente elige el resultado. No hay dinero real en juego y es el contrato de RN-11 para el MVP; un proveedor real decide por su cuenta (R11).* Opciones alternativas en §12, P-1.
- **PAYMENTS-R13 (auditoría, RF14.01):** por cada intento **nuevo** (no en una repetición) una entrada `payments.attempt_recorded`, entidad `payment_attempt`, con actor (cliente) y `after {"order_id", "status", "failure_code", "amount"}`. Nunca `card_last4`, ni nada de la solicitud. La confirmación del pedido deja además `orders.status_changed` (orders). Un 409 o un 503 no deja entrada (la transacción se deshace).
- **PAYMENTS-R14 (reembolso, RF05.05):** payments **no tiene** caso de uso, ruta ni tabla de reembolsos. Un administrador cancela el pedido pagado en orders (ORDERS-R10) y se registra `refunded_amount`; los intentos `approved` no se modifican (inmutables). Una prueba cruzada lo comprueba (CA-PAYMENTS-14).
- **PAYMENTS-R15 (respuestas):** `POST` → 201 (200 en repetición) para **cualquier** resultado registrado; los rechazos no son errores HTTP. `GET` → 200. Importes como `Money`; fechas en UTC ISO 8601; ningún campo de la respuesta lleva datos de tarjeta salvo `card_last4`. `can_pay` y `attempts_left` los calcula el servidor (RN-09): la interfaz no decide.

## 5. Modelo de dominio

**Estados del intento** (`AttemptStatus`): `approved`, `rejected` (finales). No hay transiciones: se crea con el resultado (R1).

**Códigos de rechazo** (`FailureCode`): `card_declined`, `insufficient_funds`, `expired_card`, `order_expired` (este último lo pone payments cuando orders devuelve `EXPIRED`; los demás los devuelve la pasarela).

Entidades y objetos de valor (dominio puro, sin `fastapi`, `pydantic`, `sqlalchemy` ni imports de otros módulos):
- `PaymentMethod(card_last4: str)`: valida `^[0-9]{4}$`; si no, `InvalidPaymentMethod`. Es lo único de la tarjeta que existe en el servidor.
- `PaymentAttempt`: `id`, `order_id`, `user_id`, `idempotency_key`, `status`, `amount`, `failure_code`, `card_last4`, `gateway`, `created_at | None`. Invariantes: `amount ≥ 1`; `status = rejected` si y solo si `failure_code` no es `None`; la clave cumple 16–64 y `[A-Za-z0-9_-]`.
- Funciones puras: `new_attempt(...) -> PaymentAttempt` (aprobado si `failure_code` es `None`) y `attempts_left(rejected_count: int) -> int` (`max(0, MAX_REJECTED_ATTEMPTS − n)`).
- Errores: `PaymentError`, `InvalidPaymentMethod`, `OrderAlreadyPaid`, `TooManyAttempts(max)`, `IdempotencyKeyReused`, `GatewayUnavailable`. De orders se reutilizan `OrderNotFound` y `OrderNotPayable(status)` (los lanza el puerto; payments los traduce en HTTP).

**Puerto de pasarela** (`payments/application.py`):
- `GatewayCharge(reference: UUID, amount: int, method: PaymentMethod)`: `reference` = id del intento; el importe es siempre PEN en céntimos.
- `GatewayResult(failure_code: FailureCode | None)` con la propiedad `approved`.
- `PaymentGateway(Protocol)`: atributo `name: str` (se guarda en `payment_attempts.gateway`) y `authorize(charge: GatewayCharge) -> GatewayResult`. Es **síncrono, sin BD y sin efectos sobre el pedido**; puede lanzar `GatewayUnavailable`. Nunca recibe número, vencimiento ni CVV.
- Adaptador simulado: `payments/adapters/simulated_gateway.py` → `SimulatedGateway` con `name = "simulated"` y la tabla de R12.

## 6. Persistencia

Migración `0011` (`--rev-id 0011`, sigue a `0010`). Revisar con la skill `database-migration-review`. Importes en `bigint`; una sola moneda (PEN, RN-15), sin columna de moneda, como orders.

```
app.payment_attempts   (solo inserción)
  id uuid PK
  order_id uuid NOT NULL FK → app.orders(id) ON DELETE RESTRICT
  user_id uuid NOT NULL FK → app.profiles(user_id) ON DELETE RESTRICT        (el dueño sale de la sesión; orders ya lo comprobó)
  idempotency_key text NOT NULL CHECK (char_length BETWEEN 16 AND 64)
  status text NOT NULL CHECK IN ('approved','rejected')
  amount bigint NOT NULL CHECK (> 0)
  failure_code text NULL CHECK (failure_code ~ '^[a-z_]{1,40}$')
  card_last4 text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$')
  gateway text NOT NULL CHECK (char_length BETWEEN 1 AND 30)
  created_at timestamptz NOT NULL DEFAULT now()
  CHECK ((status = 'rejected') = (failure_code IS NOT NULL))
  UNIQUE (user_id, idempotency_key)
  UNIQUE INDEX uq_payment_attempts_order_approved ON (order_id) WHERE status = 'approved'     (a lo sumo un cobro aprobado por pedido)
  INDEX (order_id, created_at DESC, id DESC)
```

- Sin `updated_at`: la tabla es inmutable. Sin columnas de titular, número, vencimiento ni CVV, ni siquiera nulables (RF05.04).
- Permisos (D-029, como `0010`): `GRANT SELECT, INSERT ON app.payment_attempts TO valmont_app` (sin `UPDATE` ni `DELETE`); `test_app_role` cubre la tabla nueva.
- FK a `app.orders` y `app.profiles` sin leer esas tablas: requiere ampliar la excepción (6)/(7) de `modules.md` §3 (E-P2, §8), igual que E-2 de orders.
- La coherencia entre el pedido y sus intentos (un `approved` implica pedido pagado o posterior) cruza tablas y la impone el caso de uso dentro de la misma transacción.
- `downgrade`: destructivo (borra el historial de intentos); solo en BD locales o de pruebas. Se añade el registro de `adapters/persistence` en `migrations/env.py`.

## 7. Contrato API (PROPUESTO)

Prefijo `/api/v1/payments`. Todas exigen sesión: 401 `unauthenticated` y 503 `auth_unavailable`. Errores en el formato común (`ERROR_RESPONSES`). Importes como `Money` (`{"amount": int, "currency": "PEN"}`); ids como UUID en texto; fechas en UTC.

| Método | Ruta | Auth | Request | Response | Errores |
|---|---|---|---|---|---|
| POST | `/orders/{order_id}/attempts` | cliente | cabecera `Idempotency-Key`; `PayOrderIn` | 201 `PaymentAttemptOut` (200 si repite la clave) | 404, 409 `order_not_payable` / `order_already_paid` / `too_many_attempts` / `idempotency_key_reused`, 422, 503 `payment_gateway_unavailable` |
| GET | `/orders/{order_id}/attempts` | cliente | — | `OrderPaymentsOut` | 404, 422 |

```jsonc
// PayOrderIn (extra="forbid": ni importe, ni user_id, ni resultado, ni número, vencimiento, titular o CVV)
{"card_last4": "4242"}        // exactamente 4 dígitos; el navegador lo deriva del número y nunca envía el número

// PaymentAttemptOut
{"id": "uuid", "order_id": "uuid",
 "status": "approved",         // | "rejected"
 "failure_code": null,         // null si approved; si rejected: "card_declined" | "insufficient_funds" | "expired_card" | "order_expired"
 "amount": Money, "card_last4": "4242", "created_at": "…Z"}

// OrderPaymentsOut
{"order_id": "uuid",
 "can_pay": true,              // el pedido está pendiente_pago vigente y quedan intentos
 "attempts_left": 5,           // MAX_REJECTED_ATTEMPTS − rechazos (nunca negativo)
 "attempts": [PaymentAttemptOut]}   // el más reciente primero (created_at desc, id desc); vacío si no hay
```

**Detalles que cierran el contrato**
- **Pagar (`POST`):**
  - Sin `Idempotency-Key` o con formato inválido → 422 con `loc ["header", "idempotency-key"]`. Campo extra (`amount`, `status`, `user_id`, `card_number`, `cvv`, `expiry`) o `card_last4` mal formado → 422 `validation_error` con `loc ["body", …]` y **sin eco del valor**. `order_id` mal formado → 422.
  - 201 y 200 con cualquier resultado registrado, también `rejected` (R15). El cliente decide qué mostrar con `status` y `failure_code`.
  - 409 `order_not_payable` con `details {"status": "cancelado" | "expirado"}`; 409 `order_already_paid` (R5); 409 `too_many_attempts` con `details {"max": 5}`; 409 `idempotency_key_reused` (la clave pertenece a un intento de otro pedido); 503 `payment_gateway_unavailable` (`GatewayUnavailable`: sin intento, el pedido intacto; se reintenta con la misma clave).
  - Ninguna respuesta de error deja efectos: ni intento, ni auditoría, ni cambios en el pedido o el stock.
  - Todas las respuestas llevan `Cache-Control: no-store`.
- **Listar (`GET`):** 404 idéntico para pedido ajeno e inexistente (R8). Cuando el pedido está vencido, el `GET` lo expira (R7 de orders) y `can_pay` es `false`. No devuelve `user_id`, `gateway` ni nada de la solicitud original.
- **Consumo desde la interfaz (T-097, T-098; contrato con la pantalla `T-082b`):**
  1. La interfaz crea el pedido con `POST /orders` (T-081/T-082a) y recibe `OrderDetailOut` en `pendiente_pago` con `expires_in_seconds`.
  2. El formulario de tarjeta es **solo cliente**: valida número, vencimiento y CVV en el navegador (sin enviarlos), calcula `card_last4` y llama a `POST /payments/orders/{id}/attempts` con una clave nueva de `crypto.randomUUID()` por pulsación de "Pagar" (la misma clave si se reintenta tras un corte o un doble clic).
  3. `201/200 approved` → confirmación del pedido (`GET /orders/{id}` ya trae `pagado`). `rejected` → mensaje según `failure_code`, formulario de nuevo si `can_pay`. `409 order_not_payable` / `order_already_paid` → releer el pedido y mostrar su estado. `503` → "inténtalo de nuevo" con la misma clave.
  4. Tras un rechazo, el pedido sigue `pendiente_pago` y la cuenta atrás de orders sigue corriendo; el botón "Pagar" del detalle del pedido (T-083) reutiliza el mismo cliente.
  5. Los campos de tarjeta no llevan `name`, el formulario no se envía de forma nativa, no hay almacenamiento ni analítica sobre ellos (H-12, D-041 P-4).
- **Seguridad del contrato:** ninguna ruta, cuerpo o parámetro acepta `user_id`, importe, estado ni resultado; las cabeceras no confiables no se usan para la identidad.

## 8. Dependencias

- **Consume:**
  - `orders.application`: `GetPayableOrder`, `ConfirmOrderPayment`, `PayableOrder`, `PaymentOutcome`, `OrderNotFound`, `OrderNotPayable` y `OrderStatus` (SPEC de orders §8, T-077; las firmas están leídas del código). Todos se importan de `valmont.modules.orders.application`, nunca de su dominio.
  - `orders.adapters.wiring` (nuevo, **T-091**, R-13 de orders): `get_get_payable_order` y `get_confirm_order_payment`, por la excepción (7).
  - `audit.application.AuditRecorder` y `AuditRecorderDep` (excepción 2); `identity.adapters.http.current_user` (excepción 1).
- **Expone:** solo HTTP (§7). Reports (RF07) lee `orders`; si necesitara los intentos, su SPEC pediría el contrato de lectura.
- **Cambios y propuestas fuera del módulo (las registra el Leader; payments no las aplica):**
  - **E-P1 (orders, T-091, ya autorizada por la excepción 7 y por R-13):** `backend/src/valmont/modules/orders/adapters/wiring.py`.
  - **E-P2 (`docs/modules.md` §3):** añadir a las excepciones (6)/(7) que payments tiene FK a `app.orders` y `app.profiles` (sin leerlas) y, en la fila de payments, su estado `SPECIFICATION (T-090, D-041)`.
  - **E-P3 (orders, opcional, antes de un proveedor real):** `GetPayableOrder.__call__(user_id, order_id, *, lock: bool = False)`; con `lock=True` bloquea el pedido (`get(lock=True)`) tras vencerlo. Permitiría pagar con la fila bloqueada **desde el principio** (cobro exacto, tope de rechazos exacto, sin el caso residual de R10) y es lo que un proveedor real necesita para no cobrar y descubrir después `ALREADY_PAID`. Es un cambio aditivo en orders: lo decide su dueño.
  - **E-P4 (orders, cosmético):** declarar `__all__` en `orders.application` (o reexportar explícitamente `OrderStatus`, `OrderNotFound`, `OrderNotPayable`), para que importarlos desde `application` sea una API pública y no un accidente de los imports.
  - **E-P5 (`shared/`, a futuro):** la cabecera `Idempotency-Key` se duplica entre orders y payments (mismo patrón); si aparece un tercer uso, moverla a `shared/`.

## 9. Seguridad

- **PCI DSS y RN-11:** el servidor solo trata `card_last4` (un dato truncado que los estándares permiten almacenar). Con un proveedor de campos alojados el número tampoco pasará por el navegador de Valmont (R11). Cada capa lo impide: esquema cerrado, patrón exacto, `CHECK` de la BD, sin eco en errores, sin cuerpo en logs, sin dato de tarjeta en la auditoría y sin columna que lo admita.
- **Identidad solo de la sesión** (R8); 404 indistinguible entre ajeno e inexistente; sin ruta de administración.
- **Importe y resultado solo en el servidor** (R2, R12); la interfaz no decide `can_pay` ni `attempts_left`.
- **Integridad:** una transacción, `UNIQUE (user_id, idempotency_key)`, un solo `approved` por pedido en la BD, tabla de solo inserción, comparar-y-cambiar de orders con la fila bloqueada, ningún "comprobar y después escribir" propio (`modules.md` §4.8).
- **Abuso:** tope de rechazos por pedido (R9), 30 minutos de vigencia del pedido, tope de 3 pedidos sin pagar (orders R9), `extra="forbid"`. No hay limitador de frecuencia global (R-14 de orders y R-4 de este módulo).
- **Riesgo aceptado del simulador:** quien llame a la API puede pagar cualquier pedido propio con una tarjeta de prueba; es inherente a un cobro simulado y desaparece con un proveedor real (R11, R-3).
- **Cabeceras:** `Cache-Control: no-store` en payments; `nosniff` y el tope del cuerpo siguen siendo transversales (R-14 de orders).
- **Pendiente para la auditoría final de seguridad** (decisions.md, QA con Opus, T-096): carreras de pago (CA-10), ausencia de datos de tarjeta en base de datos, logs, auditoría y respuestas (CA-07), aislamiento (CA-08) y la intercepción de red de la interfaz (CA-17).

## 10. Criterios de aceptación

- [ ] CA-PAYMENTS-01 (UC-01, RF05.01, RF05.02, R1, R2, R4): con un pedido `pendiente_pago` propio y `card_last4 = 4242`, `POST …/attempts` → 201 `approved`, `failure_code` nulo, `amount` igual al `total` del pedido; el pedido pasa a `pagado` con `paid_at`, `on_hand` baja en lo reservado con un movimiento `venta`, las reservas quedan `consumed`; existe una fila de intento; `GET /orders/{id}` muestra `pagado`; un pedido solo Bajo pedido se paga sin consumir stock.
- [ ] CA-PAYMENTS-02 (UC-01, RF05.01, RF05.02, R4, R12): con `0002`, `9995` y `0069` → 201 `rejected` con `card_declined`, `insufficient_funds` y `expired_card`; el pedido sigue `pendiente_pago`, las reservas `active` y el stock intacto; el intento queda registrado; con `0119` → 503 `payment_gateway_unavailable`, sin intento, sin auditoría y con el pedido intacto, y reintentar con la misma clave y otra tarjeta funciona.
- [ ] CA-PAYMENTS-03 (UC-04, RF05.03, R3): repetir la solicitud con la misma clave → 200 con el mismo `id`, una sola fila, una sola llamada a la pasarela, un solo descuento de stock y una sola entrada de auditoría, también si la clave ya está registrada tras alcanzar el tope; sin cabecera o con formato inválido → 422; la misma clave de otro cliente crea su propio intento; la misma clave con otro pedido → 409 `idempotency_key_reused`; tras un rechazo, una clave nueva crea un intento nuevo.
- [ ] CA-PAYMENTS-04 (RF05.03, R5): pagar un pedido ya `pagado`, `en_preparacion`, `enviado`, `listo_para_recojo` o `entregado` con una clave nueva → 409 `order_already_paid`, sin intento nuevo y con el stock sin cambios.
- [ ] CA-PAYMENTS-05 (R5, R6a): `cancelado` o `expirado` → 409 `order_not_payable` con su `status`; un `pendiente_pago` con `expires_at` pasado y sin materializar → 409 con `expirado`; en todos, sin intento ni consumo; un pedido ajeno o inexistente → 404 idéntico.
- [ ] CA-PAYMENTS-06 (R6b, R4, R10): si el pedido vence entre la lectura y la confirmación (reloj de la prueba), o la reserva ya venció, la respuesta es 201 `rejected` con `failure_code = order_expired`; el pedido queda `expirado` (la transacción se confirmó), con reservas liberadas, sin descuento de stock y con el intento registrado; no cuenta para el tope de rechazos.
- [ ] CA-PAYMENTS-07 (RF05.04, RN-11, R7): un cuerpo con `card_number`, `cvv`, `expiry`, `holder` o un `card_last4` de 16 dígitos → 422 `validation_error` y la respuesta **no contiene el valor enviado**; con un número de prueba enviado en esos campos, ni los logs (`caplog` en todos los niveles), ni la auditoría, ni ninguna columna de ninguna tabla de `app`, ni ninguna respuesta lo contienen; la BD rechaza un `card_last4` de más o de menos de 4 dígitos; la tabla no tiene columnas de titular, número, vencimiento ni CVV.
- [ ] CA-PAYMENTS-08 (RN-10, R8, seguridad): con dos clientes, ninguna ruta toca el pedido o los intentos del otro (404 idéntico al inexistente); sin sesión → 401; ningún cuerpo ni parámetro acepta `user_id`, `amount`, `status` ni `result` (422); no existe ruta de administración.
- [ ] CA-PAYMENTS-09 (R9): tras `MAX_REJECTED_ATTEMPTS` intentos `rejected` el siguiente → 409 `too_many_attempts` con `max`, sin intento nuevo; `order_expired` no cuenta; `attempts_left` y `can_pay` del `GET` lo reflejan; el orden de comprobación es R5 (estado del pedido) antes que el tope.
- [ ] CA-PAYMENTS-10 (R3, R4, R10, concurrencia, dos conexiones reales): dos solicitudes simultáneas con la **misma** clave dejan un solo intento y un solo descuento de stock (201 + 200) y ninguna 500; dos con claves **distintas** que la pasarela aprueba: exactamente una 201 `approved` y la otra 409 `order_already_paid`, con `on_hand` descontado una vez; pago y cancelación del cliente simultáneos sobre el mismo pedido: gana uno solo, nunca hay stock descontado en un pedido cancelado ni un pedido pagado con reservas liberadas; pago y vencimiento en el límite: estado final único; sin interbloqueos entre pagos de pedidos con los mismos productos en distinto orden.
- [ ] CA-PAYMENTS-11 (UC-02, RF05.01, RF05.02, R15): `GET …/attempts` devuelve los intentos del pedido, el más reciente primero, con `status`, `failure_code`, `amount` (Money), `card_last4` y `created_at`; vacío sin intentos; `can_pay` es `true` solo con el pedido `pendiente_pago` vigente y `attempts_left > 0`; un pedido vencido se expira al leerlo y `can_pay` es `false`; el de otro cliente → 404.
- [ ] CA-PAYMENTS-12 (R11, UC-03): con una pasarela falsa inyectada (aprobar, rechazar con cada código, lanzar `GatewayUnavailable`) `PayOrder` produce los mismos resultados sin tocar orders, el router ni el esquema; `PayOrder` y `GetOrderPayments` no importan ningún adaptador ni `SimulatedGateway`; `SimulatedGateway` cumple la tabla de R12 (determinista) y nunca recibe un campo distinto de `GatewayCharge`.
- [ ] CA-PAYMENTS-13 (RF14.01, R13): cada intento nuevo, aprobado o rechazado, deja exactamente una entrada `payments.attempt_recorded` con actor y `after {order_id, status, failure_code, amount}`, sin `card_last4`; una repetición, un 409 y un 503 no dejan ninguna; la aprobación deja además la entrada de orders.
- [ ] CA-PAYMENTS-14 (RF05.05, R14, UC-05): un pedido pagado por payments y cancelado por un administrador (UC-ORDERS-10) queda `cancelado` con `refunded_amount = total_amount`; el intento `approved` no cambia; payments no expone ninguna ruta de reembolso (el OpenAPI no la trae).
- [ ] CA-PAYMENTS-15 (RNF08, RF05.04, RN-15, §6): la migración `0011` sube y baja (`alembic upgrade head`, `alembic check`, `downgrade -1`, `upgrade head`); los `CHECK` de estado, coherencia `rejected`/`failure_code`, `card_last4`, importe y longitud de clave rechazan filas inválidas; `UNIQUE (user_id, idempotency_key)`; un segundo `approved` del mismo pedido se rechaza; dos `rejected` caben; FK `RESTRICT`; `bigint` por encima de 2³¹; con el rol `valmont_app`, `UPDATE` y `DELETE` fallan y `SELECT`/`INSERT` funcionan.
- [ ] CA-PAYMENTS-16 (contrato, §7, R15): el OpenAPI declara las dos rutas, cada error de §7 con su `code` y `details`, `Money` en la salida, `Idempotency-Key` como cabecera obligatoria y `extra="forbid"` en la entrada; las respuestas llevan `Cache-Control: no-store`; las pruebas de contrato fallan si cambia un campo.
- [ ] CA-PAYMENTS-17 (T-098, RF05.04, D-041 P-4, E2E): en la pantalla de pago ninguna solicitud del navegador (URL, cuerpo, cabeceras) contiene el número completo ni el CVV —se intercepta la red—, solo `card_last4`; `localStorage`, `sessionStorage` y cookies no los contienen; los campos no tienen `name` y el formulario no se envía de forma nativa; un doble clic envía la misma clave; `approved` lleva a la confirmación, `rejected` muestra el mensaje de su `failure_code` y permite reintentar con clave nueva mientras `can_pay`; 409 y 503 muestran su aviso; sin sesión redirige al ingreso.
- [ ] CA-PAYMENTS-18 (capas): `payments/domain.py` no importa `fastapi`, `pydantic`, `sqlalchemy` ni otros módulos; `payments` solo importa de otros módulos su `application`, los `adapters/wiring` y las dependencias de las excepciones (1) y (2); `orders/adapters/wiring.py` y sus proveedores construyen los casos de uso con la sesión de la solicitud y se comportan igual que construidos a mano (CA-ORDERS-14 y 15 siguen en verde sin editarse).

## 11. Plan de pruebas

Las escribe `qa-reviewer` (D-033) en `backend/tests/payments/` (más `backend/tests/orders/` solo para el `wiring.py`, `backend/tests/test_app_role.py` y `backend/tests/test_migrations.py`), `frontend/tests/**` y `frontend/e2e/**`; quien implementa no escribe pruebas.

- **Unitarias (sin BD):**
  - Dominio: `PaymentMethod` (4 dígitos; 3, 5, letras, espacios, `\n` y 16 dígitos → error), invariantes de `PaymentAttempt`, `new_attempt`, `attempts_left`.
  - `SimulatedGateway`: la tabla de R12 completa, determinismo, `GatewayUnavailable`.
  - `PayOrder` con repositorio, pasarela y puertos de orders falsos: aprobado, cada rechazo, repetición, clave de otro pedido, cada estado del pedido (R5), `EXPIRED`, `ALREADY_PAID` con y sin intento propio, `OrderNotPayable` en la confirmación, tope, `GatewayUnavailable`, "ningún efecto" tras cada 409/503, auditoría exacta.
  - `GetOrderPayments`: `can_pay` y `attempts_left` por estado.
- **Integración (BD real, dos conexiones donde se indica), con orders, inventory y cart reales:**
  - UC-01 completo: stock, reservas, historial de orders, auditoría; rollback total ante cada 409 y 503; `EXPIRED` confirmado.
  - Concurrencia (CA-10): misma clave, claves distintas, pago contra cancelación, pago contra vencimiento, pedidos con los mismos productos en distinto orden.
  - Migración, restricciones, índice parcial, `GRANT` (CA-15) y el `wiring.py` de orders.
- **Contrato (HTTP con la app real):** formas de §7, códigos y `details`, 401/404/409/422/503, `loc` por campo, ausencia de eco de valores, OpenAPI, `Cache-Control`.
- **Seguridad:** aislamiento entre dos clientes, campos de tarjeta en el cuerpo y como `card_last4`, búsqueda del número de prueba en logs, auditoría, respuestas y todas las tablas, cliente contra rutas inexistentes de administración.
- **E2E (Playwright, T-098):** carrito → pedido → pago aprobado; pago rechazado y reintento; vencimiento durante el pago; doble clic; intercepción de red (CA-17); accesibilidad del formulario (axe).
- **Ronda final de seguridad (T-096, `qa-reviewer` con `model: "opus"`, decisions.md):** CA-07, 08, 10, 15 y 17 con la mentalidad de un atacante, incluida la revisión de logs de errores 500 y de la ruta de repetición de claves.
- **Casos de borde obligatorios:** importe por encima de 2³¹; pedido de una sola línea Bajo pedido; `expires_at` igual a `now` (vencido) y un segundo antes (vigente); clave repetida en otro pedido; `0119` seguido de un pago correcto con la misma clave; tope alcanzado y luego repetir una clave anterior; cliente con tres pedidos sin pagar pagando el segundo; pedido pagado y cancelado por el administrador.

## 12. Preguntas abiertas

> **Resueltas en D-043 (2026-11-27):** P-1 A (4 últimos dígitos), P-2 B (5 rechazos), P-3 A (detallado en la demo), P-4 A (se guarda `card_last4`), P-5 A (una sola pantalla), P-6 A (sin vista de administración). Las hipótesis P-1…P-6 de esta SPEC pasan a ser decisiones.

Las preguntas de negocio no las resuelve este módulo; cada una lleva una hipótesis conservadora con la que el plan avanza y que se invierte sin rehacer el resto.

| ID | Pregunta | Hipótesis conservadora (recomendada) | Decide |
|---|---|---|---|
| P-1 | **¿Cómo se simula el resultado?** (A) regla determinista sobre `card_last4`, como las tarjetas de prueba de los proveedores (0002 rechaza, 9995 sin fondos, 0069 vencida, 0119 caída de pasarela; el resto aprueba); (B) campo `scenario` explícito y solo en `dev`; (C) azar con tasa de rechazo; (D) botón "Simular pago" sin formulario (descartado por D-041). **Matiz que el usuario debe confirmar:** D-041 dice que "el número y el CVV nunca salen del navegador"; A envía los **4 últimos dígitos**, que no son el número y que PCI DSS permite guardar, pero sí salen del navegador. Si se prefiere que nada derivado salga, la alternativa es B (la interfaz elige el escenario con un selector de demostración visible solo en `dev`) y el formulario real no envía nada. | A | usuario |
| P-2 | **¿Un pago rechazado permite reintentar y cuántas veces?** (A) sin tope mientras el pedido siga vigente; (B) tope de **5** rechazos por pedido; (C) 1 reintento; (D) ninguno: se cancela y se vuelve a comprar. El pedido sigue vigente 30 min y un cliente puede tener hasta 3 sin pagar. | B (5; `MAX_REJECTED_ATTEMPTS`) | usuario |
| P-3 | **¿Qué ve el cliente al rechazarse?** (A) un mensaje por cada `failure_code` ("Tarjeta rechazada", "Fondos insuficientes", "Tarjeta vencida", "El pedido venció, vuelve a comprar") (B) un mensaje genérico ("No pudimos procesar el pago"), que es lo que recomiendan los proveedores reales para no ayudar a quien prueba tarjetas. | A en el simulador; B cuando haya un proveedor real | usuario |
| P-4 | **¿Se guarda `card_last4`?** (A) sí, solo los 4 últimos dígitos, para mostrar "terminada en 4242" y para auditar un intento; (B) no se guarda (se usa solo para decidir el resultado y se descarta), con lo que el historial no muestra tarjeta. Se almacenan las mismas 4 cifras que un recibo impreso; ningún número, titular, vencimiento ni CVV. | A | usuario |
| P-5 | **Flujo de pantalla:** (A) una sola pantalla "Confirmar y pagar" que hace dos llamadas seguidas (crear pedido y pagar) y, si se rechaza, deja el pedido pendiente y vuelve al formulario; (B) dos pasos separados: confirmar el pedido (queda `pendiente_pago`) y después pagar desde su detalle. La API admite ambos. | A, con "Pagar" en el detalle del pedido pendiente para retomarlo (VIEWS §Mis pedidos) | usuario y frontend-lead |
| P-6 | **¿El administrador necesita ver los intentos de pago de un pedido?** (A) no en el MVP: ve el estado y el reembolso en orders y la auditoría registra cada intento; (B) sí: `GET /payments/admin/orders/{id}/attempts` (una ruta pequeña y de solo lectura). | A | usuario |
