# Valmont — Inventario de vistas y matriz de reutilización

> **Estado: PROPUESTO (T-111, D-031).** Fuente: archivo de Figma `xRC4mg5JmdqlZ6mbv97kGO`, páginas `landing`, `auth`, `products`, `orders`, `wishlist` y `pay`, extraídas el 2026-11-26 en la misma pasada que [BRIEF.md](BRIEF.md) (tokens, tipografía y estados de componente viven allí). **No se vuelve a consultar lo que consta aquí** (cuota de Figma). Contratos: SPEC §7 de catalog, cart, wishlist, orders e identity (solo lectura).
> **Convenciones:** `[nodo]` = id de Figma. `●` = dibujado en Figma · `○` = lo exige el contrato o un RF aunque Figma no lo dibuje (lo diseña frontend-dev con BRIEF.md). `H-nn` = hueco entre diseño y contrato (§9). `P-n` = pregunta de negocio o de marca (§10). Rutas, nombres de componente y renderizado son **PROPUESTA** hasta aprobación del Leader. Identificadores en inglés, interfaz en español.

## 1. Alcance y páginas de Figma

| Página de Figma | Nodo | Estado | Vistas |
|---|---|---|---|
| `landing` | `189:303` | capturada | Portada `/home` [1:1283] y "Nosotros" `/about` [1:1284] (desktop, tablet y mobile) |
| `auth` | `189:304` | capturada | Ingreso [32:576] y Registro [34:595] (solo desktop 1440) |
| `products` | `189:306` | capturada | Catálogo [51:323], ficha [55:358], widget de chat [104:348] (solo desktop 1280) |
| `orders` | `189:307` | capturada | Mis pedidos [54:335], detalle de pedido [54:463] (solo desktop 1280) |
| `wishlist` | `189:310` | capturada | Lista de deseos [40:686] (solo desktop 1280) |
| `pay` | `189:305` | capturada | Carrito [43:285], checkout [43:374], confirmación [43:503] (solo desktop 1280) |
| `admin` | `189:309` | **no capturada** (D-031/T-111) | Otro diseño y estructura pobre. El backoffice se diseña desde [BRIEF.md](BRIEF.md) §1 y §7 (sidebar 260, KPI, tabla, alertas, tablero 07 `125:14038`): sin frames de referencia. |
| `others` | `189:311` | **no capturada** | Contacto básico. Nota: la información de contacto ya sale en `/about` (teléfono, correo, redes) y en el pie; no hace falta una vista propia en el MVP. Las rutas "Boutiques/Tiendas" de la navegación no tienen frame (P-1). |
| `guide_design_brand` | `189:308` | base del brief | Ver BRIEF.md |
| `Page 1` | `0:1` | vacía | — |

Solo `landing` trae las tres anchuras (1280 / 800 / 375). El resto está diseñado para desktop; **tablet y mobile se derivan del brief** (BRIEF §6: apilar splits, grid 2 → 1, CTA a ancho completo, línea de tiempo vertical).

## 2. Rutas, renderizado y layouts (PROPUESTA)

Reglas de `docs/modules.md` §5 y D-024 (`output: 'static'` + adaptador Node ya configurado en `frontend/astro.config.mjs`): estático por defecto; `prerender = false` donde hay datos que cambian o son del usuario.

| Vista | Ruta | Render | Layout | RF |
|---|---|---|---|---|
| Portada | `/` | estático | `StoreLayout` | RF02.01 (acceso al catálogo) |
| Nosotros | `/nosotros` | estático | `StoreLayout` | — (contenido institucional) |
| Ingreso | `/ingresar` | estático + isla `AuthForm` | `AuthLayout` | RF01.02 |
| Registro | `/registro` | estático + isla `AuthForm` | `AuthLayout` | RF01.01 |
| Catálogo | `/relojes` (`?category&movement&…&page`) | SSR | `StoreLayout` | RF02.01–04, RF02.08, RF09.02 |
| Ficha | `/relojes/[slug]` | SSR | `StoreLayout` | RF02.05–08, RF03.01, RF09.02, RF10.01 |
| Carrito | `/carrito` | SSR (por usuario) | `StoreLayout` | RF03.01–07, RF09.02 |
| Checkout | `/checkout` | SSR + isla `CheckoutForm` | `StoreLayout` (cabecera sin ruido, P-1) | RF04.01, 04.03, 04.05, 04.07, RF05.01–04, RNF01 |
| Confirmación | `/checkout/confirmacion/[order_id]` | SSR | `StoreLayout` | RF04.01, RF05.02, RF12.01 |
| Mis pedidos | `/cuenta/pedidos` | SSR | `StoreLayout` | RF11.01, RF12.01 |
| Detalle de pedido | `/cuenta/pedidos/[order_id]` | SSR | `StoreLayout` | RF12.01–02, RF04.04, RF04.06 |
| Lista de deseos | `/cuenta/lista-de-deseos` | SSR | `StoreLayout` | RF10.01–04 |

- `BaseLayout`: `lang="es"`, metadatos, fuentes, `tokens.css`. `StoreLayout` = `SiteHeader` + `<main>` + `SiteFooter` + `ChatWidget`. `AuthLayout` = `SiteHeader compact` + split + damero + `SiteFooter`.
- Todas las vistas por usuario exigen sesión **validada en el servidor de Astro** antes de renderizar (H-01). La autorización real sigue en el backend (RF13.02); redirigir a `/ingresar` es solo experiencia.
- Dinero: se pinta lo que devuelve el servidor (`Money`), nunca se calcula (RN-09). Fechas UTC → `Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima' })`.
- **Estados de toda vista con datos** (DESIGN §7, `modules.md` §5.3): cargando (`Skeleton`) · error con reintento (`Notice` + botón) · vacío (`EmptyState`) · éxito · operación pendiente. **Figma no dibuja ninguno** (BRIEF §12): lo diseña frontend-dev con los tokens; cada ficha de §3 indica los que aplican.

## 3. Elementos transversales

| Elemento | Nodos | Contenido | Notas |
|---|---|---|---|
| `SiteHeader` | `1:116` (desktop), `1:709` (tablet), `1:780` (mobile); en cada frame hay una copia: `51:671`, `56:306`, `54:602`, `42:258`, `43:578`, `32:577` (variante compacta de auth: wordmark + Nosotros/Boutiques/Contacto, sin damero) | wordmark + símbolo + descriptor + 3 enlaces + damero `Decorative border` | Sin carrito, cuenta, búsqueda ni lista de deseos (P-1). Enlaces distintos por frame: unificar. En mobile el frame mide 232 de alto (`1:781`); menú móvil no dibujado. |
| `SiteFooter` | `1:235` (instancia en todos los frames) | enlaces (Tiendas/Boutiques, Nuestra historia), teléfono `+51 (1) 625-4500`, `contacto@valmont.pe`, wordmark gigante, "VALMONT© 2026 TODOS LOS DERECHOS RESERVADOS", damero | Es una instancia de componente: un solo `SiteFooter`. En `/about` el teléfono es otro (`+51 987 654 321` [1:426]): contenido a unificar en configuración (H-22). |
| `ChatWidget` | portada `104:515` (disparador) y `104:521` (ventana) · `104:296` (mobile "nosotros") · `104:636`/`104:613` (auth) · `104:348` (catálogo/ficha) · `104:574` (pedidos) · `104:382`/`104:384` (wishlist) · `104:307`/`104:309` (carrito) | disparador (píldora "Chat con AI" o botón redondo 72 px) + ventana (cabecera "Asistente VALMONT · Disponible 24/7", mensajes bot/usuario, respuestas rápidas, entrada) | **Siete diseños distintos** del mismo widget: se unifica en uno. Datos: RF08 (módulo assistant, sin contrato en este paquete): H-20. Ausente en checkout, confirmación y detalle de pedido (○, P-1). |

## 4. Fichas de vista

Cada ficha lista: **nodo(s)** · **layout/secciones** · **componentes** (en `ui/` los genéricos; ver §5 y matriz §6) · **datos** · **estados** · **huecos**. Solo se citan los ids de los frames clave; el resto del árbol está en Figma.

### 4.1 Portada `/` — `[1:1283]` (Desktop `1:115`, Tablet `1:658`, Mobile `1:779`)
- **Secciones** (en orden, `Main` `1:186`): `CTA section` `1:187` (foto + bloque menta "Donde la tradición relojera se encuentra con la innovación mecánica." + "Explorar") → `About section` `1:193` (manifiesto "VALMONT es una boutique de alta relojería en el Perú…" + "Conoce nuestra historia") → `Featured product` `1:197` (producto protagonista oscuro, "NEW" + "Tourbillon Clásico") → `Product grid` `1:203` (3 mosaicos: Clásico Moderno, Tourbillon Innovador, Perpetuo Elegante + "Explorar colección") → "Flavors section" `1:226` (nombre de plantilla; son 4 enlaces tipográficos gigantes: Classique, Perpetual, Tourbillon, Tiendas) → "Stocklist section" `1:231` (invitación a las boutiques + foto) → pie.
- **Layout:** desktop 1280, splits 50/50 y grid de 3; tablet 800 y mobile 375 apilados (ya dibujados). Alto desktop 5644.
- **Componentes:** `SiteHeader`, `SiteFooter`, `ChatWidget`, `Button`, `TextLink`, `HeroCta`, `ManifestoBlock`, `CollectionTile`, `CollectionLinks`, `StoreBanner`, `Checkerboard`.
- **Datos:** contenido editorial **estático** (sin endpoint). Los 3 mosaicos y los 4 enlaces enlazan a `/relojes?category=<slug>` usando los slugs de `GET /api/v1/catalog/categories`; las categorías del catálogo son las que tenga la base (la portada habla de "colecciones" Classique/Perpetual/Tourbillon: H-06). Producto protagonista: texto fijo con enlace a su ficha.
- **Estados:** éxito únicamente (estático). Sin carga ni error. Imagen no disponible: color de superficie del token.
- **Huecos:** H-06 (colecciones y "destacado" no existen en el contrato).

### 4.2 Nosotros `/nosotros` — `[1:1284]` (Desktop `1:381`, Tablet `1:436`, Mobile `1:491`)
- **Secciones:** `Hero text` `1:383` ("Nosotros" + párrafo) → `Founder section` `1:388` (lista de **Reconocimientos** por año `1:391` + imagen) → `Contact info` `1:419` (imagen + "Contáctanos": teléfono, correo, redes `@valmontperu` + "Est. 2005").
- **Componentes:** `SiteHeader`, `SiteFooter`, `ChatWidget` (mobile `104:296`), `AwardsList`, `ContactBlock`, `DefinitionList`.
- **Datos:** estático. Los reconocimientos y el "Est. 2005" son contenido de marca provisto en el prototipo; **confirmar su veracidad** antes de publicar (P-9).
- **Estados:** éxito únicamente.

### 4.3 Ingreso `/ingresar` — `[32:576]` (1440 × 1372)
- **Layout:** `AuthLayout`: `Split_Layout` `32:584` 50/50, 760 de alto. Izquierda `32:585`: arte relojero SVG (círculo de movimiento, numerales XII/III/VI/IX, rótulo "INSTRUMENTO RELOJERO DE PRECISIÓN · CALIBRE VALMONT 2026 // 24 RUBÍES"). Derecha `32:621`: `Form_Header` (overline "PORTAL DE AUTENTICACIÓN SEGURA", h "INGRESO", subtítulo) + `Credentials_Form` `32:631` (correo, contraseña con ojo, "Recuérdame", "¿Olvidaste tu contraseña?") + `Action_Group` `32:654` ("Ingresar" + separador + "Crear cuenta Valmont +"). Damero menta `32:665`. Fondo `forest`.
- **Componentes:** `AuthSplit`, `WatchmakerArtwork`, `Field` (con icono y acción), `Checkbox`, `Button` (`mint`/`primary`), `TextLink`, `IconButton` (ojo), `Checkerboard`, `SiteHeader compact`, `SiteFooter`, `ChatWidget`.
- **Datos:** Supabase Auth (RF01.02, D-009/D-018); sin endpoint propio de login en el contrato de identity (solo `GET/PATCH /api/v1/identity/me`). **Cómo se guarda la sesión en el servidor de Astro no está definido** (H-01).
- **Estados:** reposo · enviando (botón cargando, campos deshabilitados) · error de credenciales (`Notice` + `aria-live`; mismo mensaje para correo inexistente y contraseña errónea) · error de red/`auth_unavailable` (503) con reintento · éxito (redirección al destino previo).
- **Huecos:** H-18 ("Recuérdame", "¿Olvidaste…?" RF01.04 POSTERIOR), BRIEF §12.2–3 (contraste del botón y campos sin límite).

### 4.4 Registro `/registro` — `[34:595]` (1440 × 1532)
- **Layout:** igual que ingreso con otro arte (barril del resorte, rótulo "…COMPORTAMIENTO MAINSPRING" en inglés: traducir). Formulario `34:658`: nombre completo, correo, contraseña + confirmar (2 columnas), **fecha de nacimiento ("debes tener +18 años")**, casilla "Acepto los términos y condiciones" + "Registrarse" + "Crear cuenta".
- **Componentes:** los de 4.3 + `Field` (fecha).
- **Datos:** Supabase Auth (RF01.01). `full_name` y `accept_privacy_version` van por `PATCH /api/v1/identity/me` tras el alta; **no hay campo de fecha de nacimiento** en `ProfileOut` (H-18, P-8). Privacidad: Ley 29733 (RNF10) — texto y versión de la política, `privacy_version`.
- **Estados:** como 4.3 + errores por campo (`validation_error.details[].loc`, traducidos por `type`, ver identity §7) + correo ya registrado + éxito ("revisa tu correo" si Supabase pide confirmación: INFERIDO).
- **Huecos:** H-18.

### 4.5 Catálogo `/relojes` — `[51:323]` (1280 × 2553)
- **Secciones:** cabecera → `Breadcrumb` `51:336` (Inicio > Colecciones > Todos los relojes) → `TitleSection` `51:342` ("Nuestros Relojes" + "Explora… — 24 modelos disponibles") → `Recommended Banner` `51:345` ("Destacado del mes", precio, "Descubrir") → `FilterAndSortBar` `51:357` (4 desplegables, interruptor "En stock / Por encargo", orden, vista cuadrícula/lista, fila de filtros activos con chips y "Limpiar todo") → `ProductGrid` `51:394` (3 columnas × 3, tarjetas `51:395`) → `PaginationContainer` `51:554` → pie.
- **Tarjeta** [51:395]: imagen + badge (Nuevo / Edición limitada) + botón corazón; nombre (Phudu 22); "Colección …"; ficha corta "40mm · Automático · Oro Amarillo 18K"; divisor; precio + "Ver detalles →".
- **Componentes:** `SiteHeader`, `Breadcrumb`, `PageTitle`, `FeaturedBanner`, `FilterBar` (`Select`, `Toggle`), `ActiveFilters` (`Chip`), `ProductGrid`, `ProductCard` (`Badge`, `IconButton` corazón, `Price`, `Availability` ○, `TextLink`), `Pagination`, `Notice`/`EmptyState`/`Skeleton` ○, `ChatWidget`.
- **Datos:** `GET /api/v1/catalog/products` (`ProductSummary`: `name`, `slug`, `category`, `price` (precio vigente con promoción, RF09.02), `movement`, `case_material`, `case_diameter_mm`, `water_resistance_m`, `main_image`, `availability`) con `q`, `category`, `movement`, `case_material`, `case_diameter_mm_min/max`, `water_resistance_m_min`, `price_min/max`, `available`, `sort`, `page`, `page_size`; opciones de filtro: `GET /categories` y `GET /attributes`; total = `total` ("24 modelos"). Corazón: `POST/DELETE /api/v1/wishlist/items` (RF10.01–02) → isla `WishlistToggle`.
  - Mapeo de la ficha corta: `{case_diameter_mm}mm · {movement.label} · {case_material.label}`; los nulos no se pintan (RF02.07).
  - Filtros → parámetros: Colección = `category`; Precio = `price_min/max` (céntimos); "En stock / Por encargo" = `available=true`, que **excluye solo `out_of_stock`** (incluye `on_request`, así que la etiqueta debe ser "Disponibles"); filtros por material/movimiento = `case_material`/`movement`.
- **Estados:** cargando (rejilla de `Skeleton` de 9) · error (422 de filtro → `Notice`; red → reintento) · **vacío** ("Ningún reloj coincide": acción "Limpiar filtros") · éxito · paginando. `category` desconocida devuelve `items: []` (vacío, no error).
- **Huecos:** H-02 (badges), H-03 (filtro "Complicación"), H-04, H-23 (sin búsqueda por texto), H-24 (orden), H-07/H-06 ("Destacado del mes").

### 4.6 Ficha de producto `/relojes/[slug]` — `[55:358]` (1280 × 4528)
- **Secciones:** `Breadcrumb` `55:371` → `Hero Section` `55:379` (izquierda `Images Container` `55:380`: principal 712 × 593 + 4 miniaturas; derecha `Product Info Stack` `55:387`, 460: colección, nombre, "Ref. TC-2026-A", valoración ★ `55:392`, descripción, `Price Block` `55:397` "S/ 84,500 · IGV incluido / Envío internacional asegurado", `Availability` `55:400`, selector de material `55:403`, `Action Buttons` `55:412` ("Añadir al Carrito" + corazón), "Consultar con un asesor →") → `Specs Section` `55:419` (tabla de 12 filas: Referencia, Movimiento, Reserva de marcha, Frecuencia, Rubíes, Diámetro, Grosor, Material de caja, Cristal, Resistencia al agua, Correa, Esfera) → `About the Movement` `55:458` (foto + texto + 4 cifras 72h/29/286/COSC) → `Craftsmanship Section` `55:478` (3 tarjetas) → `Related Products Section` `55:493` (3 `ProductCard`) → pie.
- **Componentes:** `Breadcrumb`, `ProductGallery`, `BuyBox` (`Price`, `Availability`, `Button`, `IconButton`, `TextLink`), `DefinitionList` (specs), `CaliberSection`, `CraftCard`, `ProductGrid` + `ProductCard` (relacionados), `QuantityStepper` ○, `Notice` ○.
- **Datos:** `GET /api/v1/catalog/products/{slug}` (`ProductDetail`: `description`, `specs[{label,value}]`, `images[]`, `related` 0–4, más lo de `ProductSummary`); 404 → página "No encontrado". "Añadir al carrito": `POST /api/v1/cart/items` (`{product_id, quantity}`; 409 `out_of_stock`/`insufficient_stock`/`quantity_limit`/`cart_full`, con `details.max_quantity`) → isla `AddToCart`. Corazón: `POST/DELETE /api/v1/wishlist/items` → `WishlistToggle`. Disponibilidad: RF02.08 (`in_stock`, `low_stock`, `out_of_stock`, `on_request` + `lead_time_days`); `on_request` → "Bajo pedido, entrega estimada en N días" (RF04.07).
  - Las filas de la tabla salen de `specs[]` (etiqueta y valor del servidor) y de los campos estructurados; Figma las pinta fijas.
- **Estados:** cargando · error · 404 · producto agotado (botón deshabilitado + aviso, sin ocultar el precio) · añadiendo · añadido (confirmación con `aria-live` y enlace al carrito) · error de stock (mensaje del 409 con el máximo) · sin sesión al añadir (redirigir a `/ingresar` conservando el destino).
- **Huecos:** H-04 (material = variantes), H-05 (valoraciones), H-07 (secciones de calibre y artesanía no están en el contrato), H-13 ("IGV incluido" y "Envío internacional asegurado" fijos), "Consultar con un asesor" → abre `ChatWidget` (RF08, H-20).

### 4.7 Carrito `/carrito` — `[43:285]` (1280 × 1589)
- **Secciones:** cabecera → `Breadcrumbs` `43:297` (Carrito > Envío > Pago > Confirmación: es el progreso) → `Cart Items Container` `43:306` ("Tu carrito · 2 modelos excepcionales seleccionados", líneas `43:311`: miniatura 140, nombre, "Colección … • Ref. …", "Retirer", selector de cantidad `-1+`, precio) + "← Seguir comprando" → `Order Summary Sidebar` `43:339` (380: Subtotal, Envío "Offerte", IGV estimado "Incluido", Total, botón "Ir al pago", "Pago 100 % seguro y protegido").
- **Componentes:** `PageTitle`, `Stepper`, `CartLine` (`QuantityStepper`, `Checkbox` ○ de selección, `Price`, `Badge`/`Notice` de estado ○, `TextLink` "Quitar"), `OrderSummary` (`Price`), `Button`, `TextLink`, isla `Cart`.
- **Datos:** `GET /api/v1/cart` → `CartOut` (`items[]` con `name`, `sku`, `slug`, `image`, `quantity`, `selected`, `status` (`ok`/`insufficient_stock`/`out_of_stock`/`unavailable`), `availability`, `max_quantity`, `unit_price`, `original_price`, `discount_amount`, `subtotal`; `item_count`, `selected_count`, `total`, `can_checkout`). Operaciones: `PATCH /cart/items/{product_id}` (`quantity`, `selected`), `DELETE /cart/items/{product_id}`. **Cada operación responde el carrito completo**: la isla lo repinta sin otra consulta. "Ir al pago" solo activo con `can_checkout` (RF03.06). Total = `total` (solo lo seleccionado, RN-05/RN-09).
- **Estados:** cargando · error · **vacío** ("Tu carrito está vacío" + enlace al catálogo) · éxito · actualizando una línea (línea con `aria-busy`) · línea con `status ≠ ok` (aviso por línea, `max_quantity` como tope, retirar/desmarcar siempre posible) · `cart_full` (20 líneas).
- **Huecos:** H-10 (Figma no dibuja la **selección por línea** RN-05, el estado por línea ni los precios con promoción), H-09 ("Colección" no viene en `CartItemOut`; se muestra el `sku`), H-13 (IGV, "Envío Offerte"), H-21 (rótulos en francés).

### 4.8 Checkout `/checkout` — `[43:374]` (1280 × 1748)
- **Secciones:** `Progress Steps Block` `43:386` (Carrito · Envío · **3 Pago** activo · Confirmación) → `Checkout Forms` `43:407` (732: "1. Dirección de entrega" con nombre, apellidos, dirección, ciudad, código postal, país, teléfono; "2. Método de pago" con número de tarjeta, vencimiento, código de seguridad) → `Checkout Summary Sidebar` `43:459` (380: "Tu pedido", líneas con miniatura, Subtotal, Envío, Total, "Confirmar pedido").
- **Componentes:** `Stepper`, `CheckoutForm` (isla; `Field`, `DeliveryFields`, `PaymentFields`), `OrderSummary`, `OrderLineMini`, `Button`, `Notice`.
- **Datos:** resumen desde `GET /api/v1/cart` (solo seleccionados). Crear pedido: `POST /api/v1/orders` con cabecera `Idempotency-Key` (UUID generado en el cliente y reutilizado al reintentar) y `CreateOrderIn.delivery`: `shipping` (`recipient_name`, `phone`, `department`, `province`, `district`, `address_line`, `reference?`) o `pickup` (`recipient_name`, `phone`). Respuesta `OrderDetailOut` (201; 200 si repite la clave). Importes: los del servidor. Errores 409: `empty_selection`, `checkout_blocked` (`details.issues[]`), `insufficient_stock`, `too_many_pending_orders` (máx. 3), `pickup_unavailable`, `idempotency_conflict`. 422 por campo en `details[].loc`.
  - Pago simulado: módulo `payments` **sin contrato** (BACKLOG, RF05): H-12.
- **Estados:** cargando resumen · error · sin selección (redirige al carrito) · validación por campo · enviando (botón cargando, doble clic imposible) · éxito → confirmación · fallo de stock/bloqueo (`Notice` con lista de artículos y enlace al carrito) · pedido pendiente expirado (RF04.06).
- **Huecos:** H-11 (campos del formulario ≠ contrato; falta el selector envío/recojo), H-12 (tarjeta), H-13 (IGV), H-21 (francés y datos de París), paso "Envío" del stepper sin pantalla propia (RNF01: Carrito → Checkout → Confirmación = 3 pantallas; el stepper se simplifica).

### 4.9 Confirmación `/checkout/confirmacion/[order_id]` — `[43:503]` (1280 × 1875)
- **Secciones:** `Success Block` `43:516` (icono ✓, "Pedido confirmado", "Número de pedido: #VM-2026-4521", agradecimiento) → `Summary Details Block` `43:523` (dirección, método de pago, entrega estimada, total pagado) → `Summary Ordered Items` `43:538` (líneas con miniatura 50) → `CTA Row` `43:550` (2 botones, rótulos no capturados; la guía cita "Ver mi pedido") → pie.
- **Componentes:** `Card`, `DefinitionList`, `AddressBlock`, `OrderLineMini`, `Price`, `Button`, `Notice` ○.
- **Datos:** `GET /api/v1/orders/{order_id}` → `OrderDetailOut`: `number` (formato real `VAL-000123`), `delivery`, `estimated_delivery_on`, `total`, `lines[]` (`name`, `quantity`, `line_total`), `status`. "Entrega estimada": `estimated_delivery_on` (puede ser `null`).
- **Estados:** cargando · error · 404 (pedido ajeno o inexistente, mismo mensaje) · **pendiente de pago** (`pendiente_pago` con `expires_in_seconds`: la vista no debe decir "confirmado" si no está pagado) · éxito (`pagado`) · expirado.
- **Huecos:** H-12 (método de pago "tarjeta terminada en 4521" no está en el contrato), H-14 (el título depende del estado), imágenes de línea (H-15), H-17 (número de pedido).

### 4.10 Mis pedidos `/cuenta/pedidos` — `[54:335]` (1280 × 1760)
- **Secciones:** `Breadcrumbs_And_Title` `54:347` (Inicio > Mi Cuenta > Mis Pedidos; "Historial completo de tus compras en VALMONT") → `Filter_Sort_Bar` `54:357` (píldoras Todos / En proceso / Enviado / Entregado / Cancelado + "Ordenar por: Más reciente") → `Orders_List_Section` `54:374` (tarjetas `54:375`: número, fecha, badge de estado, hasta 2 miniaturas, "N artículos", TOTAL, "Ver detalle →") → `Pagination_Section` `54:440` → pie.
- **Componentes:** `Breadcrumb`, `PageTitle`, `Chip` (filtro), `OrderCard` (`Badge` de estado, `Price`, `TextLink`), `Pagination`, `EmptyState`/`Notice`/`Skeleton` ○, `ChatWidget`.
- **Datos:** `GET /api/v1/orders?status&page&page_size` → `OrderPageOut` (`OrderSummaryOut`: `number`, `status`, `total`, `item_count`, `created_at`, `expires_at`, `estimated_delivery_on`). Badge desde `status` con el mapa de H-14.
- **Estados:** cargando · error · **vacío** ("Aún no tienes pedidos" + catálogo) · vacío con filtro · éxito · `pendiente_pago` con cuenta atrás (`expires_at`) y acción "Pagar" ○ · `expirado` ○.
- **Huecos:** H-14 (estados), H-15 (miniaturas, riesgo D-4 de orders), H-16 (sin parámetro de orden), H-26 (formato de fecha).

### 4.11 Detalle de pedido `/cuenta/pedidos/[order_id]` — `[54:463]` (1280 × 1974)
- **Secciones:** `Breadcrumbs_And_Title_Detail` `54:475` ("Pedido #… " + badge) → `Tracking_Timeline_Section` `54:488` (`Timeline_Card`: Confirmado · En preparación · Enviado · Entregado, con fechas, nodo actual pulsante) → `Detail_Columns` `54:514`: izquierda (`Articles_Section` `54:516`: líneas 96 px; `Shipping_Section` `54:533`: courier, nº de seguimiento, entrega estimada, "Rastrear envío →"), derecha 400 (`Summary_Card` `54:547`: Subtotal, Envío, IGV (18 %), Total; `Address_Card` `54:562`; `Payment_Card` `54:570`: "Visa terminada en 4521 · Pago verificado") → `Action_Buttons` `54:577` (2 botones + "Solicitar devolución").
- **Componentes:** `Breadcrumb`, `PageTitle`, `Badge`, `Timeline`, `OrderLineMini` (variante grande), `DefinitionList`, `OrderSummary`, `AddressBlock`, `Card`, `Button`, `TextLink`, isla `CancelOrder` ○.
- **Datos:** `GET /api/v1/orders/{order_id}` → `OrderDetailOut`: `history[]` (`from_status`, `status`, `at`, `actor`) para la línea de tiempo; `lines[]`; `subtotal`, `shipping`, `total`; `delivery` (`recipient_name`, `phone`, dirección o `pickup_store`; `carrier`, `tracking_code`, `shipped_at`); `estimated_delivery_on`; `refund`; `can_cancel`. Cancelar: `POST /api/v1/orders/{order_id}/cancel` (RF04.04, solo `pendiente_pago`; 409 `not_cancellable`) con diálogo de confirmación.
- **Estados:** cargando · error · 404 · éxito · `pendiente_pago` (cuenta atrás, "Pagar", "Cancelar") · cancelando · cancelado (con `refund` si existe) · expirado.
- **Huecos:** H-14 (los pasos de Figma no son los estados del servidor), H-17 (IGV 18 %, método de pago, "Rastrear envío", "Solicitar devolución", factura), H-15.

### 4.12 Lista de deseos `/cuenta/lista-de-deseos` — `[40:686]` (1280 × 2369)
- **Secciones:** `Wishlist Hero` `40:699` (pre-título "Mi cuenta", "Lista de deseos" display, `Counter Badge` "3 relojes guardados") → `Wishlist Grid Section` `40:704` (3 columnas; `Product Card` `40:706`: imagen 380 con corazón, nombre, colección, precio, botón "Descubrir") → `Recommendation Section` `40:753` ("También te gustarán" + 3 tarjetas compactas con corazón apagado y "Ver producto") → pie.
- **Componentes:** `PageTitle` (centrado), `Badge` (contador), `ProductGrid` + `ProductCard` variante `wishlist` y variante `compact` (recomendaciones), `IconButton`, `Button`, `EmptyState`/`Notice`/`Skeleton` ○, `ChatWidget`.
- **Datos:** `GET /api/v1/wishlist` → `WishlistOut` (`items[]`: `name`, `slug`, `sku`, `status` (`available`/`unavailable`), `image`, `availability`, `unit_price`, `original_price`, `discount_amount`, `added_at`; `item_count`, `max_items` 50). Quitar: `DELETE /wishlist/items/{product_id}` → respuesta con la lista completa → isla `WishlistToggle` repinta. "Descubrir" enlaza a `/relojes/{slug}`.
- **Estados:** cargando · error · **vacío** ("Aún no guardas relojes" + catálogo) · éxito · quitando · artículo `unavailable` (tarjeta atenuada, sin precio ni imagen, con "Quitar"; el contrato lo devuelve así) · aviso al llegar a `max_items` (409 `wishlist_full` al añadir en otras vistas).
- **Huecos:** H-09 (colección y recomendaciones sin contrato), H-22 (fotos de cócteles = relleno).

## 5. Componentes (inventario propuesto)

Genéricos → `frontend/src/components/ui/` (24); de área → `components/<área>/` (30). Nombres en inglés; variantes entre paréntesis. Estilos y estados de cada uno: BRIEF §7.

| Ubicación | Componentes |
|---|---|
| `ui/` | `Button` (primary, dark, secondary, mint, link), `IconButton`, `TextLink` (con flecha), `Field` (icono izq./der., error), `Checkbox`, `Toggle`, `Chip` (activo, outline, removible), `Badge` (estado, producto), `Breadcrumb`, `Pagination`, `Select`, `Price` (con original tachado), `Availability`, `Checkerboard`, `Wordmark`, `Icon`, `Card`, `QuantityStepper`, `Stepper`, `Timeline`, `DefinitionList`, `Notice` (info, éxito, error), `EmptyState`, `Skeleton` |
| `layout/` | `SiteHeader` (full, compact), `SiteFooter`, `PageTitle` (a la izquierda, centrado) |
| `catalog/` | `ProductCard` (store, related, wishlist, compact), `ProductGrid`, `FilterBar`, `ActiveFilters`, `FeaturedBanner`, `ProductGallery`, `BuyBox`, `CaliberSection`, `CraftCard` |
| `cart/` | `CartLine`, `OrderSummary` (carrito, checkout, detalle), `OrderLineMini` (50, 60, 96 px) |
| `orders/` | `OrderCard`, `AddressBlock` |
| `checkout/` | `CheckoutForm` (isla), `DeliveryFields`, `PaymentFields` (los dos últimos, partes del formulario; ver P-4) |
| `auth/` | `AuthSplit`, `WatchmakerArtwork` |
| `assistant/` | `ChatWidget` (isla) |
| `home/` | `HeroCta`, `ManifestoBlock`, `CollectionTile`, `CollectionLinks`, `StoreBanner` · `about/`: `AwardsList`, `ContactBlock` |

## 6. Matriz de reutilización componente × vista

Vistas: **L** portada · **N** nosotros · **LI** ingreso · **RG** registro · **CT** catálogo · **FP** ficha · **CR** carrito · **CK** checkout · **CF** confirmación · **MP** mis pedidos · **DP** detalle de pedido · **WL** lista de deseos. `●` dibujado · `○` exigido por contrato/RF sin dibujo. **Total** = vistas donde aparece.

| Componente | L | N | LI | RG | CT | FP | CR | CK | CF | MP | DP | WL | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **ui/ Button** | ● | | ● | ● | ● | ● | ● | ● | ● | | ● | ● | 10 |
| IconButton | | | ● | ● | ● | ● | | | | | | ● | 5 |
| TextLink | ● | | ● | | ● | ● | ● | | | ● | ● | ● | 8 |
| Field | | | ● | ● | | | | ● | | | | | 3 |
| Checkbox | | | ● | ● | | | ○ | | | | | | 3 |
| Toggle | | | | | ● | | | | | | | | 1 |
| Chip | | | | | ● | | | | | ● | | | 2 |
| Badge | | | | | ● | | ○ | | | ● | ● | ● | 5 |
| Breadcrumb | | | | | ● | ● | | | | ● | ● | | 4 |
| Pagination | | | | | ● | | | | | ● | | | 2 |
| Select | | | | | ● | | | | | | | | 1 |
| Price | | | | | ● | ● | ● | ● | ● | ● | ● | ● | 8 |
| Availability | | | | | ○ | ● | ○ | | | | | ○ | 4 |
| Checkerboard | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | 12 |
| Wordmark | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | 12 |
| Icon | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | 12 |
| Card | | | | | ● | ● | ● | ● | ● | ● | ● | ● | 8 |
| QuantityStepper | | | | | | ○ | ● | | | | | | 2 |
| Stepper | | | | | | | ● | ● | | | | | 2 |
| Timeline | | | | | | | | | | | ● | | 1 |
| DefinitionList | | ● | | | | ● | | | ● | | ● | | 4 |
| Notice | | | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 10 |
| EmptyState | | | | | ○ | | ○ | | | ○ | | ○ | 4 |
| Skeleton | | | | | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 8 |
| **layout/ SiteHeader** | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | 12 |
| SiteFooter | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | 12 |
| PageTitle | | | | | ● | | ● | | | ● | ● | ● | 5 |
| **catalog/ ProductCard** | | | | | ● | ● | | | | | | ● | 3 |
| ProductGrid | | | | | ● | ● | | | | | | ● | 3 |
| FilterBar, ActiveFilters, FeaturedBanner | | | | | ● | | | | | | | | 1 |
| ProductGallery, BuyBox, CaliberSection, CraftCard | | | | | | ● | | | | | | | 1 |
| **cart/ CartLine** | | | | | | | ● | | | | | | 1 |
| OrderSummary | | | | | | | ● | ● | | | ● | | 3 |
| OrderLineMini | | | | | | | | ● | ● | | ● | | 3 |
| **orders/ OrderCard** | | | | | | | | | | ● | | | 1 |
| AddressBlock | | | | | | | | ○ | ● | | ● | | 3 |
| **checkout/ CheckoutForm** | | | | | | | | ● | | | | | 1 |
| **auth/ AuthSplit, WatchmakerArtwork** | | | ● | ● | | | | | | | | | 2 |
| **assistant/ ChatWidget** | ● | ● | ● | ● | ● | ● | ● | ○ | ○ | ● | ○ | ● | 12 |
| **home/ + about/** (7 componentes) | ● | ● | | | | | | | | | | | 1–2 |

**Lectura (evidencia para §7 y §8):**
- 54 componentes propuestos; **32 (59 %) aparecen en 2 o más vistas** (21 de `ui/`, `SiteHeader`, `SiteFooter`, `PageTitle`, `ProductCard`, `ProductGrid`, `OrderSummary`, `OrderLineMini`, `AddressBlock`, `AuthSplit`, `WatchmakerArtwork`, `ChatWidget`). Los 22 restantes son de una sola vista (secciones editoriales, filtros, carrito, checkout).
- El núcleo compartido —`Button`, `Price`, `Card`, `SiteHeader`, `SiteFooter`, `Wordmark`, `Icon`, `Checkerboard`— cubre las 12 vistas y es el **primer lote** de implementación.
- Los tres componentes más caros están en el carrito, el checkout y el asistente: los tres tienen estado de cliente (§8).
- `ProductCard` tiene 4 variantes que comparten datos y estados; es la pieza de mayor retorno de reutilización (catálogo, relacionados, lista de deseos, recomendaciones).

## 7. D-012 — Estilos: recomendación (decide el usuario)

**Recomendación: opción (b), CSS propio con variables CSS (`tokens.css`, BRIEF §13) y estilos con ámbito de Astro**, con `@layer` para ordenar la cascada y *container queries* para el responsive de componentes.

Evidencia:
1. **Figma no trae variables enlazadas** (`get_variable_defs` casi vacío, BRIEF §3): los tokens los definimos nosotros en ambos casos; la pregunta es solo cómo se consumen.
2. **El conjunto de tokens es pequeño y cerrado**: 13 colores (más 1 propuesto), 4 familias, 9 espaciados, 5 radios, sin sombras ni movimiento definidos (BRIEF §2–§5). No hay un sistema grande que justifique una utilidad por token.
3. **La lista de revisión pide "sin colores, tamaños ni fuentes sueltos"** (DESIGN §9). Con `var(--…)` se audita con una búsqueda de `#` y `px` en `src/`; con utilidades de Tailwind el código generado por Figma trae valores arbitrarios (`bg-[#b3efb2]`, `text-[20px]`) que esquivan los tokens salvo que se bloquee el tema.
4. **Sin dependencias nuevas** (AGENTS.md): Tailwind v4 añade `tailwindcss` y `@tailwindcss/vite` más configuración; la opción (b) no añade nada.
5. **El responsive es de recomposición** ("reorganiza, no comprimas", BRIEF §6): `grid-template-areas` y *container queries* dentro de un componente con ámbito son más directos que variantes de utilidad por breakpoint.
6. **54 componentes, 32 reutilizados** (§6): el estilo vive en el componente una vez; el beneficio de las utilidades (estilar sin salir del marcado) pesa menos cuando un componente se escribe una sola vez.

Contrapartida honesta: (a) Tailwind v4 acelera a `frontend-dev` porque la salida de referencia de Figma ya es Tailwind (traducción casi directa), y es lo que mejor conocen los modelos. Si se prioriza velocidad sobre cero dependencias, (a) es viable **solo con el tema cerrado a los tokens** (desactivar los valores por defecto y prohibir valores arbitrarios).

## 8. D-014 — Islas: recomendación (decide el usuario)

Islas necesarias según las vistas (§4):

| Isla | Vistas | Estado de cliente | Complejidad |
|---|---|---|---|
| `Cart` (líneas, cantidad, selección, quitar, resumen) | CR | lista que se repinta con el `CartOut` completo tras cada operación; actualización optimista con retroceso | **alta** |
| `CheckoutForm` (envío/recojo, validación por campo, `Idempotency-Key`, pago simulado) | CK | formulario con ramas, errores del servidor por campo, estado de envío | **alta** |
| `ChatWidget` (asistente) | 12 vistas | historial, escritura, respuestas rápidas, carga, modo degradado | **alta** |
| `WishlistToggle` / `AddToCart` | CT, FP, WL | un botón con estado pendiente/hecho/error | baja |
| `AuthForm` (Supabase, mostrar contraseña) | LI, RG | campos, errores, envío | media |
| `CancelOrder` (diálogo + POST) | DP | confirmar y enviar | baja |
| Filtros del catálogo | CT | **no necesita isla**: `<form method="get">` con SSR y chips como enlaces | — |
| Galería, menú móvil, ojo de contraseña | FP, todas, LI/RG | `<details>`, `popover`, un `<script>` | — |

**Recomendación: Preact, cargado solo en las tres islas de complejidad alta (`Cart`, `CheckoutForm`, `ChatWidget`)**; el resto, TypeScript sin framework (`<script>` de Astro o elementos personalizados), y los filtros, menú y galería sin JavaScript.

Evidencia:
1. Las tres islas de complejidad alta **repintan listas desde una respuesta del servidor** (el contrato devuelve siempre el carrito, la lista de deseos o el pedido completos) y tienen estado con ramas (optimista, error por línea, cuenta atrás de `expires_at`). Hacerlo con DOM manual duplica la lógica de repintado y los errores de accesibilidad (`aria-live`, foco) en cada una.
2. El chat aparece en 12 vistas: debe cargarse con `client:idle` y no bloquear el LCP (RNF03).
3. Las islas simples (botones, diálogo, formulario de auth) caben en unas decenas de líneas de TypeScript cada una; no justifican framework.
4. Coste: `preact` + `@astrojs/preact` (2 dependencias; el tamaño de Preact es del orden de unos pocos KB comprimidos: medir al integrar). **Requiere aprobación del usuario y de frontend-lead** (AGENTS.md: sin dependencias nuevas).

Alternativa: TypeScript sin framework en todas las islas. Viable si se acepta escribir a mano el repintado de lista y de formulario en `Cart` y `CheckoutForm`; recomiendo decidirlo con la primera isla real (carrito, T-060), como pide D-014, y fijar un criterio: si `Cart` supera ~200 líneas de manipulación de DOM, adoptar Preact.

## 9. Huecos entre diseño, contrato y requisitos

No se inventa nada: cada hueco es un campo o endpoint que la vista pide y el contrato no ofrece, o un elemento del contrato que Figma no dibuja. **Acción propuesta** por defecto: omitir lo no contractual y abrir revisión de contrato (`api-contract-review`) solo si el usuario lo prioriza.

| ID | Vista | Hueco | Acción propuesta |
|---|---|---|---|
| H-01 | todas con sesión | El servidor de Astro necesita la sesión para renderizar por usuario (SSR); el contrato solo define `Authorization` hacia FastAPI. No hay definición de cookie `httpOnly` frente a token en memoria. | Decisión técnica entre backend-lead y frontend-lead antes de T-060; hasta entonces las vistas por usuario no se pueden implementar. |
| H-02 | CT | Badges "Nuevo" / "Edición limitada" sin campo en `ProductSummary`. | Omitir; si se quiere, campo `badges` aditivo en catalog. (`Nuevo` podría derivarse de `published_at`, que el público no expone.) |
| H-03 | CT | Filtro "Complicación" (dos veces) sin atributo en el catálogo (hay movimiento, material, diámetro, resistencia, precio, disponibilidad, categoría). | Usar movimiento y material (P-2). |
| H-04 | FP | "Material de la caja" como píldoras = variantes del mismo modelo; el contrato modela cada reloj como un producto. | Omitir; mostrar `case_material` como dato. |
| H-05 | FP | Valoración ★ 4,9 (12 reseñas): no hay módulo de reseñas. | Omitir. |
| H-06 | L, CT | "Destacado del mes", colecciones y portada editorial sin endpoint. | Contenido estático; enlazar a categorías existentes (P-2). |
| H-07 | FP | Secciones "El Calibre", "Artesanía y Acabados" y cifras (72h, 29, 286, COSC): solo `description` y `specs[]` existen. | Estático para el modelo de la demo o diferir; las cifras pueden salir de `specs[]` si el catálogo las trae. |
| H-09 | WL, CR | `WishlistItemOut` y `CartItemOut` no traen colección/categoría; la wishlist no tiene recomendaciones. | Mostrar `sku`; omitir el bloque de recomendaciones o alimentarlo con `related` del catálogo (decisión de producto). |
| H-10 | CR | Figma no dibuja la **selección por línea** (RN-05), los estados `status`, `max_quantity`, ni `original_price`/descuento. | Diseñarlos (○) con el brief. |
| H-11 | CK | Figma: nombre, apellidos, dirección, ciudad, código postal, país, teléfono. Contrato: `recipient_name`, `phone`, `department`, `province`, `district`, `address_line`, `reference?` y `delivery_method` (`shipping`/`pickup`). | Seguir el contrato; diseñar selector envío/recojo y campos de ubigeo (○). |
| H-12 | CK, CF, DP | Pago: número de tarjeta, vencimiento y CVV; `payments` sin SPEC (BACKLOG). RN-11/RF05.04: no almacenar datos sensibles. | **No enviar nunca PAN/CVV al backend**; definir con backend-lead la pasarela simulada (P-4). |
| H-13 | CR, CK, DP | "IGV estimado/(18 %) Incluido", "Envío Offerte", "Envío internacional asegurado": el servidor devuelve `subtotal`, `shipping`, `total`, sin desglose de IGV. | Texto fijo "IGV incluido" (precios finales); no calcular; `shipping` según el servidor. |
| H-14 | MP, DP, CF | Estados de Figma (En proceso, En tránsito, En preparación, Enviado, Entregado, Cancelado, Confirmado) frente a los 8 del servidor: `pendiente_pago`, `pagado`, `en_preparacion`, `enviado`, `listo_para_recojo`, `entregado`, `cancelado`, `expirado`. Faltan `pendiente_pago`, `listo_para_recojo` y `expirado`; "En proceso" agrupa varios y el filtro `status` admite **un** valor. | Mapa de etiquetas y color en un solo módulo (`OrderStatusBadge`); filtros por estado real; "En proceso" requiere cambio de contrato (lista de estados, compatible). Pasos pendientes de la línea de tiempo: constante de presentación validada con backend-lead (RN-07). |
| H-15 | MP, DP, CF | Miniaturas de línea: `OrderLineOut` no trae imagen ni `slug` (riesgo D-4 de orders). | Decisión de backend-lead: ampliar con `image` (aditivo) o lector compartido de catalog (P-7). |
| H-16 | MP | "Ordenar por": el listado del cliente no tiene parámetro de orden. | Omitir el selector (orden fijo, más reciente primero). |
| H-17 | DP | IGV, método de pago ("Visa 4521 / Pago verificado"), URL de seguimiento, "Solicitar devolución" y factura: no existen en `OrderDetailOut`. El número de Figma `#VM-2026-4521` ≠ `VAL-000123`. | Omitir; usar `number` del servidor y `carrier`/`tracking_code` como texto. |
| H-18 | LI, RG | "Recuérdame" (sesión persistente), "¿Olvidaste tu contraseña?" (RF01.04, POSTERIOR), fecha de nacimiento (no existe en `ProfileOut`). | Omitir lo no contractual; ver P-8. |
| H-20 | todas | RF08 (asistente): sin contrato de chat en este paquete; 7 diseños de widget. | Un solo `ChatWidget`; cierra con el módulo assistant. |
| H-21 | CR, CK | Rótulos en francés (`Retirer`, `Sous-total`, `Offerte`, `Ville`) y datos de París. | Traducir; el contenido de ejemplo no se copia. |
| H-22 | WL, CK, N | Fotos de cócteles como imagen de producto; teléfonos de contacto distintos entre `/about` y el pie. | Imágenes dinámicas del contrato; contacto en una configuración única. |
| H-23 | CT | Sin buscador por texto (RF02.02, parámetro `q`). | Diseñarlo (○) en la cabecera o la barra de filtros (P-1). |
| H-24 | CT | Orden: solo "Relevancia"; RF02.04 pide precio, novedad y relevancia. | Mostrar las opciones que acepte `sort` (verificar el OpenAPI al implementar). |
| H-26 | MP, DP | Formato de fecha "15 de agosto de 2026". | `Intl` `es-PE`, zona `America/Lima`. |

## 10. Preguntas de negocio y marca (respuesta del usuario o del Leader)

| ID | Pregunta | Opciones | Recomendada |
|---|---|---|---|
| P-1 | **Navegación global.** El diseño no tiene carrito, cuenta, lista de deseos ni búsqueda en la cabecera, y los enlaces cambian por frame ("Boutiques/Tiendas" sin pantalla). | (A) Añadir esos accesos en la cabecera con los iconos del brief (`shopping-bag`, `heart`, `search`, usuario) y enlaces fijos (Relojes, Nosotros, Contacto); (B) no tocar: no hay forma de llegar al carrito (inviable, RF03); (C) pedirle al diseñador un frame nuevo. | **A — DECIDIDA por el usuario (2026-11-26)**: el brief ya incluye esos iconos y es una extensión, no un cambio de marca. |
| P-2 | **Filtros, badges, material y "destacado".** Lo que no tiene contrato (H-02…H-07). | (A) Mostrar solo lo que el catálogo ofrece (movimiento, material, precio, categoría, disponibilidad) y dejar el resto estático o fuera; (B) ampliar catalog (badges, destacados, variantes) con `api-contract-review`. | **A** para el MVP; B solo si lo prioriza el usuario. |
| P-3 | **Formato de precio.** Figma: `S/ 84,500`; el servidor da céntimos (D-015). | (A) `Intl es-PE` sin ".00" cuando el importe es entero y con decimales si no; (B) siempre 2 decimales. | **A**: conserva el diseño y es exacto. |
| P-4 | **Pago simulado y datos de tarjeta** (H-12). | (A) Formulario de tarjeta solo cliente, sin enviar PAN/CVV; resultado aprobado/rechazado simulado por el servidor; (B) quitar los campos y dejar un botón "Simular pago". | **A** si se quiere la experiencia del diseño; decide con backend-lead al planificar `payments`. |
| P-5 | **Sesión en el servidor de Astro** (H-01). | (A) Cookie `httpOnly` emitida tras Supabase Auth y reenviada al backend; (B) token en memoria del navegador (sin SSR por usuario). | **A**, decisión técnica Leader + backend-lead; bloquea T-060. |
| P-6 | **Estados de pedido para el cliente** (H-14). | (A) Pills por estado real (Pendiente de pago, Pagado, En preparación, Enviado, Listo para recojo, Entregado, Cancelado, Expirado); (B) agrupar ("En proceso") ampliando el filtro `status` a lista. | **B** (cambio compatible) para conservar el diseño; **A** si se quiere cero cambios de contrato. |
| P-7 | **Miniaturas en "mis pedidos"** (H-15). | (A) Añadir `image` a `OrderLineOut`; (B) leerla del catálogo con el lector compartido. | **B**: no toca el esquema ni la instantánea del pedido (decide backend-lead). |
| P-8 | **Registro: fecha de nacimiento y "+18"** (H-18). | (A) Omitir y quedarse con el consentimiento de términos y privacidad; (B) añadir `birth_date` a identity (dato personal, RNF10). | **A**; B solo si hay un requisito legal. |
| P-9 | **Contenido de marca de "Nosotros"** (reconocimientos 2022–2025, "Est. 2005", redes `@valmontperu`, teléfonos). | (A) Usarlo tal cual como contenido de la demo; (B) retirarlo hasta confirmar su veracidad. | **B** para producción; **A** en la demo marcada como contenido de ejemplo. |

**Decididas por el usuario (2026-11-26, D-041):** P-1 A · P-2 A, con los elementos sin contrato estáticos y no interactivos · P-3 A, con D-037 para las fracciones · P-4 A, con payments preparado para una pasarela real · P-5 A · P-6 B, agrupación solo de presentación · P-7 B · P-8 B (fecha de nacimiento y +18, dato personal protegido) · P-9: contenido redactado para la demo y retirado antes de producción.

## 11. Tareas propuestas (sin ID; las numera el Leader)

1. `tokens.css`, fuentes alojadas y `BaseLayout`/`StoreLayout`/`AuthLayout` (depende de D-012).
2. Lote 1 de `ui/`: `Button`, `IconButton`, `TextLink`, `Field`, `Checkbox`, `Chip`, `Badge`, `Icon`, `Wordmark`, `Checkerboard`, `Card`, `Price`, `Availability`, `Notice`, `EmptyState`, `Skeleton`.
3. `SiteHeader`, `SiteFooter`, `PageTitle` (depende de P-1).
4. Portada y Nosotros (estáticas).
5. Ingreso y Registro (`AuthForm`, depende de P-5, H-18).
6. Catálogo y ficha: `ProductCard`, filtros, galería, `BuyBox` (`api/catalog.ts`).
7. Lote 2 de `ui/` + islas: `QuantityStepper`, `Stepper`, `Timeline`, `Breadcrumb`, `Pagination`, `WishlistToggle`.
8. Existentes que esta tarea desbloquea: **T-054** (promociones en `Price`), **T-060** (carrito), **T-069** (wishlist), **T-081…T-084** (pantallas de orders: checkout, confirmación, mis pedidos, detalle).
9. `ChatWidget` (cuando exista el contrato de assistant).
10. Backoffice: se diseña desde el brief (sin frames); fuera de este alcance.

**Plan numerado (T-116, 2026-11-26):** los puntos 1–6 son los paquetes T-116…T-131 de [`docs/modules/ui/STATUS.md`](../modules/ui/STATUS.md). Aclaraciones respecto a §2: la portada, el ingreso y el registro se sirven **bajo demanda** (la portada lee las categorías reales; ingreso y registro son un `POST` de la propia página que fija la cookie de sesión); `Breadcrumb` y `Pagination` (lote 2) se adelantan a T-123 porque catálogo y ficha los necesitan. Los puntos 7–10 se reparten entre T-060, T-069, T-081…T-084 y los IDs libres T-132…T-139.
