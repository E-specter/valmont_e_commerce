# promotions — Estado
> Fase: 3 · Estado del módulo: SPECIFICATION (SPEC PROPUESTA v2 con las decisiones del usuario D-037; pendiente de la aprobación del contrato por backend-lead y frontend-lead) · Última actualización: 2026-11-26 module-coordinator

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-050 | SPEC de promotions | module-coordinator | RF09, D-015, D-022, D-037, CATALOG-R13 | DONE (SPEC v2 aprobada por el Leader el 2026-11-26: contrato §7, excepción (5) y H-1…H-7 adoptadas, D-037) |
| T-051 | Migración `0007`, dominio, repositorios y puerto `GetEffectivePrices` | backend-dev + qa-reviewer | T-050 aprobada, T-021, T-026 | DONE (`492465f`; QA APROBADO en la ronda 2: 758 + 383; corregidos H-1, CHECK con NULL, y H-2, nombre en blanco) |
| T-052 | API de administración con auditoría y promoción de demostración en las semillas | backend-dev + qa-reviewer | T-051 | READY |
| T-053 | Precio vigente en la API pública de catalog | backend-dev + qa-reviewer | T-051; aprobación de la excepción (5) de `modules.md` §3 y de los campos nuevos por frontend-lead | BACKLOG |
| T-054 | Backoffice de promociones y precio promocional en la tienda | frontend-dev + qa-reviewer | T-052, T-053, T-111 (VIEWS.md y nodos de Figma) | BACKLOG (no READY: sin diseño; frontend-lead lo divide y pide IDs fuera del rango) |

IDs reservados del módulo: T-050–T-054 (sin libres). Orden: T-051 → (T-052 ∥ T-053) → T-054. T-052 y T-053 se pueden implementar en paralelo (rutas disjuntas) y se integran en ese orden, porque la revisión manual de T-053 usa la promoción de las semillas de T-052.

Rutas disjuntas (D-033): quien implementa escribe solo `backend/src/**` y las migraciones indicadas; qa-reviewer escribe solo `backend/tests/**` (y, en T-054, `frontend/tests/**` y `frontend/e2e/**`).

## Paquetes de tarea

### T-051 — Esquema, dominio, repositorios y puerto de precios vigentes
- Objetivo: las tablas y la vista de promotions existen con sus restricciones; el dominio valida y calcula el estado; `GetEffectivePrices` devuelve el precio vigente por producto leyendo la vista.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: promotions · Requisitos: RF09.01, RF09.02 · Reglas: PROMOTIONS-R1…R9 y R11 · Decisiones: D-015, D-022, D-033, D-037
- Leer: `docs/modules/promotions/SPEC.md` §4 (R1–R9, R11, R14), §5, §6 (incluido el bosquejo SQL), §8 y §12; skills `backend-module-implementation` y `database-migration-review`; como referencia, `backend/migrations/versions/0005_inventory.py` (vista `product_availability`), `backend/src/valmont/modules/inventory/` (estructura, `lock()`, repositorios) y `backend/src/valmont/shared/db.py`.
- Contratos aplicables: SPEC §6 (esquema exacto) y §8 (puerto).
- Dependencias: T-021 (audit) y T-026 (catalog) integradas; la SPEC con el contrato aprobado. Las decisiones de negocio ya están tomadas (D-037, SPEC §12); si se invierte H-5 (monto mayor que el precio) cambian R6 y este paquete.
- Puede modificar: `backend/src/valmont/modules/promotions/**` (nuevo, con `__init__.py`; `domain.py`, `application.py`, `adapters/__init__.py`, `adapters/persistence.py`), `backend/migrations/env.py` (solo la línea de registro), `backend/migrations/versions/0007_promotions.py` (nuevo, `--rev-id 0007`) y su traspaso en este STATUS.
- Protegido (no tocar): todo lo demás, en especial `backend/src/valmont/modules/catalog/**`, `backend/tests/**` y `backend/src/valmont/main.py`. Sin endpoints (T-052) ni cambios en catalog (T-053). Sin dependencias nuevas.
- Resultado esperado:
  1. Migración `0007` con `app.promotions` (tipo, valor, alcance, categoría y sus CHECK), `app.promotion_products` (con la FK compuesta `(promotion_id, scope)`) y la vista `app.product_effective_price` exactamente como la SPEC §6 (tres alcances, dos tipos y menor precio final), con `downgrade` que borra primero la vista.
  2. Dominio puro (sin `fastapi`, `pydantic`, `sqlalchemy`): `Promotion`, `PromotionKind`, `PromotionScope`, `PromotionStatus`, `status_at(now)`, errores de validación (`PromotionError(ValueError)`), constantes de R1, R2 y R4.
  3. `application.py`: `EffectivePrice`, `EffectivePriceReader` y `GetEffectivePrices` (SPEC §8) y el puerto `PromotionRepository` con las operaciones que necesite T-052 (`add`, `get`, `lock`, `update`, `list`).
  4. `adapters/persistence.py`: modelos SQLAlchemy, repositorio y `EffectivePriceReader` sobre la vista.
- Criterios de aceptación: CA-PROMOTIONS-06, 07, 08, 10, 11, 14, 16, 17 y 18 de la SPEC §10, ejercitados contra la BD.
- Firmas públicas (contra las que escribe QA; no se cambian sin avisar):
  - `valmont.modules.promotions.domain`:
    - `PERCENT_MIN = 1`, `PERCENT_MAX = 90`, `AMOUNT_MAX = 2_147_483_647`, `PRODUCTS_MAX = 100`, `NAME_MAX = 120`
    - `class PromotionKind(StrEnum)`: `PERCENT="percent"`, `FIXED_AMOUNT="fixed_amount"`
    - `class PromotionScope(StrEnum)`: `PRODUCTS="products"`, `CATEGORY="category"`, `CATALOG="catalog"`
    - `class PromotionError(ValueError)`
    - `class PromotionStatus(StrEnum)`: `INACTIVE="inactive"`, `SCHEDULED="scheduled"`, `ACTIVE="active"`, `EXPIRED="expired"`
    - `@dataclass(frozen=True) class Promotion`: `id: UUID`, `name: str`, `kind: PromotionKind`, `percent_off: int | None`, `amount_off: int | None` (céntimos), `scope: PromotionScope`, `category_id: UUID | None`, `product_ids: tuple[UUID, ...]`, `starts_at: datetime`, `ends_at: datetime`, `is_active: bool`; `__post_init__` aplica R1 (el valor del otro tipo debe ser `None`), R2 (con `datetime` consciente de zona) y R4 (con `products`: 1–100 ids distintos y `category_id` `None`; con `category`: `category_id` y sin ids; con `catalog`: ni ids ni categoría) y lanza `PromotionError`; `def status_at(self, now: datetime) -> PromotionStatus`
  - `valmont.modules.promotions.application`:
    - `@dataclass(frozen=True) class EffectivePrice`: `product_id: UUID`, `list_price: int`, `price: int`, `discount_amount: int` (0 sin promoción), `promotion_id: UUID | None`
    - `class EffectivePriceReader(Protocol)`: `def get_many(self, product_ids: Collection[UUID]) -> list[EffectivePrice]`
    - `class GetEffectivePrices`: `__init__(self, reader: EffectivePriceReader)`, `__call__(self, product_ids: Collection[UUID]) -> dict[UUID, EffectivePrice]`
    - `class PromotionRepository(Protocol)`: `add(promotion: Promotion) -> None`, `get(promotion_id: UUID) -> Promotion | None`, `lock(promotion_id: UUID) -> Promotion | None`, `update(promotion: Promotion) -> None` (reemplaza también `product_ids`; con otro alcance borra antes las filas de productos), `list(status: PromotionStatus | None, scope: PromotionScope | None, now: datetime, page: int, page_size: int) -> tuple[list[Promotion], int]`
  - `valmont.modules.promotions.adapters.persistence`: `SqlPromotionRepository(session)` (implementa `PromotionRepository`) y `SqlEffectivePriceReader(session)` (implementa `EffectivePriceReader`); `InvalidReference(Exception)` con `.field` igual a `"product_ids"` o `"category_id"`, que lanzan `add`/`update` cuando una FK a producto o categoría falla.
  - BD: tablas `app.promotions`, `app.promotion_products` y vista `app.product_effective_price` con las columnas de la SPEC §6 (nombres exactos).
- Pruebas obligatorias (las escribe qa-reviewer, una por criterio; ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic upgrade head` + `alembic check` y un `downgrade -1` + `upgrade head`): unitarias de dominio y de `GetEffectivePrices` con un lector falso; integración de la vista (tabla de R3/R5/R6 con `now()` de la transacción; porcentaje y monto fijo; `2147483647`; 1 céntimo al 90 %; monto mayor que el precio; los tres alcances con un producto nuevo y otro que cambia de categoría; competencia de tipos y alcances por precio final con empate por `id`), restricciones CHECK/PK/FK y la FK compuesta, reemplazo de `product_ids`, cambio de alcance y cambio de precio base (CA-11).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): en Supabase Studio local (`supabase-local`, solo lectura) aparecen las tablas `promotions` y `promotion_products` y la vista `product_effective_price` con una fila por producto, `effective_price_cents = list_price_cents` y `discount_amount_cents = 0` (aún no hay promociones); `uv run alembic current` indica `0007`.
- Seguridad: SQL parametrizado; las restricciones de la BD son la última defensa; ninguna escritura en tablas de catalog.
- Estado inicial: READY (SPEC aprobada el 2026-11-26).
- Entrega: cambio preparado sin commit (`git add <rutas>`) y mensaje propuesto en el punto 12 del traspaso, p. ej. `feat(promotions): esquema, dominio y precio vigente (T-051)`; qa-reviewer lo verifica y el Leader hace el commit (§11.2, D-033, D-036).
- IDs reservados: ninguno.
- Escalar si: la vista no puede expresar R3/R5/R6 de forma eficiente (p. ej. la comparación entre tipos), hace falta tocar tablas o columnas de catalog, o hay una dependencia nueva.

### T-052 — API de administración de promotions y semillas
- Objetivo: el admin crea, edita, activa, desactiva, lista y consulta promociones por la API de la SPEC §7, con auditoría, y las semillas `dev` dejan una promoción de demostración.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: promotions · Requisitos: RF09.01, RF13.02, RF14.01 · Reglas: PROMOTIONS-R1, R2, R4, R8–R10, R12–R14 · Decisiones: D-037
- Leer: SPEC §3 (UC-01 a UC-04), §4 (en especial R14), §7 y §9; patrones de `backend/src/valmont/modules/catalog/adapters/admin_http.py` (router con `require_admin`, `current_actor`, `_domain_errors`, `ERROR_RESPONSES`) y `backend/src/valmont/modules/inventory/adapters/` (`AuditRecorderDep`); `docs/modules.md` §3 (excepciones 1 y 2).
- Contratos aplicables: SPEC §7 (PROPUESTO; el desarrollo empieza con la aprobación de backend-lead y frontend-lead).
- Dependencias: T-051.
- Puede modificar: `backend/src/valmont/modules/promotions/application.py` (casos de uso), `backend/src/valmont/modules/promotions/adapters/admin_http.py` (nuevo), `backend/src/valmont/main.py` (solo registrar el router), `backend/src/valmont/scripts/seed_dev.py` (solo añadir la promoción de demostración) y su traspaso en este STATUS.
- Protegido: `backend/migrations/**` (la migración es de T-051: si falta algo, se escala), el resto de catalog, `shared/` y `backend/tests/**`.
- Resultado esperado: router `/api/v1/promotions/admin` con las 6 rutas de la §7; casos de uso `CreatePromotion`, `UpdatePromotion`, `ActivatePromotion`, `DeactivatePromotion`, `GetPromotion` y `ListPromotions` con `AuditRecorder`; `UpdatePromotion` bloquea la fila con `lock()` (R12); `status` calculado por el servidor (R9); detalle con los productos y su precio vigente de hoy (SPEC §7, `PromotionProductOut`); `PATCH` con la semántica de R14 (resultado coherente; al cambiar `kind` o `scope` se descarta lo anterior); errores de dominio y de FK (producto o categoría) traducidos a 422 con el `loc` del campo; auditoría de R13 solo cuando algo cambia y en la misma transacción, con el actor del token; semillas `dev`: dos promociones de demostración con nombre fijo, vigentes desde hoy durante varias semanas — 15 % (`percent`) sobre dos productos (`products`) y S/ 200 (`fixed_amount`) sobre una categoría de la semilla (`category`), de modo que se vean los dos tipos y la competencia por precio final —, creadas con `CreatePromotion` y un `Actor` nulo (sistema, AUDIT-R5) y que no se repiten si ya existe una con ese nombre (idempotente, como las demás semillas).
- Criterios de aceptación: CA-PROMOTIONS-01 a 05, 12, 13 y 15 de la SPEC §10, con los tipos y alcances de D-037 (CA-01, CA-02 y CA-04).
- Firmas públicas:
  - HTTP: las 6 rutas y los esquemas JSON de la SPEC §7, y los códigos 401, 403, 404, 422 y 503.
  - `valmont.modules.promotions.application`:
    - `@dataclass(frozen=True) class Actor`: `user_id: UUID | None`, `role: str | None`
    - `CreatePromotion(promotions: PromotionRepository, audit: AuditRecorder)`: `__call__(fields: Mapping[str, object], actor: Actor) -> Promotion`
    - `UpdatePromotion(promotions: PromotionRepository, audit: AuditRecorder)`: `__call__(promotion_id: UUID, changes: Mapping[str, object], actor: Actor) -> Promotion`
    - `ActivatePromotion` y `DeactivatePromotion` (mismos parámetros): `__call__(promotion_id: UUID, actor: Actor) -> Promotion`
    - `GetPromotion(promotions)`: `__call__(promotion_id: UUID) -> Promotion`
    - `ListPromotions(promotions)`: `__call__(status: PromotionStatus | None, scope: PromotionScope | None, page: int, page_size: int) -> tuple[list[Promotion], int]`
    - `class PromotionNotFound(Exception)` (404)
    - Los casos de uso reciben un reloj opcional `clock: Callable[[], datetime]` (por defecto `datetime.now(UTC)`) para R9 y R10.
  - Acciones de auditoría: `promotions.promotion_created`, `promotions.promotion_updated`, `promotions.promotion_activated`, `promotions.promotion_deactivated`; `entity_type = "promotion"`; `entity_id` = id de la promoción.
- Pruebas obligatorias (las escribe qa-reviewer; ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y OpenAPI): una por criterio; HTTP real contra `valmont_test` con un token de admin y uno de cliente, 401/403 en las 6 rutas, `loc` de cada 422, auditoría leída de `app.audit_log`, el cambio de `kind` y de `scope` por `PATCH` (R14), la carrera de dos `PATCH` con dos conexiones y la idempotencia de la semilla (dos ejecuciones dejan una sola de cada promoción).
- Diseño (frontend): no aplica.
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:8000/docs`, con un token de administrador de desarrollo (el Leader lo prepara si `docs/setup.md` no lo describe): crear una promoción (201), editarla, desactivarla y reactivarla, listarla por `status` y por `scope`; crear una de cada tipo y alcance (`percent` y `fixed_amount`; `products`, `category` y `catalog`); tras `seed_dev`, las dos promociones de demostración aparecen una sola vez; sin token, 401; con token de cliente, 403; datos inválidos (porcentaje 95, monto 0, `category` sin `category_id`, fin anterior al inicio) → 422 con el campo marcado.
- Seguridad: `require_admin` en todas las rutas; el actor sale del token; el cuerpo no puede traer precios finales, solo el porcentaje o el monto de descuento que fija el admin.
- Estado inicial: BACKLOG → READY al terminar T-051 y aprobarse el contrato.
- Entrega: como T-051; mensaje propuesto `feat(promotions): API de administración con auditoría (T-052)`.
- IDs reservados: ninguno.
- Escalar si: el contrato no cubre un caso, hace falta cambiar el esquema de T-051 o el router de otro módulo.

### T-053 — Precio vigente en catalog
- Objetivo: la API pública de catalog devuelve el precio vigente con el mejor descuento (de cualquier tipo y alcance), el precio anterior y el ahorro, y filtra y ordena por ese precio, leyendo la vista de promotions en la misma consulta.
- Responsable: backend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: catalog (consume promotions) · Requisitos: RF09.02 · Reglas: CATALOG-R13, PROMOTIONS-R3, R5, R6, R7 · Decisiones: D-037
- Leer: SPEC §3 (UC-05), §7 («Efecto en las respuestas públicas»), §8 (propuestas 1–3) y CA-PROMOTIONS-09 y 11; `docs/modules/catalog/SPEC.md` §4 (CATALOG-R8, R13) y §7; `backend/src/valmont/modules/catalog/adapters/persistence.py` (`_AVAILABILITY`, `_base_query`, `_filters`, `_order`) como patrón; la vista en `0007` (T-051).
- Contratos aplicables: SPEC §7 (campos `price`, `original_price`, `discount_amount`, H-7).
- Dependencias: T-051 integrada (para integrar y revisar a mano, también T-052); **aprobación del Leader** de la excepción (5) de `docs/modules.md` §3 y **de frontend-lead** de los campos nuevos (sin ella no se empieza).
- Puede modificar: `backend/src/valmont/modules/catalog/domain.py`, `backend/src/valmont/modules/catalog/adapters/persistence.py` y `adapters/http.py` y su traspaso en este STATUS.
- Protegido: `backend/migrations/**` (catalog no cambia tablas ni columnas), el resto de promotions, `seed_dev.py`, la administración de catalog (`admin_http.py` y sus esquemas), `shared/` y `backend/tests/**`.
- Resultado esperado:
  1. La consulta de productos publicados une `app.product_effective_price` (una fila por producto) en el mismo SQL, nunca producto a producto, y la declara como tabla ligera sin las columnas que no usa (patrón de `_AVAILABILITY`); catalog **no importa** nada de promotions.
  2. `ProductSummary` lleva `pricing`; `ProductSummaryOut.price` es `pricing.price`; nuevos `original_price: Money | None` y `discount_amount: Money | None`, siempre presentes en el JSON (ambos `null` si `pricing.discount_amount` es 0).
  3. `price_min`, `price_max` y los órdenes `price_asc` y `price_desc` usan el precio vigente (empates por `id`, CATALOG-R8).
  4. La ficha, el listado y los `related` comparten el mismo cálculo. `AdminProduct` queda como hoy.
- Criterios de aceptación: CA-PROMOTIONS-09, 10 (igualdad con la vista), 11, 17 y 18 de la SPEC §10 (por HTTP: alcance y competencia); el comportamiento sin promociones no cambia salvo los dos campos `null`.
- Firmas públicas:
  - HTTP: `GET /api/v1/catalog/products` (filtros `price_min`/`price_max`, `sort`), `GET /api/v1/catalog/products/{slug}` (incluidos `related`) con `price`, `original_price` y `discount_amount` de la SPEC §7; OpenAPI con los dos campos nuevos obligatorios y anulables.
  - `valmont.modules.catalog.domain`: `@dataclass(frozen=True) class Pricing`: `list_price: int`, `price: int`, `discount_amount: int` (0 sin promoción); `ProductSummary.pricing: Pricing`.
  - `ProductRepository` (`list_published`, `get_published`, `related`) conserva sus firmas.
- Pruebas obligatorias (las escribe qa-reviewer; ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y OpenAPI): precio vigente en listado, ficha y relacionados; filtro y orden por precio vigente con productos con y sin promoción; `total` y paginación; promoción programada, vencida e inactiva sin efecto; una prueba de que el listado no emite una consulta por producto; regresión de catalog sin promociones; el cuerpo público no filtra el nombre, el tipo, el alcance ni las fechas de la promoción; productos cubiertos por `category` y por `catalog`; competencia entre un porcentaje y un monto fijo reflejada en `price`.
- Diseño (frontend): no aplica (la pantalla es T-054).
- Revisión manual (el usuario, en `main` tras integrar): `http://localhost:8000/docs` → `GET /api/v1/catalog/products` muestra los productos de las dos promociones de demostración (T-052) con `price` descontado, `original_price` y `discount_amount` (en cada producto gana la promoción que deja el menor precio final); el filtro `price_max` y el orden `price_asc` cuentan con el precio vigente; un producto sin promoción trae los dos campos en `null`.
- Seguridad: el precio sale del servidor (RN-09, RN-14); no se expone el `promotion_id`, ni el nombre, el tipo, el alcance o las fechas de la promoción.
- Estado inicial: BACKLOG → READY al integrar T-051 y recibir las aprobaciones.
- Entrega: como T-051; mensaje propuesto `feat(catalog): precio vigente con promociones en la API pública (T-053)`.
- IDs reservados: ninguno.
- Escalar si: hace falta tocar tablas de catalog o `shared/`, la consulta no se puede resolver en el mismo SQL, o el frontend-lead objeta la forma de los campos.

### T-054 — Backoffice de promociones y precio promocional en la tienda
- Objetivo: el admin gestiona promociones desde el backoffice y el visitante ve el precio vigente con el precio anterior tachado en el catálogo y la ficha.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta el Leader) · Módulo: promotions (frontend) · Requisitos: RF09.01, RF09.02
- Leer: SPEC §7; `docs/design_ui/DESIGN.md` (componente «precio (con promoción)»); `docs/design_ui/VIEWS.md` y los nodos de Figma que asigne frontend-lead (**aún no existen**: T-110/T-111); skill `frontend-module-implementation`; `frontend/src/lib/api/` (clientes existentes de catalog).
- Contratos aplicables: SPEC §7 aprobada y los OpenAPI de T-052 y T-053.
- Dependencias: T-052, T-053 y T-111.
- Puede modificar: lo que fije frontend-lead al dividir la tarea (previsto: `frontend/src/lib/api/promotions.ts`, `frontend/src/components/backoffice/promotions/**`, `frontend/src/components/storefront/` solo el componente de precio, y las páginas del backoffice y de la tienda que lo usan).
- Protegido: `backend/**`, `docs/design_ui/**` (salvo lo que frontend-lead asigne) y todo lo no previsto.
- Resultado esperado (previsto, a cerrar con los nodos): listado de promociones con `status`, tipo, alcance y filtros; formulario de alta y edición (nombre, tipo con su valor —porcentaje o monto en soles—, alcance con selector de productos o de categoría, fechas en `America/Lima`); activar y desactivar con confirmación; el precio de la tienda con `price`, `original_price` tachado y el ahorro `discount_amount` cuando no son `null`; estados de carga, vacío y error en todo. El frontend muestra importes en `es-PE` y **nunca calcula** descuentos ni estados.
- Criterios de aceptación: CA-PROMOTIONS-01 a 04, 09, 16 y 17 (lo visible) y el E2E del plan de pruebas (§11), a concretar con VIEWS.md.
- Firmas públicas (PROPUESTAS por este coordinador; las cierra frontend-lead con VIEWS.md):
  - Cliente `frontend/src/lib/api/promotions.ts`: `listPromotions(params: {status?, scope?, page?, page_size?})`, `getPromotion(id)`, `createPromotion(body)`, `updatePromotion(id, body)`, `activatePromotion(id)`, `deactivatePromotion(id)`; tipos de la SPEC §7 (`PromotionSummary`, `PromotionDetail`, `PromotionInput`, con `kind` y `scope` como uniones literales).
  - Componente de precio: props `price: Money`, `originalPrice: Money | null`, `discountAmount: Money | null`.
- Pruebas obligatorias: las escribe qa-reviewer (componentes y flujo E2E con Playwright: crear → ver el precio tachado en la ficha → desactivar → desaparece) cuando el paquete esté READY.
- Diseño (frontend): nodos de Figma por definir (T-111); reutilizar el componente de precio y la tabla del backoffice que fije `VIEWS.md`.
- Revisión manual (el usuario, en `main` tras integrar): en `http://localhost:4321`, crear una promoción de cada tipo y alcance en el backoffice y ver el precio tachado en el catálogo y la ficha; desactivarla y comprobar que vuelve el precio normal.
- Seguridad: ocultar controles no es autorización (RF13.02); el backend decide; texto de `name` sin HTML.
- Estado inicial: **BACKLOG** (no READY: faltan VIEWS.md y los nodos; las firmas de la interfaz son provisionales).
- Entrega: como T-051; mensaje propuesto `feat(frontend): backoffice de promociones y precio promocional (T-054)`.
- IDs reservados: ninguno; frontend-lead pide un rango nuevo al dividirla (el de promotions está agotado).
- Escalar si: Figma no tiene la pantalla, el contrato no cubre un dato que el diseño exige, o hace falta un componente fuera de `VIEWS.md`.

## Traspasos

#### Traspaso T-052 — 2026-11-26 — backend-dev
1. Estado: IN_REVIEW. API `/api/v1/promotions/admin` (6 rutas), casos de uso con auditoría R13 y promociones de demostración en `seed_dev`.
2. Archivos: `promotions/application.py`, `promotions/adapters/admin_http.py` (nuevo), `main.py` (2 líneas), `scripts/seed_dev.py`.
3. Estático: `uv run ruff format .` → 44 files left unchanged; `uv run ruff check .` → All checks passed; capas → vacío. NO EJECUTADO: pruebas (D-028, D-033).
4. Claves del `Mapping` de `Create/UpdatePromotion`: nombres del dominio (`name, kind, percent_off, amount_off` en céntimos, `scope, category_id, product_ids, starts_at, ends_at`).
5. Auditoría: `after` completo al crear; en update solo lo que cambia (R13, claves `amount_off_cents`); activar/desactivar `{"is_active": ...}`; repetidos sin entrada.
6. DISCREPANCIA para el Leader: el detalle necesita `sku`, `name` de `app.products` y `id, slug, name` de `app.categories`, fuera de la excepción 5 de `modules.md` §3 (solo `id, category_id, price_cents`); `admin_http.py` los lee con tablas ligeras de solo lectura. Hace falta ampliar la excepción o aprobar otra vía.
7. Un `PATCH` vacío da 422 con `loc ["body"]`; `status` se calcula con la hora del servidor al responder.

#### Traspaso T-050 (v2) — 2026-11-26 — module-coordinator
(El texto completo está en la respuesta final de la tarea; aquí queda el resumen.)
1. Estado final: IN_REVIEW. SPEC v2 y STATUS actualizados con las decisiones del usuario (D-037); no hay código ni pruebas.
2. Pendiente: backend-lead y frontend-lead aprueban el contrato (§7, en especial H-7); el Leader registra D-037 y decide la excepción (5) de `modules.md` §3; el usuario o el líder confirman las hipótesis H-1…H-7 de la SPEC §12.
3. Pruebas: NO EJECUTADO (tarea solo de documentación).
4. Siguiente acción: aprobar el contrato y pasar T-051 a READY.

## Discrepancias y riesgos

- **CATALOG-R13 ya aprobó lo esencial de RF09.02** (el `price` público es el vigente y el tachado llega como campo opcional): la SPEC lo respeta y solo concreta los nombres (`original_price`, `discount_amount`, H-7). No hay contradicción con decisiones aprobadas ni con D-037.
- **Cambio en catalog sin cambiar sus tablas (T-053):** toca consultas y esquemas públicos de `catalog`. Requiere aprobación del contrato por frontend-lead y la excepción (5) de `modules.md` §3 (lectura en SQL de la vista de promotions y lectura de `app.products.id`, `price_cents` y `category_id` por promotions, con FK a productos y categorías). Es la misma figura que las excepciones (3) y (4) de inventory.
- **Dependencia de diseño:** T-054 depende de T-111 (VIEWS.md y Figma), aún sin hacer. El backend puede cerrarse y revisarse por `/docs` sin esperar.
- **Rango agotado:** el rango T-050–T-054 no deja IDs libres; si frontend-lead divide T-054 o se necesita una tarea `fix`, hay que reservar IDs nuevos.
- **Procedimiento de token de admin:** `docs/setup.md` no describe cómo obtener un token de administrador de desarrollo para la revisión manual de T-052; el Leader debe prepararlo.
- **Reloj:** el precio usa la hora de la BD (`now()`); el `status` del admin usa el reloj de la aplicación. Una diferencia de segundos afecta solo a la etiqueta del admin, nunca al precio cobrado.
- **Rendimiento de la vista:** sin medir con miles de productos (SPEC §8); con alcance `category` o `catalog` cada promoción vigente se compara con cada producto; sin importancia en el MVP.
- **Hipótesis de la SPEC §12 por confirmar:** H-5 (un monto fijo mayor que el precio deja 1 céntimo en lugar de rechazarse) y H-7 (el contrato público expone importes `original_price` y `discount_amount`, sin porcentaje) son las que tocan R6 y el contrato; el resto no altera el modelo.
- **Semilla de demostración:** T-052 asume que existe al menos una categoría y dos productos en las semillas `dev`; el desarrollador elige por `slug`/SKU existentes y lo anota en su traspaso.
- **Carrito y precio cambiante:** cart y orders deben decidir cómo avisar al cliente si un descuento desaparece entre el carrito y el pago (SPEC §8, obligaciones).
