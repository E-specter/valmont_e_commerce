# promotions — Especificación
> Estado: PROPUESTO (decisiones de negocio del usuario del 2026-11-26, D-037; falta la aprobación del contrato por backend-lead y frontend-lead) · Requisitos: RF09.01, RF09.02 · Reglas globales: RN-04, RN-09, RN-14, RN-15 · Decisiones: D-015, D-022, D-037, CATALOG-R13 · Dueño: backend · Última actualización: 2026-11-26 module-coordinator (T-050, v2 con las decisiones de §12)

## 1. Problema y alcance

Que el administrador pueda poner relojes en promoción durante un período y que el cliente vea, y el servidor cobre, siempre el mejor precio vigente.

- **Incluye** (D-037):
  - Promociones de **dos tipos**: porcentaje (`percent`) o monto fijo en soles (`fixed_amount`), con nombre y vigencia (inicio y fin).
  - Tres **alcances**: una lista de productos (`products`), una categoría (`category`) o todo el catálogo (`catalog`).
  - Alta, edición, activación y desactivación por el administrador, con auditoría.
  - **Precio vigente** calculado en el servidor: una vista de lectura que usa catalog (listado, ficha, filtro y orden por precio) y un puerto que usarán cart y orders.
  - Los datos del puerto (precio de lista, precio vigente, ahorro y promoción aplicada) alimentan la instantánea del pedido (RN-04, RF04.02); la guarda orders, no promotions.
- **No incluye:**
  - Cupones o códigos, descuentos por cantidad, "2×1", envío gratis, promociones por cliente o segmento y acumulación de promociones (D-037: gana una sola).
  - Un listado público de ofertas ni un filtro `on_sale` en catalog (posterior; compatible con este contrato).
  - Cambiar el precio base del producto: sigue siendo de catalog (CATALOG-R13, D-022). Promotions **no escribe** en tablas de catalog.
  - La interfaz (backoffice y precio en la tienda): la planifica frontend-lead cuando existan `docs/design_ui/VIEWS.md` y los nodos de Figma (T-054).
  - El desglose del IGV: el precio vigente sigue con IGV incluido (D-022).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Administrador (`require_admin`) | Crear, editar, activar, desactivar, listar y consultar promociones | Borrarlas (se desactivan); modificar el precio base desde aquí |
| Visitante y cliente | Ver el precio vigente, el precio anterior y el ahorro en las respuestas públicas de catalog | Ver promociones inactivas, programadas o vencidas, ni el listado, el nombre o las fechas de las promociones |
| Módulo catalog (lectura) | Leer la vista `app.product_effective_price` en sus consultas | Escribir en tablas de promotions |
| Módulos cart y orders (casos de uso) | Pedir los precios vigentes con `GetEffectivePrices` | Escribir en promotions; aceptar un precio enviado por el cliente (RN-09) |

La autorización va siempre en el backend (`require_admin`); el cliente nunca envía precios ni descuentos.

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-PROMOTIONS-01 | Admin | `name`, `kind` (+ `percent_off` o `amount_off`), `scope` (+ `product_ids` o `category_id`), `starts_at`, `ends_at` | Promoción creada (activa por defecto) y auditada | 401, 403, 422 | RF09.01 |
| UC-PROMOTIONS-02 | Admin | Cambios parciales de cualquier campo de UC-01; el resultado debe ser coherente (R14) | Promoción actualizada y auditada; el precio vigente cambia al instante | 401, 403, 404, 422 | RF09.01 |
| UC-PROMOTIONS-03 | Admin | Activar o desactivar | `is_active` cambiado; idempotente; auditado solo si cambia | 401, 403, 404 | RF09.01 |
| UC-PROMOTIONS-04 | Admin | Listado (filtros `status`, `scope`; paginación) y detalle | Promociones con su estado calculado por el servidor, su tipo, su alcance y sus productos | 401, 403, 404, 422 | RF09.01 |
| UC-PROMOTIONS-05 | Visitante / cliente | Consulta pública de catalog (listado, ficha, relacionados) | `price` con el mejor descuento vigente, `original_price` y `discount_amount` si hay promoción; filtro y orden por precio sobre ese precio | 422 (los de catalog) | RF09.02 |
| UC-PROMOTIONS-06 | cart / orders | `GetEffectivePrices(product_ids) → dict[UUID, EffectivePrice]` dentro de su transacción | Precio de lista, precio vigente, ahorro y promoción aplicada, por producto | — (un producto inexistente no aparece en el resultado) | RF09.02 |

## 4. Reglas de negocio

- **Globales:** RN-04 (la instantánea del pedido no cambia), RN-09 (importes en el servidor), RN-14 (precio solo de la fuente autorizada), RN-15 (PEN en céntimos enteros), D-022 (IGV incluido), CATALOG-R13 (el `price` público es el que se cobra; filtro y orden por ese precio; el precio anterior llega como campo opcional nuevo; aprobado por el usuario).
- **PROMOTIONS-R1 (tipo y valor, D-037):**
  - `percent`: `percent_off` entero de 1 a 90 (H-2 la cota de 90 sigue siendo una hipótesis de la SPEC).
  - `fixed_amount`: `amount_off` entero en céntimos de PEN, de 1 a 2 147 483 647.
  - El valor del otro tipo debe estar ausente o `null`.
- **PROMOTIONS-R2 (vigencia):** `starts_at` y `ends_at` son obligatorios, en UTC, y `ends_at > starts_at`. El intervalo es semiabierto: vigente desde `starts_at` incluido hasta `ends_at` excluido.
- **PROMOTIONS-R3 (vigente):** una promoción está vigente si `is_active` y `starts_at <= now() < ends_at`. `now()` es la hora de la transacción de la BD, la misma fuente que usa la vista de disponibilidad de inventory; sin procesos en segundo plano: una promoción deja de aplicarse sola al vencer.
- **PROMOTIONS-R4 (alcance, D-037):**
  - `products`: lista de 1 a 100 productos distintos que existen en catalog, en cualquier estado (se puede preparar una promoción de un reloj aún en borrador). `category_id` debe estar ausente o `null`. H-1: el tope de 100 es de la SPEC.
  - `category`: una categoría que existe en catalog (H-6: aunque esté inactiva); `product_ids` ausente o vacío. Aplica a **todo producto cuya categoría sea esa en el momento de la consulta**, incluidos los añadidos después y los que cambian de categoría.
  - `catalog`: todo el catálogo; ni `product_ids` ni `category_id`. Aplica también a los productos añadidos después.
  - Un producto puede estar cubierto por varias promociones a la vez (R5).
- **PROMOTIONS-R5 (competencia: gana una sola, D-037):** de las promociones **vigentes que cubren al producto** (R3 y R4) se aplica **una sola**: la que deja el **menor precio final** (R6), con independencia de su tipo o alcance; con empate, la de menor `id`. Nunca se acumulan. Una promoción cuyo descuento calculado es 0 (p. ej. precio base de 1 céntimo) no cuenta como aplicada.
- **PROMOTIONS-R6 (cálculo y redondeo, D-037):** todo en enteros, sobre el precio de lista `L` de catalog.
  - `percent`: `descuento = (L × percent_off + 50) ÷ 100` (división entera: al céntimo más cercano, mitad hacia arriba). El producto se calcula en 64 bits.
  - `fixed_amount`: `descuento = amount_off`.
  - En ambos, `descuento = min(descuento, L − 1)` (con `L ≥ 1`; con `L = 0`, 0). Invariante: **precio final ≥ 1 céntimo**. *H-5: un monto fijo mayor que el precio deja el precio en 1 céntimo en lugar de rechazarse; es lo más simple y seguro porque el alcance `category`/`catalog` hace imposible validarlo al crear.*
  - `precio_vigente = L − descuento`; ahorro = `descuento`. Sin promoción aplicada, `precio_vigente = L` y ahorro 0.
- **PROMOTIONS-R7 (sin copia del precio):** promotions guarda solo el porcentaje o el monto, nunca un precio. Si el admin cambia el precio base en catalog, el precio vigente se recalcula en la siguiente consulta.
- **PROMOTIONS-R8 (sin borrado):** las promociones no se borran; se desactivan y se pueden reactivar (como CATALOG-R4). Una promoción vencida no se "reactiva": se edita `ends_at`.
- **PROMOTIONS-R9 (estado calculado):** el servidor devuelve `status`: `inactive` (`is_active` falso, tenga la fecha que tenga) · `scheduled` (activa y `now() < starts_at`) · `active` (vigente, R3) · `expired` (activa y `now() >= ends_at`). El cliente no lo calcula.
- **PROMOTIONS-R10 (fechas al crear y editar):** al crear, `ends_at` debe ser posterior a `now()` (no se crean promociones ya vencidas). Al editar solo se exige R2, para poder corregir o extender una promoción en cualquier estado (H-4).
- **PROMOTIONS-R11 (pedidos existentes, RN-04):** cambiar, desactivar o vencer una promoción no altera pedidos ya creados. Orders toma la instantánea de `EffectivePrice` (`list_price`, `price`, `discount_amount`, `promotion_id`) al crear el pedido y recalcula con el servidor cualquier consulta de carrito (RN-09).
- **PROMOTIONS-R12 (concurrencia):** crear y editar son una transacción; editar bloquea la fila de la promoción (`FOR UPDATE`) antes de reemplazar su alcance, como catalog con sus productos.
- **PROMOTIONS-R13 (auditoría, RF14.01):** se auditan `promotions.promotion_created`, `promotions.promotion_updated`, `promotions.promotion_activated` y `promotions.promotion_deactivated` (`entity_type = "promotion"`), con `before`/`after` solo de lo que cambia (AUDIT-R2). Campos auditados: `name`, `kind`, `percent_off`, `amount_off_cents`, `scope`, `category_id`, `product_ids` (lista ordenada de textos), `starts_at` y `ends_at` (ISO 8601 UTC). El precio vigente no se audita: es derivado.
- **PROMOTIONS-R14 (edición parcial coherente):** `PATCH` aplica los cambios sobre el estado actual y valida el **resultado** con R1, R2 y R4.
  - Al cambiar `kind`, el valor del tipo anterior se descarta y el del nuevo tipo es obligatorio en la misma solicitud (si no, 422).
  - Al cambiar `scope`, lo del alcance anterior se descarta (al salir de `products` se vacía la lista) y lo del nuevo es obligatorio en la misma solicitud.
  - Enviar un valor que no corresponde al tipo o alcance resultante → 422.

## 5. Modelo de dominio

- **PromotionKind** (`percent | fixed_amount`) y **PromotionScope** (`products | category | catalog`).
- **Promotion:** `id`, `name` (1–120, texto plano sin caracteres de control), `kind`, `percent_off` (`int | None`), `amount_off` (`int | None`, céntimos), `scope`, `category_id` (`UUID | None`), `product_ids` (`tuple[UUID, ...]`; vacía salvo en `products`), `starts_at`, `ends_at`, `is_active`. Invariantes: R1, R2, R4.
- **PromotionStatus:** `inactive | scheduled | active | expired` y la función pura `status_at(now)` (R9).
- **EffectivePrice (objeto de valor, lo que ven cart y orders):** `product_id`, `list_price` (céntimos), `price` (céntimos, R6), `discount_amount` (céntimos; 0 sin promoción), `promotion_id` (`UUID | None`).
- **Máquina de estados** (calculada, no guardada): `scheduled → active → expired` por el reloj; `inactive` se alcanza y se deja con desactivar y activar, desde cualquiera.

## 6. Persistencia

Migración **0007** (siguiente tras `0006`; `--rev-id 0007`). Tablas en el esquema `app`; nombres de restricciones con `op.f(...)`, como en `0004`/`0005`. Revisar con la skill `database-migration-review`.

```
app.promotions          id uuid PK · name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120)
                        kind text NOT NULL CHECK (kind IN ('percent','fixed_amount'))
                        percent_off smallint NULL · amount_off_cents integer NULL
                        CHECK ((kind = 'percent' AND percent_off BETWEEN 1 AND 90 AND amount_off_cents IS NULL)
                            OR (kind = 'fixed_amount' AND amount_off_cents >= 1 AND percent_off IS NULL))
                        scope text NOT NULL CHECK (scope IN ('products','category','catalog'))
                        category_id uuid NULL FK → app.categories ON DELETE RESTRICT
                        CHECK ((scope = 'category') = (category_id IS NOT NULL))
                        starts_at timestamptz NOT NULL · ends_at timestamptz NOT NULL · CHECK (ends_at > starts_at)
                        is_active boolean NOT NULL DEFAULT true · created_at · updated_at (timestamptz DEFAULT now())
                        UNIQUE (id, scope)                                  -- destino de la FK compuesta de abajo
                        INDEX (is_active, starts_at, ends_at) · INDEX (category_id) WHERE category_id IS NOT NULL
app.promotion_products  promotion_id uuid NOT NULL · scope text NOT NULL DEFAULT 'products' CHECK (scope = 'products')
                        product_id uuid NOT NULL FK → app.products ON DELETE RESTRICT
                        FK (promotion_id, scope) → app.promotions (id, scope) ON DELETE CASCADE
                        PK (promotion_id, product_id) · INDEX (product_id)
VIEW app.product_effective_price (product_id, list_price_cents, effective_price_cents, discount_amount_cents, promotion_id)
                        = una fila por producto de app.products; con LEFT JOIN LATERAL toma, de las promociones vigentes (R3)
                          que lo cubren (R4), la de menor precio final y menor id (R5), con R6 en aritmética bigint.
```

- **Coherencia del alcance en la BD:** la FK compuesta hace que solo una promoción de alcance `products` pueda tener filas en `promotion_products` (cambiar el alcance con filas presentes falla; el caso de uso las borra antes, R14). Que una promoción `products` tenga **al menos un** producto no se puede expresar con un CHECK entre tablas: lo impone el dominio (R4) y lo prueba QA.
- Sin `created_by`: el actor queda en la auditoría.
- La vista sigue el patrón de `app.product_availability` (0005): **contrato de lectura** de promotions para catalog. Una fila por producto garantiza que el `JOIN` de catalog no pierde productos.
- Bosquejo orientativo del cálculo en SQL (el desarrollador lo ajusta):

```sql
SELECT p.id AS product_id, p.price_cents AS list_price_cents,
       p.price_cents - coalesce(b.discount, 0) AS effective_price_cents,
       coalesce(b.discount, 0) AS discount_amount_cents, b.promotion_id
FROM app.products p
LEFT JOIN LATERAL (
    SELECT c.id AS promotion_id, c.discount
    FROM (
        SELECT pr.id,
               least(CASE pr.kind WHEN 'percent' THEN (p.price_cents::bigint * pr.percent_off + 50) / 100
                                  ELSE pr.amount_off_cents END,
                     greatest(p.price_cents - 1, 0))::integer AS discount
        FROM app.promotions pr
        WHERE pr.is_active AND pr.starts_at <= now() AND now() < pr.ends_at
          AND (pr.scope = 'catalog'
               OR (pr.scope = 'category' AND pr.category_id = p.category_id)
               OR (pr.scope = 'products' AND EXISTS (SELECT 1 FROM app.promotion_products pp
                                                     WHERE pp.promotion_id = pr.id AND pp.product_id = p.id)))
    ) c
    WHERE c.discount > 0
    ORDER BY c.discount DESC, c.id LIMIT 1          -- mayor descuento = menor precio final
) b ON true
```

- Reversible: `downgrade` borra la vista primero y luego las tablas (destructivo solo para los datos de promociones; BD locales y de pruebas).
- El índice de catalog sobre `price_cents` deja de servir al orden por precio (se ordena por el precio vigente); con el volumen del MVP (decenas de relojes) no importa (riesgo en §8).

## 7. Contrato API (PROPUESTO)

Prefijo `/api/v1/promotions/admin`. Todas las rutas con `require_admin` (añade 401 `unauthenticated`, 403 `forbidden`, 503 `auth_unavailable`). Fechas en UTC ISO 8601 (`UtcDatetime`); `Money` = `{amount, currency}` de `shared/money.py`; un campo extra en el cuerpo → 422. Errores con `ERROR_RESPONSES` de `shared/errors.py`.

```jsonc
// PromotionIn (POST). Ejemplos: tipo percent con alcance products, y tipo fixed_amount con alcance category
{"name": "Temporada de otoño", "kind": "percent", "percent_off": 15,
 "scope": "products", "product_ids": ["uuid", "uuid"],
 "starts_at": "2026-12-01T05:00:00Z", "ends_at": "2026-12-31T04:59:59Z"}
{"name": "Clásicos", "kind": "fixed_amount", "amount_off": {"amount": 20000, "currency": "PEN"},
 "scope": "category", "category_id": "uuid",
 "starts_at": "…Z", "ends_at": "…Z"}
// Campos que no corresponden al tipo o alcance: ausentes o null. scope "catalog": sin product_ids ni category_id.
// PromotionUpdateIn (PATCH): los mismos campos, todos opcionales; al menos uno; semántica de R14
// PromotionSummaryOut
{"id": "uuid", "name": "…", "kind": "percent", "percent_off": 15,        // percent_off: int | null
 "amount_off": null,                                                       // Money | null (solo fixed_amount)
 "scope": "products", "category": null,                                    // category: {"id","slug","name"} | null
 "starts_at": "…Z", "ends_at": "…Z", "is_active": true,
 "status": "scheduled",                                                    // "inactive" | "scheduled" | "active" | "expired" (R9)
 "product_count": 2,                                                       // solo scope=products; 0 en los demás
 "created_at": "…Z", "updated_at": "…Z"}
// PromotionDetailOut = PromotionSummaryOut + {"products": [PromotionProductOut]}   // por sku; [] si scope ≠ products
// PromotionProductOut
{"id": "uuid", "sku": "DEMO-H38", "name": "Heritage 38",
 "list_price": {"amount": 1250000, "currency": "PEN"},   // precio base de catalog
 "price": {"amount": 1062500, "currency": "PEN"}}        // precio vigente HOY con la mejor promoción (puede ser otra)
```

| Método | Ruta | Request | Respuesta | Errores |
|---|---|---|---|---|
| GET | `/promotions?status&scope&page&page_size` | — | `{items: [PromotionSummaryOut], total, page, page_size}` | 422 |
| POST | `/promotions` | `PromotionIn` | 201 `PromotionDetailOut` | 422 |
| GET | `/promotions/{id}` | — | `PromotionDetailOut` | 404, 422 |
| PATCH | `/promotions/{id}` | `PromotionUpdateIn` | `PromotionDetailOut` | 404, 422 |
| POST | `/promotions/{id}/activate` | — | `PromotionDetailOut` | 404, 422 |
| POST | `/promotions/{id}/deactivate` | — | `PromotionDetailOut` | 404, 422 |

**Listado:** `status` uno de los cuatro valores y `scope` uno de los tres (otro → 422); orden `starts_at` descendente y `id` para estabilidad; `page` 1–1000 y `page_size` 1–48 (24 por defecto), como catalog; una página más allá de la última devuelve `items: []` con el `total` real. No se ve cuántos productos cubre una promoción `category` o `catalog` (posterior).

**Validación (422 `validation_error`, con `details[].loc` = `["body", "<campo>"]`):**
- `name`: texto 1–120 tras recortar espacios, sin caracteres de control (como en identity y catalog).
- `kind`: uno de los dos valores. `percent_off`: entero estricto 1–90. `amount_off`: `Money` con `amount` entero estricto de 1 a 2 147 483 647 y `currency` `PEN`. Un valor del otro tipo, o el que falta del tipo elegido → 422 con `loc` en ese campo (R1).
- `scope`: uno de los tres valores. `product_ids`: 1–100 UUID **distintos** solo con `products`; un id repetido o inexistente → 422 con `loc` `["body", "product_ids"]` (patrón `InvalidReference` de catalog; el mensaje no repite el dato). `category_id`: obligatorio con `category` y solo con él; inexistente → 422 con `loc` `["body", "category_id"]`. Campos que no corresponden → 422 (R4).
- `starts_at`/`ends_at`: obligatorios al crear, con zona horaria; `ends_at > starts_at` (R2; el error sale con `loc` en `ends_at`); al crear, `ends_at > now()` (R10).
- `PATCH` sin ningún campo → 422; un resultado incoherente → 422 (R14). Un `id` de ruta mal formado → 422. Un `id` inexistente → 404 `not_found`.
- `activate`/`deactivate` repetidos → 200 sin cambios ni entrada de auditoría.

**Efecto en las respuestas públicas de catalog (cambio aditivo en `ProductSummary` y, por herencia, `ProductDetail` y `related`; lo implementa T-053):**

```jsonc
"price": {"amount": 1062500, "currency": "PEN"},            // ahora el precio vigente (CATALOG-R13)
"original_price": {"amount": 1250000, "currency": "PEN"},   // precio de lista; null sin promoción aplicada
"discount_amount": {"amount": 187500, "currency": "PEN"}    // ahorro = original_price − price; null sin promoción aplicada
```

- **Recomendación de contrato (H-7):** `original_price` + `discount_amount`, valen igual para `percent` y `fixed_amount`, los calcula el servidor (el frontend no resta importes, RN-09) y no obligan a decidir ahora cómo mostrar el tipo. Alternativas descartadas: (a) `discount: {type, value}` mezcla un entero y un `Money` según el tipo y obliga al cliente a ramificar; (b) solo `original_price` deja al frontend restar para "Ahorras S/ X" y no hay nada para una etiqueta. Un `discount_percent` efectivo (redondeado en el servidor) o `discount_type` se pueden **añadir** después sin romper este contrato.
- `original_price` y `discount_amount` son `null` a la vez o presentes a la vez; se declaran obligatorios con valor anulable en el OpenAPI (siempre viajan), como `case_material`. Nunca se expone el nombre, el tipo, el alcance ni las fechas de la promoción.
- `price_min`/`price_max` y `sort=price_asc|price_desc` actúan sobre el precio vigente, con los empates por `id` de CATALOG-R8.
- La administración de catalog (`AdminProduct`) **no cambia**: `price` sigue siendo el precio base que el admin edita.
- Sin promoción aplicada la respuesta es la de hoy más los dos campos en `null`: no rompe a los clientes actuales.
- El frontend no calcula descuentos: pinta `price` y, si `original_price` no es `null`, lo muestra tachado y puede mostrar `discount_amount` como ahorro (componente "precio (con promoción)" de `docs/design_ui/DESIGN.md`).

**Sin endpoints públicos de promotions:** UC-05 se sirve por catalog; UC-06 es un caso de uso interno (§8).

## 8. Dependencias

- **Consume:** `catalog` (existencia, precio base y categoría de los productos, y existencia de categorías, **solo leyendo** en SQL `app.products.id`, `price_cents` y `category_id`, y con FK a `app.products` y `app.categories`), `identity` (`require_admin`), `audit` (`AuditRecorder`, `AuditRecorderDep`).
- **Expone:**
  - La vista `app.product_effective_price` (para catalog, T-053).
  - El puerto de lectura para cart y orders, en `valmont.modules.promotions.application`:

```python
@dataclass(frozen=True)
class EffectivePrice:
    product_id: UUID
    list_price: int       # céntimos de PEN con IGV incluido (precio base de catalog)
    price: int            # céntimos, precio vigente (R6); >= 1
    discount_amount: int  # céntimos de ahorro = list_price - price; 0 sin promoción aplicada
    promotion_id: UUID | None

class GetEffectivePrices:
    def __init__(self, reader: EffectivePriceReader) -> None: ...
    def __call__(self, product_ids: Collection[UUID]) -> dict[UUID, EffectivePrice]: ...
    # Duplicados se ignoran; sin ids → {} sin consultar; un id que no existe no aparece en el resultado.
```

  - `EffectivePriceReader` (puerto, implementado en `adapters/persistence.py`): `get_many(product_ids: Collection[UUID]) -> list[EffectivePrice]`, leyendo la vista.
- **Obligaciones de cart y orders al usarlo** (a recoger en sus SPEC):
  - Llamarlo dentro de la misma transacción del cálculo del importe y no aceptar nunca un precio del cliente (RN-09).
  - Validar con catalog que el producto existe y está publicado: el puerto no mira el estado.
  - Guardar la instantánea (`list_price`, `price`, `discount_amount`, `promotion_id`) en la línea del pedido (RF04.02, RN-04).
  - Tratar la desaparición de un descuento entre el carrito y el pedido como un cambio de precio que se muestra al cliente antes de pagar (decisión de UX de orders).
- **Propuestas transversales** (no se implementan sin aprobación; las recoge el Leader):
  1. `docs/modules.md` §3, nueva excepción (5): catalog puede leer en SQL la vista `app.product_effective_price`; promotions puede leer de `app.products` solo `id`, `price_cents` y `category_id`, y tener FK a `app.products` y a `app.categories` (mismo patrón que las excepciones 3 y 4 de inventory).
  2. Aprobación de frontend-lead de los campos nuevos `original_price` y `discount_amount` en el contrato público de catalog (CATALOG-R13 los anticipa, pero el nombre y la forma son de esta SPEC, H-7).
  3. T-053 toca `backend/src/valmont/modules/catalog/**` (consultas y esquemas): no cambia tablas ni columnas de catalog.
- **Riesgo (rendimiento):** la vista se evalúa por producto en cada listado de catalog y, con alcance `category` o `catalog`, cada promoción vigente se compara con cada producto. Con decenas de relojes y unas pocas promociones es despreciable; con miles de productos habría que medirla (`EXPLAIN`) y, si hace falta, materializar o indexar. Fuera del MVP.

## 9. Seguridad

- Toda la administración con `require_admin`; el `actor` sale del token, nunca del cuerpo.
- Importes y descuentos solo en el servidor (RN-09); el cliente solo envía ids, tipo, valor y fechas, y solo el admin.
- SQL parametrizado; el texto de `name` es texto plano (la interfaz no lo inyecta como HTML).
- Una promoción inactiva, programada o vencida no es visible para nadie salvo el admin; el visitante solo ve su efecto en el precio, sin el nombre, el tipo, el alcance ni las fechas.
- Un monto fijo o un porcentaje mal puesto nunca deja el precio por debajo de 1 céntimo (R6).
- Auditoría de R13 en la misma transacción que el cambio (RF14.01, AUDIT-R2).
- Sin datos personales.

## 10. Criterios de aceptación

- [ ] CA-PROMOTIONS-01 (UC-01, RF09.01): `POST` con datos válidos de cada combinación de tipo y alcance → 201, `is_active` verdadero, `status` correcto según las fechas y el alcance (con `products`, los productos con su precio de lista); son 422 con el `loc` del campo y sin crear nada: `percent_off` 0, 91 o decimal; `amount_off` 0, negativo, mayor que 2 147 483 647 o con moneda distinta; ambos valores a la vez o ninguno; un valor del otro tipo; `ends_at <= starts_at`; `ends_at <= now()`; con `products`, 0 o 101 productos, ids repetidos o inexistentes; `category_id` con otro alcance, ausente con `category` o inexistente; `product_ids` con `category` o `catalog`; nombre vacío o sobrelargo.
- [ ] CA-PROMOTIONS-02 (UC-02, RF09.01, R14): `PATCH` cambia nombre, valor, fechas, productos (la lista se reemplaza) o categoría; cambiar `kind` o `scope` sin el valor nuevo → 422, con él → 200 y lo anterior descartado (al salir de `products` la lista queda vacía); un `PATCH` vacío → 422; una promoción vencida se puede extender con una nueva `ends_at`; el precio vigente en catalog cambia en la siguiente consulta.
- [ ] CA-PROMOTIONS-03 (UC-03, RF09.01): `deactivate` deja de aplicar el descuento al instante y `status = inactive`; `activate` lo restablece si está en vigencia; repetir la operación → 200 sin entrada de auditoría nueva.
- [ ] CA-PROMOTIONS-04 (UC-04, RF09.01): el listado filtra por `status` y por `scope`, ordena por `starts_at` descendente, pagina como catalog y trae `product_count`, `kind` y los valores; el detalle trae los productos (vacío si no es `products`); `id` inexistente → 404; `status` o `scope` inválido → 422.
- [ ] CA-PROMOTIONS-05 (RF09.01, RF13.02): sin token → 401 y con token de cliente → 403 en las 6 rutas; el visitante no tiene ninguna ruta de promotions.
- [ ] CA-PROMOTIONS-06 (UC-05, UC-06, RF09.02, R3): el descuento se aplica solo con `is_active` y `starts_at <= now() < ends_at`: programada, vencida e inactiva no cambian el precio; los límites exactos (`starts_at = now()` aplica; `ends_at = now()` no) se comprueban con valores iguales a `now()` de la transacción.
- [ ] CA-PROMOTIONS-07 (R5, mismo tipo): con dos promociones `percent` vigentes sobre el mismo producto gana la de mayor porcentaje; con empate, la de menor `id`; nunca se suman; un producto en una sola promoción vigente entre varias asignadas se calcula bien.
- [ ] CA-PROMOTIONS-08 (R6, RN-15): tabla de casos del cálculo `percent`, incluidos 1 % de S/ 0,01 y de un precio de 2 147 483 647 céntimos, el redondeo de la mitad hacia arriba y `precio_vigente >= 1` con el 90 % sobre 1 céntimo; todo en enteros.
- [ ] CA-PROMOTIONS-09 (UC-05, RF09.02, CATALOG-R13): `GET /catalog/products`, `GET /catalog/products/{slug}` y los `related` devuelven `price` vigente, `original_price` y `discount_amount` (ambos `null` sin promoción aplicada, con `discount_amount = original_price − price` si la hay); `price_min`/`price_max` y `sort=price_asc|price_desc` usan el precio vigente; `total` y la paginación son coherentes; la administración de catalog sigue mostrando el precio base; el cuerpo público no incluye nombre, tipo, alcance ni fechas de la promoción.
- [ ] CA-PROMOTIONS-10 (UC-06, RF09.02, RN-09): `GetEffectivePrices` devuelve `list_price`, `price`, `discount_amount` y `promotion_id` por producto, ignora duplicados, devuelve `{}` sin ids y omite los ids inexistentes; el resultado es igual al de la vista que lee catalog.
- [ ] CA-PROMOTIONS-11 (R7): cambiar el precio base en catalog recalcula el precio vigente (de ambos tipos) sin tocar promotions.
- [ ] CA-PROMOTIONS-12 (R13, RF14.01): crear, editar, activar y desactivar dejan su entrada en `app.audit_log` en la misma transacción, con el actor del token y `before`/`after` de solo lo que cambia (incluidos `kind`, valor, `scope`, `category_id` y `product_ids`); una operación sin cambios no registra nada; un fallo (422) no deja entrada.
- [ ] CA-PROMOTIONS-13 (R12): dos `PATCH` concurrentes sobre la misma promoción (lista de productos o alcance) terminan con un estado coherente (el de la última transacción), sin filas mezcladas ni errores 500.
- [ ] CA-PROMOTIONS-14: la migración `0007` es reversible (`downgrade` + `upgrade`), `alembic check` queda limpio y las restricciones de §6 existen y se cumplen en la BD: CHECK de tipo y valores, de alcance y categoría, de fechas y de nombre; PK compuesta; FK a productos y categorías; la FK compuesta impide filas de `promotion_products` en una promoción que no es `products`.
- [ ] CA-PROMOTIONS-15: el OpenAPI de promotions y los cambios de catalog coinciden con la §7 (campos obligatorios y anulables, `ErrorOut` en los códigos declarados).
- [ ] CA-PROMOTIONS-16 (R1, R6, D-037, tipo fijo): `fixed_amount` resta `amount_off` al precio de lista; con `amount_off` ≥ precio, el precio vigente es 1 céntimo y `discount_amount = precio − 1`; no hay precio final menor que 1 en ningún caso; con precio de 1 céntimo la promoción no cuenta como aplicada (`discount_amount` 0, `promotion_id` `None`).
- [ ] CA-PROMOTIONS-17 (R4, D-037, alcance): una promoción `category` afecta solo a los productos de esa categoría, incluido uno creado después y uno que cambia a esa categoría (y deja de afectar al que sale de ella); una promoción `catalog` afecta a todos, incluido uno creado después; `products` solo a los de la lista; todo el comportamiento se comprueba en la vista y, por HTTP, en catalog.
- [ ] CA-PROMOTIONS-18 (R5, D-037, competencia entre tipos y alcances): con una `percent`, una `fixed_amount` y una de alcance `catalog` vigentes sobre el mismo producto, gana la de **menor precio final** (p. ej. 15 % sobre S/ 1 250 = S/ 187,50 frente a S/ 200 fijos: gana la fija); si cambia el precio base, cambia la ganadora (el monto fijo deja de ganar en un reloj barato); con empate de precio final, la de menor `id`; nunca se acumulan; la ganadora es la que devuelve `promotion_id`.

Trazabilidad: RF09.01 → UC-01 a UC-04 → R1, R2, R4, R8–R10, R12–R14 → `/promotions/admin` → CA-01 a CA-05, CA-12 a CA-14, CA-16 y CA-17. RF09.02 → UC-05, UC-06 → R3, R5, R6, R7, R11 → vista, puerto y precio público de catalog → CA-06 a CA-11, CA-15, CA-16 a CA-18.

## 11. Plan de pruebas

Las escribe `qa-reviewer` a partir de esta SPEC y las firmas de cada paquete (D-033).

- **Unitarias (sin BD):**
  - Validación de `Promotion` (R1 para los dos tipos, R2, R4 para los tres alcances, nombre) y `status_at` con una tabla de instantes (antes, en `starts_at`, dentro, en `ends_at`, después, inactiva).
  - Casos de uso con repositorios y auditoría falsos: `Create/Update/Activate/Deactivate` (incluido el cambio de `kind` y de `scope`, R14) y `GetEffectivePrices` (duplicados, vacío, ausentes).
  - Auditoría: solo lo que cambia; sin entrada si nada cambia.
- **Integración (BD `valmont_test`):**
  - Migración (restricciones, FK compuesta, `downgrade`/`upgrade`, `alembic check`).
  - La vista con tabla de casos de R3, R5 y R6: porcentaje y monto fijo, redondeo, bordes de precio (1 céntimo, `2147483647`), tres alcances, varias promociones de tipos y alcances mezclados, vigencia con `now()` de la transacción; un producto nuevo y uno que cambia de categoría.
  - Repositorio: reemplazo de `product_ids`, cambio de alcance, `lock`, productos y categorías inexistentes.
  - Concurrencia de dos `PATCH` con dos conexiones reales (CA-13).
  - Catalog: filtro y orden por precio vigente, `total`, `related`.
- **Contrato (HTTP con `TestClient`):** las 6 rutas, 401/403, 404 y 422 con su `loc`, formato común de error, OpenAPI contra la §7, y que el cuerpo público de catalog no filtra datos de la promoción.
- **Seguridad:** token de cliente en todas las rutas; un campo extra en el cuerpo → 422; `percent_off` o `amount` como texto → 422.
- **E2E (Playwright, cuando exista T-054):** el admin crea una promoción y el visitante ve el precio tachado en la ficha; la desactiva y desaparece.
- **Casos de borde:** precio base de 1 céntimo; precio de `2147483647`; monto fijo mayor que el precio; promoción en el segundo exacto de inicio y de fin; producto en borrador dentro de una promoción (no aparece en lo público, CATALOG-R1); promoción sobre un producto despublicado y republicado; categoría inactiva con promoción (H-6).

## 12. Decisiones tomadas

El usuario respondió el 2026-11-26 a las seis preguntas de la versión 1; el Leader las registra como **D-037** en `docs/decisions.md`. Ya no hay preguntas abiertas de negocio.

| ID | Decisión (D-037) | Dónde se refleja |
|---|---|---|
| P-PROMO-1 | **(c) Ambos tipos:** `percent` (entero 1–90) o `fixed_amount` (céntimos de PEN > 0). | R1, R6, §6, §7, CA-01, CA-08, CA-16 |
| P-PROMO-2 | **(d) Cualquiera de los tres alcances:** `products` (1–100), `category` y `catalog`. | R4, R14, §6, §7, CA-04, CA-17 |
| P-PROMO-3 | **(a) Gana una sola, sin acumular.** Con tipos y alcances mezclados se compara el **precio final**: gana el menor; empate, menor `id`. | R5, §6 (vista), CA-07, CA-18 |
| P-PROMO-4 | **(a) Redondeo** del porcentaje al céntimo más cercano, mitad hacia arriba; precio final mínimo de 1 céntimo. | R6, CA-08, CA-16 |
| P-PROMO-5 | **(a) en espíritu:** `price` vigente y `original_price` tachado; el ahorro viaja como importe (H-7) para valer con los dos tipos. | §7, CA-09 |
| P-PROMO-6 | **(a) Inicio y fin obligatorios.** | R2, R10, CA-01 |

**Hipótesis de esta SPEC por confirmar** (las confirma quien aprueba el contrato; ninguna cambia el modelo si se invierte salvo H-5 y H-7, que tocan R6 y §7):

| ID | Hipótesis |
|---|---|
| H-1 | Tope de 100 productos por promoción `products`. |
| H-2 | Tope de 90 % para `percent`. |
| H-3 | Una promoción `products` puede incluir productos en borrador. |
| H-4 | Al editar no se exige que `ends_at` sea futura. |
| H-5 | Un monto fijo mayor que el precio deja el precio final en 1 céntimo (no se rechaza). |
| H-6 | Una promoción `category` aplica aunque la categoría esté inactiva. |
| H-7 | El contrato público usa `original_price` + `discount_amount` (importes), sin `discount_percent` ni `discount_type`; se pueden añadir después. |
