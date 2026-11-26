# wishlist — Especificación
> Estado: PROPUESTO (preguntas resueltas en D-039; falta la aprobación del contrato por backend-lead y frontend-lead y que el Leader registre en `modules.md` §3 el lector compartido de §8) · Requisitos: RF10.01–RF10.04 · Reglas globales: RN-02 (sesión), RN-03, RN-09, RN-10, RN-14, RN-15 · Decisiones: D-037, D-038, D-039 · Dueño: backend · Última actualización: 2026-11-26 module-coordinator (T-065)

## 1. Problema y alcance

Que el cliente autenticado guarde relojes que le interesan para volver a ellos, sin comprometer stock ni precio.

- **Incluye:**
  - Una lista por cliente (sin cabecera: son filas `(cliente, producto)`), con un producto una sola vez (RN-03).
  - Consultar la lista con, por producto, el precio vigente, la disponibilidad y la imagen, calculados en el servidor.
  - Agregar un producto (idempotente) y retirarlo (idempotente).
  - Un tope blando de 50 artículos (D-039.2).
- **No incluye:**
  - Mover al carrito: lo hace la pantalla, que llama a `POST /cart/items` y, si quiere, a `DELETE /wishlist/items/{id}` (D-039.1); el servidor no tiene ruta ni caso de uso para ello.
  - Lista de invitado (la sesión es obligatoria, como el carrito), listas múltiples o con nombre, listas compartidas o públicas, avisos de precio o de reposición, orden manual, notas.
  - Reservar stock o congelar el precio: la lista solo muestra el estado de hoy.
  - Retirar el producto de la lista al comprarlo.
  - La interfaz: la planifica frontend-lead cuando existan `docs/design_ui/VIEWS.md` y los nodos de Figma (T-110/T-111). La ficha del producto sabe si un reloj está en la lista con `GET /wishlist` (≤ 50 artículos); no hay ruta de "¿está este producto?".

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Cliente autenticado (`current_user`) | Ver, agregar y retirar en **su** lista | Ver o tocar la de otro (la identidad sale del token, RN-10) |
| Administrador | Lo mismo sobre **su propia** lista | Ver listas ajenas: no hay rutas de administración |
| Visitante | Nada: sin token → 401 | Cualquier ruta de wishlist |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-WISH-01 | Cliente | — | La lista (vacía si no hay filas) más reciente primero; la lectura no escribe | 401 | RF10.03 |
| UC-WISH-02 | Cliente | `product_id` | El producto queda en la lista; si ya estaba, no cambia nada y responde igual (RN-03) | 401, 409 (`wishlist_full`), 422 | RF10.01, RF10.04 |
| UC-WISH-03 | Cliente | `product_id` de la ruta | El producto sale de la lista; **idempotente** (retirar uno ausente da 200) | 401, 422 | RF10.02 |

## 4. Reglas de negocio

- **Globales:** RN-02 (sesión obligatoria), RN-03 (sin duplicados), RN-09 y RN-14 (precio y disponibilidad solo del servidor), RN-10 (solo datos propios), RN-15 (PEN en céntimos enteros).
- **WISH-R1 (sin duplicados, RN-03):** UNIQUE `(user_id, product_id)` en la BD. Agregar uno ya presente **no es un error**: 200 con la lista actual, `added_at` intacto.
- **WISH-R2 (identidad):** ninguna ruta recibe un `user_id`; todo se filtra por el del token. El `product_id` de ruta solo actúa sobre las filas propias.
- **WISH-R3 (producto agregable):** solo se agrega un producto **publicado** (CATALOG-R1). Uno inexistente o en borrador da el **mismo** 422 sobre `product_id`, sin revelar que existe.
- **WISH-R4 (tope blando, D-039.2):** `WISHLIST_MAX_ITEMS = 50`, constante del dominio. Agregar un producto **nuevo** con 50 → 409 `wishlist_full`; agregar uno ya presente con 50 → 200. El caso de uso **cuenta antes de insertar, sin bloqueo**: con solicitudes simultáneas de la misma cuenta la lista puede pasar de 50 (en una carrera, por 1), y está aceptado; no se duplica ninguna fila (R1) ni hay error 500.
- **WISH-R5 (estado de un artículo):** `status = "available"` si el producto está publicado; `"unavailable"` si se despublicó después de agregarse. Agotado **no** es un estado de la lista: un reloj sin stock sigue siendo `available` con `availability.status = "out_of_stock"`, porque guardar lo que no se consigue es el uso normal (RN-16: los Bajo pedido salen como `on_request` con su plazo).
- **WISH-R6 (no se pierde nada en silencio, P-WISH-3):** un artículo `unavailable` permanece en la lista hasta que el cliente lo retira, y solo muestra `name` y `slug` (sin precio, imagen, disponibilidad ni `sku`, CATALOG-R1). Republicarlo lo restablece.
- **WISH-R7 (precio y disponibilidad):** el `unit_price` es el precio vigente de promotions al momento de la consulta (D-037), con `original_price` y `discount_amount` solo si hay promoción aplicada; la `availability` es la de la vista de inventory. Nada se guarda en la lista. No se expone el número de unidades.
- **WISH-R8 (orden):** `created_at` descendente (lo último guardado, primero) y `product_id` para estabilidad.
- **WISH-R9 (sin auditoría ni segundo plano):** no son operaciones críticas de RF14.01; no se auditan. Sin caducidad.
- **WISH-R10 (respuesta):** las tres rutas devuelven la lista completa (`WishlistOut`) de la misma transacción.

## 5. Modelo de dominio

- **Constante:** `WISHLIST_MAX_ITEMS = 50`. **Error:** `WishlistFull`. **Enumeración:** `WishlistItemStatus` (`available | unavailable`).
- La lista es una colección de filas; la unicidad la garantiza la BD (`INSERT … ON CONFLICT DO NOTHING`) y el tope blando lo aplica el caso de uso contando antes de insertar (R4). Sin máquina de estados.

## 6. Persistencia

Migración **0009** (siguiente tras `0008`; `--rev-id 0009`). Esquema `app`; restricciones con `op.f(...)`. Revisar con `database-migration-review`.

```
app.wishlist_items  id uuid PK · user_id uuid NOT NULL FK → app.profiles(user_id) ON DELETE CASCADE
                    product_id uuid NOT NULL FK → app.products(id) ON DELETE RESTRICT
                    created_at timestamptz NOT NULL DEFAULT now()
                    UNIQUE (user_id, product_id) · INDEX (product_id)
```

- La FK a `app.profiles` y a `app.products` y la lectura de §8 los cubre la infraestructura compartida de §8.
- El tope (R4) no es un CHECK ni un bloqueo: lo impone el caso de uso. La BD protege lo invariable: un producto una vez por cliente.
- Sin precio ni nombre en la fila (R7). El UNIQUE `(user_id, product_id)` ya sirve a la lectura por usuario; el índice de `product_id` sirve a la FK `RESTRICT`.
- Reversible: `downgrade` borra `wishlist_items` (destructivo solo para datos de listas; BD locales y de pruebas).
- La lista se borra con el perfil (`CASCADE`); un producto en alguna lista no se puede borrar (`RESTRICT`; el catálogo despublica, no borra: CATALOG-R4).

## 7. Contrato API (PROPUESTO)

Prefijo `/api/v1/wishlist`. Todas las rutas con `current_user` (401 `unauthenticated`, 503 `auth_unavailable`). `Money` de `shared/money.py`; campo extra en el cuerpo → 422. Errores con `ERROR_RESPONSES`, más el 409 declarado en este módulo con el mismo `ErrorOut`.

```jsonc
// WishlistOut (respuesta de las tres rutas)
{"items": [WishlistItemOut], "item_count": 2, "max_items": 50}
// WishlistItemOut
{"product_id": "uuid", "sku": "DEMO-H38", "slug": "heritage-38", "name": "Heritage 38",
 "status": "available",                                  // "available" | "unavailable" (R5)
 "added_at": "2026-11-26T15:04:05Z",
 "image": {"url": "https://…", "alt": "…"},              // null si unavailable o sin imagen
 "availability": {"status": "in_stock", "lead_time_days": null},   // null si unavailable; in_stock|low_stock|out_of_stock|on_request
 "unit_price": {"amount": 1062500, "currency": "PEN"},        // null si unavailable
 "original_price": {"amount": 1250000, "currency": "PEN"},    // null sin promoción aplicada o si unavailable
 "discount_amount": {"amount": 187500, "currency": "PEN"}}    // idem
// WishlistItemIn (POST)  {"product_id": "uuid"}
```

| Método | Ruta | Request | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/wishlist` | — | `WishlistOut` | 401 |
| POST | `/wishlist/items` | `WishlistItemIn` | 200 `WishlistOut` (también si ya estaba: idempotente) | 401, 409, 422 |
| DELETE | `/wishlist/items/{product_id}` | — | 200 `WishlistOut` (también si no estaba) | 401, 422 |

- **422 (`validation_error`, `details[].loc`):** `product_id` UUID válido, publicado y existente (R3; mismo mensaje para inexistente y borrador) con `loc ["body","product_id"]`; campo extra (`user_id`, precios…) → 422; un `product_id` de ruta mal formado → 422 con `loc ["path","product_id"]`.
- **409:** `code = "wishlist_full"`, `details = {"max_items": 50}` (R4).
- La interfaz **no calcula** nada: pinta `unit_price`, `original_price` tachado si existe, `availability` y `status`; usa `max_items` para avisar del tope. Ocultar un control no es autorización (RN-09).
- `image` se calcula como en catalog y cart (URL pública de Storage de la primera imagen por posición).

## 8. Dependencias

- **Consume:**
  - `identity`: `current_user` (excepción 1 de `modules.md` §3).
  - **Lector compartido de productos** `valmont.shared.product_snapshots` (D-039.4), que **extrae T-066** de `SqlCartCatalog` y `_image_url` de cart: lectura SQL por lotes, en una sola consulta, de `app.products` (`id`, `sku`, `slug`, `name`, `status`, `order_policy`), la primera imagen de `app.product_images` por posición y las vistas `app.product_availability` y `app.product_effective_price`; nunca escribe. Es infraestructura transversal en `shared/` (la registra el Leader en `modules.md` §3): así ningún módulo importa el `domain` ni los `adapters` de otro. Cart y wishlist lo usan; la regla de dependencia entre módulos no cambia.
  - **Firmas públicas del lector** (las cierra el paquete T-066):
    - `@dataclass(frozen=True) class ProductSnapshot`: los campos que hoy tiene el de cart: `product_id: UUID`, `sku: str`, `slug: str`, `name: str`, `image_path: str | None`, `alt: str | None`, `order_policy: str`, `available: int`, `availability_status: str`, `lead_time_days: int | None`, `list_price: int`, `price: int`, `discount_amount: int`, `promotion_id: UUID | None`.
    - `class SqlProductSnapshots`: `__init__(self, session: Session)`; `get_published(product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]` (solo publicados; vacío sin consultar; duplicados ignorados; **una** consulta) y `get_names(product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]` (nombre y `slug` de cualquier producto).
    - `def image_url(storage_path: str) -> str`: URL pública de Storage (`STORAGE_PUBLIC_URL` o `SUPABASE_URL`; `RuntimeError` si faltan ambas), con el comportamiento actual de `_image_url` de cart.
  - Wishlist **no** duplica esa consulta ni `_image_url`: su `WishlistCatalog` (puerto en `application`, T-067) se implementa con `SqlProductSnapshots`. Wishlist no expone `available` ni `order_policy` (R7).
- **Cambio en cart (solo de import y uso, sin cambiar su comportamiento):** `cart/application.py` importa `ProductSnapshot` del módulo compartido y lo sigue exponiendo con el mismo nombre; `cart/adapters/persistence.py` deja `SqlCartCatalog` apuntando a `SqlProductSnapshots` (los tests existentes lo importan) y borra su consulta y sus tablas ligeras de producto; `cart/adapters/http.py` usa `image_url` compartida en lugar de `_image_url`. La regresión la cubren las pruebas de cart ya existentes.
- **Expone:** nada a otros módulos. Orders y assistant no la consumen en el MVP.

## 9. Seguridad

- Todas las rutas con `current_user`; el `user_id` del token filtra cada consulta (RN-10). No existe parámetro de usuario ni de lista: no hay forma de nombrar la lista ajena.
- Importes y disponibilidad solo del servidor; el cliente envía solo un `product_id`.
- SQL parametrizado. Un producto despublicado no filtra más que nombre y `slug` (R6). Un producto en borrador o inexistente es indistinguible en el 422 (R3).
- Tope blando de 50 filas por cliente contra abuso (R4); una carrera puede pasarlo por poco, aceptado.
- Sin datos personales propios; la lista se borra con el perfil.

## 10. Criterios de aceptación

- [ ] CA-WISH-01 (UC-WISH-01, RF10.03): `GET /wishlist` de un cliente sin filas → 200 con `items: []`, `item_count` 0, `max_items` 50 y **sin crear filas**; con artículos, los devuelve por `created_at` descendente y `product_id`; dos clientes ven listas distintas; sin token → 401.
- [ ] CA-WISH-02 (UC-WISH-02, RF10.01): `POST` de un producto publicado → 200 con el producto en `items` (con `status` `available`, `added_at`, precio y disponibilidad); la fila existe en `app.wishlist_items` para ese usuario.
- [ ] CA-WISH-03 (UC-WISH-02, RF10.04, RN-03, WISH-R1): `POST` del mismo producto otra vez → 200, una sola fila y `added_at` sin cambiar; el mismo producto en las listas de dos clientes → una fila cada uno; dos `POST` simultáneos del mismo usuario y producto (dos conexiones reales) → una fila, ambos 200, sin 500; la BD rechaza un duplicado `(user_id, product_id)`.
- [ ] CA-WISH-04 (UC-WISH-02, R3): `POST` con un producto inexistente, en borrador o `product_id` mal formado → 422 con `loc ["body","product_id"]` y el mismo mensaje en inexistente y borrador, sin fila nueva; `user_id` u otro campo extra en el cuerpo → 422.
- [ ] CA-WISH-05 (UC-WISH-02, R4): con 50 artículos, un producto nuevo → 409 `wishlist_full` con `details {"max_items": 50}` y sin cambios; el ya presente → 200; tras retirar uno se puede agregar otro; con 49 artículos, dos agregados simultáneos de productos distintos terminan sin error 500, sin filas duplicadas y con 50 o 51 filas (tope blando, D-039.2; no se exige un valor exacto).
- [ ] CA-WISH-06 (UC-WISH-03, RF10.02): `DELETE` retira el producto y devuelve la lista sin él; repetirlo → 200; retirar un `product_id` que solo está en la lista de otro usuario → 200 sin tocarla; se puede retirar un producto despublicado; `product_id` de ruta mal formado → 422 con `loc ["path","product_id"]`.
- [ ] CA-WISH-07 (UC-WISH-01, R5, R7, RN-09, RN-14): `unit_price`, `original_price` y `discount_amount` coinciden con los de catalog para el mismo producto (con y sin promoción; sin ella `original_price` y `discount_amount` son `null`); `availability` refleja la vista (`in_stock`, `low_stock`, `out_of_stock`, `on_request` con `lead_time_days`); un reloj agotado **sigue** `available` en la lista; `image` es la primera por posición o `null`; no aparece el número de unidades.
- [ ] CA-WISH-08 (UC-WISH-01, R6): un producto despublicado tras agregarse permanece con `status` `unavailable`, `name` y `slug`, y `sku`, `image`, `availability` y los tres importes en `null`; republicarlo restablece sus datos sin tocar la lista; sigue contando para el tope.
- [ ] CA-WISH-09 (RN-10, RF13): sin token → 401 en las tres rutas; ninguna respuesta ni cambio afecta a la lista de otro usuario, por ninguna ruta; el administrador solo ve la suya.
- [ ] CA-WISH-10 (RF10.04): la migración `0009` es reversible (`downgrade` + `upgrade`), `alembic check` queda limpio y las restricciones de §6 existen y se cumplen: UNIQUE `(user_id, product_id)`, FK a perfiles y productos, `CASCADE` al borrar el perfil, `RESTRICT` al borrar un producto presente en una lista.
- [ ] CA-WISH-12 (regresión de cart, D-039.4): tras extraer el lector, **todas las pruebas existentes de `backend/tests/cart/**` pasan sin cambios** y cart ya no tiene su propia consulta de producto ni `_image_url`; wishlist y cart producen la misma `image.url` y los mismos importes para el mismo producto.
- [ ] CA-WISH-11: el OpenAPI coincide con la §7 (campos obligatorios y anulables, `ErrorOut` en 401, 409, 422 y 503) y las capas se respetan (wishlist no importa `domain` ni `adapters` de otros módulos); la lectura de productos es **una** consulta para toda la lista y sale del lector compartido de §8.

Trazabilidad: RF10.01 → UC-WISH-02 → CA-02, 04, 05. RF10.02 → UC-WISH-03 → CA-06. RF10.03 → UC-WISH-01 → CA-01, 07, 08, 12. RF10.04 → UC-WISH-02 → CA-03, 10.

## 11. Plan de pruebas

Las escribe `qa-reviewer` a partir de esta SPEC y de las firmas de cada paquete (D-033).

- **Unitarias (sin BD):** `GetWishlist`, `AddToWishlist` y `RemoveFromWishlist` con repositorio y catálogo falsos: idempotencia, tope blando (50 con producto nuevo y ya presente; cuenta antes de insertar), producto no agregable, `unavailable` con solo nombre y `slug`, orden, "ningún cambio" tras un rechazo.
- **Integración (BD `valmont_test`):** migración y restricciones (CA-10); el lector compartido `SqlProductSnapshots` (productos de cada política, con y sin promoción, sin imagen, despublicado, una sola consulta para varios, `image_url`); **regresión: toda la suite de cart** (CA-12); `INSERT … ON CONFLICT DO NOTHING`; concurrencia con dos conexiones reales: mismo producto (CA-03) y productos distintos con 49 (CA-05, sin exigir 50 exactos).
- **Contrato (HTTP con `TestClient`):** las 3 rutas, 401, 409 con `code` y `details`, 422 con su `loc`, campo extra, OpenAPI contra la §7.
- **Seguridad:** dos usuarios en las tres rutas, administrador con su lista, `user_id` en el cuerpo.
- **E2E (Playwright, cuando exista T-069):** guardar desde la ficha → verla en la lista → retirarla; un reloj despublicado queda marcado.
- **Casos de borde:** producto de 1 céntimo con promoción; precio de 2 147 483 647; producto que cambia de política con la lista ya hecha; despublicar y republicar; 50 artículos; categoría reasignada con promoción de categoría.

## 12. Decisiones tomadas (D-039, 2026-11-26)

El usuario resolvió P-WISH-1…3 con la recomendación; el Leader resolvió P-WISH-4 y el tope con una solución distinta a la propuesta.

| ID | Decisión | Quién | Efecto en la SPEC |
|---|---|---|---|
| P-WISH-1 | (a) mover al carrito lo hace la pantalla; el servidor no tiene ruta | usuario | §1, T-069 |
| P-WISH-2 | (b) tope de 50 artículos | usuario | R4, CA-05 |
| P-WISH-3 | (a) un reloj despublicado sigue visible, marcado `unavailable`, con nombre y `slug` | usuario | R5, R6, CA-08 |
| P-WISH-4 (técnica) | No se replica la consulta de `SqlCartCatalog` ni `_image_url`: T-066 extrae la lectura a `valmont.shared.product_snapshots` y cart y wishlist la usan. Sustituye a la excepción (7) | Leader | §8, T-066, CA-12 |
| Tope | **Blando**: se cuenta antes de insertar, sin `pg_advisory_xact_lock`; una carrera puede pasarlo (por 1), aceptado | Leader | R4, CA-05, T-068 |

**Hipótesis que se invierten sin tocar el modelo:** H-1 tope de 50 (R4); H-2 la lista no tiene paginación (cabe en el tope); H-3 la ruta `DELETE` va por `/wishlist/items/{product_id}` como cart, aunque el encargo hablaba de `/wishlist`.
