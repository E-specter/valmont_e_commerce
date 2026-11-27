# catalog — Especificación
> Estado: APROBADO (modelo: decisiones del usuario D-019…D-023; contrato: revisado por frontend-lead el 2026-10-27 y cambios incorporados) · Requisitos: RF02.01–RF02.08, RF06.01–RF06.03, RF06.07 · Decisiones: D-010, D-015, D-019…D-024 · Dueño: backend · Última actualización: 2026-10-27 claude-leader

## 1. Problema y alcance

Los visitantes deben encontrar y conocer cada reloj de Valmont con precisión, y el administrador debe mantener el catálogo.

- **Incluye:** productos, categorías planas, listas de valores de los atributos filtrables, ficha técnica ordenada, política de venta y plazo, imágenes, búsqueda sin tildes, filtros, orden, paginación, productos relacionados y la administración de todo ello con auditoría.
- **No incluye:** el cálculo del estado de disponibilidad, que hace inventory en la vista `app.product_availability`; catalog solo la lee (T-030). Tampoco el precio con promoción (`promotions`) ni la interfaz (frontend).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Visitante y cliente | Listar, buscar, filtrar y ver productos **publicados**, categorías activas y listas de valores activas | Ver borradores ni datos de administración |
| Administrador (`require_admin`) | Crear y editar productos, categorías y listas de valores; publicar y despublicar; gestionar imágenes; configurar la política de venta | Borrar productos (se despublican) |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-CATALOG-01 | Visitante | `GET /products` con filtros, orden y página | Página de resúmenes de productos publicados | 422 | RF02.01, RF02.03, RF02.04 |
| UC-CATALOG-02 | Visitante | `GET /products?q=…` | Resultados por relevancia; sin distinguir tildes ni mayúsculas | 422 | RF02.02 |
| UC-CATALOG-03 | Visitante | `GET /products/{slug}` | Ficha con imágenes, atributos, `specs`, disponibilidad y relacionados | 404 | RF02.05, RF02.06, RF02.07, RF02.08 |
| UC-CATALOG-04 | Visitante | `GET /categories`, `GET /attributes` | Categorías y listas de valores activas | — | RF02.03 |
| UC-CATALOG-05 | Admin | Crear, leer o editar un producto (incluida su política de venta) | Producto en borrador o actualizado; precio auditado | 401, 403, 404, 409, 422 | RF06.01, RF06.07 |
| UC-CATALOG-06 | Admin | Publicar o despublicar | Cambio de estado auditado | 401, 403, 404, 409 | RF06.01 |
| UC-CATALOG-07 | Admin | Listar y gestionar categorías y listas de valores (incluidas las inactivas) | Altas, ediciones, activación y desactivación | 401, 403, 404, 409, 422 | RF06.02 |
| UC-CATALOG-08 | Admin | Subir, editar el `alt`, ordenar o retirar imágenes | Imagen en Supabase Storage y en `product_images` | 401, 403, 404, 409, 413, 415, 422 | RF06.03 |

## 4. Reglas de negocio

- **Globales:** RN-09, RN-14, RN-15, RN-16; D-022 (precio final con IGV); D-023 (disponibilidad y política de venta).
- **CATALOG-R1:** la API pública solo muestra productos `published`; un borrador responde 404 (no se revela que existe).
- **CATALOG-R2:** publicar exige nombre, descripción, categoría activa, precio > 0, al menos una imagen y, si `order_policy` ≠ `stock`, `lead_time_days`. Si falta algo → 409 `publish_requirements_unmet` con `details.missing` (lista de claves: `name`, `description`, `category`, `price`, `image`, `lead_time_days`). **Es un invariante mientras el producto está publicado:** un `PATCH` que lo rompa (precio 0, descripción vacía, categoría inactiva, política sin plazo…) responde el mismo 409 y no cambia nada (hallazgo B-1 de QA en T-028, 2026-10-27).
- **CATALOG-R3:** `sku` y `slug` son únicos (409 `sku_taken` / `slug_taken`). El `slug` es opcional al crear (se genera del nombre: minúsculas, sin tildes, guiones). **No cambia después de la primera publicación** (PATCH → 409 `slug_locked`).
- **CATALOG-R4:** los productos no se borran; se despublican.
- **CATALOG-R5:** los atributos filtrables son opcionales (RF02.07). En la respuesta siempre aparecen, con `null` si no aplican; esos productos quedan fuera del filtro correspondiente.
- **CATALOG-R6:** relacionados = hasta 4 publicados de la misma categoría, excluido el propio, los más recientes primero (aprobado por el usuario).
- **CATALOG-R7:** se auditan `catalog.product_created`, `catalog.price_changed`, `catalog.product_published`, `catalog.product_unpublished` y `catalog.order_policy_changed` (en esta última, solo los campos que cambian entre `order_policy` y `lead_time_days`, AUDIT-R2).
- **CATALOG-R8:** orden: `newest` (por defecto sin `q`; `published_at` desc), `price_asc`, `price_desc` y `relevance` (por defecto con `q`; sin `q` → 422). Empates resueltos por `id` para que la paginación sea estable.
- **CATALOG-R9:** `page_size` entre 1 y 48 (por defecto 24); `page` ≥ 1; una página más allá de la última devuelve `items: []` con el `total` real.
- **CATALOG-R10:** no se puede desactivar una categoría que tiene productos publicados (409 `category_in_use`), aprobado por el usuario.
- **CATALOG-R11:** borrar la última imagen de un producto publicado → 409 `last_image`.
- **CATALOG-R12:** `description` es texto plano con saltos de línea; nunca HTML.
- **CATALOG-R13:** el `price` es el precio que se cobra. Cuando exista promotions, `price` será el precio vigente con descuento (y filtro y orden lo usarán; aprobado por el usuario); un precio anterior tachado llegará como campo opcional nuevo.

## 5. Modelo de dominio

- **Product:** `id`, `sku` (1–40), `slug`, `name` (1–120), `description` (texto plano, 1–5000), `category_id`, `price` (céntimos, IGV incluido, ≥ 0), `status` (`draft` | `published`), `order_policy` (`stock` | `made_to_order` | `backorder`), `lead_time_days?` (> 0), `movement_code?`, `case_material_code?`, `case_diameter_mm?` (> 0, un decimal), `water_resistance_m?` (≥ 0), `specs` (lista ordenada de pares `label` 1–60 / `value` 1–200; máx. 40; `label` único), `published_at?`.
- **Category:** `id`, `slug` (≤ 60), `name` (1–60), `description?` (≤ 500), `position`, `is_active`.
- **AttributeValue** (movimiento y material de la caja): `code` (≤ 60), `label` (1–60), `position`, `is_active`.
- Slugs y códigos: `^[a-z0-9]+(-[a-z0-9]+)*$`. `description` admite saltos de línea (`\r\n` y `\r` se normalizan a `\n`); el resto de caracteres de control se rechaza. Las etiquetas de `specs` son únicas sin distinguir mayúsculas.
- **ProductImage:** `id`, `product_id`, `storage_path`, `alt` (1–150), `position`. La URL pública **no se guarda**: se calcula al responder (§6).
- Los textos de entrada rechazan caracteres de control (criterio de identity).

## 6. Persistencia

```
app.categories       id uuid PK · slug text UNIQUE · name text · description text NULL · position int DEFAULT 0 · is_active bool DEFAULT true · created_at · updated_at
app.movement_types   code text PK · label text · position int DEFAULT 0 · is_active bool DEFAULT true
app.case_materials   code text PK · label text · position int DEFAULT 0 · is_active bool DEFAULT true
app.products         id uuid PK · sku text UNIQUE · slug text UNIQUE · name text · description text
                     category_id uuid FK → categories ON DELETE RESTRICT
                     price_cents integer CHECK (price_cents >= 0)
                     status text CHECK (status IN ('draft','published')) DEFAULT 'draft'
                     order_policy text CHECK (order_policy IN ('stock','made_to_order','backorder')) DEFAULT 'stock'
                     lead_time_days integer NULL CHECK (lead_time_days > 0)
                     movement_code text NULL FK → movement_types · case_material_code text NULL FK → case_materials
                     case_diameter_mm numeric(4,1) NULL CHECK (> 0) · water_resistance_m integer NULL CHECK (>= 0)
                     specs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(specs) = 'array')
                     search tsvector GENERATED ALWAYS AS (to_tsvector('spanish', app.f_unaccent(name || ' ' || sku || ' ' || coalesce(description, '')))) STORED
                     published_at timestamptz NULL · created_at · updated_at
                     INDEX GIN(search) · INDEX (status, published_at) · INDEX (category_id) · INDEX (price_cents)
                     INDEX (movement_code) · INDEX (case_material_code)
app.product_images   id uuid PK · product_id uuid FK → products ON DELETE RESTRICT · storage_path text · alt text
                     position int · created_at · UNIQUE (product_id, position)
```

- `app.f_unaccent(text)`: envoltorio IMMUTABLE sobre la extensión `unaccent`, instalada en el esquema `extensions` (no expuesto por PostgREST; nunca en `public`). La columna generada lo exige y la consulta aplica la misma función al término.
- **URL de imagen** = `<STORAGE_PUBLIC_URL>/storage/v1/object/public/products/<storage_path>`, con `STORAGE_PUBLIC_URL` como ajuste del backend (la URL que alcanza el navegador, distinta de la interna de Docker en producción). Llega con T-029.
- Migración `0004`. Revisión: skill `database-migration-review`.

## 7. Contrato API (APROBADO)

Esquemas comunes (todas las fechas en UTC ISO 8601; `Money` = `{amount: int, currency: "PEN"}`, ambos obligatorios):

```jsonc
// Category (público)        {"slug": "clasicos", "name": "Clásicos", "description": null}
// AttributeValue (público)  {"code": "automatic", "label": "Automático"}
// ProductImage              {"id": "…", "url": "https://…", "alt": "…"}          // por position; sin storage_path
// Availability (desde T-030) {"status": "in_stock" | "low_stock" | "out_of_stock" | "on_request", "lead_time_days": 42 | null}  // lead_time_days solo con on_request; si no, null
// ProductSummary
{"id": "…", "slug": "heritage-38", "sku": "DEMO-H38", "name": "Heritage 38",
 "category": {"slug": "clasicos", "name": "Clásicos"},
 "price": {"amount": 1250000, "currency": "PEN"},          // precio que se cobra (CATALOG-R13)
 "movement": {"code": "automatic", "label": "Automático"},  // o null
 "case_material": {"code": "steel", "label": "Acero"},      // o null
 "case_diameter_mm": 38.0,                                  // número (float) o null
 "water_resistance_m": 50,                                  // o null
 "main_image": {"id": "…", "url": "https://…", "alt": "…"}, // nunca null en publicados
 "availability": {…}}                                       // obligatorio desde T-030; nunca expone cantidades
// ProductDetail = ProductSummary + {"description": "texto plano", "specs": [{"label": "Calibre", "value": "VM-01"}],
//                                   "images": [ProductImage] (≥ 1), "related": [ProductSummary] (0–4)}
```

**Pública** (prefijo `/api/v1/catalog`):

| Método | Ruta | Respuesta | Errores |
|---|---|---|---|
| GET | `/products` | `{items: [ProductSummary], total, page, page_size}` | 422 |
| GET | `/products/{slug}` | `ProductDetail` | 404 |
| GET | `/categories` | `[Category]` (activas, por `position`) | — |
| GET | `/attributes` | `{movements: [AttributeValue], case_materials: [AttributeValue]}` (activos, por `position`) | — |

Parámetros de `GET /products`: `q` (≤ 100; vacío = sin búsqueda) · `category` (un slug; desconocido → `items: []`) · `movement` · `case_material` · `case_diameter_mm_min` / `case_diameter_mm_max` · `water_resistance_m_min` · `price_min` / `price_max` (céntimos) · `available=true` (desde T-030; excluye solo `out_of_stock`, así que incluye `on_request`; `false` o ausente = sin filtro) · `sort` · `page` · `page_size`. Rangos inclusivos; `min > max` → 422; filtros combinados con AND.

**Administración** (prefijo `/api/v1/catalog/admin`; todas con `require_admin`, que añade 401 y 403):

| Método | Ruta | Request | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/products?status&q&page&page_size` | — | página de `AdminProduct` | 422 |
| GET | `/products/{id}` | — | `AdminProduct` | 404 |
| POST | `/products` | `ProductCreateIn` | 201 `AdminProduct` (borrador) | 409 `sku_taken`/`slug_taken`, 422 |
| PATCH | `/products/{id}` | `ProductUpdateIn` (parcial) | `AdminProduct` | 404, 409 `sku_taken`/`slug_taken`/`slug_locked`/`publish_requirements_unmet` (si está publicado, CATALOG-R2), 422 |
| POST | `/products/{id}/publish` · `/unpublish` | — | `AdminProduct` | 404, 409 `publish_requirements_unmet` |
| POST | `/products/{id}/images` | multipart `file` + `alt` (1–150) | 201 `ProductImage` | 404, 413 `file_too_large`, 415 `unsupported_media_type`, 422 (`invalid_image`, `image_dimensions_exceeded`, `animated_image`, T-018i) |
| PATCH | `/products/{id}/images/{image_id}` | `{alt}` | `ProductImage` | 404, 422 |
| DELETE | `/products/{id}/images/{image_id}` | — | 204 | 404, 409 `last_image` |
| PUT | `/products/{id}/images/order` | `[image_id]` (exactamente todos) | `[ProductImage]` | 404, 422 |
| GET | `/categories` | — | `[AdminCategory]` (incluye inactivas) | — |
| POST / PATCH | `/categories` · `/categories/{id}` | `CategoryIn` | `AdminCategory` | 404, 409 `slug_taken`/`category_in_use`, 422 |
| GET | `/attributes` | — | `{movements: [AdminAttributeValue], case_materials: [AdminAttributeValue]}` (incluye inactivos) | — |
| POST / PATCH | `/movement-types` · `/movement-types/{code}` y `/case-materials` · `/case-materials/{code}` | `AttributeValueIn` | `AdminAttributeValue` | 404, 409 `code_taken`, 422 |

- `AdminProduct` = `ProductDetail` sin `related` ni `availability`, + `status`, `order_policy`, `lead_time_days`, `category_id`, `movement_code`, `case_material_code`, `published_at`, `created_at`, `updated_at`.
- `ProductCreateIn` / `ProductUpdateIn`: `sku`, `slug?`, `name`, `description`, `category_id`, `price: Money`, `order_policy`, `lead_time_days?`, `movement_code?`, `case_material_code?`, `case_diameter_mm?`, `water_resistance_m?`, `specs`. En PATCH, `null` borra un atributo opcional. Campos extra (incluido `status`) → 422.
- `AdminCategory` = `Category` + `id`, `position`, `is_active`; `AdminAttributeValue` = `AttributeValue` + `position`, `is_active`.
- **Precisiones aprobadas por el Leader tras T-028 (compatibles):** los `POST` de categorías y de valores responden 201; los `PATCH` usan `CategoryUpdateIn` y `AttributeValueUpdateIn` (parciales; el `code` de un valor es inmutable y va solo en la ruta, así que en el cuerpo → 422); `AdminProduct.main_image` admite `null` (un borrador puede no tener imágenes); en la auditoría de altas, el precio va como `price_cents`. Se revisarán con el consumidor frontend en su próxima revisión de contratos.
- Errores con el formato común, declarados en el OpenAPI (`ERROR_RESPONSES`).

## 8. Dependencias

- **Consume:** `identity` (`require_admin`), `audit` (`AuditRecorder`, `AuditRecorderDep`), Supabase Storage (D-019) mediante un puerto `ImageStorage`.
- **Expone (para cart, orders y assistant):** consulta de productos publicados por id con precio y política de venta.
- **Disponibilidad (T-030):** el filtro `available` y la paginación necesitan el stock en la misma consulta del listado. Se resolverá con una vista de lectura de inventory que catalog consulta en el mismo SQL (no producto a producto); se especifica en la SPEC de inventory. Umbral de "Últimas unidades": 2, configurable por el admin (D-027, INVENTORY-R3).

## 9. Seguridad

- CATALOG-R1; `status` y fechas internas no salen en la API pública.
- Búsqueda con `websearch_to_tsquery('spanish', app.f_unaccent(:q))` parametrizado; nunca SQL concatenado.
- Subida de imágenes: se valida por contenido (firma del archivo), no por la extensión; ≤ 5 MB; nombre generado por el servidor (UUID); la clave de servicio de Storage nunca sale del backend.
- `description` en texto plano (CATALOG-R12): el frontend no la inyecta como HTML.
- Auditoría (CATALOG-R7).

## 10. Criterios de aceptación

- [ ] CA-CATALOG-01 (UC-01; RF02.01, RF02.04): el listado devuelve solo publicados, paginados de forma estable, con los cuatro órdenes y `total` correcto.
- [ ] CA-CATALOG-02 (UC-02; RF02.02): `q` encuentra por nombre, SKU y descripción sin distinguir tildes ni mayúsculas ("automatico" encuentra "Automático").
- [ ] CA-CATALOG-03 (UC-01; RF02.03, RF02.07): cada filtro restringe los resultados; los productos sin el atributo quedan fuera de ese filtro; `min > max` → 422.
- [ ] CA-CATALOG-04 (UC-03; RF02.05, RF02.06): la ficha incluye imágenes ordenadas, atributos (con `null` explícitos), `specs` en orden y hasta 4 relacionados; un borrador o un slug inexistente → 404.
- [ ] CA-CATALOG-05 (UC-05, UC-06; RF06.01, RF06.07): el admin crea, lee, edita y publica según CATALOG-R2 y R3, con los códigos de error de §7; un no admin → 403.
- [ ] CA-CATALOG-06 (UC-07; RF06.02): el admin gestiona categorías y listas de valores (también las inactivas); CATALOG-R10.
- [ ] CA-CATALOG-07 (UC-08; RF06.03): subida, edición del `alt`, orden y retirada de imágenes con los códigos de §7 y CATALOG-R11.
- [ ] CA-CATALOG-08 (CATALOG-R7): las operaciones auditadas dejan su entrada en `app.audit_log` en la misma transacción.
- [x] CA-CATALOG-09 (RF02.08, D-023): con inventory (T-030), el estado de disponibilidad y el filtro `available` siguen D-023.

## 11. Plan de pruebas

- **Unitarias:** slug, CATALOG-R2/R3/R10/R11, validación de filtros, orden y `specs`.
- **HTTP:** contratos públicos y de administración, 401/403/404/409/422 con sus `code`, OpenAPI con `ErrorOut` y `Money.currency` obligatorio.
- **Integración:** filtros y búsqueda sin tildes contra Postgres real, unicidad, auditoría en la misma transacción, `EXPLAIN` con el índice GIN.
- **Storage:** adaptador real contra Supabase Storage local (integración) y fake en las unitarias.

## 12. Preguntas abiertas

| ID | Pregunta | Hipótesis conservadora | Decide |
|---|---|---|---|
| P-CATALOG-1 | ¿Datos de demostración para el frontend? | **Resuelta:** sí, `backend/scripts/seed_dev.py`, ficticios (`DEMO-…`), solo fuera de `prod`, idempotente (T-031) | usuario |
| P-CATALOG-2 | ¿Relacionados elegidos por el admin? | **Resuelta:** regla automática CATALOG-R6 | usuario |
| P-CATALOG-3 | Umbral de "Últimas unidades" | 2 unidades, configurable; se decide en la SPEC de inventory | usuario |

> **T-018i (D-047, D-048):** toda imagen subida se convierte en el servidor a WebP optimizado (calidad 82, lado máximo 2000 px, orientación EXIF aplicada, sRGB) y se guarda **sin metadatos** (EXIF, XMP, ICC) en `<product_id>/<image_id>.webp`; el original nunca se guarda. Entrada: JPEG, PNG o WebP de ≤ 5 MiB y ≤ 25 MP (MPO de móvil aceptado, animadas rechazadas). Las imágenes subidas antes de T-018i no se migran. Adaptador: `catalog/adapters/image_optimizer.py` (Pillow 13.0.0).
