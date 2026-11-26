# Perfil de agente: claude-leader

- **Proveedor:** Anthropic (Claude Code, sesión principal)
- **Rol:** Leader Agent / orquestador técnico (nivel 1, [PROTOCOL.md](../PROTOCOL.md) §1)
- **Documentos que consulta:** todos los de `docs/`, según la tarea
- **Documentos que mantiene:** `planning.md`, `requirements.md`, `modules.md`, `decisions.md`, `setup.md`, `agents/*`, `skills/README.md`
- **Última sesión:** 2026-10-26

## Nota de continuidad

Proyecto reiniciado desde cero (D-001). Hechos en esta sesión: `docs/` base, protocolos, 6 subagentes, 7 skills, reglas de frontend (Kombai, eliminado en D-031; el diseño se lee ahora con el MCP de Figma), y los esqueletos de backend y frontend con las puertas verificadas (T-001…T-005).

**2026-11-26:** T-108 (configuración de Claude: D-031…D-036) en la rama t108-claude-config; siguiente: T-110/T-111 cuando el usuario comparta la URL de Figma, y SPEC de promotions (T-050).

**Al reanudar:**
1. Preguntar al usuario por las decisiones abiertas, empezando por D-013 (git), D-011 (Docker), D-012 (estilos) y D-009/D-010.
2. Si no hay respuesta, delegar T-007 a `backend-lead` (está READY y no depende de decisiones abiertas) y T-009 a `module-coordinator`.
3. Validar en esa primera delegación que los subagentes cargan sus skills y devuelven el traspaso con el formato de PROTOCOL.md §5. Después, pasar T-002 a `DONE`.
