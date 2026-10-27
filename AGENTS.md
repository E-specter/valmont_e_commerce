# Valmont_E_Commerce — Instrucciones para agentes

Comercio electrónico de alta relojería mecánica (Valmont): catálogo, carrito, pedidos, pagos simulados, backoffice, reportes y asistente de IA. Monorepo: `backend/` (FastAPI + uv) y `frontend/` (Astro). Aplica a **todo** agente: Claude Code, Kombai, Codex u otros.

## Fuente de verdad: `docs/`

| Necesitas | Lee |
|---|---|
| Qué construir: RF, RNF, reglas de negocio | `docs/requirements.md` (busca por ID, no lo leas entero) |
| Arquitectura, módulos, convenciones | `docs/modules.md` |
| Plan, fase y estado actual | `docs/planning.md` |
| Decisiones tomadas y pendientes | `docs/decisions.md` |
| Comandos, entorno, problemas conocidos | `docs/setup.md` |
| Diseño visual y flujo Figma → Kombai | `docs/design_ui/DESIGN.md` |
| Tareas | `docs/agents/tasks.md` · `docs/modules/<módulo>/STATUS.md` |
| Coordinación entre agentes, traspasos, contexto | `docs/agents/PROTOCOL.md` |
| Contexto original del usuario | `docs/prompt_maestro.md` (cita secciones, no lo cargues entero) |

**Orden de autoridad:** instrucciones del usuario y seguridad > decisiones aprobadas y contratos > requisitos > planes y STATUS > código > hipótesis. Si `docs/` y el código discrepan, registra la discrepancia; no la resuelvas en silencio.

## Protocolo mínimo

1. Antes de tocar código: identifica tu `task_id`, lee solo lo que cita su paquete y verifica el estado real del código.
2. Modifica solo lo autorizado en el paquete. Un cambio transversal se propone; no se implementa por tu cuenta.
3. No inventes endpoints, campos, reglas ni datos: marca `BLOCKED` y escala.
4. Ejecuta las puertas de calidad y reporta `comando → resultado`. Sin evidencia, nada "pasa".
5. Termina con el traspaso de `docs/agents/PROTOCOL.md` §5 y actualiza tu fila en `docs/agents/tasks.md` (escritura aditiva).
6. Cada aporte atómico completo va en su propio commit (`<tipo>(<ámbito>): <resumen> (T-NNN)`), solo con tus archivos y comunicado en tu traspaso. Nunca `push`, `--no-verify` ni commits en `main` (`docs/agents/PROTOCOL.md` §11, skill `version-control`).

## Reglas no negociables

- **Secretos:** nunca en código, `docs/` ni logs. `.env` no se versiona. Las credenciales de las herramientas viven fuera del proyecto (D-013).
- **Autorización siempre en el backend:** el frontend no decide permisos ni calcula importes.
- **Precio, stock y estado de pedidos** salen de la base de datos, nunca de la memoria de un modelo.
- **Un cliente solo accede a sus propios datos:** la identidad sale de la sesión validada, nunca de un id recibido.
- **Nada destructivo sin aprobación del usuario:** borrados masivos, `git reset --hard`, `git clean`, migraciones destructivas, producción.
- **Sin dependencias nuevas** sin aprobación del líder técnico del área.
- **Idioma:** interfaz y documentación en español; identificadores de código en inglés.

## Skills (procedimientos)

Viven en `.claude/skills/<nombre>/SKILL.md` y cualquier agente puede leerlas. Catálogo: `docs/skills/README.md`.
`context-handoff` · `module-planning` · `backend-module-implementation` · `frontend-module-implementation` · `testing-and-quality-gates` · `api-contract-review` · `database-migration-review` · `version-control`

## Comandos

- **Backend** (`cd backend`): `uv sync` · `uv run fastapi dev src/valmont/main.py` · `uv run pytest -q` · `uv run ruff check .` · `uv run ruff format --check .`
- **Frontend** (`cd frontend`): `npm install` · `npx astro dev --background` · `npm run check` · `npm run build`

## Frontend y Kombai

Figma → Kombai → `frontend/src/components/<área>/` → revisión con `docs/design_ui/DESIGN.md` §9. Las reglas específicas de Kombai están en `.kombai/rules/valmont-frontend.md`.
