# catalog — Especificación
> Estado: PROPUESTO (modelo aprobado por el usuario en D-019…D-022; contrato API pendiente de revisión por el consumidor frontend) · Requisitos: RF02.01–RF02.07, RF06.01–RF06.03 · Decisiones: D-010, D-015, D-019, D-020, D-021, D-022 · Dueño: backend · Última actualización: 2026-10-27 claude-leader

## 1. Problema y alcance

Los visitantes deben encontrar y conocer cada reloj de Valmont con precisión, y el administrador debe mantener el catálogo.

- **Incluye:** productos, categorías planas, listas de valores de los atributos filtrables, ficha técnica libre, imágenes, búsqueda, filtros, orden, paginación, productos relacionados y la administración de todo ello con auditoría.
- **No incluye:** stock y disponibilidad (`inventory`; se conecta en T-030 mediante un puerto), precio con promoción (`promotions`) y la interfaz (frontend).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Visitante y cliente | Listar, buscar, filtrar y ver productos **publicados**, categorías activas y listas de valores | Ver borradores ni datos de administración |
| Administrador (`require_admin`) | Crear y editar productos, categorías y listas de valores; publicar y despublicar; subir y retirar imágenes | Borrar productos con historial (se despublican) |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-CATALOG-01 | Visitante | `GET /products` con filtros, orden y página | Página de resúmenes de productos publicados | 422 | RF02.01, RF02.03, RF02.04 |
| UC-CATALOG-02 | Visitante | `GET /products?q=…` | Resultados ordenados por relevancia (búsqueda de texto en español) | 422 | RF02.02 |
| UC-CATALOG-03 | Visitante | `GET /products/{slug}` | Ficha completa con imágenes, atributos, `specs` y relacionados | 404 si no existe o no está publicado | RF02.05, RF02.06, RF02.07 |
| UC-CATALOG-04 | Visitante | `GET /categories`, `GET /attributes` | Categorías activas y listas de valores para los filtros | — | RF02.03 |
| UC-CATALOG-05 | Admin | Crear o editar un producto | Producto en borrador o actualizado; el cambio de precio queda auditado | 401, 403, 404, 409 (SKU o slug repetido), 422 | RF06.01 |
| UC-CATALOG-06 | Admin | Publicar o despublicar | Cambio de estado auditado | 401, 403, 404, 409 (requisitos de publicación) | RF06.01 |
| UC-CATALOG-07 | Admin | Gestionar categorías y listas de valores | Altas, ediciones, activación y desactivación | 401, 403, 409, 422 | RF06.02 |
| UC-CATALOG-08 | Admin | Subir, ordenar o retirar imágenes | Imagen en Supabase Storage y en `product_images` | 401, 403, 404, 413, 415, 422 | RF06.03 |

## 4. Reglas de negocio

- **Globales:** RN-09 (los importes los decide el servidor), RN-14 (precio y disponibilidad salen de la BD), RN-15 (céntimos de PEN), D-022 (precio final con IGV).
- **CATALOG-R1:** solo los productos `published` son visibles en la API pública; un borrador responde 404 (no se revela que existe).
- **CATALOG-R2:** publicar exige nombre, descripción, categoría activa, precio > 0 y al menos una imagen.
- **CATALOG-R3:** `sku` y `slug` son únicos. El `slug` se genera del nombre si no se envía (minúsculas, sin acentos, guiones) y no cambia al editar el nombre.
- **CATALOG-R4:** los productos no se borran; se despublican. Así los pedidos y la auditoría conservan sus referencias.
- **CATALOG-R5:** cada atributo filtrable es opcional (RF02.07). Si un producto no lo tiene, no aparece en el filtro correspondiente y la ficha no lo muestra.
- **CATALOG-R6:** productos relacionados = hasta 4 publicados de la misma categoría, excluido el propio, los más recientes primero.
- **CATALOG-R7:** se auditan `catalog.product_created`, `catalog.price_changed`, `catalog.product_published` y `catalog.product_unpublished` (RF14.01; skill de audit: `AuditRecorder`).
- **CATALOG-R8:** orden permitido: `newest` (por defecto; `published_at` desc), `price_asc`, `price_desc` y `relevance` (solo con `q`).
- **CATALOG-R9:** `page_size` entre 1 y 48 (por defecto 24).

## 5. Modelo de dominio

- **Product:** `id`, `sku`, `slug`, `name`, `description`, `category_id`, `price` (céntimos, IGV incluido), `status` (`draft` | `published`), `movement_code?`, `case_material_code?`, `case_diameter_mm?` (> 0, un decimal), `water_resistance_m?` (≥ 0), `specs` (objeto de texto clave → valor), `published_at?`.
  - Invariantes: CATALOG-R2 al publicar; precio ≥ 0 siempre.
- **Category:** `id`, `slug`, `name`, `description?`, `position`, `is_active`.
- **AttributeValue** (movimiento y material de la caja): `code`, `label`, `position`, `is_active`.
- **ProductImage:** `id`, `product_id`, `storage_path`, `url`, `alt`, `position`.
- Los textos de entrada rechazan caracteres de control (mismo criterio que identity).

## 6. Persistencia

```
app.categories       id uuid PK · slug text UNIQUE · name text · description text NULL · position int DEFAULT 0 · is_active bool DEFAULT true · created_at · updated_at
app.movement_types   code text PK · label text · position int DEFAULT 0 · is_active bool DEFAULT true
app.case_materials   code text PK · label text · position int DEFAULT 0 · is_active bool DEFAULT true
app.products         id uuid PK · sku text UNIQUE · slug text UNIQUE · name text · description text
                     category_id uuid FK → categories ON DELETE RESTRICT
                     price_cents integer CHECK (price_cents >= 0)
                     status text CHECK (status IN ('draft','published')) DEFAULT 'draft'
                     movement_code text NULL FK → movement_types · case_material_code text NULL FK → case_materials
                     case_diameter_mm numeric(4,1) NULL CHECK (> 0) · water_resistance_m integer NULL CHECK (>= 0)
                     specs jsonb DEFAULT '{}' CHECK (jsonb_typeof(specs) = 'object')
                     search tsvector GENERATED ALWAYS AS (to_tsvector('spanish', name || ' ' || sku || ' ' || coalesce(description, ''))) STORED
                     published_at timestamptz NULL · created_at · updated_at
                     INDEX GIN(search) · INDEX (status, published_at) · INDEX (category_id) · INDEX (price_cents)
app.product_images   id uuid PK · product_id uuid FK → products ON DELETE RESTRICT · storage_path text · url text · alt text
                     position int · created_at · UNIQUE (product_id, position)
```

- Migración `0004`. Revisión: skill `database-migration-review`.
- La moneda no se guarda: es `PEN` en todo el sistema (D-015); la API la expone en el objeto `Money`.

## 7. Contrato API (PROPUESTO)

Pública, prefijo `/api/v1/catalog`:

| Método | Ruta | Respuesta | Errores |
|---|---|---|---|
| GET | `/products?q&category&movement&case_material&diameter_min&diameter_max&water_resistance_min&price_min&price_max&sort&page&page_size` | `{items: [ProductSummary], total, page, page_size}` | 422 |
| GET | `/products/{slug}` | `ProductDetail` | 404 |
| GET | `/categories` | `[Category]` (activas, por `position`) | — |
| GET | `/attributes` | `{movements: [AttributeValue], case_materials: [AttributeValue]}` (activos) | — |

Administración, prefijo `/api/v1/catalog/admin` (todas con `require_admin`; errores 401 y 403 además de los indicados):

| Método | Ruta | Request | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/products?status&q&page&page_size` | — | página de `AdminProduct` | 422 |
| POST | `/products` | `ProductCreateIn` | 201 `AdminProduct` (borrador) | 409, 422 |
| PATCH | `/products/{id}` | `ProductUpdateIn` (parcial) | `AdminProduct` | 404, 409, 422 |
| POST | `/products/{id}/publish` · `/unpublish` | — | `AdminProduct` | 404, 409 |
| POST | `/products/{id}/images` | multipart `file` + `alt` | 201 `ProductImage` | 404, 413, 415, 422 |
| DELETE | `/products/{id}/images/{image_id}` | — | 204 | 404 |
| PUT | `/products/{id}/images/order` | `[image_id]` | `[ProductImage]` | 404, 422 |
| POST / PATCH | `/categories` · `/categories/{id}` | `CategoryIn` | `Category` | 404, 409, 422 |
| POST / PATCH | `/movement-types` · `/movement-types/{code}` y `/case-materials` · `/case-materials/{code}` | `AttributeValueIn` | `AttributeValue` | 404, 409, 422 |

```jsonc
// ProductSummary
{"id": "…", "slug": "valmont-heritage-38", "sku": "VH-38-ST", "name": "Heritage 38",
 "category": {"slug": "clasicos", "name": "Clásicos"},
 "price": {"amount": 1250000, "currency": "PEN"},
 "movement": {"code": "automatic", "label": "Automático"},
 "case_material": {"code": "steel", "label": "Acero"},
 "case_diameter_mm": 38.0, "water_resistance_m": 50,
 "main_image": {"url": "https://…", "alt": "…"}}
// ProductDetail = ProductSummary + description, specs {texto: texto}, images [ProductImage], related [ProductSummary]
```

Errores con el formato común y declarados en el OpenAPI (`ERROR_RESPONSES`).

## 8. Dependencias

- **Consume:** `identity` (`require_admin`), `audit` (`AuditRecorder`, `AuditRecorderDep`), Supabase Storage (D-019) mediante un puerto `ImageStorage` con su adaptador.
- **Expone (para cart, orders y assistant):** consulta de productos publicados por id con su precio vigente; puerto `AvailabilityReader` que implementará `inventory` (T-030).

## 9. Seguridad

- Solo los productos publicados llegan a la API pública (CATALOG-R1); `status` y fechas internas no salen en la respuesta pública.
- La búsqueda usa `websearch_to_tsquery` / `plainto_tsquery` parametrizado; nunca SQL concatenado.
- Subida de imágenes: se valida por contenido (firma del archivo), no por la extensión; tamaño ≤ 5 MB; nombre de archivo generado por el servidor (UUID); la clave de servicio de Storage nunca sale del backend ni de su `.env`.
- Auditoría de precio y publicación (CATALOG-R7).

## 10. Criterios de aceptación

- [ ] CA-CATALOG-01 (UC-01; RF02.01, RF02.04): el listado devuelve solo publicados, paginados, con los cuatro órdenes y `total` correcto.
- [ ] CA-CATALOG-02 (UC-02; RF02.02): `q` encuentra por nombre, SKU y descripción, sin distinguir acentos ni mayúsculas en lo posible, y ordena por relevancia.
- [ ] CA-CATALOG-03 (UC-01; RF02.03, RF02.07): cada filtro (categoría, movimiento, material, rango de diámetro, resistencia mínima, rango de precio) restringe los resultados; los productos sin el atributo quedan fuera de ese filtro.
- [ ] CA-CATALOG-04 (UC-03; RF02.05, RF02.06): la ficha incluye imágenes ordenadas, atributos, `specs` y hasta 4 relacionados de la misma categoría; un borrador o un slug inexistente → 404.
- [ ] CA-CATALOG-05 (UC-05, UC-06; RF06.01): el admin crea un borrador, lo edita y lo publica solo si cumple CATALOG-R2; SKU o slug repetido → 409; un no admin → 403.
- [ ] CA-CATALOG-06 (UC-07; RF06.02): el admin gestiona categorías y listas de valores; un valor desactivado deja de aparecer en `/attributes`.
- [ ] CA-CATALOG-07 (UC-08; RF06.03): subir una imagen válida la guarda en Storage y en `product_images`; tipo no permitido → 415; > 5 MB → 413.
- [ ] CA-CATALOG-08 (CATALOG-R7): crear, cambiar el precio, publicar y despublicar dejan sus entradas en `app.audit_log` en la misma transacción.

## 11. Plan de pruebas

- **Unitarias:** generación de slug, CATALOG-R2, validación de filtros y orden.
- **HTTP:** contratos públicos y de administración, 401, 403 y 404, OpenAPI con `ErrorOut`.
- **Integración:** filtros y búsqueda contra Postgres real (con datos de prueba), unicidad, auditoría en la misma transacción, `EXPLAIN` de la búsqueda usando el índice GIN.
- **Storage:** adaptador real contra Supabase Storage local (integración) y fake en las pruebas unitarias.

## 12. Preguntas abiertas

| ID | Pregunta | Hipótesis conservadora | Decide |
|---|---|---|---|
| P-CATALOG-1 | ¿Se cargan datos de demostración (relojes ficticios marcados como tales) para el desarrollo del frontend con Kombai? | Sí, un script de semillas solo para `dev`, con datos claramente ficticios | usuario |
| P-CATALOG-2 | ¿Los relacionados los elige el admin en vez de la regla CATALOG-R6? | Regla automática en el MVP | usuario |
