# catalog — Estado
> Fase: 2 · Estado del módulo: IN_PROGRESS · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-025 | SPEC de catalog | claude-leader | D-019…D-023 | DONE (contrato aprobado por frontend-lead con cambios incorporados) |
| T-026 | Esquema `0004`, dominio y repositorios de catalog | backend-dev | T-021 | DONE (2 rondas; verificado por claude-leader: 319 unitarias + 71 integración) |
| T-027 | API pública: listado con filtros, búsqueda, orden y paginación; ficha con relacionados; categorías y atributos (incluye T-019) | backend-dev | T-026 | DONE (verificado por claude-leader: 355 unitarias + 94 integración) |
| T-028 | API de administración: productos, publicación, categorías y listas de valores, con auditoría | backend-dev + qa-reviewer | T-026, T-021 | BACKLOG |
| T-029 | Activar Supabase Storage (puerta Docker) e imágenes: subida, orden y retirada | claude-leader + backend-dev | T-028 | IN_PROGRESS (Storage activado y verificado por claude-leader el 2026-10-27; faltan los endpoints de imágenes) |
| T-030 | Conectar la disponibilidad con inventory (`AvailabilityReader`) | backend-dev | módulo inventory | BACKLOG |
| T-031 | Semillas de demostración para `dev` (aprobadas por el usuario, P-CATALOG-1) | backend-dev | T-026 | BACKLOG |

IDs reservados del módulo: T-025–T-039 (libres: T-032–T-039).

## Paquetes de tarea

### T-028 — API de administración de catalog (sin imágenes)
- Objetivo: el administrador gestiona productos (crear, leer, editar, publicar, despublicar), categorías y listas de valores por la API de §7 (administración), con las reglas de §4 y la auditoría de CATALOG-R7.
- Responsable: backend-dev (revisan claude-leader y qa-reviewer) · Módulo: catalog · Requisitos: RF06.01, RF06.02, RF06.07, RF13.02, RF14.01 · Decisiones: D-021…D-023
- Leer: `docs/modules/catalog/SPEC.md` §4, §5 y §7 (administración); `docs/modules/audit/SPEC.md` §4 y §8; `docs/modules.md` §3 (excepciones de auth y audit) y §4; el código de catalog (T-026, T-027), identity (`require_admin`) y audit (`AuditRecorderDep`).
- Puede modificar: `backend/src/valmont/modules/catalog/**` (incluidas las operaciones de repositorio de administración que falten: `get`, `update`, listado con borradores) y `backend/tests/catalog/**`. `main.py` solo si hace falta registrar un router nuevo.
- Protegido: `shared/**`, otros módulos, migraciones (si hiciera falta un cambio de esquema → escalar), `docs/**`.
- Resultado esperado:
  1. Router `/api/v1/catalog/admin` con todas las rutas de §7, **excepto imágenes** (T-029), todas con `require_admin`.
  2. Errores con los `code` de §7: `sku_taken`, `slug_taken`, `slug_locked`, `publish_requirements_unmet` (con `details.missing`), `category_in_use`, `code_taken`; 404 `not_found`; las referencias inexistentes (`category_id`, `movement_code`, `case_material_code`) → 422 con `loc` en el campo (nunca un 500 por la FK).
  3. **Bloqueo del slug (CATALOG-R3):** `published_at` guarda la fecha de la **primera** publicación y no se borra al despublicar; si existe, cambiar el `slug` → 409 `slug_locked`.
  4. Auditoría en la misma transacción (`AuditRecorderDep` + `SessionDep`): `catalog.product_created` (after: sku, price, order_policy), `catalog.price_changed` (before/after: price_cents), `catalog.product_published`, `catalog.product_unpublished`, `catalog.order_policy_changed` (before/after: order_policy, lead_time_days). `actor_id` y `actor_role` = el admin.
  5. Esquemas de entrada con campos extra prohibidos (incluido `status`); `price` como `Money`; en PATCH, `null` borra los atributos opcionales.
- Criterios de aceptación: CA-CATALOG-05, CA-CATALOG-06 y CA-CATALOG-08 de la SPEC; un `customer` → 403 y sin token → 401 en todas las rutas.
- Pruebas obligatorias: format, lint, `pytest -q`, `pytest -m integration -q` (incluida la auditoría real en la BD de pruebas), capas, `alembic check`, OpenAPI de las rutas de administración con `ErrorOut`.
- Seguridad: autorización en cada ruta; el actor sale del token; nada de datos de otros módulos.
- Estado inicial: BACKLOG (tras T-027) · IDs reservados: ninguno (tarea hoja)
- Escalar si: hace falta cambiar el esquema, tocar `shared/` o el contrato no cubre un caso.

### T-026 — Esquema, dominio y repositorios de catalog
- Objetivo: las tablas de catalog existen con todas sus restricciones e índices, el dominio aplica sus reglas y los repositorios leen y escriben productos, categorías, listas de valores e imágenes.
- Responsable: backend-dev (revisa claude-leader) · Módulo: catalog · Requisitos: RF02.07, RF06.01, RF06.02 (base de datos y dominio; las API son T-027 y T-028) · Decisiones: D-010, D-020, D-021, D-022
- Leer: `docs/modules/catalog/SPEC.md` §4–§6 y §9; `docs/modules.md` §3–§4; `.claude/skills/backend-module-implementation/SKILL.md`; `.claude/skills/database-migration-review/SKILL.md`; como referencia de estilo, `backend/src/valmont/modules/identity/` y `audit/`, con sus pruebas.
- Dependencias: T-021 (audit) integrada, porque su migración `0003` debe ser la anterior a `0004`.
- Puede modificar: `backend/src/valmont/modules/catalog/**` (nuevo: `domain.py`, `application.py` con los puertos `ProductRepository`, `CategoryRepository` y `AttributeRepository`, y `adapters/persistence.py`), `backend/migrations/env.py` (solo la línea de registro), `backend/migrations/versions/0004_*.py` (nuevo, `--rev-id 0004`), `backend/tests/catalog/**` (nuevo, con `__init__.py`).
- Protegido: todo lo demás. Sin dependencias nuevas. Sin endpoints en esta tarea.
- Resultado esperado: el esquema de la SPEC §6 exacto, con la columna `search` generada y su índice GIN; dominio puro con `Product`, `Category`, `AttributeValue` y `ProductImage`, la generación de slug (CATALOG-R3) y la validación de publicación (CATALOG-R2); los textos rechazan caracteres de control como en identity; repositorios SQL con la consulta del listado (filtros, orden, paginación y búsqueda con `websearch_to_tsquery('spanish', :q)` parametrizado) y la de relacionados (CATALOG-R6); la unicidad de SKU y slug resuelta por los UNIQUE de la BD (el repositorio traduce la violación a un error de dominio "conflicto").
- Criterios de aceptación: migración `0004` reversible y `alembic check` limpio; pruebas de integración que demuestran cada filtro, cada orden, la paginación con `total`, la búsqueda por nombre, SKU y descripción, los relacionados, la unicidad (409 de dominio) y que un borrador no aparece en las consultas públicas; `EXPLAIN` de la búsqueda con el índice GIN (al menos con `enable_seqscan = off` en la prueba).
- Pruebas obligatorias (desde `backend/`): `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, `uv run pytest -m integration -q`, la comprobación de capas y `uv run alembic upgrade head` + `uv run alembic check`.
- Seguridad: SQL siempre parametrizado; ningún dato de prueba con apariencia de dato real.
- Estado inicial: READY · IDs reservados: ninguno (tarea hoja)
- Escalar si: la SPEC no cubre un caso, hace falta una dependencia, o hay que tocar `shared/` u otro módulo.

## Traspasos

#### Traspaso T-027 (+ T-019) — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW.
2. Cambios: router público `/api/v1/catalog` con `GET /products`, `/products/{slug}`, `/categories` y `/attributes` según SPEC §7. `GET /products` valida `page` 1–1000, `page_size` 1–48 (24), `sort`, `relevance` sin `q`, `q` ≤ 100 (vacío = sin búsqueda), `min > max`, precios enteros ≥ 0 y caracteres de control (dominio) → 422. La ficha devuelve imágenes por posición, `specs` en orden y hasta 4 `related`; borrador, inexistente o slug mal formado → el mismo 404 `not_found`. URL de imagen = `<storage_public_url o supabase_url>/storage/v1/object/public/products/<storage_path>`; sin ninguna de las dos → 500 `internal_error`. T-019: `Money` con `json_schema_serialization_defaults_required` (`Money-Output` exige `currency`, `Money-Input` no); `validation_error.details` = solo `loc`, `type`, `msg`.
3. Archivos: `backend/src/valmont/modules/catalog/adapters/http.py` (nuevo), `backend/src/valmont/main.py` (una línea + import), `backend/src/valmont/shared/config.py` (`storage_public_url`), `backend/src/valmont/shared/money.py`, `backend/src/valmont/shared/errors.py` (T-019 y la entrada 404 de `ERROR_RESPONSES`), `backend/.env.example` (comentario + `# STORAGE_PUBLIC_URL=`), `backend/tests/catalog/{catalog_helpers,conftest,test_http,test_http_db}.py` (nuevos), `backend/tests/catalog/test_persistence.py` (datos movidos a `catalog_helpers`), `backend/tests/shared/test_errors.py`.
4. Decisiones: esquemas con sufijo `Out` (convención de la skill; el componente es `ProductSummaryOut`, no `ProductSummary`); el router llama a los puertos directamente, porque son lecturas sin reglas y `application.py` estaba protegido; la ruta de la ficha declara 422 solo para sustituir el `HTTPValidationError` que FastAPI añade a toda ruta con parámetros (en la práctica no ocurre); los parámetros desconocidos (p. ej. `available`) se ignoran, como hace FastAPI por defecto; `ERROR_RESPONSES` gana la entrada 404 (`shared/errors.py`, fuera de T-019). Sin cambios en `domain.py` ni `persistence.py`.
5. Pruebas (desde `backend/`): `uv run ruff format --check .` → 59 files already formatted · `uv run ruff check .` → All checks passed! · `uv run pytest -q` → 355 passed, 94 deselected · `uv run pytest -m integration -q` → 94 passed, 355 deselected · capas → vacío · `uv run alembic current` → 0004 (head) · `uv run alembic check` → No new upgrade operations detected. · `app.openapi()` → `GET /products` {200, 422}, `GET /products/{slug}` {200, 404, 422}, `GET /categories` {200}, `GET /attributes` {200}; `Money-Output.required = [amount, currency]`, `Money-Input.required = [amount]`; sin `HTTPValidationError` en todo el documento.
6. No ejecutadas: E2E y tipos (no configurados); prueba con Supabase Storage real (llega con T-029).
7. Dependencias: T-030 añade `availability` y el filtro `available`; T-029 y T-031 deben dejar al menos una imagen en cada publicado (`main_image` es obligatorio en el contrato: un publicado sin imagen hoy rompe el listado con 500).
8. Riesgos: los componentes del OpenAPI `Money` pasan a `Money-Input` y `Money-Output` (afecta a tipos generados del frontend, si los hay); `available=true` se ignora en silencio hasta T-030.
9. Decisión pendiente: ninguna.
10. Documentación: este STATUS y la fila T-019 de `docs/agents/tasks.md`.
11. Siguiente acción: claude-leader revisa T-027 y T-019; después, T-028.

#### Traspaso T-026 (ronda 2) — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW.
2. Cambios: `description` admite `\n` (`\r\n` y `\r` pasan a `\n`; el resto de `Cc` y los sustitutos se rechazan; ≤ 5000); longitudes de la SPEC §5 en el dominio (`sku` 40, `name` 120, slugs y códigos 60, categoría 60/500, `label` 60, `alt` 150); `slugify` corta a 60 sin guion final; etiquetas de `specs` únicas con `casefold`; clave de CATALOG-R2 `image` (antes `images`); desempate solo por `id` en todos los órdenes (CATALOG-R8; antes `published_at, id`); `0004`: `unaccent` en el esquema `extensions` (se crea, o se traslada con `ALTER EXTENSION … SET SCHEMA` si estaba en otro), envoltorio `extensions.unaccent('extensions.unaccent', $1)`, índices `ix_products_movement_code` e `ix_products_case_material_code`.
3. Archivos: `backend/src/valmont/modules/catalog/domain.py`, `backend/src/valmont/modules/catalog/adapters/persistence.py`, `backend/migrations/versions/0004_catalog.py`, `backend/tests/catalog/test_domain.py`, `backend/tests/catalog/test_persistence.py`.
4. Decisiones: `slugify` trunca a 60 los nombres largos (la SPEC no dice qué hacer si el nombre genera más); el `downgrade` no borra ni la extensión ni el esquema `extensions`.
5. Pruebas (desde `backend/`): `uv run ruff format --check .` → 54 files already formatted · `uv run ruff check .` → All checks passed! · `uv run pytest -q` → 319 passed, 71 deselected · `uv run pytest -m integration -q` → 71 passed, 319 deselected · capas → vacío · dev `alembic downgrade 0003` + `upgrade head` → Running downgrade 0004 -> 0003 / Running upgrade 0003 -> 0004 / 0004 (head) · `uv run alembic check` → No new upgrade operations detected. · dev y `valmont_test`: `unaccent` en `extensions`, 0 funciones `unaccent` en `public`, `app.f_unaccent('Automático Cronógrafo')` → `Automatico Cronografo` con `provolatile = i`, `'automatico'` encuentra `'Movimiento Automático'` → True; los 6 índices de la SPEC están presentes en ambas BD. En las dos se recorrió el traslado desde `public`.
6. No ejecutadas: HTTP, E2E y tipos (sin endpoints o sin configurar).
7. Dependencias: T-027 (tope de `page` 1–1000 en HTTP), T-028 y T-029 como en el traspaso anterior.
8. Riesgos: los que siguen abiertos en "Discrepancias y riesgos".
9. Decisión pendiente: ninguna nueva.
10. Documentación: este STATUS.
11. Siguiente acción: claude-leader revisa T-026.

#### Traspaso T-026 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW.
2. Cambios: migración `0004` (categorías, `movement_types`, `case_materials`, `products` con `search` generada + GIN, `product_images`) con `unaccent` y el envoltorio IMMUTABLE `app.f_unaccent`; dominio puro (`Product`, `Category`, `AttributeValue`, `ProductImage`, `SpecEntry`, `ProductQuery`, `OrderPolicy`, `slugify`, CATALOG-R2 ampliada por D-023); puertos `ProductRepository`, `CategoryRepository` y `AttributeRepository`; repositorios SQL (alta de productos, categorías, valores e imágenes; listado con filtros AND, rangos inclusivos, 4 órdenes, paginación con `total` y búsqueda; ficha por slug; imágenes; relacionados; listas activas). Incluye los cambios del Leader C-1 (`specs` lista de pares), C-9 (sin `url`), búsqueda sin tildes y D-023 (`order_policy`, `lead_time_days`).
3. Archivos: `backend/src/valmont/modules/catalog/{__init__,domain,application}.py`, `backend/src/valmont/modules/catalog/adapters/{__init__,persistence}.py`, `backend/migrations/versions/0004_catalog.py`, `backend/migrations/env.py` (una línea), `backend/tests/catalog/{__init__,test_domain,test_persistence}.py`.
4. Decisiones (supuestos a revisar): `clean_text` local (modules.md §3 prohíbe importar el `domain` de identity); `sort` sin indicar = `relevance` con `q`, si no `newest` (UC-02/CA-02); formato `^[a-z0-9]+(-[a-z0-9]+)*$` para slugs y códigos de valores; `description` NOT NULL, vacía permitida en borrador; publicado ⇒ `published_at` (solo dominio); ids `uuid4` del llamador; FK de movimiento y material `ON DELETE RESTRICT`; desempate `published_at desc, id`; etiquetas de `specs` únicas sin distinguir solo por espacios (sí por mayúsculas). Lectura/escritura de administración (`get`, `update`, listado admin) queda para T-028.
5. Pruebas (desde `backend/`): `uv run ruff format --check .` → 54 files already formatted · `uv run ruff check .` → All checks passed! · `uv run pytest -q` → 308 passed, 68 deselected (base 147) · `uv run pytest -m integration -q` → 68 passed, 308 deselected (base 22; incluye base↔head de `test_migrations.py` en `valmont_test`) · capas (grep) → vacío · `uv run alembic upgrade head` → 0004 (head) · `uv run alembic check` → No new upgrade operations detected. · dev `alembic downgrade 0003` → `upgrade head` → Running downgrade 0004 -> 0003 / Running upgrade 0003 -> 0004 / 0004 (head) · `unaccent` en `public` en dev y en `valmont_test`; `app.f_unaccent('Automático Cronógrafo')` → `Automatico Cronografo`, `provolatile = i` en ambas · `EXPLAIN` del total y de la página con `q` → Bitmap Index Scan on ix_products_search.
6. No ejecutadas: pruebas HTTP (no hay endpoints), E2E y tipos (no configurados); la puerta de secretos sobre `git diff --cached` se sustituyó por el mismo grep sobre los archivos nuevos (sin commits) → sin coincidencias.
7. Dependencias: T-027 usa `list_published`, `get_published`, `related`, `list_images` y `list_active`; T-028 añade `get`/`update`/listado admin y traduce `CatalogError` → 422, `CatalogConflict` y `NotPublishable` → 409, y valida antes la categoría y los códigos (una FK inexistente hoy es `IntegrityError` → 500); T-029 calcula la URL pública desde `storage_path`.
8. Riesgos: ver "Discrepancias y riesgos" (T-026).
9. Decisión pendiente: saltos de línea en `description`; longitudes máximas de textos; esquema de `unaccent`; tope de `page`.
10. Documentación: este STATUS. La SPEC §5–§6 aún no refleja C-1, C-9, `unaccent` ni D-023.
11. Siguiente acción: claude-leader revisa T-026 y actualiza SPEC §5–§6 con C-1, C-9, `unaccent` y D-023; después, T-027.

## Discrepancias y riesgos

- Mientras T-030 no esté hecha, la API pública no puede filtrar por disponibilidad (RF02.03) ni mostrarla (RF02.05).
- El precio con promoción (RF09.02) llega con el módulo promotions; hasta entonces se muestra el precio base.
- T-026 (resuelto en la ronda 2): saltos de línea en `description` (CATALOG-R12), longitudes de la SPEC §5, `unaccent` en `extensions`, índices de `movement_code` y `case_material_code`. El tope de `page` (1–1000) lo pone T-027 en HTTP.
- T-026: en una tabla diminuta el planificador puede no usar el GIN. La prueba simula un catálogo real (300 filas de relleno, `gin_clean_pending_list`, `ANALYZE` y `enable_seqscan = off`); en producción, autovacuum vacía la lista pendiente.
- T-026: un producto publicado con `published_at` nulo solo lo impide el dominio, no un CHECK de la BD.
