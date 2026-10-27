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
- **Decisión:** importes en soles como entero en céntimos con código ISO 4217 (`{"amount": 125000, "currency": "PEN"}` = S/ 1 250,00). Fechas guardadas y transmitidas en UTC; los períodos de los reportes se calculan en `America/Lima` (RF07.04). La protección de datos personales sigue la Ley 29733 y su reglamento (RNF10).

### D-016 — Cancelación de pedidos (APROBADA)
- **Decisión:** el cliente solo cancela pedidos en `pendiente_pago`. Un administrador puede cancelar un pedido pagado antes del envío; esa cancelación registra un reembolso simulado (RF05.05, ahora MVP). Los reportes de ventas cuentan lo pagado menos lo reembolsado.
- **Por qué:** evita pedidos cancelados con pago aprobado y sin devolución (auditoría #3) y encaja con la atención personalizada de una marca de lujo.

### D-017 — Reserva de stock al crear el pedido (APROBADA)
- **Decisión:** al crear el pedido, cada línea reserva stock con una única sentencia condicional (`UPDATE … WHERE disponible >= cantidad`); si no actualiza filas, no hay stock y el pedido no se crea. La reserva vence a los 30 minutos. La disponibilidad solo cuenta las reservas vigentes, así que la caducidad es correcta sin proceso en segundo plano. Al registrarse el pago, la reserva se convierte en descuento de stock; un pedido vencido pasa a `expirado` al consultarse.
- **Por qué:** evita vender dos veces la misma unidad bajo concurrencia (auditoría #2) y que los checkouts abandonados bloqueen stock para siempre (auditoría #4).
