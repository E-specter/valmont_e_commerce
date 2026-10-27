# catalog — Estado
> Fase: 2 · Estado del módulo: IN_PROGRESS · Última actualización: 2026-10-27 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-025 | SPEC de catalog | claude-leader | D-019…D-023 | DONE (contrato aprobado por frontend-lead con cambios incorporados) |
| T-026 | Esquema `0004`, dominio y repositorios de catalog | backend-dev | T-021 | DONE (2 rondas; verificado por claude-leader: 319 unitarias + 71 integración) |
| T-027 | API pública: listado con filtros, búsqueda, orden y paginación; ficha con relacionados; categorías y atributos (incluye T-019) | backend-dev | T-026 | DONE (verificado por claude-leader: 355 unitarias + 94 integración) |
| T-028 | API de administración: productos, publicación, categorías y listas de valores, con auditoría | backend-dev + qa-reviewer | T-026, T-021 | DONE (`6d66054`; qa-reviewer APROBADO en la re-verificación) |
| T-029 | Activar Supabase Storage (puerta Docker) e imágenes: subida, orden y retirada | claude-leader + backend-dev | T-028 | DONE (`b86a17a`; verificado por claude-leader: 545 unitarias + 140 integración, Storage real) |
| T-030 | Conectar la disponibilidad con inventory (`AvailabilityReader`) | backend-dev | módulo inventory | BACKLOG |
| T-031 | Semillas de demostración para `dev` (aprobadas por el usuario, P-CATALOG-1) | backend-dev | T-029 | IN_REVIEW (entregada por backend-dev el 2026-10-27; ejecutada dos veces en `dev`) |

IDs reservados del módulo: T-025–T-039 (libres: T-032–T-039).

## Paquetes de tarea

### T-029 — Imágenes de producto (Supabase Storage)
- Objetivo: el administrador sube, corrige el `alt`, ordena y retira imágenes de un producto, que se guardan en el bucket `products` y se sirven por su URL pública (D-019).
- Responsable: backend-dev (revisa claude-leader) · Módulo: catalog · Requisitos: RF06.03 · Decisiones: D-019
- Leer: `docs/modules/catalog/SPEC.md` §4 (CATALOG-R11), §5, §6 (URL de imagen), §7 (rutas de imágenes) y §9 (subida); tu código de T-026…T-028.
- Estado del entorno (verificado por el Leader): Storage activo, bucket público `products` (5 MiB; JPEG, PNG, WebP), `backend/.env` con `SUPABASE_SERVICE_ROLE_KEY` y `STORAGE_PUBLIC_URL` (no los imprimas).
- Puede modificar: `backend/src/valmont/modules/catalog/**`, `backend/src/valmont/shared/config.py` (solo `supabase_service_role_key: SecretStr | None = None`), `backend/pyproject.toml` + `uv.lock` (solo para declarar como directas `httpx` y `python-multipart`, que hoy llegan de forma transitiva), `backend/tests/**`.
- Resultado esperado:
  1. Puerto `ImageStorage` (`put(path, data, content_type)`, `delete(path)`) y adaptador `SupabaseImageStorage` (httpx con la clave de servicio; timeouts; errores de Storage → 503 `storage_unavailable` sin detalles).
  2. `POST /admin/products/{id}/images` (multipart `file` + `alt` 1–150): tipo por **firma del archivo** (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF….WEBP`; otro → 415 `unsupported_media_type`), tamaño ≤ 5 MiB leyendo como mucho límite + 1 bytes (→ 413 `file_too_large`); ruta `{product_id}/{uuid4}.{ext}` generada por el servidor; posición = siguiente libre. Orden: subir el archivo y después insertar la fila; si la inserción falla, borrar el archivo.
  3. `PATCH …/images/{image_id}` (`{alt}`), `PUT …/images/order` (exactamente todos los ids del producto, si no → 422) y `DELETE …/images/{image_id}` (toma el producto con `lock()`; si está publicado y es la última imagen → 409 `last_image`). El borrado del archivo en Storage va en una `BackgroundTask` (después de confirmar la transacción); si falla, se registra un aviso sin datos sensibles.
  4. Respuestas `ProductImage` `{id, url, alt}` con la URL de §6; errores declarados en el OpenAPI.
- Criterios de aceptación: CA-CATALOG-07 y CATALOG-R11; una prueba de integración contra el Storage real (sube un PNG mínimo, lo lee por la URL pública y lo borra; marcador `integration`); fakes para el resto.
- Pruebas obligatorias: format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check`, OpenAPI.
- Seguridad: la clave de servicio nunca sale del backend ni de los logs; nombres de archivo del cliente ignorados; sin seguir redirecciones; límites de tamaño antes de leer todo el cuerpo.
- Estado inicial: BACKLOG (tras la revisión de T-028) · IDs reservados: ninguno (tarea hoja)

### T-031 — Semillas de demostración para desarrollo
- Objetivo: con un comando, la BD local tiene un catálogo ficticio coherente para que Kombai y el frontend trabajen con la API real (P-CATALOG-1, aprobado por el usuario).
- Responsable: backend-dev · Módulo: catalog
- Puede modificar: `backend/src/valmont/scripts/__init__.py` y `backend/src/valmont/scripts/seed_dev.py` (nuevos; se ejecuta con `uv run python -m valmont.scripts.seed_dev`), `backend/tests/**`.
- Resultado esperado: se niega a correr si `ENVIRONMENT=prod`; idempotente (por `sku`, `slug` y `code`); usa los casos de uso de catalog (no SQL directo) para crear 4 categorías, los movimientos (`automatic`, `manual`) y los materiales (`steel`, `gold-18k`, `titanium`, `ceramic`), y unas 12 referencias con SKU `DEMO-…`, nombres ficticios, descripciones de varias líneas, `specs` ordenadas, precios en céntimos de PEN y una mezcla de políticas de venta (`stock`, `made_to_order` y `backorder`, con `lead_time_days`); cada producto con al menos una imagen de marcador (PNG generado en el propio script, con `alt` "Imagen de marcador (demo)") subida a Storage, y publicado. Nada se presenta como producto o activo oficial de Valmont.
- Criterios de aceptación: dos ejecuciones seguidas dejan el mismo número de filas; `GET /api/v1/catalog/products` devuelve los 12 con imagen; con `ENVIRONMENT=prod` termina con error sin escribir nada.
- Estado inicial: BACKLOG (tras T-029)

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

#### Traspaso T-031 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (revisa claude-leader).
2. Cambios:
   - `uv run python -m valmont.scripts.seed_dev` crea, mediante los casos de uso de catalog:
     - 4 categorías: `demo-vestir`, `demo-deportivos`, `demo-buceo` y `demo-aviador`, con nombres "… (demo)".
     - Movimientos: `automatic` y `manual`. Materiales: `steel`, `gold-18k`, `titanium` y `ceramic`.
     - 12 relojes, `DEMO-001`…`DEMO-012`, llamados "Demo Alba 38"…"Demo Lira 37", repartidos 3 por categoría.
   - Contenido de cada reloj:
     - Descripción de tres líneas que dice que es ficticio y que no es un producto de Valmont.
     - `specs` ordenadas (Calibre, Cristal, Garantía) y precios en céntimos de PEN.
     - Política de venta: 7 `stock`, 2 `made_to_order` (60 y 90 días) y 3 `backorder` (14, 21 y 30 días).
     - Dos productos sin algunos atributos, para probar los `null` de CATALOG-R5: Eco no tiene movimiento y Lira no tiene ninguno.
   - Cada producto recibe una imagen PNG de 400×400 de un color liso (distinto por producto), generada en el script, con `alt` "Imagen de marcador (demo)". Se sube con `AddProductImage` y `get_image_storage()` y después se publica con `PublishProduct` (CATALOG-R2).
   - Idempotencia: el script busca por `slug` (categorías), `code` (valores) y `sku` (productos), estos últimos leyendo `list_all` página a página. Solo crea lo que falta. Además, sube la imagen a un producto que no la tenga y publica un borrador.
   - Confirma una vez tras las categorías y los valores, y otra después de cada producto.
   - Con `ENVIRONMENT=prod` termina con código 1 antes de abrir la BD o Storage.
3. Archivos modificados:
   - `backend/src/valmont/scripts/__init__.py` y `backend/src/valmont/scripts/seed_dev.py` (nuevos).
   - `backend/tests/catalog/test_seed_dev.py` (nuevo).
4. Decisiones tomadas (supuestos a revisar):
   - Las categorías llevan el prefijo `demo-` para no chocar con las reales.
   - Si algo ya existe, no se actualiza: solo se crea lo que falta.
   - Las entradas de auditoría del sistema llevan `actor_id` y `actor_role` nulos (AUDIT-R5).
   - Los valores de atributo se crean con `AttributeRepository.add`, como hace el router: no hay caso de uso de alta.
   - Cada producto se confirma por separado: si algo falla, lo ya hecho se queda y una nueva ejecución sigue sin volver a subir imágenes.
5. Pruebas ejecutadas → resultado observado (desde `backend/`):
   - `uv run ruff format --check .` → 74 files already formatted
   - `uv run ruff check .` → All checks passed!
   - `uv run pytest -q` → 548 passed, 141 deselected (línea base: 545 passed, 140 deselected)
   - `uv run pytest -m integration -q` → 141 passed, 548 deselected. Incluye la idempotencia en `valmont_test` con Storage en memoria. Las dos ejecuciones dejan las mismas cifras: 12 productos, 12 publicados, 12 imágenes, 4 categorías, 2 + 4 valores, 24 entradas de auditoría con `actor_id` nulo y 12 archivos. La API devuelve los 12 con `main_image`, y la ficha, imágenes y relacionados.
   - Capas → vacío · `uv run alembic check` → No new upgrade operations detected.
   - En `dev` (BD vacía al empezar, Storage real):
     - 1.ª ejecución → "nuevos: 4 categorías, 6 valores, 12 productos, 12 imágenes, 12 publicados".
     - 2.ª ejecución → "nuevos: 0 …" en todo.
     - Recuento tras cada ejecución (idéntico): categories 4, movement_types 2, case_materials 4, products 12 (12 publicados), product_images 12, audit_log 24 (24 con `actor_id` nulo) y `storage.objects` del bucket `products` 12.
   - `TestClient` sobre la app en `dev`:
     - `GET /api/v1/catalog/products?page_size=48` → 200, total 12, los 12 con `main_image`.
     - Las 12 fichas → 200. `demo-lira-37` tiene 1 imagen, 2 relacionados y `specs` [Calibre, Cristal, Garantía].
     - La URL pública de la imagen → 200 `image/png`, 1061 bytes.
     - `/categories` → las 4. `/attributes` → los 2 + 4.
   - `ENVIRONMENT=prod uv run python -m valmont.scripts.seed_dev` → "seed_dev: se niega a correr con ENVIRONMENT=prod; no se ha escrito nada." y exit=1.
6. Pruebas no ejecutadas y motivo: E2E y tipos (no configurados).
7. Dependencias pendientes: ninguna. Kombai y el frontend ya pueden usar la API real en `dev`.
8. Riesgos conocidos:
   - Si el script falla después de subir una imagen pero antes del commit de ese producto, el archivo queda huérfano (es el caso de T-018).
   - La salida del script, con tildes, se ve mal en una consola de Windows que la redirige con cp1252. Es solo visual: los datos están bien.
9. Preguntas que requieren decisión: discrepancia de tipos. `Actor.user_id` está tipado como `UUID`, pero AUDIT-R5 necesita un actor nulo; el script usa `Actor(None, None)` con `type: ignore`. Propuesta: `Actor.user_id: UUID | None` en `application.py`. Decide claude-leader (está fuera de "Puede modificar").
10. Documentación actualizada: este STATUS (fila T-031 y este traspaso).
11. Siguiente acción recomendada: claude-leader revisa T-031 y avisa a frontend de que `dev` ya tiene datos de demostración.
12. Commits: el que contiene este traspaso, `feat(catalog): semillas de demostración para desarrollo (T-031)` (el hash va en el traspaso al Leader).

#### Traspaso T-029 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (revisa claude-leader).
2. Cambios:
   - Puerto `ImageStorage` (`put`, `delete`) y `StorageUnavailable` en `application.py`. Adaptador `SupabaseImageStorage` (`adapters/storage.py`): `httpx` con la clave de servicio en `Authorization` y `apikey`, timeout de 10 s (3 s de conexión) y sin seguir redirecciones. Un 3xx, 4xx, 5xx o un error de red → `StorageUnavailable` → 503 `storage_unavailable`, sin detalles. El log guarda solo el estado o la clase del error: ni el cuerpo de Storage ni la clave.
   - Dominio: `image_format` detecta el tipo por la firma (JPEG `FF D8 FF`, PNG de 8 bytes, WebP `RIFF….WEBP`); otro → 415 `unsupported_media_type`, más de 5 MiB → 413 `file_too_large`. `Product.ensure_image_can_be_removed` aplica CATALOG-R11 → 409 `last_image`. `order_images` exige exactamente todos los ids, sin repetir (si no → 422) y renumera 0…n-1.
   - Casos de uso `AddProductImage`, `UpdateProductImage`, `ReorderProductImages` y `RemoveProductImage`, más `discard_file`. Subir, ordenar y retirar toman el producto con `lock()`. La subida valida el archivo y el `alt`, bloquea el producto, sube el archivo y después inserta la fila en la siguiente posición libre (máx. + 1); si la inserción falla, borra el archivo. La retirada borra la fila y el router borra el archivo en una `BackgroundTask` tras el commit; si Storage falla, deja un aviso.
   - Rutas en el router de administración, todas con `require_admin`: `POST /products/{id}/images` (multipart `file` + `alt`, 201), `PATCH …/images/{image_id}` (`{alt}`), `PUT …/images/order` (`[image_id]`) y `DELETE …/images/{image_id}` (204). Responden `ProductImageOut` `{id, url, alt}` con la URL de §6.
   - Límite de tamaño antes de leer el cuerpo: solo la ruta de subida usa `_BoundedBodyRoute`, que rechaza por `Content-Length` (> 5 MiB + 64 KiB, o ausente) antes de que FastAPI lea el multipart. Después se leen como mucho 5 MiB + 1 bytes del archivo.
   - Persistencia: `update_image_alt`, `delete_image` y `set_image_order`. Este último hace dos `UPDATE`: primero las posiciones a negativas y después a las finales. Comprobado en PostgreSQL: un intercambio directo da `UniqueViolation`, porque el UNIQUE no es diferible.
   - `Settings.supabase_service_role_key: SecretStr | None`. `httpx` y `python-multipart`, declaradas como directas con las versiones que ya estaban en el lock.
3. Archivos modificados:
   - Código: `backend/src/valmont/modules/catalog/{domain.py, application.py, adapters/admin_http.py, adapters/persistence.py}` y `adapters/storage.py` (nuevo).
   - Compartidos: `backend/src/valmont/shared/config.py` (un campo), `backend/pyproject.toml` y `backend/uv.lock`.
   - Pruebas: `backend/tests/catalog/{catalog_helpers.py (tiny_png, InMemoryStorage), test_admin_http.py (4 rutas más en ROUTES, last_image)}`; nuevas: `test_domain_images.py`, `test_application_images.py`, `test_images_http.py`, `test_storage_adapter.py`, `test_images_db.py` y `test_storage_supabase.py`.
   - `main.py` no cambia: las rutas van en el router de administración ya registrado.
4. Decisiones tomadas (supuestos a revisar, sin cambio de contrato):
   - Un cuerpo sin `Content-Length` (transferencia por trozos) → 413 `file_too_large`. Sin ese dato no se puede acotar antes de leer, y un 411 no está en el contrato. Este 413 llega antes que el 401/403.
   - Errores de validación (413, 415, 422) antes que el 404 del producto.
   - La ruta de Storage es `{product_id}/{image_id}.{ext}`: el uuid del archivo es el id de la imagen. JPEG se guarda como `.jpg`.
   - Tras una retirada quedan huecos en las posiciones. "Siguiente libre" es máx. + 1, y ordenar renumera desde 0.
   - Solo la subida declara `storage_unavailable` en su 503. En la retirada, un fallo de Storage solo deja un aviso: el archivo queda huérfano y la respuesta es 204.
   - El aviso de huérfano registra la `storage_path`, que solo contiene UUID (sin datos personales), para poder limpiarla.
   - Sin `SUPABASE_URL` o sin la clave → `RuntimeError` (500), como hace `_image_url`.
5. Pruebas ejecutadas → resultado observado (desde `backend/`):
   - `uv run ruff format --check .` → 71 files already formatted
   - `uv run ruff check .` → All checks passed!
   - `uv run pytest -q` → 545 passed, 140 deselected (línea base: 474 passed, 124 deselected)
   - `uv run pytest -m integration -q` → 140 passed, 545 deselected (línea base: 124 passed). Incluye `test_images_db.py` (14 casos por HTTP contra `valmont_test` con Storage en memoria: subida y posición, 404, 503 sin filas, intercambio de posiciones, 422 sin cambios, `alt`, imagen de otro producto, CATALOG-R11, borrado de la fila y del archivo, borrador) y `test_storage_supabase.py` (Storage local real: sube un PNG de 1×1, lo lee por la URL pública con `image/png` y los mismos bytes, lo borra y la URL deja de servirlo; una clave falsa → `StorageUnavailable`).
   - Capas (grep de `fastapi|pydantic|sqlalchemy|httpx|supabase` en `domain*` y `application*`) → vacío.
   - `uv run alembic current` → 0004 (head) · `uv run alembic check` → No new upgrade operations detected.
   - `app.openapi()` → 18 rutas admin. Subida {201, 401, 403, 404, 413, 415, 422, 503}; PATCH y PUT {200, 401, 403, 404, 422, 503}; DELETE {204, 401, 403, 404, 409, 422, 503}. El 409 del DELETE lista solo `last_image`. `ProductImageOut` = {id, url, alt}. Sin `HTTPValidationError`.
   - En PostgreSQL, un `UPDATE … CASE` que intercambia dos posiciones en una tabla temporal con UNIQUE → `UniqueViolation`; por eso se hace en dos pasos.
6. Pruebas no ejecutadas y motivo: E2E y tipos (no configurados). Sin prueba de dos subidas concurrentes con hilos: lo cubre el diseño (`lock()` del producto).
7. Dependencias pendientes: T-031 puede subir sus marcadores con `AddProductImage` y `get_image_storage()`. El PNG debe generarse en su propio script, porque `tiny_png` vive en las pruebas.
8. Riesgos conocidos:
   - Quedan archivos huérfanos (sin fila) en dos casos, sin limpieza automática: si falla el commit después de una subida correcta, o si Storage falla al borrar tras una retirada (en este caso queda un aviso en el log).
   - En los datos semilla de las pruebas hay publicados sin imagen, así que la ficha pública de un producto con relacionados da 500 (ya anotado en T-027). Las pruebas nuevas no dependen de esa ficha.
9. Preguntas que requieren decisión: ninguna bloqueante; los supuestos del punto 4 quedan para la revisión.
10. Documentación actualizada: este STATUS (fila T-029 y este traspaso).
11. Siguiente acción recomendada: claude-leader revisa T-029 (en especial el 413 sin `Content-Length` y los huérfanos) y, después, lanza T-031.
12. Commits: el que contiene este traspaso, `feat(catalog): imágenes de producto en Supabase Storage (T-029)` (el hash va en el traspaso al Leader).

#### Traspaso T-028 (ronda 2: correcciones de qa-reviewer) — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (vuelve a qa-reviewer).
2. Cambios:
   - B-1: `UpdateProduct` mantiene CATALOG-R2 como invariante del publicado. Bloquea el producto FOR UPDATE, toma la categoría destino FOR SHARE (si no existe → 422 `category_id`), cuenta las imágenes y aplica `ensure_publishable` al resultado antes de escribir. Si falla → 409 `publish_requirements_unmet` con `details.missing`, sin cambios ni auditoría. `PublishProduct` comparte el mismo helper y el mismo orden de bloqueo.
   - M-1: `catalog.order_policy_changed` registra solo los campos que cambian.
   - M-2: el comentario de `UpdateCategory` explica la dependencia de READ COMMITTED.
   - M-4: `loc` preciso. Un nombre sin slug posible → `["body","name"]` (producto y categoría). Un carácter de control en `q`, `category`, `movement` o `case_material` → `["query", parámetro]` (público y admin).
   - M-5: el 409 de cada ruta describe solo sus códigos; el PATCH de producto incluye `publish_requirements_unmet`.
   - M-6: `AttributeValue(**body.model_dump())` va dentro de `_domain_errors`.
   - I-1: sin cambios (aprobado).
3. Archivos: `backend/src/valmont/modules/catalog/{application.py, adapters/admin_http.py, adapters/http.py}`; pruebas `backend/tests/catalog/{test_application.py (nuevo), test_admin_db.py, test_admin_http.py, test_http.py}`.
4. Decisiones: ninguna nueva. Las de la ronda 1 quedan aprobadas por el Leader (I-1).
5. Pruebas (desde `backend/`):
   - `uv run ruff format --check .` → 64 files already formatted
   - `uv run ruff check .` → All checks passed!
   - `uv run pytest -q` → 474 passed, 124 deselected
   - `uv run pytest -m integration -q` → 124 passed, 474 deselected (incluye los 5 casos de B-1 por HTTP contra `valmont_test`: 409, sin cambios y sin auditoría; y que en borrador se permiten)
   - capas → vacío
   - `uv run alembic current` → 0004 (head) · `uv run alembic check` → No new upgrade operations detected.
   - `app.openapi()` → 14 rutas admin; PATCH 409 = `sku_taken`, `slug_taken`, `slug_locked`, `publish_requirements_unmet`; sin `HTTPValidationError`.
   - `test_application.py` → 13 pruebas con fakes que fijan el orden de llamadas y los `lock=` de `PublishProduct`, `UpdateProduct` (publicado y borrador) y `UpdateCategory`.
6. No ejecutadas: E2E y tipos (no configurados).
7. Dependencias: T-029 debe usar `lock()` antes de retirar una imagen (CATALOG-R11).
8. Riesgos: ninguno nuevo.
9. Decisión pendiente: ninguna.
10. Documentación: este STATUS.
11. Siguiente acción: qa-reviewer verifica B-1 y M-1…M-6.
12. Commits: el que contiene este traspaso, `feat(catalog): API de administración del catálogo (T-028)` (el hash va en el traspaso al Leader).

#### Traspaso T-028 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (falta la revisión de qa-reviewer).
2. Cambios: router `/api/v1/catalog/admin` con las 14 rutas de §7 sin imágenes, todas con `require_admin` (dependencia del router). Casos de uso en `application.py`: `CreateProduct`, `UpdateProduct`, `PublishProduct`, `UnpublishProduct`, `CreateCategory`, `UpdateCategory` y `UpdateAttributeValue`. Errores de §7:
   - `sku_taken`, `slug_taken` y `code_taken` (409): los decide el UNIQUE.
   - `slug_locked` (409).
   - `publish_requirements_unmet` (409), con `details.missing`.
   - `category_in_use` (409).
   - `not_found` (404).
   - Referencia inexistente → 422 `validation_error` con `loc: ["body", <campo>]` y `type: "reference_not_found"`. La traduce el repositorio desde la FK; ya no puede acabar en 500.

   Reglas y concurrencia:
   - CATALOG-R3: `published_at` es la primera publicación y se conserva al despublicar y al republicar; si existe, cambiar el slug → 409.
   - Bloqueos: editar, publicar y despublicar leen el producto con `SELECT … FOR UPDATE`. Publicar toma la categoría `FOR SHARE` y desactivarla la toma `FOR UPDATE` antes de buscar publicados (CATALOG-R10 sin carreras).
   - Auditoría en la misma transacción, con `actor_id`/`actor_role` del token y el `request_id`: `product_created` (after: `sku`, `price_cents`, `order_policy`), `price_changed` (`price_cents`), `product_published` y `product_unpublished` (`status`), y `order_policy_changed` (`order_policy`, `lead_time_days`). Solo se audita lo que cambia.

   Esquemas de entrada:
   - Campos extra prohibidos, incluido `status`.
   - En PATCH, `null` borra los atributos opcionales; en los campos obligatorios da 422.
   - Enteros estrictos acotados a `integer` de PostgreSQL (precio incluido), para que un valor grande no acabe en 500.
3. Archivos: `backend/src/valmont/modules/catalog/adapters/admin_http.py` (nuevo); `backend/src/valmont/modules/catalog/{domain,application}.py` y `adapters/persistence.py` (`get`, `lock`, `update`, `list_all` de productos; `get` con bloqueo, `update`, `list_all`, `has_published_products` de categorías; `update` y `list_all` de valores); `backend/src/valmont/main.py` (registro del router); `backend/tests/catalog/{test_admin_http,test_admin_db,test_domain_admin}.py` (nuevos) y `test_persistence.py` (una FK inexistente ahora es `InvalidReference`; un id repetido sigue siendo `IntegrityError`).
4. Decisiones (supuestos a revisar):
   - Clave de auditoría: `price_cents` también en `product_created`, por coherencia con `price_changed`.
   - Publicar algo ya publicado, o despublicar un borrador, devuelve 200 sin cambios ni auditoría.
   - Las altas de categorías y valores responden 201, como la de productos.
   - El listado admin ordena por `updated_at desc, id`.
   - `main_image` de `AdminProduct` admite `null`, porque un borrador puede no tener imágenes.
   - `CategoryIn` (POST) y `CategoryUpdateIn` (PATCH) son dos esquemas.
   - `slug` opcional al crear una categoría: se genera del nombre.
   - Un código mal formado en la ruta → 404.
   - Unpublish y el PATCH de valores no declaran 409, porque no pueden producirlo.
   - `AuditEntry` y `CurrentUser` se importan desde los módulos permitidos en modules.md §3 (`audit.application` e `identity.adapters.http`), no desde los `domain`.
5. Pruebas (desde `backend/`): `uv run ruff format --check .` → 63 files already formatted · `uv run ruff check .` → All checks passed! · `uv run pytest -q` → 445 passed, 117 deselected · `uv run pytest -m integration -q` → 117 passed, 445 deselected (incluye `test_admin_db.py`: 20 pruebas por HTTP contra `valmont_test` con la auditoría real y un SAVEPOINT por solicitud, y una prueba de bloqueo entre dos conexiones) · capas → vacío · `uv run alembic current` → 0004 (head) · `uv run alembic check` → No new upgrade operations detected. · OpenAPI: 14 rutas admin, todas con 401/403/503 y errores `ErrorOut`; sin `HTTPValidationError` · grep de secretos → sin coincidencias.
6. No ejecutadas: E2E y tipos (no configurados). Concurrencia real de dos PATCH: cubierta por diseño (`FOR UPDATE`), sin prueba con hilos.
7. Dependencias: T-029 (imágenes) debe bloquear el producto con `lock()` antes de retirar una imagen (CATALOG-R11 frente a una publicación concurrente). T-031: las semillas deben dar imagen a todo publicado (un publicado sin imagen da 500 en la ficha pública).
8. Riesgos: ningún esquema de base de datos cambia. Los publicados sin imagen solo pueden existir por datos insertados fuera de la API.
9. Decisión pendiente: ninguna bloqueante; los supuestos del punto 4 están a la espera de revisión.
10. Documentación: este STATUS.
11. Siguiente acción: qa-reviewer revisa T-028 (autorización, auditoría y bloqueos); después, claude-leader integra.

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
