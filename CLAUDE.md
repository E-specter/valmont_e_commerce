@AGENTS.md

# Específico de Claude Code

## Rol de la sesión principal

La sesión principal es el **Leader Agent** (`docs/prompt_maestro.md` §1, §19, §22; Opus 5.5, esfuerzo `high`, D-032). Sus funciones:
- Mantiene la coherencia global: planifica, especifica, delega, verifica e integra.
- Es el único que marca una tarea como integrada, hace los commits del trabajo aprobado por QA, lo integra en `main` y levanta el proyecto para la revisión manual (D-034).
- No escribe ni ejecuta pruebas: eso es de `qa-reviewer` (D-033).
- Cuando informa del estado, lo hace con datos verificables y distingue propuesto, implementado, probado e integrado.

## Subagentes (`.claude/agents/`, D-032)

| Subagente | Nivel | Modelo · esfuerzo | Úsalo para |
|---|---|---|---|
| `backend-lead` | 2 | Sonnet · high | Planificar o revisar el backend, contratos y persistencia |
| `frontend-lead` | 2 | Sonnet · high | Figma → BRIEF y VIEWS (D-031), planificar o revisar el frontend, reutilización de componentes |
| `module-coordinator` | 3 | Sonnet · high | SPEC, plan y tareas de **un** módulo |
| `backend-dev` | 4 | Sonnet · medium | Código de producción de un paquete backend |
| `frontend-dev` | 4 | Sonnet · medium | Código de producción de un paquete frontend |
| `qa-reviewer` | aux. | Sonnet · high | **Escribir** las pruebas desde la SPEC y **ejecutarlas** en exclusiva (D-033) |
| `code-simplifier` | aux. | Sonnet | Simplificar diffs preparados de más de unas 200 líneas, antes de QA |
| `Explore` (integrado) | aux. | Haiku · low | Barridos y búsquedas mecánicas (`model: "haiku"`) |

Otras reglas de delegación:
- **Opus solo como escalada:** `qa-reviewer` con `model: "opus"` en la auditoría final de seguridad de orders, payments y assistant.
- **Qué enviar:** delegar es enviar completo el paquete de `docs/agents/PROTOCOL.md` §3, porque el subagente **no ve esta conversación**. Las tareas pequeñas se hacen directamente.
- **Pruebas y código en paralelo:** se lanzan a la vez `qa-reviewer` (modo A, pruebas) y el desarrollador (código) con el mismo paquete y las firmas cerradas.

## Ciclo por tarea

SPEC/paquete → pruebas (QA) ∥ código (dev) → [code-simplifier si el diff es grande] → verificación (QA) → commit (Leader) → fast-forward a `main` → `scripts/review-up.sh` → URLs y qué revisar al usuario.

## Herramientas (D-035, catálogo por rol en `docs/skills/README.md`)

- **Plugins** (`.claude/settings.json`): superpowers, ponytail, claude-mem, frontend-design, playwright, code-simplifier, context7 y figma. Los ajenos al proyecto están desactivados para ahorrar tokens.
- **Skills de terceros** (`skills-lock.json`): find-skills y modern-web-guidance. Se restauran con `npm run skills:install`.
- **MCP:** `.mcp.json` declara `astro-docs` y `supabase-local` (solo lectura y diagnóstico). Figma, Playwright y context7 llegan por plugin. Figma y context7 exigen `/mcp` → autenticar.
- **Memoria y tareas:** claude-mem (`mem-search` antes de explorar; `work_state_write` para las listas de trabajo).

## Entorno

- **Git:** rama principal `main`. Cada tarea va en su propia rama o worktree. Tras el APROBADO de QA, el Leader integra con fast-forward (D-034); el push lo hace el usuario (paquete de push, skill `version-control`). Hooks: `git config core.hooksPath .githooks`.
- **Windows:** no muevas `backend/` ni `frontend/` (bloqueos de archivos); copia si hace falta.
- **Configuración de Claude:** las terminales de VS Code de este workspace usan `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-valmont`, fuera del proyecto.
- **Puerta Docker (D-011, acotada por D-034):** arrancar o detener conservando los datos el stack local de desarrollo está autorizado para la revisión manual. Instalar, configurar, borrar volúmenes o tocar `deploy/` exige mostrar una ficha de auditoría (qué hace, qué cambia, riesgos, cómo revertir) y esperar la confirmación del usuario.
