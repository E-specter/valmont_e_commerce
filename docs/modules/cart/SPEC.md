# cart — Especificación
> Estado: PROPUESTO (falta la aprobación del contrato por backend-lead y frontend-lead, de la excepción (6) de `modules.md` §3 por el Leader y de las preguntas de §12) · Requisitos: RF03.01–RF03.07 · Reglas globales: RN-02, RN-04, RN-05, RN-06, RN-09, RN-10, RN-14, RN-15, RN-16 · Decisiones: D-015, D-017, D-022, D-023, D-037 · Dueño: backend · Última actualización: 2026-11-26 module-coordinator (T-055)

## 1. Problema y alcance

Que el cliente autenticado reúna relojes, elija cuáles comprar y vea el importe que pagaría, calculado por el servidor, antes de crear el pedido.

- **Incluye:**
  - Un único carrito por cliente (RN-02), creado al añadir el primer artículo.
  - Agregar un producto, cambiar su cantidad, retirarlo y marcarlo o desmarcarlo como seleccionado (RN-05).
  - Lectura del carrito con, por artículo, el precio vigente, el subtotal, el estado de compra (`status`) y la cantidad máxima permitida ahora, y con el total de los seleccionados, todo calculado en el servidor (RN-09).
  - Validación de disponibilidad al agregar, al subir la cantidad y al confirmar la compra (RF03.06).
  - Dos casos de uso internos para orders: preparar la compra (artículos seleccionados ya validados y con su precio) y retirar del carrito los comprados (RN-05).
- **No incluye:**
  - Carrito de invitado, ni fusión al iniciar sesión (P-CART-5; RN-02: el carrito exige sesión).
  - Reservar stock: no se reserva al añadir (D-017); la reserva atómica la hace orders al crear el pedido (RN-06).
  - Congelar el precio: el carrito muestra siempre el precio vigente de hoy; la instantánea la toma orders (RN-04).
  - Caducidad del carrito (P-CART-4), "seleccionar todo", "vaciar carrito", guardar para después o mover a la lista de deseos (wishlist), cupones, costo de envío, desglose de IGV (el precio ya lo incluye, D-022).
  - Crear el pedido, la entrega y el pago: son de orders y payments.
  - La interfaz: la planifica frontend-lead cuando existan `docs/design_ui/VIEWS.md` y los nodos de Figma (T-110/T-111).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Cliente autenticado (`current_user`) | Ver y modificar **su** carrito | Ver o tocar el de otro (la identidad sale del token, RN-10); enviar precios o totales (RN-09) |
| Administrador | Lo mismo sobre **su propio** carrito, como cualquier usuario | Ver carritos ajenos: no hay rutas de administración de carritos |
| Visitante | Nada: sin token → 401 | Cualquier ruta de cart (RN-02) |
| Módulo orders (casos de uso) | `PrepareCheckout` y `RemoveCheckedOutItems` dentro de su transacción | Escribir en las tablas de cart; aceptar precios del cliente |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-CART-01 | Cliente | — | El carrito (vacío si no hay fila: la lectura no escribe) con sus artículos, `status`, precios, subtotales, total de los seleccionados y `can_checkout` | 401 | RF03.05, RF03.06, RF03.07 |
| UC-CART-02 | Cliente | `product_id`, `quantity` (1 por defecto) | El producto queda en el carrito (si ya estaba, la cantidad se **suma**); el carrito se crea si no existía; el artículo nace con `selected = true` (RN-05) | 401, 409 (`out_of_stock`, `insufficient_stock`, `quantity_limit`, `cart_full`), 422 | RF03.01, RF03.06, RF03.07 |
| UC-CART-03 | Cliente | `product_id` de la ruta; `quantity` (valor final) | La cantidad queda en ese valor, dentro de los límites (R4, R5) | 401, 404, 409, 422 | RF03.02, RF03.06 |
| UC-CART-04 | Cliente | `product_id` de la ruta | El artículo sale del carrito; **idempotente** (retirar uno ausente da 200) | 401, 422 | RF03.03 |
| UC-CART-05 | Cliente | `product_id` de la ruta; `selected` | El indicador cambia; no mira el stock | 401, 404, 422 | RF03.04 |
| UC-CART-06 | orders | `PrepareCheckout(user_id)` | Bloquea el carrito y devuelve los artículos **seleccionados** con cantidad, datos comerciales y precio vigente, ya validados | `EmptySelection`, `CheckoutBlocked(issues)` | RF03.05, RF03.06 |
| UC-CART-07 | orders | `RemoveCheckedOutItems(user_id, product_ids)` | Retira esos artículos; los no seleccionados permanecen (RN-05) | — | RF03.03, RN-05 |

UC-CART-03 y UC-CART-05 comparten la ruta `PATCH` (§7): un cuerpo puede traer una o ambas cosas.

## 4. Reglas de negocio

- **Globales:** RN-02 (un carrito activo por cliente y sesión obligatoria), RN-04 (la instantánea es de orders), RN-05 (selección), RN-06 (la reserva atómica es de orders), RN-09 (importes en el servidor), RN-10 (solo datos propios), RN-14 (precio y stock salen de la fuente autorizada), RN-15 (PEN en céntimos enteros), RN-16 (Bajo pedido no reserva).
- **CART-R1 (un carrito, RN-02):** `app.carts.user_id` es UNIQUE. La identidad es siempre la del token; ninguna ruta recibe un `user_id` ni un id de carrito. Cada operación de escritura crea el carrito si falta (`INSERT … ON CONFLICT (user_id) DO NOTHING`) y lo bloquea (`SELECT … FOR UPDATE`) antes de leer o cambiar artículos.
- **CART-R2 (artículo único):** un producto aparece una vez por carrito (UNIQUE `(cart_id, product_id)`). Agregar uno ya presente **suma** la cantidad pedida a la actual.
- **CART-R3 (límites, hipótesis H-1 y H-2):** `CART_ITEM_MAX_QUANTITY = 5` unidades por artículo y `CART_MAX_LINES = 20` artículos distintos. Son constantes del dominio, no de la BD (la BD solo exige `quantity` entre 1 y 100 como última defensa).
- **CART-R4 (cantidad permitida):** `max_quantity` lo calcula el servidor por artículo y es la cantidad más alta que el cliente puede fijar **ahora**: `min(CART_ITEM_MAX_QUANTITY, disponible)` si la política del producto es `stock`; `CART_ITEM_MAX_QUANTITY` si es `made_to_order` o `backorder` (RN-16: no dependen del stock; con `backorder` y menos stock que la cantidad, orders trata la línea entera como bajo pedido, D-023); 0 si el producto no está publicado.
- **CART-R5 (validar al cambiar, RF03.06):** al agregar o fijar una cantidad **mayor** que la actual, la cantidad resultante debe ser ≤ `max_quantity`; si no, 409 con el motivo: `quantity_limit` (supera el tope de R3), `out_of_stock` (política `stock` sin unidades) o `insufficient_stock` (hay unidades pero menos que las pedidas). Bajar la cantidad y cambiar `selected` nunca se rechazan por stock. Agregar con `cart_full` (20 artículos distintos y el producto es nuevo) → 409. El resultado de una operación rechazada es **ningún cambio**.
- **CART-R6 (producto agregable):** solo se agrega un producto **publicado** (CATALOG-R1). Uno inexistente o en borrador da el **mismo** 422 sobre `product_id`, sin revelar que existe.
- **CART-R7 (`status` de un artículo):** calculado por el servidor al leer, con la regla pura `line_status(published, order_policy, available, quantity)`:
  - `unavailable`: el producto ya no está publicado (se despublicó después de agregarse);
  - `out_of_stock`: política `stock` con 0 disponibles;
  - `insufficient_stock`: política `stock` con `0 < disponible < quantity`;
  - `ok`: en cualquier otro caso (incluido Bajo pedido, RN-16).
  El artículo **no se elimina solo**: permanece visible con su `status` hasta que el cliente lo retire o el producto vuelva a estar disponible (P-CART-3). Un artículo `unavailable` no revela más datos del producto que su nombre y `slug`: sin precio, imagen ni disponibilidad (CATALOG-R1).
- **CART-R8 (precio y subtotales, RN-09, RN-15):** el precio unitario es el precio vigente de promotions (`price`, D-037) **al momento de la consulta**, nunca guardado en el carrito. `subtotal = price × quantity` en enteros (puede superar 2³¹: se calcula en Python, no en la BD). `total` = suma de los subtotales de los artículos **seleccionados que tienen precio** (todos menos los `unavailable`), aunque estén `out_of_stock` o `insufficient_stock`: el total informa del importe y `can_checkout` decide si se puede comprar. `original_price` y `discount_amount` solo cuando hay promoción aplicada (mismo criterio que catalog).
- **CART-R9 (`can_checkout`):** verdadero si hay al menos un artículo seleccionado y **todos** los seleccionados están `ok`. Es solo una ayuda de pantalla: la decisión firme es de `PrepareCheckout` (R10) y de orders.
- **CART-R10 (preparar la compra, RF03.06):** `PrepareCheckout` bloquea el carrito (R1), toma los artículos seleccionados y los evalúa con R7 y R8 en esa misma transacción. Sin seleccionados → `EmptySelection`. Con alguno distinto de `ok` → `CheckoutBlocked(issues)` con un `CartIssue(product_id, status)` por artículo, y orders no crea el pedido. Si todo está `ok`, devuelve las líneas con precio vigente; la **comprobación definitiva del stock** es la reserva atómica de orders (RN-06): entre ambas puede cambiar el stock y entonces gana la reserva. El bloqueo del carrito serializa dos confirmaciones simultáneas del mismo cliente: la segunda, tras el commit de la primera, encuentra el carrito sin los comprados y recibe `EmptySelection`.
- **CART-R11 (retirar los comprados, RN-05):** `RemoveCheckedOutItems` borra solo los `product_ids` indicados, exactamente los que orders puso en el pedido; los no seleccionados permanecen. Idempotente; los ausentes se ignoran. Corre en la transacción del pedido: si orders la deshace, el carrito queda intacto.
- **CART-R12 (precio cambiante):** como no se congela el precio, el importe de una lectura puede diferir del de la anterior (cambió el precio base o venció una promoción). Orders debe mostrar al cliente el importe final antes de pagar (obligación recogida de promotions SPEC §8).
- **CART-R13 (sin proceso en segundo plano ni reserva):** el carrito no caduca ni retiene stock; la disponibilidad que muestra es la de la vista en ese instante y no está garantizada (D-017).
- **CART-R14 (sin auditoría):** las operaciones del carrito no son críticas en el sentido de RF14.01 (precio, stock, estado de pedido, pagos, roles). No se auditan; el hecho que importa, el pedido, lo audita orders.
- **CART-R15 (orden):** los artículos se devuelven por `created_at` ascendente y `product_id` para estabilidad.

## 5. Modelo de dominio

- **Constantes:** `CART_ITEM_MAX_QUANTITY = 5`, `CART_MAX_LINES = 20`.
- **CartLineStatus** (`ok | insufficient_stock | out_of_stock | unavailable`) y la función pura `line_status(...)` y `max_quantity(...)` (R4, R7).
- **CartItem** (`product_id`, `quantity`, `selected`, `created_at`) y **Cart** (`id`, `user_id`, `items`): invariantes R2 y R3; `Cart.add(product_id, quantity)`, `set_quantity`, `set_selected` y `remove` devuelven un carrito nuevo o lanzan el error del dominio.
- **Errores de dominio:** `QuantityLimit`, `CartFull`, `ItemNotInCart`.
- Sin máquina de estados: el carrito es una colección editable.

## 6. Persistencia

Migración **0008** (siguiente tras `0007`; `--rev-id 0008`). Esquema `app`; restricciones con `op.f(...)`. Revisar con `database-migration-review`.

```
app.carts       id uuid PK · user_id uuid NOT NULL FK → app.profiles(user_id) ON DELETE CASCADE · UNIQUE (user_id)
                created_at · updated_at (timestamptz NOT NULL DEFAULT now())
app.cart_items  id uuid PK · cart_id uuid NOT NULL FK → app.carts(id) ON DELETE CASCADE
                product_id uuid NOT NULL FK → app.products(id) ON DELETE RESTRICT
                quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 100)
                selected boolean NOT NULL DEFAULT true
                created_at · updated_at (timestamptz NOT NULL DEFAULT now())
                UNIQUE (cart_id, product_id) · INDEX (product_id)
```

- La FK a `app.profiles` (identity) y a `app.products` (catalog) y la lectura de §8 son la **excepción (6)** que se pide a `docs/modules.md` §3.
- Los límites de R3 (5 y 20) no se expresan en CHECK: los impone el dominio con el carrito bloqueado (R1) y los prueba QA. La BD protege lo invariable: un artículo por producto, cantidad ≥ 1, un carrito por usuario.
- Sin precio ni nombre en `cart_items` (R8).
- Reversible: `downgrade` borra `cart_items` y luego `carts` (destructivo solo para datos de carritos; BD locales y de pruebas).
- El carrito de un usuario se borra con su perfil (`CASCADE`); un producto con artículos en carritos no se puede borrar (`RESTRICT`; el catálogo despublica, no borra: CATALOG-R4).

## 7. Contrato API (PROPUESTO)

Prefijo `/api/v1/cart`. Todas las rutas con `current_user` (añaden 401 `unauthenticated` y 503 `auth_unavailable`). `Money` = `{amount, currency}` de `shared/money.py`; un campo extra en el cuerpo → 422. Errores con `ERROR_RESPONSES`, más 409 declarado en este módulo con el mismo `ErrorOut`.

```jsonc
// CartOut (respuesta de las cuatro rutas)
{"items": [CartItemOut], "item_count": 2, "selected_count": 1,
 "total": {"amount": 1062500, "currency": "PEN"},   // solo seleccionados con precio (R8)
 "can_checkout": true}                                // R9
// CartItemOut
{"product_id": "uuid", "sku": "DEMO-H38", "slug": "heritage-38", "name": "Heritage 38",
 "image": {"url": "https://…", "alt": "…"},           // null si unavailable o sin imagen
 "quantity": 1, "selected": true,
 "status": "ok",                                       // "ok" | "insufficient_stock" | "out_of_stock" | "unavailable" (R7)
 "availability": {"status": "in_stock", "lead_time_days": null},   // null si unavailable; status de catalog: in_stock|low_stock|out_of_stock|on_request
 "max_quantity": 3,                                    // R4
 "unit_price": {"amount": 1062500, "currency": "PEN"},      // null si unavailable
 "original_price": {"amount": 1250000, "currency": "PEN"},  // null sin promoción aplicada o si unavailable
 "discount_amount": {"amount": 187500, "currency": "PEN"},  // null sin promoción aplicada o si unavailable
 "subtotal": {"amount": 1062500, "currency": "PEN"}}        // null si unavailable
// CartItemIn (POST)       {"product_id": "uuid", "quantity": 1}        // quantity opcional, 1–5, entero estricto
// CartItemUpdateIn (PATCH) {"quantity": 2, "selected": false}          // ambos opcionales; al menos uno
```

| Método | Ruta | Request | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/cart` | — | `CartOut` | 401 |
| POST | `/cart/items` | `CartItemIn` | 200 `CartOut` (si el producto ya estaba, suma) | 401, 409, 422 |
| PATCH | `/cart/items/{product_id}` | `CartItemUpdateIn` | `CartOut` | 401, 404, 409, 422 |
| DELETE | `/cart/items/{product_id}` | — | `CartOut` (200 también si el artículo no estaba) | 401, 422 |

- **Siempre se responde con el carrito completo** (`CartOut`) para que la interfaz se redibuje sin una segunda consulta; los importes son los de la misma transacción.
- **Validación (422 `validation_error`, `details[].loc` = `["body", "<campo>"]`):** `product_id` UUID válido, publicado y existente (R6, mismo mensaje para inexistente y borrador); `quantity` entero estricto de 1 a `CART_ITEM_MAX_QUANTITY` (un 0, negativo, decimal, texto o mayor que 5 → 422); `selected` booleano estricto; `PATCH` sin ningún campo → 422 (`loc ["body"]`); un `product_id` de ruta mal formado → 422. Un campo extra → 422. El cuerpo no puede traer precios, subtotales ni totales.
- **Conflictos de negocio (409), código en `error.code`:**

| `code` | Cuándo | `details` |
|---|---|---|
| `quantity_limit` | la cantidad resultante supera `CART_ITEM_MAX_QUANTITY` (R3, R5) | `{"max_quantity": 5}` |
| `out_of_stock` | política `stock` sin unidades al agregar o subir la cantidad | `{"max_quantity": 0}` |
| `insufficient_stock` | hay unidades pero menos que la cantidad resultante | `{"max_quantity": <disponible>}` |
| `cart_full` | el producto es nuevo y ya hay 20 artículos distintos | `{"max_lines": 20}` |

- `PATCH` de un producto que no está en el carrito → 404 `not_found`. `DELETE` de uno ausente → 200 (idempotente).
- **Qué pasa con un artículo que deja de estar disponible:** sigue en `items` con su `status` (R7) y `max_quantity` coherente; `can_checkout` pasa a falso mientras esté seleccionado. Se puede desmarcar o retirar siempre; la cantidad se puede bajar siempre.
- La interfaz **no calcula** importes ni decide si se puede comprar: pinta `unit_price`, `original_price` tachado si existe, `subtotal`, `total`, `status` y `can_checkout`, y usa `max_quantity` como tope del selector (RN-09). Ocultar un control no es autorización.
- `image` se calcula como en catalog (URL pública de Storage de la primera imagen por posición); se retira si Figma no muestra miniatura (P-CART-6).

## 8. Dependencias

- **Consume:**
  - `identity`: `current_user` (excepción 1 de `modules.md` §3).
  - `catalog` (**lectura en SQL**, excepción (6) propuesta): `app.products` solo `id`, `sku`, `slug`, `name`, `status`, `order_policy` y `lead_time_days`; `app.product_images`, la primera por posición.
  - `inventory` (lectura en SQL de su contrato de lectura): la vista `app.product_availability` (`available`, `status`, `lead_time_days`).
  - `promotions` (lectura en SQL de su contrato de lectura): la vista `app.product_effective_price` (`list_price_cents`, `effective_price_cents`, `discount_amount_cents`, `promotion_id`); es la misma que usa catalog, así que el carrito y la ficha nunca discrepan.
  - Todo en **una sola consulta** por carrito (un `JOIN` de las líneas con productos, vistas e imagen), nunca producto a producto.
- **Excepción (6) que se pide a `docs/modules.md` §3** (la aprueba el Leader; sin ella T-056 y T-057 no empiezan): cart puede tener FK a `app.profiles` y a `app.products` y leer en SQL los objetos listados arriba, y nunca escribe en ellos; es el mismo patrón que las excepciones (3), (4) y (5).
  - **Alternativa descartada** (promotions SPEC §8 preveía el puerto `GetEffectivePrices` para cart): obliga a que cart obtenga un `GetEffectivePrices` ya enlazado a la sesión, y hoy solo se construye importando `promotions.adapters.persistence` (prohibido por `modules.md` §3). Para disponibilidad y producto no existe un puerto por lotes (`AvailabilityReader.get` es de un producto y catalog no ofrece lectura por id). Si el Leader prefiere puertos, hay que añadir antes uno por lotes a catalog, a inventory y una fábrica en promotions: más tareas fuera de este módulo.
- **Expone** (para orders; PROPUESTO, lo cierra la SPEC de orders), en `valmont.modules.cart.application`:

```python
@dataclass(frozen=True)
class CheckoutLine:
    product_id: UUID
    sku: str
    name: str
    quantity: int
    list_price: int          # céntimos
    price: int               # precio vigente unitario (>= 1)
    discount_amount: int     # 0 sin promoción
    promotion_id: UUID | None
    availability_status: str  # "in_stock" | "low_stock" | "on_request" (nunca out_of_stock)
    lead_time_days: int | None

@dataclass(frozen=True)
class CheckoutCart:
    lines: tuple[CheckoutLine, ...]   # solo los seleccionados; no vacía
    total: int                        # suma de price * quantity

class EmptySelection(Exception): ...                    # sin artículos seleccionados
class CheckoutBlocked(Exception): issues: tuple[CartIssue, ...]   # CartIssue(product_id, status)

class PrepareCheckout:       __call__(self, user_id: UUID) -> CheckoutCart
class RemoveCheckedOutItems: __call__(self, user_id: UUID, product_ids: Collection[UUID]) -> None
```

- **Obligaciones de orders al usarlo:** llamar `PrepareCheckout` y `RemoveCheckedOutItems` dentro de la **misma transacción** que crea el pedido y reserva el stock (el bloqueo del carrito dura hasta el commit); guardar la instantánea de `CheckoutLine` en las líneas del pedido (RF04.02, RN-04); reservar con `ReserveStock` (RN-06); mostrar el importe final antes de pagar (R12); no aceptar nunca un precio del cliente. Orden de bloqueos: carrito → filas de stock (cart nunca bloquea stock: sin ciclos).
- **Riesgo (rendimiento):** la consulta evalúa la vista de precios para los productos del carrito (≤ 20); despreciable en el MVP.

## 9. Seguridad

- Todas las rutas con `current_user`; el `user_id` sale del token validado y filtra cada consulta (RN-10). No existe ningún parámetro de id de carrito ni de usuario: no hay forma de nombrar el carrito ajeno. Los `product_id` de ruta se buscan **solo dentro del carrito propio**.
- Importes y estados solo en el servidor (RN-09, RN-14); el cliente envía ids, cantidad y `selected`.
- SQL parametrizado. `name` y `sku` son datos de catalog, no entrada de este módulo; la interfaz no los inyecta como HTML.
- Un producto despublicado no filtra más que su nombre y `slug` (R7).
- Protección frente a abuso: 20 artículos × 5 unidades como máximo por carrito; sin ello una cuenta podría generar filas sin tope.
- Sin datos personales propios; el carrito se borra con el perfil.

## 10. Criterios de aceptación

- [ ] CA-CART-01 (UC-CART-01, RF03.07, RN-02): `GET /cart` de un cliente sin carrito → 200 con `items: []`, `total` 0, `can_checkout` falso y **sin crear filas**; con artículos, los devuelve por `created_at` y `product_id`; dos clientes ven carritos distintos; sin token → 401.
- [ ] CA-CART-02 (UC-CART-02, RF03.01, RF03.07): `POST /cart/items` con un producto publicado y disponible → 200, carrito creado si no existía, artículo con `selected` verdadero y `quantity` 1 (o la pedida); agregar el mismo producto otra vez suma; tras agregar, `app.carts` tiene una sola fila del usuario y `app.cart_items` una por producto; dos `POST` concurrentes del mismo usuario terminan con **un** carrito y con el artículo sumado una vez por cada solicitud, sin 500.
- [ ] CA-CART-03 (UC-CART-02, R6): `POST` con un producto inexistente, en borrador o con `product_id` mal formado → 422 con `loc ["body","product_id"]` y el mismo mensaje en inexistente y borrador; no crea el carrito.
- [ ] CA-CART-04 (UC-CART-02, UC-CART-03, RF03.01, RF03.02, RF03.06, R3–R5): validación de cantidad: `quantity` 0, −1, 6, `1.5` o `"2"` → 422 con `loc ["body","quantity"]`; con política `stock`, agregar más de lo disponible → 409 `insufficient_stock` con `max_quantity` = disponible; con 0 disponibles → 409 `out_of_stock`; sumar hasta superar 5 → 409 `quantity_limit`; el rechazo no cambia nada; un producto `made_to_order` o `backorder` agotado **sí** se agrega hasta el tope (RN-16); el artículo 21 distinto → 409 `cart_full`, y sumar a uno existente con 20 líneas sigue permitido.
- [ ] CA-CART-05 (UC-CART-03, RF03.02): `PATCH` con `quantity` fija el valor final (no suma); subir por encima de `max_quantity` → 409; **bajar** siempre se permite, también si la cantidad actual excede el stock; un producto que no está en el carrito → 404; un `PATCH` sin campos → 422.
- [ ] CA-CART-06 (UC-CART-04, RF03.03): `DELETE` retira el artículo y devuelve el carrito sin él; repetirlo → 200 sin error; el artículo de otro usuario con el mismo `product_id` no se toca.
- [ ] CA-CART-07 (UC-CART-05, RF03.04, RN-05): `PATCH` con `selected` falso/verdadero cambia el indicador sin mirar stock; el `total` y `selected_count` cuentan solo los seleccionados; con todos desmarcados `total` 0 y `can_checkout` falso.
- [ ] CA-CART-08 (UC-CART-01, RF03.05, RN-09, RN-15, R8): `unit_price`, `subtotal` y `total` salen del precio vigente del servidor: `subtotal = unit_price × quantity`; `total` = suma de los seleccionados con precio; con una promoción vigente `unit_price` es el descontado y `original_price` y `discount_amount` vienen informados (iguales a los de catalog para el mismo producto); sin promoción los dos son `null`; un subtotal mayor que 2 147 483 647 céntimos se calcula bien; si el admin cambia el precio base o vence la promoción, la siguiente lectura muestra el precio nuevo (el carrito no lo guarda).
- [ ] CA-CART-09 (UC-CART-01, RF03.06, R7, R9): `status` por artículo: `ok`; `out_of_stock` (política `stock`, 0 disponibles); `insufficient_stock` (menos disponibles que la cantidad); Bajo pedido siempre `ok`; `unavailable` si se despublicó (sale con nombre y `slug`, y `unit_price`, `subtotal`, `image` y `availability` en `null`, y queda fuera del `total`); `can_checkout` es verdadero solo con ≥ 1 seleccionado y todos `ok`; republicar el producto restablece su `status` sin tocar el carrito; el artículo no se elimina solo.
- [ ] CA-CART-10 (R4, RF03.02): `max_quantity` es `min(5, disponible)` con política `stock`, 5 con `made_to_order`/`backorder` y 0 si `unavailable`; un `POST`/`PATCH` con `quantity` = `max_quantity` se acepta y con `max_quantity + 1` se rechaza (409 o `quantity_limit`).
- [ ] CA-CART-11 (RN-10, RF13): sin token → 401 en las 4 rutas; **ninguna** respuesta ni cambio afecta al carrito de otro usuario: con dos clientes, `PATCH`/`DELETE` de un `product_id` que solo existe en el carrito del otro → 404/200 sin tocarlo; el cuerpo no acepta `user_id` ni `cart_id` (422).
- [ ] CA-CART-12 (UC-CART-06, RF03.05, RF03.06, R10): `PrepareCheckout` devuelve solo los seleccionados, con cantidad, `sku`, `name`, `list_price`, `price`, `discount_amount`, `promotion_id`, `availability_status`, `lead_time_days` y `total` correctos; sin seleccionados → `EmptySelection`; con un seleccionado `out_of_stock`, `insufficient_stock` o `unavailable` → `CheckoutBlocked` con ese `product_id` y su `status` y **sin** efectos; un no seleccionado agotado no bloquea; no confía en ningún dato del cliente.
- [ ] CA-CART-13 (UC-CART-07, RN-05, R11): `RemoveCheckedOutItems` retira solo los `product_ids` dados y deja los no seleccionados; ids ausentes se ignoran; si la transacción de orders se deshace, el carrito queda igual.
- [ ] CA-CART-14 (R10, concurrencia): dos `PrepareCheckout` + `RemoveCheckedOutItems` simultáneos del mismo usuario con dos conexiones reales: el segundo espera el commit del primero y recibe `EmptySelection`; un `POST` concurrente con un `PrepareCheckout` se serializa por el bloqueo del carrito, sin 500.
- [ ] CA-CART-15: la migración `0008` es reversible (`downgrade` + `upgrade`), `alembic check` queda limpio y las restricciones de §6 existen y se cumplen en la BD: UNIQUE de `user_id` y de `(cart_id, product_id)`, CHECK de `quantity` 1–100, FK a perfiles y productos, `CASCADE` al borrar el carrito o el perfil, `RESTRICT` al borrar un producto con artículos.
- [ ] CA-CART-16: el OpenAPI de cart coincide con la §7 (campos obligatorios y anulables, `ErrorOut` en 401, 404, 409, 422 y 503) y las capas se respetan (cart no importa `domain` ni `adapters` de otros módulos).

Trazabilidad: RF03.01 → UC-CART-02 → CA-02, 03, 04. RF03.02 → UC-CART-03 → CA-04, 05, 10. RF03.03 → UC-CART-04, UC-CART-07 → CA-06, 13. RF03.04 → UC-CART-05 → CA-07. RF03.05 → UC-CART-01, UC-CART-06 → CA-01, 08, 12. RF03.06 → UC-CART-01 a 03 y UC-CART-06 → CA-04, 05, 09, 12. RF03.07 → UC-CART-01, UC-CART-02 → CA-01, 02, 15.

## 11. Plan de pruebas

Las escribe `qa-reviewer` a partir de esta SPEC y de las firmas de cada paquete (D-033).

- **Unitarias (sin BD):** dominio (`Cart.add/set_quantity/set_selected/remove`, R2 y R3, `line_status` y `max_quantity` con tabla: tres políticas × disponible 0/1/n × cantidad, publicado o no); casos de uso con repositorio y lector falsos (`GetCart`, `AddToCart`, `UpdateCartItem`, `RemoveFromCart`, `PrepareCheckout`, `RemoveCheckedOutItems`), incluidos totales, `can_checkout` y el "ningún cambio" tras un rechazo.
- **Integración (BD `valmont_test`):** migración y restricciones (CA-15); el lector real con productos de cada política, con y sin promoción (los tres alcances de promotions), con stock reservado vigente y vencido (la disponibilidad descuenta reservas vigentes), producto despublicado, producto sin imagen; una sola consulta para varias líneas; creación perezosa del carrito (`ON CONFLICT`); concurrencia con dos conexiones reales (CA-02, CA-14).
- **Contrato (HTTP con `TestClient`):** las 4 rutas, 401, 404, 409 con su `code` y `details`, 422 con su `loc`, un campo extra, OpenAPI contra la §7.
- **Seguridad:** dos usuarios (el carrito de uno no se ve ni se toca desde el otro, por ninguna ruta), administrador con su propio carrito, ausencia de `user_id` y `cart_id` en el cuerpo.
- **E2E (Playwright, cuando existan T-060 y orders):** agregar → cambiar cantidad → desmarcar → ver el total → retirar; un artículo que se agota queda marcado y bloquea la compra.
- **Casos de borde:** producto de 1 céntimo con promoción; precio de 2 147 483 647 × 5; producto que cambia de política con el artículo ya en el carrito; despublicar y republicar; categoría reasignada con promoción de categoría; cantidad actual mayor que el stock actual; 20 líneas.

## 12. Decisiones tomadas (D-038, 2026-11-26)

Todas las preguntas se resolvieron con la recomendación con la que está diseñada esta SPEC: P-CART-1 (b), P-CART-2 (a), P-CART-3 (a), P-CART-4 (a) y P-CART-5 (a), del usuario; P-CART-6 (§7, ajustable con Figma) y P-CART-7 (a, excepción (6)), del Leader. El contrato §7 queda aprobado por el Leader. Historial de las opciones:

Ninguna bloquea la implementación: el diseño usa la hipótesis conservadora (recomendación) de cada una. Se piden al usuario (negocio) o al Leader (técnicas) antes de T-056; lo que se decida distinto se corrige en R3, R4 o R7 sin cambiar el modelo de datos.

| ID | Pregunta | Opciones | Hipótesis conservadora (recomendación) | Decide |
|---|---|---|---|---|
| P-CART-1 | ¿Cuántas unidades del mismo reloj se pueden comprar? RF03.02 dice "cuando el producto lo permita". | (a) 1 unidad fija; (b) tope global (propuesta: 5) más el stock disponible; (c) un tope configurable por producto en catalog | **(b)**, constante `CART_ITEM_MAX_QUANTITY = 5` (H-1). (c) se añade después sin romper nada: `max_quantity` ya viaja por artículo y bastaría con rebajarlo; (a) es el caso de la constante en 1 | usuario |
| P-CART-2 | ¿Se pueden añadir productos Bajo pedido (RN-16, RF04.07 ya permite pedirlos)? ¿Y mezclarlos con productos en stock en el mismo carrito? | (a) sí y se mezclan (orders crea líneas con y sin reserva); (b) sí, pero no mezclados; (c) no | **(a)**: RF04.07 está aprobado y D-023 dice que orders trata cada línea según su política; el carrito no restringe | usuario |
| P-CART-3 | ¿Qué pasa con un artículo que se agota o se despublica estando ya en el carrito? | (a) permanece visible con `status`, no se compra hasta resolverlo; (b) se elimina solo al consultar (la lectura escribiría); (c) permanece y se excluye en silencio del pedido | **(a)**: no se pierde la intención del cliente, la lectura no escribe y RF03.06 ("informar y no crear el pedido") se cumple de forma explícita | usuario |
| P-CART-4 | ¿Caduca el carrito? | (a) no caduca; (b) 30 días sin actividad, con limpieza al consultar | **(a)**: sin proceso en segundo plano y sin pérdida sorpresiva; `updated_at` queda para añadir (b) después | usuario |
| P-CART-5 | ¿Hay carrito de invitado (antes de iniciar sesión)? | (a) no: RN-02 exige sesión; (b) carrito local en el navegador que se fusiona al iniciar sesión (ruta nueva de fusión y reglas de conflicto) | **(a)**: RN-02 lo dice y es lo más simple. Se replantea como mejora posterior | usuario |
| P-CART-6 | ¿Qué trae cada artículo para la pantalla (miniatura, plazo de Bajo pedido, ahorro)? | (a) los de §7; (b) menos | **(a)**: se ajusta cuando frontend-lead cierre las vistas del carrito con Figma | frontend-lead |
| P-CART-7 (técnica) | Cómo consume cart el precio, la disponibilidad y el producto de otros módulos (§8). | (a) excepción (6): lectura en SQL de las vistas y de columnas, en una consulta; (b) puertos por lotes nuevos en catalog, inventory y promotions | **(a)**, mismo patrón que las excepciones (3), (4) y (5); (b) abre tres tareas fuera de este módulo | Leader (backend-lead) |

**Hipótesis de esta SPEC que se invierten sin tocar el modelo:** H-1 tope de 5 unidades (R3); H-2 tope de 20 artículos distintos (R3); H-3 un artículo `unavailable` se muestra solo con nombre y `slug` (R7); H-4 el total incluye artículos seleccionados sin stock (R8) en lugar de excluirlos: lo decide la interfaz con `can_checkout`.
