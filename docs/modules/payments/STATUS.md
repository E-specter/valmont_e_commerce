# payments — Estado
> Fase: 4 · Estado del módulo: SPECIFICATION (SPEC propuesta en T-090; pendiente de aprobación del alcance por el Leader, del contrato §7 por backend-lead y frontend-lead, y de las preguntas de negocio P-1…P-6 de la SPEC §12) · Última actualización: 2026-11-27 module-coordinator

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-090 | SPEC y plan de payments | module-coordinator | RF05, RN-08, RN-11, D-016, D-017, D-040 (E-3), D-041 (P-4) | DONE |
| T-091 | Costura de orders: `modules/orders/adapters/wiring.py` con `get_get_payable_order` y `get_confirm_order_payment` (R-13 de orders) | backend-dev + qa-reviewer | excepción (7), T-077 (DONE) | DONE (ca73b56) |
| T-092 | Dominio de payments, puertos (`PaymentGateway`, `PaymentAttemptRepository`) y adaptador simulado | backend-dev + qa-reviewer | T-090 aprobada (alcance y P-1, P-2, P-4) | DONE (2d596a2) |
| T-093 | Migración `0011`, fila y repositorio SQL de intentos | backend-dev + qa-reviewer | T-092; E-P2 registrada | DONE (0d0fdd1) |
| T-094 | Pagar un pedido (`PayOrder`) y `POST /payments/orders/{id}/attempts` | backend-dev + qa-reviewer | T-091, T-093 | DONE (ec34d3a) |
| T-095 | Consultar los intentos (`GetOrderPayments`) y `GET /payments/orders/{id}/attempts` | backend-dev + qa-reviewer | T-094 | DONE (fbd006a) |
| T-096 | Integración transversal y auditoría de seguridad del backend de payments | qa-reviewer (con Opus, decisions.md) | T-091…T-095 | READY |
| T-097 | Cliente de API de payments (`frontend/src/lib/api/payments.ts`) y tipos | frontend-dev + qa-reviewer | T-094, T-095 integradas; contrato §7 aprobado | BACKLOG (no READY: sin contrato aprobado ni backend) |
| T-098 | Pantalla de pago: formulario de tarjeta solo cliente, estados y reintento (la `T-082b` de la pista `ui`) | frontend-dev + qa-reviewer | T-097, T-082a (checkout y creación del pedido), T-111, componentes `ui/` (T-117…T-119) | BACKLOG (no READY: sin diseño de pago cerrado) |

IDs reservados del módulo: T-090–T-099. En uso: T-090–T-098; **libre: T-099** (un `fix` o una división de T-098 por frontend-lead).

**Decisiones previas que condicionan el plan:** D-040 E-3 (el reembolso simulado es de orders; payments no tiene puerto para él), D-041 P-4 (formulario solo cliente; pasarela con puerto y adaptador simulado), excepción (7) de `modules.md` §3 (orders debe exponer su `wiring.py`, R-13 de orders). Las preguntas de negocio (SPEC §12, P-1…P-6) se responden antes de T-092; las hipótesis recomendadas ya están en la SPEC y el plan avanza con ellas.

**Orden y paralelismo:** T-091 ∥ T-092 (archivos disjuntos) → T-093 (usa el dominio) → T-094 (usa el `wiring.py` y el repositorio) → T-095 (mismos archivos `application.py` y `adapters/http.py`: **en serie**) → T-096. En paralelo con cada tarea, `qa-reviewer` escribe las pruebas de la siguiente contra las firmas de este STATUS (D-033). Frontend (T-097, T-098) empieza con T-095 integrada.

**Rutas disjuntas (D-033):** quien implementa escribe solo `backend/src/**` (y `backend/migrations/**` en T-093) y su traspaso aquí; `qa-reviewer` escribe solo `backend/tests/payments/**` (y `backend/tests/orders/**` solo para el `wiring.py` en T-091, `backend/tests/test_app_role.py` y `backend/tests/test_migrations.py` en T-093), y en T-097 y T-098 `frontend/tests/**` y `frontend/e2e/**`. Estructura `modules/payments/{domain.py, application.py, adapters/persistence.py, adapters/simulated_gateway.py, adapters/http.py}` con la skill `backend-module-implementation`; las referencias de estilo son `modules/orders/` (HTTP, `Idempotency-Key`, errores, `Money`, `ERROR_RESPONSES`, `wiring.py` de cart e inventory) y `modules/inventory/` (transacciones y auditoría).

## Propuestas para el Leader (payments no las aplica: solo modifica `docs/modules/payments/**`)

**Filas para `docs/agents/tasks.md`:**
```
| T-090 | SPEC y plan de payments | requisitos, backend | module-coordinator (revisa claude-leader) | RF05, RN-08, RN-11, D-016, D-017, D-040, D-041 | docs/modules/payments/SPEC.md | IN_REVIEW | SPEC propuesta; 6 preguntas de negocio (P-1…P-6) y el contrato §7 sin aprobar |
| T-091 | Costura de orders: `adapters/wiring.py` (R-13) | backend | backend-dev + qa-reviewer | excepción (7), T-077 | docs/modules/payments/STATUS.md | READY | primera tarea de payments; no depende del contrato |
| T-092…T-096 | Implementación de payments (dominio y pasarela simulada, esquema 0011, pagar, consultar, seguridad final con Opus) | backend | backend-dev + qa-reviewer (T-096: qa-reviewer con Opus) | ver STATUS de payments | docs/modules/payments/STATUS.md | BACKLOG | T-092 READY al aprobar la SPEC; T-099 libre |
| T-097…T-098 | Cliente de API de payments y pantalla de pago (T-082b de la pista ui) | frontend | frontend-dev + qa-reviewer | ver STATUS de payments | docs/modules/payments/STATUS.md | BACKLOG | sin READY hasta tener el backend integrado y el diseño de pago |
```
**`docs/agents/_registry.md`:** `| docs/modules/payments/ | Carpeta | SPEC y STATUS del módulo payments | 03-modules/payments | claude-leader | 2026-11-27 |`.

**`docs/modules.md` §3 (E-P2):**
- Fila de payments: Depende de `orders, audit, identity` (hoy solo `orders`: el flujo usa también la auditoría y la sesión) y Estado `SPECIFICATION (T-090, D-041)`.
- Añadir a las excepciones (6)/(7): "payments tiene FK a `app.orders` y `app.profiles` y no las lee; consume de orders solo `GetPayableOrder` y `ConfirmOrderPayment` por `orders/adapters/wiring.py`". Debe estar registrado **antes de T-093**.

**`docs/decisions.md`:** una D-043 "Pagos simulados" tras las respuestas del usuario a P-1…P-6 (puerto de pasarela, regla de simulación, tope de rechazos, `card_last4`), que reemplace estas hipótesis por decisiones.

**Otros documentos:** `docs/design_ui/VIEWS.md` H-12 y P-4 (frontend-lead): el contrato de pago ya está propuesto (SPEC §7, "Consumo desde la interfaz"). `docs/requirements.md`: RF05.01…RF05.04 pasan a APROBADO cuando el Leader apruebe la SPEC. Orders: E-P3 y E-P4 de la SPEC §8 son propuestas de cambio para el dueño de orders, no tareas de payments.

## Paquetes de tarea

### T-091 — Costura de orders: `adapters/wiring.py` (R-13)
- Objetivo: payments puede construir `GetPayableOrder` y `ConfirmOrderPayment` con la sesión de la solicitud, sin importar el repositorio de orders.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders (lo pide payments) · Requisitos: ninguno directo (habilita RF05.02 y RF05.03) · Decisiones: D-033, D-040 (excepción 7)
- Leer: `docs/modules/orders/SPEC.md` §4 (R4, R16) y §8; `docs/modules/orders/STATUS.md` R-13; `backend/src/valmont/modules/orders/application.py` (`GetPayableOrder`, `ConfirmOrderPayment`, `ExpireOverdueOrders`, `Clock`); `modules/orders/adapters/http.py` (`get_orders`, `get_clock`, `get_expire_overdue_orders`: **no se importa ese archivo**, se construye igual); `modules/cart/adapters/wiring.py` e `inventory/adapters/wiring.py` (estilo); `modules/audit/adapters/http.py` (`AuditRecorderDep`).
- Contratos aplicables: ninguno HTTP. SPEC de payments §8.
- Dependencias: excepción (7) ya registrada; T-077 (DONE).
- Puede modificar: `backend/src/valmont/modules/orders/adapters/wiring.py` (nuevo) y su traspaso en este STATUS.
- Protegido: el resto de orders (`application.py`, `domain.py`, `adapters/http.py`, `admin_http.py`, `persistence.py`), `main.py`, `shared/`, `migrations/**`, `backend/tests/**`. Sin dependencias nuevas.
- Resultado esperado: dos proveedores sin lógica de negocio que construyen los casos de uso reales con `SqlOrderRepository(session)`, `SqlClock(session)` y los casos de uso de inventory y audit que reciben por `Depends`.
- Criterios de aceptación: los casos de uso construidos por los proveedores se comportan como los construidos a mano (CA-ORDERS-14 y 15 de orders siguen en verde sin editarse); CA-PAYMENTS-18 (capas, parte de orders).
- Firmas públicas (contra las que escribe QA):
  - `valmont.modules.orders.adapters.wiring`:
    - `get_get_payable_order(session: SessionDep, release: Annotated[ReleaseReservations, Depends(get_release_reservations)], audit: AuditRecorderDep) -> GetPayableOrder` (construye `ExpireOverdueOrders(orders, release, audit, clock)` y `GetPayableOrder(orders, expire)`).
    - `get_confirm_order_payment(session: SessionDep, consume: Annotated[ConsumeReservations, Depends(get_consume_reservations)], release: Annotated[ReleaseReservations, Depends(get_release_reservations)], audit: AuditRecorderDep) -> ConfirmOrderPayment` (construye `ConfirmOrderPayment(orders, consume, release, audit, clock)`).
  - Los dos corren en la transacción de quien los llama y no hacen commit.
- Pruebas obligatorias (las escribe qa-reviewer en `backend/tests/orders/`; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas): los dos proveedores contra la BD real con la **misma** sesión (preparar un pedido, `GetPayableOrder` devuelve su importe, `ConfirmOrderPayment` lo paga y baja `on_hand`); las suites de orders sin cambios; `wiring.py` no importa `orders.adapters.http` ni el dominio ni los adaptadores de otro módulo (solo `application`, `adapters/wiring` de inventory y `AuditRecorderDep`).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): ninguna visible; el Leader enseña la suite completa en verde.
- Seguridad: sin rutas y sin identidad propia; el `user_id` lo reciben los casos de uso de quien los llama.
- Estado inicial: READY.
- Entrega: cambio preparado sin commit (`git add <rutas>`) y mensaje propuesto en el punto 12, p. ej. `feat(orders): proveedores del puerto de pago para payments (T-091)`; qa-reviewer lo verifica y el Leader hace el commit (§11.2, D-033, D-036).
- IDs reservados: ninguno.
- Escalar si: un proveedor exige cambiar `application.py` de orders, o hay un import circular con `adapters/http.py`.

### T-092 — Dominio de payments, puertos y adaptador simulado
- Objetivo: el intento, el método de pago, los errores, el puerto de pasarela, el de repositorio y la pasarela simulada de R12, comprobables sin BD.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: payments · Requisitos: RF05.01, RF05.04 · Reglas: PAYMENTS-R1, R7, R9 (`attempts_left`), R11, R12 · Decisiones: D-041 (P-4), D-033
- Leer: `docs/modules/payments/SPEC.md` §4 (R1, R7, R9, R11, R12), §5 y §7; `backend/src/valmont/modules/orders/application.py` (`PayableOrder`, `PaymentOutcome`, `GetPayableOrder`, `ConfirmOrderPayment`: solo para saber qué importar); `modules/orders/domain.py` (estilo: `StrEnum`, dataclasses congeladas, errores); skill `backend-module-implementation`.
- Contratos aplicables: SPEC §5 (puerto de pasarela).
- Dependencias: SPEC aprobada, con las respuestas a P-1, P-2 y P-4 (o sus hipótesis).
- Puede modificar: `backend/src/valmont/modules/payments/__init__.py`, `domain.py`, `application.py` (**solo** dataclasses y `Protocol`; los casos de uso son de T-094 y T-095), `adapters/__init__.py` y `adapters/simulated_gateway.py` (todos nuevos) y su traspaso en este STATUS.
- Protegido: todo lo demás, en especial `modules/**` de otros módulos, `adapters/persistence.py`, `adapters/http.py`, `migrations/**`, `main.py`, `shared/`, `backend/tests/**`. Sin dependencias nuevas.
- Resultado esperado: `domain.py` sin `fastapi`, `pydantic`, `sqlalchemy` ni imports de otros módulos; `application.py` con sus puertos importando de orders solo `valmont.modules.orders.application`.
- Criterios de aceptación: la parte de dominio y de pasarela de CA-PAYMENTS-02 (tabla de R12), 07 (validación de `card_last4`), 09 (`attempts_left`), 12 y 18.
- Firmas públicas (contra las que escribe QA; no se cambian sin avisar):
  - `valmont.modules.payments.domain`:
    - Constantes: `MAX_REJECTED_ATTEMPTS = 5`, `GATEWAY_SIMULATED = "simulated"`.
    - `class AttemptStatus(StrEnum)`: `APPROVED = "approved"`, `REJECTED = "rejected"`.
    - `class FailureCode(StrEnum)`: `CARD_DECLINED = "card_declined"`, `INSUFFICIENT_FUNDS = "insufficient_funds"`, `EXPIRED_CARD = "expired_card"`, `ORDER_EXPIRED = "order_expired"`.
    - `@dataclass(frozen=True) PaymentMethod(card_last4: str)`: en `__post_init__` exige `^[0-9]{4}$` (4 caracteres exactos; espacios, `\n` y letras no pasan) y si no lanza `InvalidPaymentMethod`.
    - `@dataclass(frozen=True) PaymentAttempt(id: UUID, order_id: UUID, user_id: UUID, idempotency_key: str, status: AttemptStatus, amount: int, failure_code: FailureCode | None, card_last4: str, gateway: str, created_at: datetime | None = None)`: `__post_init__` valida `amount ≥ 1`, `(status is REJECTED) == (failure_code is not None)`, clave 16–64 de `[A-Za-z0-9_-]`, `card_last4` de 4 dígitos y `gateway` de 1–30 caracteres; lanza `ValueError` (sin el valor en el mensaje).
    - `new_attempt(*, attempt_id: UUID, order_id: UUID, user_id: UUID, idempotency_key: str, amount: int, method: PaymentMethod, gateway: str, failure_code: FailureCode | None) -> PaymentAttempt` (`APPROVED` si `failure_code is None`, si no `REJECTED`).
    - `attempts_left(rejected_count: int) -> int` (`max(0, MAX_REJECTED_ATTEMPTS - rejected_count)`).
    - Errores: `PaymentError(Exception)`, `InvalidPaymentMethod(PaymentError, ValueError)`, `OrderAlreadyPaid(PaymentError)`, `TooManyAttempts(PaymentError)` con atributo `max_attempts: int`, `IdempotencyKeyReused(PaymentError)`, `GatewayUnavailable(PaymentError)`.
  - `valmont.modules.payments.application` (solo tipos):
    - `@dataclass(frozen=True) GatewayCharge(reference: UUID, amount: int, method: PaymentMethod)`.
    - `@dataclass(frozen=True) GatewayResult(failure_code: FailureCode | None)` con la propiedad `approved: bool`.
    - `class PaymentGateway(Protocol)`: atributo `name: str`; `authorize(self, charge: GatewayCharge) -> GatewayResult` (puede lanzar `GatewayUnavailable`).
    - `class PaymentAttemptRepository(Protocol)`:
      - `add(self, attempt: PaymentAttempt) -> PaymentAttempt | None`: inserta; devuelve el intento con `created_at` de la BD, o `None` si `(user_id, idempotency_key)` ya existe; una violación del índice de un solo `approved` por pedido lanza `OrderAlreadyPaid`; no hace commit.
      - `find_by_key(self, user_id: UUID, key: str) -> PaymentAttempt | None`.
      - `list_for_order(self, user_id: UUID, order_id: UUID) -> tuple[PaymentAttempt, ...]`: solo los del dueño, `created_at desc, id desc`.
      - `count_rejected(self, user_id: UUID, order_id: UUID) -> int`: intentos `rejected` del dueño **sin** contar `order_expired`.
    - `@dataclass(frozen=True) PaymentResult(attempt: PaymentAttempt, created: bool)`.
    - `@dataclass(frozen=True) OrderPayments(order: PayableOrder, attempts: tuple[PaymentAttempt, ...], can_pay: bool, attempts_left: int)` (`PayableOrder` de `orders.application`).
  - `valmont.modules.payments.adapters.simulated_gateway`: `SimulatedGateway()` con `name = "simulated"` y `authorize` según R12: `0002` → `GatewayResult(CARD_DECLINED)`, `9995` → `INSUFFICIENT_FUNDS`, `0069` → `EXPIRED_CARD`, `0119` → lanza `GatewayUnavailable`, el resto → `GatewayResult(None)`; sin azar, sin reloj, sin E/S.
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, capas): `PaymentMethod` (`4242`, `0002`; 3 y 5 dígitos, letras, espacios, `\n`, `"4242 4242 4242 4242"`, vacío → error); invariantes de `PaymentAttempt` (cada una); `new_attempt` aprobado y rechazado; `attempts_left` (0, 4, 5, 6, 100); la tabla completa de `SimulatedGateway` (cuatro especiales y un puñado de tarjetas que aprueban), determinismo (misma entrada, mismo resultado) y que `0119` lanza; ningún mensaje de error contiene el valor recibido; capas (`domain.py` sin `fastapi`, `pydantic`, `sqlalchemy` ni otros módulos; `application.py` solo importa de orders `valmont.modules.orders.application`).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): ninguna visible (dominio puro).
- Seguridad: validación del único dato de tarjeta en el dominio (R7); mensajes de error sin el dato.
- Estado inicial: BACKLOG → READY al aprobar la SPEC.
- Entrega: como T-091; mensaje propuesto `feat(payments): dominio, puerto de pasarela y pasarela simulada (T-092)`.
- IDs reservados: ninguno.
- Escalar si: una regla de §4 es ambigua o contradice una decisión, o hace falta importar el dominio de otro módulo.

### T-093 — Migración `0011`, fila y repositorio SQL
- Objetivo: la tabla `app.payment_attempts` existe con todas sus restricciones y permisos, y el repositorio guarda y lee intentos sin carreras.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: payments · Requisitos: RF05.01, RF05.02, RF05.03, RF05.04 · Reglas: PAYMENTS-R1, R3, R7, R9, R10 · Decisiones: D-010, D-029, D-033
- Leer: SPEC §4 (R3, R9, R10) y §6; skills `backend-module-implementation` y `database-migration-review`; `backend/migrations/versions/0010_orders.py` (CHECK, FK, `op.f`, `GRANT`, `downgrade`) y `0006_app_role.py`; `modules/orders/adapters/persistence.py` (filas, `pg_insert … on_conflict_do_nothing`, traducción de `IntegrityError`); `modules/cart/adapters/persistence.py` (`InvalidReference`); `backend/src/valmont/shared/db.py` (`Base`, `NAMING_CONVENTION`) y `backend/migrations/env.py`.
- Contratos aplicables: SPEC §6 (esquema exacto) y las firmas de `PaymentAttemptRepository` de T-092.
- Dependencias: T-092; E-P2 registrada en `modules.md` §3; `0010` y T-016 (perfiles) integradas.
- Puede modificar: `backend/src/valmont/modules/payments/adapters/persistence.py` (nuevo), `backend/migrations/env.py` (solo la línea de registro de `valmont.modules.payments.adapters.persistence`), `backend/migrations/versions/0011_payments.py` (nuevo, `--rev-id 0011`, `down_revision = "0010"`) y su traspaso en este STATUS.
- Protegido: `domain.py` y `application.py` de payments (de T-092: si falta algo, se escala), el resto de `modules/**`, `main.py`, `shared/`, `backend/tests/**`. Sin endpoints. Sin dependencias nuevas.
- Resultado esperado: migración `0011` exactamente como §6 con su `downgrade` y su `GRANT SELECT, INSERT … TO valmont_app`; `PaymentAttemptRow`; `SqlPaymentAttemptRepository(session)` que convierte filas en `PaymentAttempt`.
- Criterios de aceptación: CA-PAYMENTS-15 (esquema, restricciones, índice parcial, permisos, `bigint`), la parte de repositorio de CA-PAYMENTS-03 (`ON CONFLICT DO NOTHING` devuelve `None`) y de CA-PAYMENTS-09 y CA-PAYMENTS-11 (`count_rejected` sin `order_expired`, orden de `list_for_order`).
- Firmas públicas (contra las que escribe QA; no se cambian sin avisar):
  - `valmont.modules.payments.adapters.persistence`: `PaymentAttemptRow` (tabla `app.payment_attempts`, columnas y nombres de §6), `SqlPaymentAttemptRepository(session: Session)` que implementa `PaymentAttemptRepository` de T-092 al pie de la letra.
  - `add`: `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING created_at`; sin fila devuelta → `None`; un `IntegrityError` del índice único parcial `uq_payment_attempts_order_approved` → `OrderAlreadyPaid`; otro error de integridad se propaga.
  - BD: tabla, columnas, `CHECK`, `UNIQUE`, índice parcial y FK con los nombres de §6 (convención `NAMING_CONVENTION`).
- Pruebas obligatorias (las escribe qa-reviewer; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check` y `downgrade -1` + `upgrade head`): cada `CHECK` (estado fuera de lista, `rejected` sin `failure_code` y `approved` con él, `card_last4` de 3, 5 y 16 dígitos o con letras, importe 0 y negativo, clave de 15 y 65 caracteres, `failure_code` con mayúsculas), `UNIQUE (user_id, idempotency_key)`, el segundo `approved` del mismo pedido (rechazado) y dos `rejected` (permitidos), FK `RESTRICT` a pedidos y perfiles, importe por encima de 2³¹; con el rol `valmont_app`: `SELECT` e `INSERT` funcionan, `UPDATE` y `DELETE` fallan (y `test_app_role` cubre la tabla); `add` (ida y vuelta de todos los campos, `None` en la clave repetida, `OrderAlreadyPaid` en el segundo aprobado), `find_by_key`, `list_for_order` (orden, solo del dueño, ajeno vacío), `count_rejected` (rechazos sí, `order_expired` y aprobados no, ajeno 0); dos conexiones insertando la misma clave: una inserta y la otra recibe `None`.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): `uv run alembic current` indica `0011`; en Supabase Studio local (solo lectura) aparece `app.payment_attempts` sin filas, con sus restricciones y sin columnas de número, titular, vencimiento ni CVV.
- Seguridad: SQL parametrizado; el repositorio recibe `user_id` solo como filtro de dueño; permisos mínimos (sin `UPDATE` ni `DELETE`); las restricciones de la BD son la última defensa de RF05.04 y del cobro único.
- Estado inicial: BACKLOG.
- Entrega: como T-091; mensaje propuesto `feat(payments): esquema 0011 y repositorio de intentos de pago (T-093)`.
- IDs reservados: ninguno.
- Escalar si: hace falta otra tabla o columna, leer tablas de otro módulo, o `ON CONFLICT DO NOTHING … RETURNING` no se puede expresar con el ORM.

### T-094 — Pagar un pedido y `POST /payments/orders/{order_id}/attempts`
- Objetivo: el cliente paga su pedido pendiente con una tarjeta simulada, de forma idempotente, y el pedido queda pagado o el intento rechazado, sin datos de tarjeta en el servidor.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: payments · Requisitos: RF05.01, RF05.02, RF05.03, RF05.04 · Reglas: PAYMENTS-R2…R13, R15 · Decisiones: D-016, D-017, D-040, D-041
- Leer: SPEC §3 (UC-01, UC-04), §4 (R2…R13, R15) y §7 (`POST`, "Pagar"); `modules/orders/application.py` (`GetPayableOrder`, `ConfirmOrderPayment`, `PayableOrder`, `PaymentOutcome`, `OrderNotFound`, `OrderNotPayable`, `OrderStatus`); `modules/orders/adapters/http.py` (`IdempotencyKey`, `_conflict`, esquemas `Money`, `ERROR_RESPONSES`, 404 por `OrderNotFound`) y `adapters/wiring.py` de T-091; `modules/audit/adapters/http.py`; `modules/identity/adapters/http.py` (`current_user`); `backend/src/valmont/main.py`; el código de T-091…T-093.
- Contratos aplicables: SPEC §7 (PROPUESTO; el desarrollo empieza con la aprobación de backend-lead y frontend-lead).
- Dependencias: T-091 y T-093 integradas.
- Puede modificar: `modules/payments/application.py` (`PayOrder`; los tipos de T-092 solo para leerlos), `adapters/http.py` (nuevo: router `/api/v1/payments`, `PayOrderIn`, `PaymentAttemptOut`, errores, proveedores), `backend/src/valmont/main.py` (solo registrar el router) y su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py`, `adapters/simulated_gateway.py` y `migrations/**` (de T-092/T-093: si falta algo, se escala), el resto de módulos (incluido orders, salvo lo que ya exista en su `wiring.py`), `shared/`, `backend/tests/**`. Payments no importa nada del `domain` ni de los `adapters/persistence` de orders (solo `orders.application` y `orders.adapters.wiring`).
- Resultado esperado: `PayOrder` sigue exactamente R3…R6, R9, R10 y R13: (1) `find_by_key` → repetición o `IdempotencyKeyReused`; (2) `GetPayableOrder` (`OrderNotFound` pasa) y la tabla de R5 (`OrderNotPayable(status)` para `cancelado`/`expirado`, `OrderAlreadyPaid` para el resto que no es `pendiente_pago`); (3) `count_rejected ≥ MAX_REJECTED_ATTEMPTS` → `TooManyAttempts`; (4) `PaymentGateway.authorize(GatewayCharge(attempt_id, total, method))` (`GatewayUnavailable` pasa); (5) si aprobó, `ConfirmOrderPayment`: `PAID` → aprobado, `EXPIRED` → rechazado `order_expired`, `ALREADY_PAID` → buscar la clave y devolver o `OrderAlreadyPaid`; (6) `new_attempt` y `add` (si `None`, `find_by_key` y devolver con `created=False`); (7) auditoría `payments.attempt_recorded` solo si `created`. `POST` con `current_user` y `AuditRecorderDep`; 201 si `created`, 200 si no; `Cache-Control: no-store`; los errores se traducen a §7 (`order_not_payable` con `details {"status"}`, `order_already_paid`, `too_many_attempts` con `details {"max"}`, `idempotency_key_reused`, `payment_gateway_unavailable` 503, `not_found` 404). Un rechazo y `order_expired` son 2xx. `PayOrderIn` con `extra="forbid"` y `card_last4` de patrón `^[0-9]{4}$`; nunca se registra ni se devuelve el cuerpo.
- Criterios de aceptación: CA-PAYMENTS-01…10, 12 (con pasarela falsa), 13, 14, 16, 18 y la parte de `POST` de 08.
- Firmas públicas:
  - `valmont.modules.payments.application`: `class PayOrder`: `__init__(self, attempts: PaymentAttemptRepository, gateway: PaymentGateway, get_payable: GetPayableOrder, confirm: ConfirmOrderPayment, audit: AuditRecorder)`; `__call__(self, user_id: UUID, order_id: UUID, idempotency_key: str, method: PaymentMethod) -> PaymentResult`; lanza `OrderNotFound`, `OrderNotPayable`, `OrderAlreadyPaid`, `TooManyAttempts`, `IdempotencyKeyReused`, `GatewayUnavailable`.
  - `valmont.modules.payments.adapters.http`: `router` (`APIRouter(prefix="/api/v1/payments")`); `PayOrderIn(card_last4: str)`; `PaymentAttemptOut(id, order_id, status, failure_code, amount: Money, card_last4, created_at)`; proveedores `get_payment_attempts(session: SessionDep) -> PaymentAttemptRepository`, `get_payment_gateway() -> PaymentGateway` (devuelve `SimulatedGateway()`; **único** punto que nombra el adaptador, R11) y `get_pay_order(...) -> PayOrder`.
  - Ruta: `POST /api/v1/payments/orders/{order_id}/attempts` → 201/200 `PaymentAttemptOut`; cabecera `Idempotency-Key` obligatoria.
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-093): casos de uso con falsos (todo lo de SPEC §11 para `PayOrder`, con "ningún efecto" tras cada 409/503 y la auditoría exacta); integración con orders, inventory y cart reales (CA-01, 02, 06, 14, stock y reservas, rollback total); concurrencia con dos conexiones (CA-10 completo); HTTP (formas de §7, 401, 404 de otro cliente, 409 con `details`, 422 sin eco de valores, 503, `Cache-Control`); OpenAPI (`Idempotency-Key` obligatoria, errores declarados, sin ruta de reembolso); seguridad (campos de tarjeta en el cuerpo, número de prueba ausente de logs, auditoría, respuestas y tablas).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): con la sesión de desarrollo, `POST` desde `/docs` sobre un pedido de T-074: `card_last4 = 4242` → `approved` y el pedido pasa a `pagado`; con `0002` → `rejected` y el pedido sigue pendiente; repetir con la misma clave devuelve el mismo intento; la fila no tiene ningún dato de tarjeta salvo los 4 últimos.
- Seguridad: R7 y R8 al pie de la letra; sin eco, sin cuerpo en logs, identidad solo de la sesión, importe solo de orders.
- Estado inicial: BACKLOG → READY al integrar T-091 y T-093.
- Entrega: como T-091; mensaje propuesto `feat(payments): pagar un pedido con pasarela simulada, idempotente (T-094)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso, `EXPIRED` no se puede confirmar sin cambiar la transacción, aparece un interbloqueo con `ConfirmOrderPayment`, o payments necesita otro dato u operación de orders (proponer E-P3).

### T-095 — Consultar los intentos y `GET /payments/orders/{order_id}/attempts`
- Objetivo: el cliente ve los intentos de su pedido y si puede volver a pagar, con valores calculados por el servidor.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: payments · Requisitos: RF05.01, RF05.02 · Reglas: PAYMENTS-R8, R9, R15 · Decisiones: D-033
- Leer: SPEC §3 (UC-02), §4 (R8, R9, R15) y §7 (`GET`, "Listar"); el código de T-094.
- Contratos aplicables: SPEC §7.
- Dependencias: T-094.
- Puede modificar: `modules/payments/application.py` (`GetOrderPayments`), `adapters/http.py` (`OrderPaymentsOut`, `GET`, `get_get_order_payments`) y su traspaso en este STATUS.
- Protegido: lo demás de payments y de otros módulos, `main.py`, `migrations/**`, `backend/tests/**`.
- Resultado esperado: `GetOrderPayments`: `GetPayableOrder` (404 si ajeno o inexistente; expira el vencido) → `list_for_order` y `count_rejected` → `can_pay = status is PENDING_PAYMENT and attempts_left > 0` → `OrderPayments`. `Cache-Control: no-store`.
- Criterios de aceptación: CA-PAYMENTS-08 (parte `GET`), 09 (`attempts_left` y `can_pay`), 11, 16.
- Firmas públicas: `valmont.modules.payments.application.GetOrderPayments`: `__init__(self, attempts: PaymentAttemptRepository, get_payable: GetPayableOrder)`; `__call__(self, user_id: UUID, order_id: UUID) -> OrderPayments` (lanza `OrderNotFound`). `valmont.modules.payments.adapters.http`: `OrderPaymentsOut(order_id, can_pay, attempts_left, attempts: list[PaymentAttemptOut])`, `get_get_order_payments(...) -> GetOrderPayments`. Ruta `GET /api/v1/payments/orders/{order_id}/attempts` → 200 `OrderPaymentsOut`.
- Pruebas obligatorias (qa-reviewer): casos de uso con falsos (cada estado del pedido, tope, vacío); integración (orden, vencido expirado al leer); HTTP (aislamiento entre dos clientes, 404 indistinguible, 401, 422, OpenAPI).
- Diseño (frontend): no aplica. Revisión manual: `GET` desde `/docs` tras pagar y tras un rechazo. Seguridad: sin `user_id` ni `gateway` en la salida.
- Estado inicial: BACKLOG → READY al integrar T-094. Entrega como T-091; mensaje `feat(payments): consulta de intentos de un pedido propio (T-095)`. IDs reservados: ninguno. Escalar si: `can_pay` necesita un dato que orders no entrega.

### T-096 — Integración transversal y auditoría de seguridad de payments
- Objetivo: verificar de punta a punta CA-PAYMENTS-01…18 (salvo el E2E de CA-17) con la mentalidad de un atacante, y cerrar el backend de payments.
- Responsable: qa-reviewer, **con `model: "opus"`** (única escalada permitida, decisions.md); no escribe código de producción; los hallazgos se corrigen en tareas `fix` (T-099 y siguientes que reserve el Leader) · Módulo: payments · Requisitos: RF05.01…RF05.05
- Leer: SPEC completa; STATUS de orders (R-1, R-3, R-12, R-14) y los traspasos de T-091…T-095.
- Dependencias: T-091…T-095 integradas.
- Puede modificar: `backend/tests/payments/**`, `backend/tests/orders/**` solo para pruebas cruzadas y su traspaso aquí.
- Resultado esperado: veredicto con `comando → resultado`; ronda de seguridad sobre CA-07 (número de prueba y CVV en logs, auditoría, tablas, respuestas y trazas de 500), CA-08, CA-10 (pago contra cancelación y vencimiento con dos conexiones, mismas claves y claves distintas, caso residual R10) y CA-15 (permisos del rol de la aplicación); revisión de que ningún error 500 filtra el cuerpo; revisión de `Cache-Control`.
- Criterios de aceptación: ningún hallazgo crítico o mayor abierto; los menores quedan como `fix` o como riesgo aceptado en este STATUS.
- Pruebas obligatorias: todas las puertas de `testing-and-quality-gates` sobre `main` con T-095 integrada (`ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas, migración arriba y abajo).
- Seguridad: es la tarea de seguridad del módulo.
- Estado inicial: BACKLOG. Escalar si: aparece un hallazgo crítico (stock descontado sin pago o pago sin stock, número de tarjeta persistido o registrado).

### T-097 — Cliente de API de payments (frontend)
- Objetivo: la interfaz llama a payments solo desde `frontend/src/lib/api/payments.ts`, con tipos y errores del contrato.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader; coordina frontend-lead) · Módulo: payments (frontend) · Requisitos: RF05.01, RF05.02 · Decisiones: D-041 (P-4, P-5)
- Leer: SPEC §7 (contrato y "Consumo desde la interfaz"); `docs/design_ui/VIEWS.md` (checkout, H-12, P-4); `frontend/src/lib/api/` (cliente existente: errores, sesión, `orders.ts` si ya existe, T-081).
- Dependencias: T-094 y T-095 integradas; contrato §7 aprobado por backend-lead y frontend-lead.
- Puede modificar: `frontend/src/lib/api/payments.ts` (nuevo) y su traspaso aquí. Protegido: el resto de `lib/api/`, `pages/`, `components/`, `islands/`, `backend/**`, `frontend/tests/**`.
- Firmas públicas (contra las que escribe QA): `payOrder(orderId: string, idempotencyKey: string, cardLast4: string): Promise<PaymentAttempt & { created: boolean }>`; `getOrderPayments(orderId: string): Promise<OrderPayments>`; tipos `PaymentAttempt` (`id`, `orderId`, `status: "approved" | "rejected"`, `failureCode: "card_declined" | "insufficient_funds" | "expired_card" | "order_expired" | null`, `amount`, `cardLast4`, `createdAt`), `OrderPayments` (`orderId`, `canPay`, `attemptsLeft`, `attempts`) y los códigos de error de §7 como unión. **Ninguna función recibe ni acepta número de tarjeta, vencimiento ni CVV.**
- Pruebas obligatorias (qa-reviewer, `frontend/tests/**`): cliente contra respuestas simuladas (cada estado y error), que `payOrder` solo envía `card_last4` y `Idempotency-Key`, y `npm run check`.
- Estado inicial: BACKLOG (no READY: sin contrato aprobado ni backend). Entrega como T-091 (mensaje `feat(ui): cliente de API de pagos (T-097)`). Escalar si: el contrato cambia o la sesión SSR (T-127) no reenvía el token.

### T-098 — Pantalla de pago (la `T-082b` de la pista `ui`)
- Objetivo: el cliente paga su pedido con el formulario de tarjeta del diseño, que solo existe en el navegador, y ve el resultado y los estados de error.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader; coordina frontend-lead) · Módulo: payments (frontend) · Requisitos: RF05.01, RF05.02, RF05.04 · Decisiones: D-041 (P-4, P-5)
- Leer: SPEC §4 (R7), §7 ("Consumo desde la interfaz") y §10 (CA-PAYMENTS-17); `docs/design_ui/VIEWS.md` (checkout `43:386`…`43:459`, confirmación `43:516`…, detalle de pedido y H-12, H-14); componentes `ui/` existentes (`Field`, `Notice`, `Button`, `Stepper`, `OrderSummary`, `PaymentFields`).
- Dependencias: T-097; T-082a (checkout y pedido pendiente); T-111 y los componentes de `ui/`; P-3 y P-5 respondidas.
- Puede modificar: `frontend/src/components/checkout/PaymentFields.*` e isla de pago, la página de pago o la sección de pago de `/checkout` (la fija frontend-lead), y su traspaso aquí. Protegido: `lib/api/` salvo `payments.ts` (T-097), `backend/**`, `frontend/tests/**`, `frontend/e2e/**`.
- Resultado esperado: formulario con número, vencimiento y CVV **solo en el cliente**: validación en el navegador (Luhn, vencimiento, longitud del CVV), `card_last4` derivado y enviado; campos sin atributo `name`, `autocomplete` estándar (`cc-number`, `cc-exp`, `cc-csc`), el formulario no se envía de forma nativa y se limpia tras cada envío; clave `crypto.randomUUID()` por pulsación (la misma ante doble clic o reintento tras un corte); estados cargando, aprobado (confirmación), rechazado (mensaje por `failure_code` según P-3, formulario de nuevo si `can_pay`), pedido vencido o cancelado (409), pedido ya pagado, 503 y sin sesión; el botón "Pagar" del detalle de pedido pendiente reutiliza la misma sección.
- Criterios de aceptación: CA-PAYMENTS-17 y la revisión de `docs/design_ui/DESIGN.md` §9 con captura de Playwright frente al frame.
- Pruebas obligatorias (qa-reviewer): E2E (CA-17: intercepción de red de todos los métodos, URL y cuerpos; almacenamiento y cookies; doble clic; aprobado, rechazado, vencido); axe sobre el formulario; `npm run check`.
- Seguridad: ni el número ni el CVV salen del navegador ni se guardan (almacenamiento, analítica, `console`, URL); no hay `GET` con campos de tarjeta si falla el JavaScript.
- Estado inicial: BACKLOG (no READY: sin diseño de pago cerrado ni backend integrado). Entrega como T-091 (`feat(ui): pantalla de pago simulado sin datos de tarjeta en el servidor (T-098)`). Escalar si: el diseño exige enviar más datos de la tarjeta, o frontend-lead propone dividir la tarea (usar T-099).

## Traspasos

#### Traspaso T-099 — 2026-11-27 — backend-dev

1. Tarea: T-099, corrección de CRÍTICO-1 de T-096 (misma clave, tarjetas distintas: cobro confirmado con intento ajeno reproducido).
2. Estado: IN_REVIEW (a la espera de QA).
3. Hecho: (a) `PayOrder` toma `lock_key(user_id, key)` al principio, antes de `find_by_key` y de cualquier bloqueo de fila; (b) si `add` devuelve `None` tras haber confirmado `PAID` en esta petición, lanza `IdempotencyKeyReused` (409) y la ruta hace rollback (`_fail`): se deshacen confirmación, consumo y venta. Solo se reproduce si esta petición no confirmó.
4. Archivos: `modules/payments/application.py`, `modules/payments/adapters/persistence.py`. `http.py` sin cambios (error existente).
5. Firma nueva: `PaymentAttemptRepository.lock_key(user_id: UUID, key: str) -> None`. SQL: `pg_advisory_xact_lock(hashtextextended('payments:<user>:<key>', 0))`, parametrizado. Las demás firmas no cambian. AVISO a QA: los fakes de `PaymentAttemptRepository` en `backend/tests/payments/` necesitan `lock_key`.
6. Por qué CRÍTICO-1 ya no ocurre: R y A con la misma clave se serializan en `lock_key`; A espera hasta que R confirma o revierte, luego `find_by_key` ve el intento de R y lo reproduce sin cobrar ni confirmar. Si el bloqueo fallara, A solo confirma `PAID` y luego `add` da `None`: se lanza 409 y rollback, nunca se responde `rejected` con el pedido pagado.
7. Interbloqueos: el bloqueo consultivo es siempre el primero de la transacción y no se retiene a la espera de otro bloqueo consultivo; el orden posterior (pedido, reservas, stock) es el de T-094. Una petición con otra clave no lo toma. Se libera solo al terminar la transacción, también con rollback.
8. Análisis estático: `uv run ruff format .` → 265 files left unchanged; `uv run ruff check .` → All checks passed!; `import valmont.main` → OK; comprobación de capas → vacía.
9. NO EJECUTADO: pruebas (D-028, D-033). Pendiente de QA: `test_t096_races.py` (4 casos en rojo) y pruebas de `lock_key`.
10. Riesgos: ninguno conocido. Sin migración, sin dependencias.
12. Commit: ninguno — preparado. Mensaje propuesto: `fix(payments): serializar pagos con la misma clave y no reutilizar intentos tras cobrar (T-099)`.

#### Traspaso T-095 — 2026-11-27 — backend-dev

1. Tarea: T-095, `GetOrderPayments` y `GET /api/v1/payments/orders/{order_id}/attempts`.
2. Estado: IN_REVIEW (a la espera de QA).
3. Hecho: `GetOrderPayments` (`GetPayableOrder` -> `count_rejected` y `list_for_order` -> `can_pay = PENDING_PAYMENT and attempts_left > 0`); `OrderPaymentsOut`, `get_get_order_payments` y la ruta `GET`, con `no-store`; 404 uniforme con rollback (`_fail`).
4. Archivos: `modules/payments/application.py`, `modules/payments/adapters/http.py`.
5. Firmas: las del paquete, sin cambios. `main.py` no se toca (router ya registrado).
6. Decisiones: sin `user_id` ni `gateway` en la salida; `card_last4` se devuelve (D-043); sin registro de `card_last4`; la expiración perezosa de `GetPayableOrder` se confirma al terminar la solicitud con 200.
7. Evidencia: `ruff format .` -> 259 files left unchanged; `ruff check .` -> All checks passed; OpenAPI del GET declara 200/401/404/422; capas vacías. NO EJECUTADO: pruebas (D-028, D-033).
8. Riesgos: ninguno nuevo; `no-store` en 401/422 sigue pendiente (transversal, T-094).

#### Traspaso T-094 — 2026-11-27 — backend-dev

1. Tarea: T-094, `PayOrder` y `POST /api/v1/payments/orders/{order_id}/attempts`.
2. Estado: IN_REVIEW (a la espera de QA).
3. Hecho: `PayOrder` en el orden find_by_key, GetPayableOrder, R5, tope, pasarela, ConfirmOrderPayment, `add` tras confirmar, auditoría solo si `created`; ruta con `PayOrderIn` (`extra="forbid"`, `^[0-9]{4}$`), `PaymentAttemptOut`, proveedores y errores de §7; router registrado.
4. Archivos: `modules/payments/application.py`, `modules/payments/adapters/http.py` (nuevo), `main.py` (import y `include_router`).
5. Firmas: las del paquete, sin cambios.
6. Decisiones: errores 404/409/503 como `JSONResponse` con `Cache-Control: no-store` (un `AppError` no lleva cabeceras); 401/422 de FastAPI y `auth_unavailable` no llevan `no-store`. `OrderAlreadyPaid` de `add` sube a 409. `IdempotencyKeyReused` si `add` da `None` y la clave ya no se encuentra.
7. Evidencia: `ruff format --check .` y `ruff check .` limpios; app importa, OpenAPI declara 201/200/401/404/409/422/503; capas vacías. NO EJECUTADO: pruebas (D-028, D-033).
8. Ajuste del Leader (E-P4): `orders/application.py` declara `__all__ = ["OrderNotFound", "OrderNotPayable", "OrderStatus"]` y payments importa las tres solo de `orders.application`. Pendiente transversal: `no-store` en 401/422 (middleware, R-14 de orders).
8b. Corrección de QA: `_fail` hace `session.rollback()` antes de devolver 404/409/503 (`SessionDep` confirmaría); verificado que el `begin()` de la sesión tolera el rollback previo.
9. Riesgos: `no-store` en 401/422 requeriría un middleware (transversal); el conteo de rechazos es blando (R9).
#### Traspaso T-093 — 2026-11-27 — backend-dev

1. Tarea: T-093, migración `0011`, fila y repositorio SQL de intentos de pago.
2. Estado: IN_REVIEW (a la espera de QA).
3. Hecho: `0011_payments.py` (tabla, 7 CHECK, FK RESTRICT, UNIQUE, índice parcial `uq_payment_attempts_order_approved`, índice de listado, `GRANT SELECT, INSERT`, downgrade); `PaymentAttemptRow` y `SqlPaymentAttemptRepository`; registro en `migrations/env.py`.
4. Archivos: `backend/migrations/versions/0011_payments.py`, `backend/src/valmont/modules/payments/adapters/persistence.py`, `backend/migrations/env.py` (una línea).
5. Decisiones: `add` usa `pg_insert ... on_conflict_do_nothing(index_elements=[user_id, idempotency_key]).returning(created_at)` (sí se expresa con el ORM); `IntegrityError` con `uq_payment_attempts_order_approved` -> `OrderAlreadyPaid`, el resto se relanza. Sin permisos sobre secuencias (no hay identidad).
6. Estático: `ruff format .` -> 241 files left unchanged; `ruff check .` -> All checks passed; `import valmont.main` -> OK.
7. Migración local: `alembic upgrade head` -> 0010 -> 0011; `alembic check` -> No new upgrade operations detected; `downgrade -1` + `upgrade head` -> OK; `alembic current` -> 0011 (head).
8. NO EJECUTADO: pruebas (D-028, D-033). `test_app_role` debe incluir `payment_attempts: {SELECT, INSERT}` (es de QA).
9. Riesgos: tras `IntegrityError` la sesión queda abortada: el caso de uso (T-094) debe terminar la transacción con `OrderAlreadyPaid`.
10. Discrepancias: ninguna.
11. Siguiente: QA escribe y ejecuta las pruebas.
12. Commit: ninguno, preparado. Mensaje propuesto: `feat(payments): esquema 0011 y repositorio de intentos de pago (T-093)`.

#### Traspaso T-091 y T-092 — 2026-11-27 — backend-dev
1. Estado final: IN_REVIEW (ambas). Sin commit.
2. Cambios: T-091 `orders/adapters/wiring.py` con `get_get_payable_order` y `get_confirm_order_payment` (firmas del paquete; construyen con `SqlOrderRepository`, `SqlClock`, inventory y `AuditRecorderDep`; sin commit). T-092 dominio, puertos y `SimulatedGateway` (D-043 sobre `card_last4`).
3. Archivos: `backend/src/valmont/modules/orders/adapters/wiring.py`; `backend/src/valmont/modules/payments/{__init__,domain,application}.py`, `adapters/{__init__,simulated_gateway}.py`; este STATUS.
4. Decisiones: ninguna. `TooManyAttempts(max_attempts=5)` por defecto; `InvalidPaymentMethod` y `ValueError` sin el valor en el mensaje; regex con `fullmatch` (`\n` final no pasa).
5. Evidencia: `uv run ruff format --check . → 232 files already formatted`; `uv run ruff check . → All checks passed!`; import de `valmont.main` y de ambos módulos → ok; capas (grep) → vacío. NO EJECUTADO: pruebas (D-028, D-033).
6. Riesgos: `orders.adapters.wiring` importa `audit.adapters.http` (como pide el paquete); sin pruebas de BD hasta QA.
7. Siguiente: qa-reviewer verifica; T-093 (migración y repositorio).

#### Traspaso T-090 — 2026-11-27 — module-coordinator
1. Estado final: IN_REVIEW. SPEC y STATUS propuestos; no hay código.
2. Cambios: `docs/modules/payments/SPEC.md` (alcance, 5 UC, 15 reglas PAYMENTS-R1…R15, dominio, `0011`, contrato API, puerto de pasarela, 18 CA, plan de pruebas con ronda Opus) y este STATUS (plan T-091…T-098, paquetes completos de T-091…T-094, resumidos de T-095…T-098).
3. Archivos: `docs/modules/payments/SPEC.md`, `docs/modules/payments/STATUS.md` (preparados con `git add`, sin commit).
4. Decisiones tomadas: ninguna. Hipótesis conservadoras P-1…P-6 en SPEC §12; propuestas E-P1…E-P5 en SPEC §8 y arriba.
5. Pruebas ejecutadas: ninguna (solo documentación). Cobertura RF: `grep` de RF05.01…RF05.05 en la SPEC (ver el traspaso final).
6. No ejecutado: todo lo demás (no hay código).
7. Dependencias pendientes: aprobación del alcance (Leader) y del contrato §7 (backend-lead, frontend-lead); respuestas de P-1…P-6; E-P2 registrada antes de T-093.
8. Riesgos: ver abajo (R-1…R-9).
9. Preguntas que requieren decisión: SPEC §12 (P-1…P-6).
10. Documentación actualizada: solo `docs/modules/payments/**`.
11. Siguiente acción: el Leader aprueba o ajusta la SPEC, pregunta P-1…P-6 al usuario y lanza T-091 (READY) en paralelo con T-092.
12. Commits: ninguno — preparado; mensaje propuesto `docs(payments): SPEC y plan del módulo (T-090)`.

## Discrepancias y riesgos

**Discrepancias detectadas (registradas, no resueltas):**
- `modules.md` §3 da a payments solo `orders` como dependencia; el flujo usa también `audit` e `identity` (E-P2).
- `VIEWS.md` H-12 y P-4 dicen "definir con backend-lead la pasarela simulada": queda propuesta en la SPEC (§7) y falta que frontend-lead cierre el diseño del formulario.
- `requirements.md`: RF05.01…RF05.04 siguen `PROPUESTO` (RF05.05 ya está `APROBADO` y es de orders de hecho, D-040 E-3). Quedan con la SPEC hasta que el Leader la apruebe.
- `docs/modules/ui/STATUS.md` llama `T-082b` a la pantalla de pago; aquí es **T-098** (rango de payments). Hace falta una nota cruzada en la pista `ui`.
- D-041 P-4 dice que "el número y el CVV nunca salen del navegador"; la SPEC propone enviar `card_last4` (P-1): no es el número, pero sale del navegador. Lo confirma el usuario.

**Riesgos:**
- **R-1 (dinero y stock):** carreras entre pago, cancelación y vencimiento. Mitigadas por el bloqueo del pedido de `ConfirmOrderPayment` y el orden fijo (R10), y por el índice de un solo `approved` por pedido; se comprueban en CA-10 y en la auditoría final con Opus (T-096). Hereda R-1 de orders.
- **R-2 (reloj y vencimiento):** `now()` de la BD es la hora de inicio de la transacción (R-3 de orders): un pago puede confirmarse milisegundos tras el vencimiento; INVENTORY-R11 protege el stock. Un 409 deshace la materialización del vencimiento (R-12 de orders); se guarda en la siguiente lectura.
- **R-3 (simulador):** el cliente elige el resultado con `card_last4`; no hay dinero en juego. Con un proveedor real: (a) cambia el cuerpo de la solicitud (token), (b) el flujo "cobrar y luego bloquear el pedido" podría cobrar y descubrir `ALREADY_PAID`: antes hace falta E-P3 (`lock`) o un flujo con intento `pending`, y (c) se necesitan `pending`, webhooks y conciliación. Está acotado por R11, no resuelto.
- **R-4 (transversal, R-14 de orders):** sin `nosniff`, sin límite de tamaño de cuerpo y sin limitador de frecuencia; payments pone `Cache-Control: no-store` por su cuenta y limita los rechazos por pedido (R9), nada más. Va al endurecimiento del backend antes del lanzamiento.
- **R-5 (interbloqueo residual):** misma clave y distinto `card_last4` en dos solicitudes simultáneas (error del cliente) puede abortar una con 500; sin corrupción de datos y el reintento devuelve lo guardado (R10).
- **R-6 (tope blando):** el límite de rechazos por pedido se cuenta sin bloqueo y puede pasarse en uno bajo concurrencia; exacto solo con E-P3.
- **R-7 (dato de tarjeta truncado):** `card_last4` es un dato permitido por PCI DSS, pero es dato de pago: sin él en logs ni auditoría; si el usuario responde P-4 con B, se elimina la columna.
- **R-8 (simulador en producción):** el MVP lanza con pagos simulados (RN-11); antes de un lanzamiento comercial hay que sustituir el adaptador (R11) o dejar visible que el pago es de demostración. Decisión del usuario fuera de este módulo.
- **R-9 (acoplamiento accidental con orders):** payments importa `OrderStatus`, `OrderNotFound` y `OrderNotPayable` por `orders.application`, donde solo están por un `import` (E-P4); un refactor de ese archivo podría quitarlos. La prueba de capas de T-091/T-092 lo detecta.
- **R-10 (QA de T-093, para T-096):** con `sqlalchemy.engine` en DEBUG, SQLAlchemy vuelca las filas leídas, `card_last4` incluido, aunque `hide_parameters=True`. El motor de producción no usa DEBUG; T-096 lo comprueba y, si hace falta, fija el nivel del logger `sqlalchemy.engine` a WARNING en `shared/logging`.
- **R-11 (QA de T-094):** `Cache-Control: no-store` es obligatorio en las respuestas de la propia ruta (201, 200, 404, 409, 503). Las 401 y 422 que genera el framework lo recibirán del middleware transversal del endurecimiento (R-14 de orders), no de payments.
