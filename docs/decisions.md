# Registro de decisiones — Valmont_E_Commerce

> Una entrada por decisión. No se reescriben: si una decisión cambia, se agrega otra que la reemplaza (`Reemplaza a D-xxx`).
> Estados: `PROPUESTA` (requiere aprobación del usuario) · `APROBADA` · `ADOPTADA` (decisión reversible tomada por el Leader dentro de su autoridad) · `REEMPLAZADA`.

| ID | Fecha | Decisión | Estado |
|---|---|---|---|
| D-001 | 2026-10-26 | Reinicio del proyecto desde cero | APROBADA |
| D-002 | 2026-10-26 | `docs/` como fuente de verdad, con la estructura del skill coordinador | APROBADA |
| D-003 | 2026-10-26 | IDs de requisitos estables; no usar `actualizar-requerimientos-rf` | ADOPTADA |
| D-004 | 2026-10-26 | Jerarquía de agentes como subagentes de Claude Code | ADOPTADA |
| D-005 | 2026-10-26 | `AGENTS.md` como instrucciones comunes a todos los agentes | ADOPTADA |
| D-006 | 2026-10-26 | Flujo visual Figma → Kombai → revisión | APROBADA |
| D-007 | 2026-10-26 | Backend: Python 3.14 + uv + FastAPI, paquete `valmont` | ADOPTADA |
| D-008 | 2026-10-26 | Frontend: Astro 7 + npm + TypeScript strict | ADOPTADA |
| D-009 | 2026-10-26 | Supabase Auth + verificación del token en FastAPI | APROBADA |
| D-010 | 2026-10-26 | SQLAlchemy 2 síncrono + psycopg 3 + Alembic, esquema `app` | APROBADA |
| D-011 | 2026-10-26 | Docker Desktop + CLI de Supabase vía npx; lanzamiento portable con Compose | APROBADA |
| D-012 | — | Estrategia de estilos del frontend | PROPUESTA |
| D-013 | 2026-10-26 | Git + commit base, con credenciales fuera del proyecto | APROBADA |
| D-014 | — | Framework para islas interactivas | PROPUESTA |
| D-015 | 2026-10-26 | Perú: PEN en céntimos, America/Lima, Ley 29733 | APROBADA |
| D-016 | 2026-10-26 | Cancelación: cliente solo sin pagar; admin pagados con reembolso simulado | APROBADA |
| D-017 | 2026-10-26 | Reserva de stock de 30 min al crear el pedido | APROBADA |
| D-018 | 2026-10-27 | Verificación de tokens con el JWKS de Supabase (ES256); reemplaza el mecanismo de D-009 | APROBADA |
| D-019 | 2026-10-27 | Imágenes de producto en Supabase Storage, subidas a través del backend | APROBADA |
| D-020 | 2026-10-27 | Atributos de relojería: columnas para filtros + ficha técnica libre | APROBADA |
| D-021 | 2026-10-27 | Catálogo con categorías planas y sin variantes | APROBADA |
| D-022 | 2026-10-27 | Precios guardados con IGV incluido | APROBADA |
| D-023 | 2026-10-27 | Estados de disponibilidad y política de venta por producto (incluye "Bajo pedido") | APROBADA |
| D-024 | 2026-10-27 | Frontend: SSR con `@astrojs/node` para listado, categoría y ficha | APROBADA |
| D-025 | 2026-10-27 | Sesión en cookies con `@supabase/ssr`; el servidor de Astro reenvía el Bearer a FastAPI | APROBADA |
| D-026 | 2026-10-27 | Protocolo de control de versiones: commits atómicos comunicados, paquete de push y push del usuario | APROBADA |
| D-027 | 2026-10-27 | Inventory: umbral de "Últimas unidades" 2 (configurable), un solo almacén y motivos cerrados con nota | APROBADA |
| D-028 | 2026-10-27 | Las pruebas las ejecuta solo qa-reviewer; el Leader hace el commit tras su APROBADO | APROBADA |
| D-029 | 2026-10-27 | Lanzamiento portable (M1): Caddy, frontend en contenedor desde ya y primera prueba en https://localhost | APROBADA |
| D-030 | 2026-10-27 | Copias de seguridad: disco distinto más copia semanal fuera del equipo, cifradas con GPG | APROBADA |

---

### D-001 — Reinicio desde cero
- **Contexto:** la sesión anterior dejó errores: `git init` sin commit inicial, un worktree en rama huérfana y un movimiento de `backend/` bloqueado por un lock de archivos de Windows.
- **Decisión:** se descarta todo lo anterior. Al reiniciar, la raíz solo contenía carpetas vacías de configuración de IA.
- **Consecuencia:** no se arrastra código previo; ver la lección en [setup.md](setup.md#problemas-conocidos).

### D-002 — `docs/` como fuente de verdad
- **Contexto:** el prompt maestro propone `/doc/00-project…07-decisions`; el skill `coordinador-multiagente` y la carpeta existente usan `docs/` con `planning.md`, `modules.md`, `requirements.md`, `setup.md`, `design_ui/`, `skills/` y `agents/`. El usuario pidió respetar la estructura actual.
- **Decisión:** usar `docs/` con la estructura del skill, más `decisions.md`, `prompt_maestro.md` y `modules/<módulo>/` (SPEC y STATUS por módulo). El prompt maestro permite adaptar nombres y granularidad (§9).
- **Alternativas:** `/doc` con 8 subcarpetas (rechazada: duplica la convención del skill y crea archivos vacíos).
- **Consecuencia:** el mapeo del §9 del prompt maestro está en [agents/_registry.md](agents/_registry.md).

### D-003 — Identificadores de requisitos estables
- **Contexto:** el prompt maestro exige identificadores estables; la skill `actualizar-requerimientos-rf` renumera todo el documento y su dominio es un sistema de cobranzas.
- **Decisión:** `RFnn.mm` sin renumeración; las reglas de edición están en la cabecera de [requirements.md](requirements.md).
- **Consecuencia:** esa skill de usuario no se usa en este proyecto.

### D-004 — Jerarquía de agentes en Claude Code
- **Contexto:** se verificó en la documentación oficial que los subagentes (`.claude/agents/*.md`) inician con contexto aislado, reciben skills precargadas (`skills:`) y pueden lanzar subagentes hasta 3 niveles por debajo de la sesión principal.
- **Decisión:** Leader = sesión principal; niveles 2–4 = subagentes `backend-lead`, `frontend-lead`, `module-coordinator`, `backend-dev`, `frontend-dev`; más el auxiliar `qa-reviewer`. Los desarrolladores no pueden delegar.
- **Consecuencia:** el estado compartido vive en `docs/`; ver [agents/PROTOCOL.md](agents/PROTOCOL.md).

### D-005 — `AGENTS.md` como instrucciones comunes
- **Contexto:** Kombai lee el `AGENTS.md` de la raíz como regla de proyecto; Codex y otros agentes también lo leen; Claude Code lee `CLAUDE.md`.
- **Decisión:** `AGENTS.md` es canónico y `CLAUDE.md` lo importa (`@AGENTS.md`) y añade lo específico de Claude Code. Las reglas exclusivas de Kombai van en `.kombai/rules/`.

### D-006 — Flujo visual Figma → Kombai
- **Contexto:** el usuario usará Kombai (extensión de VS Code) conectado a Figma para el diseño visual del frontend.
- **Decisión:** Figma es la fuente visual; Kombai genera los componentes en `frontend/src/components/<área>/`; frontend-lead revisa contra [design_ui/DESIGN.md](design_ui/DESIGN.md) antes de integrarlos. El sistema de diseño de Kombai (`.ds`) se genera desde `DESIGN.md` y se guarda en `.kombai/design-systems/`.
- **Consecuencia:** Kombai no toca `backend/`, `docs/` (salvo `design_ui/`) ni `src/lib/api/`; ver `.kombai/rules/valmont-frontend.md`.

### D-007 — Backend Python 3.14 + uv + FastAPI
- **Contexto:** el sistema tiene Python 3.15.1, pero no hay garantía de ruedas binarias de todas las dependencias para 3.15. `uv` gestiona su propio intérprete.
- **Decisión:** `.python-version = 3.14`, `requires-python >= 3.14`, layout `src/` con paquete `valmont`, `fastapi[standard]`, `pytest` y `ruff` como dependencias de desarrollo.

### D-008 — Frontend Astro 7 + npm
- **Decisión:** plantilla `minimal`, TypeScript `strict`, `@astrojs/check` como verificación de tipos y npm como gestor (pnpm 11 bloquea por defecto los scripts de instalación de dependencias nativas, lo que añade fricción a los agentes).

### D-009 — Supabase Auth + verificación en FastAPI (APROBADA)
- **Decisión:** Supabase Auth gestiona registro, inicio de sesión, confirmación de correo y recuperación (RF01.01–RF01.04). El frontend inicia sesión con supabase-js y envía el access token a FastAPI. FastAPI lo verifica con PyJWT (HS256, `audience="authenticated"`, `exp` y `sub` obligatorios) usando el secreto JWT del entorno.
- **Por qué HS256:** la documentación de la CLI local y del autohospedado no ofrece claves asimétricas ni JWKS (verificado el 2026-10-26). Si llegan, el cambio se limita a `shared/auth.py`.
- **Corregido por D-018 (2026-10-27):** la suposición de HS256 resultó falsa en la prueba de punta a punta: Supabase local (Auth v2.197) firma los tokens de usuario con ES256. El resto de D-009 sigue vigente.
- **Roles:** en `app.profiles` (`customer` | `admin`), leídos en cada solicitud, por lo que se pueden revocar al instante. El perfil se crea al vuelo en la primera solicitud (`INSERT … ON CONFLICT DO NOTHING`), sin triggers en el esquema de Supabase.
- **Alternativa descartada:** auth propia en FastAPI (más código y más superficie de seguridad).

### D-010 — SQLAlchemy 2 + Alembic, esquema `app` (APROBADA)
- **Decisión:** SQLAlchemy 2 síncrono con psycopg 3; el pool de hilos de FastAPI basta para la carga prevista. Migraciones con Alembic en `backend/migrations/` (tabla de versiones en `app`). Todas las tablas en el esquema `app`, que PostgREST no expone (por defecto solo `public`, `storage` y `graphql_public`). Una transacción por solicitud vía la dependencia `get_session`. Pruebas de integración contra la BD `valmont_test`.
- **Alternativas descartadas:** migraciones SQL de la CLI de Supabase (sin autogeneración y atadas a la CLI) y `supabase-py` (sin transacciones entre tablas).

### D-011 — Docker Desktop + CLI de Supabase; lanzamiento portable (APROBADA)
- **Decisión:** en desarrollo, Docker Desktop (WSL2) + CLI de Supabase vía `npx`, con versión fijada en el `package.json` raíz (mismo comando en Windows y en Linux). Para el lanzamiento, Docker Compose con los mismos archivos en Windows 11 o Linux; para producción se recomienda Linux, porque Docker Desktop necesita una sesión iniciada. Pasos en `docs/deploy.md`.
- **Puerta Docker (condición del usuario):** toda acción de Docker (instalar, configurar, arrancar o detener contenedores, borrar volúmenes) la ejecuta el Leader tras mostrar una auditoría (qué hace, qué cambia, riesgos, cómo revertir) y recibir confirmación.
- **Alternativas descartadas:** Docker Engine en WSL2 (más pasos, no documentado por Supabase para Windows) y PostgreSQL nativo (sin Auth ni Studio locales).

### D-012 — Estilos del frontend (PROPUESTA)
- **Opciones:** (a) Tailwind CSS v4 con los tokens como variables CSS; (b) CSS propio con variables y estilos con ámbito de Astro.
- **Nota:** se decide antes del primer componente generado con Kombai, porque define su salida.

### D-013 — Git, commit base y credenciales fuera del proyecto (APROBADA)
- **Contexto:** la carpeta no es un repositorio. Los worktrees de Claude Code necesitan al menos un commit; su ausencia causó el fallo de la sesión anterior. Además, `.claude_session/` (tokens de Claude) estaba dentro del proyecto y la alcanza cualquier herramienta que lo recorra.
- **Decisión:** `git init -b main` + commit base revisado con `git status --ignored`. `.claude_session/` se mueve a `%USERPROFILE%\.claude-valmont` y `CLAUDE_CONFIG_DIR` apunta allí. El trabajo sigue en ramas por tarea; integrar en `main` lo autoriza el usuario.

### D-014 — Framework de islas (PROPUESTA)
- **Opciones:** TypeScript sin framework vs Preact. Se decide con la primera isla real (carrito o asistente); el prompt maestro pide no añadir un framework sin justificación.

### D-015 — País de operación: Perú (APROBADA)
- **Decisión:** importes en soles como entero en céntimos con código ISO 4217 (`{"amount": 125000, "currency": "PEN"}` = S/ 1,250.00 en formato `es-PE`; corregido el 2026-10-27, el ejemplo original decía "S/ 1 250,00"). Fechas guardadas y transmitidas en UTC; los períodos de los reportes se calculan en `America/Lima` (RF07.04). La protección de datos personales sigue la Ley 29733 y su reglamento (RNF10).

### D-016 — Cancelación de pedidos (APROBADA)
- **Decisión:** el cliente solo cancela pedidos en `pendiente_pago`. Un administrador puede cancelar un pedido pagado antes del envío; esa cancelación registra un reembolso simulado (RF05.05, ahora MVP). Los reportes de ventas cuentan lo pagado menos lo reembolsado.
- **Por qué:** evita pedidos cancelados con pago aprobado y sin devolución (auditoría #3) y encaja con la atención personalizada de una marca de lujo.

### D-017 — Reserva de stock al crear el pedido (APROBADA)
- **Decisión:** al crear el pedido, cada línea reserva stock con una única sentencia condicional (`UPDATE … WHERE disponible >= cantidad`); si no actualiza filas, no hay stock y el pedido no se crea. La reserva vence a los 30 minutos. La disponibilidad solo cuenta las reservas vigentes, así que la caducidad es correcta sin proceso en segundo plano. Al registrarse el pago, la reserva se convierte en descuento de stock; un pedido vencido pasa a `expirado` al consultarse.
- **Por qué:** evita vender dos veces la misma unidad bajo concurrencia (auditoría #2) y que los checkouts abandonados bloqueen stock para siempre (auditoría #4).

### D-018 — Verificación de tokens con el JWKS de Supabase (APROBADA; reemplaza el mecanismo de D-009)
- **Contexto:** en la prueba de punta a punta de T-016, un access token real de Supabase local llegó con `alg: ES256`, y la verificación HS256 lo rechazó (401). Supabase recomienda validar contra su JWKS público.
- **Decisión del usuario:** FastAPI descarga y cachea las claves públicas de `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` y valida firma ES256, `aud=authenticated`, `iss` esperado, `exp` y `sub`. Ajustes: `SUPABASE_URL` (dónde el backend alcanza Auth) y `SUPABASE_JWT_ISSUER` opcional (por defecto `<SUPABASE_URL>/auth/v1`; en producción el `iss` público puede diferir de la URL interna de Docker). El backend ya no guarda ningún secreto compartido. Si Auth no responde → 503 `auth_unavailable`; un token inválido → 401 `unauthenticated`.
- **Alternativas descartadas:** preguntar a Auth en cada solicitud (una llamada de red por solicitud) y forzar HS256 (no recomendado por Supabase y sin forma documentada).

### D-019 — Imágenes de producto en Supabase Storage (APROBADA)
- **Decisión del usuario:** un bucket público `products`. El administrador sube desde el backoffice; FastAPI valida (JPEG, PNG o WebP; hasta 5 MB) y sube con la clave de servicio de Supabase, que solo existe en el backend (`SUPABASE_SERVICE_ROLE_KEY`). La URL pública y la ruta se guardan en `app.product_images`. En producción, los archivos viven en el volumen del Supabase autohospedado, con el mismo backup que la BD.
- **Consecuencia:** hay que activar `[storage]` en `supabase/config.toml` (puerta Docker) antes de la tarea de imágenes.
- **Alternativas descartadas:** carpeta en el servidor del backend (backup y escalado aparte) y URLs externas (dependencia de terceros).

### D-020 — Atributos de relojería (APROBADA)
- **Decisión del usuario:** columnas tipadas para los filtros de RF02.03 (tipo de movimiento, material de la caja, diámetro en mm, resistencia al agua en m), con listas de valores que gestiona el administrador (`app.movement_types`, `app.case_materials`), y una ficha técnica libre `specs` (jsonb) que se muestra pero no filtra.
- **Alternativa descartada:** atributos dinámicos tipo EAV (filtros complejos y lentos).

### D-021 — Categorías planas, sin variantes (APROBADA)
- **Decisión del usuario:** cada reloj es un producto con su SKU y su stock; cada producto pertenece a una sola categoría de primer nivel.
- **Alternativas descartadas:** colecciones editoriales y variantes por correa o tamaño (se pueden añadir después sin romper el modelo).

### D-022 — Precio con IGV incluido (APROBADA)
- **Decisión del usuario:** el precio guardado y mostrado es el precio final al consumidor, en céntimos de PEN, con IGV incluido. El desglose del IGV (18 %) solo se calculará cuando haya comprobantes electrónicos (fuera del MVP).

### D-023 — Disponibilidad y política de venta por producto (APROBADA)
- **Decisión del usuario:** el cliente ve cuatro estados: **Disponible**, **Últimas unidades**, **Agotado** y **Bajo pedido** (con su plazo estimado). Cada producto tiene una política de venta configurable: `stock` (solo se vende con stock; sin stock = Agotado), `made_to_order` (siempre Bajo pedido) o `backorder` (con stock se vende normal; al agotarse pasa a Bajo pedido). Los productos bajo pedido llevan `lead_time_days`.
- **Consecuencias:** catalog guarda la política y el plazo (T-026); inventory calcula el estado (T-030), con un umbral de "últimas unidades" por decidir (propuesta: 2); orders crea pedidos bajo pedido sin reserva de stock y con fecha estimada (RF04.07, RN-16). Las condiciones comerciales del bajo pedido (adelanto, cancelación, plazos) se preguntarán en la SPEC de orders.

### D-024 — Renderizado en servidor del catálogo (APROBADA)
- **Decisión del usuario:** listado, categoría y ficha se renderizan en el servidor con `@astrojs/node` (standalone) y caché corta; portada y páginas legales, estáticas. Motivos: filtros y paginación por URL, SEO completo y precio y disponibilidad siempre al día (RN-14).
- **Consecuencias:** nueva dependencia de frontend (`@astrojs/node`); en el hito M1 el frontend corre como contenedor Node.

### D-025 — Sesión en cookies con @supabase/ssr (APROBADA)
- **Decisión del usuario:** la sesión de Supabase viaja en cookies seguras (httpOnly) gestionadas con `@supabase/ssr`. El servidor de Astro lee la sesión y reenvía `Authorization: Bearer` a FastAPI.
- **Consecuencias:** FastAPI no necesita CORS para el sitio; el token no queda expuesto a scripts del navegador; cuenta y carrito se pueden renderizar en el servidor. Requiere D-024.

### D-026 — Protocolo de control de versiones (APROBADA)
- **Petición del usuario (2026-10-27):** cada implementación o aporte atómico completo queda registrado en un commit; los agentes pueden hacer commits, pero siempre se comunican al usuario y se recopilan para que él haga el push.
- **Decisión:** reglas en `docs/agents/PROTOCOL.md` §11 y procedimiento en la skill `version-control`. Un commit por aporte atómico con puertas en verde; formato `<tipo>(<ámbito>): <resumen> (T-NNN)` con trailer `Agent:`; los subagentes hacen commit solo si su paquete dice `Commit: sí` y lo listan en el punto 12 del traspaso; el Leader lo informa al usuario en el mismo turno y prepara el paquete de push desde `git log` (sin listas a mano). Solo el usuario hace push; integrar en `main`, con su autorización.
- **Cumplimiento:** hooks versionados en `.githooks/` (`commit-msg`: formato y `T-NNN`; `pre-commit`: `.env`, secretos literales, JWT y valores en `.env.example`), activos con `git config core.hooksPath .githooks`.
- **Modificada por D-028:** los commits del trabajo delegado los hace el Leader tras el `APROBADO` de qa-reviewer; los subagentes ya no hacen commit.

### D-027 — Inventory: umbral, ubicación y motivos (APROBADA)
- **Decisiones del usuario:** "Últimas unidades" con 2 o menos unidades disponibles, como ajuste global que el admin cambia sin desplegar; un único almacén (las ubicaciones se pueden añadir después sin romper el modelo); motivos de movimiento cerrados (`entrada`, `ajuste_inventario`, `merma`, `devolucion`) con nota obligatoria en ajustes y mermas, más `venta`, que registra el sistema.
- **Refinamiento técnico del Leader:** como las reservas vencen solas (D-017), la reserva atómica bloquea la fila de stock (`FOR UPDATE`), suma las reservas vigentes e inserta la nueva; varias líneas se bloquean ordenadas por producto. Misma garantía sin carreras que pedía D-017 (SPEC de inventory, INVENTORY-R4).

### D-028 — Las pruebas las ejecuta QA (APROBADA)
- **Petición del usuario (2026-10-27):** "Cada pruebas y tests las corren los QA, no los mismos desarrolladores".
- **Qué puede ejecutar quien implementa** (backend-dev, frontend-dev, Kombai u otro agente, por elección del usuario): escribe el código y sus pruebas, pero no las ejecuta.
  - No ejecuta `pytest` (unitarias o de integración), las migraciones reversibles, `alembic check`, `npm run build` ni E2E.
  - Solo puede pasar el análisis estático (`ruff format`, `ruff check`, capas, `npm run check`), que no cuenta como evidencia.
- **Quién verifica:** `qa-reviewer` ejecuta todas las puertas de toda tarea con código y es el único que puede declarar que pasan. Los líderes, el coordinador y el Leader tampoco ejecutan pruebas: se las piden.
- **Commit tras el APROBADO (también elegido por el usuario):**
  1. Quien implementa deja el cambio preparado (`git add`), sin commit, y propone el mensaje.
  2. QA verifica exactamente lo preparado y anota su huella (`git diff --cached | git hash-object --stdin`).
  3. El Leader comprueba que la huella no ha cambiado y hace el commit.

  Esto cambia D-026 en quién hace el commit.
- **Vigencia:** desde 2026-10-27, después del commit `615189d` (ronda 2 de T-042, hecha antes de la regla).
- **Coste asumido:** toda tarea con código pasa por qa-reviewer, y una errata en una prueba cuesta una ronda de QA.
- **Dónde se aplica:**
  - `AGENTS.md` y `CLAUDE.md`.
  - `docs/agents/PROTOCOL.md` §1, §3, §5, §6 y §11.
  - `.claude/agents/*`.
  - Las skills `testing-and-quality-gates`, `version-control`, `context-handoff`, `backend-module-implementation` y `frontend-module-implementation`.

### D-029 — Lanzamiento portable, hito M1 (APROBADA)
- **Decisiones del usuario (2026-10-27):**
  - Proxy inverso **Caddy**: HTTPS automático cuando haya dominio; con `localhost`, su autoridad interna.
  - El **contenedor del frontend** (Astro SSR con `@astrojs/node`, D-024) entra ya en M1, con el esqueleto actual.
  - La primera prueba se hace en este Windows 11 con `https://localhost`. El dominio real se configura después cambiando una variable.
- **Refinamiento técnico del Leader:**
  - Solo Caddy publica puertos (80/443). En la prueba local se enlazan a `127.0.0.1`, así que no se exponen a la red.
  - Supabase autohospedado con los archivos oficiales en una versión fijada y sin los servicios que no se usan (realtime, functions, analytics/vector, y studio en producción).
  - El backend se conecta con el rol `valmont_app`, de privilegios mínimos. Las migraciones corren con el rol propietario.
  - Cada paso de Docker pasa la puerta D-011: ficha de auditoría y confirmación del usuario.
- **Puertos configurables (refinamiento de T-104, a petición del usuario):** Caddy publica `HTTP_PORT` y `HTTPS_PORT`, y Mailpit (solo con el perfil `local`) `MAILPIT_PORT`. Por defecto son 80/443/8025, como pide D-029. La primera prueba corrió en `127.0.0.1:18080/18443/18025`, con `PUBLIC_URL=https://localhost:18443`.
- **Riesgo principal (T-100):** el backend solo acepta tokens ES256 verificados por JWKS (D-018). El Auth autohospedado debe firmar con una clave asimétrica; si la versión oficial no lo permite, se escala antes de tocar D-018.
- **Tareas:** T-100–T-104 (`docs/agents/tasks.md`).

### D-030 — Copias de seguridad cifradas y fuera del equipo (APROBADA)
- **Decisiones del usuario (2026-10-27, RNF12 y Ley 29733):**
  - La copia diaria va a un **disco distinto** del sistema.
  - **Una vez por semana**, una copia sale del equipo: a otro disco guardado en otro sitio o a una carpeta en la nube que sincroniza el usuario.
  - Cada copia va **cifrada con GPG** a la clave pública del responsable. La clave privada se guarda **fuera del servidor** y solo hace falta para restaurar.
- **Refinamiento técnico del Leader:**
  - El cifrado es obligatorio: `backup.sh` falla si no hay destinatario GPG.
  - El texto en claro solo vive en un temporal con permisos 700, que se borra también si el proceso se interrumpe.
  - Cada copia es un único archivo `.gpg`, con su suma SHA-256 del cifrado, para comprobar la integridad sin la clave.
  - GnuPG ya viene con Git para Windows y con Linux, así que no añade dependencias.
  - La subida automática a la nube queda para después del lanzamiento.
- **Refinamientos de la prueba real (T-103, 2026-10-28):**
  - Los datos de Supabase se copian con **lista blanca**: todo `auth` (salvo `schema_migrations`), más `storage.buckets` y `storage.objects`. El rol `postgres` no puede escribir en las tablas vectoriales de Storage, y Valmont no las usa. Si se activan S3, transformaciones o vectores, hay que ampliar la lista.
  - Al restaurar se omiten las ACL de las funciones de `unaccent` en el esquema `extensions`, que son de `supabase_admin`. La ACL de `app.f_unaccent` se conserva.
  - La copia solo se restaura sobre las mismas imágenes de Supabase. El `MANIFEST` las registra y `restore.sh` avisa si difieren.
- **Tareas:** T-103.
