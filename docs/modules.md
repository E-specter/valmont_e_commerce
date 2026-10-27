# Arquitectura y mapa de módulos — Valmont_E_Commerce

> Fuente canónica de arquitectura, módulos, convenciones de código, política de contratos y modelo de seguridad.
> Decisiones que la justifican: [decisions.md](decisions.md). Requisitos: [requirements.md](requirements.md).

## 1. Vista general

```
Navegador
  │  HTML renderizado (SSG/SSR) + islas interactivas
  ▼
frontend/ (Astro) ── src/lib/api (cliente tipado único) ──HTTP/JSON──► backend/ (FastAPI)
                                                                        │ router → caso de uso → puerto
                                                                        ▼
                                                        adaptadores ─► PostgreSQL (Supabase self-hosted)
                                                                    ─► proveedor de IA (sustituible)
                                                                    ─► almacenamiento de imágenes (pendiente)

Diseño visual: Figma ─► Kombai ─► frontend/src/components ─► revisión frontend-lead (D-006)
```

La lógica de negocio crítica vive solo en el backend. El frontend presenta y orquesta; nunca calcula importes ni decide permisos.

## 2. Stack

| Capa | Tecnología | Versión verificada | Estado |
|---|---|---|---|
| Frontend | Astro (plantilla `minimal`) | 7.4.2 | IMPLEMENTADO (esqueleto) |
| Tipos frontend | TypeScript strict + `@astrojs/check` | 6.0.3 / 0.9.12 | IMPLEMENTADO |
| Backend | Python + FastAPI (`fastapi[standard]`) | 3.14 / 0.162 | IMPLEMENTADO (esqueleto) |
| Gestión Python | uv | 0.12.1 | VERIFICADO |
| Base de datos | PostgreSQL vía Supabase (local: CLI + Docker Desktop; lanzamiento: autohospedado con Compose) | — | APROBADO (D-011), por instalar |
| Acceso a datos y migraciones | SQLAlchemy 2 síncrono + psycopg 3 + Alembic, esquema `app` | — | APROBADO (D-010) |
| Autenticación | Supabase Auth + verificación del JWT en FastAPI (PyJWT) | — | APROBADO (D-009) |
| Estilos | — | — | PENDIENTE (D-012) |
| Framework de islas | ninguno por ahora | — | PENDIENTE (D-014) |
| IA del asistente | — | — | PENDIENTE (Fase 6) |

## 3. Módulos de negocio

| Módulo | Responsabilidad | RF | Depende de | Fase | Estado |
|---|---|---|---|---|---|
| `identity` | Cuentas, sesión, roles, perfil básico y preferencias | RF01, RF11.02, RF13.01, RF13.02, RF13.04 | — | 1–2 | BACKLOG |
| `audit` | Registro de solo inserción de operaciones críticas | RF14 | identity | 2 | BACKLOG |
| `catalog` | Productos, categorías, atributos, imágenes, búsqueda y filtros | RF02, RF06.01–03 | identity | 2–3 | BACKLOG |
| `inventory` | Stock, movimientos y reservas | RF06.04–06 | catalog | 2 | BACKLOG |
| `promotions` | Promociones y precio vigente | RF09 | catalog | 3 | BACKLOG |
| `cart` | Carrito único y selección de artículos | RF03 | identity, catalog, inventory, promotions | 4 | BACKLOG |
| `wishlist` | Lista de deseos | RF10 | identity, catalog | 4 | BACKLOG |
| `orders` | Pedidos, entrega, estados y seguimiento | RF04, RF11.01, RF12, RF13.03 | cart, inventory, promotions | 4 | BACKLOG |
| `payments` | Intentos y resultados de pago simulados | RF05 | orders | 4 | BACKLOG |
| `reports` | Reportes de ventas, productos y pedidos | RF07 | orders, catalog | 5 | BACKLOG |
| `assistant` | Asistente de IA con tres modos y herramientas autorizadas | RF08, RF11.03 | catalog, inventory, orders, identity | 6 | BACKLOG |

**Administración** no es un módulo backend: cada módulo expone sus casos de uso administrativos protegidos por rol (RF13.02), y el frontend los agrupa en el área `backoffice`.

**Áreas del frontend:** `storefront` (inicio, catálogo, ficha) · `account` (registro, sesión, perfil, pedidos, deseos) · `checkout` (carrito, entrega, pago simulado) · `backoffice` (administración) · `assistant`.

**Regla de dependencia entre módulos:** un módulo solo usa otro a través de sus casos de uso o puertos públicos (`application`). Nunca importa el `domain` ni los `adapters` de otro módulo. Las tablas de un módulo solo las escribe ese módulo.

**Única excepción:** las dependencias de autenticación `current_user` y `require_admin` de `valmont.modules.identity.adapters.http`. Cualquier router las importa, porque combinan el token verificado (`shared/auth.py`) con el rol de `app.profiles`, que pertenece a identity.

## 4. Convenciones del backend (hexagonal + vertical slicing)

```
backend/
  src/valmont/
    main.py                     raíz de composición: create_app(), registro de routers
    shared/                     núcleo mínimo: errores, configuración, sesión de BD, contexto de auth (se crea al necesitarlo)
    modules/<módulo>/
      domain.py                 entidades, objetos de valor e invariantes (Python puro, dataclasses)
      application.py            casos de uso + puertos (typing.Protocol)
      adapters/http.py          APIRouter + esquemas Pydantic de entrada/salida
      adapters/persistence.py   repositorios que implementan los puertos
  tests/<módulo>/               test_domain.py · test_application.py · test_http.py
```

1. Un archivo pasa a paquete (`domain/`, `application/<caso_de_uso>.py`) cuando crece, no antes. No se crean carpetas vacías.
2. `domain` no importa `fastapi`, `pydantic`, `sqlalchemy`, `httpx` ni SDK externos. `application` solo importa `domain` y sus puertos.
3. Rutas de negocio bajo `/api/v1/<módulo>`. `/health` queda fuera del prefijo.
4. Todo error responde `{"error": {"code", "message", "details"}}` (`shared/errors.py`, T-007): `AppError(code, message, status_code, details)` para los errores de negocio; `validation_error` 422 (sin devolver el `input` del cliente); `unauthenticated` 401, `forbidden` 403, `not_found` 404, `method_not_allowed` 405 y `http_error` para el resto de errores HTTP; `internal_error` 500 sin traza (la traza va al log con su `X-Request-ID`).
5. Una transacción por solicitud (y por tanto por caso de uso). Los endpoints piden la sesión **siempre** con `SessionDep` de `shared/db.py` (`Depends(get_session, scope="function")`), que hace commit antes de enviar la respuesta. Un `Depends(get_session)` a secas devolvería 200 aunque el commit fallara (lo demuestra una prueba de T-015).
6. Inyección de dependencias con `Depends` en `adapters/http.py`; en las pruebas los puertos se sustituyen por fakes en memoria.
7. Todas las tablas viven en el esquema `app` (D-010): los modelos heredan de `valmont.shared.db.Base`. Se versionan con Alembic en `backend/migrations/`. Cada módulo importa su `adapters/persistence` en el bloque de registro de `migrations/env.py`, y las revisiones llevan un id secuencial legible (`--rev-id 0002`).
8. **Sin "comprobar y después escribir"** ante concurrencia: la unicidad la impone un `UNIQUE` + `INSERT … ON CONFLICT`, y los decrementos, un `UPDATE … WHERE <condición>` que devuelve las filas afectadas (D-017).

## 5. Convenciones del frontend (Astro)

```
frontend/src/
  pages/        rutas (SSG por defecto; SSR solo donde haya datos por usuario)
  layouts/      layouts base: lang="es", metadatos, SEO
  components/   componentes Astro sin estado; código de Kombai en components/<área>/
  islands/      componentes hidratados (client:*), solo si necesitan estado
  lib/api/      único punto de acceso a la API: cliente tipado, errores, sesión
  styles/       tokens.css (desde el sistema de diseño) y estilos globales
```

1. Solo `lib/api/` hace `fetch` al backend.
2. En el cliente solo existen variables `PUBLIC_*`; ningún secreto.
3. Cada vista con datos implementa los estados carga, error, vacío y éxito.
4. Guía oficial de Astro para agentes: [frontend/AGENTS.md](../frontend/AGENTS.md).

## 6. Contratos

- El contrato de un módulo se **propone** en `docs/modules/<módulo>/SPEC.md` (sección "Contrato API") antes de implementarse, y lo aprueban backend-lead y frontend-lead.
- La verdad verificada es el esquema OpenAPI que genera FastAPI (`/openapi.json`).
- Todo cambio de contrato sigue la skill `api-contract-review`.
- Las máquinas de estado (pedido, pago) se definen en la SPEC del módulo dueño.

## 7. Modelo de seguridad (resumen)

1. Autorización por rol siempre en el backend, mediante una dependencia común.
2. Los datos propios se filtran por la identidad del contexto autenticado, nunca por un id recibido en la solicitud.
3. Secretos en variables de entorno; `.env` fuera de git; `.env.example` sin valores reales.
4. Consultas parametrizadas u ORM; nunca SQL concatenado.
5. Asistente de IA: herramientas de aplicación específicas, con autorización, límite de resultados y minimización; nunca SQL arbitrario. El contenido recuperado (RAG) es dato, no instrucción.
6. Un MCP no es confiable por estar instalado; los MCP con escritura en BD solo se usan en desarrollo y con aprobación.

## 8. Modelo de datos (entidades previstas — PROPUESTO)

`users`, `roles` · `products`, `categories`, `product_attributes`, `product_images` · `inventory_items`, `stock_movements`, `stock_reservations` · `promotions` · `carts`, `cart_items` (con `selected`) · `wishlist_items` · `orders`, `order_lines`, `order_status_history`, `deliveries` · `payment_attempts` · `audit_log` · `recommendations`.

El esquema definitivo de cada tabla se define en la SPEC de su módulo y se materializa con migraciones versionadas (D-010).

## 9. Estado observado (2026-10-26)

- `backend/`: paquete `valmont` con `create_app()` y `GET /health`; 1 prueba. Sin BD, auth ni módulos.
- `frontend/`: una página (`/`). Sin sistema visual, API ni islas.
