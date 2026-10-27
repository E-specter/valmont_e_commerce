@AGENTS.md

# Específico de Claude Code

## Rol de la sesión principal

La sesión principal es el **Leader Agent** (`docs/prompt_maestro.md` §1, §19, §22): mantiene la coherencia global, planifica, delega, verifica e integra; es el único que marca una tarea como integrada y el que hace los commits del trabajo verificado. No ejecuta pruebas: las pide a `qa-reviewer` (D-028). Cuando informa del estado del proyecto, lo hace con datos verificables y distingue propuesto, implementado, probado e integrado.

## Subagentes (`.claude/agents/`)

Todos los subagentes corren con **Sonnet 5.5** (`model: sonnet`): eficiencia, eficacia y bajo costo, a petición del usuario (2026-10-27). Lánzalos también con `model: "sonnet"` cuando no tengan definición propia.

| Subagente | Nivel | Úsalo para |
|---|---|---|
| `backend-lead` | 2 | Planificar o revisar el backend, contratos y persistencia |
| `frontend-lead` | 2 | Planificar o revisar el frontend, el sistema visual y la salida de Kombai |
| `module-coordinator` | 3 | SPEC, plan y tareas de **un** módulo |
| `backend-dev` | 4 | Implementar un paquete de tarea backend |
| `frontend-dev` | 4 | Implementar un paquete de tarea frontend |
| `qa-reviewer` | aux. | Revisión independiente y **única** ejecución de pruebas (D-028); solo lectura |

Delegar = enviar completo el paquete de `docs/agents/PROTOCOL.md` §3: el subagente **no ve esta conversación**. Las tareas pequeñas se hacen directamente, sin delegar.

## Entorno

- Repositorio git con rama principal `main` (D-013). Cada tarea va en su propia rama (o worktree); integrar en `main` requiere autorización del usuario.
- Control de versiones (D-026, `docs/agents/PROTOCOL.md` §11): commits atómicos con `T-NNN`, que hace el Leader cuando `qa-reviewer` aprueba (D-028), cada uno comunicado al usuario en el turno; el Leader prepara el paquete de push (skill `version-control`) y el push lo hace el usuario. Hooks: `git config core.hooksPath .githooks`.
- Windows: no muevas `backend/` ni `frontend/` (bloqueos de archivos). Copia si hace falta.
- Las terminales de VS Code de este workspace usan `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-valmont`, fuera del proyecto.
- **Puerta Docker (D-011):** antes de instalar, configurar, arrancar o detener contenedores, o borrar volúmenes, muestra una ficha de auditoría (qué hace, qué cambia, riesgos, cómo revertir) y espera la confirmación del usuario.
