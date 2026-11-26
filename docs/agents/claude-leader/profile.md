# Perfil de agente: claude-leader

- **Proveedor:** Anthropic (Claude Code, sesión principal)
- **Rol:** Leader Agent / orquestador técnico (nivel 1, [PROTOCOL.md](../PROTOCOL.md) §1)
- **Documentos que consulta:** todos los de `docs/`, según la tarea
- **Documentos que mantiene:** `planning.md`, `requirements.md`, `modules.md`, `decisions.md`, `setup.md`, `agents/*`, `skills/README.md`
- **Última sesión:** 2026-10-26

## Nota de continuidad

Proyecto reiniciado desde cero (D-001). Hechos en esta sesión: `docs/` base, protocolos, 6 subagentes, 7 skills, reglas de frontend (Kombai, eliminado en D-031; el diseño se lee ahora con el MCP de Figma), y los esqueletos de backend y frontend con las puertas verificadas (T-001…T-005).

**2026-11-26:** T-108 (configuración de Claude: D-031…D-036) en la rama t108-claude-config; siguiente: T-110/T-111 cuando el usuario comparta la URL de Figma, y SPEC de promotions (T-050).

**Al reanudar (2026-11-26, la sesión sigue en el chat del proyecto con `.claude-valmont`):**
1. Leer `docs/planning.md` §Estado actual, `docs/agents/tasks.md` (filas T-070, T-071…T-084, T-110, T-111) y `docs/modules/orders/STATUS.md` §T-071 y §T-072.
2. Lanzar en paralelo:
   - frontend-lead con T-110+T-111 (Figma conectado, una sola pasada, cada nodo una vez).
   - backend-dev ∥ qa-reviewer (modo A) con T-071+T-072, en el worktree de orders; luego qa-reviewer en modo B → commit → `main` → `scripts/review-up.sh`.
3. Los worktrees se crean desde `main` local (`git worktree add -b <rama> .claude/worktrees/<nombre> main`) y se retiran al integrar. Hay que copiar `backend/.env` al worktree.
4. Las preguntas de negocio, con AskUserQuestion: opciones fundamentadas y una recomendada.
