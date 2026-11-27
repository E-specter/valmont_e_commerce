# Tablero de tareas

> Escritura aditiva: cada agente agrega o actualiza solo sus filas (skill `coordinador-multiagente` §6).
> Estados y plantillas: [PROTOCOL.md](PROTOCOL.md) §3, §5, §6. Los paquetes de las tareas de módulo viven en `docs/modules/<módulo>/STATUS.md`; los de tareas transversales, abajo.

| ID | Descripción | Rol | Agente | RF / D | Documentos | Estado | Notas de continuidad |
|---|---|---|---|---|---|---|---|
| T-001 | Base documental `docs/` desde cero | docs, arquitectura | claude-leader | OE07 | requirements, modules, planning, setup, decisions | DONE | — |
| T-002 | Protocolo de agentes, subagentes y skills | docs, arquitectura | claude-leader | OE07, D-004 | agents/PROTOCOL.md, skills/README.md | DONE | Validado con T-007: backend-dev cargó sus skills y entregó el traspaso de 11 puntos |
| T-003 | Configuración de Kombai y flujo Figma | ui | claude-leader | D-006 | design_ui/DESIGN.md, `.kombai/rules/` | DONE | Obsoleta: Kombai eliminado en T-108 (D-031) |
| T-004 | Esqueleto backend FastAPI + uv con `/health` | arquitectura | claude-leader | D-007 | modules.md §4, setup.md §3 | DONE | ruff, pytest (1/1) y servidor con `curl` verificados |
| T-005 | Esqueleto frontend Astro 7 | arquitectura | claude-leader | D-008 | modules.md §5, setup.md §3 | DONE | `astro check` 0 errores, build OK |
| T-006 | Supabase local (CLI vía npx + `supabase/config.toml`) | arquitectura | claude-leader | D-011 | setup.md §3 | DONE | 7 contenedores sanos; Postgres 17.11; Auth y Mailpit responden 200; `backend/.env` creado (ignorado) |
| T-007 | Base del backend: configuración por entorno, errores centralizados, logging con id de solicitud | backend | backend-dev (revisa claude-leader) | RNF09, RNF05 | modules.md §4 | DONE | Traspaso abajo; 15 pruebas en verde |
| T-008 | SPEC del módulo `identity` | requisitos, backend | claude-leader | RF01, RF11.02, RF13, D-009 | docs/modules/identity/SPEC.md | IN_REVIEW | Perfil mínimo aprobado por el usuario; falta que el frontend revise el contrato |
| T-009 | SPEC del módulo `catalog` | requisitos | module-coordinator | RF02, RF06.01–03 | requirements.md RF02, RF06 | CANCELLED | Sustituida por T-025 (rango del módulo) |
| T-010 | Sistema de diseño Kombai (`.ds`) y primer componente desde Figma | ui | frontend-lead + Kombai | D-006, D-012 | design_ui/DESIGN.md | CANCELLED | Kombai eliminado (D-031); la sustituyen T-110 y T-111 |
| T-011 | Inicializar git y commit base | — | usuario | D-013 | decisions.md D-013 | CANCELLED | Fusionada en T-012 |
| T-012 | Credenciales fuera del proyecto + `git init` + commit base | — | claude-leader + usuario | D-013 | decisions.md D-013 | DONE | Credenciales en `%USERPROFILE%\.claude-valmont`; commit base `f931a54` en `main`; trabajo en la rama `worktree-fase1-backend-db` |
| T-013 | Documentación al día con D-009…D-017 y correcciones de la auditoría | docs | claude-leader | D-009…D-017 | decisions, requirements, modules, skills | DONE | — |
| T-014 | Instalar Docker Desktop | arquitectura | claude-leader | D-011 | setup.md §1 | DONE | Docker Desktop 29.9.2 + Compose v5.6.1; `hello-world` OK |
| T-015 | Capa de datos: SQLAlchemy + Alembic, esquema `app`, BD de pruebas | backend | backend-dev (revisa claude-leader) | D-010 | modules.md §4 | DONE | Traspaso abajo; 17 pruebas unitarias + 5 de integración |
| T-016 | Autenticación: verificación del JWT, `app.profiles`, `current_user` / `require_admin` | backend, seguridad | backend-dev + qa-reviewer | RF01.05, RF13.01, RF13.02, D-009, D-018 | docs/modules/identity/STATUS.md | DONE | 2 rondas; qa-reviewer APROBADO; E2E con token ES256 real OK |
| T-017 | Ficha de lanzamiento `docs/deploy.md` (Windows 11 / Linux) | docs, arquitectura | claude-leader | D-011 | docs/deploy.md | IN_PROGRESS | Sección A verificada (A-11 parcial hasta la Fase 5); B pendiente de un equipo Linux; C en el hito M1 |
| T-105 | Protocolo de control de versiones: PROTOCOL §11, skill `version-control` y hooks de `.githooks/` (petición del usuario) | docs, arquitectura | claude-leader | D-026 | docs/agents/PROTOCOL.md §11 | DONE | Hooks probados (9/9 casos) y activos con `core.hooksPath` |
| T-106 | Las pruebas las ejecuta solo qa-reviewer, y el Leader hace el commit tras su APROBADO (petición del usuario) | docs, arquitectura | claude-leader | D-028 | docs/agents/PROTOCOL.md §1, §3, §5, §11 | DONE | Rige desde 2026-10-27; la ronda 2 de T-042 (`615189d`) es anterior |
| T-107 | Subagentes con Sonnet 5.5 (`model: sonnet`): eficiencia, eficacia y bajo costo (petición del usuario) | arquitectura | claude-leader | — | `.claude/agents/*.md`, CLAUDE.md | DONE | Rige desde 2026-10-27; la prueba de humo de T-104 ya estaba en marcha con el modelo heredado. Ampliada con el esfuerzo por rol en T-108 (D-032) |
| T-108 | Configuración de Claude: Figma por MCP en lugar de Kombai, modelos y esfuerzo por rol, QA escribe las pruebas, integración en `main` con revisión manual, plugins/skills/MCP y commits sin firma de IA (petición del usuario) | arquitectura, docs | claude-leader (+ subagente de documentación) | D-031…D-036 | decisions.md, PROTOCOL.md, CLAUDE.md, AGENTS.md, `.claude/`, `.mcp.json`, `scripts/review-up.sh` | DONE | `49192b0`, `61de7e5`, `f0a61a9` integrados en `main`. Hook `commit-msg` probado (5/5 casos); `scripts/review-up.sh` verificado desde `main` (API, tienda, Studio y Mailpit responden) |
| T-110 | Brief técnico de diseño y marca desde Figma (`docs/design_ui/BRIEF.md`) | ui | frontend-lead | D-031, RNF01, RNF07 | design_ui/ | DONE | URL: archivo `xRC4mg5JmdqlZ6mbv97kGO` (VALMONT). Base obligatoria: la página `guide_design_brand` (brief existente), que se toma tal cual y se complementa. MCP de Figma autorizado el 2026-11-26 |
| T-111 | Inventario de vistas y matriz de componentes reutilizables (`docs/design_ui/VIEWS.md`); propuestas de D-012 y D-014 con evidencia | ui | frontend-lead | D-031, D-012, D-014 | design_ui/ | DONE | Va en la misma pasada que T-110. Páginas a capturar con estructura y detalle, coherentes con el brief: `landing`, `auth`, `products`, `orders`, `wishlist`, `pay`. No se capturan: `admin`, que tiene otro diseño y una estructura pobre (el backoffice se diseña desde el brief), ni `others`, la página de contacto básica (solo una nota en VIEWS) |
| T-113 | identity: fecha de nacimiento en el perfil y mayoría de edad (18) para comprar; ampliar la SPEC de identity (dónde se exige, migración, contrato de perfil, privacidad) | identity, backend | module-coordinator → backend-dev + qa-reviewer | RF01.07, D-041 (P-8), Ley 29733 | docs/modules/identity/ | BACKLOG | Primero la ampliación de la SPEC; afecta a orders (comprobación al crear el pedido) y a la pantalla de registro |
| T-114 | Guía de revisión manual: qué muestra cada servicio (Studio en el esquema `app`, Mailpit, API con Authorize, tienda esqueleto) y aviso en `review-up.sh` | infra, docs | claude-leader | D-034, D-010 | docs/setup.md | DONE | Origen: el usuario no veía tablas en Studio (esquema `public`). Pendiente aparte: correos de Auth en inglés (plantillas en español, puerta Docker) |
| T-115 | Correos de Supabase Auth en español con la marca Valmont (confirmación, recuperación, enlace mágico, cambio de correo, invitación) | infra, ui | claude-leader | AGENTS.md (idioma), BRIEF §1-§2, D-011 (ficha aprobada por el usuario 2026-11-26) | supabase/templates/ | DONE | Verificado con un registro en Mailpit |
| T-116…T-131 | Pista de frontend: tokens y layouts, componentes `ui/`, cabecera y pie, portada, Nosotros, catálogo, ficha, sesión SSR, ingreso, registro, cuenta e infraestructura de pruebas | ui, frontend | frontend-dev + qa-reviewer (T-130: qa-reviewer) | D-012, D-014, D-024, D-025, D-041, D-042 | docs/modules/ui/STATUS.md | IN_PROGRESS | T-116 (7459771) y T-130 (eaa407b) DONE, QA APROBADO; T-117 DONE (92f6727); T-118 DONE (a280dda); T-120 DONE (d90bbc9); T-119 DONE (4974fb3); T-123 DONE (eff4acc); T-121 DONE (6b54197); T-125 DONE (079de69) y fix T-132 DONE (73f2459); T-122 READY; T-124 en QA; T-131 BLOCKED (T-113); libres T-132…T-139. Ajustes propuestos a T-060, T-069, T-054 y T-081…T-084 en ui/STATUS §7 (los aplica cada tarea al planificarse) |
| T-101 | Rol de BD `valmont_app` con privilegios mínimos (migración 0006) | backend, seguridad | backend-dev + qa-reviewer | D-029, RNF02 | paquete abajo | DONE | `4c6b79e`; APROBADA por qa-reviewer con D-028 (704 + 267, 3 mutantes detectados). Los dos MENOR: uno en la skill de migraciones y otro en T-100 |
| T-102 | Imagen del frontend: `@astrojs/node` 11.1.9 (D-024), `output: 'static'` con adaptador standalone y `frontend/Dockerfile` | frontend, arquitectura | frontend-dev + qa-reviewer | D-024, D-029 | paquete abajo | DONE | `aa0ae5b`; APROBADA por qa-reviewer con D-028. `output: 'static'` confirmado por el Leader (D-024). Sus dos MENOR (`init: true` y `**/.env*`) pasan a T-100 |
| T-100 | Imagen del backend y stack de despliegue `deploy/`: compose, Caddyfile, Supabase autohospedado fijado, `.env.example` y alta de la contraseña de `valmont_app` | backend, arquitectura | backend-dev + qa-reviewer | D-011, D-018, D-029 | paquete abajo | DONE | `666b3db`; APROBADA por qa-reviewer en la ronda 2 (D-028) y probada en ejecución en T-104. `roles.sql` recortado (BLOQUEANTE-1), Caddy solo con h1/h2 y LF en los archivos de Docker. Supabase fijado en el tag `self-hosted/v0.8.3`. ES256 resuelto con `GOTRUE_JWT_KEYS` (Auth v2.197.0); evidencia en el traspaso. Gateway Kong (override oficial, en desuso a favor de Envoy). `CONNECT` no se revoca (decisión en `deploy/scripts/migrate.sh`). Hechos los MENOR de T-101 y T-102 |
| T-103 | Copias de seguridad: `pg_dump` diario y restauración probada (RNF12) | arquitectura | backend-dev + qa-reviewer | D-029, RNF12 | paquete abajo | DONE | `f8f80a1` y `39b8bea`. La prueba real repetida está APROBADA por qa-reviewer: copia cifrada (D-030), restauración idéntica en un stack nuevo, negativa a repetir, fallo forzado, `--sobrescribir`, fallo del borrado y los negativos del pre-vuelo. Ficha §C-10 al día. Los MENOR pasan a T-018 y que el Leader haga el commit. Ver "ronda 3" en el traspaso |
| T-104 | Prueba de lanzamiento en este Windows 11 (`https://localhost`) y sección C de la ficha verificada | arquitectura | claude-leader + qa-reviewer | D-029 | docs/deploy.md §C | DONE | Ficha confirmada por el usuario (con puertos poco comunes). Puertos configurables en `f7f49e5`. Prueba de humo APROBADA por qa-reviewer: 8 servicios en healthy, ES256 de punta a punta, `valmont_app`, subidas por Caddy, búsqueda y auditoría. §C de la ficha al día. Stack detenido con los volúmenes conservados; quedan datos de prueba (usuario `qa-t104@example.test`, producto `QA-T104-001`) y 3 filas de auditoría imborrables en el volumen local |
| T-019 | Ajustes de contrato de identity tras la revisión de frontend-lead: `validation_error.details` sin `url` (solo `loc`, `type`, `msg`) y `Money.currency` obligatorio en el OpenAPI | backend | backend-dev | RF01.06 | docs/modules/identity/SPEC.md §7 | DONE | Hecho con T-027: `Money-Output` exige `amount` y `currency`; `details` = `loc`, `type`, `msg` |
| T-018 | Endurecimiento antes del lanzamiento: limpieza periódica de archivos huérfanos en Storage (T-029); JWKS no-JSON → 503 con aviso; no registrar el `DETAIL` de PostgreSQL (solo `sqlstate` y restricción); rechazar controles bidireccionales y nombres invisibles; límites de longitud documentados en el OpenAPI. Copias (MENOR de T-103):
  - comparar en `restore.sh` solo las imágenes con etiqueta, para que el aviso no salte con otro nombre de proyecto;
  - `client_min_messages = warning` en el borrado de `--sobrescribir`;
  - un aviso más prudente si una señal interrumpe el borrado;
  - la guarda de `TMPDIR` con rutas de Windows.

Despliegue (MENOR de T-104): cabeceras de seguridad en Caddy (`X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`; HSTS con dominio real) sin exponer `Server`/`X-Kong-*`; error 502 de `/api/*` con el formato común; access log duplicado y healthchecks en los logs del backend; comentarios desfasados en `deploy/compose.yml:99` y `generate-env.sh`; `--forwarded-allow-ips` limitado a Caddy si se usa la IP del cliente | backend, seguridad | backend-dev + qa-reviewer | RNF02, RNF10 | docs/modules/identity/STATUS.md | BACKLOG | Hallazgos menores de qa-reviewer en T-016 y T-104; antes de abrir al público |

| T-020 | SPEC de audit | requisitos, backend | claude-leader | RF14 | docs/modules/audit/SPEC.md | DONE | Sin preguntas de negocio bloqueantes |
| T-021 | `app.audit_log` de solo inserción, `AuditRecorder` y `AuditRecorderDep` | backend | backend-dev (revisa claude-leader) | RF14.01, RF14.02 | docs/modules/audit/STATUS.md | DONE | 147 pruebas unitarias + 22 de integración; migración 0003 |
| T-025 | SPEC de catalog | requisitos, backend | claude-leader | RF02, RF06.01–03, RF06.07, D-019…D-023 | docs/modules/catalog/SPEC.md | DONE | Contrato revisado por frontend-lead; cambios incorporados |
| T-026…T-031 | Implementación de catalog | backend | backend-dev (+ qa-reviewer en T-028) | ver STATUS de catalog | docs/modules/catalog/STATUS.md | DONE | T-026…T-031 DONE (T-030: `58fc964`, verificada por qa-reviewer con D-028); queda un MENOR de pruebas para la próxima tarea de catalog |
| T-040 | SPEC de inventory | requisitos, backend | claude-leader | RF06.04–06, D-017, D-023, D-027 | docs/modules/inventory/SPEC.md | DONE | Decisiones del usuario D-027 |
| T-041…T-044 | Implementación de inventory | backend | backend-dev + qa-reviewer | ver STATUS de inventory | docs/modules/inventory/STATUS.md | DONE | T-041…T-044 DONE (última: `08cefce`); verificadas por qa-reviewer con D-028 desde T-042 |
| T-050 | SPEC de promotions | requisitos, backend | module-coordinator (revisa claude-leader) | RF09.01, RF09.02, D-037 | docs/modules/promotions/SPEC.md | DONE | Contrato §7 e hipótesis H-1…H-7 aprobadas por el Leader; T-051 READY |
| T-051…T-054 | Implementación de promotions (esquema y puerto, API de administración, precio vigente en catalog, interfaz) | backend, frontend | backend-dev + qa-reviewer; frontend-dev en T-054 | ver STATUS de promotions | docs/modules/promotions/STATUS.md | IN_PROGRESS | Backend completo (T-051…T-053 DONE). T-054 espera a T-110 y T-111 (Figma). Pendiente menor de QA: pruebas que combinen q o available con filtros de precio |
| T-055 | SPEC de cart | requisitos, backend | module-coordinator (revisa claude-leader) | RF03, D-038 | docs/modules/cart/SPEC.md | DONE | Preguntas resueltas en D-038; excepción (6); T-056 READY |
| T-056…T-060 | Implementación de cart (esquema, lectura, operaciones, puerto para orders, pantalla) | backend, frontend | backend-dev + qa-reviewer; frontend-dev en T-060 | ver STATUS de cart | docs/modules/cart/STATUS.md | IN_PROGRESS | Backend completo (T-056…T-059 DONE). T-060 espera a T-111 (Figma) |
| T-065 | SPEC de wishlist | requisitos, backend | module-coordinator (revisa claude-leader) | RF10, D-039 | docs/modules/wishlist/SPEC.md | DONE | SPEC aprobada (D-039); T-066 READY |
| T-066…T-069 | Implementación de wishlist (esquema y lectura compartida, GET, POST/DELETE, pantalla) | backend, frontend | backend-dev + qa-reviewer; frontend-dev en T-069 | ver STATUS de wishlist | docs/modules/wishlist/STATUS.md | IN_PROGRESS | Backend completo (T-066…T-068 DONE). T-069 espera a T-111 (Figma) |
| T-070 | SPEC de orders | requisitos, backend | module-coordinator (revisa claude-leader) | RF04, RF11.01, RF12, RF13.03, D-040 | docs/modules/orders/SPEC.md | DONE | SPEC aprobada por el Leader (D-040, contrato §7, H-1…H-6); T-071 y T-072 READY |
| T-071…T-084 | Implementación de orders (costuras, dominio, esquema, crear, leer, cancelar, puerto de pago, administración, pantallas) | backend, frontend | backend-dev + qa-reviewer; frontend-dev en T-081…T-084 | ver STATUS de orders | docs/modules/orders/STATUS.md | IN_PROGRESS | T-071 y T-072 DONE (09cda5f), T-073 DONE (3194a85), T-074 DONE (d9682c6), T-075 DONE (ca7a40a), T-076 DONE (780a33e), T-077 DONE (39c503a), T-078 DONE (b31df9e), T-079 DONE (9e98c42), T-080 DONE (dd81602) y fix T-085 DONE (b8a2017), QA APROBADO. **Backend de orders completo y auditado.** Pantallas T-081…T-084 en la pista de frontend. T-085…T-089 libres; pantallas esperan a T-111 |
| T-090 | SPEC y plan de payments | requisitos, backend | module-coordinator (revisa claude-leader) | RF05, RN-08, RN-11, D-016, D-017, D-040, D-041, D-043 | docs/modules/payments/SPEC.md | DONE | SPEC aprobada con D-043 (P-1…P-6) |
| T-091 | Costura de orders: `adapters/wiring.py` (R-13) | backend | backend-dev + qa-reviewer | excepción (7), T-077 | docs/modules/payments/STATUS.md | DONE (ca73b56) | proveedores de orders para payments |
| T-092…T-096 | Implementación de payments (dominio y pasarela simulada, esquema 0011, pagar, consultar, seguridad final con Opus) | backend | backend-dev + qa-reviewer (T-096: qa-reviewer con Opus) | ver STATUS de payments | docs/modules/payments/STATUS.md | IN_PROGRESS | T-092 DONE (2d596a2); T-093 READY; T-099 libre |
| T-097…T-098 | Cliente de API de payments y pantalla de pago (T-082b de la pista ui) | frontend | frontend-dev + qa-reviewer | ver STATUS de payments | docs/modules/payments/STATUS.md | BACKLOG | tras el backend integrado |

**Rangos reservados para la Fase 2** (PROTOCOL §6): audit T-020–T-024 · catalog T-025–T-039 · inventory T-040–T-049 · promotions T-050–T-054 · cart T-055–T-064 · wishlist T-065–T-069 · orders T-070–T-089 · payments T-090–T-099 · hito M1 de lanzamiento T-100–T-104 · ui (pista de frontend) T-116–T-139.

Estados válidos: `BACKLOG` · `SPECIFICATION` · `READY` · `IN_PROGRESS` · `BLOCKED` · `IN_REVIEW` · `INTEGRATION` · `DONE` · `CANCELLED`.

## Paquetes de tareas transversales

### T-103 — Copias de seguridad y restauración probada
- **Objetivo:** una copia diaria del stack desplegado (BD y archivos de Storage) que se puede restaurar en un stack nuevo, siguiendo los pasos de la ficha (RNF12, `docs/deploy.md` C-10).
- **Responsable:** backend-dev (verifica qa-reviewer, acepta claude-leader) · Decisiones: D-011, D-028, D-029 · **Entrega:** preparada sin commit, con el mensaje propuesto (PROTOCOL §11.2).
- **Leer:**
  - `docs/deploy.md` §C;
  - `deploy/compose.yml` (servicios `db` y `storage` y los volúmenes `db-data` y `storage-data`);
  - `deploy/scripts/migrate.sh` (estilo y forma de no imprimir secretos);
  - la guía oficial de Supabase autohospedado sobre copias y restauración, en la misma versión fijada `self-hosted/v0.8.3`.
- **Puede modificar:**
  - `deploy/scripts/backup.sh` y `deploy/scripts/restore.sh` (nuevos, con LF);
  - `.gitignore`, solo para ignorar la carpeta de copias;
  - tu traspaso debajo de este paquete y la fila de T-103.
  - `docs/deploy.md` lo actualiza el Leader.
- **Resultado esperado:**
  1. **`backup.sh`:**
     - Hace un `pg_dump` de la BD `postgres` en formato custom, con lo necesario para restaurar usuarios (`auth`), metadatos de Storage (`storage`) y la app (`app`). Investiga qué recomienda Supabase para el autohospedado: roles del clúster, esquemas gestionados y orden.
     - Archiva los objetos del volumen de Storage.
     - Escribe en `${BACKUP_DIR:-deploy/backups}` con marca de fecha UTC, suma SHA-256 y retención configurable (`BACKUP_KEEP_DAYS`, 14 por defecto).
     - No imprime secretos y sale con un código distinto de 0 si algo falla.
  2. **`restore.sh`:**
     - Restaura en un stack **nuevo o vacío**, comprobando antes la suma.
     - Es destructivo, así que exige un indicador explícito (por ejemplo `--confirmo-restaurar`) y se niega si la BD de destino ya tiene datos de la app, salvo que se fuerce a propósito.
     - Al terminar, deja `valmont_app` y el bucket como `migrate.sh`.
  3. **Programación:** instrucciones para `cron` en Linux y el Programador de tareas en Windows (Git Bash o WSL) en tu traspaso, para que el Leader las pase a la ficha.
- **Criterios:**
  - Revisión estática (`sh -n`, LF, sin secretos, carpeta de copias ignorada).
  - La prueba real la hace el Leader con su ficha Docker y la verifica QA: copia → stack de prueba nuevo con otro nombre de proyecto → restauración. Se comprueba que el usuario de prueba de T-104 inicia sesión, que el producto `QA-T104-001` se lista con su imagen y que `audit_log` conserva sus filas.
- **D-028:** backend-dev solo hace análisis estático y `sh -n`; no ejecuta Docker ni pruebas.
- **Estado inicial:** READY · IDs reservados: ninguno.

#### Traspaso T-103 — 2026-10-27 — backend-dev
1. **Estado final:** IN_REVIEW. Scripts escritos y revisados de forma estática; ninguno se ha ejecutado.
2. **Cambios:**
   - `deploy/scripts/backup.sh` (formato de la ronda 2, D-030): crea en `${BACKUP_DIR:-deploy/backups}` el archivo cifrado `valmont-<AAAAMMDDTHHMMSSZ>.tar.gpg` y `valmont-<marca>.tar.gpg.sha256`. Dentro del tar cifrado van:
     - `db-app.dump`: `pg_dump -Fc -n app -e unaccent` (esquema `app` completo y la extensión que crea la migración 0004);
     - `db-supabase-data.dump`: `pg_dump -Fc --data-only -t 'auth.*' -t storage.buckets -t storage.objects -T auth.schema_migrations` (lista blanca desde la ronda 3);
     - `storage-objects.tar.gz`: el volumen `storage-data` con GNU tar y atributos extendidos;
     - `MANIFEST` (fecha, commit, versión de Postgres, revisión de Alembic) y `SHA256SUMS`.
   - Lo cifrado se escribe en archivos ocultos `.valmont-*.partial` y se renombra al terminar. Valida con `pg_restore -l` y `gzip -t`. Retención con `find -mindepth 1 -mtime +BACKUP_KEEP_DAYS` (14 por defecto) sobre los `.tar.gpg`, sus `.sha256` y los `.partial`, solo tras una copia correcta. Admite `-p proyecto`. `set -eu`, sin pipelines que enmascaren fallos y sin leer ni imprimir secretos (usa el `PGPASSWORD` que ya tiene el contenedor `db`).
   - `deploy/scripts/restore.sh <valmont-MARCA.tar.gpg>`: exige `--confirmo-restaurar`, comprueba el `.sha256` del archivo cifrado, descifra a un temporal 700, comprueba el `SHA256SUMS` interno y se niega si el destino tiene el esquema `app`, usuarios, buckets u objetos, salvo `--sobrescribir`. Después crea `valmont_app` (NOLOGIN, como la migración 0006), restaura `app`, carga los datos de `auth` y `storage` con `SET session_replication_role = replica` en una sola transacción, vuelca los archivos al volumen y ejecuta `migrate.sh` (migraciones pendientes, `LOGIN` y contraseña de `valmont_app`, bucket `products`). Admite `-p proyecto`, que `migrate.sh` hereda por `COMPOSE_PROJECT_NAME`.
   - `.gitignore`: `deploy/backups/`.
   - **Qué incluye la copia y por qué** (fuentes en el punto 4 del apéndice de abajo):
     - `app` completo, porque lo crean las migraciones de Valmont y sus permisos a `valmont_app` forman parte del esquema.
     - `auth` y `storage` solo datos: sus tablas las crean Auth y Storage al arrancar, con sus propietarios. Es lo que hace `supabase db dump`, y la guía de restauración carga los datos con `session_replication_role = replica`.
     - Sin roles: los reservados los crea la imagen y `valmont_app` sale de la migración 0006 más `migrate.sh`. La guía de Supabase advierte de que un `pg_dump` en bruto arrastra internos y da errores de permisos al restaurar.
     - Archivos de Storage aparte: el volcado SQL no los lleva (lo dice la misma guía) y Storage guarda `content-type` y `cache-control` en atributos extendidos `user.supabase.*` (storage-api v1.81.0, `src/storage/backend/file.ts`). Sin ellos sirve todo como `application/octet-stream`. Solo GNU tar los conserva, así que se usa un contenedor Debian de apoyo (`node:26.12.1-trixie-slim`, el tag de `frontend/Dockerfile` y `generate-env.sh`, ya presente tras construir el stack) con `--network none`.
     - Fuera, a propósito: `deploy/.env` (secretos; guardarlo aparte), `caddy-data` (el certificado se vuelve a emitir) y `db-config` (clave raíz de pgsodium; Valmont no usa Vault ni pgsodium, comprobado en las migraciones).
3. **Archivos modificados:** `deploy/scripts/backup.sh` (nuevo), `deploy/scripts/restore.sh` (nuevo; los dos se invocan con `sh`, y en el índice llevan modo 644 como los demás de `deploy/scripts`), `.gitignore`, `docs/agents/tasks.md` (este traspaso y la fila de T-103).
4. **Decisiones tomadas:** ninguna nueva en `docs/decisions.md`. Elecciones de diseño de arriba que el Leader puede elevar a D-nnn: dos volcados en lugar de uno, sin roles, GNU tar en un contenedor de apoyo.
5. **Pruebas ejecutadas → resultado observado (solo análisis estático):**
   - `sh -n deploy/scripts/backup.sh` → sin salida (sintaxis válida)
   - `sh -n deploy/scripts/restore.sh` → sin salida (sintaxis válida)
   - búsqueda de `\r` en los dos scripts → 0 coincidencias (LF)
   - búsqueda de secretos literales entre comillas en los dos scripts → vacía; los scripts no leen valores de `deploy/.env`, solo comprueban que exista
   - `command -v shellcheck` → no instalado
6. **Pruebas no ejecutadas y motivo:** `NO EJECUTADO: scripts, Docker y pruebas (D-028, D-011)`. Ni un solo comando de `docker` ni de los scripts; el stack sigue detenido.
7. **Dependencias pendientes:** la prueba real con su ficha D-011 y su verificación por qa-reviewer. Imagen `node:26.12.1-trixie-slim` presente en el equipo (la usa el build del frontend); si no, `docker run` la descarga.
8. **Riesgos conocidos** (supuestos no comprobados por no poder ejecutar nada):
   - **`postgres` y `session_replication_role`.** La guía oficial lo usa con `postgres`, y `migrate.sh` ya demuestra que `postgres` escribe en `storage.buckets`. Si el `SET` falla con "permission denied", la alternativa es `-U supabase_admin` (superusuario de la imagen, contraseña `POSTGRES_PASSWORD`) en ese único `psql`.
   - **`pg_dump -n app -e unaccent`.** Se apoya en que `-e` y `-n` se suman (la documentación de PostgreSQL no lo dice expresamente). Comprueba con `pg_restore -l db-app.dump`: debe aparecer `EXTENSION - unaccent`. Si falta, `restore.sh` fallaría al crear `app.f_unaccent`.
   - **Acoplamiento a `unaccent`.** Es la única extensión que crean las migraciones (0004). Si una migración futura crea otra, hay que añadir su `-e` en `backup.sh` (hay un comentario `shortcut:` en el código). Detección: la restauración falla en alto.
   - **Destino "vacío".** Se supone que Auth y Storage no insertan filas propias en `auth.*` ni `storage.*` al arrancar (aparte de sus tablas de migraciones, que se excluyen). Si lo hicieran, la carga fallaría por clave duplicada y se revertiría entera.
   - **tar con xattrs.** Ni la imagen de `db` ni la de `storage` garantizan GNU tar (no lo comprobé en ninguna), de ahí el contenedor Debian. Si el sistema de archivos del volumen no admite atributos `user.*`, `tar` falla y el script sale con error. Prueba clave: `Content-Type: image/…` de una imagen restaurada.
   - **`--sobrescribir`** borra `app` con `DROP SCHEMA … CASCADE` (incluida `audit_log`) y hace `TRUNCATE` de `auth` y `storage` (desde la ronda 3, solo de las tablas donde `postgres` tiene ese privilegio, sin `RESTART IDENTITY`). Los archivos que ya hubiera en el volumen no se borran.
   - **Consistencia.** Los dos volcados no comparten instantánea. `app.profiles` no tiene clave foránea a `auth.users` (migración 0002), así que un registro entre ambos volcados solo deja un perfil por crear (se crea en el primer `GET /identity/me`).
   - **`tar` de Storage:** si un archivo cambia mientras se lee (código 1 de GNU tar), reintenta una vez y, si vuelve a fallar, aborta; se prefiere repetir la copia antes que aceptar un archivo a medias.
9. **Preguntas que requieren decisión:** ninguna abierta. El destino en otro disco, la copia semanal fuera del equipo y el cifrado quedaron decididos en D-030; los scripts solo escriben en una ruta local, y la copia semanal fuera del equipo la hace el operador con el `.tar.gpg`.
10. **Documentación actualizada:** solo este archivo. `docs/deploy.md` C-10 lo actualiza el Leader con las instrucciones de programación de abajo.
11. **Siguiente acción recomendada:** el Leader prepara la ficha Docker de la prueba y la ejecuta. Propuesta:
    0. Antes de nada, un llavero temporal para la prueba (la clave privada no debe quedar en el equipo): `export GNUPGHOME=$(mktemp -d)`, `gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key valmont-prueba default default never` e `export BACKUP_GPG_RECIPIENT=valmont-prueba`. Los dos scripts respetan `GNUPGHOME`.
    1. Con el stack original arrancado: `sh deploy/scripts/backup.sh`. Comprobar `valmont-<marca>.tar.gpg` y su `.sha256` (`sha256sum -c`, sin la clave); que no hay texto en claro en `BACKUP_DIR`; y, tras descifrar a mano, `EXTENSION - unaccent` en `pg_restore -l db-app.dump`.
    2. Stack nuevo en paralelo, sin tocar el original, con las mismas variables exportadas para **todos** los comandos siguientes (también `restore.sh`): `HTTP_PORT`, `HTTPS_PORT`, `MAILPIT_PORT` distintos y `PUBLIC_URL=https://localhost:<HTTPS_PORT nuevo>` (el emisor de los tokens usa `PUBLIC_URL`). Luego `docker compose -p valmont-restore -f deploy/compose.yml --profile local up -d --build --wait`. **No** ejecutar `migrate.sh`.
    3. `sh deploy/scripts/restore.sh -p valmont-restore --confirmo-restaurar deploy/backups/valmont-<marca>.tar.gpg`.
    4. Criterios de la tarea: el usuario `qa-t104@example.test` inicia sesión; `QA-T104-001` aparece en el catálogo con su imagen y `Content-Type` correcto; `app.audit_log` conserva sus 3 filas; `valmont_app` con `LOGIN`. Negativos: sin `--confirmo-restaurar` no hace nada; repetir el comando sobre el destino ya restaurado se niega; un byte alterado del `.tar.gpg` lo detiene en la suma, antes de tocar el destino; con otro `GNUPGHOME` sin la clave privada falla al descifrar y no deja nada escrito; sin `BACKUP_GPG_RECIPIENT` o con una clave inexistente, `backup.sh` falla sin llamar a Docker.
    5. Retirar el stack de prueba: `docker compose -p valmont-restore … down -v` (puerta D-011).
12. **Commits:** ninguno — preparado. Rutas preparadas: `deploy/scripts/backup.sh`, `deploy/scripts/restore.sh`, `.gitignore`, `docs/agents/tasks.md`. Mensaje propuesto: `feat(deploy): copias de seguridad y restauración del stack (T-103)`.

#### Traspaso T-103, ronda 2 — 2026-10-27 — backend-dev
Parte de lo preparado en la ronda 1 y de la revisión estática de qa-reviewer (APROBADO con 2 IMPORTANTES). Prevalece sobre los puntos 2, 9 y 11 de arriba en lo que cambia el formato; el resto sigue valiendo.
1. **Estado final:** IN_REVIEW. Nada se ha ejecutado.
2. **D-030 (cifrado GPG obligatorio):**
   - `backup.sh`:
     - Exige `BACKUP_GPG_RECIPIENT`. Comprueba `gpg` y hace un cifrado de prueba con `--trust-model always` (clave pública presente y utilizable) **antes de tocar Docker**. `--trust-model always` se justifica en la cabecera: el operador importa la clave a propósito y compara su huella.
     - Produce un único `valmont-<marca>.tar.gpg` y `valmont-<marca>.tar.gpg.sha256` (suma del cifrado). El texto en claro vive solo en `mktemp -d` (700, en `TMPDIR`), borrado por `trap` en EXIT y en HUP/INT/TERM. En `BACKUP_DIR` solo hay texto cifrado.
     - Retención sobre `valmont-*.tar.gpg`, sus `.sha256` y los `.partial`, con `-mindepth 1` (MENOR-1).
   - `restore.sh`: recibe el `.tar.gpg`; comprueba el `.sha256` primero, descifra con `gpg --decrypt` a un temporal 700 (sin `--batch`, para que gpg pueda pedir la frase de paso), extrae solo los cinco nombres esperados, comprueba el `SHA256SUMS` interno y sigue como antes.
3. **IMPORTANTE-1 (pre-vuelo completo):** en `restore.sh`, todo lo que puede fallar va antes de la primera escritura (el `DROP`/`TRUNCATE` de `--sobrescribir` o, si no, el `CREATE ROLE`):
   - contenedor `db` y volumen de Storage del destino;
   - imagen de apoyo (`docker image inspect … || docker pull -q`);
   - sonda `SET session_replication_role = replica` sin efectos;
   - `show server_version` del destino frente a `postgres=` del MANIFEST;
   - destino vacío;
   - añadido por mí: que `deploy/.env` tenga `POSTGRES_PASSWORD` y `VALMONT_APP_DB_PASSWORD`, porque `migrate.sh` las necesita al final.
4. **IMPORTANTE-2(a):** el `TRUNCATE` de `--sobrescribir` ya no lleva `CASCADE` (queda `RESTART IDENTITY`). El `DROP SCHEMA app CASCADE` se mantiene: es lo que borra `app`.
5. **MENOR aplicados:**
   - **2:** comentario de `backup.sh` corregido (la subida nueva deja archivos huérfanos; un borrado o reemplazo concurrente puede dejar una fila sin archivo).
   - **3:** guarda la salida de `pg_restore -l db-app.dump` y exige `EXTENSION - unaccent` con un `case`, sin tuberías.
   - **4:** un único reintento del tar de Storage si sale con código 1.
   - **7:** `touched=1` antes de la primera escritura; el `trap` de EXIT avisa por stderr "RESTAURACIÓN INCOMPLETA: recrea el stack vacío o repite con --sobrescribir" si la salida es distinta de 0.
   - **8:** los dos scripts comparan la etiqueta `com.docker.compose.project` del contenedor `db` con el proyecto pedido (`-p` o `COMPOSE_PROJECT_NAME`, en minúsculas como lo guarda Compose), abortan si difiere y siempre imprimen el proyecto.
   - **9 (comentario de `restore.sh`):** la copia lleva refresh tokens vigentes y secretos MFA que siguen sirviendo tras restaurar.
   - **5 (`flock`):** no se hace, como indicaste.
6. **Evidencia (solo estático):**
   - `sh -n deploy/scripts/backup.sh` → sin salida
   - `sh -n deploy/scripts/restore.sh` → sin salida
   - búsqueda de `\r` en los dos scripts → 0 coincidencias
   - búsqueda de secretos literales entre comillas en los dos scripts → vacía
   - `CASCADE` en los scripts → solo `DROP SCHEMA app CASCADE` y el comentario que explica su ausencia en el `TRUNCATE`
   - `NO EJECUTADO: scripts, Docker, gpg contra un llavero real y pruebas (D-028, D-011)`
7. **Riesgos nuevos o que cambian:**
   - La prueba real debe usar un llavero temporal (`GNUPGHOME`): propuesta en el punto 11 de arriba, con casos negativos de cifrado.
   - El cifrado de prueba de `backup.sh` falla si la clave no tiene subclave de cifrado utilizable; el mensaje lo dice.
   - `gpg --decrypt` sin `--batch` necesita `gpg-agent` y `pinentry` en una restauración manual con frase de paso. Está pensado para una persona; en el llavero temporal sin frase no pregunta.
   - `kill -9` no ejecuta ningún `trap` y dejaría el temporal en claro en `TMPDIR`. Se documenta en la cabecera de `backup.sh`. La copia en `TMPDIR` necesita sitio para toda la copia sin cifrar.
   - `umask 077` y los permisos 700 no existen en NTFS: en Windows la protección del temporal y de `BACKUP_DIR` depende de las ACL de la carpeta (lo documenta el Leader, MENOR-9).
   - La comprobación del proyecto (MENOR-8) solo puede comparar cuando hay `-p` o `COMPOSE_PROJECT_NAME`; sin ellos imprime el proyecto y no compara.
   - La comparación de versión de Postgres es de igualdad exacta de `show server_version`: un destino con una imagen más nueva se rechaza a propósito.
   - El `docker pull` del pre-vuelo necesita red si la imagen de apoyo no está.
   - El cifrado no firma: quien escriba en el destino de copias y tenga la clave pública podría fabricar una copia. Las sumas detectan corrupción, no autoría. Si importa, añadir `--sign` en una tarea futura.
8. **Commits:** ninguno — preparado. Mismas rutas y mismo mensaje propuesto: `feat(deploy): copias de seguridad y restauración del stack (T-103)`.

#### Traspaso T-103, ronda 3 — 2026-10-27 — backend-dev
Parte de `f8f80a1` (árbol limpio). Aplica tal cual los 3 BLOQUEANTES, el IMPORTANTE y los MENOR que qa-reviewer encontró al ejecutar con Docker. Prevalece sobre las rondas 1 y 2 en lo que las contradice.
1. **Estado final:** IN_REVIEW. Nada se ha ejecutado: ni Docker, ni los scripts, ni `gpg`.
2. **BLOQUEANTE-1** (`restore.sh`): el `pg_restore` de `app` falla por las ACL de `unaccent` (`grant options cannot be granted back to your own grantor`). Ahora vuelca la lista con `pg_restore -l > app.all`, quita las líneas ` ACL extensions ` con `grep -v > app.list` y restaura con `-L app.list`. Tres comandos, sin tuberías. La ACL de `app.f_unaccent` se conserva.
3. **BLOQUEANTE-2** (`backup.sh`): lista blanca `pg_dump -Fc --data-only -t 'auth.*' -t storage.buckets -t storage.objects -T auth.schema_migrations`, con el comentario de por qué (Valmont solo usa `buckets` y `objects`; si eso cambia, ampliar la lista). La comprobación del contenido exige `TABLE DATA auth users`, `storage buckets` y `storage objects`, con un `case`.
4. **BLOQUEANTE-3** (`restore.sh`, `--sobrescribir`):
   - Sin `RESTART IDENTITY`: las secuencias las fija el `setval` de la copia.
   - El `WHERE` del `TRUNCATE` añade `has_table_privilege(format('%I.%I', schemaname, tablename), 'TRUNCATE')`.
   - Siguen en la lista `s3_multipart_*` e `iceberg_*`, por su FK a `buckets`.
5. **IMPORTANTE-1** (`backup.sh`): `git rev-parse --short HEAD` sin `-C` (con `MSYS_NO_PATHCONV=1` fallaba y el `MANIFEST` decía siempre `commit=desconocido`).
6. **MENOR de la ronda 3:**
   - **1:** si falla el propio borrado de `--sobrescribir`, el aviso dice que se revirtió y que el destino no cambió, sin recomendar `--sobrescribir`. Variable `phase=borrado`.
   - **2:** la carga de datos usa `psql -q -o /dev/null`; los errores siguen por stderr.
   - **3:** `backup.sh` guarda en el `MANIFEST` una línea `imagen=` por cada imagen de `docker compose config --images` (solo nombres) y aborta si la lista sale vacía. `restore.sh` compara con las del destino y, si difieren, imprime un aviso con las dos listas y sigue.
7. **MENOR de la ronda 2:**
   - **A:** `backup.sh` escribe primero la suma, con el nombre final dentro, y renombra el `.tar.gpg` el último. Todo `valmont-*.tar.gpg` visible ya tiene su `.sha256`.
   - **B:** tras el `tar -xf`, `restore.sh` exige que los cinco miembros sean archivos regulares y no enlaces simbólicos.
   - **D:** `restore.sh` solo continúa si `used` es `f`; cualquier otro valor cuenta como destino con datos. Se aplica en el rechazo y en la rama del borrado.
   - **E:** `backup.sh` aborta si el temporal cae dentro de `BACKUP_DIR`. Añadí lo mismo en `restore.sh` respecto a la carpeta de la copia, por el mismo motivo.
8. **Evidencia (solo estático):**
   - `sh -n deploy/scripts/backup.sh` → sin salida
   - `sh -n deploy/scripts/restore.sh` → sin salida
   - búsqueda de `\r` en los dos scripts → 0 coincidencias
   - búsqueda de secretos literales entre comillas → vacía
   - `RESTART IDENTITY`, `git -C`, `-n storage` y `= t` → solo en comentarios y en la comprobación `ready` (correcta)
   - `NO EJECUTADO: scripts, Docker, gpg y pruebas (D-028, D-011)`
9. **Riesgos:**
   - La lista blanca deja fuera de la copia cualquier tabla de `storage` que no sea `buckets` u `objects`. Hoy es correcto para `STORAGE_BACKEND=file` sin S3.
   - `has_table_privilege` evita el `permission denied`, pero deja sin vaciar las tablas de vectores. Si algún día tuvieran datos, `--sobrescribir` no los borraría.
   - La comparación de imágenes es textual y usa `docker compose config --images` sin `--profile`: no incluye Mailpit en ninguno de los dos lados.
   - El filtro ` ACL extensions ` depende del formato de `pg_restore -l`. QA lo comprobó con la versión de la imagen de `db`.
10. **Commits:** ninguno — preparado. Mismas rutas y mismo mensaje propuesto que en la ronda 1, o uno de seguimiento si el Leader prefiere un commit aparte: `fix(deploy): corrige la restauración tras la prueba real (T-103)`.

**Apéndice del traspaso de T-103**

1. **Programación en Linux (`cron`).** Como usuario del grupo `docker`, con `crontab -e` (crea antes la carpeta de destino, en un disco distinto del de Docker):
   ```
   # copia diaria a las 03:00; si falla, el aviso sale por stderr y cron lo envía por correo (MAILTO)
   0 3 * * * cd /opt/valmont && BACKUP_GPG_RECIPIENT=copias@ejemplo.pe BACKUP_DIR=/mnt/copias/valmont BACKUP_KEEP_DAYS=14 sh deploy/scripts/backup.sh >> /mnt/copias/valmont/backup.log 2>&1 || echo "La copia de Valmont falló: revisa backup.log" >&2
   ```
   `BACKUP_GPG_RECIPIENT` es obligatorio (D-030) y su clave **pública** debe estar en el llavero del usuario de `cron` (`gpg --import clave-publica.asc`; compara la huella con `gpg --fingerprint`). La privada no debe estar en el servidor. En `crontab` el carácter `%` hay que escribirlo como `\%`; aquí no se usa.
2. **Programación en Windows 11 (Programador de tareas, con Git Bash).** Crea antes la carpeta de destino (por ejemplo `D:\copias-valmont`). Desde un `cmd` o PowerShell, sustituyendo las rutas:
   ```
   schtasks /Create /TN "Valmont copia diaria" /SC DAILY /ST 03:00 /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc \"cd /c/valmont && BACKUP_GPG_RECIPIENT=copias@ejemplo.pe BACKUP_DIR=/d/copias-valmont sh deploy/scripts/backup.sh >> /d/copias-valmont/backup.log 2>&1\""
   ```
   - Importa antes la clave pública con el mismo usuario de Windows, en Git Bash: `gpg --import clave-publica.asc`.
   - Docker Desktop necesita una sesión de usuario iniciada (`docs/deploy.md` §D), así que la tarea debe ser "Ejecutar solo cuando el usuario haya iniciado sesión" (lo habitual con `schtasks` sin `/RU`). Comprueba el último resultado en el Programador (0 = correcto).
   - Con WSL: el programa es `wsl.exe` y los argumentos `-d Ubuntu -- sh -lc "cd /mnt/c/valmont && BACKUP_GPG_RECIPIENT=copias@ejemplo.pe BACKUP_DIR=/mnt/d/copias-valmont sh deploy/scripts/backup.sh >> /mnt/d/copias-valmont/backup.log 2>&1"`, con la integración de WSL de Docker Desktop activada.
3. **Restaurar (resumen para `docs/deploy.md` C-10).** Stack nuevo sin `migrate.sh` → `sh deploy/scripts/restore.sh [-p proyecto] --confirmo-restaurar <valmont-MARCA.tar.gpg>`, con la clave privada en el llavero (puede pedir su frase de paso) y el `.sha256` junto a la copia. Es destructivo y se niega sobre un destino con datos. Guarda aparte `deploy/.env`: no va en la copia. La suma del `.tar.gpg` se comprueba con `sha256sum -c valmont-MARCA.tar.gpg.sha256` desde su carpeta, sin la clave; es lo que conviene hacer también con la copia semanal que sale del equipo. Una restauración probada antes de abrir al público es lo que cierra RNF12.
4. **Fuentes consultadas.**
   - Supabase, "Restore a Platform Project to Self-Hosted" (`supabase.com/docs/guides/self-hosting/restore-from-platform`) y "Restore to a new project" (`…/platform/migrating-within-supabase/backup-restore`): órdenes `supabase db dump` (roles, esquema y datos con `--use-copy --data-only`), restauración con `psql --single-transaction --variable ON_ERROR_STOP=1` y `SET session_replication_role = replica` antes de los datos, el volcado no incluye objetos de Storage ni contraseñas de roles propios, y un `pg_dump` en bruto arrastra internos de Supabase.
   - No existe una guía oficial de copias para el autohospedado en `self-hosted/v0.8.3`: la página `self-hosting/docker` solo cita los directorios de datos al desinstalar, y `docker/README.md` del tag no dice cómo copiarlos. Lo de arriba es una adaptación para un stack nuevo de la misma versión.
   - PostgreSQL 17, `pg_dump`: `-e`, `-n`, `-T`, `--data-only` (incluye valores de secuencias) y `-Fc`.
   - `supabase/storage` v1.81.0, `src/storage/backend/file.ts`: atributos `user.supabase.content-type` y `user.supabase.cache-control`, y valores por defecto `application/octet-stream` y `no-cache` cuando faltan.

### T-100 — Imagen del backend y stack de despliegue `deploy/`
- **Objetivo:** con `docker compose -f deploy/compose.yml up -d` arranca Valmont completo en Windows 11 o Linux: Caddy, frontend, backend y un Supabase autohospedado mínimo. Solo Caddy publica puertos. El usuario confirmó la ficha de archivos de M1 el 2026-10-27; construir y arrancar es T-104, con otra ficha.
- **Responsable:** backend-dev (verifica qa-reviewer, acepta claude-leader) · Decisiones: D-009, D-011, D-018, D-019, D-028, D-029 · **Entrega:** preparada sin commit, con el mensaje propuesto (PROTOCOL §11.2).
- **Leer:**
  - `docs/decisions.md`: D-018 (ES256 por JWKS) y D-029.
  - `docs/deploy.md` §C.
  - `backend/src/valmont/shared/config.py` (variables) y `shared/auth.py` (`supabase_url` para JWKS frente a `supabase_jwt_issuer`).
  - `backend/src/valmont/main.py` (`app`) y `backend/migrations/env.py`.
  - `supabase/config.toml`: bucket `products` público, 5 MiB, jpeg/png/webp; `enable_confirmations`.
  - Los traspasos de T-101 y T-102, en este archivo.
  - Los archivos oficiales de Supabase autohospedado (`supabase/supabase`, carpeta `docker/`) en una versión fijada.
- **Puede modificar:**
  - `backend/Dockerfile` y `backend/.dockerignore` (nuevos);
  - `deploy/**` (nuevo);
  - `frontend/.dockerignore`, solo el MENOR-2 de T-102;
  - `backend/tests/test_app_role.py`, solo el MENOR-1 de T-101;
  - tu traspaso debajo de este paquete y la fila de T-100.
  - `docs/deploy.md` no: la completa el Leader en T-104.
- **Resultado esperado:**
  1. **`backend/Dockerfile` multietapa.**
     - `uv` copiado de `ghcr.io/astral-sh/uv` con etiqueta exacta (la local es 0.12.1) y `python:3.14.x-slim` también exacta.
     - `uv sync --frozen --no-dev` y usuario no root.
     - `HEALTHCHECK` con Python (`urllib`) a `/health`.
     - Arranque de producción, por ejemplo `fastapi run src/valmont/main.py --host 0.0.0.0 --port 8000 --proxy-headers`.
     - La imagen incluye `alembic` y `migrations/`, para poder migrar con `docker compose run --rm`. Las migraciones usan la URL del rol **propietario**, que se pasa solo en ese comando; el servicio usa la de `valmont_app`.
     - `backend/.dockerignore` con `**/.env*`, `.venv`, cachés y pruebas.
  2. **`deploy/supabase/`.** Los archivos oficiales en un tag o commit fijado (anota la URL y la versión), con **solo** los servicios necesarios:
     - `db`, `auth` y `kong`;
     - `storage`, y lo que `storage` requiera (`rest`, `imgproxy`), justificado;
     - fuera: studio, realtime, functions, analytics, vector y supavisor. Quita las dependencias que apunten a ellos.
  3. **Riesgo principal (D-018).** El Auth autohospedado debe firmar los access tokens con **ES256** y publicar `/auth/v1/.well-known/jwks.json`.
     - Investiga la configuración de GoTrue en la versión fijada (claves asimétricas o JWKS) y cómo se generan las claves.
     - Si no es posible, devuelve **BLOCKED** con lo que encontraste. No cambies `shared/auth.py` ni D-018.
  4. **`deploy/compose.yml`**, con proyecto `valmont`.
     - `caddy` en imagen exacta. Es el único con `ports`: `${BIND_ADDRESS:-127.0.0.1}:80` y `:443`.
     - `frontend`: build `../frontend`, `init: true` (MENOR-1 de T-102).
     - `backend`: build `../backend`, `init: true`, con estas variables:
       - `ENVIRONMENT=prod`;
       - `DATABASE_URL` con `valmont_app`;
       - `SUPABASE_URL` interno (`http://kong:8000`);
       - `SUPABASE_JWT_ISSUER=${PUBLIC_URL}/auth/v1`;
       - `STORAGE_PUBLIC_URL`;
       - `SUPABASE_SERVICE_ROLE_KEY`.
     - Los servicios de Supabase, con `include` o integrados.
     - Healthchecks con `depends_on: condition: service_healthy`.
     - Volúmenes con nombre para la BD, el almacenamiento y Caddy.
     - Para la prueba local se permite un `mailpit` bajo el perfil `local`, enlazado a `127.0.0.1`, para las confirmaciones de correo.
  5. **`deploy/Caddyfile`.**
     - `{$SITE_ADDRESS:localhost}`.
     - Rutas: `/api/*` → backend:8000; `/auth/v1/*` y `/storage/v1/*` → kong:8000; el resto → frontend:4321.
     - Límite de cuerpo adecuado a las imágenes de 5 MiB. Las subidas deben conservar `Content-Length` (ficha C, paso 13).
  6. **`deploy/.env.example`.** Solo marcadores, sin un solo valor real.
     - Contraseñas de Postgres y de `valmont_app`.
     - Claves de Auth y de API.
     - `SITE_ADDRESS=localhost`, `BIND_ADDRESS=127.0.0.1` y `PUBLIC_URL=https://localhost`.
     - SMTP.
  7. **`deploy/scripts/`, con LF.**
     - Generar `deploy/.env` con secretos aleatorios y claves sin imprimirlos.
     - Después de las migraciones:
       - `ALTER ROLE valmont_app LOGIN PASSWORD …`, con el rol que lo creó (comprueba que tiene `CREATEROLE`/`ADMIN`);
       - decide y documenta si se revoca `CONNECT` en las BD ajenas;
       - crea el bucket `products` igual que en `supabase/config.toml`.
  8. **MENOR pendientes.**
     - T-101: en `test_app_role.py`, `has_any_column_privilege` para SELECT, INSERT, UPDATE y REFERENCES.
     - T-102: `frontend/.dockerignore` con `**/.env*` y `**/node_modules`.
- **Criterios** (los ejecuta qa-reviewer, **sin arrancar contenedores**):
  - `docker compose -f deploy/compose.yml --env-file deploy/.env.example config --quiet` válido. Es lectura y análisis, no arranca nada.
  - Todas las imágenes con etiqueta exacta.
  - Solo Caddy publica puertos.
  - Ningún secreto versionado.
  - Los scripts con LF y `sh -n` correcto.
  - Las puertas del backend en verde, con la prueba de privilegios por columna detectando un `GRANT` por columna.
  - La comprobación ES256 resuelta con evidencia documental.
- **D-028:** backend-dev puede ejecutar el análisis estático y `docker compose … config`. No ejecuta pruebas ni `docker build`/`up`/`run`.
- **Estado inicial:** READY · IDs reservados: ninguno.

#### Traspaso T-100, ronda 2 — 2026-10-27 — backend-dev
Responde a la revisión de qa-reviewer: un BLOQUEANTE y dos MENOR. Lo demás se dio por verificado. Estado: IN_REVIEW.
- **BLOQUEANTE-1, `roles.sql` (decisión del Leader):**
  - `deploy/supabase/volumes/db/roles.sql` pasa a ser una copia recortada: se quita `ALTER USER supabase_functions_admin …`. La cabecera explica el recorte, igual que en `kong.yml`.
  - El código de `supabase/postgres` 17.6.1.136 lo confirma:
    - el rol solo se crea en `migrations/db/init-scripts/00000000000003-post-setup.sql` (`issue_pg_net_access`, al instalar `pg_net`);
    - `migrations/db/migrate.sh:44` corre los scripts de inicio con `ON_ERROR_STOP=1`.
  - `webhooks.sql` sigue sin montarse.
- **Repaso de los scripts de BD que montamos:**
  - En `roles.sql` todos los roles los crea la imagen:
    - `pgbouncer`, en `init-scripts/00-schema.sql`, que `Dockerfile-17:159` copia de `ansible/files/pgbouncer_config/pgbouncer_auth_schema.sql`;
    - `authenticator`, en `00000000000000-initial-schema.sql`;
    - `supabase_auth_admin`, en `…0001-auth-schema.sql`;
    - `supabase_storage_admin`, en `…0002-storage-schema.sql`.
  - `jwt.sql` solo usa la BD `postgres`, el parámetro `app.settings.jwt_exp` y la variable `JWT_EXP`, que está en el `environment` de `db`. No depende de los servicios quitados.
- **`deploy/compose.yml`:** la cabecera ya no da `roles.sql` por copia sin cambios. Copias exactas: `kong-entrypoint.sh` y `jwt.sql`. Recortados: `kong.yml` y `roles.sql`.
- **MENOR-2:** el `Caddyfile` añade las opciones globales `servers { protocols h1 h2 }`, sin HTTP/3. Así lo anunciado coincide con lo publicado (`443/tcp`) y lo comprobado sobre `Content-Length` para el paso 13 sigue valiendo.
- **MENOR-1 (alcance ampliado por el Leader):** el `.gitattributes` raíz añade `Dockerfile text eol=lf` y `.dockerignore text eol=lf`, con su comentario. Queda resuelto el riesgo de CRLF en los Dockerfiles de la ronda 1. `git check-attr` da `eol: lf` en los dos Dockerfiles y en los dos `.dockerignore`.
- **Riesgo nuevo, sin cambios (decisión del Leader):** `--forwarded-allow-ips *` hace que el backend acepte `X-Forwarded-*` de cualquier contenedor de la red interna, que es única. Hoy no se usa la IP del cliente. Si algún día se usa (límites de peticiones o auditoría por IP), hay que restringirla a Caddy o segmentar la red.
- **Evidencias (solo análisis estático):**
  - `docker compose -f deploy/compose.yml --env-file deploy/.env.example config --quiet` → exit 0.
  - `sh -n` sobre `migrate.sh`, `generate-env.sh` y `kong-entrypoint.sh` → exit 0 en los tres.
  - Búsqueda de `\r` en `deploy/` → ningún archivo.
- **NO EJECUTADO:**
  - Pruebas y Docker (D-028, D-011).
  - La sintaxis del `Caddyfile`: no hay `caddy` local y `caddy adapt` necesitaría Docker. qa-reviewer puede validarla en T-104 o en su revisión.
- **Commits:** ninguno, queda preparado. El mensaje propuesto no cambia.

#### Traspaso T-100 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (pendiente de qa-reviewer, D-028). No se construyó ni arrancó nada.
2. Cambios:
   - **`backend/Dockerfile`** multietapa, según la guía de uv en Docker:
     - `build` sobre `python:3.14.7-slim-trixie` con `uv` de `ghcr.io/astral-sh/uv:0.12.1`. Primero `uv sync --frozen --no-dev --no-install-project`, después `uv sync --frozen --no-dev --no-editable`.
     - `runtime`: la misma base, con `.venv`, `alembic.ini` y `migrations/`. Usuario `valmont` (uid 10001), `HEALTHCHECK` con `urllib` a `http://127.0.0.1:8000/health`.
     - Arranque: `fastapi run --entrypoint valmont.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips *`.
   - **`backend/.dockerignore`:** `**/.env*`, `.venv`, cachés, `tests` y los archivos de Docker.
   - **`deploy/compose.yml`** (proyecto `valmont`):
     - `caddy` (`caddy:2.11.7-alpine`) es el único servicio con `ports`, en `${BIND_ADDRESS:-127.0.0.1}:80` y `:443`.
     - `frontend` y `backend` con `build` e `init: true`. El backend recibe las variables del paquete.
     - Supabase: `db`, `auth`, `storage` y `kong`. Cada uno con healthcheck y `depends_on: service_healthy` (db → auth/storage → kong → backend → caddy).
     - Volúmenes con nombre: `db-data`, `db-config`, `storage-data`, `caddy-data` y `caddy-config`.
     - `mailpit` (`axllent/mailpit:v1.31.6`) solo con el perfil `local`, en `127.0.0.1:8025`.
   - **`deploy/supabase/`:** copias sin cambios de `volumes/api/kong-entrypoint.sh`, `volumes/db/roles.sql` y `volumes/db/jwt.sql`, con el mismo SHA-256 que en el tag. `volumes/api/kong.yml` está recortado: solo quedan las rutas oficiales de Auth y Storage, y su cabecera explica lo quitado.
   - **`deploy/Caddyfile`:** `{$SITE_ADDRESS:localhost}` con `request_body max_size 6MiB`. Enruta `/api/*` → `backend:8000`, `/auth/v1/*` y `/storage/v1/*` → `kong:8000`, y el resto → `frontend:4321`.
   - **`deploy/.env.example`:** solo marcadores. Los secretos van vacíos; los valores por defecto son `SITE_ADDRESS`, `BIND_ADDRESS` y `PUBLIC_URL`, y el SMTP apunta a Mailpit.
   - **`deploy/scripts/`:**
     - `generate-env.sh` + `generate-env.mjs` escriben `deploy/.env` sin imprimir nada, con permisos 600. Nunca sobrescriben: usan `flag: 'wx'`.
     - `migrate.sh`, en este orden:
       1. `alembic upgrade head` con la URL del propietario `postgres`, que viaja por el entorno (`-e DATABASE_URL`);
       2. comprueba `CREATEROLE` + `ADMIN`, `CONNECT` y el esquema de Storage;
       3. `ALTER ROLE valmont_app LOGIN PASSWORD`, con la contraseña entrando por stdin;
       4. `INSERT … ON CONFLICT` del bucket `products` (público, 5242880 bytes, jpeg/png/webp).
   - **`deploy/.gitattributes`:** `* text=auto eol=lf`. Con `core.autocrlf=true`, `kong-entrypoint.sh`, el SQL y el YAML llegarían con CRLF a los contenedores.
   - **MENOR-1 de T-101:** `TABLE_PRIVILEGES` usa `has_any_column_privilege` para SELECT, INSERT, UPDATE y REFERENCES, y `has_table_privilege` para el resto.
   - **MENOR-2 de T-102:** `frontend/.dockerignore` con `**/node_modules` y `**/.env*`.
3. Archivos modificados:
   - nuevos: `backend/Dockerfile`, `backend/.dockerignore`, `deploy/.env.example`, `deploy/.gitattributes`, `deploy/Caddyfile`, `deploy/compose.yml`, `deploy/scripts/generate-env.mjs`, `deploy/scripts/generate-env.sh`, `deploy/scripts/migrate.sh`, `deploy/supabase/volumes/api/kong-entrypoint.sh`, `deploy/supabase/volumes/api/kong.yml`, `deploy/supabase/volumes/db/jwt.sql` y `deploy/supabase/volumes/db/roles.sql`;
   - modificados: `backend/tests/test_app_role.py`, `frontend/.dockerignore` y `docs/agents/tasks.md`.
4. Decisiones tomadas (técnicas, dentro del paquete; ninguna D-xxx nueva):
   - **Riesgo ES256 (D-018): resuelto, no BLOCKED.**
     - Configuración: `GOTRUE_JWT_KEYS=${JWT_KEYS}`, un array JSON con una JWK EC P-256 privada (`alg: ES256`, `key_ops: ["sign","verify"]`) y la simétrica `oct`. `GOTRUE_JWT_ISSUER=${PUBLIC_URL}/auth/v1` coincide con `SUPABASE_JWT_ISSUER` del backend.
     - Fuentes, todas en la versión fijada:
       - (a) `docker/docker-compose.yml` del tag `self-hosted/v0.8.3` trae `#GOTRUE_JWT_KEYS: ${JWT_KEYS:-[]}` ("JSON array of signing JWKs (EC private + legacy symmetric)") y la imagen `supabase/gotrue:v2.197.0`.
       - (b) La guía oficial `apps/docs/content/guides/self-hosting/self-hosted-auth-keys.mdx` dice: "When `JWT_KEYS` is set, Auth will start signing new user session JWTs with the new asymmetric ES256 key pair". Añade que `curl …/auth/v1/.well-known/jwks.json` "should return the EC public key (the symmetric key is excluded)".
       - (c) El código de `supabase/auth` v2.197.0:
         - `internal/conf/configuration.go`: `JWTConfiguration.Keys JwtKeysDecoder`, es decir, `GOTRUE_JWT_KEYS`;
         - `internal/conf/jwk.go`: `GetSigningJwk` firma con la JWK cuyo `key_ops` contiene `sign`, y `Validate` exige exactamente una; `GetSigningAlg` → `ES256`;
         - `internal/api/jwks.go`: `WellKnownJwks` publica las claves públicas y omite las `oct`.
       - (d) `kong.yml` oficial: la ruta abierta `auth-v1-open-jwks` (`/auth/v1/.well-known/jwks.json`) no pide `apikey`, así que el backend la alcanza en `http://kong:8000`.
     - Generación de claves: replica `utils/generate-keys.sh` y `utils/add-new-auth-keys.sh` del mismo tag (EC P-256 con `crypto` de Node, `kid` UUID y `oct` = base64url de `JWT_SECRET`). No uso las claves opacas `sb_`, que no hacen falta.
   - **Versión de Supabase:** tag `self-hosted/v0.8.3` (commit `bc27d2661edd09a5d0b8d76ce33da6d4071a756e`, 2026-10-16), en https://github.com/supabase/supabase/tree/self-hosted/v0.8.3/docker. Es la última release; frente a `master` del 2026-10-22 solo cambian dos comentarios.
   - **Servicios integrados en `deploy/compose.yml`, sin `include`.** Así `docker compose config` y la interpolación usan un único `.env`.
   - **Gateway Kong, como pide el paquete.** En v0.8.3 el gateway por defecto es Envoy (servicio `api-gw` con los alias `envoy` y `kong`), y Kong es el override oficial `docker-compose.kong.yml`. Lo copié de ahí: imagen, healthcheck, entorno y entrypoint. Más `KONG_PORT_MAPS: "443:8000"`, como indica `docker-compose.caddy.yml`.
   - **`rest` e `imgproxy` quedan fuera** (el paquete pedía justificarlos):
     - en el código de `supabase/storage` v1.81.0, `src/config.ts` no lee `POSTGREST_URL`; el `depends_on: rest` oficial es heredado;
     - imgproxy solo se usa si `ENABLE_IMAGE_TRANSFORMATION=true` (`src/http/routes/render/index.ts` no registra rutas si no). Lo desactivo y Valmont sirve las imágenes tal cual;
     - desactivo también el endpoint S3 con `S3_PROTOCOL_ENABLED=false` (`src/http/routes/s3/index.ts`), así no hace falta ningún par de claves S3.
   - **BD:** solo se montan `roles.sql` (contraseñas de los roles internos de Auth y Storage) y `jwt.sql`. Quedan fuera los de `_supabase`, realtime, logs, pooler y webhooks, que solo sirven a servicios excluidos.
   - **Paridad con `supabase/config.toml`:** confirmación de correo obligatoria (`GOTRUE_MAILER_AUTOCONFIRM=false`), `jwt_expiry` 3600, Storage con límite de 5 MiB, y teléfono y anónimos desactivados.
   - **`Content-Length`:** comprobado en el código de Caddy v2.11.7:
     - `cloneRequest` copia la petición entera, incluido `ContentLength`;
     - `request_body` solo envuelve el cuerpo en `MaxBytesReader` y responde 413 si se pasa;
     - sin `request_buffers` no se reescribe el cuerpo.

     El backend sigue viendo el `Content-Length` del cliente. No activo `request_buffers` porque cambiaría la regla de T-029 (aceptaría cuerpos sin `Content-Length`).
   - **`CONNECT` no se revoca.** Está documentado en `migrate.sh`:
     - la única BD con datos es `postgres`, y valmont_app necesita `CONNECT` en ella (el script lo comprueba);
     - no se crea `_supabase`;
     - revocárselo a `PUBLIC` en `postgres` cortaría a los roles de Supabase que entran por esa vía.
   - **El rol que hace `ALTER ROLE` es `postgres`,** el mismo que corre las migraciones. En PostgreSQL 16+ recibe `ADMIN` al crear valmont_app en la 0006. El script exige `rolsuper` o `rolcreaterole` + `pg_has_role(current_user, 'valmont_app', 'MEMBER WITH ADMIN OPTION')` y, si no, falla con un mensaje claro.
   - **Base `python:3.14.7-slim-trixie`:** la misma versión que el Python local, donde qa-reviewer pasa `pytest`, y con la distribución fijada (criterio de T-102). Existen ya 3.14.8–3.14.10.
5. Pruebas ejecutadas → resultado observado (solo análisis estático, D-028):
   - `docker compose -f deploy/compose.yml --env-file deploy/.env.example config --quiet` → exit 0, sin avisos.
   - `… config --format json`, con y sin `--profile local` → `name: valmont`, todas las imágenes con etiqueta exacta y solo `caddy` con puertos (`127.0.0.1:80` y `:443`). Con el perfil `local` se añade `mailpit`, en `127.0.0.1:8025`.
   - `sh -n` sobre `deploy/scripts/generate-env.sh`, `deploy/scripts/migrate.sh` y `deploy/supabase/volumes/api/kong-entrypoint.sh` → exit 0 en los tres.
   - `node --check deploy/scripts/generate-env.mjs` → exit 0.
   - Búsqueda de `\r` en `deploy/` → ningún archivo (todos en LF).
   - `git check-ignore --no-index -v deploy/.env` → `.gitignore:8:.env`.
   - `cd backend && uv run ruff format .` → `93 files left unchanged`.
   - `cd backend && uv run ruff check .` → `All checks passed!`.
   - capas (grep) → vacío.
   - Sobre `git diff --cached`: grep de secretos literales → vacío; `^\+[A-Z_]*(KEY|SECRET|PASSWORD|TOKEN)[A-Z_]*=.+` → vacío; grep de JWT pegados (`eyJ…`) → vacío.
   - `git diff --cached --stat` → 16 archivos, solo los de T-100. `git diff` → vacío.
6. Pruebas no ejecutadas y motivo: NO EJECUTADO: pruebas y Docker (D-028, D-011). Lo que espero que observe qa-reviewer:
   - `pytest -q` → 704 passed, sin unitarias nuevas.
   - `pytest -m integration -q` → 267 passed. Mutante para el MENOR-1: con `GRANT SELECT (version_num) ON app.alembic_version TO valmont_app`, la prueba del mapa debe fallar.
   - Generador, sin Docker: `node deploy/scripts/generate-env.mjs deploy/.env.example <tmp>/x.env`. El archivo tiene las 7 claves rellenas y `JWT_KEYS` lleva una sola JWK con `key_ops` `sign`. Una segunda ejecución sobre el mismo destino falla con `EEXIST`.
   - T-104 (con ficha Docker):
     - `docker compose … up -d --build`, con todos los servicios `healthy`;
     - `sh deploy/scripts/migrate.sh`;
     - `curl -k https://localhost/auth/v1/.well-known/jwks.json` devuelve una clave `EC`/`ES256`;
     - registro → correo en Mailpit → token con `alg: ES256` → `GET /api/v1/identity/me` → 200;
     - subida de imagen de 5 MiB → 201, y de más de 5 MiB → 413.
7. Dependencias pendientes:
   - T-104: construir, arrancar, `migrate.sh` y la prueba de humo. `docs/deploy.md` §C está desactualizada:
     - el paso 4 cita `generate-keys.sh` (ahora `deploy/scripts/generate-env.sh`);
     - el paso 6 migra con `run --rm backend alembic upgrade head` sin la URL del propietario. Usar `deploy/scripts/migrate.sh`; con la URL del servicio (valmont_app) fallaría;
     - el paso 9 pide `GET /health`, pero Caddy no enruta `/health`: se comprueba con el estado `healthy` del contenedor.
   - T-018: sigue pendiente lo que listaba.
8. Riesgos conocidos:
   - **Kong está anunciado en desuso** en el CHANGELOG de v0.8.3 ("Upcoming deprecations: `docker-compose.kong.yml` … superseded by Envoy"). Pasar a Envoy no toca Caddy ni el backend, porque Envoy declara el alias `kong`, pero habría que recortar su `lds.template.yaml`. Conviene decidirlo antes de actualizar Supabase.
   - **No verificado en ejecución:**
     - que storage-api v1.81.0 arranque sin `rest` ni `imgproxy` (verificado solo en el código);
     - que `postgres` pueda escribir en `storage.buckets` en el autohospedado (la guía de Storage crea buckets por SQL);
     - que `pg_has_role(..., 'MEMBER WITH ADMIN OPTION')` dé verdadero con el `ADMIN` automático. Si no, el script falla con un mensaje claro, sin efectos a medias.
   - **Certificado de `https://localhost`:** lo firma la CA interna de Caddy, que el navegador del anfitrión no conoce. En T-104 habrá que aceptar el aviso o importar la raíz desde el volumen `caddy-data`.
   - **SMTP:** `.env.example` apunta a Mailpit. Sin `--profile local` y sin un SMTP real, Auth no envía los correos de confirmación.
   - **`deploy/.env` no se puede regenerar** tras el primer arranque sin perder el acceso a la BD (`roles.sql` solo corre al crearla). El generador se niega a sobrescribirlo.
   - **Respaldo con Docker:** en Linux sin Node, el generador usa `docker run node:26.12.1-trixie-slim` (puerta D-011).
   - **Dockerfiles con CRLF:** `backend/Dockerfile` y `frontend/Dockerfile` llegarán con CRLF en un clon de Windows (`core.autocrlf=true`). BuildKit suele tolerarlo, pero no lo he comprobado. Para fijar LF habría que añadir `Dockerfile* eol=lf` al `.gitattributes` raíz, que está fuera de mi alcance.
9. Preguntas que requieren decisión:
   - claude-leader: ¿Kong (lo que pide el paquete, en desuso en upstream) o Envoy (el gateway por defecto)? No bloquea.
   - claude-leader: ¿subir la base a `python:3.14.10-slim-trixie` tras la verificación? No bloquea.
10. Documentación actualizada: `docs/agents/tasks.md` (fila T-100 y este traspaso). `docs/deploy.md` no se toca: es de T-104.
11. Siguiente acción recomendada: qa-reviewer verifica lo preparado:
    - `config --quiet`, `sh -n`, ruff, capas y las puertas de secretos;
    - `pytest -q` y `pytest -m integration -q`, con el mutante por columna;
    - el generador sobre un destino temporal;
    - revisión estática de los Dockerfiles y del compose;
    - la huella de lo preparado.

    Después, el Leader hace el commit y abre T-104 con su ficha Docker.
12. Commits: ninguno — preparado (D-028).
    - Rutas preparadas: `backend/Dockerfile`, `backend/.dockerignore`, `backend/tests/test_app_role.py`, `frontend/.dockerignore`, `deploy/` (11 archivos) y `docs/agents/tasks.md`.
    - Mensaje propuesto: `feat(deploy): imagen del backend y stack de despliegue con Caddy y Supabase autohospedado (T-100)`.

### T-102 — Imagen del frontend (Astro SSR con `@astrojs/node`)
- **Objetivo:** el frontend se construye y arranca como contenedor Node, listo para el compose de T-100. Ficha de auditoría de archivos confirmada por el usuario el 2026-10-27.
- **Responsable:** frontend-dev (verifica qa-reviewer, acepta claude-leader) · Decisiones: D-024, D-028, D-029 · **Entrega:** preparada sin commit, con el mensaje propuesto (PROTOCOL §11.2).
- **Leer:**
  - `docs/decisions.md`: D-024 (SSR solo en listado, categoría y ficha; portada y legales estáticas) y D-029.
  - `frontend/astro.config.mjs` y `frontend/package.json`.
  - `docs/modules.md` §5.
  - La documentación oficial de `@astrojs/node` y de los modos de salida de Astro 7.
- **Puede modificar:**
  - `frontend/package.json` y `frontend/package-lock.json`;
  - `frontend/astro.config.mjs`;
  - `frontend/Dockerfile` y `frontend/.dockerignore` (nuevos);
  - tu traspaso debajo de este paquete y la fila de T-102.
- **Resultado esperado:**
  1. **Adaptador.** `@astrojs/node` instalado con `npm install --save-exact`, en una versión compatible con `astro` 7.4 que anotes con su fuente. Lo aprueba D-024.
  2. **Configuración.** Adaptador `node({ mode: 'standalone' })`, con el modo de salida que pide D-024: las páginas estáticas se prerenderizan y las del catálogo, cuando existan, se renderizan bajo demanda. El build debe dejar el servidor en `dist/server/entry.mjs`; compruébalo en la documentación, porque no puedes ejecutar el build.
  3. **`frontend/Dockerfile`** multietapa, con una imagen base de Node fijada a la misma versión mayor que la local (Node 26, etiqueta `-slim` exacta):
     - etapa de build: `npm ci` y `npm run build`;
     - etapa final: `dist/` y dependencias de producción (`npm ci --omit=dev`), usuario no root, `HOST=0.0.0.0`, `PORT=4321`, `EXPOSE 4321`;
     - `HEALTHCHECK` con `node` (la imagen slim no trae curl);
     - arranque con `node ./dist/server/entry.mjs`.
  4. **`frontend/.dockerignore`:** `node_modules`, `dist`, `.astro`, `.env*` y lo que no deba entrar en la imagen.
  5. **Sin valores de entorno horneados en la imagen.** Astro sustituye `PUBLIC_*` en el build. Documenta en el traspaso cómo se pasará la configuración en tiempo de ejecución cuando haga falta (por ejemplo, `astro:env` con contexto server). El esqueleto aún no la necesita.
- **Criterios** (los ejecuta qa-reviewer):
  - `npm run check` sin errores;
  - `npm run build` correcto, dejando `dist/server/entry.mjs`;
  - `node ./dist/server/entry.mjs` sirve la portada en el puerto 4321;
  - revisión estática del Dockerfile: base fijada, no root, sin secretos, caché de capas razonable.
  - La imagen se construye en T-104, con su propia ficha Docker.
- **D-028:** frontend-dev puede ejecutar `npm install` (para añadir la dependencia) y `npm run check` (análisis estático). No ejecuta `npm run build`, el servidor ni Docker.
- **Estado inicial:** READY · IDs reservados: ninguno.

#### Traspaso T-102 — 2026-10-27 — frontend-dev
1. Estado final: IN_REVIEW (pendiente de qa-reviewer, D-028).
2. Cambios:
   - **Adaptador:** `npm install --save-exact @astrojs/node@11.1.9` → `added 284 packages … found 0 vulnerabilities`. En `package.json` queda `"@astrojs/node": "11.1.9"`. En el lock solo hay líneas añadidas (222 inserciones, 0 borrados) y `astro` sigue en 7.4.2.
   - **`astro.config.mjs`:** `output: 'static'` y `adapter: node({ mode: 'standalone' })`.
   - **`Dockerfile`:** sigue la receta multietapa oficial (docs.astro.build/en/recipes/docker/), con estas etapas:
     - `base`: copia solo `package.json` y `package-lock.json`;
     - `prod-deps`: `npm ci --omit=dev`;
     - `build`: `npm ci`, después `COPY . .` y `npm run build`;
     - `runtime`: sobre `node:26.12.1-trixie-slim`, con `NODE_ENV=production`, `HOST=0.0.0.0` y `PORT=4321`. Copia `package.json`, `node_modules` de producción y `dist/`. Corre con `USER node` y `EXPOSE 4321`. El `HEALTHCHECK` es exec con `fetch` de Node a `http://127.0.0.1:$PORT/`, y arranca con `CMD ["node", "./dist/server/entry.mjs"]`.
     - No lleva `ARG` ni `ENV` de la aplicación ni secretos.
   - **`.dockerignore`:** excluye `node_modules`, `dist`, `.astro`, `.env*`, `.git`, `Dockerfile`, `.dockerignore`, editores (`.vscode`, `.idea`), `.DS_Store`, registros de npm/yarn/pnpm y `AGENTS.md`.
3. Archivos modificados:
   - `frontend/package.json` y `frontend/package-lock.json`;
   - `frontend/astro.config.mjs`;
   - `frontend/Dockerfile` y `frontend/.dockerignore` (nuevos);
   - `docs/agents/tasks.md` (fila T-102 y este traspaso).
4. Decisiones tomadas (técnicas, dentro del paquete; ninguna D-xxx nueva):
   - **`output: 'static'`, no `'server'` (discrepancia con el texto de la fila).**
     - D-024 pide portada y legales estáticas, y solo listado, categoría y ficha bajo demanda. `modules.md` §5 dice "SSG por defecto".
     - La guía oficial (docs.astro.build/en/guides/on-demand-rendering/) recomienda mantener `'static'` mientras la mayoría de páginas sean estáticas. Con `'server'`, la portada actual se renderizaría bajo demanda, salvo que se añadiera `prerender = true` a `index.astro`, que queda fuera de mi alcance.
     - Las páginas del catálogo pondrán `export const prerender = false`.
     - `dist/server/entry.mjs` se genera aunque todo esté prerenderizado. Lo comprobé en el código instalado:
       - `node_modules/@astrojs/node/dist/index.js` declara `adapterFeatures.buildOutput: "server"`;
       - `node_modules/astro/dist/integrations/hooks.js` (`setAdapter`) pone `settings.buildOutput = "server"` cuando ese valor no es `"static"`;
       - `node_modules/astro/dist/core/build/index.js` lo aplica después de la línea que lo fija según `output`.
     - La guía del adaptador confirma la ruta `./dist/server/entry.mjs` y que el modo standalone sirve `dist/client/`, donde queda la portada prerenderizada.
   - **Versión 11.1.9:**
     - `npm view @astrojs/node dist-tags` → `latest: 11.1.9`;
     - `npm view @astrojs/node@latest peerDependencies` → `astro: ^7.2.1`, que cubre la 7.4.2;
     - la guía del adaptador documenta la v11.1.9.
   - **Imagen base `node:26.12.1-trixie-slim`** (API de etiquetas de Docker Hub: amd64 y arm64, publicada el 2026-10-21):
     - fija la misma versión que la local (v26.12.1) y la distribución, mientras que `26.12.1-slim` es un alias que puede cambiar de Debian;
     - el lock trae los binarios nativos `linux-x64-gnu` y `linux-arm64-gnu` (rolldown, lightningcss, compilador de Astro y sharp), así que `npm ci` funciona en glibc.
   - **`prod-deps` es una etapa aparte**, como en la receta oficial: la caché de npm no llega a la imagen final y esa capa solo se rehace si cambian los manifiestos.
   - **Los archivos de la etapa final son de root**, de solo lectura para `node`: el servidor no escribe en disco.
   - **El `HEALTHCHECK` usa `127.0.0.1` y no `localhost`.** Node puede resolver `localhost` a `::1`, y el servidor escucha en `0.0.0.0` (solo IPv4).
   - **Configuración en tiempo de ejecución (pauta para cuando haga falta, por ejemplo la URL del backend o las claves de Supabase de D-025):**
     - No se usará `import.meta.env.PUBLIC_*` para valores que cambien según el entorno: Vite los sustituye en el build y quedarían dentro de la imagen.
     - Tampoco sirve `astro:env` con `access: 'public'`, ni siquiera con `context: 'server'`. Lo comprobé en `node_modules/astro/dist/env/vite-plugin-env.js`: las variables públicas se escriben como `export const KEY = "valor"` en el build.
     - Solo `envField.string({ context: 'server', access: 'secret' })` se lee al arrancar, mediante `_internalGetSecret` y `process.env` en el adaptador Node (`envGetSecret: "stable"`). Se usa aunque el valor no sea secreto, se importa desde `astro:env/server` y se pasa con `environment:` en el compose de T-100.
     - Si el navegador necesita un valor, el servidor lo escribe en la página.
     - Con `validateSecrets: true`, una variable que falte hace fallar el arranque.
5. Pruebas ejecutadas → resultado observado (solo análisis estático, D-028), desde `frontend/`:
   - `npm run check` (línea base, tras instalar y antes de tocar la configuración) → `Result (3 files): 0 errors, 0 warnings, 0 hints`
   - `npm run check` (con `astro.config.mjs` nuevo) → `Result (3 files): 0 errors, 0 warnings, 0 hints`
6. Pruebas no ejecutadas y motivo: NO EJECUTADO: build, servidor y Docker (D-028). Lo que espero que observe qa-reviewer:
   - `npm run build` termina con `mode: "server"` y deja `dist/server/entry.mjs` y `dist/client/index.html`. También registra el aviso del adaptador `Enabling sessions with filesystem storage` (punto 8).
   - `HOST=127.0.0.1 PORT=4321 node ./dist/server/entry.mjs` sirve la portada con 200. Sin `PORT`, el adaptador usa el `server.port` de Astro, que por defecto es 4321.
   - Revisión estática del `Dockerfile`: la imagen se construye en T-104.
7. Dependencias pendientes:
   - T-100: el servicio del compose con `build: ./frontend`, el puerto 4321 solo en la red interna (lo publica Caddy, D-029) y las variables de entorno según la pauta del punto 4.
   - T-104: construir la imagen y comprobar el `HEALTHCHECK`, `docker inspect --format '{{.State.Health.Status}}'` → `healthy`.
8. Riesgos conocidos:
   - **Sesiones de Astro.** El adaptador activa por defecto sesiones en disco, en `node_modules/.astro/sessions` dentro del contenedor (`cacheDir`). Hoy nadie usa `Astro.session` y D-025 lleva la sesión en cookies de `@supabase/ssr`. Si algún día se usa, el usuario `node` no puede escribir en `/app`: habría que poner `session: false` o elegir otro driver.
   - **Detrás de Caddy.** Astro comprueba el origen en los POST de páginas bajo demanda (`security.checkOrigin`). Con TLS terminado en Caddy, el servidor ve `http`. Hay que comprobarlo en T-104 con el primer formulario bajo demanda y, si falla, revisar `security.allowedDomains` y las cabeceras `X-Forwarded-*`. Hoy no hay páginas bajo demanda, así que no aplica.
   - **La versión de npm de la imagen no está verificada.** En local hay npm 12.2.1. El lock es compatible con cualquier npm reciente.
9. Preguntas que requieren decisión:
   - claude-leader: confirmar `output: 'static'` (punto 4) y, si procede, corregir "`output: 'server'`" en la descripción de la fila T-102. No bloquea.
10. Documentación actualizada: `docs/agents/tasks.md` (fila T-102 y este traspaso).
11. Siguiente acción recomendada: qa-reviewer ejecuta en `frontend/` `npm run check`, `npm run build` (comprobar `dist/server/entry.mjs`) y `node ./dist/server/entry.mjs` con `curl http://127.0.0.1:4321/` → 200. Después hace la revisión estática del `Dockerfile` y anota la huella de lo preparado.
12. Commits: ninguno — preparado (D-028).
    - Rutas preparadas: `frontend/package.json`, `frontend/package-lock.json`, `frontend/astro.config.mjs`, `frontend/Dockerfile`, `frontend/.dockerignore` y `docs/agents/tasks.md`.
    - Mensaje propuesto: `feat(frontend): imagen Docker con @astrojs/node (T-102)`.

### T-101 — Rol de BD `valmont_app` con privilegios mínimos
- **Objetivo:** el backend desplegado se conecta con un rol que no puede cambiar el esquema ni alterar el registro de auditoría (defensa en profundidad, además de los triggers de `audit_log`).
- **Responsable:** backend-dev (verifica qa-reviewer, acepta claude-leader) · Requisitos: RNF02 · Decisiones: D-010, D-028, D-029 · **Entrega:** preparada sin commit, con el mensaje propuesto (PROTOCOL §11.2).
- **Leer:**
  - `backend/migrations/versions/` (0001–0005; sobre todo 0001, por el `REVOKE` y los `IF EXISTS` en `pg_roles`).
  - La skill `database-migration-review`.
  - `backend/tests/conftest.py` (el fixture de la BD de pruebas).
- **Puede modificar:**
  - `backend/migrations/versions/0006_*.py` (nueva, `--rev-id 0006`);
  - `backend/tests/**` (archivo de pruebas nuevo);
  - tu traspaso debajo de este paquete.
- **Resultado esperado** (migración 0006):
  - **Rol:** crea `valmont_app NOLOGIN` si no existe. Los roles son del clúster y la BD de pruebas comparte clúster, así que debe ser idempotente. La contraseña y el `LOGIN` se fijan al desplegar (T-100), **nunca** en la migración.
  - **Permisos:**
    - `USAGE` en el esquema `app`.
    - `SELECT, INSERT, UPDATE, DELETE` en las tablas de `app` que escribe el backend.
    - En `app.audit_log`, **solo** `SELECT, INSERT`.
    - `SELECT` en las vistas (`product_availability`).
    - `USAGE, SELECT` en las secuencias.
    - Lo necesario para ejecutar `app.f_unaccent` (comprueba si hace falta `USAGE` en el esquema `extensions`).
  - **Sin poder de esquema:** sin `CREATE` en `app` y sin ser dueño de nada. `alembic_version` solo la toca el rol de migraciones.
  - **Tablas futuras:** una tabla nueva sin permisos para `valmont_app` debe hacer **fallar una prueba**, que compara los privilegios reales de cada tabla de `app` con un mapa esperado. Así cada módulo nuevo tiene que concederlos de forma explícita.
  - **`downgrade`:** retira los permisos de esta BD sin romper las demás del clúster.
- **Criterios** (integración, con `SET ROLE valmont_app` dentro de la transacción de prueba):
  - Lee y escribe las tablas del backend.
  - `UPDATE`/`DELETE` en `audit_log` dan `permission denied`, antes de llegar al trigger.
  - `CREATE TABLE` y `ALTER TABLE` en `app` fallan.
  - La prueba del mapa de privilegios cubre todas las tablas.
  - `alembic downgrade 0005` y después `upgrade head` funcionan.
  - En desarrollo el backend sigue conectándose como hoy: no cambia `.env`.
- **Pruebas obligatorias:** las escribe backend-dev; qa-reviewer ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y las migraciones reversibles (D-028).
- **Estado inicial:** READY · IDs reservados: ninguno (tarea hoja).

#### Traspaso T-101 — 2026-10-27 — backend-dev
1. Estado final: IN_REVIEW (pendiente de qa-reviewer, D-028).
2. Cambios:
   - Migración `0006`, escrita a mano con el formato de 0005: crea `valmont_app NOLOGIN` solo si no existe, con un bloque `DO` sobre `pg_roles` como en 0001. Concede:
     - `USAGE` en `app`;
     - CRUD en las 9 tablas que escribe el backend;
     - `SELECT, INSERT` en `audit_log` y en `stock_movements` (decisión del Leader, punto 9);
     - `SELECT` en `product_availability`;
     - `USAGE, SELECT` en las secuencias;
     - `EXECUTE` en `app.f_unaccent(text)`.
   - El `downgrade` revoca todo eso en esta BD (con guarda `IF EXISTS`) y **no** hace `DROP ROLE`.
   - Pruebas de integración nuevas en `tests/test_app_role.py`.
3. Archivos modificados: `backend/migrations/versions/0006_app_role.py` (nuevo), `backend/tests/test_app_role.py` (nuevo) y `docs/agents/tasks.md` (fila y este traspaso).
4. Decisiones tomadas (técnicas, dentro del paquete; ninguna D-xxx nueva):
   - **Sin `DROP ROLE` en el `downgrade`.** El rol es del clúster: si la otra BD (desarrollo o `valmont_test`) conserva permisos, `DROP ROLE` falla (2BP01) y rompe el `downgrade`. En despliegue, además, se perderían el `LOGIN` y la contraseña de T-100. Sin permisos, el rol no alcanza nada de `app`.
   - **Sin `USAGE` en `extensions`.** `f_unaccent` tiene cuerpo SQL estándar (`RETURN`), enlazado al crearse, así que no busca `extensions.unaccent` por nombre. El `EXECUTE` en `unaccent` llega por `PUBLIC`. El `EXECUTE` en `app.f_unaccent` se concede de forma explícita. La prueba de lectura y escritura lo ejercita: inserta un producto (columna generada) y busca con `f_unaccent`.
   - **El fixture `app_session` se concede `SET` a sí mismo.** En PostgreSQL 16+, quien crea un rol sin ser superusuario recibe `ADMIN`, pero no `SET`, y `SET ROLE` lo exige. Solo lo hace si `pg_has_role('valmont_app', 'SET')` es falso, y el rollback de `db_session` lo deshace junto con el `SET LOCAL ROLE`.
   - **No se prueba `rolcanlogin`:** lo fija el despliegue. Sí se prueba que el rol no tiene `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` ni `BYPASSRLS`, y que no es dueño de nada (`pg_shdepend`).
5. Pruebas ejecutadas → resultado observado (solo análisis estático, desde `backend/`):
   - `uv run ruff format .` → 93 files left unchanged
   - `uv run ruff check .` → All checks passed!
   - capas (grep) → vacío
6. Pruebas no ejecutadas y motivo: NO EJECUTADO: pruebas ni migraciones (D-028). Esperado, sobre la base de la verificación de T-030 (704 + 256):
   - `pytest -q` → 704 passed (sin unitarias nuevas).
   - `pytest -m integration -q` → 267 passed (+11: atributos y propiedad, mapa de privilegios, lectura y escritura, 3 de `audit_log` con `UPDATE`/`DELETE`/`TRUNCATE`, 2 de `stock_movements` con `UPDATE`/`DELETE`, 2 de esquema, `downgrade 0005` → `upgrade head`).
   - `alembic check` → sin operaciones nuevas (los `GRANT` no están en los metadatos).
   - Migraciones reversibles en desarrollo, incluido `downgrade 0005` → `upgrade head`.
7. Dependencias pendientes:
   - T-100: `ALTER ROLE valmont_app LOGIN PASSWORD …` con el rol que lo creó (tiene `ADMIN`), y la `DATABASE_URL` del backend con `valmont_app`. Las migraciones siguen con el propietario.
   - `CONNECT` llega por `PUBLIC`: si la BD de despliegue lo revoca, T-100 debe concederlo.
8. Riesgos conocidos:
   - El `EXECUTE` de `extensions.unaccent` por `PUBLIC` solo queda probado en `valmont_test`. La prueba de humo de T-104 debería crear un producto y buscar como `valmont_app`.
   - Si `valmont_app` lo creó otro rol, el usuario de pruebas no tiene `ADMIN`, el `GRANT` del fixture falla y las 8 pruebas con `app_session` dan error (no pasan en falso).
   - Cada migración futura con tablas o secuencias en `app` debe concederlas y añadirlas al mapa; si no, la prueba del mapa falla. Es lo buscado.
   - Si la prueba de `downgrade` falla a mitad, deja `valmont_test` en 0005, igual que `test_migrations.py`.
9. Preguntas que requieren decisión: ninguna abierta. Resuelta por claude-leader el 2026-10-27:
   - `app.stock_movements` es un libro de movimientos y queda en `SELECT, INSERT`. Hay 2 pruebas nuevas: `UPDATE` y `DELETE` dan `permission denied` con una fila que casa.
   - El resto de tablas mantiene CRUD. Las pruebas del backend no corren como `valmont_app`, así que quitar un `DELETE` hoy sin uso podría romper producción sin que nada lo detecte. El mapa de privilegios obliga a decidirlo tabla a tabla.
   - El `downgrade` no cambia: `REVOKE ALL ON ALL TABLES IN SCHEMA app` ya cubre `stock_movements`.
10. Documentación actualizada: `docs/agents/tasks.md` (fila T-101 y este traspaso).
11. Siguiente acción recomendada: qa-reviewer ejecuta format, lint, `pytest -q`, `pytest -m integration -q`, capas, `alembic check` y las migraciones reversibles sobre lo preparado.
12. Commits: ninguno — preparado.
    - Rutas: `backend/migrations/versions/0006_app_role.py`, `backend/tests/test_app_role.py`, `docs/agents/tasks.md`.
    - Mensaje propuesto: `feat(db): rol valmont_app con privilegios mínimos (T-101)`.

### T-007 — Base del backend (configuración, errores, logging)
- Objetivo: el backend carga su configuración por entorno, responde a cualquier error con un formato JSON único y registra cada solicitud con un id.
- Responsable: backend-dev (revisa claude-leader) · Módulo: plataforma (`shared/`) · Requisitos: RNF09, RNF05, RNF02
- Leer: `docs/modules.md` §4 y §7; `backend/src/valmont/main.py`; `backend/tests/test_health.py`
- Contratos aplicables: formato de error de `modules.md` §4.4
- Dependencias: ninguna
- Puede modificar: `backend/src/valmont/main.py`, `backend/src/valmont/shared/**`, `backend/tests/**`, `backend/.env.example`, y `backend/pyproject.toml` + `backend/uv.lock` solo para dos cosas: `uv add pydantic-settings` (hoy llega de forma transitiva) y cambiar `fastapi[standard]` por `fastapi[standard-no-fastapi-cloud-cli]` (auditoría #16)
- Protegido: `frontend/**`, `docs/**` (salvo el traspaso en este archivo)
- Resultado esperado: `shared/config.py` (Settings con `ENVIRONMENT`), `shared/errors.py` (excepción base de la app + handlers), middleware de id de solicitud (`X-Request-ID`), `.env.example`
- Criterios de aceptación: (1) un error de dominio de prueba devuelve `{"error": {"code", "message", "details"}}` con el código HTTP correcto; (2) un error no controlado devuelve 500 con el mismo formato y sin traza; (3) toda respuesta incluye `X-Request-ID`: se reutiliza el entrante solo si cumple `^[A-Za-z0-9-]{1,64}$` (si no, se genera un UUID4, para evitar inyección en logs), y cada línea de log de la solicitud lleva ese id; (4) `/health` sigue funcionando y `uv run fastapi dev src/valmont/main.py` arranca
- Pruebas obligatorias: `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, con pruebas nuevas para (1)–(3)
- Seguridad: no exponer trazas ni datos internos en las respuestas; no registrar cabeceras de autorización
- Estado inicial: READY
- IDs reservados: ninguno (tarea hoja)
- Escalar si: hace falta otra dependencia, o el formato de error no cubre un caso

#### Traspaso T-007 — 2026-10-26 — backend-dev (revisado por claude-leader)
1. Estado final: DONE (aceptado por claude-leader).
2. Cambios: `shared/config.py` (Settings + `get_settings()` cacheada), `shared/errors.py` (AppError y formato común), `shared/logs.py` (middleware `X-Request-ID` + logging con `request_id`; el 500 se gestiona en el middleware para conservar la cabecera); `fastapi[standard-no-fastapi-cloud-cli]` y `pydantic-settings` como dependencias directas.
3. Revisión del Leader (añadido): `extra="ignore"` en Settings (si no, el `.env` de T-006 rompería el arranque); handler de `HTTPException` con códigos `unauthenticated`/`forbidden`/`not_found`/`method_not_allowed`/`http_error`; el 422 ya no devuelve `input`. Tres pruebas nuevas.
4. Pruebas: `uv run ruff format --check .` → 10 files already formatted · `uv run ruff check .` → All checks passed! · `uv run pytest -q` → 15 passed · humo `fastapi dev` + `curl /health` → 200 con `x-request-id` (hecho por backend-dev).
5. No ejecutadas: integración (sin BD en esta tarea), capas (aún no hay módulos), tipos (sin herramienta).
6. Riesgos aceptados: el access log de uvicorn duplica la línea de cada solicitud sin el id (en producción se usará `--no-access-log`, hito M1); `LOG_LEVEL` inválido aborta el arranque a propósito.

#### Traspaso T-015 — 2026-10-26 — backend-dev (revisado por claude-leader)
1. Estado final: DONE (aceptado por claude-leader).
2. Cambios: `shared/db.py` (`Base` en el esquema `app` con convención de nombres, `get_engine()` perezoso, `get_session()` + alias `SessionDep` con `scope="function"`); Alembic (`alembic.ini`, `migrations/env.py` limitado al esquema `app`, `version_table_schema="app"`, modo `--sql` rechazado); migración `0001` (REVOKE a `anon` y `authenticated`); `tests/conftest.py` (crea `valmont_test`, `upgrade head`, `db_session` con savepoint; exige el sufijo `_test`); marcador `integration`. Dependencias: sqlalchemy 2.1.6, psycopg[binary] 3.3.6, alembic 1.20.1.
3. Pruebas (reejecutadas por el Leader): `ruff format --check` → 16 files already formatted · `ruff check` → All checks passed! · `pytest -q` → 17 passed, 5 deselected · `pytest -m integration -q` → 5 passed · `alembic current` → 0001 (head) · `alembic check` → No new upgrade operations detected. backend-dev demostró además que sin `scope="function"` un fallo de commit devolvía 200.
4. Convenciones adoptadas (docs/modules.md §4.5 y §4.7): `SessionDep` obligatorio; `--rev-id` secuencial.
5. Riesgos: un `GRANT … TO PUBLIC` futuro sobre `app` anularía el REVOKE (la prueba de privilegios lo detectaría); las URLs de BD no son `SecretStr` (no registrar el objeto `Settings`).
