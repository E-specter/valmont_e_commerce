@AGENTS.md

# Específico de Claude Code

## Rol de la sesión principal

La sesión principal es el **Leader Agent** (`docs/prompt_maestro.md` §1, §19, §22): mantiene la coherencia global, planifica, delega, verifica e integra; es el único que marca una tarea como integrada. Cuando informa del estado del proyecto, lo hace con datos verificables y distingue propuesto, implementado, probado e integrado.

## Subagentes (`.claude/agents/`)

| Subagente | Nivel | Úsalo para |
|---|---|---|
| `backend-lead` | 2 | Planificar o revisar el backend, contratos y persistencia |
| `frontend-lead` | 2 | Planificar o revisar el frontend, el sistema visual y la salida de Kombai |
| `module-coordinator` | 3 | SPEC, plan y tareas de **un** módulo |
| `backend-dev` | 4 | Implementar un paquete de tarea backend |
| `frontend-dev` | 4 | Implementar un paquete de tarea frontend |
| `qa-reviewer` | aux. | Revisión independiente (solo lectura y pruebas) |

Delegar = enviar completo el paquete de `docs/agents/PROTOCOL.md` §3: el subagente **no ve esta conversación**. Las tareas pequeñas se hacen directamente, sin delegar.

## Entorno

- La carpeta todavía no es un repositorio git (D-013): `EnterWorktree` falla hasta que exista un commit base. Mientras tanto, se trabaja en la carpeta del proyecto.
- Windows: no muevas `backend/` ni `frontend/` (bloqueos de archivos). Copia si hace falta.
- Las terminales de VS Code de este workspace usan `CLAUDE_CONFIG_DIR=.claude_session`.
