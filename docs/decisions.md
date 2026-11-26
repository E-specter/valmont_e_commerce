# Registro de decisiones — Valmont_E_Commerce

> Una entrada por decisión. No se reescriben: si una decisión cambia, se agrega otra que la reemplaza (`Reemplaza a D-xxx`).
> Estados: `PROPUESTA` (requiere aprobación del usuario) · `APROBADA` · `ADOPTADA` (decisión reversible tomada por el Leader dentro de su autoridad) · `REEMPLAZADA`.

**Plantilla para decisiones importantes (desde D-031):** Contexto · Decisión · Alcance · Fuera de alcance · Limitaciones y riesgos · Requisitos afectados · Casos de uso · Alternativas descartadas · Consecuencias (archivos y tareas) · Reversión. Las decisiones menores pueden usar solo Contexto · Decisión · Consecuencia.

| ID | Fecha | Decisión | Estado |
|---|---|---|---|
| D-001 | 2026-10-26 | Reinicio del proyecto desde cero | APROBADA |
| D-002 | 2026-10-26 | `docs/` como fuente de verdad, con la estructura del skill coordinador | APROBADA |
| D-003 | 2026-10-26 | IDs de requisitos estables; no usar `actualizar-requerimientos-rf` | ADOPTADA |
| D-004 | 2026-10-26 | Jerarquía de agentes como subagentes de Claude Code | ADOPTADA |
| D-005 | 2026-10-26 | `AGENTS.md` como instrucciones comunes a todos los agentes | ADOPTADA |
| D-006 | 2026-10-26 | Flujo visual Figma → Kombai → revisión | REEMPLAZADA por D-031 |
| D-007 | 2026-10-26 | Backend: Python 3.14 + uv + FastAPI, paquete `valmont` | ADOPTADA |
| D-008 | 2026-10-26 | Frontend: Astro 7 + npm + TypeScript strict | ADOPTADA |
| D-009 | 2026-10-26 | Supabase Auth + verificación del token en FastAPI | APROBADA |
| D-010 | 2026-10-26 | SQLAlchemy 2 síncrono + psycopg 3 + Alembic, esquema `app` | APROBADA |
| D-011 | 2026-10-26 | Docker Desktop + CLI de Supabase vía npx; lanzamiento portable con Compose | APROBADA (puerta Docker acotada por D-034) |
| D-012 | — | Estrategia de estilos del frontend | PROPUESTA |
| D-013 | 2026-10-26 | Git + commit base, con credenciales fuera del proyecto | APROBADA (integración en `main`: D-034) |
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
| D-028 | 2026-10-27 | Las pruebas las ejecuta solo qa-reviewer; el Leader hace el commit tras su APROBADO | APROBADA (quién escribe las pruebas: D-033) |
| D-029 | 2026-10-27 | Lanzamiento portable (M1): Caddy, frontend en contenedor desde ya y primera prueba en https://localhost | APROBADA |
| D-030 | 2026-10-27 | Copias de seguridad: disco distinto más copia semanal fuera del equipo, cifradas con GPG | APROBADA |
| D-031 | 2026-11-26 | Figma por MCP reemplaza a Kombai: brief técnico de diseño y marca, inventario de vistas y componentes reutilizables | APROBADA |
| D-032 | 2026-11-26 | Modelos 5.5, esfuerzo por rol y presupuesto de tokens | APROBADA |
| D-033 | 2026-11-26 | Las pruebas las escribe y ejecuta QA; los desarrolladores no escriben pruebas | APROBADA |
| D-034 | 2026-11-26 | Integración en `main` tras el APROBADO de QA y proyecto levantado desde `main` para la revisión manual | APROBADA |
| D-035 | 2026-11-26 | Plugins, skills y MCP oficiales del proyecto declarados en `.claude/` | APROBADA |
| D-036 | 2026-11-26 | Commits y PR sin firma de IA: autoría solo del usuario | APROBADA |

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

### D-031 — Figma por MCP reemplaza a Kombai (APROBADA; reemplaza a D-006)
- **Contexto:** el usuario (2026-11-26) dejó de usar Kombai: el desarrollo visual sale de Figma, al que se accede por su MCP oficial porque ahí está el prototipado completo del proyecto. T-010 seguía bloqueada esperando D-012 y la URL de Figma.
- **Decisión:** Figma es la única fuente visual y se lee con el MCP oficial (plugin `figma@claude-plugins-official` o conector de claude.ai). El flujo es este:
  1. El usuario comparte la URL del archivo o prototipo.
  2. **T-110 (frontend-lead):** con `get_metadata` (estructura) y luego `get_variable_defs`, `get_design_context` y `get_screenshot` de los frames clave, redacta `docs/design_ui/BRIEF.md`, el **brief técnico de diseño y marca**. Cubre tokens (color, tipografía, espaciado, radios, sombras, movimiento), retícula y breakpoints, componentes base con sus variantes y estados, iconografía, tratamiento de imagen, voz y tono, accesibilidad y la correspondencia de cada token con una variable CSS.
  3. **T-111 (frontend-lead):** redacta `docs/design_ui/VIEWS.md`, el **inventario de vistas**. Para cada frame registra: ruta de Astro, layout, componentes reutilizables, datos (endpoint y RF) y estados (carga, vacío, error, éxito). Incluye una matriz de reutilización componente × vista.
  4. Con BRIEF y VIEWS se deciden D-012 (estilos) y D-014 (islas) con evidencia, no por suposición.
  5. **Implementación:** frontend-dev usa la skill `figma:figma-design-to-code` nodo a nodo. Primero los átomos reutilizables en `frontend/src/components/ui/` y después las vistas, que los componen. Un componente nuevo solo se crea si VIEWS no lista uno reutilizable.
- **Alcance:** toda la interfaz (tienda y backoffice): tokens, componentes, layouts y vistas.
- **Fuera de alcance:** Figma no define reglas de negocio, contratos ni datos, que vienen de la SPEC y la API. No se inventan activos de marca oficiales. Code Connect (`figma:figma-code-connect`) solo si el plan de Figma lo permite.
- **Limitaciones y riesgos:**
  - El MCP de Figma exige que el usuario se autentique en la configuración `.claude-valmont` (`/mcp`).
  - Figma limita las llamadas según el plan y el asiento; en los planes básicos el cupo es muy bajo. Por eso cada nodo se consulta **una vez** y su resultado se guarda en BRIEF y VIEWS. Está prohibido volver a consultar lo que ya está documentado.
  - `get_design_context` devuelve código de referencia (React + Tailwind por defecto). Se adapta a Astro y a los tokens; nunca se pega tal cual.
  - Una vista incompleta en el prototipo se registra en VIEWS como `PENDIENTE`; no se inventa.
- **Requisitos afectados:** RNF01, RNF04, RNF07, RF02, RF03, RF04, RF10, RF11; prompt maestro §3.
- **Casos de uso:**
  - CU-D1: crear el brief desde Figma.
  - CU-D2: implementar una vista nueva. Se busca su frame en VIEWS, se reutilizan los componentes listados y solo se crean en `ui/` los que falten.
  - CU-D3: el diseño cambia en Figma. frontend-lead actualiza BRIEF o VIEWS (solo la diferencia) y abre una tarea.
  - CU-D4: revisión visual. Captura de Playwright de la vista frente a `get_screenshot` del frame.
- **Alternativas descartadas:** Kombai (lo descartó el usuario); maquetar desde capturas de pantalla (se pierden los tokens exactos).
- **Consecuencias:**
  - D-006 queda REEMPLAZADA y se elimina `.kombai/`.
  - T-010 pasa a CANCELLED y la sustituyen T-110 y T-111.
  - Se actualizan PROTOCOL §1 y §9, `AGENTS.md`, `CLAUDE.md`, `design_ui/DESIGN.md`, `frontend-lead`, `frontend-dev`, la skill `frontend-module-implementation` y `setup.md` §1 y §5.
- **Reversión:** restaurar `.kombai/` desde el commit anterior a T-108.

### D-032 — Modelos 5.5, esfuerzo por rol y presupuesto de tokens (APROBADA)
- **Contexto:** el usuario (2026-11-26) pidió que el Leader defina modelo, esfuerzo, responsabilidad y especificación de cada agente con modelos 5.5, con eficiencia y calidad, y cuidando el consumo de tokens. T-107 había puesto todos los subagentes en Sonnet 5.5 sin fijar el esfuerzo.
- **Decisión:**

  | Rol | Modelo | Esfuerzo | Motivo |
  |---|---|---|---|
  | Leader (sesión principal) | Opus 5.5 | `high`; `xhigh` solo para decisiones de arquitectura o seguridad | Coherencia global; lo elige el usuario con `/model` |
  | `backend-lead`, `frontend-lead` | Sonnet 5.5 | `high` | Diseño y revisión de contratos |
  | `module-coordinator` | Sonnet 5.5 | `high` | Un error de especificación es el más caro de corregir |
  | `qa-reviewer` | Sonnet 5.5 | `high` | Escribe y ejecuta las pruebas (D-033) y revisa la seguridad |
  | `backend-dev`, `frontend-dev` | Sonnet 5.5 | `medium` | Implementación acotada por un paquete cerrado |
  | `code-simplifier` | Sonnet 5.5 | `medium` | Limpieza de diffs grandes |
  | Búsquedas mecánicas (agente `Explore`) | Haiku 5.5 | `low` | Barridos de archivos sin juicio de diseño |

  - **Única escalada permitida:** la auditoría final de seguridad de orders, payments y assistant (RF04, RF05, RF08) puede lanzarse con `qa-reviewer` en `model: "opus"`, y queda anotado en el traspaso.
- **Presupuesto de tokens (reglas para todo agente):**
  1. Leer `docs/` por ID o por sección (`grep`), nunca entero; `prompt_maestro.md`, solo la sección citada.
  2. Antes de explorar, buscar en claude-mem (`mem-search`); para la documentación de librerías, context7 o el MCP de Astro, no la web.
  3. Delegar solo los paquetes cuyo tamaño justifica arrancar un contexto nuevo. Lo pequeño lo hace quien lo tiene.
  4. Precargar en cada subagente (`skills:`) solo las skills de su rol; el resto se invoca cuando hace falta.
  5. Lo que se obtiene de Figma se guarda en `docs/design_ui/` y no se vuelve a consultar (D-031).
  6. Traspasos de 40 líneas como máximo, con referencias en vez de copias.
  7. Una sola ronda de QA por tarea como objetivo: el paquete llega con criterios verificables.
  8. Orquestaciones masivas (Workflow) solo si el usuario las pide.
  9. Los plugins ajenos al proyecto se desactivan en `.claude/settings.json` (D-035).
- **Alcance:** todos los agentes de Claude Code del proyecto.
- **Fuera de alcance:** el modelo de la sesión principal, que lo elige el usuario.
- **Limitaciones:**
  - `xhigh` y `max` solo existen en Opus.
  - El campo `effort` de la frontmatter necesita una versión reciente de Claude Code; si se ignora, el subagente hereda el esfuerzo de la sesión.
- **Requisitos afectados:** OE06, OE07, prompt maestro §10.7 y §22.
- **Casos de uso:**
  - CU-M1: implementar un paquete con backend-dev (Sonnet, `medium`).
  - CU-M2: especificar un módulo con module-coordinator (Sonnet, `high`).
  - CU-M3: localizar todos los usos de un símbolo con Explore (Haiku, `low`).
  - CU-M4: auditoría de payments con qa-reviewer en Opus.
- **Consecuencias:** frontmatter de `.claude/agents/*.md`, `CLAUDE.md`, PROTOCOL §1 y §8.
- **Reversión:** editar la frontmatter.

### D-033 — Las pruebas las escribe y ejecuta QA (APROBADA; modifica D-028)
- **Contexto:** el usuario (2026-11-26) indicó: "los que hacen el código (los dev), no desarrollan las pruebas, esto lo hacen los auditores (qa)". En D-028, quien implementaba escribía las pruebas.
- **Decisión:** `qa-reviewer` pasa a ser el **auditor QA**. Escribe todas las pruebas (unitarias, integración, contrato, seguridad y E2E con Playwright) a partir de la SPEC y de los criterios de aceptación, y sigue siendo el único que las ejecuta. Los desarrolladores escriben solo código de producción (y las migraciones autorizadas); no crean ni modifican pruebas, `conftest`, *fixtures*, *factories* ni datos de prueba.
- **Flujo por tarea (las pruebas salen de la especificación):**
  1. El paquete está READY, con criterios verificables y el contrato o las firmas públicas cerradas.
  2. QA escribe las pruebas y las prepara con `git add`. Puede ejecutarlas para verlas fallar.
  3. En paralelo, el desarrollador implementa: rutas disjuntas (`src/**` frente a `tests/**`), en la misma copia. Solo pasa el análisis estático y prepara sus cambios.
  4. QA ejecuta todas las puertas sobre lo preparado, anota la huella y da su veredicto.
  5. Si falla por el código, corrige el desarrollador. Si la prueba contradice la SPEC, la corrige QA. Si la SPEC es ambigua, decide el coordinador o el Leader.
  6. El Leader hace un único commit atómico con código y pruebas, e integra (D-034).
- **Alcance:** `backend/tests/**`, `frontend/tests/**`, `frontend/e2e/**` y su configuración.
- **Fuera de alcance:** QA no edita código de producción, migraciones ni `docs/`, salvo su traspaso y el STATUS de la tarea.
- **Limitaciones y riesgos:**
  - Separar autoría y prueba da independencia, a cambio de que una prueba escrita contra detalles internos no encaje. Por eso las pruebas atacan la interfaz pública (casos de uso, puertos, endpoints, DOM accesible), y las firmas van en el paquete.
  - QA recibe `Write` y `Edit`. El protocolo limita sus rutas y el Leader comprueba en el diff que no tocó `src/`.
- **Requisitos afectados:** RNF11, prompt maestro §13.
- **Casos de uso:**
  - CU-Q1: tarea nueva de backend.
  - CU-Q2: error encontrado. QA escribe la prueba que lo reproduce y el desarrollador lo corrige.
  - CU-Q3: flujo E2E con Playwright.
- **Vigencia:** las tareas que empiecen desde el 2026-11-26 (promotions en adelante). QA mantiene también las pruebas existentes.
- **Consecuencias:** `AGENTS.md`, PROTOCOL §1, §3 y §5, los agentes `backend-dev`, `frontend-dev` y `qa-reviewer`, y las skills `testing-and-quality-gates`, `backend-module-implementation`, `frontend-module-implementation` y `version-control`.

### D-034 — Integración en `main` y revisión manual tras cada implementación (APROBADA; modifica D-013 y D-011)
- **Contexto:** el usuario (2026-11-26) pidió: "después de cada implementación, se debe levantar el proyecto en main para la revisión manual", y terminar el MVP lo antes posible. Hasta ahora cada integración en `main` y cada arranque de contenedores requerían su autorización.
- **Decisión:**
  1. **Integración.** Tras el APROBADO de QA y el commit en la rama de la tarea, el Leader integra en `main` con fast-forward. El usuario lo autorizó de forma permanente el 2026-11-26. Si el fast-forward no es posible, la rama de la tarea (local y sin publicar) se rebasa sobre `main` y QA vuelve a verificar.
  2. **Revisión manual.** El Leader ejecuta `scripts/review-up.sh` en la copia de `main`. El script es idempotente: Supabase local, dependencias, migraciones aprobadas, backend y frontend en modo desarrollo. Después le pasa al usuario las URLs y qué revisar (los criterios de aceptación de la tarea). En las integraciones siguientes, los servidores de desarrollo recargan solos.
  3. **Push.** Lo sigue haciendo el usuario, con el paquete de push.
- **Autorización de Docker:** queda autorizado arrancar (`npm run db:start`) y detener conservando los datos (`npm run db:stop`) el stack local de desarrollo. Siguen pasando por la puerta D-011:
  - instalar o actualizar Docker;
  - cambiar la configuración;
  - borrar volúmenes (`supabase stop --no-backup`, `supabase db reset`);
  - todo el stack de `deploy/`.
- **Fuera de alcance:** producción, push y migraciones destructivas, que siguen requiriendo aprobación expresa.
- **Limitaciones y riesgos:**
  - `main` avanza en local sin pull request: la revisión de código es la de QA más el Leader.
  - Un fallo que aparezca en la revisión manual se corrige con una tarea `fix` nueva; `main` no se reescribe.
  - Las migraciones se aplican solas a la BD de desarrollo: solo las aprobadas por QA y reversibles.
  - Los puertos 8000 (backend) y 4321 (frontend) deben estar libres.
- **Casos de uso:**
  - CU-I1: tarea backend integrada → `/docs` de la API listo para probarse.
  - CU-I2: tarea frontend integrada → vista en `http://localhost:4321`.
  - CU-I3: el usuario rechaza la revisión → tarea `fix`.
- **Consecuencias:** PROTOCOL §11.7, `CLAUDE.md`, la skill `version-control`, `setup.md` §3 y `scripts/review-up.sh`.
- **Reversión:** volver a exigir la autorización en PROTOCOL §11.7.

### D-035 — Plugins, skills y MCP oficiales del proyecto (APROBADA)
- **Contexto:** el usuario (2026-11-26) fijó las herramientas: ponytail, find-skills, superpowers, claude-mem, frontend-design, playwright, code-simplifier, context7 y modern-web-guidance, junto con las CLI y los MCP oficiales de cada tecnología. La configuración `.claude-valmont` de las terminales del proyecto solo tenía `frontend-design`, mientras que la de usuario cargaba decenas de skills ajenas al proyecto, con el gasto de tokens que eso supone.
- **Decisión:**
  - **`.claude/settings.json` (versionado):**
    - `extraKnownMarketplaces` con ponytail y thedotmack (claude-mem).
    - Activados en `enabledPlugins`: superpowers, ponytail, claude-mem, frontend-design, playwright, code-simplifier, context7 y figma.
    - Desactivados **solo en este proyecto**: product-management, cowork-plugin-management, design, engineering, code-review, claude-code-setup, skill-creator y github.
  - **Skills de terceros**, instaladas en el proyecto con la CLI oficial `skills`: find-skills (vercel-labs/skills) y modern-web-guidance (GoogleChrome). Se versiona `skills-lock.json`; las carpetas se ignoran en git y se restauran con `npm run skills:install` (solo para Claude Code; `experimental_install` instala para todos los agentes y llena la raíz de carpetas).
  - **`.mcp.json` (versionado):**
    - `astro-docs` (`https://mcp.docs.astro.build/mcp`): solo lectura de la documentación.
    - `supabase-local` (`http://127.0.0.1:54321/mcp`): solo en desarrollo.
  - **MCP de plugin o de la cuenta:** Figma, Playwright y context7.
  - **CLI oficiales:** `uv`, `supabase` (vía `npx`), `astro`, `npm`, `git` y `skills`.
  - **Uso por rol:** la tabla canónica está en `docs/skills/README.md`.
- **Política de uso:**
  - `supabase-local` solo para lectura y diagnóstico (tablas, avisos, logs). El esquema cambia únicamente con Alembic.
  - Instalar una skill nueva (find-skills) requiere la aprobación del Leader.
  - Las skills de terceros se revisan antes de usarse, porque corren con todos los permisos del agente.
- **Limitaciones y riesgos:**
  - Al abrir el proyecto con `.claude-valmont`, Claude Code pide confiar en los marketplaces y en los plugins declarados.
  - Figma y context7 exigen OAuth del usuario.
  - `supabase-local` tiene acceso total a la BD local.
  - Desactivar un plugin aquí no lo desinstala en la cuenta.
- **Requisitos afectados:** OE06, OE07, RNF05.
- **Casos de uso:**
  - CU-T1: API de FastAPI o SQLAlchemy → context7.
  - CU-T2: HTML, CSS o JS → modern-web-guidance, obligatoria.
  - CU-T3: diseño → MCP de Figma.
  - CU-T4: E2E o revisión visual → Playwright.
  - CU-T5: diagnóstico de la BD → `supabase-local`.
  - CU-T6: falta una capacidad → find-skills, con propuesta al Leader.
- **Reversión:** borrar `.claude/settings.json`, `.mcp.json` y `skills-lock.json`.

### D-036 — Commits y PR sin firma de IA (APROBADA; modifica D-026 §formato)
- **Contexto:** el usuario (2026-11-26) asume el 100 % de la responsabilidad del proyecto y pidió quitar la firma de Claude de git: solo debe constar su firma (`Especter <especter.o.a@gmail.com>`).
- **Decisión:** ningún commit ni PR lleva `Co-Authored-By` de Claude o Anthropic, `Claude-Session`, `Agent:` ni "Generated with Claude Code". El autor y quien hace el commit es la identidad de git del usuario.
- **Cómo se garantiza:**
  - `.claude/settings.json`: `attribution` vacío e `includeCoAuthoredBy: false`.
  - El hook `.githooks/commit-msg` rechaza esos trailers.
  - Lo recogen PROTOCOL §11.4 y la skill `version-control`.
- **Alcance:** los commits desde el 2026-11-26.
- **Fuera de alcance:** la historia ya existente no se reescribe. Hacerlo cambiaría todos los hashes y es una operación destructiva que el usuario no ha pedido.
- **Limitación:** la trazabilidad de qué agente hizo qué se mantiene en los traspasos de `docs/` (STATUS y `tasks.md`), no en git.
