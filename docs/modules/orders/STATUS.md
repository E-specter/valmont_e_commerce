# orders — Estado
> Fase: 4 · Estado del módulo: SPECIFICATION (SPEC PROPUESTA; pendiente de la aprobación del contrato §7 por backend-lead y frontend-lead; las preguntas de negocio y las propuestas E-1…E-3 quedaron resueltas en D-040, con el recojo en tienda como hipótesis H-1…H-6 de la SPEC §12) · Última actualización: 2026-11-26 module-coordinator

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-070 | SPEC de orders | module-coordinator | RF04, RF11.01, RF12, RF13.03, D-015…D-017, D-022, D-023, D-037, D-038 | DONE (aprobada por el Leader el 2026-11-26, D-040) |
| T-071 | Costuras entre módulos (`wiring.py` de cart e inventory, `InsufficientStock` reexportada) y configuración de la boutique en `Settings` | backend-dev + qa-reviewer | excepción (7) (E-1, D-040) registrada en `modules.md` §3 | DONE (09cda5f) |
| T-072 | Dominio puro de orders: estados, transiciones, entrega, pedido y funciones | backend-dev + qa-reviewer | T-070 aprobada | DONE (09cda5f) |
| T-073 | Migración `0010`, filas y repositorio SQL (incluido el reloj de la BD y la caducidad) | backend-dev + qa-reviewer | T-072; E-2 registrada; T-016, T-026 integradas | DONE (3194a85) |
| T-074 | Crear pedido (`CreateOrder`) y `POST /orders` | backend-dev + qa-reviewer | T-071, T-073; cart (T-059), inventory (T-042), promotions (T-051) integradas | DONE (d9682c6) |
| T-075 | Lectura propia y caducidad (`ExpireOverdueOrders`, `ListMyOrders`, `GetMyOrder`) y 2 `GET` | backend-dev + qa-reviewer | T-074 | DONE (ca7a40a) |
| T-076 | Cancelar el pedido propio (`CancelMyOrder`) y `POST /orders/{id}/cancel` | backend-dev + qa-reviewer | T-075 | DONE (780a33e) |
| T-077 | Puerto para payments: `GetPayableOrder` y `ConfirmOrderPayment` | backend-dev + qa-reviewer | T-075 | DONE (39c503a) |
| T-078 | Administración: listado y detalle (`ListAdminOrders`, `GetAdminOrder`) y 2 `GET` | backend-dev + qa-reviewer | T-075 | DONE (b31df9e) |
| T-079 | Administración: transiciones y cancelación con reembolso simulado (`TransitionOrder`) y `POST …/transitions` | backend-dev + qa-reviewer | T-078 | READY |
| T-080 | Integración transversal y revisión de seguridad del backend de orders | qa-reviewer (con Opus en la ronda final, decisions.md) | T-074…T-079 | BACKLOG |
| T-081 | Cliente de API de orders (`frontend/src/lib/api/orders.ts`) y tipos | frontend-dev + qa-reviewer | contrato §7 aprobado; T-074…T-079 integradas | BACKLOG (no READY: sin contrato aprobado) |
| T-082 | Pantalla de entrega y confirmación del pedido (checkout) | frontend-dev + qa-reviewer | T-081, T-111 (VIEWS.md y Figma), T-060 | BACKLOG (no READY: sin diseño) |
| T-083 | Mis pedidos, detalle con historial, cancelar y "volver a comprar" (account) | frontend-dev + qa-reviewer | T-081, T-111 | BACKLOG (no READY: sin diseño) |
| T-084 | Backoffice de pedidos: listado, detalle y transiciones | frontend-dev + qa-reviewer | T-081, T-111 | BACKLOG (no READY: sin diseño) |

IDs reservados del módulo: T-070–T-089. En uso: T-070–T-084; **libres: T-085–T-089** (correcciones `fix`, o la división de las pantallas por frontend-lead).

**Decisiones:** D-040 resuelve las preguntas de negocio, E-1…E-3 y fija las dos modalidades de entrega (`shipping`, `pickup`).

**Orden y paralelismo:** T-071 ∥ T-072 → T-073 → T-074 → T-075 → T-076 → T-077 → T-078 → T-079 → T-080. Las tareas T-074…T-079 tocan los mismos archivos (`application.py`, y `main.py` solo T-074 y T-078): van **en serie**; no se paralelizan. En paralelo con ellas, qa-reviewer escribe las pruebas de la siguiente contra las firmas de este STATUS (D-033). Frontend (T-081…T-084) empieza con el backend integrado y el diseño disponible.

**Rutas disjuntas (D-033):** quien implementa escribe solo `backend/src/**`, `backend/migrations/**` (T-073) y su traspaso aquí; qa-reviewer escribe solo `backend/tests/orders/**` (y `backend/tests/test_app_role.py`, `backend/tests/test_migrations.py`, `backend/tests/cart/**` e `inventory/**` solo en T-071 para la prueba de las costuras), y en T-081…T-084 `frontend/tests/**` y `frontend/e2e/**`. Estructura `modules/orders/{domain.py, application.py, adapters/persistence.py, adapters/http.py, adapters/admin_http.py}` con la skill `backend-module-implementation`; las referencias de estilo son `modules/cart/` (HTTP, errores, `Money`, `ERROR_RESPONSES`) y `modules/inventory/` (transacción, bloqueos, `admin_http.py`, auditoría).

**Convención de los routers:** `adapters/http.py` define el router del cliente (`/api/v1/orders`) y `adapters/admin_http.py` el de administración (`/api/v1/orders/admin`). En `main.py` el router de administración se registra **antes** que el del cliente para que `/admin` no lo capture `/{order_id}`.

**Filas para `docs/agents/tasks.md` (las añade el Leader; este paquete solo modifica `docs/modules/orders/**`):**
`| T-070 | SPEC de orders | requisitos, backend | module-coordinator (revisa claude-leader) | RF04, RF11.01, RF12, RF13.03, D-040 | docs/modules/orders/SPEC.md | IN_REVIEW | SPEC propuesta con D-040 (envío y recojo); falta la aprobación del contrato §7 |`
`| T-071…T-084 | Implementación de orders (costuras, dominio, esquema, crear, leer, cancelar, puerto de pago, administración, pantallas) | backend, frontend | backend-dev + qa-reviewer; frontend-dev en T-081…T-084 | ver STATUS de orders | docs/modules/orders/STATUS.md | BACKLOG | T-085…T-089 libres |`
Y la fila de `docs/agents/_registry.md`: `docs/modules/orders/ · Carpeta · SPEC y STATUS del módulo orders · module-coordinator`.

## Paquetes de tarea

### T-071 — Costuras entre módulos (E-1) y configuración de la boutique (E-4)
- Objetivo: orders puede construir los casos de uso públicos de cart e inventory con la sesión de la solicitud, sin importar sus repositorios, y capturar `InsufficientStock`; `Settings` lleva los datos de la boutique del recojo (H-1).
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders (toca cart e inventory solo para esto) · Requisitos: ninguno directo (habilita RF04.01, RF04.07) · Decisiones: D-033, propuesta E-1
- Leer: `docs/modules/orders/SPEC.md` §8 (E-1); `backend/src/valmont/modules/cart/application.py` (`PrepareCheckout`, `RemoveCheckedOutItems`), `modules/cart/adapters/persistence.py` (`SqlCartRepository`, `SqlCartCatalog`), `modules/cart/adapters/http.py` (cómo se construyen hoy `GetCart` y compañía); `modules/inventory/application.py` (`ReserveStock`, `ConsumeReservations`, `ReleaseReservations`), `modules/inventory/adapters/persistence.py` (`SqlProductPolicies`, `SqlStockRepository`, `SqlReservationRepository`, `SqlMovementRepository`) y `modules/inventory/adapters/admin_http.py` (proveedores existentes); `backend/src/valmont/shared/db.py` y `shared/config.py` (`Settings`), `backend/.env.example`.
- Contratos aplicables: SPEC §8 (E-1, E-4) y R20. Sin endpoints.
- Dependencias: **E-1 aprobada y registrada por el Leader en `docs/modules.md` §3 como excepción (7)** (sin ella no se empieza).
- Puede modificar: `backend/src/valmont/modules/cart/adapters/wiring.py` y `backend/src/valmont/modules/inventory/adapters/wiring.py` (nuevos); `backend/src/valmont/modules/inventory/application.py` **solo** para reexportar `InsufficientStock` (que sea importable desde `valmont.modules.inventory.application`; `OrderLine` y `ReservationExpired` ya lo son); **`backend/src/valmont/shared/config.py`, solo para añadir** `pickup_store_name`, `pickup_store_address` y `pickup_store_hours` (`str | None = None`, sin secretos), y `backend/.env.example` para documentarlos (sin valores reales); su traspaso en este STATUS.
- Protegido: todo lo demás de cart e inventory (dominio, casos de uso, repositorios, rutas), `backend/tests/**`, `migrations/**`, `main.py`, el resto de `shared/`. Sin dependencias nuevas.
- Resultado esperado: proveedores sin lógica de negocio, que solo construyen el caso de uso real con los repositorios SQL de su módulo y la sesión de la solicitud.
- Criterios de aceptación: la suite de cart e inventory pasa sin editarse; los casos de uso construidos por los proveedores se comportan igual que los construidos a mano (CA-ORDERS-06, 14 dependen de ello).
- Firmas públicas (contra las que escribe QA):
  - `valmont.modules.cart.adapters.wiring`: `get_prepare_checkout(session: SessionDep) -> PrepareCheckout`; `get_remove_checked_out_items(session: SessionDep) -> RemoveCheckedOutItems`.
  - `valmont.modules.inventory.adapters.wiring`: `get_reserve_stock(session: SessionDep) -> ReserveStock`; `get_consume_reservations(session: SessionDep) -> ConsumeReservations`; `get_release_reservations(session: SessionDep) -> ReleaseReservations`.
  - `valmont.modules.inventory.application.InsufficientStock` (el mismo objeto que `inventory.domain.InsufficientStock`).
  - `valmont.shared.config.Settings`: `pickup_store_name: str | None = None`, `pickup_store_address: str | None = None`, `pickup_store_hours: str | None = None` (variables de entorno `PICKUP_STORE_NAME`, `PICKUP_STORE_ADDRESS`, `PICKUP_STORE_HOURS`).
- Pruebas obligatorias (las escribe qa-reviewer; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas): las suites existentes de cart e inventory sin cambios; los cinco proveedores contra la BD real (reservar, consumir, liberar, preparar la compra y retirar, de punta a punta con la misma sesión); `InsufficientStock` importable desde `inventory.application` y capturable al reservar sin stock; el módulo `orders` no importa `domain` ni `adapters/persistence` de cart o inventory; `Settings` lee las tres variables y sin ellas las deja en `None`; la suite de `shared/` (config) sin cambios.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): ninguna visible; `uv run pytest -q` del conjunto completo en verde (lo muestra el Leader).
- Seguridad: los proveedores no exponen rutas ni toman identidad; cada caso de uso corre en la transacción de quien lo llama y no hace commit.
- Estado inicial: BACKLOG (READY al registrar la excepción (7)).
- Entrega: cambio preparado sin commit (`git add <rutas>`) y mensaje propuesto en el punto 12, p. ej. `feat(orders): proveedores de cart e inventory y datos de la boutique para orders (T-071)`; qa-reviewer lo verifica y el Leader hace el commit (§11.2, D-033, D-036).
- IDs reservados: ninguno.
- Escalar si: un proveedor exige cambiar un caso de uso o un repositorio, o `ReserveStock` no se puede construir con solo la sesión.

### T-072 — Dominio puro de orders
- Objetivo: estados, transiciones, entrega, línea y pedido como Python puro, con R1, R2, R5 (fecha estimada), R6, R10 (reglas de quién cancela), R13, R14 y R20 (transiciones por modalidad) comprobables sin BD.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF04.02, RF04.03, RF04.05, RF04.06, RF04.07, RF13.03 · Reglas: ORDERS-R1, R2, R3, R5, R6, R10, R13, R14, R19, R20; RN-07, RN-15 · Decisiones: D-015, D-016, D-033
- Leer: `docs/modules/orders/SPEC.md` §4 (R1, R2, R3, R5, R6, R10, R13, R14, R19) y §5; `backend/src/valmont/modules/identity/domain.py` (`normalize_phone`, `clean_text`, control de caracteres: la regla se **duplica**, no se importa); `modules/cart/domain.py` (estilo, `StrEnum`); skill `backend-module-implementation`.
- Contratos aplicables: SPEC §5.
- Dependencias: SPEC aprobada.
- Puede modificar: `backend/src/valmont/modules/orders/__init__.py` y `domain.py` (nuevos) y su traspaso en este STATUS.
- Protegido: todo lo demás, en especial `modules/**` de otros módulos, `application.py`, `adapters/**`, `migrations/**`, `main.py`, `shared/`, `backend/tests/**`. Sin dependencias nuevas (sin `zoneinfo`: desfase fijo UTC−5, R5).
- Resultado esperado: un módulo `domain.py` sin `fastapi`, `pydantic`, `sqlalchemy` ni imports de otros módulos.
- Criterios de aceptación: la parte de dominio de CA-ORDERS-03, 04, 07, 18, 19, 20 y 26 (matriz de transiciones, validación de la entrega, fecha estimada, invariantes de importes).
- Firmas públicas (contra las que escribe QA):
  - Constantes: `PAYMENT_WINDOW_MINUTES = 30`, `MAX_PENDING_ORDERS = 3`, `ORDER_NUMBER_PREFIX = "VAL-"`.
  - Enumeraciones `StrEnum`: `OrderStatus` (`PENDING_PAYMENT="pendiente_pago"`, `PAID="pagado"`, `PREPARING="en_preparacion"`, `SHIPPED="enviado"`, `READY_FOR_PICKUP="listo_para_recojo"`, `DELIVERED="entregado"`, `CANCELLED="cancelado"`, `EXPIRED="expirado"`), `ActorKind` (`CUSTOMER="customer"`, `ADMIN="admin"`, `SYSTEM="system"`), `Fulfillment` (`STOCK="stock"`, `MADE_TO_ORDER="made_to_order"`), `DeliveryMethod` (`SHIPPING="shipping"`, `PICKUP="pickup"`); `PAID_STATUSES: frozenset[OrderStatus]` (`pagado`, `en_preparacion`, `enviado`, `listo_para_recojo`, `entregado`).
  - `admin_targets(status: OrderStatus, method: DeliveryMethod) -> frozenset[OrderStatus]` (la columna "A" de §5 para el administrador según la modalidad; vacío en los terminales); `check_admin_transition(from_status, to_status, method) -> None` (lanza `InvalidTransition`); `can_customer_cancel(status) -> bool` (solo `pendiente_pago`).
  - `format_order_number(number: int) -> str` (`VAL-000123`); `estimated_delivery_on(created_at: datetime, lead_times: Iterable[int | None]) -> date | None` (fecha de Lima, R5).
  - `@dataclass(frozen=True) DeliveryDetails(delivery_method, recipient_name, phone, department=None, province=None, district=None, address_line=None, reference=None)`: valida y normaliza en `__post_init__` según la modalidad (R13: `shipping` exige los cuatro campos de ubicación; `pickup` los prohíbe); lanza `DeliveryInvalid(field, message)` (hereda de `ValueError`, atributo `field`).
  - `@dataclass(frozen=True)`: `OrderLine(product_id, sku, name, quantity, list_price, unit_price, discount_amount, promotion_id, fulfillment, lead_time_days)` con propiedad `line_total`; `StatusChange(from_status | None, to_status, actor_kind, actor_id | None, note | None, at)`; `Order(id, number | None, user_id, status, lines, delivery, shipping_amount, created_at, expires_at, estimated_delivery_on, paid_at, refunded_amount, refunded_at, history, idempotency_key)` con propiedades `subtotal_amount` y `total_amount`.
  - `build_order(order_id: UUID, user_id: UUID, idempotency_key: str, lines: Sequence[OrderLine], delivery: DeliveryDetails, now: datetime) -> Order`: estado `pendiente_pago`, `shipping_amount = 0`, `expires_at = now + 30 min`, `estimated_delivery_on` (R5), historial inicial (`None → pendiente_pago`, `customer`); sin líneas → `ValueError`.
  - Errores: `InvalidTransition(from_status, to_status, allowed)`, `NotCancellable(status)`, `TooManyPendingOrders`, `IdempotencyConflict`, `PickupUnavailable`, `OrderNotFound`, `OrderNotPayable(status)`.
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, capas): tabla completa estado × destino (64 pares por modalidad, `shipping` y `pickup`) contra §5; `can_customer_cancel` por estado; `format_order_number` (1, 123, 1 234 567); `estimated_delivery_on` (sin líneas Bajo pedido, con `None`, varios plazos, medianoche de Lima y UTC); `DeliveryDetails` (ambas modalidades: cada longitud en su límite y fuera, teléfono, espacios, `\n`, controles, `reference` vacía); `build_order` (totales, `expires_at`, historial, subtotal por encima de 2³¹, sin líneas); el dominio no importa `fastapi`, `pydantic`, `sqlalchemy` ni otros módulos.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): ninguna visible (dominio puro).
- Seguridad: validación de entrada en el dominio (R13); sin datos personales en los mensajes de error.
- Estado inicial: BACKLOG → READY al aprobar la SPEC.
- Entrega: como T-071; mensaje propuesto `feat(orders): dominio de pedidos, estados y transiciones (T-072)`.
- IDs reservados: ninguno.
- Escalar si: una regla de §4 es ambigua o contradice una decisión, o hace falta importar otro módulo.

### T-073 — Migración `0010`, filas y repositorio SQL
- Objetivo: las cuatro tablas de §6 existen con todas sus restricciones y permisos, y el repositorio guarda y lee pedidos, aplica transiciones con la fila bloqueada, materializa los vencidos y da el reloj de la BD.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF04.01…RF04.03, RF12.02, RF13.03 · Reglas: ORDERS-R4, R6, R7, R8, R11, R14, R17 · Decisiones: D-010, D-029, D-033
- Leer: SPEC §4 (R4, R7, R8, R11, R17) y §6; skills `backend-module-implementation` y `database-migration-review`; `backend/migrations/versions/0008_cart.py` y `0009_wishlist.py` (FK, `op.f`, `GRANT`, `downgrade`) y `0006_app_role.py`; `modules/cart/adapters/persistence.py` (`CartRow`, `InvalidReference`, `pg_insert … on_conflict`, `with_for_update`); `modules/inventory/adapters/persistence.py` (`_now`, bloqueos, `SELECT now()`); `backend/src/valmont/shared/db.py`.
- Contratos aplicables: SPEC §6 (esquema exacto) y §7 (formas de lectura).
- Dependencias: T-072; E-2 registrada en `modules.md` §3; T-016 (perfiles) y T-026 (productos) integradas.
- Puede modificar: `backend/src/valmont/modules/orders/application.py` (**solo** los puertos y datos de lectura: `OrderRepository`, `Clock`, `OrderSummary`, `OrderPage`, `AdminOrderQuery`), `adapters/__init__.py` y `adapters/persistence.py` (nuevos), `backend/migrations/env.py` (solo la línea de registro), `backend/migrations/versions/0010_orders.py` (nuevo, `--rev-id 0010`) y su traspaso en este STATUS.
- Protegido: el resto de `modules/**`, `domain.py` (de T-072: si falta algo, se escala), `main.py`, `shared/`, `backend/tests/**`. Sin endpoints. Sin dependencias nuevas.
- Resultado esperado: migración `0010` exactamente como §6 con `downgrade` (historial, entrega, líneas, pedidos), `GRANT` como §6; filas `OrderRow`, `OrderLineRow`, `DeliveryRow`, `OrderStatusHistoryRow`; `SqlOrderRepository` y `SqlClock`; el repositorio convierte filas en objetos del dominio.
- Criterios de aceptación: CA-ORDERS-20 (permisos e historial), CA-ORDERS-23 (esquema, `CHECK` incluidos los de `deliveries`, `UNIQUE`, FK, `bigint`), la parte de repositorio de CA-ORDERS-08 (`UNIQUE` → `IdempotencyConflict`), CA-ORDERS-13 (materialización con `SKIP LOCKED`) y CA-ORDERS-17 (orden de listados).
- Firmas públicas (contra las que escribe QA; no se cambian sin avisar):
  - `valmont.modules.orders.application`:
    - `class Clock(Protocol)`: `now() -> datetime` (UTC con zona; `SELECT now()` de la BD, hora de inicio de la transacción).
    - `@dataclass(frozen=True) OrderSummary`: `id`, `number`, `user_id`, `status`, `total_amount`, `item_count`, `created_at`, `expires_at`, `estimated_delivery_on`, `recipient_name`, `district`.
    - `@dataclass(frozen=True) OrderPage`: `items: tuple[OrderSummary, ...]`, `total: int`, `page: int`, `page_size: int`.
    - `@dataclass(frozen=True) AdminOrderQuery`: `status: OrderStatus | None`, `q: str | None`, `created_from: date | None`, `created_to: date | None` (fechas de Lima), `page: int`, `page_size: int`.
    - `class OrderRepository(Protocol)`:
      - `add(order: Order) -> Order`: inserta pedido, líneas, entrega e historial inicial; asigna `number`; una violación de `UNIQUE (user_id, idempotency_key)` lanza `IdempotencyConflict`; no hace commit.
      - `find_by_key(user_id: UUID, key: str) -> Order | None`.
      - `count_pending(user_id: UUID, now: datetime) -> int`: pedidos `pendiente_pago` con `expires_at > now`.
      - `get(order_id: UUID, *, user_id: UUID | None = None, lock: bool = False) -> Order | None`: con `user_id`, filtra por dueño (ajeno = `None`); con `lock`, `FOR UPDATE`; incluye líneas, entrega e historial (más antiguo primero).
      - `list_for_user(user_id: UUID, *, status: OrderStatus | None, page: int, page_size: int) -> OrderPage`.
      - `list_all(query: AdminOrderQuery) -> OrderPage`.
      - `apply(order_id: UUID, change: StatusChange, *, paid: bool = False, refund_amount: int | None = None, carrier: str | None = None, tracking_code: str | None = None) -> Order`: precondición: fila bloqueada por quien llama; compara el estado esperado (`change.from_status`) y cambia (si no coincide, lanza `InvalidTransition`), pone `paid_at`, reembolso o `shipped_at` según corresponda, inserta el historial y devuelve el pedido.
      - `expire_overdue(now: datetime, *, user_id: UUID | None = None, order_ids: Collection[UUID] | None = None, limit: int = 200) -> list[Order]`: `UPDATE … WHERE status='pendiente_pago' AND expires_at <= now` sobre las filas elegidas con `FOR UPDATE SKIP LOCKED`, ordenadas por `id`; inserta el historial `system` solo de las que cambió y las devuelve.
  - `valmont.modules.orders.adapters.persistence`: `SqlOrderRepository(session)`, `SqlClock(session)`, `OrderRow`, `OrderLineRow`, `DeliveryRow`, `OrderStatusHistoryRow`.
  - BD: tablas, columnas, restricciones e índices con los nombres de §6 (convención `NAMING_CONVENTION` de `shared/db.py`).
- Pruebas obligatorias (las escribe qa-reviewer; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check` y `downgrade -1` + `upgrade head`): migración y cada `CHECK`, `UNIQUE`, FK y `GRANT` (incluidos los `CHECK` de coherencia de `deliveries`: `shipping` sin ubicación y `pickup` con ubicación, transportista, seguimiento o `shipped_at` se rechazan) (con el rol `valmont_app`, `UPDATE`/`DELETE` sobre historial y líneas fallan); `add` y lectura completa (ida y vuelta de todos los campos, importes por encima de 2³¹); número asignado y creciente; `find_by_key`; `count_pending` (vigentes, vencidos, cancelados); `get` con dueño ajeno, con `lock` (una segunda conexión espera); `apply` con estado inesperado; `expire_overdue` (límite, `SKIP LOCKED` con una fila bloqueada por otra conexión, historial solo de las cambiadas, idempotente); listados (orden, paginación, filtros de administración, comodines escapados); `SqlClock` devuelve la hora de la transacción.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): `uv run alembic current` indica `0010`; en Supabase Studio local (solo lectura) aparecen `app.orders`, `app.order_lines`, `app.deliveries` y `app.order_status_history` sin filas y con sus restricciones.
- Seguridad: SQL parametrizado; el repositorio recibe `user_id` solo como filtro de dueño; permisos mínimos (sin `DELETE`, historial y líneas sin `UPDATE`); las restricciones de la BD son la última defensa (RNF08).
- Estado inicial: BACKLOG.
- Entrega: como T-071; mensaje propuesto `feat(orders): esquema 0010 y repositorio de pedidos (T-073)`.
- IDs reservados: ninguno.
- Escalar si: hace falta otra tabla o columna, leer tablas de otro módulo, una FK a otro módulo distinta de `profiles` y `products`, o `SKIP LOCKED` no se puede expresar con el ORM.

### T-074 — Crear pedido y `POST /orders`
- Objetivo: el cliente convierte su carrito validado en un pedido idempotente, con precio de servidor, instantánea, stock reservado y entrega.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF04.01, RF04.02, RF04.03, RF04.05, RF04.07, RF12.02 · Reglas: ORDERS-R2…R6, R8, R9, R11, R13, R14 · Decisiones: D-016, D-017, D-023, D-037, D-038
- Leer: SPEC §3 (UC-01), §4 (R2…R6, R8, R9, R11, R13), §7 (`POST /`, `CreateOrderIn`, `OrderDetailOut`, "Crear") y §8; `modules/cart/application.py` (`PrepareCheckout`, `CheckoutLine`, `CheckoutBlocked`, `EmptySelection`) y su SPEC §8 (obligaciones de orders); `docs/modules/inventory/SPEC.md` §4 (R4, R10) y §8 (obligaciones de orders); `modules/inventory/application.py` (`ReserveStock`, `ReservedOrder`); `shared/config.py` (`Settings`); `modules/cart/adapters/http.py` (`_money`, esquemas, `ERROR_RESPONSES`, `_conflict`); `modules/inventory/adapters/admin_http.py` (`AuditRecorderDep`, `current_actor`, traducción de errores); el código de T-071…T-073; `backend/src/valmont/main.py`.
- Contratos aplicables: SPEC §7 (PROPUESTO; el desarrollo empieza con la aprobación de backend-lead y frontend-lead).
- Dependencias: T-071, T-073; cart (T-059), inventory (T-042, T-044) y promotions (T-051) integradas.
- Puede modificar: `modules/orders/application.py` (`CreateOrder` y el resultado `CreatedOrder`, `PickupStore` y `PickupStoreProvider`; puertos de T-073 solo para leerlos), `adapters/pickup.py` (nuevo: `SettingsPickupStore`), `adapters/http.py` (nuevo: router del cliente, esquemas `CreateOrderIn`, `DeliveryIn` (unión discriminada `ShippingIn` / `PickupIn` por `delivery_method`), `OrderDetailOut`, `OrderLineOut`, `DeliveryOut`, `HistoryEntryOut`, `RefundOut`, proveedores), `backend/src/valmont/main.py` (solo registrar el router) y su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py` y `migrations/**` (de T-072/T-073: si falta algo, se escala), el resto de módulos, `shared/`, `backend/tests/**`. No importar nada del `domain` ni de los `adapters/persistence` de cart o inventory (solo sus `application` y `adapters/wiring`).
- Resultado esperado: `POST /api/v1/orders` con `current_user` y `AuditRecorderDep`; `CreateOrder` sigue R8 y el flujo de UC-01: `now` del reloj de la BD → búsqueda por clave → `PrepareCheckout` (si `EmptySelection`, buscar de nuevo la clave) → tope R9 → `ReserveStock(order_id, líneas por producto, now)` → `build_order` con `fulfillment` según `reservations`/`on_request` → `add` → `RemoveCheckedOutItems` con exactamente los productos del pedido → auditoría `orders.created`. Traduce a 409/422 de §7. `pickup` sin boutique (`PickupStoreProvider.get()` es `None`; `SettingsPickupStore` trata un `PICKUP_STORE_NAME` vacío o en blanco igual que ausente, porque `Settings` lo lee como `""`: decisión del Leader tras QA de T-071) → `PickupUnavailable` antes de tocar nada. Una violación del `UNIQUE` deshace todo (`IdempotencyConflict`). `LookupError` de `ReserveStock` no se traduce (500: error de programación).
- Criterios de aceptación: CA-ORDERS-01…09, 11 (forma de `OrderDetailOut` recién creado), 26 (creación `pickup`), 20 (historial inicial), 21 (`orders.created`), 22 (aislamiento y campos extra), 24 (dos pedidos con los mismos productos en distinto orden) y 25 (OpenAPI de `POST`).
- Firmas públicas:
  - HTTP: `POST /api/v1/orders`, cabecera `Idempotency-Key` obligatoria, cuerpo `CreateOrderIn` (`extra="forbid"`), 201/200 `OrderDetailOut`; 401, 409 (`empty_selection`, `checkout_blocked`, `insufficient_stock`, `too_many_pending_orders`, `pickup_unavailable`, `idempotency_conflict`), 422, 503 (SPEC §7).
  - `valmont.modules.orders.application`:
    - `@dataclass(frozen=True) class PickupStore`: `name: str`, `address: str`, `hours: str`; `class PickupStoreProvider(Protocol)`: `get() -> PickupStore | None` (`None` si falta algún dato; H-1, H-5). Implementación `valmont.modules.orders.adapters.pickup.SettingsPickupStore(settings: Settings)`.
    - `@dataclass(frozen=True) class CreatedOrder`: `order: Order`, `created: bool` (`False` si repite la clave).
    - `class CreateOrder`: `__init__(self, orders: OrderRepository, prepare: PrepareCheckout, remove: RemoveCheckedOutItems, reserve: ReserveStock, pickup_store: PickupStoreProvider, clock: Clock, audit: AuditRecorder)`; `__call__(self, user_id: UUID, idempotency_key: str, delivery: DeliveryAddress) -> CreatedOrder`. Lanza `EmptySelection` y `CheckoutBlocked` (de cart), `InsufficientStock` (de inventory), `TooManyPendingOrders`, `PickupUnavailable`, `IdempotencyConflict`; no hace commit.
  - Proveedores en `adapters/http.py`: `get_orders(session: SessionDep) -> OrderRepository`, `get_clock(session: SessionDep) -> Clock`, `get_pickup_store() -> PickupStoreProvider`, `get_create_order(...) -> CreateOrder` (usa los proveedores de T-071).
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas, OpenAPI): `CreateOrder` con repositorio, carrito, inventario y reloj falsos (instantánea, totales, idempotencia, tope, cada error sin efectos, `RemoveCheckedOutItems` con los productos exactos, `fulfillment`); integración con cart, inventory y promotions reales (precio con y sin promoción, reservas con `expires_at` igual, rollback total ante `checkout_blocked` e `insufficient_stock`, Bajo pedido y mixto, `backorder` parcial); HTTP (201/200, 401, `loc` de cada campo de la entrega, campo extra, cabecera ausente o mala); concurrencia con dos conexiones (última unidad, misma clave, mismos productos en distinto orden); aislamiento entre dos clientes.
- Diseño (frontend): no aplica (pantallas: T-082).
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:8000/docs` con un token de cliente de desarrollo: con artículos seleccionados en el carrito, `POST /api/v1/orders` con una clave de 16+ caracteres devuelve 201 con precios, total, `expires_at` a 30 minutos y `estimated_delivery_on` si hay Bajo pedido; el carrito queda sin esos artículos; con `delivery_method` `pickup` (solo nombre y teléfono) la respuesta trae `pickup_store` con los datos de `PICKUP_STORE_*` y, sin ellos, 409 `pickup_unavailable`; repetir la misma clave devuelve 200 y el mismo `id`; sin carrito, 409 `empty_selection`; sin token, 401; en Studio local, la reserva aparece `active` con el mismo vencimiento.
- Seguridad: la identidad sale de `current_user`; importes solo del servidor (cuerpo cerrado); no se registra el cuerpo (PII); tope de pedidos sin pagar; un único `now` de la BD para pedido y reservas.
- Estado inicial: BACKLOG → READY al integrar T-071 y T-073 y recibir la aprobación del contrato.
- Entrega: como T-071; mensaje propuesto `feat(orders): crear pedido desde el carrito con reserva e idempotencia (T-074)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso, `PrepareCheckout` o `ReserveStock` no permiten cumplir R4 (p. ej. un bloqueo en otro orden), hace falta cambiar `CheckoutLine` (imagen, `slug`) o aparece una dependencia nueva.
- **Ajuste D-041 (P-7):** `OrderLineOut` añade `image: OrderImageOut | None` (`url`, `alt`, misma forma que `CartImageOut`), leída al construir la respuesta con `SqlProductSnapshots(session).get_published(...)` de `valmont.shared.product_snapshots` (una consulta para todas las líneas) e `image_url`; `null` si el producto ya no está publicado o no tiene imagen. No se guarda en el pedido. Aplica a `OrderDetailOut` en todas las rutas que lo devuelven.

### T-075 — Lectura propia y caducidad (`GET /orders`, `GET /orders/{id}`)
- Objetivo: el cliente ve sus pedidos y su historial; los pedidos vencidos pasan a `expirado` al leerse, con la reserva liberada.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF11.01, RF12.01, RF12.02, RF04.06 · Reglas: ORDERS-R6, R7, R11, R12, R17, R18 · Decisiones: D-017
- Leer: SPEC §3 (UC-02, 03, 05), §4 (R6, R7, R11, R12, R17), §7 (`GET /`, `GET /{order_id}`, `OrderSummaryOut`, `OrderPageOut`); `docs/modules/inventory/SPEC.md` §4 (R12) y `modules/inventory/application.py` (`ReleaseReservations`); el código de T-071…T-074.
- Contratos aplicables: SPEC §7.
- Dependencias: T-074.
- Puede modificar: `modules/orders/application.py` (`ExpireOverdueOrders`, `ListMyOrders`, `GetMyOrder`), `adapters/http.py` (2 rutas, `OrderSummaryOut`, `OrderPageOut`, mapeo del detalle con `can_cancel`, `expires_in_seconds` y `pickup_store`), su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py`, `migrations/**`, el resto de módulos, `main.py`, `shared/`, `backend/tests/**`.
- Resultado esperado: `ExpireOverdueOrders` llama a `expire_overdue` y, por cada pedido cambiado, a `ReleaseReservations` y a la auditoría `orders.status_changed` sin actor; `ListMyOrders` y `GetMyOrder` lo ejecutan antes de leer (solo con los pedidos que van a leer); un pedido ajeno o inexistente es `OrderNotFound` (404 idéntico); sin notas ni `user_id` en la respuesta del cliente.
- Criterios de aceptación: CA-ORDERS-10, 11, 13, 21 (caducidad), 22 (aislamiento en lectura), 25 (OpenAPI de los dos `GET`).
- Firmas públicas:
  - HTTP: `GET /api/v1/orders?status&page&page_size` → `OrderPageOut`; `GET /api/v1/orders/{order_id}` → `OrderDetailOut`; 200, 401, 404, 422, 503.
  - `valmont.modules.orders.application`:
    - `class ExpireOverdueOrders`: `__init__(self, orders: OrderRepository, release: ReleaseReservations, audit: AuditRecorder, clock: Clock)`; `__call__(self, *, user_id: UUID | None = None, order_ids: Collection[UUID] | None = None, limit: int = 200) -> list[Order]` (devuelve los expirados).
    - `class ListMyOrders`: `__init__(self, orders, expire: ExpireOverdueOrders)`; `__call__(self, user_id: UUID, *, status: OrderStatus | None, page: int, page_size: int) -> OrderPage`.
    - `class GetMyOrder`: `__init__(self, orders, expire)`; `__call__(self, user_id: UUID, order_id: UUID) -> Order` (lanza `OrderNotFound`).
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-074): casos de uso con falsos (caducidad, orden y paginación, ajeno = no encontrado, repetición sin duplicar); integración (vencido por lectura con reservas `released`, historial `system`, auditoría sin actor, disponibilidad ya correcta antes de leer, una fila bloqueada por otra conexión se salta, pagado nunca vence, 200+ vencidos con el límite); HTTP (forma de `OrderSummaryOut`/`OrderDetailOut`, 404 idéntico, 422 de `status`, de `page_size` y de `order_id`, 401); aislamiento entre dos clientes.
- Diseño (frontend): no aplica (pantallas: T-083).
- Revisión manual (el usuario, en `main` tras integrar): en `/docs` con un token de cliente: `GET /api/v1/orders` lista el pedido de T-074; su detalle muestra líneas, entrega e historial; con `expires_at` modificado a mano en Studio local (a un instante pasado), el detalle muestra `expirado` y la reserva queda `released`; con el token de otro cliente, el mismo `id` da 404.
- Seguridad: filtro de dueño en cada consulta; el 404 no revela existencia; la respuesta del cliente no trae `user_id` ni notas internas; no se registra la dirección.
- Estado inicial: BACKLOG → READY al integrar T-074.
- Entrega: como T-071; mensaje propuesto `feat(orders): mis pedidos, detalle e historial con caducidad a los 30 minutos (T-075)`.
- IDs reservados: ninguno.
- Escalar si: la caducidad exige un proceso en segundo plano o un cambio en inventory, o el límite de 200 produce resultados incorrectos en la lectura.
- **Ajuste D-041 (P-6):** el filtro admite varios estados: `GET /api/v1/orders?status=pagado&status=en_preparacion` (parámetro repetido; sin `status` = todos; un valor desconocido = 422). La firma pasa a `ListMyOrders.__call__(self, user_id, *, statuses: frozenset[OrderStatus] | None, page, page_size)`, y T-075 puede cambiar **solo** ese parámetro de `OrderRepository.list_for_user` y `SqlOrderRepository.list_for_user` (`statuses: Collection[OrderStatus] | None`, `IN (...)`). La agrupación de etiquetas vive en el frontend; ningún estado agrupado se guarda ni se devuelve.
- **Ajuste R-11 (ruta A, decisión del usuario 2026-11-26):** T-075 también puede modificar `domain.py` y `adapters/persistence.py`, **solo** para esto:
  - `domain.py`: `@dataclass(frozen=True) class Delivery(DeliveryDetails)` con `carrier: str | None = None`, `tracking_code: str | None = None` y `shipped_at: datetime | None = None` (SPEC §5). En `pickup`, cualquiera de los tres distinto de `None` lanza `DeliveryInvalid`. `Order.delivery` sigue tipado como `DeliveryDetails` (un `Delivery` lo es), así que `build_order`, T-074 y las pruebas existentes no cambian.
  - `adapters/persistence.py`: `SqlOrderRepository.get` (y lo que devuelva `Order` completos: `apply`, `expire_overdue`) construye `Delivery` con las tres columnas de `app.deliveries` que ya lee; sin consultas nuevas.
  - `adapters/http.py`: `DeliveryOut` toma `carrier`, `tracking_code` y `shipped_at` del `Delivery` (o `null` si la entrega es un `DeliveryDetails` sin ellos).
  - Pruebas (QA): un pedido `shipping` llevado a `enviado` por SQL o con `apply` muestra los tres campos en `GET /orders/{id}`; uno nuevo los muestra en `null`; `Delivery` en `pickup` con alguno de ellos → `DeliveryInvalid`; las suites de T-072…T-074 pasan sin modificarse.

### T-076 — Cancelar el pedido propio
- Objetivo: el cliente cancela un pedido sin pagar y se liberan sus reservas.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF04.04, RF12.02 · Reglas: ORDERS-R4, R10, R11, R12 · Decisiones: D-016
- Leer: SPEC §3 (UC-04), §4 (R4, R10, R11, R12), §7 (`POST /{order_id}/cancel`, "Cancelar"); el código de T-074 y T-075; `modules/inventory/application.py` (`ReleaseReservations`).
- Contratos aplicables: SPEC §7.
- Dependencias: T-075.
- Puede modificar: `modules/orders/application.py` (`CancelMyOrder`), `adapters/http.py` (1 ruta, traducción de `NotCancellable` a 409), su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py`, `migrations/**`, el resto de módulos, `main.py`, `shared/`, `backend/tests/**`.
- Resultado esperado: `CancelMyOrder` bloquea el pedido propio (`get(..., user_id, lock=True)`), materializa su vencimiento (R7: un vencido queda `expirado`, no cancelable), y si es `pendiente_pago` aplica `apply` con `ActorKind.CUSTOMER`, llama a `ReleaseReservations` y audita; `cancelado` ya → devuelve sin cambios; otro estado → `NotCancellable(status)`.
- Criterios de aceptación: CA-ORDERS-12, 15 (cancelación contra pago), 20, 21, 22 y 25 (OpenAPI de la ruta).
- Firmas públicas:
  - HTTP: `POST /api/v1/orders/{order_id}/cancel` sin cuerpo → `OrderDetailOut`; 200, 401, 404, 409 `not_cancellable` con `details {"status"}`, 422, 503.
  - `valmont.modules.orders.application.CancelMyOrder`: `__init__(self, orders, expire: ExpireOverdueOrders, release: ReleaseReservations, audit: AuditRecorder, clock: Clock)`; `__call__(self, user_id: UUID, order_id: UUID) -> Order` (lanza `OrderNotFound`, `NotCancellable`).
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-074): casos de uso con falsos (cada estado, idempotencia, vencido, "ningún cambio" tras un rechazo); integración (reservas liberadas y disponible recuperado, historial, auditoría); HTTP (200, 404 de otro cliente, 409 con `details`, 401); concurrencia: cancelar y `ConfirmOrderPayment` a la vez (con T-077) y dos cancelaciones simultáneas (un solo historial).
- Diseño (frontend): no aplica (T-083).
- Revisión manual (el usuario, en `main` tras integrar): en `/docs`: cancelar el pedido de T-074 → 200 `cancelado`; el stock disponible del reloj vuelve (en `GET /api/v1/inventory/admin/stock/{id}`); cancelarlo otra vez → 200; con un pedido ya pagado (cuando exista payments, o poniéndolo en `pagado` en Studio local) → 409.
- Seguridad: solo pedidos propios; el estado se decide en el dominio; sin cuerpo de entrada.
- Estado inicial: BACKLOG → READY al integrar T-075.
- Entrega: como T-071; mensaje propuesto `feat(orders): cancelar el pedido propio sin pagar (T-076)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso o aparece un interbloqueo con `ReleaseReservations`.

### T-077 — Puerto para payments
- Objetivo: payments puede conocer lo que debe cobrar de un pedido del cliente y marcarlo pagado de forma idempotente, consumiendo las reservas.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF12.02 (RN-06; sostiene RF05.02 y RF05.03 de payments) · Reglas: ORDERS-R4, R6, R7, R11, R16 · Decisiones: D-017
- Leer: SPEC §3 (UC-06), §4 (R4, R6, R7, R11, R16) y §8; `docs/modules/inventory/SPEC.md` §4 (R8, R11, R12) y §8 (obligaciones de orders: I-6); `modules/inventory/application.py` (`ConsumeReservations`); el código de T-074 y T-075.
- Contratos aplicables: SPEC §3 (UC-06) y §8. Sin endpoints.
- Dependencias: T-075; inventory (T-042) integrada.
- Puede modificar: `modules/orders/application.py` (`PayableOrder`, `PaymentOutcome`, `GetPayableOrder`, `ConfirmOrderPayment`), su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/**`, `migrations/**`, el resto de módulos, `main.py`, `shared/`, `backend/tests/**`.
- Resultado esperado: dos casos de uso que corren en la transacción de quien los llama (payments) y no hacen commit. `ConfirmOrderPayment` sigue R16 al pie de la letra: bloqueo del pedido (filtrado por dueño) → decisión por estado → `ConsumeReservations` antes del cambio de estado → `apply(paid=True)` con `ActorKind.CUSTOMER`, auditoría; `ReservationExpired` → expira el pedido y devuelve `EXPIRED` sin relanzar (la transacción debe poder confirmarse).
- Criterios de aceptación: CA-ORDERS-14, 15 (pago contra cancelación, contra expiración y doble pago), 20, 21, 22 (aislamiento) y 24 (pago concurrente con vencimiento sobre los mismos productos).
- Firmas públicas:
  - `valmont.modules.orders.application`:
    - `@dataclass(frozen=True) class PayableOrder`: `order_id: UUID`, `number: str`, `status: OrderStatus`, `total_amount: int`, `expires_at: datetime`.
    - `class PaymentOutcome(StrEnum)`: `PAID="paid"`, `ALREADY_PAID="already_paid"`, `EXPIRED="expired"`.
    - `class GetPayableOrder`: `__init__(self, orders, expire: ExpireOverdueOrders)`; `__call__(self, user_id: UUID, order_id: UUID) -> PayableOrder` (lanza `OrderNotFound`; no exige `pendiente_pago`: payments decide con `status`).
    - `class ConfirmOrderPayment`: `__init__(self, orders, consume: ConsumeReservations, release: ReleaseReservations, audit: AuditRecorder, clock: Clock)`; `__call__(self, user_id: UUID, order_id: UUID) -> PaymentOutcome` (lanza `OrderNotFound`, `OrderNotPayable(status)`).
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-074): casos de uso con falsos (los tres resultados, cada estado, `ReservationExpired`, "ningún cambio" tras `OrderNotPayable`); integración con inventory real (`on_hand` baja y hay un movimiento `venta`, reservas `consumed`, Bajo pedido sin consumo, límite del vencimiento INVENTORY-R11, repetir el pago); concurrencia con dos conexiones (CA-15 completo, CA-24).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): sin HTTP aún (lo ejerce payments, T-090…); el Leader enseña el resultado de las pruebas de integración y, con una sesión de desarrollo, un pedido de T-074 pasa a `pagado` y el `on_hand` baja.
- Seguridad: filtro de dueño; `ConfirmOrderPayment` nunca toca importes; no se cobra si el pedido no está vigente.
- Estado inicial: BACKLOG → READY al integrar T-075.
- Entrega: como T-071; mensaje propuesto `feat(orders): puerto de pago para payments, pagado idempotente (T-077)`.
- IDs reservados: ninguno.
- Escalar si: payments necesita otro dato u otra operación del pedido, o el resultado `EXPIRED` no se puede confirmar sin cambiar la transacción de payments.

### T-078 — Administración: listado y detalle
- Objetivo: el administrador lista y consulta pedidos de cualquier cliente.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF13.03, RF12.01 · Reglas: ORDERS-R7, R11, R17, R18 · Decisiones: D-016
- Leer: SPEC §3 (UC-07, 08), §4 (R7, R17), §7 (rutas `admin`, `AdminOrderSummaryOut`, `AdminOrderPageOut`, `AdminOrderDetailOut`, "Listado de administración"); `modules/inventory/adapters/admin_http.py` (router y listado de administración: `q`, escape de comodines, paginación); el código de T-073…T-075.
- Contratos aplicables: SPEC §7.
- Dependencias: T-075.
- Puede modificar: `modules/orders/application.py` (`ListAdminOrders`, `GetAdminOrder`), `adapters/admin_http.py` (nuevo: router, esquemas, proveedores), `backend/src/valmont/main.py` (solo registrar el router de administración **antes** que el del cliente), su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py` y `adapters/http.py` (salvo importar sus esquemas de salida si se reutilizan), `migrations/**`, el resto de módulos, `shared/`, `backend/tests/**`.
- Resultado esperado: dos `GET` con `require_admin`; `ListAdminOrders` materializa hasta 200 vencidos (R7) antes de consultar la página; `can_transition_to` sale de `admin_targets`; el detalle trae `user_id`, `actor_id` y notas.
- Criterios de aceptación: CA-ORDERS-16, 17, 13 (lectura de administración), 22 (403/401) y 25 (OpenAPI).
- Firmas públicas:
  - HTTP: `GET /api/v1/orders/admin?status&q&created_from&created_to&page&page_size` → `AdminOrderPageOut`; `GET /api/v1/orders/admin/{order_id}` → `AdminOrderDetailOut`; 200, 401, 403, 404, 422, 503.
  - `valmont.modules.orders.application`: `class ListAdminOrders`: `__init__(self, orders, expire: ExpireOverdueOrders)`, `__call__(self, query: AdminOrderQuery) -> OrderPage`; `class GetAdminOrder`: `__init__(self, orders, expire)`, `__call__(self, order_id: UUID) -> Order` (lanza `OrderNotFound`).
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-074): casos de uso con falsos; integración (filtros combinados, `q` por número con y sin `VAL-` y por nombre, comodines `%` y `_`, fechas de Lima inclusivas en el borde de medianoche, paginación, caducidad por lectura); HTTP (cliente → 403, sin token → 401, 422 de filtros y fechas, formas); el router de administración no queda capturado por `/{order_id}`.
- Diseño (frontend): no aplica (T-084).
- Revisión manual (el usuario, en `main` tras integrar): en `/docs` con un token de administrador de desarrollo: el listado muestra los pedidos de todos los clientes y filtra por estado y número; el detalle muestra `can_transition_to`; con un token de cliente, 403.
- Seguridad: `require_admin` en cada ruta; los datos de entrega solo se devuelven a administradores y al dueño; sin escritura salvo la caducidad de R7.
- Estado inicial: BACKLOG → READY al integrar T-075.
- Entrega: como T-071; mensaje propuesto `feat(orders): listado y detalle de pedidos para el administrador (T-078)`.
- IDs reservados: ninguno.
- Escalar si: la búsqueda necesita datos del cliente que solo tiene identity (nombre del perfil, correo) o hace falta una vista de lectura en otro módulo.

### T-079 — Administración: transiciones y reembolso simulado
- Objetivo: el administrador lleva el pedido por la máquina de estados y cancela uno pagado con reembolso simulado, todo trazado.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders · Requisitos: RF13.03, RF12.02, RF04.04 (D-016) · Reglas: ORDERS-R1, R4, R10, R11, R15, R19; RN-07, RN-08 · Decisiones: D-016
- Leer: SPEC §3 (UC-09, 10), §4 (R1, R4, R10, R11, R15, R19), §5 (tabla de transiciones), §7 (`POST /admin/{order_id}/transitions`, `TransitionIn`, "Transiciones"); `modules/inventory/application.py` (`ReleaseReservations`); `modules/inventory/adapters/admin_http.py` (`current_actor`, auditoría, traducción de errores); el código de T-073…T-078.
- Contratos aplicables: SPEC §7.
- Dependencias: T-078.
- Puede modificar: `modules/orders/application.py` (`Actor`, `TransitionOrder`), `adapters/admin_http.py` (la ruta, `TransitionIn`, traducción de `InvalidTransition` a 409 con `allowed`), su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py`, `adapters/http.py`, `migrations/**`, el resto de módulos (inventory no se toca: el stock no se repone solo, R15), `main.py`, `shared/`, `backend/tests/**`.
- Resultado esperado: `TransitionOrder` bloquea el pedido, materializa su vencimiento, valida con `check_admin_transition(from, to, method)` y aplica con `ActorKind.ADMIN` (`apply`): `enviado` (solo `shipping`) guarda `carrier`, `tracking_code` y `shipped_at`; `listo_para_recojo` (solo `pickup`) no lleva datos extra; `cancelado` desde `pagado` o `en_preparacion` registra el reembolso total; desde `pendiente_pago` libera reservas sin reembolso; historial con `note` y auditoría `orders.status_changed` (con el reembolso si lo hay, sin datos personales). `TransitionIn.to` solo admite los cinco destinos de §7 (`en_preparacion`, `enviado`, `listo_para_recojo`, `entregado`, `cancelado`) (el resto es 422 por el esquema).
- Criterios de aceptación: CA-ORDERS-18, 19, 20, 21 (transiciones), 22 (403/401), 25 (OpenAPI de la ruta) y 26 (`pickup`).
- Firmas públicas:
  - HTTP: `POST /api/v1/orders/admin/{order_id}/transitions`, cuerpo `TransitionIn` (`extra="forbid"`) → `AdminOrderDetailOut`; 200, 401, 403, 404, 409 `invalid_transition` con `details {"from", "to", "allowed"}`, 422, 503.
  - `valmont.modules.orders.application`: `@dataclass(frozen=True) class Actor`: `user_id: UUID`, `kind: ActorKind`; `class TransitionOrder`: `__init__(self, orders, expire: ExpireOverdueOrders, release: ReleaseReservations, audit: AuditRecorder, clock: Clock)`; `__call__(self, actor: Actor, order_id: UUID, to: OrderStatus, *, note: str | None = None, carrier: str | None = None, tracking_code: str | None = None) -> Order` (lanza `OrderNotFound`, `InvalidTransition`; `ValueError` si `cancelado` sin nota o `carrier`/`tracking_code` sin `enviado`).
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-074): la matriz completa de 64 pares por modalidad con casos de uso falsos y por HTTP (incluidos `enviado` en `pickup` y `listo_para_recojo` en `shipping`); cancelación de `pagado` y `en_preparacion` (reembolso, historial, auditoría, `on_hand` sin cambio), de `pendiente_pago` (reservas liberadas) y rechazo de `enviado`, `entregado`, `cancelado`, `expirado`; `note` obligatoria; `carrier` fuera de `enviado` → 422; dos administradores que aplican la misma transición a la vez (uno 200, otro 409); administrador contra pago simultáneo; el historial lleva `actor_id` del administrador.
- Diseño (frontend): no aplica (T-084).
- Revisión manual (el usuario, en `main` tras integrar): en `/docs` con un token de administrador: llevar un pedido `shipping` pagado (poner `pagado` en Studio local si payments aún no existe) por `en_preparacion → enviado → entregado` y uno `pickup` por `en_preparacion → listo_para_recojo → entregado`; intentar saltar un estado (409 con `allowed`); cancelar uno pagado (200 con `refund` igual al total); cancelar uno enviado (409); con un token de cliente, 403; revisar `GET /api/v1/orders/{id}` con el token del dueño: historial completo, sin notas.
- Seguridad: `require_admin`; el actor sale del token; transiciones solo por el dominio; el reembolso es un registro simulado sin datos de tarjeta (RN-11); sin datos personales en la auditoría.
- Estado inicial: BACKLOG → READY al integrar T-078.
- Entrega: como T-071; mensaje propuesto `feat(orders): transiciones de estado y cancelación con reembolso simulado (T-079)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso, se decide reponer el stock automáticamente o que el reembolso viva en payments (ambas descartadas en D-040; cambiarlas exige una decisión nueva).

### T-080 — Integración transversal y revisión de seguridad del backend de orders
- Objetivo: el backend de orders completo se comporta bien de punta a punta con cart, inventory, promotions y audit reales y resiste los abusos de §9.
- Responsable: qa-reviewer (con `model: "opus"` en la ronda final, decisions.md; no escribe código de producción) · Módulo: orders · Requisitos: RF04, RF11.01, RF12, RF13.03 · Reglas: todas
- Leer: SPEC completa (§4, §9, §10, §11); los traspasos de T-071…T-079; skills `testing-and-quality-gates` y `api-contract-review`.
- Contratos aplicables: SPEC §7 contra el OpenAPI generado.
- Dependencias: T-074…T-079 integradas.
- Puede modificar: `backend/tests/orders/**` (y `backend/tests/test_app_role.py` y `test_migrations.py` si falta cobertura) y su veredicto en este STATUS.
- Protegido: todo el código de producción; si encuentra un fallo, lo informa como hallazgo (`MAYOR`, `MENOR`) y el Leader abre un `fix` con los IDs T-085…T-089.
- Resultado esperado: un recorrido completo carrito → pedido → pago (`ConfirmOrderPayment`) → preparación → envío o recojo → entrega, para las dos modalidades, por HTTP y por casos de uso; la matriz completa de CA-ORDERS-01…26 con evidencia; las carreras de CA-15, 24 con dos conexiones; seguridad: aislamiento, 403, campos extra, PII ausente de logs y auditoría, 404 indistinguible, importes por encima de 2³¹, y revisión del OpenAPI contra §7.
- Criterios de aceptación: los 26 CA-ORDERS de la SPEC §10, cada uno con su comando y resultado.
- Firmas públicas: las de T-071…T-079.
- Pruebas obligatorias: `ruff format --check`, `ruff check`, `uv run pytest -q`, `uv run pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check` + `downgrade -1` + `upgrade head`, OpenAPI contra §7; mutaciones sobre las reglas críticas (transiciones, tope, idempotencia, orden de bloqueos).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): el recorrido completo en `/docs` con un cliente y un administrador de desarrollo, con la guía que preparará el Leader a partir de las "Revisión manual" de T-074…T-079.
- Seguridad: es la tarea de seguridad del módulo (RNF02, ASVS nivel 1).
- Estado inicial: BACKLOG.
- Entrega: veredicto de qa-reviewer con `comando → resultado`, commit base y huella (`PROTOCOL.md` §11.2); el Leader hace los commits de los `fix`.
- IDs reservados: ninguno.
- Escalar si: aparece una carrera con efecto en dinero o stock, o una fuga de datos entre clientes (`CRÍTICO`, al Leader de inmediato).

### T-081 — Cliente de API de orders (BACKLOG)
- Objetivo: `frontend/src/lib/api/orders.ts` con tipos exactos de §7 y funciones para cada ruta, sin lógica de negocio.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders (frontend) · Requisitos: RF04, RF11.01, RF12, RF13.03
- Leer: SPEC §7; `frontend/src/lib/api/` (clientes existentes, errores, sesión), skill `frontend-module-implementation`.
- Contratos aplicables: SPEC §7 aprobado y el OpenAPI real.
- Dependencias: contrato aprobado; T-074…T-079 integradas.
- Puede modificar: `frontend/src/lib/api/orders.ts` (y su tipo de errores si se amplía de forma aditiva) y su traspaso aquí. Protegido: el resto de `frontend/src/**`, `backend/**`.
- Resultado esperado: `createOrder(idempotencyKey, delivery)`, `listOrders`, `getOrder`, `cancelOrder`, `adminListOrders`, `adminGetOrder`, `adminTransition`; errores 409 y 422 tipados por `code` y `details`; el cliente genera la clave de idempotencia **una vez por intento de compra** y la reutiliza en los reintentos.
- Criterios de aceptación: tipos coinciden con §7; cada código de error de §7 se distingue; `npm run check` limpio.
- Firmas públicas: las funciones citadas, con `Money`, `OrderDetail`, `OrderSummary`, `AdminOrderDetail`, `OrderStatus` y `ApiError` con `code` y `details`.
- Pruebas obligatorias (las escribe qa-reviewer): pruebas de contrato del cliente con respuestas simuladas por ruta y error; `npm run check`; `npm run build`.
- Diseño (frontend): no aplica (sin interfaz).
- Revisión manual (el usuario, en `main`): ninguna visible; se ejerce en T-082…T-084.
- Seguridad: nunca importes ni `user_id` en las solicitudes; sin secretos (RNF02).
- Estado inicial: BACKLOG (no READY: sin contrato aprobado).
- Entrega: como T-071.
- IDs reservados: ninguno.
- Escalar si: el OpenAPI real difiere de §7.

### T-082 — Pantalla de entrega y confirmación del pedido (BACKLOG)
- Objetivo: desde el carrito, el cliente elige envío a domicilio o recojo en tienda, indica sus datos y confirma el pedido (RNF01: checkout en 3 pantallas como máximo), ve el importe final del servidor y llega al pago.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders (frontend, área `checkout`) · Requisitos: RF04.01, RF04.03, RF04.05, RF04.07
- Leer: SPEC §7 y §4 (R2, R8, R13); `docs/design_ui/VIEWS.md` y los nodos de Figma que asigne frontend-lead (**aún no existen**: T-110/T-111); `docs/design_ui/DESIGN.md`; skill `frontend-module-implementation`; `frontend/src/lib/api/` (T-081 y el de cart).
- Contratos aplicables: SPEC §7.
- Dependencias: T-081, T-111, T-060 (pantalla del carrito).
- Puede modificar: `frontend/src/pages/checkout/**`, `frontend/src/components/checkout/**` y `frontend/src/islands/**` de checkout (rutas exactas las fija frontend-lead con VIEWS.md) y su traspaso aquí. Protegido: `lib/api/` salvo T-081, otras áreas, `backend/**`.
- Resultado esperado: selector de modalidad (`shipping` | `pickup`) y formulario según `delivery_method` (R13; en `pickup` solo quien recoge, sin dirección, y la boutique de `pickup_store` en la confirmación), resumen de líneas con precio y plazo de las líneas Bajo pedido, errores 409 (`checkout_blocked`, `insufficient_stock`, `too_many_pending_orders`, `empty_selection`, `pickup_unavailable`) y 422 por campo, estados carga, error, vacío y éxito (`docs/modules.md` §5.3), la clave de idempotencia estable entre reintentos, y la cuenta atrás con `expires_in_seconds` del servidor.
- Criterios de aceptación: los de §10 que afectan a la pantalla (CA-ORDERS-01, 04, 05, 07, 08); accesibilidad WCAG 2.2 AA; ancho móvil desde 360 px.
- Firmas públicas: props e islas que defina VIEWS.md.
- Pruebas obligatorias (las escribe qa-reviewer): pruebas de componente, E2E con Playwright (carrito → entrega → pedido pendiente; reintento con la misma clave; error de stock), accesibilidad; `npm run check` y `npm run build`.
- Diseño (frontend): nodos de Figma y filas de VIEWS.md pendientes de T-111; reutilizar «precio (con promoción)» y los componentes del carrito.
- Revisión manual (el usuario, en `main`): recorrer el checkout desde un carrito real y ver el pedido en `/docs`.
- Seguridad: la pantalla no calcula importes ni decide estados; no registra la dirección en consola ni analítica.
- Estado inicial: BACKLOG (no READY: sin diseño).
- Entrega: como T-071.
- IDs reservados: ninguno.
- Escalar si: Figma exige datos que el contrato no trae (imagen o `slug` de las líneas: requeriría ampliar `CheckoutLine` de cart, cambio aditivo propuesto aparte).

### T-083 — Mis pedidos, detalle, cancelar y volver a comprar (BACKLOG)
- Objetivo: el cliente ve su historial de pedidos, el detalle con la línea de tiempo de estados, puede cancelar un pedido sin pagar y repetir una compra (D-040, P-6).
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders (frontend, área `account`) · Requisitos: RF11.01, RF12.01, RF12.02, RF04.04
- Leer: SPEC §7 y D-040 (P-6); `docs/design_ui/VIEWS.md` y Figma (pendientes); `frontend/src/lib/api/` (T-081 y cart: `POST /cart/items`).
- Contratos aplicables: SPEC §7.
- Dependencias: T-081, T-111.
- Puede modificar: `frontend/src/pages/account/orders/**` y sus componentes (rutas exactas, frontend-lead) y su traspaso aquí. Protegido: `lib/api/` salvo T-081, otras áreas, `backend/**`.
- Resultado esperado: lista paginada con filtro de estado; detalle con importes, líneas, entrega, línea de tiempo y `can_cancel` del servidor; cancelar con confirmación; "volver a comprar" agrega al carrito cada línea (`product_id`, `quantity`) con la API existente y avisa de las que ya no se pueden agregar; estados carga, error, vacío y éxito.
- Criterios de aceptación: CA-ORDERS-10, 11, 12 en la interfaz; WCAG 2.2 AA; 360 px.
- Firmas públicas: las que defina VIEWS.md.
- Pruebas obligatorias (las escribe qa-reviewer): componente, E2E (listar → detalle → cancelar → volver a comprar), accesibilidad, `npm run check` y `npm run build`.
- Diseño (frontend): pendiente de T-111.
- Revisión manual (el usuario, en `main`): ver un pedido propio, cancelarlo y recomprar; el pedido de otro cliente no se puede abrir por URL.
- Seguridad: la interfaz oculta controles según `can_cancel` pero la autorización es del backend; no inyecta `note` ni textos como HTML.
- Estado inicial: BACKLOG (no READY: sin diseño).
- Entrega: como T-071.
- IDs reservados: ninguno.
- Escalar si: Figma muestra imagen de producto por línea (el pedido no la guarda; ver T-082).

### T-084 — Backoffice de pedidos (BACKLOG)
- Objetivo: el administrador lista, filtra, abre un pedido y lo lleva por sus estados o lo cancela.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: orders (frontend, área `backoffice`) · Requisitos: RF13.03, RF12.02
- Leer: SPEC §7 y §4 (R10, R15, R19); `docs/design_ui/VIEWS.md` y Figma (pendientes); `frontend/src/lib/api/`.
- Contratos aplicables: SPEC §7.
- Dependencias: T-081, T-111.
- Puede modificar: `frontend/src/pages/admin/orders/**` y sus componentes (rutas exactas, frontend-lead) y su traspaso aquí. Protegido: `lib/api/` salvo T-081, otras áreas, `backend/**`.
- Resultado esperado: listado con filtros (estado, `q`, fechas), detalle con historial y notas, botones de transición según `can_transition_to` del servidor (distintos para `shipping` y `pickup`: `enviado` o `listo_para_recojo`), con transportista y seguimiento solo en `enviado`, formulario de cancelación con nota obligatoria, aviso de reponer el stock con una `devolucion` cuando se cancela un pedido pagado (R15), errores 409 y 422 por campo.
- Criterios de aceptación: CA-ORDERS-16, 17, 18, 19 en la interfaz; WCAG 2.2 AA.
- Firmas públicas: las que defina VIEWS.md.
- Pruebas obligatorias (las escribe qa-reviewer): componente, E2E (administrador recorre el pedido hasta `entregado`; cancela uno pagado), accesibilidad, `npm run check` y `npm run build`.
- Diseño (frontend): pendiente de T-111.
- Revisión manual (el usuario, en `main`): recorrer un pedido hasta `entregado` y cancelar otro pagado desde el panel.
- Seguridad: ocultar controles no es autorización (RF13.02); el backend decide; sin datos personales en la consola.
- Estado inicial: BACKLOG (no READY: sin diseño).
- Entrega: como T-071.
- IDs reservados: ninguno.
- Escalar si: el panel necesita datos del cliente (correo, nombre de perfil) que orders no tiene (RF13.04, identity).

## Traspasos

#### Traspaso T-078 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW. Pruebas: NO EJECUTADO (D-028, D-033).
2. Hecho: `application.py` (`ListAdminOrders`, `GetAdminOrder`); `adapters/admin_http.py` nuevo (router `/api/v1/orders/admin`, `AdminOrderSummaryOut`, `AdminOrderPageOut`, `AdminHistoryEntryOut`, `AdminOrderDetailOut`, 2 `GET` con `require_admin`); `main.py`: una línea, router de administración antes del del cliente.
3. Interpretaciones: (a) `ListAdminOrders` llama `expire()` sin filtro (hasta 200, R7) y luego `list_all`; `GetAdminOrder` hace `expire(order_ids=[id])` y `get(id)` sin dueño. (b) `page_size` 1-50 y `page` 1-1000 (R17; la SPEC no da otro tope para admin). (c) `status` admite un solo valor, como dice §7 (sin el multivalor de D-041 P-6). (d) `created_from > created_to` no es 422: devuelve vacío (§7 no lo pide). (e) `can_transition_to` = `admin_targets(status, método)` en el orden del enum. (f) El detalle reutiliza `OrderDetailOut.build` y sustituye `history` por la versión con `actor_id` y `note`. (g) `q` se recorta y vacío equivale a sin filtro (lo hace `list_all`).
4. Análisis estático: `uv run ruff format . -> 209 files left unchanged`; `uv run ruff check . -> All checks passed!`; `create_app().openapi()` lista `/admin` y `/admin/{order_id}` antes que `/{order_id}`, con sus parámetros y respuestas 200/401/403/404/422/503.
5. Sin PII en logs: no se registra nada; sin escrituras salvo la caducidad.
6. Corrección (Leader, QA modo A): `persistence.py` `list_all` no compara el número si `int(digits) > 2**63 - 1`; `admin_http.py` responde 422 `validation_error` (`loc ["query","q"]`) si `q` tiene caracteres Cc o Cs. `VAL-` ya era insensible a mayúsculas (`term.upper()`); `q` en blanco = sin filtro.
12. Commits: ninguno, preparado. Mensaje: `feat(orders): listado y detalle de pedidos para administración (T-078)`.

#### Traspaso T-077 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW. Pruebas: NO EJECUTADO (D-028, D-033).
2. Hecho: solo `application.py`: `PayableOrder`, `PaymentOutcome`, `GetPayableOrder`, `ConfirmOrderPayment` con las firmas del paquete. Sin HTTP, sin `wiring.py` (el paquete protege `adapters/**`): payments necesitará el proveedor, que se pide en otra tarea.
3. Interpretaciones: (a) `GetPayableOrder`: `expire(user_id, [id])` -> `get(user_id)`; `number` = `format_order_number`. (b) `ConfirmOrderPayment`: `get(lock=True)` -> pagado o posterior = `ALREADY_PAID`; otro estado distinto de `pendiente_pago` = `OrderNotPayable`; `expires_at <= clock.now()` = expira y `EXPIRED` sin consumir; `ConsumeReservations(order_id, now)`; `ReservationExpired` = expira y `EXPIRED` sin relanzar; si no, `apply(paid=True)` (customer, actor = user_id) y auditoría `orders.status_changed` con actor y solo `status`. (c) Expirar usa `apply` (system, sin actor) + `ReleaseReservations` + auditoría sin actor, igual que R7; no se usa `ExpireOverdueOrders` (no está en el constructor). Tras `ReservationExpired`, `release` es seguro: no hubo escrituras de consumo. (d) `now` del `Clock` (R-3: borde de milisegundos cubierto por INVENTORY-R11).
4. Análisis estático: `uv run ruff format . -> 204 files left unchanged`; `uv run ruff check . --fix -> 1 fixed (imports), 0 remaining`; `uv run python -c "import valmont.main"` OK; capas (grep) vacío.
5. Corrección (Leader/QA, capas): `ReservationExpired` se importa de `inventory.application`, no de `inventory.domain`.
12. Commits: ninguno, preparado. Mensaje: `feat(orders): puerto para payments con consulta y confirmación del pago (T-077)`.

#### Traspaso T-076 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW. Pruebas: NO EJECUTADO (D-028, D-033).
2. Hecho: `application.py` (`CancelMyOrder`, firma del paquete); `adapters/http.py` (`POST /orders/{order_id}/cancel`, `get_cancel_my_order`, 409 `not_cancellable` con `details {"status"}`). `domain.py`, `persistence.py` y `main.py` sin cambios.
3. Interpretaciones: (a) orden: `get(user_id, lock=True)` (None -> `OrderNotFound`, sin caducar nada) -> `expire(user_id, order_ids=[id])` con la fila ya bloqueada; si caduca -> `NotCancellable(EXPIRED)` (409 con `status: expirado`, §7 "vigente"); luego `cancelado` -> devuelve sin cambios; otro estado -> `NotCancellable(status)`; `pendiente_pago` -> `apply` (customer, actor = user_id, sin nota), `ReleaseReservations`, auditoría `orders.status_changed` (before/after solo `status`). (b) El 409 de un vencido hace rollback de `SessionDep`, por lo que la caducidad se materializa en la siguiente lectura (R7 perezosa); en el caso de uso con falsos queda expirado. Si QA quiere persistirla en la respuesta 409, requiere cambio de transacción (escalar). (c) 404 igual que T-075.
4. Análisis estático: `uv run ruff format --check . -> 200 files already formatted`; `uv run ruff check . -> All checks passed` (tras `--fix` de orden de imports); `uv run python -c "import valmont.main"` OK; capas (grep) vacío.
5. Corrección (Leader/QA, CA-21): la auditoría de la cancelación lleva actor (`user_id`, `"customer"`), como `orders.created`; la caducidad del sistema sigue sin actor.
12. Commits: ninguno, preparado. Mensaje: `feat(orders): cancelar el pedido propio sin pagar (T-076)`.

#### Traspaso T-075 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW. Pruebas: NO EJECUTADO (D-028, D-033).
2. Hecho: `application.py` (`ExpireOverdueOrders`, `ListMyOrders`, `GetMyOrder`; `list_for_user(statuses=...)` en el puerto); `adapters/http.py` (`GET /orders` con `status` repetible, `GET /orders/{order_id}`, `OrderSummaryOut`, `OrderPageOut`, proveedores `get_expire_overdue_orders`, `get_list_my_orders`, `get_get_my_order`, `DeliveryOut` con los tres campos de R-11); `domain.py` (`Delivery(DeliveryDetails)` solo para R-11); `adapters/persistence.py` (`Delivery` en `get` y `statuses` con `IN`). `main.py` sin cambios.
3. Interpretaciones: (a) `GetMyOrder` expira con `user_id` + `order_ids=[id]` y luego `get(..., user_id=)`; no hay lectura previa. (b) Auditoría de caducidad `orders.status_changed`, sin actor, `before {status: pendiente_pago}`, `after {status: expirado}`. (c) 404 con `AppError("not_found", "Pedido no encontrado.", 404)`. (d) `status` vacío o ausente = todos (`None`); `page` 1-1000, `page_size` 1-50 (20). (e) `Delivery` en `pickup` con carrier, tracking o shipped_at lanza `DeliveryInvalid`.
4. Análisis estático: `uv run ruff format --check . → 191 files already formatted`; `uv run ruff check . → All checks passed!`; `uv run python -c "import valmont.main"` OK; capas (grep) vacío.
3b. Corrección del Leader: el repositorio devuelve `DeliveryDetails` si carrier, tracking_code y shipped_at son los tres `NULL` y `Delivery` si alguno tiene valor (igualdad con T-073); `DeliveryOut` ya trata ambos casos.
5. Entrega: ninguno (sin commit) — preparado. Mensaje propuesto: `feat(orders): consultar mis pedidos y caducidad de los vencidos (T-075)`.

#### Traspaso T-074 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW. Sin pruebas ejecutadas por mí (D-033).
2. Hecho: `application.py` (`PickupStore`, `PickupStoreProvider`, `CreatedOrder`, `CreateOrder`), `adapters/pickup.py` (`SettingsPickupStore`; nombre, dirección u horario vacíos o en blanco = `None`), `adapters/http.py` (router, `CreateOrderIn`/`ShippingIn`/`PickupIn` por unión discriminada, `OrderDetailOut` y anidados, proveedores `get_orders`, `get_clock`, `get_pickup_store`, `get_create_order`, `get_product_snapshots`), `main.py` (una línea: registro del router).
3. Interpretaciones: (a) la firma dice `delivery: DeliveryAddress`, que no existe; se usa `DeliveryDetails` del dominio. (b) Orden en `CreateOrder`: `now` → `find_by_key` → `pickup_unavailable` → `PrepareCheckout` → tope → `ReserveStock`; una repetición de clave devuelve el original aunque la boutique ya no esté. (c) `lead_time_days` de una línea `made_to_order` sale de `OnRequestLine` (y, si es `None`, de `CheckoutLine`); en `stock` es `None`. (d) Errores de la entrega que lanza el dominio (`DeliveryInvalid`) → 422 con `loc ["body","delivery","<modalidad>","<campo>"]`, igual que los de Pydantic; el cuerpo se limita a tipos, la validación de longitudes la hace el dominio. (e) Cabecera con alias `idempotency-key` (`loc ["header","idempotency-key"]`), 16-64 `[A-Za-z0-9_-]`. (f) Auditoría `orders.created` con actor `customer`, solo `status`, `number`, `total_amount`, `line_count`. (g) `OrderDetailOut.build(order, now, store, products)` es reutilizable por T-075; `expires_at` y `expires_in_seconds` solo en `pendiente_pago`; `now` de `SqlClock` (misma transacción).
4. Discrepancia para T-075/T-079: `Order` no trae `carrier`, `tracking_code` ni `shipped_at`; `DeliveryOut` los emite `null` (correcto para pedidos nuevos). Al leer pedidos enviados hará falta que el dominio/repositorio (protegidos) los carguen: decide backend-lead.
5. Estático: `uv run ruff format .` → 2 files reformatted (míos); `uv run ruff check .` → All checks passed; capas (grep) → vacío; `uv run python -c "import valmont.main"` → ok; OpenAPI de `POST /api/v1/orders` declara 201, 200, 401, 409, 422, 503 y la cabecera.
6. NO EJECUTADO: pruebas (D-028, D-033).
7. Entrega: preparado, sin commit. Mensaje propuesto: `feat(orders): crear pedido con reserva de stock e idempotencia (T-074)`.

#### Traspaso T-073 — 2026-11-26 — backend-dev
0. Corrección tras QA modo A: `apply` fija `shipped_at` siempre que `to_status = enviado` (carrier y tracking solo si llegan); la 0010 ya no concede permisos de secuencia (mínimo privilegio; anula la interpretación (a) y (c) en parte). Reaplicada: downgrade -1, upgrade head, alembic check limpio.
1. Estado: IN_REVIEW. Sin pruebas ejecutadas por mí (D-033).
2. Hecho: `migrations/versions/0010_orders.py` (4 tablas de §6, `CHECK` con nombre `ck_<tabla>_<sufijo>`, índices, `GRANT` y `downgrade` en orden historial, entrega, líneas, pedidos); registro en `migrations/env.py`; puertos y datos de lectura en `orders/application.py` (firmas del paquete, sin casos de uso); `orders/adapters/{__init__,persistence}.py` con `OrderRow`, `OrderLineRow`, `DeliveryRow`, `OrderStatusHistoryRow`, `SqlOrderRepository`, `SqlClock`.
3. Interpretaciones: (a) la `0010` añade `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app`: la `0006` solo cubrió las secuencias existentes y `order_number` y el `id` del historial son identidades nuevas (sin esto `valmont_app` no podría insertar). (b) `OrderSummary.number` es `int` (el formato `VAL-` es presentación, `format_order_number`); `item_count` = Σ cantidades. (c) `apply` compara y cambia con un `UPDATE … WHERE status = from_status`; si `rowcount != 1` lanza `InvalidTransition(from, to, frozenset())` (`allowed` vacío: el repositorio no conoce la tabla de transiciones). `carrier`/`tracking_code` (si alguno llega) fijan también `shipped_at = change.at`. (d) `change.at` es la fecha del historial, de `paid_at`, `refunded_at` y `shipped_at`; `add` usa `order.created_at` como `created_at`/`updated_at`. (e) `list_all.q`: `ILIKE` del destinatario con `%`, `_` y `\` escapados, o igualdad del número si el texto (sin `VAL-`) son dígitos. Fechas: medianoche de Lima (UTC-5, `domain._LIMA` importado) `[from, to+1d)`. (f) `expire_overdue` con `order_ids=[]` devuelve `[]`; `IdempotencyConflict` se detecta por el nombre del `UNIQUE` en el error de BD y el resto de `IntegrityError` se relanza. (g) Importo `_LIMA` (privado) de `domain.py`: no lo modifiqué; si prefieren, hacerlo público en otra tarea.
4. Estático: `uv run ruff format --check .` → 174 files already formatted; `uv run ruff check .` → All checks passed; capas (grep) → vacío.
5. BD local: `alembic upgrade head` → 0009→0010; `alembic check` → No new upgrade operations detected; `downgrade -1` → `upgrade head` → `alembic check` limpio; `alembic current` → 0010 (head). `import valmont.modules.orders.adapters.persistence` OK.
6. NO EJECUTADO: pruebas (D-028, D-033). El SQL del repositorio (`SKIP LOCKED`, `FOR UPDATE`, filtros, orden) solo está comprobado por QA, no por mí.
7. Pendiente de QA: añadir las 4 tablas al mapa de `tests/test_app_role.py` (orders y deliveries: SELECT/INSERT/UPDATE; líneas e historial: SELECT/INSERT).
8. Entrega: preparado, sin commit. Mensaje propuesto: `feat(orders): esquema 0010 y repositorio de pedidos (T-073)`.

#### Traspaso T-071 y T-072 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW (T-071, T-072). Sin pruebas ejecutadas por mí (D-033).
2. T-071: `cart/adapters/wiring.py` (`get_prepare_checkout`, `get_remove_checked_out_items`), `inventory/adapters/wiring.py` (`get_reserve_stock`, `get_consume_reservations`, `get_release_reservations`), `InsufficientStock` reexportada en `inventory/application.py` (con `# noqa: F401`), tres campos `pickup_store_*` en `Settings` y `.env.example` comentado.
3. T-072: `orders/__init__.py` (vacío) y `orders/domain.py` con las firmas del paquete.
4. Decisiones de lectura (no contradicen la SPEC): `admin_targets(pendiente_pago)={cancelado}` (R10, R19); `Order` valida lineas no vacías y reembolso solo en `cancelado` y total; `Order.history` e `idempotency_key` llevan valor por defecto; `OrderLine` exige quantity ≥ 1 y precios ≥ 1 (ValueError); `estimated_delivery_on` trata un `created_at` sin zona como UTC; en `build_order` solo cuentan las líneas `made_to_order` para R5; `reference` vacía → None en `shipping` y en `pickup` cualquier valor no `None` (incluida "") es DeliveryInvalid; nombre y ubicación y dirección colapsan espacios.
5. Estático: `uv run ruff format .` → 161 files left unchanged; `uv run ruff check .` → All checks passed; capas (grep de fastapi/pydantic/sqlalchemy/zoneinfo/valmont en orders) → vacío. NO EJECUTADO: pruebas (D-028, D-033).

#### Traspaso T-070 (D-040) — 2026-11-26 — module-coordinator
1. Estado final: IN_REVIEW. SPEC y STATUS actualizados con D-040; sin preguntas de negocio abiertas.
2. Cambios: dos modalidades de entrega (`shipping`, `pickup`; envío gratis a todo el Perú; sin DNI); nuevo estado `listo_para_recojo` (ocho estados; transiciones por modalidad); `deliveries` con `delivery_method` y `CHECK` de coherencia con `IS NOT NULL` explícitos; contrato con `delivery_method` (unión discriminada), `pickup_store` y 409 `pickup_unavailable`; R13 reescrita y R20 nueva; CA-04, 18, 19, 23 ajustados y CA-26 nueva; §12 pasa a "Decisiones tomadas (D-040)" con las hipótesis H-1…H-6.
3. Archivos: `docs/modules/orders/SPEC.md`, `docs/modules/orders/STATUS.md`.
4. Decisiones: D-040 (la registra el Leader). H-5 y H-6 son mías; el resto de hipótesis, del Leader. Lectura de H-4: se cancela hasta antes de `enviado` o `listo_para_recojo` (desde estos dos no).
5. Pruebas ejecutadas: ninguna (documentación).
6. Dependencias: T-071 incorpora E-4 (campos `pickup_store_*` en `shared/config.py` y `.env.example`, cambio aditivo en un archivo compartido que D-040 implica; el Leader lo confirma).
7. Riesgos: `get_settings` está en caché, así que cambiar la boutique exige reiniciar el backend; el detalle muestra la boutique vigente, no una copia.
8. Siguiente acción: el Leader registra D-040, la excepción (7) y las filas de `tasks.md`.
9. Commits: ninguno (sin `git add`).

#### Traspaso T-070 — 2026-11-26 — module-coordinator
1. Estado final: IN_REVIEW (SPEC y STATUS completos; pendientes las aprobaciones y las preguntas de la SPEC §12).
2. Cambios: `SPEC.md` y `STATUS.md` de orders, con 10 casos de uso, 19 reglas, máquina de estados, esquema `0010`, contrato API, 25 criterios y plan de pruebas; 15 paquetes T-071…T-084.
3. Archivos modificados: `docs/modules/orders/SPEC.md`, `docs/modules/orders/STATUS.md`.
4. Decisiones tomadas: el diseño original usó las recomendaciones de las preguntas P-1…P-11 y E-1…E-3; D-040 (traspaso de arriba) las confirma o las sustituye por la decisión del usuario.
5. Pruebas ejecutadas → resultado observado: ninguna (documentación). Comprobación de trazabilidad: `for id in RF04.01 … RF13.03; grep` en la SPEC → sin faltantes y cada RF en al menos un CA.
6. Pruebas no ejecutadas y motivo: no aplica.
7. Dependencias pendientes: aprobación del contrato por backend-lead y frontend-lead; E-1, E-2 y E-3 por el Leader; Figma (T-111) para T-082…T-084.
8. Riesgos conocidos: ver "Discrepancias y riesgos".
9. Preguntas que requieren decisión: SPEC §12.
10. Documentación actualizada: ninguna fuera de `docs/modules/orders/` (las filas de `tasks.md` y `_registry.md` y la excepción (7) de `modules.md` los añade el Leader).
11. Siguiente acción recomendada: el Leader resuelve E-1…E-3 y las preguntas; con eso T-071 y T-072 pasan a READY y qa-reviewer empieza las pruebas de T-072.
12. Commits: ninguno (documentación sin commit; sin `git add`, a petición del paquete).

## Discrepancias y riesgos

- **D-1 (RF05.05 y `modules.md` §3) — RESUELTA en D-040 (E-3):** el reembolso simulado es un dato de orders; payments no necesita puerto. El Leader refleja la reasignación de RF05.05 en `modules.md` §3.
- **D-2 (RN-05 y la recuperación de la compra) — RESUELTA en D-040 (P-6):** "volver a comprar" en la interfaz con la API del carrito (T-083).
- **D-3 (inventory SPEC §6, FK anunciada) — RESUELTA en D-040 (P-11):** no se añade en el MVP; la `0005` queda con su nota.
- **D-4 (`CheckoutLine` sin imagen ni `slug`):** el pedido no guarda imagen; si Figma la exige en "mis pedidos", hay que ampliar `CheckoutLine` en cart (cambio aditivo) o leer la imagen actual con el lector compartido.
- **R-1 (dinero y stock):** carreras entre pago, cancelación y vencimiento; mitigadas con el bloqueo del pedido y de las reservas en un orden fijo (R4) y comprobadas en CA-15 y CA-24; la auditoría final de seguridad de orders se lanza con Opus (decisions.md).
- **R-2 (lecturas que escriben):** la caducidad perezosa escribe en un `GET`. El límite de 200 y `SKIP LOCKED` acotan el coste; un `GET` repetido no duplica nada. Si el volumen lo exige, un proceso periódico llamaría al mismo `ExpireOverdueOrders` (sin cambiar la SPEC).
- **R-3 (reloj):** `now()` de PostgreSQL es la hora de inicio de la transacción; un pago que empieza antes del vencimiento y espera un bloqueo puede confirmarse unos milisegundos después. INVENTORY-R11 protege el stock; el borde se prueba (CA-13, 15).
- **R-4 (idempotencia sin huella):** reintentar la misma clave con otro cuerpo devuelve el pedido original. Aceptado para el MVP (R8).
- **R-5 (datos personales):** la dirección y el teléfono del pedido son datos personales (Ley 29733). El derecho de supresión y la retención no están en el MVP; el FK `RESTRICT` a perfiles impide borrar un cliente con pedidos y hará falta una política de anonimización antes de producción.
- **R-6 (duplicación de reglas):** `DeliveryDetails` duplica la normalización de teléfono y texto de identity porque no se importa su dominio; si el Leader prefiere compartirla, se mueve a `shared/` en una tarea aparte.
- **R-7 (decisiones D-040):** tope de 3 pedidos sin pagar y reembolso solo total.
- **R-8 (recojo en tienda, H-1…H-6):** una sola boutique en `Settings`; el cambio de horario o dirección requiere reiniciar el backend (`get_settings` en caché) y el detalle muestra siempre los datos vigentes; con más de una boutique habría que pasar a una tabla (cambio de modelo no trivial). La coherencia método-estado (`enviado` solo en `shipping`, `listo_para_recojo` solo en `pickup`) la impone el dominio, no la BD.
- **R-9 (QA de T-073, menor):** `SqlClock.now()` devuelve la hora en la zona de la sesión de la BD; la local está en UTC. T-074 lo normaliza con `.astimezone(UTC)` si toca `SqlClock`, o lo deja anotado para el despliegue.
- **R-10 (QA de T-073, menor):** `apply` lanza `InvalidTransition(..., frozenset())`; el 409 de §7 (`details.allowed`) lo calcula el caso de uso con `admin_targets` (T-079).
- **R-11 (QA de T-074, a resolver en T-075):** el dominio `Order` y `SqlOrderRepository.get` no cargan `carrier`, `tracking_code` ni `shipped_at` (están en `app.deliveries`), y `DeliveryOut` los emite como `null`. Es correcto para pedidos nuevos; para leer pedidos enviados, T-075 debe añadirlos a `DeliveryDetails` u `Order` (o a un objeto `Delivery`, SPEC §5) y al repositorio, y T-079 los escribe al enviar. RESUELTA en T-075 (ca7a40a): ruta A; el repositorio devuelve `Delivery` solo cuando hay datos de envío.
- **R-12 (T-076, aceptado):** cancelar un pedido vencido responde 409 `not_cancellable` con `status: "expirado"`. El 409 deshace la transacción, así que la caducidad (historial `system`, auditoría y liberación) se guarda en la siguiente lectura (R7 perezosa). La disponibilidad ya ignora las reservas vencidas, así que el stock no queda retenido. CA-15 se probó con un pago simulado (repositorio + `ConsumeReservations`); se repite con `ConfirmOrderPayment` real en T-077.
- **R-13 (T-077, para payments):** `GetPayableOrder` y `ConfirmOrderPayment` existen en `application.py`, pero orders aún no expone `adapters/wiring.py` con sus proveedores (excepción (7)). La primera tarea de implementación de payments (T-091 o la que la SPEC T-090 asigne) crea `modules/orders/adapters/wiring.py` con `get_get_payable_order` y `get_confirm_order_payment`, igual que los de cart e inventory en T-071. CA-15 y CA-24 ya se verificaron con el `ConfirmOrderPayment` real (T-077).
