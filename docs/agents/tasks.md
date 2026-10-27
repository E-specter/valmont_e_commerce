# Tablero de tareas

> Escritura aditiva: cada agente agrega o actualiza solo sus filas (skill `coordinador-multiagente` §6).
> Estados y plantillas: [PROTOCOL.md](PROTOCOL.md) §3, §5, §6. Los paquetes de las tareas de módulo viven en `docs/modules/<módulo>/STATUS.md`; los de tareas transversales, abajo.

| ID | Descripción | Rol | Agente | RF / D | Documentos | Estado | Notas de continuidad |
|---|---|---|---|---|---|---|---|
| T-001 | Base documental `docs/` desde cero | docs, arquitectura | claude-leader | OE07 | requirements, modules, planning, setup, decisions | DONE | — |
| T-002 | Protocolo de agentes, subagentes y skills | docs, arquitectura | claude-leader | OE07, D-004 | agents/PROTOCOL.md, skills/README.md | DONE | Validado con T-007: backend-dev cargó sus skills y entregó el traspaso de 11 puntos |
| T-003 | Configuración de Kombai y flujo Figma | ui | claude-leader | D-006 | design_ui/DESIGN.md, `.kombai/rules/` | DONE | Generar el `.ds` en T-010 |
| T-004 | Esqueleto backend FastAPI + uv con `/health` | arquitectura | claude-leader | D-007 | modules.md §4, setup.md §3 | DONE | ruff, pytest (1/1) y servidor con `curl` verificados |
| T-005 | Esqueleto frontend Astro 7 | arquitectura | claude-leader | D-008 | modules.md §5, setup.md §3 | DONE | `astro check` 0 errores, build OK |
| T-006 | Supabase local (CLI vía npx + `supabase/config.toml`) | arquitectura | claude-leader | D-011 | setup.md §3 | DONE | 7 contenedores sanos; Postgres 17.11; Auth y Mailpit responden 200; `backend/.env` creado (ignorado) |
| T-007 | Base del backend: configuración por entorno, errores centralizados, logging con id de solicitud | backend | backend-dev (revisa claude-leader) | RNF09, RNF05 | modules.md §4 | DONE | Traspaso abajo; 15 pruebas en verde |
| T-008 | SPEC del módulo `identity` | requisitos, backend | claude-leader | RF01, RF11.02, RF13, D-009 | docs/modules/identity/SPEC.md | IN_REVIEW | Perfil mínimo aprobado por el usuario; falta que el frontend revise el contrato |
| T-009 | SPEC del módulo `catalog` | requisitos | module-coordinator | RF02, RF06.01–03 | requirements.md RF02, RF06 | CANCELLED | Sustituida por T-025 (rango del módulo) |
| T-010 | Sistema de diseño Kombai (`.ds`) y primer componente desde Figma | ui | frontend-lead + Kombai | D-006, D-012 | design_ui/DESIGN.md | BLOCKED | Requiere D-012 y la URL del frame de Figma |
| T-011 | Inicializar git y commit base | — | usuario | D-013 | decisions.md D-013 | CANCELLED | Fusionada en T-012 |
| T-012 | Credenciales fuera del proyecto + `git init` + commit base | — | claude-leader + usuario | D-013 | decisions.md D-013 | DONE | Credenciales en `%USERPROFILE%\.claude-valmont`; commit base `f931a54` en `main`; trabajo en la rama `worktree-fase1-backend-db` |
| T-013 | Documentación al día con D-009…D-017 y correcciones de la auditoría | docs | claude-leader | D-009…D-017 | decisions, requirements, modules, skills | DONE | — |
| T-014 | Instalar Docker Desktop | arquitectura | claude-leader | D-011 | setup.md §1 | DONE | Docker Desktop 29.9.2 + Compose v5.6.1; `hello-world` OK |
| T-015 | Capa de datos: SQLAlchemy + Alembic, esquema `app`, BD de pruebas | backend | backend-dev (revisa claude-leader) | D-010 | modules.md §4 | DONE | Traspaso abajo; 17 pruebas unitarias + 5 de integración |
| T-016 | Autenticación: verificación del JWT, `app.profiles`, `current_user` / `require_admin` | backend, seguridad | backend-dev + qa-reviewer | RF01.05, RF13.01, RF13.02, D-009, D-018 | docs/modules/identity/STATUS.md | DONE | 2 rondas; qa-reviewer APROBADO; E2E con token ES256 real OK |
| T-017 | Ficha de lanzamiento `docs/deploy.md` (Windows 11 / Linux) | docs, arquitectura | claude-leader | D-011 | docs/deploy.md | IN_PROGRESS | Sección A verificada (A-11 parcial hasta la Fase 5); B pendiente de un equipo Linux; C en el hito M1 |
| T-105 | Protocolo de control de versiones: PROTOCOL §11, skill `version-control` y hooks de `.githooks/` (petición del usuario) | docs, arquitectura | claude-leader | D-026 | docs/agents/PROTOCOL.md §11 | DONE | Hooks probados (9/9 casos) y activos con `core.hooksPath` |
| T-106 | Las pruebas las ejecuta solo qa-reviewer, y el Leader hace el commit tras su APROBADO (petición del usuario) | docs, arquitectura | claude-leader | D-028 | docs/agents/PROTOCOL.md §1, §3, §5, §11 | DONE | Rige desde 2026-10-27; la ronda 2 de T-042 (`615189d`) es anterior |
| T-101 | Rol de BD `valmont_app` con privilegios mínimos (migración 0006) | backend, seguridad | backend-dev + qa-reviewer | D-029, RNF02 | paquete abajo | DONE | `b8eb2f9`; APROBADA por qa-reviewer con D-028 (704 + 267, 3 mutantes detectados). Los dos MENOR: uno en la skill de migraciones y otro en T-100 |
| T-102 | Imagen del frontend: `@astrojs/node` 11.1.9 (D-024), `output: 'static'` con adaptador standalone y `frontend/Dockerfile` | frontend, arquitectura | frontend-dev + qa-reviewer | D-024, D-029 | paquete abajo | DONE | `c8c8ace`; APROBADA por qa-reviewer con D-028. `output: 'static'` confirmado por el Leader (D-024). Sus dos MENOR (`init: true` y `**/.env*`) pasan a T-100 |
| T-100 | Imagen del backend y stack de despliegue `deploy/`: compose, Caddyfile, Supabase autohospedado fijado, `.env.example` y alta de la contraseña de `valmont_app` | backend, arquitectura | backend-dev + qa-reviewer | D-011, D-018, D-029 | paquete abajo | READY | Puerta Docker para los archivos; riesgo ES256. Pendiente de T-101: `ALTER ROLE valmont_app LOGIN PASSWORD` con el rol propietario (que necesita `CREATEROLE`); decidir si se revoca `CONNECT` en las BD ajenas; y su MENOR-1, que la prueba del mapa use `has_any_column_privilege` para SELECT, INSERT, UPDATE y REFERENCES |
| T-103 | Copias de seguridad: `pg_dump` diario y restauración probada (RNF12) | arquitectura | backend-dev + qa-reviewer | D-029, RNF12 | — | BACKLOG | — |
| T-104 | Prueba de lanzamiento en este Windows 11 (`https://localhost`) y sección C de la ficha verificada | arquitectura | claude-leader + qa-reviewer | D-029 | docs/deploy.md §C | BACKLOG | Build y arranque con puerta Docker |
| T-019 | Ajustes de contrato de identity tras la revisión de frontend-lead: `validation_error.details` sin `url` (solo `loc`, `type`, `msg`) y `Money.currency` obligatorio en el OpenAPI | backend | backend-dev | RF01.06 | docs/modules/identity/SPEC.md §7 | DONE | Hecho con T-027: `Money-Output` exige `amount` y `currency`; `details` = `loc`, `type`, `msg` |
| T-018 | Endurecimiento antes del lanzamiento: limpieza periódica de archivos huérfanos en Storage (T-029); JWKS no-JSON → 503 con aviso; no registrar el `DETAIL` de PostgreSQL (solo `sqlstate` y restricción); rechazar controles bidireccionales y nombres invisibles; límites de longitud documentados en el OpenAPI | backend, seguridad | backend-dev + qa-reviewer | RNF02, RNF10 | docs/modules/identity/STATUS.md | BACKLOG | Hallazgos menores de qa-reviewer en T-016; antes del hito M1 |

| T-020 | SPEC de audit | requisitos, backend | claude-leader | RF14 | docs/modules/audit/SPEC.md | DONE | Sin preguntas de negocio bloqueantes |
| T-021 | `app.audit_log` de solo inserción, `AuditRecorder` y `AuditRecorderDep` | backend | backend-dev (revisa claude-leader) | RF14.01, RF14.02 | docs/modules/audit/STATUS.md | DONE | 147 pruebas unitarias + 22 de integración; migración 0003 |
| T-025 | SPEC de catalog | requisitos, backend | claude-leader | RF02, RF06.01–03, RF06.07, D-019…D-023 | docs/modules/catalog/SPEC.md | DONE | Contrato revisado por frontend-lead; cambios incorporados |
| T-026…T-031 | Implementación de catalog | backend | backend-dev (+ qa-reviewer en T-028) | ver STATUS de catalog | docs/modules/catalog/STATUS.md | DONE | T-026…T-031 DONE (T-030: `cf22744`, verificada por qa-reviewer con D-028); queda un MENOR de pruebas para la próxima tarea de catalog |
| T-040 | SPEC de inventory | requisitos, backend | claude-leader | RF06.04–06, D-017, D-023, D-027 | docs/modules/inventory/SPEC.md | DONE | Decisiones del usuario D-027 |
| T-041…T-044 | Implementación de inventory | backend | backend-dev + qa-reviewer | ver STATUS de inventory | docs/modules/inventory/STATUS.md | DONE | T-041…T-044 DONE (última: `08cefce`); verificadas por qa-reviewer con D-028 desde T-042 |

**Rangos reservados para la Fase 2** (PROTOCOL §6): audit T-020–T-024 · catalog T-025–T-039 · inventory T-040–T-049 · promotions T-050–T-054 · cart T-055–T-064 · wishlist T-065–T-069 · orders T-070–T-089 · payments T-090–T-099 · hito M1 de lanzamiento T-100–T-104.

Estados válidos: `BACKLOG` · `SPECIFICATION` · `READY` · `IN_PROGRESS` · `BLOCKED` · `IN_REVIEW` · `INTEGRATION` · `DONE` · `CANCELLED`.

## Paquetes de tareas transversales

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
