# Valmont_E_Commerce — Instrucciones para agentes

Comercio electrónico de alta relojería mecánica (Valmont): catálogo, carrito, pedidos, pagos simulados, backoffice, reportes y asistente de IA. Monorepo: `backend/` (FastAPI + uv) y `frontend/` (Astro). Aplica a **todo** agente: Claude Code, Codex u otros.

## Fuente de verdad: `docs/`

| Necesitas | Lee |
|---|---|
| Qué construir: RF, RNF, reglas de negocio | `docs/requirements.md` (busca por ID, no lo leas entero) |
| Arquitectura, módulos, convenciones | `docs/modules.md` |
| Plan, fase y estado actual | `docs/planning.md` |
| Decisiones tomadas y pendientes | `docs/decisions.md` |
| Comandos, entorno, problemas conocidos | `docs/setup.md` |
| Diseño: brief de marca, vistas y componentes (Figma, D-031) | `docs/design_ui/DESIGN.md` → `BRIEF.md` · `VIEWS.md` |
| Tareas | `docs/agents/tasks.md` · `docs/modules/<módulo>/STATUS.md` |
| Coordinación entre agentes, traspasos, contexto, tokens | `docs/agents/PROTOCOL.md` |
| Skills y herramientas por rol | `docs/skills/README.md` |
| Contexto original del usuario | `docs/prompt_maestro.md` (cita secciones, no lo cargues entero) |

**Orden de autoridad:** instrucciones del usuario y seguridad > decisiones aprobadas y contratos > requisitos > planes y STATUS > código > hipótesis. Si `docs/` y el código discrepan, registra la discrepancia; no la resuelvas en silencio.

## Protocolo mínimo

1. Antes de tocar código: identifica tu `task_id`, lee solo lo que cita su paquete y verifica el estado real del código.
2. Modifica solo lo autorizado en el paquete. Un cambio transversal se propone; no se implementa por tu cuenta.
3. No inventes endpoints, campos, reglas ni datos: marca `BLOCKED` y escala.
4. **Las pruebas las escribe y ejecuta solo QA** (`qa-reviewer`, D-028 y D-033).
   - Quien implementa escribe solo código de producción y solo puede pasar el análisis estático (`ruff format`, `ruff check`, `npm run check`), que no cuenta como evidencia.
   - Sin evidencia de QA (`comando → resultado`), nada "pasa".
5. **Reutiliza antes de crear:** helpers, servicios y componentes existentes (mapa de módulos en `docs/modules.md`; componentes en `docs/design_ui/VIEWS.md`). El código genérico va en `shared/` (backend) o `components/ui/` (frontend).
6. Termina con el traspaso de `docs/agents/PROTOCOL.md` §5 (40 líneas como máximo) y actualiza tu fila en `docs/agents/tasks.md` (escritura aditiva).
7. **Commits** (`docs/agents/PROTOCOL.md` §11, skill `version-control`):
   - Cada aporte atómico completo va en su propio commit (`<tipo>(<ámbito>): <resumen> (T-NNN)`), que hace el Leader cuando `qa-reviewer` lo aprueba, y que después integra en `main` (D-034).
   - Quien implementa deja preparados solo sus archivos (`git add <rutas>`, sin commit) y propone el mensaje.
   - Nunca `push`, `--no-verify` ni commits directos en `main`.

## Reglas no negociables

- **Secretos:** nunca en código, `docs/` ni logs. `.env` no se versiona. Las credenciales de las herramientas viven fuera del proyecto (D-013).
- **Autorización siempre en el backend:** el frontend no decide permisos ni calcula importes.
- **Precio, stock y estado de pedidos** salen de la base de datos, nunca de la memoria de un modelo.
- **Un cliente solo accede a sus propios datos:** la identidad sale de la sesión validada, nunca de un id recibido.
- **Nada destructivo sin aprobación del usuario:** borrados masivos, `git reset --hard`, `git clean`, migraciones destructivas, producción.
- **Sin dependencias nuevas** sin aprobación del líder técnico del área.
- **Idioma:** interfaz y documentación en español; identificadores de código en inglés.

## Skills (procedimientos)

- **Del proyecto**, en `.claude/skills/<nombre>/SKILL.md`: `context-handoff` · `module-planning` · `backend-module-implementation` · `frontend-module-implementation` · `testing-and-quality-gates` · `api-contract-review` · `database-migration-review` · `version-control`.
- **Externas** (D-035): ponytail · superpowers · claude-mem · frontend-design · modern-web-guidance · playwright · code-simplifier · context7 · find-skills · figma.
- Qué usa cada rol y cuándo: `docs/skills/README.md`.

## Comandos

- **Backend** (`cd backend`): `uv sync` · `uv run fastapi dev src/valmont/main.py` · `uv run ruff check .` · `uv run ruff format --check .` (las pruebas, solo QA: `uv run pytest -q`)
- **Frontend** (`cd frontend`): `npm install` · `npx astro dev --background` · `npm run check` (build y pruebas, solo QA)
- **Revisión manual en `main`** (Leader, D-034): `bash scripts/review-up.sh`

## Frontend y Figma (D-031)

Figma (MCP) → `docs/design_ui/BRIEF.md` (tokens y marca) y `VIEWS.md` (vistas → componentes) → componentes `ui/` reutilizables → vistas en `frontend/src/` → revisión con `docs/design_ui/DESIGN.md` §9 y captura de Playwright frente al frame.
