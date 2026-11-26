# cart — Estado
> Fase: 4 · Estado del módulo: SPECIFICATION (SPEC PROPUESTA; pendiente de la aprobación del contrato por backend-lead y frontend-lead, de la excepción (6) de `modules.md` §3 por el Leader y de las preguntas P-CART-1…P-CART-7) · Última actualización: 2026-11-26 module-coordinator

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-055 | SPEC de cart | module-coordinator | RF03, D-015, D-017, D-022, D-023, D-037 | IN_REVIEW (SPEC propuesta; falta aprobación) |
| T-056 | Migración `0008`, dominio y repositorio del carrito | backend-dev + qa-reviewer | T-055 aprobada; excepción (6); T-021, T-026, T-016 integradas | DONE (QA APROBADO en la ronda 2: 843 + 542) |
| T-057 | Lectura del carrito (`GetCart`, lector de producto, disponibilidad y precio) y `GET /cart` | backend-dev + qa-reviewer | T-056, T-044 (inventory), T-051 (promotions) | IN_REVIEW |
| T-058 | Agregar, cambiar cantidad, seleccionar y retirar (3 rutas) | backend-dev + qa-reviewer | T-057 | BACKLOG |
| T-059 | Puerto para orders: `PrepareCheckout` y `RemoveCheckedOutItems` | backend-dev + qa-reviewer | T-057 | BACKLOG |
| T-060 | Pantalla del carrito (checkout) y cliente de API | frontend-dev + qa-reviewer | T-057, T-058, T-111 (VIEWS.md y Figma) | BACKLOG (no READY: sin diseño) |

IDs reservados del módulo: T-055–T-064. En uso: T-055–T-060; **libres: T-061–T-064** (correcciones `fix`, o la división de T-060 por frontend-lead). Orden: T-056 → T-057 → (T-058 ∥ T-059) → T-060. T-058 y T-059 tocan archivos distintos (ver "Puede modificar") y se pueden implementar en paralelo; se integran en ese orden.

Rutas disjuntas (D-033): quien implementa escribe solo `backend/src/**` y las migraciones indicadas; qa-reviewer escribe solo `backend/tests/**` (y, en T-060, `frontend/tests/**` y `frontend/e2e/**`). Todos los paquetes de backend siguen la skill `backend-module-implementation`, con la estructura `modules/cart/{domain.py, application.py, adapters/persistence.py, adapters/http.py}`.

## Paquetes de tarea

### T-056 — Esquema, dominio y repositorio del carrito
- Objetivo: las tablas `carts` y `cart_items` existen con sus restricciones; el dominio aplica R2 y R3; el repositorio crea y bloquea el carrito del usuario y guarda artículos.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: cart · Requisitos: RF03.01–RF03.04, RF03.07 · Reglas: CART-R1, R2, R3, R15, RN-02 · Decisiones: D-015, D-033
- Leer: `docs/modules/cart/SPEC.md` §4 (R1–R3, R15), §5 y §6; skills `backend-module-implementation` y `database-migration-review`; como referencia `backend/migrations/versions/0007_promotions.py` y `0005_inventory.py` (FK, `op.f`, `downgrade`), `backend/src/valmont/modules/inventory/` (estructura, `lock()`) y `backend/src/valmont/shared/db.py`.
- Contratos aplicables: SPEC §6 (esquema exacto).
- Dependencias: SPEC aprobada; **excepción (6) de `docs/modules.md` §3 aprobada** (FK a `app.profiles` y `app.products`); T-016 (perfiles), T-026 (productos).
- Puede modificar: `backend/src/valmont/modules/cart/**` (nuevo, con `__init__.py`; `domain.py`, `application.py` solo el puerto `CartRepository`, `adapters/__init__.py`, `adapters/persistence.py`), `backend/migrations/env.py` (solo la línea de registro), `backend/migrations/versions/0008_cart.py` (nuevo, `--rev-id 0008`) y su traspaso en este STATUS.
- Protegido: todo lo demás, en especial `modules/catalog/**`, `modules/inventory/**`, `modules/promotions/**`, `backend/tests/**`, `main.py` y `shared/`. Sin endpoints (T-057/T-058). Sin dependencias nuevas.
- Resultado esperado: migración `0008` exactamente como SPEC §6 con `downgrade` (primero `cart_items`); dominio puro (sin `fastapi`, `pydantic`, `sqlalchemy`) con las constantes, `Cart`, `CartItem` y los errores; puerto `CartRepository` y su implementación SQL.
- Criterios de aceptación: CA-CART-15, la parte de dominio de CA-02, CA-04 y CA-05 (R2, R3) y la creación perezosa y única del carrito de CA-02 (`ON CONFLICT`), contra la BD.
- Firmas públicas (contra las que escribe QA; no se cambian sin avisar):
  - `valmont.modules.cart.domain`:
    - `CART_ITEM_MAX_QUANTITY = 5`, `CART_MAX_LINES = 20`
    - `class CartError(Exception)`; `QuantityLimit(CartError)`, `CartFull(CartError)`, `ItemNotInCart(CartError)`
    - `@dataclass(frozen=True) class CartItem`: `product_id: UUID`, `quantity: int`, `selected: bool`, `created_at: datetime`
    - `@dataclass(frozen=True) class Cart`: `id: UUID`, `user_id: UUID`, `items: tuple[CartItem, ...]`; `add(product_id, quantity, now) -> Cart` (suma si existe; `QuantityLimit` si supera 5; `CartFull` si es nuevo y hay 20; el artículo nuevo nace `selected=True`), `set_quantity(product_id, quantity) -> Cart` y `set_selected(product_id, selected) -> Cart` (`ItemNotInCart` si falta; `QuantityLimit` si `quantity` ∉ 1–5), `remove(product_id) -> Cart` (idempotente)
  - `valmont.modules.cart.application`: `class CartRepository(Protocol)`:
    - `lock_for_user(user_id: UUID) -> Cart`: crea el carrito si falta (`INSERT … ON CONFLICT (user_id) DO NOTHING`), lo bloquea `FOR UPDATE` y lo devuelve con sus artículos (R1)
    - `find_for_user(user_id: UUID) -> Cart | None`: lectura sin bloqueo ni escritura
    - `save(cart: Cart) -> None`: persiste el estado del carrito (artículos nuevos, cantidades y `selected` cambiados, artículos retirados) y actualiza `updated_at`; solo con la fila bloqueada
    - `InvalidReference(Exception)` en `adapters.persistence`, que lanza `save` si la FK a producto falla (`field = "product_id"`)
  - `valmont.modules.cart.adapters.persistence`: `SqlCartRepository(session)`.
  - BD: tablas `app.carts` y `app.cart_items` con los nombres y columnas de SPEC §6.
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check` y `downgrade -1` + `upgrade head`): unitarias de `Cart` (tabla de R2 y R3: sumar, tope de 5, la línea 21, `selected` por defecto, idempotencia de `remove`, inmutabilidad); integración de la migración y de cada restricción de §6, `lock_for_user` (crea una vez, dos conexiones concurrentes → un solo carrito) y `save`.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): en Supabase Studio local (solo lectura) aparecen `app.carts` y `app.cart_items` con sus restricciones y sin filas; `uv run alembic current` indica `0008`.
- Seguridad: SQL parametrizado; las restricciones de la BD son la última defensa; el repositorio solo recibe `user_id` (del token, nunca del cliente).
- Estado inicial: READY (SPEC y excepción (6) aprobadas el 2026-11-26, D-038).
- Entrega: cambio preparado sin commit (`git add <rutas>`) y mensaje propuesto en el punto 12, p. ej. `feat(cart): esquema, dominio y repositorio del carrito (T-056)`; qa-reviewer lo verifica y el Leader hace el commit (§11.2, D-033, D-036).
- IDs reservados: ninguno.
- Escalar si: hace falta otra tabla o columna de otro módulo, el repositorio no puede garantizar el carrito único sin un índice adicional, o aparece una dependencia nueva.

### T-057 — Lectura del carrito y `GET /cart`
- Objetivo: el cliente ve su carrito con precios vigentes, subtotales, `status`, `max_quantity`, total y `can_checkout`, calculados en el servidor.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: cart · Requisitos: RF03.05, RF03.06, RF03.07 · Reglas: CART-R4, R7, R8, R9, R12, R13, R15, RN-09, RN-14 · Decisiones: D-017, D-022, D-023, D-037
- Leer: SPEC §3 (UC-CART-01), §4 (R4, R7–R9), §7 (`CartOut`, `CartItemOut`, `GET`) y §8 (lectura en una consulta); la vista `app.product_availability` en `0005_inventory.py` y `app.product_effective_price` en `0007_promotions.py`; `backend/src/valmont/modules/catalog/adapters/persistence.py` (tablas ligeras `_AVAILABILITY` y `_EFFECTIVE_PRICE`, patrón a seguir) y `adapters/http.py` (`_image_url`, `ProductImageOut`); `identity/adapters/http.py` (`current_user`).
- Contratos aplicables: SPEC §7 (PROPUESTO; el desarrollo empieza con la aprobación de backend-lead y frontend-lead).
- Dependencias: T-056; T-044 (inventory) y T-051 (promotions) integradas; excepción (6) aprobada.
- Puede modificar: `backend/src/valmont/modules/cart/domain.py` (`CartLineStatus`, `line_status`, `max_quantity`), `application.py` (`ProductSnapshot`, `CartCatalog`, `CartView`, `CartLineView`, `GetCart`), `adapters/persistence.py` (`SqlCartCatalog`), `adapters/http.py` (nuevo; router y esquemas), `backend/src/valmont/main.py` (solo registrar el router) y su traspaso en este STATUS.
- Protegido: `backend/migrations/**` (si falta algo, se escala), el resto de módulos, `shared/` y `backend/tests/**`.
- Resultado esperado: `GET /api/v1/cart` con `current_user`; el lector lee, en **una sola consulta** y con tablas ligeras de solo lectura, las líneas del carrito unidas a `app.products` (solo las columnas de SPEC §8), `app.product_availability`, `app.product_effective_price` y la primera imagen de `app.product_images`; no importa nada de otros módulos; los productos no publicados no devuelven datos más allá de nombre y `slug`; el importe se calcula en Python con enteros; la lectura no escribe.
- Criterios de aceptación: CA-CART-01, 08, 09, 10, 11 (lectura) y 16 (OpenAPI de `GET`).
- Firmas públicas:
  - HTTP: `GET /api/v1/cart` → `CartOut` (SPEC §7); códigos 200, 401, 503.
  - `valmont.modules.cart.domain`: `class CartLineStatus(StrEnum)`: `OK="ok"`, `INSUFFICIENT_STOCK="insufficient_stock"`, `OUT_OF_STOCK="out_of_stock"`, `UNAVAILABLE="unavailable"`; `line_status(published: bool, order_policy: str, available: int, quantity: int) -> CartLineStatus`; `max_quantity(published: bool, order_policy: str, available: int) -> int` (R4, R7).
  - `valmont.modules.cart.application`:
    - `@dataclass(frozen=True) class ProductSnapshot`: `product_id: UUID`, `sku: str`, `slug: str`, `name: str`, `image_path: str | None`, `alt: str | None`, `order_policy: str`, `available: int`, `availability_status: str`, `lead_time_days: int | None`, `list_price: int`, `price: int`, `discount_amount: int`, `promotion_id: UUID | None`
    - `class CartCatalog(Protocol)`: `get_published(product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]` (solo publicados; los demás no aparecen; vacío sin consultar; duplicados ignorados) y `get_names(product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]` (nombre y `slug` de cualquier producto, para los `unavailable`)
    - `@dataclass(frozen=True) class CartLineView`: `product_id`, `sku: str | None`, `slug: str`, `name: str`, `image_path: str | None`, `alt: str | None`, `quantity: int`, `selected: bool`, `status: CartLineStatus`, `availability_status: str | None`, `lead_time_days: int | None`, `max_quantity: int`, `unit_price: int | None`, `original_price: int | None`, `discount_amount: int | None`, `subtotal: int | None`
    - `@dataclass(frozen=True) class CartView`: `lines: tuple[CartLineView, ...]`, `selected_count: int`, `total: int`, `can_checkout: bool`
    - `class GetCart`: `__init__(self, carts: CartRepository, catalog: CartCatalog)`, `__call__(self, user_id: UUID) -> CartView`
  - `adapters.persistence`: `SqlCartCatalog(session)`.
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; mismas puertas que T-056, más OpenAPI): `line_status` y `max_quantity` con la tabla de políticas; `GetCart` con repositorio y catálogo falsos (total, `can_checkout`, orden, `unavailable`); integración del lector con productos de cada política, con y sin promoción (los tres alcances), reservas vigentes y vencidas, despublicado, sin imagen y **una sola consulta** para varias líneas; el precio es igual al de catalog para el mismo producto; HTTP con dos usuarios y sin token.
- Diseño (frontend): no aplica (la pantalla es T-060).
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:8000/docs`, con un token de cliente de desarrollo, `GET /api/v1/cart` devuelve el carrito vacío (`items: []`, `total` 0); sin token, 401. Los artículos se prueban tras T-058.
- Seguridad: la identidad sale de `current_user`; ninguna consulta acepta un id de usuario o de carrito; un producto despublicado no filtra más que nombre y `slug`; precios y estados solo del servidor.
- Estado inicial: BACKLOG → READY al integrar T-056 y recibir las aprobaciones.
- Entrega: como T-056; mensaje propuesto `feat(cart): lectura del carrito con precios y disponibilidad (T-057)`.
- IDs reservados: ninguno.
- Escalar si: la consulta no se puede resolver en una sola lectura, hace falta una columna o vista que la excepción (6) no cubre, o frontend-lead objeta la forma de `CartOut`.

### T-058 — Agregar, cambiar cantidad, seleccionar y retirar artículos
- Objetivo: el cliente agrega, cambia la cantidad, marca o desmarca y retira artículos, con la validación de disponibilidad y los límites de la SPEC.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: cart · Requisitos: RF03.01, RF03.02, RF03.03, RF03.04, RF03.06, RF03.07 · Reglas: CART-R1, R2, R3, R5, R6, RN-05, RN-16 · Decisiones: D-017, D-023
- Leer: SPEC §3 (UC-CART-02 a 05), §4 (R1–R6), §7 (`POST`, `PATCH`, `DELETE`, validación y tabla de 409); el código de T-056 y T-057 en `modules/cart/`; `shared/errors.py` (`AppError`, `ERROR_RESPONSES`); `backend/src/valmont/modules/catalog/adapters/admin_http.py` (traducción de errores de dominio a HTTP, patrón).
- Contratos aplicables: SPEC §7 (PROPUESTO; aprobación como T-057).
- Dependencias: T-057.
- Puede modificar: `backend/src/valmont/modules/cart/application.py` (casos de uso y errores), `adapters/http.py` (3 rutas y esquemas de entrada, traducción a 404/409/422) y su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py` y `backend/migrations/**` (de T-056/T-057: si falta algo, se escala), el resto de módulos, `main.py`, `shared/` y `backend/tests/**`.
- Resultado esperado: tres rutas que devuelven siempre `CartOut`; casos de uso que **bloquean el carrito** (`lock_for_user`), leen los datos del producto con `CartCatalog.get_published`, validan R5 y R6, guardan con `save` y devuelven `GetCart`'s `CartView` de la misma transacción; un rechazo no deja ningún cambio.
- Criterios de aceptación: CA-CART-02 a 07, 10 y 11 (escritura) y 16 (OpenAPI de las tres rutas).
- Firmas públicas:
  - HTTP: `POST /api/v1/cart/items`, `PATCH /api/v1/cart/items/{product_id}`, `DELETE /api/v1/cart/items/{product_id}` con los cuerpos, respuestas y códigos de SPEC §7 (401, 404, 409 con `code` ∈ {`quantity_limit`, `out_of_stock`, `insufficient_stock`, `cart_full`} y `details` de la SPEC, 422, 503).
  - `valmont.modules.cart.application`:
    - `class ProductNotAvailable(Exception)` (→ 422 con `loc ["body","product_id"]`); `class CartItemNotFound(Exception)` (→ 404); `class ItemOutOfStock(Exception)`, `class ItemInsufficientStock(Exception)` (ambas con `.max_quantity: int`); `QuantityLimit` y `CartFull` del dominio
    - `AddToCart(carts: CartRepository, catalog: CartCatalog)`: `__call__(user_id: UUID, product_id: UUID, quantity: int = 1) -> CartView`
    - `UpdateCartItem(carts, catalog)`: `__call__(user_id: UUID, product_id: UUID, quantity: int | None = None, selected: bool | None = None) -> CartView` (con ambos ausentes lanza `ValueError`; el router ya lo da como 422)
    - `RemoveFromCart(carts, catalog)`: `__call__(user_id: UUID, product_id: UUID) -> CartView`
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-057): tabla de R5 (política × disponibilidad × cantidad actual × pedida; `out_of_stock` vs `insufficient_stock` vs `quantity_limit`; la línea 21; bajar la cantidad siempre; `selected` sin mirar stock); un rechazo no cambia nada; HTTP con los 422 por `loc`, los 409 con `code` y `details`, el campo extra y `user_id`/`cart_id` en el cuerpo (422); aislamiento entre dos usuarios; dos `POST` concurrentes del mismo usuario (un carrito, cantidades sumadas, sin 500).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): en `/docs` con un token de cliente: agregar un reloj (200, `selected` verdadero), agregarlo de nuevo (cantidad suma), subir la cantidad por encima del tope o del stock (409 con su `code`), bajarla, desmarcar (el `total` baja), retirar (200 y 200 otra vez), agregar uno en borrador o inexistente (422), sin token (401); con un reloj agotado, 409 `out_of_stock`; con uno bajo pedido, se agrega con su plazo.
- Seguridad: el carrito siempre es el del token; el `product_id` de ruta solo se busca en el carrito propio; sin precios en el cuerpo.
- Estado inicial: BACKLOG → READY al integrar T-057.
- Entrega: como T-056; mensaje propuesto `feat(cart): agregar, cambiar, seleccionar y retirar artículos del carrito (T-058)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso, hace falta cambiar el esquema o `CartRepository`, o dos operaciones del carrito se bloquean entre sí.

### T-059 — Puerto de cart para orders
- Objetivo: orders puede pedir los artículos seleccionados ya validados y con su precio vigente, y retirar los comprados, dentro de su transacción.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: cart · Requisitos: RF03.05, RF03.06, RF04.01 (lado cart), RN-05 · Reglas: CART-R8, R10, R11 · Decisiones: D-017, D-037
- Leer: SPEC §3 (UC-CART-06 y 07), §4 (R8, R10, R11) y §8 (firmas y obligaciones de orders); `docs/modules/inventory/SPEC.md` §3 (UC-INVENTORY-04, `ReserveStock`) y §4 (INVENTORY-R4, orden de bloqueos); `docs/modules/promotions/SPEC.md` §8 (obligaciones al usar el precio); el código de T-056 y T-057.
- Contratos aplicables: SPEC §8 (PROPUESTO; lo cierra la SPEC de orders: si orders pide otra forma, se actualiza aquí antes de implementar).
- Dependencias: T-057.
- Puede modificar: `backend/src/valmont/modules/cart/application.py` (`CheckoutLine`, `CheckoutCart`, `CartIssue`, `EmptySelection`, `CheckoutBlocked`, `PrepareCheckout`, `RemoveCheckedOutItems`) y su traspaso en este STATUS. Si hace falta un método nuevo de `CartRepository`, **se escala** (es de T-056).
- Protegido: `domain.py`, `adapters/**`, `backend/migrations/**`, el resto de módulos, `main.py`, `shared/` y `backend/tests/**`. Sin endpoints: son casos de uso internos.
- Resultado esperado: `PrepareCheckout` bloquea el carrito (`lock_for_user`), toma los seleccionados, los evalúa con `CartCatalog.get_published` y `line_status` (R7, R8) y devuelve `CheckoutCart` o lanza `EmptySelection` / `CheckoutBlocked`; `RemoveCheckedOutItems` retira solo los `product_ids` dados. Ninguno hace commit: corren en la transacción de orders.
- Criterios de aceptación: CA-CART-12, 13 y 14.
- Firmas públicas:
  - `@dataclass(frozen=True) class CheckoutLine`: `product_id: UUID`, `sku: str`, `name: str`, `quantity: int`, `list_price: int`, `price: int`, `discount_amount: int`, `promotion_id: UUID | None`, `availability_status: str`, `lead_time_days: int | None`
  - `@dataclass(frozen=True) class CheckoutCart`: `lines: tuple[CheckoutLine, ...]` (no vacía), `total: int`
  - `@dataclass(frozen=True) class CartIssue`: `product_id: UUID`, `status: CartLineStatus`
  - `class EmptySelection(Exception)`; `class CheckoutBlocked(Exception)` con `.issues: tuple[CartIssue, ...]` (en el orden de las líneas)
  - `PrepareCheckout(carts: CartRepository, catalog: CartCatalog)`: `__call__(user_id: UUID) -> CheckoutCart`
  - `RemoveCheckedOutItems(carts: CartRepository)`: `__call__(user_id: UUID, product_ids: Collection[UUID]) -> None`
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-057): con repositorio y catálogo falsos (solo seleccionados, `total`, `EmptySelection`, `CheckoutBlocked` por cada `status` no `ok`, un no seleccionado agotado no bloquea, ningún efecto al bloquear, ids ausentes ignorados) y de integración con la BD y **dos conexiones reales** (el segundo `PrepareCheckout` espera al primero y recibe `EmptySelection`; deshacer la transacción deja el carrito intacto).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): no tiene ruta HTTP; se comprueba al integrar orders. Hasta entonces, `uv run pytest` lo ejecuta qa-reviewer y el usuario revisa el veredicto.
- Seguridad: el `user_id` lo pasa orders desde el token validado, nunca desde el cuerpo; devuelve solo los datos del carrito de ese usuario; no acepta precios del cliente.
- Estado inicial: BACKLOG → READY al integrar T-057 y confirmarse la forma del puerto con orders.
- Entrega: como T-056; mensaje propuesto `feat(cart): puerto de preparación de la compra para orders (T-059)`.
- IDs reservados: ninguno.
- Escalar si: orders necesita otro dato en `CheckoutLine`, otro orden de bloqueos o que cart no bloquee el carrito.

### T-060 — Pantalla del carrito y cliente de API
- Objetivo: el cliente ve y edita su carrito en el área `checkout` y puede seguir a la compra solo cuando el servidor lo permite.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: cart (frontend) · Requisitos: RF03.01–RF03.07
- Leer: SPEC §7; `docs/design_ui/DESIGN.md` (componente «precio (con promoción)»); `docs/design_ui/VIEWS.md` y los nodos de Figma que asigne frontend-lead (**aún no existen**: T-110/T-111); skill `frontend-module-implementation`; `frontend/src/lib/api/` (clientes existentes).
- Contratos aplicables: SPEC §7 aprobada y el OpenAPI de T-057 y T-058.
- Dependencias: T-057, T-058 y T-111.
- Puede modificar: lo que fije frontend-lead al dividir la tarea (previsto: `frontend/src/lib/api/cart.ts`, `frontend/src/components/checkout/cart/**`, la página del carrito y el botón "añadir al carrito" de la ficha del producto).
- Protegido: `backend/**`, `docs/design_ui/**` (salvo lo que frontend-lead asigne) y todo lo no previsto.
- Resultado esperado (previsto, a cerrar con los nodos): lista de artículos con miniatura, nombre, precio vigente (con el anterior tachado si existe), selector de cantidad con tope `max_quantity`, casilla de selección, "retirar", aviso por `status` (agotado, stock insuficiente, ya no disponible), plazo de Bajo pedido, total de los seleccionados y botón de continuar habilitado solo con `can_checkout`; estados de carga, vacío, error y éxito; un `409` se muestra con su mensaje y no rompe la pantalla. El frontend muestra importes en `es-PE` y **nunca calcula** importes ni estados.
- Criterios de aceptación: CA-CART-01 a 11 en lo visible y el E2E del plan de pruebas (§11), a concretar con VIEWS.md.
- Firmas públicas (PROPUESTAS por este coordinador; las cierra frontend-lead con VIEWS.md):
  - Cliente `frontend/src/lib/api/cart.ts`: `getCart()`, `addToCart(productId, quantity?)`, `updateCartItem(productId, {quantity?, selected?})`, `removeFromCart(productId)`; tipos de la SPEC §7 (`Cart`, `CartItem`, con `status` como unión literal).
  - Componente de precio: el de `VIEWS.md` (props `price`, `originalPrice`, `discountAmount`).
- Pruebas obligatorias: las escribe qa-reviewer (componentes y E2E con Playwright: agregar → cambiar cantidad → desmarcar → ver el total → retirar) cuando el paquete esté READY.
- Diseño (frontend): nodos de Figma por definir (T-111); reutilizar el componente de precio y los controles de `VIEWS.md`.
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:4321`, iniciar sesión, agregar relojes desde la ficha, cambiar cantidades, desmarcar uno y ver bajar el total, retirar, y comprobar el aviso de un reloj agotado.
- Seguridad: ocultar controles no es autorización; el backend decide; sin secretos en el cliente; solo `lib/api/` hace `fetch`.
- Estado inicial: **BACKLOG** (no READY: faltan VIEWS.md y los nodos; las firmas son provisionales).
- Entrega: como T-056; mensaje propuesto `feat(frontend): pantalla del carrito (T-060)`.
- IDs reservados: ninguno; frontend-lead puede usar T-061–T-064 al dividirla.
- Escalar si: Figma no tiene la pantalla, el contrato no cubre un dato que el diseño exige o hace falta un componente fuera de `VIEWS.md`.

## Traspasos

#### Traspaso T-057 — 2026-11-26 — backend-dev
1. Estado final: IN_REVIEW. `GetCart`, `SqlCartCatalog` y `GET /api/v1/cart` implementados según las firmas del paquete.
2. Archivos: `modules/cart/{domain,application}.py`, `modules/cart/adapters/{persistence,http}.py`, `main.py` (2 líneas: import y `include_router`).
3. Lector: `get_published` es una sola consulta (products JOIN product_availability, LATERAL de product_effective_price y de la primera imagen, `status = 'published'`, `id IN ids`); `get_names` otra solo para los despublicados. Sin migraciones ni imports de otros módulos (solo `identity` `current_user`/`CurrentUser`).
4. `available`, precios y `promotion_id` salen de las vistas; `original_price` y `discount_amount` solo si `promotion_id` no es nulo; subtotal y total en Python (R8; los `unavailable` no suman).
5. `image.url` replica `_image_url` de catalog dentro de `adapters/http.py` (no se importa catalog); falta `alt` -> cadena vacía.
6. Análisis estático: `uv run ruff format .` -> 1 file reformatted; `uv run ruff check .` -> All checks passed; capas -> vacío. NO EJECUTADO: pruebas (D-028, D-033).
#### Traspaso T-056 — 2026-11-26 — backend-dev
1. Estado final: IN_REVIEW. Migración 0008, dominio, puerto y `SqlCartRepository` implementados según las firmas del paquete.
2. Archivos: `migrations/versions/0008_cart.py`, `migrations/env.py` (1 línea), `modules/cart/{__init__,domain,application}.py`, `modules/cart/adapters/{__init__,persistence}.py`.
3. NO EJECUTADO: pruebas, `alembic upgrade/check/downgrade` (D-028, D-033). Estático: `ruff format --check` y `ruff check` limpios.
4. Para QA: `backend/tests/test_app_role.py` debe incluir `carts` y `cart_items` con CRUD (la migración concede SELECT, INSERT, UPDATE, DELETE a `valmont_app`). `save` hace upsert (`ON CONFLICT (cart_id, product_id)`), borra los ausentes y toca `carts.updated_at`; `InvalidReference("product_id")` si salta `fk_cart_items_product_id_products`. `Cart.add` con cantidad < 1 lanza `QuantityLimit`; un artículo nuevo con cantidad > 5 también.

#### Traspaso T-055 — 2026-11-26 — module-coordinator
1. Estado final: IN_REVIEW. SPEC y STATUS de cart escritos; sin código ni pruebas.
2. Cambios: `SPEC.md` (alcance, 7 casos de uso, reglas R1–R15, modelo, migración 0008, contrato API de 4 rutas, puerto para orders, 16 criterios, plan de pruebas, 7 preguntas) y este `STATUS.md` (T-056…T-060 con firmas, pruebas y revisión manual).
3. Archivos modificados: `docs/modules/cart/SPEC.md`, `docs/modules/cart/STATUS.md`.
4. Decisiones tomadas: ninguna aprobada; hipótesis H-1…H-4 y recomendaciones de P-CART-1…7 en la SPEC §12.
5. Pruebas ejecutadas: cobertura RF03.01–07 con `grep` en la SPEC (ver el traspaso final). NO EJECUTADO: pruebas (tarea de documentación).
7. Dependencias pendientes: aprobación del contrato (backend-lead, frontend-lead); excepción (6) de `modules.md` §3 (Leader); respuestas a P-CART-1…5 (usuario).
8. Riesgos: ver "Discrepancias y riesgos".
11. Siguiente acción recomendada: el Leader decide P-CART-7 y registra la excepción (6); el usuario responde P-CART-1…5; después T-056 pasa a READY.
12. Commits: ninguno (la edición de `docs/modules/cart/**` la integra el Leader).

## Discrepancias y riesgos

- **Excepción (6) de `docs/modules.md` §3 (PROPUESTA, bloquea T-056 y T-057):** cart tiene FK a `app.profiles` y `app.products` y lee en SQL `app.products` (`id`, `sku`, `slug`, `name`, `status`, `order_policy`, `lead_time_days`), `app.product_images`, y las vistas `app.product_availability` y `app.product_effective_price`. **Discrepancia con promotions SPEC §8**, que preveía el puerto `GetEffectivePrices` para cart: no se puede enlazar a la sesión sin importar `promotions.adapters` (prohibido por §3) y no hay puertos por lotes de catalog ni de inventory. Se propone la lectura de las vistas (mismo patrón que catalog); si el Leader prefiere puertos, hay que añadir antes tres tareas fuera de cart.
- **Forma del puerto hacia orders (T-059):** `CheckoutLine`/`CheckoutCart` son propuesta de este módulo; orders (T-070…) puede pedir otra. Hay que cerrarla en la SPEC de orders antes de pasar T-059 a READY.
- **Bajo pedido con `backorder` y stock parcial:** con `backorder`, 1 ≤ disponible < cantidad, la vista da `low_stock`, pero `ReserveStock` (inventory) trata la línea entera como bajo pedido. El carrito dice `ok` y orders decide; el `availability_status` que ve el cliente puede ser `low_stock` mientras la entrega será bajo pedido. Se documenta; lo resuelve la SPEC de orders.
- **Estado de stock no garantizado:** el carrito no reserva (D-017); entre `PrepareCheckout` y la reserva el stock puede cambiar. La garantía firme es de orders (RN-06).
- **Precio cambiante (R12):** el carrito no congela el precio; orders debe mostrar el importe final antes de pagar.
- **Dependencia de diseño:** T-060 depende de T-111 (VIEWS.md y Figma), aún BLOCKED. El backend se cierra y revisa por `/docs` sin esperar.
- **Rango:** T-055–T-064; libres T-061–T-064 para `fix` o la división de T-060.
- **Pendiente para el Leader (fuera de `docs/modules/cart/**`, no tocado):** fila de T-055…T-060 en `docs/agents/tasks.md`, estado de `cart` en `docs/modules.md` §3 (BACKLOG → SPECIFICATION) y la excepción (6).
- **Token de cliente de desarrollo:** las revisiones manuales de T-057 y T-058 necesitan un token de cliente; `docs/setup.md` no lo describe todavía (mismo hueco que promotions con el de administrador).
