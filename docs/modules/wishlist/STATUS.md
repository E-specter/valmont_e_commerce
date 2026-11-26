# wishlist — Estado
> Fase: 4 · Estado del módulo: SPECIFICATION (SPEC PROPUESTA; preguntas resueltas en D-039; pendiente de la aprobación del contrato por backend-lead y frontend-lead y de que el Leader registre en `modules.md` §3 el lector compartido `shared/product_snapshots.py`) · Última actualización: 2026-11-26 module-coordinator

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-065 | SPEC de wishlist | module-coordinator | RF10, RN-03, D-037, D-038 | IN_REVIEW (SPEC propuesta; falta aprobación) |
| T-066 | Lector compartido de productos (extraído de cart), migración `0009`, dominio y repositorio de la lista | backend-dev + qa-reviewer | T-065 aprobada; lector compartido registrado en `modules.md` §3; T-016, T-026, T-057 integradas | READY |
| T-067 | Lectura de la lista (`GetWishlist`, lector de producto) y `GET /wishlist` | backend-dev + qa-reviewer | T-066, T-044 (inventory), T-051 (promotions) | BACKLOG |
| T-068 | Agregar y retirar (`POST` y `DELETE`) | backend-dev + qa-reviewer | T-067 | BACKLOG |
| T-069 | Pantalla de deseos (account) y cliente de API | frontend-dev + qa-reviewer | T-067, T-068, T-111 (VIEWS.md y Figma) | BACKLOG (no READY: sin diseño) |

IDs reservados del módulo: T-065–T-069; todos en uso (si hace falta un `fix`, se pide rango al Leader). Orden: T-066 → T-067 → T-068 → T-069. T-067 y T-068 tocan los mismos archivos (`application.py`, `adapters/http.py`): van **en serie**.

Rutas disjuntas (D-033): quien implementa escribe solo `backend/src/**` y la migración indicada; qa-reviewer escribe solo `backend/tests/wishlist/**` y `backend/tests/shared/**` (y, en T-069, `frontend/tests/**` y `frontend/e2e/**`). Estructura `modules/wishlist/{domain.py, application.py, adapters/persistence.py, adapters/http.py}` con la skill `backend-module-implementation`; la referencia es `modules/cart/` (mapeo HTTP, errores) y, en T-066, la consulta de `SqlCartCatalog` que se **mueve** a `shared/`, no se copia (D-039).

## Paquetes de tarea

### T-066 — Lector compartido de productos, esquema, dominio y repositorio de la lista
- Objetivo: la lectura de producto + disponibilidad + precio vigente + primera imagen vive en `valmont.shared.product_snapshots` y cart la usa **sin cambiar su comportamiento**; `app.wishlist_items` existe con sus restricciones y el repositorio agrega sin duplicar, retira y lista.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: wishlist (y `shared/`; toca cart solo en imports) · Requisitos: RF10.01, RF10.02, RF10.04, RN-03 · Reglas: WISH-R1, R4, R8 · Decisiones: D-033, D-039
- Leer: `docs/modules/wishlist/SPEC.md` §4 (R1, R4, R8), §5, §6 y §8; skills `backend-module-implementation` y `database-migration-review`; **`backend/src/valmont/modules/cart/adapters/persistence.py` (`SqlCartCatalog` y las tablas ligeras `_PRODUCT`, `_IMAGE`, `_AVAILABILITY`, `_PRICE_VIEW`, que se mueven), `cart/application.py` (`ProductSnapshot`) y `cart/adapters/http.py` (`_image_url`)**; como referencia de migración `backend/migrations/versions/0008_cart.py` y `CartItemRow` / `InvalidReference` / `pg_insert … on_conflict` de cart; `backend/src/valmont/shared/db.py`.
- Contratos aplicables: SPEC §6 (esquema exacto) y §8 (firmas del lector compartido).
- Dependencias: SPEC aprobada; el Leader registra el lector compartido en `docs/modules.md` §3; T-016 (perfiles), T-026 (productos), T-057 (cart, de donde se extrae).
- Puede modificar:
  - **Compartido:** `backend/src/valmont/shared/product_snapshots.py` (nuevo).
  - **Cart, solo para cambiar import y uso, sin tocar su lógica ni su contrato:** `modules/cart/application.py` (borrar la clase `ProductSnapshot` e importarla del módulo compartido, manteniendo el nombre accesible desde `cart.application`), `modules/cart/adapters/persistence.py` (borrar la consulta y las tablas ligeras de producto y dejar `SqlCartCatalog` como nombre de `SqlProductSnapshots`, p. ej. `SqlCartCatalog = SqlProductSnapshots`) y `modules/cart/adapters/http.py` (sustituir `_image_url` por `image_url` compartida).
  - **Catalog, solo para reutilizar la URL de imagen (decisión del Leader):** `modules/catalog/adapters/http.py`, sustituir su `_image_url` privada por `image_url` de `shared/product_snapshots.py`, con el mismo comportamiento (también el error de configuración). Así queda una sola implementación en todo el backend.
  - **Wishlist:** `backend/src/valmont/modules/wishlist/**` (nuevo, con `__init__.py`; `domain.py`, `application.py` solo `WishlistEntry` y el puerto `WishlistRepository`, `adapters/__init__.py`, `adapters/persistence.py`), `backend/migrations/env.py` (solo la línea de registro), `backend/migrations/versions/0009_wishlist.py` (nuevo, `--rev-id 0009`) y su traspaso en este STATUS.
- Protegido: el resto de cart (`domain.py`, `CartRepository`, `SqlCartRepository`, `CartCatalog`, casos de uso), el resto de `modules/catalog/**`, el resto de `modules/**`, `backend/tests/**`, `main.py` y el resto de `shared/`. Sin endpoints. Sin dependencias nuevas.
- Resultado esperado: un movimiento puro de código (la consulta, las tablas ligeras y `image_url` pasan a `shared/` con el mismo SQL y el mismo comportamiento); migración `0009` exactamente como SPEC §6 con `downgrade`; dominio puro (sin `fastapi`, `pydantic`, `sqlalchemy`); puerto e implementación SQL.
- Criterios de aceptación: CA-WISH-12 (cart sin regresión), CA-WISH-10 y, contra la BD, la parte de repositorio de CA-WISH-03 (`ON CONFLICT DO NOTHING`, una fila).
- Firmas públicas (contra las que escribe QA; no se cambian sin avisar):
  - `valmont.shared.product_snapshots` (SPEC §8): `ProductSnapshot` (frozen dataclass con los 14 campos de §8), `SqlProductSnapshots(session)` con `get_published(product_ids) -> dict[UUID, ProductSnapshot]` y `get_names(product_ids) -> dict[UUID, tuple[str, str]]`, y `image_url(storage_path: str) -> str`.
  - `valmont.modules.cart` (sin cambios de contrato): `cart.application.ProductSnapshot` y `cart.adapters.persistence.SqlCartCatalog` siguen importables con el mismo comportamiento.
  - `valmont.modules.wishlist.domain`: `WISHLIST_MAX_ITEMS = 50`; `class WishlistFull(Exception)`; `class WishlistItemStatus(StrEnum)`: `AVAILABLE="available"`, `UNAVAILABLE="unavailable"`.
  - `valmont.modules.wishlist.application`:
    - `@dataclass(frozen=True) class WishlistEntry`: `product_id: UUID`, `added_at: datetime`
    - `class WishlistRepository(Protocol)`:
      - `list_for_user(user_id: UUID) -> tuple[WishlistEntry, ...]`: más reciente primero y `product_id` (R8); sin bloqueo
      - `add(user_id: UUID, product_id: UUID, now: datetime) -> bool`: `INSERT … ON CONFLICT (user_id, product_id) DO NOTHING`; `True` si insertó, `False` si ya estaba; lanza `InvalidReference` si la FK a producto falla
      - `remove(user_id: UUID, product_id: UUID) -> bool`: `True` si borró una fila, `False` si no había
  - `valmont.modules.wishlist.adapters.persistence`: `SqlWishlistRepository(session)`; `InvalidReference(Exception)` con `field = "product_id"`; `WishlistItemRow`.
  - BD: `app.wishlist_items` con los nombres y columnas de SPEC §6.
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; ejecuta `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check` y `downgrade -1` + `upgrade head`): **la suite de cart completa sin cambios** (reader, GET, escritura, checkout, concurrencia, HTTP) y que cart ya no define su consulta de producto ni `_image_url`; pruebas del lector compartido (`backend/tests/shared/`: los casos del lector de cart contra `SqlProductSnapshots` e `image_url` con `STORAGE_PUBLIC_URL`, `SUPABASE_URL` y sin ninguna); migración y restricciones (UNIQUE, FK, `CASCADE`, `RESTRICT`); `add` dos veces → `True` y `False`; dos conexiones reales agregando lo mismo → una fila sin error; `list_for_user` ordenado; `remove` idempotente.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): el carrito sigue igual (`GET /api/v1/cart` y agregar en `/docs`, con la misma `image.url` y precios); en Supabase Studio local (solo lectura) aparece `app.wishlist_items` con sus restricciones y sin filas; `uv run alembic current` indica `0009`.
- Seguridad: SQL parametrizado, sin escrituras en tablas ajenas; las restricciones de la BD son la última defensa; el repositorio solo recibe `user_id` (del token).
- Estado inicial: READY (SPEC aprobada por el Leader el 2026-11-26, D-039).
- Entrega: cambio preparado sin commit (`git add <rutas>`) y mensaje propuesto en el punto 12, p. ej. `feat(wishlist): lector compartido de productos, esquema y repositorio de la lista de deseos (T-066)`; qa-reviewer lo verifica y el Leader hace el commit (§11.2, D-033, D-036).
- IDs reservados: ninguno.
- Escalar si: mover la consulta cambia algún resultado de cart (las pruebas de cart deben pasar sin editarse), hace falta otra tabla o columna, o aparece una dependencia nueva.

### T-067 — Lectura de la lista y `GET /wishlist`
- Objetivo: el cliente ve su lista con precio vigente, disponibilidad e imagen calculados en el servidor, y los despublicados marcados.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: wishlist · Requisitos: RF10.03 · Reglas: WISH-R5, R6, R7, R8, R10, RN-09, RN-14 · Decisiones: D-037, D-038
- Leer: SPEC §3 (UC-WISH-01), §4 (R5–R8, R10), §7 (`WishlistOut`, `WishlistItemOut`, `GET`) y §8; `backend/src/valmont/shared/product_snapshots.py` (de T-066); de cart, `adapters/http.py` (`_money`, esquemas, router) y `application.py` (`GetCart`, el patrón a seguir); `backend/src/valmont/main.py` (cómo se registra el router).
- Contratos aplicables: SPEC §7 (PROPUESTO; el desarrollo empieza con la aprobación de backend-lead y frontend-lead).
- Dependencias: T-066 (incluye el lector compartido); T-044 (inventory) y T-051 (promotions) integradas.
- Puede modificar: `modules/wishlist/application.py` (`WishlistCatalog`, `WishlistItemView`, `WishlistView`, `GetWishlist`), `adapters/http.py` (nuevo; router y esquemas), `backend/src/valmont/main.py` (solo registrar el router) y su traspaso en este STATUS.
- Protegido: `domain.py`, `WishlistRepository` y `adapters/persistence.py` (de T-066: si falta algo, se escala), `backend/migrations/**`, el resto de módulos incluido cart, `shared/` (el lector se usa, no se cambia) y `backend/tests/**`. No importar nada de `cart` ni de `catalog`.
- Resultado esperado: `GET /api/v1/wishlist` con `current_user`; `GetWishlist` lee las filas de la lista (`list_for_user`) y los productos con **una** llamada a `get_published` del lector compartido (`SqlProductSnapshots` implementa `WishlistCatalog`), pide `get_names` solo de los no publicados y marca `unavailable` (R5, R6); no expone `available` ni `order_policy`; sin escribir. El router usa `image_url` compartida.
- Criterios de aceptación: CA-WISH-01, 07, 08, 09 (lectura) y 11 (OpenAPI de `GET`).
- Firmas públicas:
  - HTTP: `GET /api/v1/wishlist` → `WishlistOut` (SPEC §7); códigos 200, 401, 503.
  - `valmont.modules.wishlist.application`:
    - `class WishlistCatalog(Protocol)`: `get_published(product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]` y `get_names(product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]`, con la semántica del lector compartido (`ProductSnapshot` de `valmont.shared.product_snapshots`)
    - `@dataclass(frozen=True) class WishlistItemView`: `product_id: UUID`, `slug: str`, `name: str`, `added_at: datetime`, `status: WishlistItemStatus`, `sku: str | None`, `image_path: str | None`, `alt: str | None`, `availability_status: str | None`, `lead_time_days: int | None`, `unit_price: int | None`, `original_price: int | None`, `discount_amount: int | None` (`original_price` y `discount_amount` solo si `promotion_id` no es nulo)
    - `@dataclass(frozen=True) class WishlistView`: `items: tuple[WishlistItemView, ...]`, `max_items: int` (el `item_count` es `len(items)`)
    - `class GetWishlist`: `__init__(self, wishlist: WishlistRepository, catalog: WishlistCatalog)`, `__call__(self, user_id: UUID) -> WishlistView`
  - Implementación: `valmont.shared.product_snapshots.SqlProductSnapshots(session)`; el router la inyecta con `SessionDep`.
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; mismas puertas que T-066, más OpenAPI): `GetWishlist` con repositorio y catálogo falsos (orden, `unavailable`, sin precio en no publicados, agotado sigue `available`); integración de `GetWishlist` con el lector real (precio, disponibilidad, imagen, despublicado; el lector en sí se prueba en T-066); HTTP (401, forma de `WishlistOut`, importes iguales a los de catalog); aislamiento entre dos usuarios.
- Diseño (frontend): no aplica (la pantalla es T-069).
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:8000/docs`, con un token de cliente de desarrollo, `GET /api/v1/wishlist` devuelve `items: []`, `item_count` 0 y `max_items` 50; sin token, 401. Los artículos se prueban tras T-068.
- Seguridad: la identidad sale de `current_user`; ninguna consulta acepta un id de usuario; un despublicado no filtra más que nombre y `slug`; importes y disponibilidad solo del servidor.
- Estado inicial: BACKLOG → READY al integrar T-066 y recibir las aprobaciones.
- Entrega: como T-066; mensaje propuesto `feat(wishlist): lectura de la lista de deseos con precio y disponibilidad (T-067)`.
- IDs reservados: ninguno.
- Escalar si: la consulta no se resuelve en una sola lectura, hace falta una columna o vista que el lector compartido no lee, o frontend-lead objeta la forma de `WishlistOut`.

### T-068 — Agregar y retirar de la lista
- Objetivo: el cliente agrega un reloj (idempotente, con tope) y lo retira (idempotente).
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: wishlist · Requisitos: RF10.01, RF10.02, RF10.04, RN-03 · Reglas: WISH-R1, R2, R3, R4, R10
- Leer: SPEC §3 (UC-WISH-02 y 03), §4 (R1–R4, R10), §7 (`POST`, `DELETE`, 422 y 409); el código de T-066 y T-067; de cart, `adapters/http.py` (`_conflict`, `_translated`, rutas `POST` y `DELETE`) y `application.py` (`AddToCart`, `ProductNotAvailable`); `shared/errors.py` (`AppError`, `ERROR_RESPONSES`).
- Contratos aplicables: SPEC §7 (PROPUESTO; aprobación como T-067).
- Dependencias: T-067.
- Puede modificar: `modules/wishlist/application.py` (casos de uso y errores), `adapters/http.py` (2 rutas, esquema de entrada, traducción a 409/422) y su traspaso en este STATUS.
- Protegido: `domain.py`, `adapters/persistence.py`, `backend/migrations/**`, el resto de módulos, `main.py`, `shared/` y `backend/tests/**`.
- Resultado esperado: dos rutas que devuelven siempre `WishlistOut`; `AddToWishlist` valida que el producto esté publicado con `WishlistCatalog.get_published` (si no, `ProductNotAvailable`), lee la lista y: si ya estaba, no escribe; si no y ya hay 50, `WishlistFull`; si no, `add` (cuenta antes de insertar, **sin bloqueo**: tope blando, D-039) (una `InvalidReference` también es `ProductNotAvailable`); devuelve el `WishlistView` de la misma transacción. `RemoveFromWishlist` borra la fila propia, exista o no el producto.
- Criterios de aceptación: CA-WISH-02 a 06, 09 (escritura) y 11 (OpenAPI de `POST` y `DELETE`).
- Firmas públicas:
  - HTTP: `POST /api/v1/wishlist/items` (cuerpo `{"product_id"}`, `extra="forbid"`) y `DELETE /api/v1/wishlist/items/{product_id}` con respuestas y códigos de SPEC §7 (401, 409 `wishlist_full` con `details {"max_items": 50}`, 422 con `loc ["body","product_id"]` o `["path","product_id"]`, 503).
  - `valmont.modules.wishlist.application`:
    - `class ProductNotAvailable(Exception)` (→ 422, mismo mensaje para inexistente y borrador); `WishlistFull` del dominio (→ 409)
    - `AddToWishlist(wishlist: WishlistRepository, catalog: WishlistCatalog)`: `__call__(user_id: UUID, product_id: UUID) -> WishlistView`
    - `RemoveFromWishlist(wishlist: WishlistRepository, catalog: WishlistCatalog)`: `__call__(user_id: UUID, product_id: UUID) -> WishlistView`
- Pruebas obligatorias (las escribe qa-reviewer; mismas puertas que T-067): `AddToWishlist` con falsos (idempotencia sin escribir, tope con nuevo y con presente, no agregable, "ningún cambio" tras rechazo); HTTP con los 422 por `loc`, el 409 con `code` y `details`, el campo extra y `user_id` en el cuerpo; aislamiento entre dos usuarios; dos `POST` simultáneos del mismo producto (una fila, ambos 200); dos `POST` simultáneos de productos distintos con 49 artículos (sin 500 ni duplicados; quedan 50 o 51, tope blando); `DELETE` de un despublicado y de uno ajeno.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): en `/docs` con un token de cliente: agregar un reloj (200, aparece con precio y disponibilidad), agregarlo de nuevo (200 y sigue una sola vez), agregar uno en borrador o inexistente (422), retirarlo (200) y retirarlo otra vez (200), sin token (401); con 50 agregados, el 51.º da 409 `wishlist_full`.
- Seguridad: la lista es siempre la del token; el `product_id` de ruta solo actúa sobre filas propias; el cuerpo no trae `user_id`.
- Estado inicial: BACKLOG → READY al integrar T-067.
- Entrega: como T-066; mensaje propuesto `feat(wishlist): agregar y retirar relojes de la lista de deseos (T-068)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso, hace falta cambiar el esquema o `WishlistRepository`, o la carrera del tope produce algo peor que pasarse por poco (una fila duplicada o un 500).

### T-069 — Pantalla de deseos y cliente de API
- Objetivo: el cliente ve su lista en el área `account`, guarda y quita relojes desde la ficha y desde la lista, y puede pasar uno al carrito.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: wishlist (frontend) · Requisitos: RF10.01–RF10.04
- Leer: SPEC §7; `docs/design_ui/DESIGN.md` (componente «precio (con promoción)»); `docs/design_ui/VIEWS.md` y los nodos de Figma que asigne frontend-lead (**aún no existen**: T-110/T-111; la página `wishlist` está entre las capturas previstas); skill `frontend-module-implementation`; `frontend/src/lib/api/` (clientes existentes, incluido el de cart si ya está).
- Contratos aplicables: SPEC §7 aprobada y el OpenAPI de T-067 y T-068.
- Dependencias: T-067, T-068 y T-111; T-060 para "pasar al carrito" (P-WISH-1 a).
- Puede modificar: lo que fije frontend-lead al dividirla (previsto: `frontend/src/lib/api/wishlist.ts`, `frontend/src/components/account/wishlist/**`, la página de deseos y el botón de guardar de la ficha del producto).
- Protegido: `backend/**`, `docs/design_ui/**` (salvo lo que frontend-lead asigne) y todo lo no previsto.
- Resultado esperado (previsto, a cerrar con los nodos): lista con imagen, nombre, precio vigente (anterior tachado si existe), disponibilidad (agotado, bajo pedido con plazo), aviso de "ya no disponible" para `unavailable`, botón "retirar" y "añadir al carrito" (llama a cart, y opcionalmente retira), contador `item_count`/`max_items` y aviso del 409; estados de carga, vacío, error y éxito; corazón en la ficha que marca según `GET /wishlist`. El frontend muestra importes en `es-PE` y **nunca calcula** importes ni estados; sin sesión, el control lleva a iniciar sesión.
- Criterios de aceptación: CA-WISH-01 a 08 en lo visible y el E2E del plan de pruebas (§11), a concretar con VIEWS.md.
- Firmas públicas (PROPUESTAS por este coordinador; las cierra frontend-lead con VIEWS.md):
  - Cliente `frontend/src/lib/api/wishlist.ts`: `getWishlist()`, `addToWishlist(productId)`, `removeFromWishlist(productId)`; tipos de la SPEC §7 (`Wishlist`, `WishlistItem`, con `status` como unión literal).
  - Componente de precio: el de `VIEWS.md` (props `price`, `originalPrice`, `discountAmount`).
- Pruebas obligatorias: las escribe qa-reviewer (componentes y E2E con Playwright: guardar desde la ficha → ver en la lista → retirar) cuando el paquete esté READY.
- Diseño (frontend): nodos de Figma por definir (T-111); reutilizar el componente de precio y los controles de `VIEWS.md`.
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:4321`, iniciar sesión, guardar un reloj desde su ficha, verlo en la lista, retirarlo, y comprobar el aviso de un reloj despublicado.
- Seguridad: ocultar controles no es autorización; el backend decide; sin secretos en el cliente; solo `lib/api/` hace `fetch`.
- Estado inicial: **BACKLOG** (no READY: faltan VIEWS.md y los nodos; las firmas son provisionales).
- Entrega: como T-066; mensaje propuesto `feat(frontend): pantalla de la lista de deseos (T-069)`.
- IDs reservados: ninguno (rango agotado; frontend-lead pide más si divide la tarea).
- Escalar si: Figma no tiene la pantalla, el contrato no cubre un dato que el diseño exige o hace falta un componente fuera de `VIEWS.md`.

## Traspasos

#### Traspaso T-065 (revisión D-039) — 2026-11-26 — module-coordinator
1. Estado final: IN_REVIEW. SPEC y STATUS actualizados con D-039; solo `docs/modules/wishlist/**`, sin `git add`.
2. P-WISH-1 (a), P-WISH-2 (b) y P-WISH-3 (a) del usuario: ya reflejadas en §1, R4–R6 y CA; §12 es ahora "Decisiones tomadas (D-039)".
3. Sustituida la excepción (7) por el lector compartido `valmont.shared.product_snapshots` (SPEC §8): firmas públicas cerradas (`ProductSnapshot`, `SqlProductSnapshots.get_published/get_names`, `image_url`).
4. T-066 incluye ahora la extracción desde cart y los archivos de cart que puede tocar (solo `application.py`, `adapters/persistence.py`, `adapters/http.py`, por import y uso); nuevo CA-WISH-12 (la suite de cart pasa sin cambios).
5. Tope blando: sin `pg_advisory_xact_lock` ni `lock_for_user`; R4, CA-05, T-066 y T-068 ajustados (50 o 51 en carrera; sin exigir 50 exactos).
6. T-067 usa el lector compartido (sin `SqlWishlistCatalog`); T-068 sin bloqueo.
7. NO EJECUTADO: pruebas (no hay código).

#### Traspaso T-065 — 2026-11-26 — module-coordinator
1. Estado final: IN_REVIEW. `SPEC.md` y `STATUS.md` de wishlist creados, PROPUESTOS.
2. Archivos: `docs/modules/wishlist/SPEC.md` y `STATUS.md`. Sin commits ni `git add`.
3. Cobertura: RF10.01–RF10.04 y RN-03 comprobados con el bucle de la skill `module-planning` §3 (sin salida = completo).
4. Preguntas abiertas P-WISH-1…4: resueltas después en D-039 (ver arriba).
5. NO EJECUTADO: pruebas (no hay código).

## Discrepancias y riesgos

- **Lector compartido (D-039.4):** T-066 mueve código en uso de cart (T-057…T-059, DONE) a `shared/`. Riesgo: una regresión en cart. Mitigación: movimiento puro, `SqlCartCatalog` y `cart.application.ProductSnapshot` siguen existiendo con el mismo nombre y la suite de cart se ejecuta entera (CA-WISH-12). Si backend-lead prefiere acotar el riesgo, puede partir T-066 en dos (extracción y luego wishlist), pero el rango T-065–T-069 está agotado: pide un ID al Leader.
- **Pendiente del Leader:** registrar en `docs/modules.md` §3 el lector compartido de `shared/` (sustituye a la excepción (7)); `shared/` queda fuera de "se crea al necesitarlo" de §4.
- **`catalog` conserva su `_image_url`:** hay ahora dos copias (catalog y `shared/`); unificarlas es una mejora aparte, no se toca catalog aquí.
- **Tope blando (D-039):** con solicitudes simultáneas de una misma cuenta la lista puede pasar de 50 (por 1 en una carrera); aceptado. La unicidad (RN-03) no se ve afectada: la garantiza la BD.
- **Ruta:** el encargo hablaba de `/api/v1/wishlist` con POST y DELETE; la SPEC usa `/wishlist/items` y `/wishlist/items/{product_id}`, como cart (H-3).
- **Dependencia de diseño:** T-069 depende de T-111 (VIEWS.md y Figma), aún BLOCKED; incluye el "añadir al carrito" desde la lista (D-039.1), que depende de T-060. El backend se cierra y revisa por `/docs` sin esperar.
- **Pendiente para el Leader (fuera de `docs/modules/wishlist/**`):** filas de T-065…T-069 en `docs/agents/tasks.md`, fila `docs/modules/wishlist/` en `docs/agents/_registry.md`, estado de wishlist en `docs/modules.md` §3 (BACKLOG → SPECIFICATION).
- **Token de cliente de desarrollo:** las revisiones manuales necesitan un token de cliente; `docs/setup.md` aún no lo describe (mismo hueco que cart).
