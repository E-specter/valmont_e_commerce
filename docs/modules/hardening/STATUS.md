# hardening (T-018) — Estado
> Fase: 5 (antes del lanzamiento) · Estado: PLAN PROPUESTO (paquetes listos para delegar; el Leader aprueba D-H1 y D-H2) · Última actualización: 2026-11-27 backend-lead (paquete T-018i)

Transversal: no es un módulo con SPEC propia. Cada paquete corrige hallazgos de auditorías (T-016, T-080 R-14, T-096, T-103, T-104, T-126 N-9) y toca `shared/` o adaptadores de varios módulos. Orden de autoridad y contratos: `docs/modules.md` §4.4, §5, §6.

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-018a | Cabeceras `no-store` y `nosniff` en toda la API y límite de tamaño del cuerpo (413) | backend-dev + qa-reviewer | ninguna | DONE (a75e77c) |
| T-018b | Logs y fallos de infraestructura: `sqlalchemy.engine` en WARNING, sin `DETAIL` de PostgreSQL, `X-Request-ID` solo UUID, JWKS no-JSON → 503 | backend-dev + qa-reviewer | ninguna | DONE (a75e77c) |
| T-018c | `Idempotency-Key` solo UUID, una definición en `shared/` (orders y payments) | backend-dev + qa-reviewer | **D-H1** (contrato, Leader + frontend-lead) | DONE (45ae4c1) |
| T-018d | Texto de entrada: rechazar controles bidireccionales y caracteres invisibles; nombres sin parte visible | backend-dev + qa-reviewer | **D-H2** (cambio en 6 módulos, Leader) | DONE (297a8d8) |
| T-018f | Limpieza de archivos huérfanos de Storage (`dry-run` por defecto) | backend-dev + qa-reviewer | ninguna | DONE (42af4eb) |

| T-018e | Límites de longitud en el OpenAPI (solo documentación) | backend-dev + qa-reviewer | ninguna | DONE (45ae4c1) |
| T-018g | Copias de seguridad: 4 MENOR de T-103 en `deploy/scripts/` | backend-dev + qa-reviewer | **ficha de auditoría Docker y confirmación del usuario** (D-011) | BLOCKED |
| T-018h | Despliegue con dominio real: `security.allowedDomains` de Astro, cabeceras y 502 en Caddy, HSTS, `--forwarded-allow-ips`, comentarios de `compose.yml` (MENOR de T-104, ui N-9) | frontend-dev + backend-dev + qa-reviewer | dominio real y T-104 desplegada | BACKLOG |
| T-018i | Imágenes de producto subidas: WebP optimizado y sin metadatos con Pillow `==13.0.0` (D-047 D-H3, D-048) | backend-dev + qa-reviewer | ninguna (D-048 aprobada); integrar después de T-018f | READY |
| T-018q | QA: estabilizar las dos pruebas inestables de payments (QA de T-138) | qa-reviewer | ninguna | DONE (0d653d2) |

IDs reservados del hardening: T-018a…T-018q (los de arriba); un `fix` de QA reutiliza el sufijo con número (`T-018a1`).

**Orden y paralelismo.** Archivos disjuntos entre sí:
- Primera tanda, en paralelo: **T-018a ∥ T-018b ∥ T-018e ∥ T-018f ∥ T-018q** (`shared/hardening.py` + `main.py` · `shared/logs.py` + `shared/auth.py` · solo `adapters/*http.py` de catalog, identity, inventory y promotions · `catalog/` + `scripts/` · solo `backend/tests/payments/`).
- Segunda tanda, tras decidir D-H1 y D-H2: **T-018c ∥ T-018d** (c: `shared/idempotency.py`, `orders/adapters/http.py`, `payments/adapters/http.py`; d: `shared/text.py`, seis `domain.py` y `orders/adapters/admin_http.py`). Disjuntos en producción; en pruebas, c cambia fixtures de `tests/orders` y `tests/payments` y d añade casos en los mismos directorios: si comparten rama, QA las hace en serie.
- **T-018i** (WebP sin metadatos: `catalog/domain.py`, `application.py`, `adapters/admin_http.py`, `adapters/image_optimizer.py` nuevo, `scripts/seed_dev.py`, `pyproject.toml`, `uv.lock`): se **integra después de T-018f** (comparten `application.py`, en bloques distintos; f no toca `domain.py`, `admin_http.py` ni la semilla). Con T-018d (`catalog/domain.py`) y T-018e (`admin_http.py`) los hunks no se pisan, pero se integran en serie por fast-forward y el segundo rebasa. En paralelo con T-018c sin restricción (archivos y pruebas disjuntos).
- Coste: 10 paquetes. Para no lanzar 10 agentes a la vez, T-018a y T-018b pueden asignarse al mismo `backend-dev` en serie (archivos distintos, sin dependencia).
- T-018g y T-018h no empiezan sin su condición.

## Decisiones pendientes (para el Leader o el usuario)

| ID | Pregunta | Opciones | Recomendada |
|---|---|---|---|
| D-H1 | Formato de `Idempotency-Key` (MENOR-1 de payments: un PAN podría guardarse como clave) | **A:** exigir UUID (36 caracteres, hex con guiones; se normaliza a minúsculas). **B:** mantener `[A-Za-z0-9_-]{16,64}` y rechazar 13–19 dígitos seguidos | **A.** B no cubre `4111-1111-1111-1111` (el patrón actual admite guiones) y A cierra el riesgo por construcción: un UUID no tiene más de 12 dígitos seguidos. Es una restricción del request **sin consumidores todavía** (checkout T-082 y pago T-098 son BACKLOG; el BFF solo reenvía la cabecera): el frontend genera la clave con `crypto.randomUUID()`. Requiere visto bueno de frontend-lead (api-contract-review §3) |
| D-H2 | Rechazar caracteres `Cf` (controles bidireccionales, ancho cero, guion blando) y rellenos invisibles en todo texto guardado | **A:** helper único `shared/text.py` y que los 6 dominios lo llamen (toca `domain.py` de identity, orders, catalog, inventory, promotions). **B:** solo en identity (`full_name`) y orders (`DeliveryDetails`), los datos personales | **A.** Hoy hay 7 copias del mismo filtro `Cc`/`Cs`; dejarlas así reproduce el hueco. Cambio de comportamiento: más 422 `validation_error` en esos campos (misma forma). Pierde el ZWJ de un emoji compuesto y el ZWNJ del persa: irrelevante para relojería |
| D-H3 | Límite de cuerpo del JSON: 256 KiB. ¿Se acepta? | 64 KiB · **256 KiB** · 1 MiB | **256 KiB** (cálculo en T-018a) |
| D-H4 | La limpieza de Storage, ¿quién la ejecuta y cuándo? | **A:** script manual `--apply` por el Leader/usuario antes del lanzamiento y tras incidentes. **B:** también un temporizador en `deploy/` (cron del host o servicio compose) | **A** ahora; B entra en T-018h (toca `deploy/`: ficha D-011) |

## Contratos (api-contract-review, §3 y §4)

| Cambio | Clasificación | Consumidor afectado | Acción |
|---|---|---|---|
| 413 `payload_too_large` (nuevo, cualquier ruta con cuerpo) | compatible: código de error nuevo en el formato común | `frontend/src/pages/bff/[...path].ts` ya limita su propio cuerpo y reenvía el estado | documentar en `modules.md` §4.4 al integrar T-018a |
| `Cache-Control: no-store` y `X-Content-Type-Options: nosniff` | compatible | ninguno | ninguna |
| La subida de imagen sigue en 413 `file_too_large` (hasta 6 MiB; por encima, `payload_too_large`) | compatible: el criterio de T-029 (más de 5 MiB → 413) se cumple en ambos casos | pantalla de imágenes del backoffice (pendiente de T-140) | el frontend traduce por **estado 413** y, si distingue, por `code` ∈ {`file_too_large`, `payload_too_large`} |
| `POST /admin/products/{id}/images`: se guarda WebP (`.webp`, `image/webp`) y hay tres 422 nuevos: `invalid_image`, `image_dimensions_exceeded`, `animated_image` (T-018i) | compatible: la respuesta `{id, url, alt}` no cambia de forma; códigos de error nuevos en el formato común; 413 y 415 como hoy | pantalla de imágenes del backoffice (pendiente de T-140): usa la `url` tal cual y traduce los tres códigos | actualizar SPEC de catalog §7 y §9 al integrar T-018i |
| `X-Request-ID` del cliente solo se reutiliza si es UUID | compatible: otro valor se sustituye (ya ocurría con los inválidos) | ninguno (el frontend no lo envía) | actualizar el criterio de T-007 en `tasks.md` (línea de `request_id_middleware`) |
| `Idempotency-Key`: 422 si no es UUID (orders y payments) | **restricción del request** (cuenta como incompatible en la skill) | ninguno desplegado; checkout T-082 y pago T-098 aún no existen | **D-H1.** Marcado y escalado; no se implementa sin su visto bueno |
| Más 422 por `Cf` y rellenos invisibles | compatible en forma (mismo `validation_error`), más estricto | formularios de registro, perfil y entrega | D-H2; frontend-lead lo anota en `ui/STATUS.md` N-10 |
| `maxLength`/`maxItems` en el OpenAPI | compatible (solo documentación) | tipos del cliente de API (si se generan) | ninguna |

Lista de revisión de la skill: importes del servidor (sin cambio) · identidad por sesión (sin cambio) · sin datos de otros usuarios (sin cambio) · errores con `{"error": {"code","message","details"}}` (el 413 lo usa) · convenciones §5 (sin cambio).

## Paquetes de tarea

### T-018a — Cabeceras de seguridad y límite de cuerpo
- Objetivo: toda respuesta de `/api/*` (también 401, 404, 405, 409, 413, 422 y 500) lleva `Cache-Control: no-store`; toda respuesta de la app lleva `X-Content-Type-Options: nosniff`; un cuerpo mayor que el límite responde 413 `payload_too_large` en el formato común, con o sin `Content-Length` (cierra R-14 de orders y R-11/R-4 de payments; ASVS 8.2.1 y 14.4).
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulo: shared · Requisitos: RNF02, RNF10 · IDs: R-14 (orders), R-4 y R-11 (payments)
- Leer: `backend/src/valmont/main.py`; `shared/logs.py` (`request_id_middleware`: estilo y orden); `shared/errors.py` (`error_response`); `modules/catalog/adapters/admin_http.py` líneas 585-625 (`_BODY_MAX`, `_BoundedBodyRoute`: ya rechaza por `Content-Length` y devuelve `file_too_large`; **no se toca**); `deploy/Caddyfile` (`request_body max_size 6MiB`).
- Contratos aplicables: `docs/modules.md` §4.4 (formato de error). Nuevo `code`: `payload_too_large`.
- Dependencias: ninguna.
- Puede modificar: `backend/src/valmont/shared/hardening.py` (nuevo) y `backend/src/valmont/main.py` (solo el registro de middleware).
- Protegido: el resto de `shared/`, todo `modules/`, `deploy/`, `frontend/`, `backend/tests/**`, `migrations/**`. Sin dependencias nuevas (ASGI puro de Starlette).
- Resultado esperado: el módulo y el registro, con este **orden** (el último registrado es el más externo):
  ```python
  app.add_middleware(BodyLimitMiddleware)                 # más interno
  app.middleware("http")(request_id_middleware)           # ya existe
  app.middleware("http")(security_headers_middleware)     # más externo: alcanza también el 500 y el 413
  ```
- Firmas públicas (`valmont.shared.hardening`):
  - `MAX_BODY_BYTES = 256 * 1024`
  - `MAX_MULTIPART_BODY_BYTES = 6 * 1024 * 1024` (igual al `max_size` de Caddy; por encima del `_BODY_MAX` de catalog, que sigue siendo quien responde `file_too_large` entre 5 MiB + 64 KiB y 6 MiB)
  - `NO_STORE_PREFIX = "/api/"`
  - `class BodyLimitMiddleware:` con `def __init__(self, app: ASGIApp, *, max_body_bytes: int = MAX_BODY_BYTES, max_multipart_bytes: int = MAX_MULTIPART_BODY_BYTES) -> None` y `async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None`. Solo actúa en `scope["type"] == "http"`; el límite es `max_multipart_bytes` si `Content-Type` empieza por `multipart/form-data` y `max_body_bytes` en el resto.
  - `def body_limit_for(content_type: str | None, *, max_body_bytes: int, max_multipart_bytes: int) -> int`
  - `async def security_headers_middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response`
  - Respuesta 413: `{"error": {"code": "payload_too_large", "message": "El cuerpo de la solicitud supera el tamaño permitido.", "details": {"max_bytes": <límite aplicado>}}}`, con `X-Request-ID`, `no-store` y `nosniff` (usa `error_response`).
  - Reglas: (1) `Content-Length` numérico mayor que el límite → 413 sin leer el cuerpo; (2) sin `Content-Length` (chunked) o con uno falso → se cuentan los bytes recibidos y, al pasar el límite, 413 (no 400 ni 500: FastAPI convierte una excepción del `receive` en 400, así que el desbordamiento se señala con un indicador y se sustituye la respuesta de la app); (3) `Content-Length` no numérico → se ignora y rige el recuento; (4) `no-store` solo se pone si la ruta no fijó su propio `Cache-Control` (payments ya lo fija); (5) `nosniff` va en toda respuesta, `/health` y `/docs` incluidos; (6) las rutas fuera de `/api/` (`/health`, `/docs`, `/openapi.json`) no reciben `no-store`.
- Decisiones técnicas: **límite JSON 256 KiB.** El cuerpo legítimo mayor es una ficha de producto: descripción de 5 000 caracteres más 40 especificaciones de hasta 260 caracteres, unos 100 KiB en el peor caso con escapes `\uXXXX`; 256 KiB deja margen y acota la memoria por solicitud (D-H3). **Multipart 6 MiB**: imagen de 5 MiB (D-019) más 64 KiB de formulario más holgura, igual que Caddy, para que el mensaje específico `file_too_large` de catalog siga siendo el que ve el administrador. **`no-store` en todo `/api/`, sin lista de excepciones**: no hay CDN ni caché pública que perder, la regla por defecto es la segura y una sola línea sirve a orders, payments, identity, cart y backoffice (los datos personales están en casi todas las rutas); si se quiere caché pública del catálogo se decide después con su propia tarea.
- Criterios de aceptación: ver pruebas; además `pytest -q` y `pytest -m integration -q` completos en verde sin tocar pruebas de otros módulos salvo la fixture de la nueva cabecera si alguna comprobara la ausencia.
- Pruebas obligatorias (las escribe qa-reviewer en `backend/tests/shared/test_hardening.py`; puertas: `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, `uv run python -c "…openapi…"` sin cambios de rutas):
  1. `/api/v1/*` con 200, 201, 401 (sin token), 404, 405, 409, 422 y un 500 forzado llevan `no-store` y `nosniff`; `/health` lleva `nosniff` y no `no-store`.
  2. Una ruta que fija su `Cache-Control` (payments) conserva el suyo.
  3. Cuerpo JSON de exactamente `MAX_BODY_BYTES` → pasa; `+1` → 413 con el cuerpo de arriba, `X-Request-ID` y las dos cabeceras; vale para `Content-Length` y para cuerpo troceado (generador) sin `Content-Length`, y la ruta no llega a ejecutarse.
  4. Multipart: 5 MiB + 64 KiB pasa el middleware; más de 6 MiB → 413 `payload_too_large`; la subida de imagen de T-029 sigue dando 201 (5 MiB) y 413 `file_too_large` (5 MiB + 1) sin cambios en `tests/catalog/test_images_http.py`.
  5. GET y solicitudes sin cuerpo no cambian; el orden de middleware: un 413 y un 500 llevan `X-Request-ID` y `no-store`.
  6. Capas: `hardening.py` no importa `valmont.modules`.
- Diseño (frontend): no aplica.
- Revisión manual (usuario, en `main`): `curl -si -X POST localhost:8000/api/v1/orders -H "Content-Type: application/json" --data-binary @archivo300KiB` → 413 con `payload_too_large`; `curl -si localhost:8000/api/v1/identity/me` → 401 con `Cache-Control: no-store` y `X-Content-Type-Options: nosniff`.
- Seguridad: el límite se aplica antes de leer el cuerpo; ni el mensaje ni `details` repiten datos del cliente.
- Estado inicial: READY.
- Entrega: cambio preparado sin commit (`git add backend/src/valmont/shared/hardening.py backend/src/valmont/main.py`); mensaje propuesto `feat(shared): cabeceras no-store y nosniff y límite de cuerpo (T-018a)`.
- IDs reservados: ninguno.
- Escalar si: el recuento de bytes exige cambiar el `_BoundedBodyRoute` de catalog, o `BaseHTTPMiddleware` impide que el 413 llegue a `request_id_middleware`.

### T-018b — Logs y fallos de infraestructura
- Objetivo: (1) con cualquier `LOG_LEVEL`, el logger `sqlalchemy.engine` no baja de WARNING; (2) ningún log lleva el `DETAIL` de PostgreSQL, solo `sqlstate` y nombre de restricción; (3) el `X-Request-ID` del cliente solo se reutiliza si es un UUID; (4) un JWKS que responde algo que no es JSON da 503 `auth_unavailable` con aviso, no 401.
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulo: shared · Requisitos: RNF10 · IDs: R-10 y MENOR-1/2/3 de payments (T-096), JWKS (T-016)
- Leer: `shared/logs.py`; `shared/auth.py` (`verify_token`); `shared/db.py` (`hide_parameters=True`); `docs/modules/payments/STATUS.md` R-10 y "Auditoría T-096"; `backend/tests/shared/test_logs.py`, `tests/identity/test_http.py` (cómo sustituyen `get_jwks_client`).
- Contratos aplicables: `docs/modules.md` §4.4 y §7. `X-Request-ID`: criterio de `request_id_middleware` en `tasks.md` (T-007).
- Dependencias: ninguna.
- Puede modificar: `backend/src/valmont/shared/logs.py`, `backend/src/valmont/shared/auth.py`.
- Protegido: `shared/errors.py`, `shared/db.py`, `main.py`, todo `modules/`, `backend/tests/**`. Sin dependencias nuevas.
- Resultado esperado y firmas (`valmont.shared.logs`):
  - `QUIET_LOGGERS = ("sqlalchemy.engine", "httpcore")`: `configure_logging(level)` fija cada uno a `logging.WARNING` **después** de `root.setLevel(level)`, también cuando el handler ya existía. `httpcore` es preventivo (no se verificó que a DEBUG vuelque cabeceras con la clave de servicio de Storage); `sqlalchemy.engine` es el hallazgo R-10.
  - `def redact_db_detail(text: str) -> str`: función pura; sustituye cada línea `DETAIL: …` por `DETAIL: [omitido]` y cada `Key (…)=(…)` por `Key (…)=(…)` sin valores.
  - `class SafeFormatter(logging.Formatter)` con `formatException(self, ei) -> str`: aplica `redact_db_detail` y, por cada error de BD de la cadena (`__cause__`, `__context__`, `SQLAlchemyError.orig`, objeto con `.diag`), añade una línea `[BD] sqlstate=<código> constraint=<nombre o ->`. Es el formateador del handler `valmont` (`LOG_FORMAT` no cambia). Si el mecanismo elegido es un `logging.Filter`, la salida observable es la misma (ver pruebas).
  - `_VALID_REQUEST_ID` pasa a: UUID canónico (`8-4-4-4-12` hex) o 32 hex (el formato que genera el servidor, `uuid4().hex`). Cualquier otro valor se sustituye por `uuid4().hex`; la cabecera de respuesta sigue siendo `X-Request-ID`. `REQUEST_ID_HEADER` y `request_id_var` no cambian.
  - `valmont.shared.auth.verify_token`: antes del `except jwt.PyJWTError, ValueError` añade `except (json.JSONDecodeError, UnicodeDecodeError)` → `logger.warning("JWKS de Supabase Auth no devolvió JSON válido (%s)", type(exc).__name__)` (nunca el cuerpo) y `raise AppError("auth_unavailable", "Autenticación no disponible.", 503) from None`. Un token mal formado o con firma inválida sigue siendo 401. Causa: `jwt.PyJWKClient.fetch_data` deja escapar el `JSONDecodeError` de `json.load` (que es un `ValueError`) y hoy cae en el 401.
- Criterios de aceptación: ver pruebas; ningún cambio de forma en las respuestas de error.
- Pruebas obligatorias (qa-reviewer, en `backend/tests/shared/test_logs.py`, `tests/shared/test_auth_jwks.py` y, con BD, un caso `integration`; puertas: `ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`):
  1. `configure_logging("DEBUG")` deja `logging.getLogger("sqlalchemy.engine").getEffectiveLevel() == WARNING` y `httpcore` también; con `INFO` igual; el root sigue en el nivel pedido.
  2. `redact_db_detail` sobre el texto real de un `UniqueViolation` ("DETAIL:  Key (user_id, idempotency_key)=(…, …) already exists.") no contiene ningún valor; el nombre de la restricción sobrevive.
  3. Con la BD real (integration): provocar un `IntegrityError` en un request y comprobar, leyendo el flujo del handler `valmont` (no `caplog`, que tiene su propio formateador), que el log de "Error no controlado" lleva `sqlstate=23505` y la restricción y **no** contiene el valor único ni "DETAIL:  Key".
  4. `X-Request-ID`: un UUID y un hex de 32 se reutilizan; `1234567890123456`, `abc-123`, `a`*64, uno con salto de línea y uno de 13–19 dígitos se sustituyen por un hex de 32 nuevos; ese valor nuevo es el que ve el log y el de `audit.request_id`.
  5. JWKS: `get_jwks_client` sustituido por uno que lanza `json.JSONDecodeError` y otro con `UnicodeDecodeError` → 503 `auth_unavailable` en una ruta protegida, aviso en el log sin el cuerpo; el mismo cliente con un token basura → 401; una prueba de punta a punta con un servidor local que responde `200 <html>` al JWKS (urllib real) → 503.
  6. Las pruebas existentes de `test_logs.py` que asumían el patrón anterior (`[A-Za-z0-9-]{1,64}`) se actualizan, no se borran.
- Diseño (frontend): no aplica.
- Revisión manual (usuario): ninguna visible; el Leader enseña el resultado de la prueba 3.
- Seguridad: nunca el cuerpo del JWKS ni valores de columnas en un log. Residual aceptado: un JWKS con JSON válido pero sin claves o sin objeto sigue dando 401 (PyJWT lo lanza como `PyJWKClientError`, igual que un `kid` desconocido; no se distingue por tipo).
- Estado inicial: READY.
- Entrega: `git add backend/src/valmont/shared/logs.py backend/src/valmont/shared/auth.py`; mensaje `fix(shared): logs sin DETAIL de PostgreSQL, X-Request-ID solo UUID y JWKS no JSON da 503 (T-018b)`.
- IDs reservados: ninguno.
- Escalar si: `formatException` no basta porque otro handler (uvicorn) vuelca la traza sin pasar por `valmont`; entonces se decide si se añade un filtro global.

### T-018c — `Idempotency-Key` solo UUID (D-H1, no empieza sin aprobación)
- Objetivo: una única definición de la cabecera en `shared/` que acepta solo un UUID (36 caracteres), normalizado a minúsculas, usada por `POST /orders` y `POST /payments/orders/{id}/attempts`. Cierra MENOR-1 de payments y E-P5 de su SPEC.
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulos: orders y payments (adaptadores) · Requisitos: RF04.01, RF05.03, RNF10
- Leer: `modules/orders/adapters/http.py` líneas 445-480; `modules/payments/adapters/http.py` líneas 50-60 y 190-230; `docs/modules/orders/SPEC.md` ORDERS-R8 y §7; `docs/modules/payments/SPEC.md` §4 (R3) y E-P5; `frontend/src/pages/bff/[...path].ts` línea 16 (solo para constatar que no cambia).
- Contratos aplicables: SPEC de orders §7 y de payments §7 (ver tabla "Contratos"): el formato pasa de `[A-Za-z0-9_-]{16,64}` a UUID.
- Dependencias: **D-H1**; T-018a/T-018b no.
- Puede modificar: `backend/src/valmont/shared/idempotency.py` (nuevo), `modules/orders/adapters/http.py` y `modules/payments/adapters/http.py` (solo la definición y los imports de `IdempotencyKey`).
- Protegido: `application.py`, `domain.py`, `persistence.py` y migraciones de ambos módulos (la restricción `char_length BETWEEN 16 AND 64` de la BD sigue valiendo para un UUID de 36), el resto de `shared/`, `frontend/`, `backend/tests/**`.
- Firmas públicas (`valmont.shared.idempotency`):
  ```python
  IDEMPOTENCY_KEY_PATTERN = r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"
  IdempotencyKey = Annotated[
      str,
      Header(alias="idempotency-key", min_length=36, max_length=36, pattern=IDEMPOTENCY_KEY_PATTERN),
      AfterValidator(str.lower),   # dos mayúsculas/minúsculas distintas son la misma clave
  ]
  ```
  Ambos `http.py` hacen `from valmont.shared.idempotency import IdempotencyKey` y borran su copia. Sin clave o con otro formato: 422 `validation_error` con `loc ["header", "idempotency-key"]` (como hoy); el OpenAPI declara `minLength`/`maxLength` 36 y el patrón en las dos rutas.
- Criterios de aceptación: UUID válido (mayúsculas o minúsculas) → como hoy; la repetición con la misma clave en otra capitalización devuelve el mismo pedido o intento (200); `4111111111111111`, `4111-1111-1111-1111`, 16 caracteres cualquiera, UUID sin guiones, con espacios o de 37 caracteres → 422; sin cabecera → 422; la clave nunca aparece en `message` ni `details` del 422.
- Pruebas obligatorias (qa-reviewer): casos de arriba en `tests/orders/` y `tests/payments/`; el OpenAPI de las dos rutas; capas (`shared/idempotency.py` no importa módulos); **actualizar las fixtures** de ambos directorios que fabrican claves no UUID (`uuid4()` basta); suites de orders y payments completas, también `integration`.
- Revisión manual: ninguna visible (sin cliente aún); el Leader enseña la suite.
- Seguridad: un PAN no puede ser clave (un UUID no tiene más de 12 dígitos seguidos).
- Estado inicial: PROPUESTO hasta que el Leader apruebe D-H1 y frontend-lead lo anote en `ui/STATUS.md` (N-10: el checkout y el pago generan `crypto.randomUUID()`).
- Entrega: `git add backend/src/valmont/shared/idempotency.py backend/src/valmont/modules/orders/adapters/http.py backend/src/valmont/modules/payments/adapters/http.py`; mensaje `fix(shared): Idempotency-Key solo UUID, definida una vez (T-018c)`.
- IDs reservados: ninguno. Docs a actualizar por backend-lead al integrar: ORDERS-R8 y payments R3 (SPEC) y la fila de contrato.
- Escalar si: algún dato existente de producción usa claves que no son UUID (hoy solo hay datos de desarrollo).

### T-018d — Texto de entrada sin controles bidireccionales ni invisibles (D-H2, no empieza sin aprobación)
- Objetivo: todo texto guardado o mostrado rechaza caracteres `Cf` (controles bidireccionales U+061C, U+200E-200F, U+202A-202E, U+2066-2069; ancho cero U+200B-200D, U+2060, U+FEFF; guion blando U+00AD) y rellenos invisibles (U+2800, U+3164, U+FFA0, U+115F, U+1160, U+17B4-17B5, U+034F); un texto obligatorio sin ninguna parte visible (por ejemplo `"ㅤ"`) es 422. Cierra el riesgo de nombres que se ven iguales o con el texto invertido (spoofing en el backoffice y en documentos).
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulos: shared + identity, orders, catalog, inventory, promotions · Requisitos: RNF02, RNF10
- Leer: `identity/domain.py` líneas 68-80; `orders/domain.py` líneas 160-175; `catalog/domain.py` líneas 148-170 (`clean_text`); `inventory/domain.py` líneas 160-170 (`has_control_chars`); `promotions/domain.py` líneas 35-60; `orders/adapters/admin_http.py` líneas 215-240; `docs/modules/orders/STATUS.md` T-085 (precedente de `carrier` y `note`).
- Contratos aplicables: ninguno nuevo (el 422 mantiene su forma). Ver tabla "Contratos".
- Dependencias: **D-H2**.
- Puede modificar: `backend/src/valmont/shared/text.py` (nuevo); y solo en las funciones citadas: `modules/identity/domain.py`, `modules/orders/domain.py`, `modules/catalog/domain.py`, `modules/inventory/domain.py`, `modules/promotions/domain.py`, `modules/orders/adapters/admin_http.py` (validador `_without_controls`).
- Protegido: los filtros de búsqueda `q` (se quedan con `Cc`/`Cs`: no se guardan), `application.py`, `persistence.py`, migraciones, `main.py`, `backend/tests/**`.
- Firmas públicas (`valmont.shared.text`):
  ```python
  def has_unsafe_chars(text: str, allow: str = "") -> bool   # Cc, Cs (salvo `allow`), Cf o relleno invisible
  def has_visible_char(text: str) -> bool                    # algún carácter que no sea Z*, C* ni relleno invisible
  ```
  Cada dominio sustituye su copia por `has_unsafe_chars` (mismos `allow` de hoy: `"\n"` en descripciones y notas) y exige `has_visible_char` en los textos obligatorios (`clean_text`, `_text`, `normalize_full_name`, nombres de producto, categoría y promoción). Los mensajes de error actuales no cambian (siguen siendo "caracteres de control no permitidos").
- Criterios de aceptación: los casos de la lista rechazan con 422 y la misma forma de hoy; `"José Núñez"`, `"Calle 5 de Mayo #123, Lima"`, `"Reloj de pulsera — edición 1925"`, textos con `ñ`, `ü`, tildes y comillas tipográficas pasan; un salto de línea sigue permitido solo donde hoy lo está.
- Pruebas obligatorias (qa-reviewer): tabla unitaria de `has_unsafe_chars` y `has_visible_char` (cada punto de código de la lista, los permitidos y los límites); un caso por dominio (full_name, `recipient_name` y `address_line` de entrega, nombre de producto y descripción, nota de inventario, nombre de promoción, `carrier`) por HTTP con `loc` correcto; las suites existentes sin editar; capas (`shared/text.py` sin imports de módulos).
- Revisión manual (usuario): registrar un nombre con `‮` en el formulario → mensaje de campo inválido (después de T-127/T-131).
- Seguridad: no cambia lo guardado; solo lo rechaza.
- Estado inicial: PROPUESTO.
- Entrega: `git add` de esos 7 archivos; mensaje `feat(shared): rechazar controles bidireccionales y caracteres invisibles en el texto (T-018d)`.
- IDs reservados: ninguno.
- Escalar si: un dato semilla o un caso de uso legítimo contiene `Cf` (p. ej. un emoji compuesto en una descripción de demostración).

### T-018e — Límites de longitud en el OpenAPI
- Objetivo: cada texto de entrada y cada lista del request declara su tope en el OpenAPI (`maxLength`, `maxItems`) sin cambiar lo que se acepta.
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulos: catalog, identity, inventory, promotions (solo adaptadores HTTP) · Requisitos: RNF10
- Leer: las constantes de `*/domain.py` citadas abajo; `modules/identity/adapters/http.py` líneas 95-115; `modules/catalog/adapters/admin_http.py` (Annotated de campos), `catalog/adapters/http.py` (parámetros de consulta); `docs/modules.md` §5.
- Contratos aplicables: solo documentación del OpenAPI (compatible).
- Dependencias: ninguna.
- Puede modificar: `modules/catalog/adapters/admin_http.py`, `modules/catalog/adapters/http.py`, `modules/identity/adapters/http.py`, `modules/inventory/adapters/admin_http.py`, `modules/promotions/adapters/admin_http.py`.
- Protegido: `domain.py` y `application.py`, `modules/orders/**`, `modules/payments/**` (`card_last4` es patrón de 4 dígitos), `shared/`, `backend/tests/**`.
- Cómo: **sin validar antes de normalizar.** Un `max_length` real en `Annotated[str, Field(max_length=…)]` rechazaría un texto de 130 caracteres con espacios que tras recortar cabe en 120, y cambiaría los mensajes. Se declara con `Field(json_schema_extra={"maxLength": N})` (en `Query`/`Path`, `json_schema_extra` igual) y `maxItems` en las listas; N sale **siempre de la constante del dominio** (`from …domain import NAME_MAX`), nunca de un literal.
- Campos (resultado de recorrer el OpenAPI actual; 43 en cuerpos y 8 parámetros):
  - catalog cuerpos: `ProductCreateIn`/`ProductUpdateIn` → `sku` SKU_MAX, `slug` SLUG_MAX, `name` NAME_MAX, `description` DESCRIPTION_MAX, `movement_code`/`case_material_code` SLUG_MAX, `specs` maxItems SPECS_MAX; `SpecIn.label` SPEC_LABEL_MAX, `.value` SPEC_VALUE_MAX; `CategoryIn`/`CategoryUpdateIn` → `slug` SLUG_MAX, `name` CATEGORY_NAME_MAX, `description` CATEGORY_DESCRIPTION_MAX; `AttributeValueIn` `code` SLUG_MAX y `label` LABEL_MAX (+ `AttributeValueUpdateIn.label`); `ImageUpdateIn.alt` y el `alt` del formulario de imagen ALT_MAX.
  - catalog parámetros: `category`, `movement`, `case_material` y `slug` de la ficha, `code` de las dos rutas PATCH de atributos → SLUG_MAX.
  - identity: `ProfileUpdateIn.full_name` FULL_NAME_MAX, `phone` 16 (`+` y 15 dígitos), `accept_privacy_version` PRIVACY_VERSION_MAX, `birth_date` 10; `PreferencesIn.style` SHORT_TEXT_MAX y `materials` maxItems MATERIALS_MAX.
  - inventory: `MovementIn.note` NOTE_MAX. promotions: `name` (NAME_MAX) en `PromotionIn`/`PromotionUpdateIn` y `product_ids` maxItems PRODUCTS_MAX.
  - Se dejan sin tope, y el test los lista como excepciones: `file` (binario), `Money-Input.currency` (valor único), `case_diameter_mm` y los parámetros `case_diameter_mm_min`/`_max` (decimales; backend-dev confirma su tipo en el OpenAPI y les da `maxLength` o los deja en la lista con motivo).
- Criterios de aceptación: el OpenAPI declara los topes anteriores; cero cambios de comportamiento (las suites existentes pasan sin editarse; un texto de 130 caracteres que recortado cabe sigue aceptándose).
- Pruebas obligatorias (qa-reviewer, `backend/tests/shared/test_openapi_limits.py`): recorrer `app.openapi()` y exigir que todo `string` de un request o parámetro sin `format`, `enum`, `const` ni `pattern` tenga `maxLength` y toda lista tenga `maxItems` (con la lista de excepciones de arriba); comparar cada tope con su constante de dominio (tabla); un caso de no regresión por la normalización (texto con espacios laterales); `ruff` y `pytest -q`.
- Revisión manual: abrir `/docs` y ver los topes en los esquemas.
- Seguridad: ninguna nueva; documenta lo que el servidor ya hace cumplir.
- Estado inicial: READY.
- Entrega: `git add` de los 5 archivos; mensaje `docs(api): límites de longitud en el OpenAPI (T-018e)`.
- IDs reservados: ninguno.
- Escalar si: un tope del dominio no es una constante (hay que crear una en `domain.py`, que está protegido).

### T-018f — Limpieza de archivos huérfanos en Storage
- Objetivo: un comando que lista y, con `--apply`, borra del bucket `products` los archivos sin fila en `app.product_images` y con más de 24 h. Orígenes de huérfanos (T-029): commit fallido tras una subida correcta; borrado de Storage fallido tras retirar una imagen (queda un aviso en el log); fallo del script de semillas entre la subida y el commit.
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulo: catalog · Requisitos: RF02.* (imágenes), RNF12 · IDs: T-029 (huérfanos)
- Leer: `modules/catalog/adapters/storage.py`; `catalog/application.py` líneas 96-103 (`ImageStorage`) y 330-370 (`discard_file`, `AddProductImage`: ruta `<product_id>/<image_id>.<ext>`); `catalog/adapters/persistence.py` líneas 150-165 (`ProductImageRow`); `scripts/seed_dev.py` (estilo de script y de sesión); `tests/catalog/test_storage_adapter.py`; `docs/modules/catalog/STATUS.md` T-029 (puntos 9-10).
- Contratos aplicables: ninguno HTTP.
- Dependencias: ninguna.
- Puede modificar: `modules/catalog/application.py` (solo añadir), `modules/catalog/adapters/storage.py` (añadir `list_files`), `modules/catalog/adapters/persistence.py` (añadir `referenced_paths`), `backend/src/valmont/scripts/cleanup_orphan_images.py` (nuevo).
- Protegido: `ImageStorage` (no se le añaden métodos: fakes de otras pruebas), `admin_http.py`, migraciones, `deploy/` (el temporizador es D-H4/T-018h), `backend/tests/**`.
- Firmas públicas:
  ```python
  # modules/catalog/application.py
  ORPHAN_GRACE = timedelta(hours=24)
  MAX_ORPHAN_DELETIONS = 50
  @dataclass(frozen=True) class StoredFile: path: str; created_at: datetime
  class ImageInventory(Protocol):  def list_files(self) -> Iterable[StoredFile]: ...
  class ImagePathReader(Protocol): def referenced_paths(self) -> set[str]: ...
  @dataclass(frozen=True) class OrphanReport: scanned: int; orphans: tuple[str, ...]; deleted: int; failed: int
  def find_orphan_files(files: Iterable[StoredFile], referenced: Set[str], now: datetime, grace: timedelta = ORPHAN_GRACE) -> list[StoredFile]
  class CleanupOrphanImages:
      def __init__(self, inventory: ImageInventory, reader: ImagePathReader, storage: ImageStorage, clock: Callable[[], datetime]) -> None
      def __call__(self, *, apply: bool = False, grace: timedelta = ORPHAN_GRACE, max_deletions: int = MAX_ORPHAN_DELETIONS) -> OrphanReport
  # adaptadores
  SupabaseImageStorage.list_files(self) -> Iterator[StoredFile]    # POST {base}/storage/v1/object/list/{bucket}; recorre cada carpeta de producto con paginación (limit/offset); ignora entradas sin `id`
  SqlProductRepository.referenced_paths(self) -> set[str]          # todas las storage_path
  ```
  Script: `uv run python -m valmont.scripts.cleanup_orphan_images [--apply] [--grace-hours N] [--max-deletions N]`. Sin `--apply` solo informa. **No** se niega a correr con `ENVIRONMENT=prod` (a diferencia de `seed_dev`: es la herramienta de producción), pero nunca borra sin `--apply`.
- Reglas: (1) primero se listan los archivos y después se leen las rutas de la BD (un archivo subido entre medias es más joven que la gracia); (2) solo cuenta `created_at < now - grace`; (3) si hay más huérfanos que `max_deletions`, **no borra nada** y sale con error (protege contra un fallo de lectura que dé un conjunto vacío); (4) un fallo de Storage en un borrado se cuenta en `failed` y sigue; (5) el informe y los logs solo llevan rutas (UUID, sin datos personales); (6) código de salida ≠ 0 si Storage no responde o se supera el tope.
- Criterios de aceptación: ver pruebas; sin `--apply` no hay ninguna llamada de borrado.
- Pruebas obligatorias (qa-reviewer, `backend/tests/catalog/test_orphan_cleanup.py`; unitarias con fakes y `httpx.MockTransport`; una `integration` con el Storage real del stack local, con `grace=0` para no depender del reloj; puertas habituales): tabla de `find_orphan_files` (referenciado, huérfano viejo, huérfano joven, límite exacto); `dry-run` no borra; `--apply` borra solo los viejos sin fila; tope de borrados; un borrado fallido no detiene el resto; paginación y carpetas del listado; lectura de la BD tras el listado; script (argumentos y código de salida).
- Revisión manual (usuario, Puerta Docker: stack dev ya autorizado): subir una imagen real, borrar su fila a mano (huérfano), ejecutar el comando con y sin `--apply --grace-hours 0`. **El `--apply` contra un entorno que no sea el local lo ejecuta el usuario, no un agente.**
- Seguridad: la clave de servicio solo viaja en `SupabaseImageStorage`; el script no la imprime; usa el rol `valmont_app` (solo `SELECT` sobre `product_images`).
- Estado inicial: READY.
- Entrega: `git add` de los 4 archivos; mensaje `feat(catalog): limpieza de archivos huérfanos de Storage (T-018f)`.
- IDs reservados: ninguno.
- Escalar si: la API de listado de Storage v1.81.0 no devuelve `created_at` por objeto (verificar con el stack real; sin él no hay gracia segura y se detiene).

### T-018g — Copias de seguridad: MENOR de T-103 (BLOCKED)
- Objetivo: (1) `deploy/scripts/restore.sh` compara solo las imágenes con etiqueta del MANIFEST (el aviso de la línea ~177-185 salta con otro nombre de proyecto); (2) `client_min_messages = warning` en el borrado de `--sobrescribir` (línea ~191-200); (3) aviso más prudente si una señal interrumpe el borrado (traps de las líneas ~108-111); (4) la guarda de `TMPDIR` con rutas de Windows (`restore.sh` ~152 y `backup.sh` ~114).
- Responsable: backend-dev (shell) + qa-reviewer · Módulo: deploy · Requisitos: RNF12 · Ficha §C-10 de `docs/deploy.md`.
- Leer: `deploy/scripts/backup.sh`, `deploy/scripts/restore.sh`; `docs/agents/tasks.md` traspaso de T-103 (ronda 3); `docs/deploy.md` §C-10.
- Puede modificar: `deploy/scripts/restore.sh`, `deploy/scripts/backup.sh`. Protegido: `compose.yml`, `Caddyfile`, `supabase/`.
- Pruebas obligatorias: la prueba real repetida de T-103 (copia cifrada, restauración idéntica en un stack nuevo, negativa a repetir, fallo forzado, `--sobrescribir`, negativos del pre-vuelo) más un caso por MENOR; todas las ejecuta qa-reviewer con Docker.
- Estado: **BLOCKED: tocar `deploy/` y crear un stack nuevo con volúmenes exige ficha de auditoría y confirmación del usuario (D-011, acotada por D-034) — decide: usuario.** Cuando se confirme pasa a READY sin más cambios de alcance.
- Entrega y escalado: como el resto; mensaje `fix(deploy): MENOR de la ronda 3 de las copias (T-018g)`. IDs reservados: ninguno.

### T-018h — Despliegue con dominio real (BACKLOG)
- No empieza hasta tener el dominio y T-104 desplegada. Contenido (sin diseñar en detalle: depende de la topología final):
  - Astro: `security.allowedDomains` en `frontend/astro.config.mjs` con el dominio real (ui N-9.2); sin esto, tras Caddy con HTTPS todo POST de `/bff` y `/salir` da 403 por `Origin`. Frontend-lead/frontend-dev; prueba: `npm run check` y una petición real tras Caddy.
  - Caddy: `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`, HSTS con el dominio real; sin `Server` ni `X-Kong-*`; el 502 de `/api/*` con el formato común; `--forwarded-allow-ips` limitado a Caddy si se usa la IP del cliente; access log duplicado y healthchecks fuera de los logs del backend; comentarios desfasados de `compose.yml:99` y `generate-env.sh`.
  - Temporizador de la limpieza de Storage de T-018f (D-H4 B).
  - Nota para esta tarea: el `no-store` y el límite de cuerpo de T-018a ya cubren la API; Caddy conserva su `max_size 6MiB`.
- Todo cambio en `deploy/` exige ficha de auditoría (D-011).

### T-018i — Imágenes de producto: WebP optimizado y sin metadatos (D-047 D-H3, D-048)
- Objetivo: toda imagen que sube el administrador se decodifica con Pillow, se orienta, se acota a 2000 px, se pasa a sRGB y se guarda en Storage como **WebP sin ningún metadato**; el archivo original nunca se guarda. Cierra la fuga de EXIF/GPS y reduce el peso de la ficha.
- Responsable: backend-dev (pruebas: qa-reviewer) · Módulo: catalog · Requisitos: RF06.03, RNF10 · IDs: T-029 (subida), D-019, D-047, D-048
- Leer: `catalog/domain.py` líneas 20-30 y 68-95 (`IMAGE_MAX_BYTES`, `ImageTooLarge`, `UnsupportedImage`, `image_format`); `catalog/application.py` líneas 96-103 (`ImageStorage`) y 330-365 (`AddProductImage`); `catalog/adapters/admin_http.py` líneas 155-175 (`_domain_errors`) y 575-650 (`get_image_storage`, `_IMAGE_ERRORS`, `upload_image`); `scripts/seed_dev.py` líneas 190-205, 255-262 y 290; `tests/catalog/catalog_helpers.py` (`tiny_png`, `InMemoryStorage`); `docs/modules/catalog/SPEC.md` §7 (fila `POST …/images`) y §9; `docs/decisions.md` D-019, D-047, D-048; Pillow por context7 (`/websites/pillow_readthedocs_io_en_stable`: WebP, `ImageOps.exif_transpose`, `Image.thumbnail`, `ImageCms.profileToProfile`, MPO).
- Contratos aplicables: `POST /api/v1/admin/products/{id}/images` (SPEC de catalog §7). Cambio **compatible** (tabla "Contratos"): la respuesta `{id, url, alt}` no cambia de forma (la `url` termina en `.webp`) y se añaden tres códigos 422.
- Dependencias: D-048 (aprobada). Pillow `==13.0.0`. Sin tocar `deploy/` ni el `Dockerfile`.

**Dónde va la conversión.** Puerto `ImageOptimizer` en `application.py` (junto a `ImageStorage`: en este módulo los puertos viven ahí y `domain.py` no tiene ninguno) y adaptador Pillow en `adapters/image_optimizer.py`. `domain.py` y `application.py` **no importan `PIL`**; solo el adaptador y los compositores (`admin_http.py`, `scripts/seed_dev.py`, que ya importan adaptadores). La política (tope de píxeles, lado máximo, errores) es del dominio; los parámetros del codificador (calidad, `method`) son del adaptador.

**Valores elegidos.**

| Parámetro | Valor | Motivo |
|---|---|---|
| Entrada | JPEG, PNG, WebP: `image_format` (firma) y `Image.open(..., formats=("JPEG","PNG","WEBP"))` | D-019; GIF, TIFF, BMP, EPS… → 415 antes de llegar a Pillow |
| Salida | WebP con pérdida, `quality=82`, `method=4`, `alpha_quality=100` | 80-85 comprime sin artefactos visibles en un reloj; `method=6` ahorra ~3 % a costa de ~3× de CPU en una subida síncrona |
| Lado máximo | **2000 px** (`IMAGE_MAX_SIDE`): `thumbnail((2000, 2000), LANCZOS, reducing_gap=2.0)`; reduce, **nunca amplía** | cubre el zoom de la ficha; peso típico 150-400 KiB |
| Píxeles máximos | **25 000 000** (`IMAGE_MAX_PIXELS`, 5000×5000), sobre `im.size` **antes de `load()`** (solo cabecera) | un PNG de 5 MiB puede declarar 10⁹ píxeles. 25 MP en RGBA son 100 MB; con la copia de `exif_transpose` el pico queda en ~200-300 MB. Comprobación propia; **no** se toca `Image.MAX_IMAGE_PIXELS` (global del proceso). Un `Image.DecompressionBombError` de `open` (más de ~178 MP) se trata igual |
| Orientación | `ImageOps.exif_transpose(im)` antes de descartar nada | un JPEG con orientación 6 sale girado y sin la etiqueta |
| Color | con ICC no sRGB: `ImageCms.profileToProfile(…, sRGB)` dentro de `try` (perfil roto → se asume sRGB, no es error); CMYK sin perfil → `convert("RGB")`; sin ICC → sRGB. **El ICC no se escribe** | un Display P3 o AdobeRGB se vería apagado si solo se descartara el perfil (ver R-8) |
| Transparencia | modo con alfa (`RGBA`, `LA`, `PA`) o `"transparency"` en `im.info` → `RGBA`; si no, `RGB` | los recortes PNG sobre fondo transparente se conservan |
| Animadas | PNG (APNG) o WebP animado → **422 `animated_image`**; un GIF, animado o no, ya es 415 por su firma | una foto de producto no se anima; quedarse con el primer fotograma en silencio taparía un error del administrador. **Excepción:** un JPEG de móvil puede abrirse como `MPO` con `n_frames > 1`; el rechazo por animación solo vale si el formato NO es `JPEG`/`MPO`, y de un MPO se usa el primer fotograma (backend-dev lo verifica en la versión instalada) |
| Salida > 5 MiB | `ImageTooLarge` (413 `file_too_large`) | el bucket (D-019) la rechazaría con un 503 engañoso |

**Pillow con datos no confiables.**
1. Puertas previas, en orden: `image_format(data)` (413 por bytes, 415 por firma; **se conserva**, es la puerta barata) → `optimizer.optimize(data)`.
2. En el adaptador: `Image.open(BytesIO(data), formats=…)` → `verify()` → **reabrir** (`verify` inutiliza el objeto) → comprobar formato, `im.size` y animación → `load()`. `ImageFile.LOAD_TRUNCATED_IMAGES` queda en `False`: una imagen truncada es 422.
3. Se capturan `UnidentifiedImageError`, `OSError`, `SyntaxError`, `ValueError`, `EOFError`, `Image.DecompressionBombError` y `ImageCms.PyCMSError` → `InvalidImage` o `ImageDimensionsExceeded`. Ni el mensaje ni el log llevan el texto de Pillow ni los bytes.
4. **La salida solo recibe píxeles:** se copia a una imagen nueva (sin `info`) y `save(buf, "WEBP", quality=…, method=…)` sin `exif=`, `icc_profile=` ni `xmp=`, para que un cambio futuro de Pillow no arrastre metadatos desde `im.info`. No se guarda ningún nombre de archivo.
5. Tiempo y memoria acotados por construcción: entrada ≤ 5 MiB y ≤ 25 MP, salida ≤ 2000 px, `method=4`. La ruta es síncrona (`def`), corre en el pool de hilos sin bloquear el bucle, y la conversión ocurre **antes** de `_lock(product)`: el bloqueo de BD no espera a la CPU. Pillow no ofrece tope de tiempo; solo sube el administrador (R-7).
6. Atajo conocido: sin `Image.draft()` para JPEG; si el pico de memoria importa en producción, se añade sin cambiar el contrato.

**Firmas públicas.**
```python
# modules/catalog/domain.py (añadir)
IMAGE_MAX_PIXELS = 25_000_000
IMAGE_MAX_SIDE = 2000
IMAGE_EXTENSION = "webp"                      # ruta de Storage: <product_id>/<image_id>.webp
class InvalidImage(Exception): ...            # no se pudo decodificar, truncada o corrupta: 422 invalid_image
class ImageDimensionsExceeded(Exception): ... # más de IMAGE_MAX_PIXELS: 422 image_dimensions_exceeded
class AnimatedImage(Exception): ...           # PNG o WebP animado: 422 animated_image
# modules/catalog/application.py (añadir junto a ImageStorage)
@dataclass(frozen=True)
class OptimizedImage: data: bytes; width: int; height: int; content_type: str = "image/webp"
class ImageOptimizer(Protocol):
    def optimize(self, data: bytes) -> OptimizedImage:
        """InvalidImage, ImageDimensionsExceeded o AnimatedImage. La salida no lleva metadatos."""
class AddProductImage:
    def __init__(self, products: ProductRepository, storage: ImageStorage, optimizer: ImageOptimizer) -> None
    def __call__(self, product_id: UUID, data: bytes, alt: str) -> ProductImage   # misma firma
# modules/catalog/adapters/image_optimizer.py (nuevo)
class PillowImageOptimizer:  def optimize(self, data: bytes) -> OptimizedImage
# modules/catalog/adapters/admin_http.py (añadir)
def get_image_optimizer() -> ImageOptimizer          # PillowImageOptimizer(); sin estado
# scripts/seed_dev.py
def seed(session: Session, storage: ImageStorage, optimizer: ImageOptimizer) -> dict[str, int]
```
Flujo de `AddProductImage`: `image_format(data)` → `optimizer.optimize(data)` → si `len(optimized.data) > IMAGE_MAX_BYTES`, `ImageTooLarge` → `_lock` → posición → `storage_path = f"{product_id}/{image_id}.{IMAGE_EXTENSION}"` → `storage.put(path, optimized.data, optimized.content_type)` → `add_image` (con `discard_file` si falla, como hoy). Se sube **solo** `optimized.data`.
`_domain_errors`: `InvalidImage` → `AppError("invalid_image", …, 422)`, `ImageDimensionsExceeded` → `"image_dimensions_exceeded"`, `AnimatedImage` → `"animated_image"`, con mensajes en español. `_IMAGE_ERRORS` documenta los tres 422 (`ErrorOut`). El 413, el 415 y `_BODY_MAX` no cambian.

**Dependencia.** `cd backend && uv add pillow==13.0.0` (solo cambian `pyproject.toml` y `uv.lock`).
- **13.0.0 y no 12.3.0:** publicada el 2026-10-16 (6 semanas); PyPI lista **cero** vulnerabilidades para 13.0.0 y unas 55 para 12.3.0 (todas corregidas en 13.0.0). Pillow procesa datos no confiables: solo vale la última estable. Requiere Python ≥ 3.11 (el proyecto, 3.14).
- **Docker sin cambios:** hay ruedas `cp314` `manylinux_2_27/2_28` para x86_64 y aarch64 (y `win_amd64` para desarrollo) con libwebp, libjpeg, zlib y lcms2 incluidas; `python:3.14.7-slim-trixie` + `uv sync --frozen` las instala sin paquetes del sistema. **No se toca `Dockerfile` ni `deploy/`: sin puerta D-011.** QA lo confirma con `uv sync --frozen --no-dev` y `python -c "from PIL import features; assert features.check('webp') and features.check('littlecms2')"`; el `docker build` lo hará el Leader en la revisión (D-034).
- Licencia HPND (permisiva).

**Contrato y datos existentes.**
- `201 {id, url, alt}` igual; `url` = `<STORAGE_PUBLIC_URL>/storage/v1/object/public/products/<product_id>/<image_id>.webp`; tipo en Storage `image/webp`. No se añaden `width`/`height` al API (no hay columna: exigiría migración); quedan en `OptimizedImage` por si T-140 los necesita.
- **Las imágenes ya subidas no se migran;** solo las nuevas. No hay producción con datos reales (T-018h exige dominio y T-104 desplegada); las de desarrollo son los PNG de la semilla (generados, sin metadatos) y de pruebas. Un script de reconversión sería una tarea aparte (tocaría filas de `product_images`).
- La semilla sube PNG lisos de 400×400: pasan por el optimizador y quedan en `.webp`; `placeholder_png` no cambia; `main()` crea `PillowImageOptimizer()`.

**Coordinación de archivos.**
- Puede modificar: `catalog/domain.py` (solo añadir), `catalog/application.py` (añadir `OptimizedImage` e `ImageOptimizer`; modificar **solo** `AddProductImage`), `catalog/adapters/image_optimizer.py` (nuevo), `catalog/adapters/admin_http.py` (solo `_domain_errors`, `_IMAGE_ERRORS`, `get_image_optimizer`, `upload_image` y su dependencia), `scripts/seed_dev.py` (solo `seed` y `main`), `backend/pyproject.toml`, `backend/uv.lock`; tras el APROBADO de QA, `docs/modules/catalog/SPEC.md` §7 (errores de la fila de `POST …/images`) y §9 (tubería de imágenes).
- Protegido: `ImageStorage` (sin métodos nuevos), `persistence.py`, `adapters/storage.py`, `adapters/http.py`, migraciones, `Dockerfile`, `deploy/`, `frontend/`, `backend/tests/**`.
- Orden: **después de T-018f** (f solo añade bloques en `application.py` y toca `storage.py`, `persistence.py` y `scripts/cleanup_orphan_images.py`, que i no toca; la ruta `<product_id>/<image_id>.<ext>` de f vale con `.webp`). Con T-018d (`catalog/domain.py`) y T-018e (`admin_http.py`) hunks distintos pero integración en serie. **En paralelo con T-018c** sin restricción.
- Escalar si: `ImageCms`, `verify()` o MPO no se comportan como aquí con la versión instalada, o el pico de memoria con 25 MP es excesivo en el stack local: se propone un tope menor, no se improvisa.

- Criterios de aceptación: (1) un JPEG con EXIF GPS y orientación 6 se guarda girado y sin una etiqueta; (2) la salida es `image/webp`, `.webp`, ≤ 2000 px y ≤ 5 MiB; (3) el PNG con transparencia conserva el alfa; (4) corrupta, bomba de píxeles y animada dan 422 con su código y nada llega a Storage ni a la BD; (5) 413 y 415 siguen como hoy; (6) la semilla funciona y `domain.py`/`application.py` no importan `PIL`.
- Pruebas obligatorias (qa-reviewer: `backend/tests/catalog/test_image_optimizer.py` nuevo y casos en `test_application_images.py`, `test_images_http.py`, `test_seed_dev.py`; las imágenes se **generan con Pillow en la prueba**, ninguna foto real; puertas habituales):
  1. JPEG con EXIF (GPS, `Make`, orientación 6, comentario) y XMP/ICC: sale con los lados intercambiados y sin metadatos.
  2. **Ausencia de metadatos, independiente de Pillow:** recorrer los fragmentos RIFF de la salida y exigir que solo existan `VP8X`, `VP8 `, `VP8L` y `ALPH` (ningún `EXIF`, `XMP `, `ICCP`); se aplica a las salidas de 1-4, 8, 9 y 11. Además `getexif()` vacío y sin `icc_profile`/`xmp` en `info` al reabrir.
  3. PNG RGBA: conserva el alfa (un píxel transparente y uno opaco).
  4. WebP ya optimizado (con EXIF añadido): se recodifica sin metadatos, ≤ 5 MiB y ≤ 2000 px (no se exige que sea menor).
  5. Imagen de ~5 MiB exactos: pasa; 5 MiB + 1 byte → 413 `file_too_large` sin llamar al optimizador.
  6. Corrupto (cabecera JPEG válida + basura; PNG truncado): 422 `invalid_image`, sin llamada a Storage.
  7. Bomba de píxeles: PNG de 5000×6000 de un color (pocos KiB) → 422 `image_dimensions_exceeded`, rechazado **sin decodificar** (sin `load()`); 5000×5000 exacto pasa.
  8. GIF animado → 415; APNG animado y WebP animado → 422 `animated_image`; **JPEG MPO de dos imágenes** → aceptado con el primer fotograma.
  9. Grande (4000×3000 con ruido): lado mayor 2000 y proporción conservada; una de 800×600 no se amplía.
  10. Tamaño: JPEG calidad 95, 3000×2000 con degradado y ruido → salida menor que la entrada.
  11. ICC no sRGB (Display P3 o similar): color convertido y sin `ICCP`; un ICC corrupto no rompe (se asume sRGB).
  12. Capas: `domain.py` y `application.py` de catalog sin `import PIL`/`from PIL` (AST); solo `adapters/image_optimizer.py` lo importa (más los dos compositores).
  13. `AddProductImage` con un optimizador falso: se sube `optimized.data` (no el original) con `image/webp` y ruta `.webp`; el original no llega a `storage.put`; un error del optimizador no deja nada en Storage ni en BD; el optimizador corre antes de `_lock`; salida > 5 MiB → `ImageTooLarge`.
  14. HTTP: 201 con `url` `.webp`; los tres 422 con su `code` y la forma común; 413/415 sin cambios; 401/403 como hoy.
  15. Semilla: `seed(...)` con el optimizador real sube `.webp` para los 12 relojes y sigue idempotente; las suites existentes de imágenes solo cambian en lo que cambia (`.png` → `.webp`, `image/png` → `image/webp`, tercer argumento).
  16. Integración (stack local): subir un JPEG con GPS por HTTP real, descargar la URL pública y comprobar `Content-Type: image/webp` y que no hay metadatos.
  17. Dependencia: `features.check('webp')` y `features.check('littlecms2')`; `uv sync --frozen --no-dev` limpio.
- Revisión manual (usuario, stack local autorizado por D-034): subir una foto de móvil con GPS en vertical y un PNG con fondo transparente; abrir la URL pública: vertical, colores correctos, transparencia, `.webp`; `exiftool` o «Propiedades» no muestran ubicación ni cámara.
- Seguridad: el original no se guarda ni se registra; los logs no llevan bytes ni mensajes de Pillow; ningún objeto nuevo del bucket lleva metadatos; solo los formatos permitidos llegan al decodificador; entrada, píxeles y salida acotados. La clave de servicio sigue solo en `SupabaseImageStorage`.
- Estado inicial: **READY**.
- Entrega: `git add backend/src/valmont/modules/catalog/domain.py backend/src/valmont/modules/catalog/application.py backend/src/valmont/modules/catalog/adapters/image_optimizer.py backend/src/valmont/modules/catalog/adapters/admin_http.py backend/src/valmont/scripts/seed_dev.py backend/pyproject.toml backend/uv.lock`; mensaje `feat(catalog): imágenes de producto a WebP optimizado sin metadatos con Pillow (T-018i)`. Las pruebas de QA van en su propio `test(catalog): …`.
- IDs reservados: ninguno (un `fix` de QA usa `T-018i1`).

### T-018q — QA: dos pruebas inestables de payments
- Objetivo: que ninguna de las dos falle de forma intermitente, sin debilitar lo que comprueban. Solo escribe `backend/tests/payments/`; no toca producción.
- Responsable: qa-reviewer · Requisitos: RNF10, RN-11 · IDs: QA de T-138
- Leer: `backend/tests/payments/test_pay_order_http_security.py` (constante `FAKE_CVV = "913"` línea 43 y la prueba de la línea ~285 `test_rejected_card_data_reaches_no_table_audit_or_response`); `backend/tests/payments/test_pay_order_concurrency.py` línea ~386 (`test_a_payment_against_an_overdue_order_being_expired_by_a_read_is_409_and_expired`); `docs/modules/payments/STATUS.md` traspaso de T-138 si existe.
- Causas: (1) busca `'913'` en todo el volcado de tablas, auditoría y respuesta y lo encuentra dentro de un UUID aleatorio; (2) la expiración del pedido vencido depende de la temporización bajo carga.
- Criterios de aceptación: (1) el dato falso no puede coincidir con ningún UUID ni importe generado (por ejemplo, buscar el valor completo de la tarjeta con delimitadores o buscar por campo, y un CVV elegido que además se compruebe ausente de los identificadores recogidos, sin aleatoriedad que pueda coincidir); (2) la prueba usa el reloj inyectado (`Clock`, como en `tests/orders/`) para fijar el instante, sin `sleep` ni márgenes de segundos; ambas siguen detectando la fuga o la expiración si se rompe el código (se comprueba con una mutación manual de una línea).
- Verificación: ejecutar cada una 50 veces seguidas (bucle de shell) sin ningún fallo, y una vez con la máquina cargada (suite completa en paralelo); `pytest -q` y `pytest -m integration -q` completos.
- Protegido: `backend/src/**`. Escalar si la causa 2 exige exponer el reloj en producción (entonces es un `fix` para backend-dev).
- Estado inicial: READY. Entrega: `git add backend/tests/payments/…`; mensaje `test(payments): dos pruebas sin intermitencia (T-018q)`.

## Traspasos
### Traspaso T-018i — 2026-11-27 — backend-dev (IN_REVIEW)
1. Tarea: T-018i (WebP optimizado sin metadatos). 2. Estado: implementado, sin probar (D-033).
3. Archivos: `catalog/domain.py` (solo añadido: 3 constantes y 3 excepciones, tras `IMAGE_MAX_BYTES` y antes de `LastImage`; anotar para el rebase con T-018d), `catalog/application.py` (`OptimizedImage`, `ImageOptimizer`, `AddProductImage`), `catalog/adapters/image_optimizer.py` (nuevo), `catalog/adapters/admin_http.py` (`_domain_errors`, `_IMAGE_ERRORS`, `get_image_optimizer`, `upload_image`), `scripts/seed_dev.py` (`seed`, `main`), `pyproject.toml`, `uv.lock`.
4. Firmas: las del paquete, sin cambios. `AddProductImage` convierte antes de `_lock`; ruta `<product>/<image>.webp`; salida > 5 MiB = `ImageTooLarge`.
5. Dependencia: `pillow==13.0.0` (D-048); `features.check('webp')` y `littlecms2` = True en Windows. Dockerfile y `deploy/` intactos.
6. Riesgos comprobados con un script desechable fuera del repo: MPO (`verify()` + `n_frames=2`) se acepta; `profileToProfile` con RGBA en 13.0.0 funciona (modo RGBA); sin diferencias con el paquete.
7. Observado: JPEG con orientación 6 de 300x100 sale 100x300 WebP; 3000x1000 sale a 2000 px; PNG corrupto y truncado = `InvalidImage`; WebP animado = `AnimatedImage`; PNG 6000x6000 = `ImageDimensionsExceeded`; alfa conservado.
8. Decisión menor: `_to_srgb` solo aplica ICC a RGB/RGBA/CMYK; en L/P/LA se convierte directo (un ICC de grises no cambia el aspecto).
9. Comandos: `uv run ruff format src && uv run ruff check src` -> sin errores; importar `valmont.main` y `valmont.scripts.seed_dev` OK. NO EJECUTADO: pruebas (D-028, D-033).
10. Pendiente de QA: las pruebas existentes que construyen `AddProductImage(repo, storage)` o `seed(session, storage)` deben pasar el optimizador; `InMemoryStorage` esperará `.webp`.
11. Bloqueos: ninguno.
12. Commit: ninguno, preparado. Mensaje: `feat(catalog): imágenes de producto en WebP optimizado sin metadatos (T-018i)`.

### Traspaso T-018f — 2026-11-27 — backend-dev (IN_REVIEW)
1. Tarea: T-018f, solo código (el temporizador es de T-018g/h, `deploy/`, ficha D-011). 2. Estado: implementado, sin probar por QA.
3. Archivos: `modules/catalog/application.py` (solo añadido al final), `adapters/storage.py` (`list_files`), `adapters/persistence.py` (`referenced_paths`), `scripts/cleanup_orphan_images.py` (nuevo). `domain.py`, `ImageStorage`, `admin_http.py`, `main.py` y `tests/**` intactos.
4. Firmas: las del paquete. Añadido: `OrphanLimitExceeded(found, limit)` (excepción de aplicación, la lanza el caso de uso si hay más huérfanos que el tope) y `main(argv) -> int` en el script.
5. Riesgo del paquete verificado con el stack local (Storage v1.81.0, solo `POST …/object/list/products`): cada archivo devuelve `created_at` ISO (`2026-10-27T12:14:20.728Z`) y `id`; las carpetas traen `id: null` y todo `null`. Gracia aplicable. Un archivo sin `id` o sin `created_at` se ignora (nunca se borra sin fecha).
6. Reglas: lista Storage, luego lee la BD; huérfano = sin fila y `created_at < now - grace` (límite exacto = no huérfano); más huérfanos que el tope → `OrphanLimitExceeded`, no borra nada; un borrado fallido suma `failed` y sigue; sin `--apply` no hay llamadas de borrado.
7. Script: `uv run python -m valmont.scripts.cleanup_orphan_images [--apply] [--grace-hours N] [--max-deletions N] [--json]`. Salida: 0 correcto; 1 Storage no responde o algún borrado falló; 2 tope superado. `--json` = una línea `{mode, scanned, orphans, deleted, failed}`. Solo rutas UUID; no imprime la clave.
8. Para la ficha del temporizador (Leader): comando `cd backend && uv run python -m valmont.scripts.cleanup_orphan_images --apply --json`; frecuencia propuesta diaria (p. ej. 03:30), con la gracia de 24 h; usuario: sin privilegios, el mismo del servicio backend; variables (de `backend/.env`): `DATABASE_URL` del rol `valmont_app` (solo SELECT sobre `product_images`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; alerta si el código de salida es ≠ 0.
9. Análisis estático: `uv run ruff format . → 291 files left unchanged`; `uv run ruff check . → All checks passed!`; importar `valmont.main` y el script → OK.
10. Dry-run contra el Storage de desarrollo: `--json → {"mode":"dry-run","scanned":12,"orphans":[],"deleted":0,"failed":0}`, salida 0. `--apply` NO ejecutado.
11. NO EJECUTADO: pruebas (D-028, D-033). Nota: el script exige que `get_image_storage()` devuelva `SupabaseImageStorage` (assert), por si QA lo sustituye.
12. Commits: ninguno — preparado. Rutas: las 4 de código + este STATUS. Mensaje: `feat(catalog): limpieza de imágenes huérfanas de Storage con script en dry-run por defecto (T-018f)`.


### Traspaso backend-dev: T-018d (IN_REVIEW)
1. Tarea: T-018d, rama `t018d` (desde 4643606). 2. Estado: IN_REVIEW.
3. Hecho: nuevo `shared/text.py` con `has_unsafe_chars(text, allow="")` (Cc, Cs, Cf o relleno invisible U+2800, 3164, FFA0, 115F, 1160, 17B4-5, 034F; `allow` exime caracteres) y `has_visible_char(text)` (algun char que no es Z*, C* ni relleno).
4. Sustituidas las 6 copias del filtro Cc/Cs (identity, orders, catalog, inventory, promotions, `TransitionIn._without_controls` en orders/admin_http); mismos codigos y mensajes, mismo recorte; `allow="
"` donde ya estaba (catalog multiline, notas de inventario, `note` de transicion).
5. `has_visible_char` exigido en: identity `clean_text` (full_name, privacy), orders `_text` (recipient_name, department, province, district, address_line), catalog `clean_text` obligatorio, promotions `name`. Mismo mensaje que el de longitud/vacio actual.
6. Sin cambios: filtro `q` de orders/admin_http (Cc/Cs), application, persistence, migraciones, main, tests.
7. Notas: `carrier`/`tracking_code`/`note` de transicion pasan por `has_unsafe_chars` pero no exigen parte visible (no esta en la lista del paquete); la nota de inventario tampoco. Las secuencias emoji con ZWJ (U+200D) quedan rechazadas por diseno del paquete.
8. Estatico: `uv run ruff format src` -> 79 files left unchanged; `uv run ruff check src` -> All checks passed!; importar `valmont.main` -> OK.
9. NO EJECUTADO: pruebas (D-028, D-033).
10. Propuesto: fix(shared): rechazar controles bidireccionales e invisibles en el texto de entrada (T-018d). Preparado (git add), sin commit: shared/text.py + 5 domain.py + orders/adapters/admin_http.py.

### Traspaso backend-dev: T-018c y T-018e (IN_REVIEW)
1. Tareas: T-018c (Idempotency-Key solo UUID) y T-018e (topes en el OpenAPI). Rama `t018ce`, base 93fb4e7.
2. Hecho T-018c: `shared/idempotency.py` (nuevo) con `IDEMPOTENCY_KEY_PATTERN` e `IdempotencyKey` (firma exacta del paquete); orders y payments lo importan y borran su copia (y el import `Header`).
3. Hecho T-018e: `json_schema_extra` con `maxLength`/`maxItems` desde constantes de dominio en catalog (admin, ficha, filtros, `code`/`slug` de ruta), identity (perfil y preferencias), inventory (`note`) y promotions (`name`, `product_ids`). Sin `max_length` real: validación sin cambios.
4. Literales aceptados por el paquete: `phone` 16 y `birth_date` 10 (no hay constante de dominio).
5. Sin tope y sin cubrir (para la lista de excepciones de QA): `file`; `case_diameter_mm` y `case_diameter_mm_min/max` (Decimal: la rama string de `anyOf` no admite el tope a nivel de campo); respuestas (`ErrorBody`).
6. Orders (autorizado por el Leader): `ShippingIn`, `PickupIn` y `status` de `GET /orders` ya declaran topes (literales de `DeliveryDetails`; `maxItems` 8). `orders/adapters/http.py` mezcla T-018c y T-018e: un solo commit o `git add -p`. `admin_http.py` de orders ya tenía topes.
7. Docs pendientes (el paquete no me autoriza): ORDERS-R8 y §7 de orders, R3/E-P5 de payments (formato UUID, ya sin copia duplicada) y la fila de contrato; los actualiza backend-lead.
8. Estático: `uv run ruff format src` → sin cambios; `uv run ruff check src` → All checks passed; `import valmont.main` y `app.openapi()` → OK (la cabecera declara minLength/maxLength 36 y patrón en las dos rutas). NO EJECUTADO: pruebas (D-028, D-033).
9. Aviso: un `ruff format .` inicial pudo tocar `backend/tests/**` de QA (mismo worktree); no los preparé. QA debe verificar sus archivos.
10. Commits: ninguno, preparado. T-018c: `shared/idempotency.py`, `modules/orders/adapters/http.py`, `modules/payments/adapters/http.py`: `feat(orders): Idempotency-Key solo en formato UUID en pedidos y pagos (T-018c)`. T-018e: los 5 archivos del paquete (catalog x2, identity, inventory, promotions): `docs(api): límites de longitud declarados en el OpenAPI (T-018e)`.

### Traspaso T-018a + T-018b — 2026-11-27 — backend-dev (IN_REVIEW)
1. Tareas: T-018a y T-018b, en serie. 2. Estado: implementado, sin probar por QA.
3. Archivos: `shared/hardening.py` (nuevo), `main.py` (import + 3 líneas de middleware), `shared/logs.py`, `shared/auth.py`.
4. Firmas: las del paquete, sin cambios (`BodyLimitMiddleware`, `body_limit_for`, `security_headers_middleware`, `MAX_BODY_BYTES`=256 KiB, `MAX_MULTIPART_BODY_BYTES`=6 MiB, `NO_STORE_PREFIX`; `QUIET_LOGGERS`, `redact_db_detail`, `SafeFormatter`).
5. Decisiones de implementación: el desbordamiento sin `Content-Length` devuelve `http.disconnect` a la app y se sustituye su respuesta por el 413 (flag + `send` protegido; también si la app lanza). `SafeFormatter` recorre `__cause__`/`__context__`/`.orig` y añade `[BD] sqlstate=… constraint=…` leyendo `.diag`. `Key (c)=(v)` pasa a `Key (c)=([omitido])`.
6. Orden de middleware: BodyLimit (interno) < request_id < security_headers (externo).
7. Evidencia (solo estática): `uv run ruff format .` → 283 files left unchanged; `uv run ruff check .` → All checks passed!; importar `valmont.main` → OK; humo ad hoc con TestClient (no es prueba): 413 con `max_bytes=262144`, `X-Request-ID`, `no-store`, `nosniff`; troceado sin Content-Length → 413; `/api/v1/identity/me` → 401 con ambas cabeceras; `/health` solo `nosniff`.
8. NO EJECUTADO: pruebas (D-028, D-033).
9. Para QA: `tests/shared/test_logs.py` hay que actualizar el patrón antiguo de `X-Request-ID`; el caso `integration` del `DETAIL` no se ejercitó con BD real (el atributo `.diag` es el de psycopg).
10. Riesgos: un cuerpo de otro tipo que la app no lee (ruta sin parámetro de cuerpo) con chunked no se cuenta, porque nadie llama a `receive`; Content-Length sí se valida siempre.
11. Sin dependencias, migraciones ni cambios de contrato. Falta anotar el 413 en `modules.md` §4.4 (Leader, al integrar).
12. Commits: ninguno, preparado (`git add` de los 4 archivos). Mensajes: `feat(shared): cabeceras de seguridad y límite de cuerpo (T-018a)` y `fix(shared): logs sin datos sensibles y JWKS no-JSON como 503 (T-018b)`.

### Traspaso del paquete T-018i — 2026-11-27 — backend-lead (READY)
Paquete escrito, sin código. Verificado: PyPI (`pillow` 13.0.0 publicada el 2026-10-16, sin vulnerabilidades listadas; 12.3.0 con unas 55 corregidas en 13.0.0; ruedas `cp314` manylinux x86_64/aarch64 y win_amd64); el flujo actual de subida (`AddProductImage`, `image_format`, `SupabaseImageStorage`, `upload_image`, semilla) y la documentación de Pillow por context7. No se ejecutó nada (D-028, D-033). Valores: WebP `quality=82`, `method=4`, lado máximo 2000 px, 25 MP, tres 422 nuevos. Orden: después de T-018f; en paralelo con T-018c.

### Traspaso del plan T-018 — 2026-11-27 — backend-lead
Plan y paquetes escritos; sin código. Resumen en el traspaso al Leader (respuesta de la tarea). Verificado: se recorrió el OpenAPI actual con `app.openapi()` (43 campos de cuerpo y 8 parámetros sin tope; la lista de T-018e); se leyó `jwt/jwks_client.py` de la versión instalada (el `JSONDecodeError` no se envuelve: hoy da 401); no se ejecutó ninguna prueba (D-028, D-033).

## Discrepancias y riesgos

- **R-1 (código de 413):** entre 5 MiB + 64 KiB y 6 MiB el error es `file_too_large` (catalog) y por encima `payload_too_large` (global). Si el frontend quiere un solo mensaje, que traduzca por estado 413.
- **R-2 (T-018b, residual):** JWKS con JSON válido pero sin claves → 401, no 503 (PyJWT usa la misma excepción que un `kid` desconocido).
- **R-3 (T-018c):** orders y payments tienen pruebas con claves no UUID; el cambio obliga a QA a actualizar fixtures (esfuerzo, no riesgo).
- **R-4 (limitador de frecuencia):** el hardening **no** incluye limitador de tasa (R-4 de payments lo cita junto al cuerpo). Sigue sin tarea; propongo decidirlo con el despliegue (Caddy o capa propia) en T-018h.
- **R-5 (no verificado):** el formato exacto de la respuesta de listado de Storage (T-018f) y que `httpcore` a DEBUG vuelque cabeceras (T-018b, preventivo).
- **R-6 (tasks.md):** la fila de T-018 mezclaba backend, despliegue y QA; se mantiene como paraguas y apunta a este STATUS.
- **R-7 (T-018i):** Pillow no tiene tope propio de CPU ni de memoria; se acotan por entrada (≤ 5 MiB y ≤ 25 MP), por salida (≤ 2000 px) y porque solo sube el administrador. Si se abriera a más actores o el pico de memoria preocupara, se añade `Image.draft()` o un proceso aparte con límites, sin cambiar el contrato. Caso de borde más probable de un falso rechazo: un JPEG de móvil que Pillow abre como `MPO` con varios fotogramas (prueba obligatoria 8).
- **R-8 (T-018i):** la conversión a sRGB ejecuta lcms2 sobre un perfil ICC no confiable (superficie pequeña, acotada por los 5 MiB y por 13.0.0 sin vulnerabilidades conocidas en PyPI a 2026-11-27). Alternativa con cero superficie: descartar el ICC y asumir sRGB (colores apagados con Display P3); lo decide el Leader si lo prefiere.

## Decisiones del usuario (D-047, 2026-11-27)
- D-H1 = A (solo UUID) → **T-018c READY**. D-H2 = A (todos los módulos) → **T-018d READY**. D-H3 = 256 KiB.
- **T-018i (WebP, D-047 D-H3 + D-048 Pillow aprobado, READY):** las imágenes de producto subidas se convierten en el servidor a WebP optimizado (calidad 82, lado máximo 2000 px, sRGB) y **sin ningún metadato** (EXIF, GPS, XMP, IPTC, ICC, comentarios) antes de guardarse en Storage; Pillow `==13.0.0`. Paquete en «T-018i» de este archivo; se integra después de T-018f; las imágenes ya subidas no se migran.
- D-H4 = B: además del script manual (T-018f), un temporizador en `deploy/`; se aplica en T-018g/h con ficha de auditoría y confirmación del usuario (D-011).
- **T-018r (DONE 085b32c, qa-reviewer):** aislamiento de la BD de pruebas. `tests/identity/test_birth_date_migration.py`, `tests/payments/test_migration.py` y el resto de pruebas de migración bajan y suben `valmont_test`; con varias ejecuciones de integración a la vez (agentes en paralelo) provocan `UndefinedColumn`/`UndefinedTable`, `DeadlockDetected` y destinos de downgrade inválidos. Corrección propuesta: las pruebas de migración usan una BD propia creada y borrada por la sesión de pruebas (p. ej. `valmont_test_migrations`), sin tocar la compartida. Incluye: datos sobrantes `lectura-*` que rompen `tests/catalog/test_http_db.py::test_categories_and_attributes_show_only_active_values_by_position`, y la prueba de tiempos comparados de `tests/payments/test_t096_journey_and_attacks.py` (~línea 276), inestable bajo carga.
- **R-8 (decisión del Leader, 2026-11-27):** se mantiene la conversión a sRGB con `ImageCms` (lcms2 incluido en la rueda de Pillow): solo el administrador sube imágenes y la entrada está acotada (5 MiB y 25 MP); un perfil ICC roto se asume sRGB.
- **T-018h (añadidos tras T-018f):** fijar `connect_timeout` en `get_engine()` (con la BD caída el script se cuelga >90 s); el temporizador diario del script de limpieza (ficha D-011); MENOR: un archivo suelto en la raíz del bucket se trataría como candidato (no es el layout `<product_id>/<image_id>.<ext>`).
- **T-018j (DONE, temporizador systemd):** `deploy/systemd/valmont-storage-cleanup.{service,timer}` y `valmont-alert@.service`; se activa en el servidor al desplegar (T-018h). Requisito: `deploy/.env` legible por el usuario del servicio.
- **T-018d, riesgos aceptados (Leader):** ZWJ y ZWNJ se rechazan (afecta a nombres en persa o escrituras índicas y a emojis compuestos); el filtro `q` de inventario es más estricto que el de orders.
