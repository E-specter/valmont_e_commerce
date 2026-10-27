# Registro de documentación del proyecto (`docs/`)

> Índice vivo de todo lo que existe bajo `docs/`. Quien agregue o descubra una ruta nueva añade su fila aquí en la misma sesión (skill `coordinador-multiagente` §5). No se borran filas salvo que la ruta se elimine y el usuario lo confirme.

| Ruta | Tipo | Propósito | Equivale en el prompt maestro §9 | Mantiene | Última actualización |
|---|---|---|---|---|---|
| docs/prompt_maestro.md | Doc | Contexto inicial original del usuario, copia literal | — (fuente) | usuario (solo lectura para agentes) | 2026-10-26 |
| docs/planning.md | Doc | Plan maestro, fases, estado actual, riesgos, estrategia de pruebas | ROADMAP, CURRENT_STATE, TEST_STRATEGY | claude-leader | 2026-10-26 |
| docs/requirements.md | Doc | Objetivos, alcance, glosario, RF, RNF, RN, hipótesis | PROJECT_OVERVIEW, SCOPE, GLOSSARY, REQUIREMENTS | claude-leader | 2026-10-26 |
| docs/modules.md | Doc | Arquitectura, módulos, convenciones, contratos, seguridad, modelo de datos | SYSTEM_ARCHITECTURE, MODULE_MAP, SECURITY_MODEL, DATA_MODEL, API_CONTRACTS (política) | claude-leader | 2026-10-26 |
| docs/decisions.md | Doc | Registro de decisiones (ADR) | ARCHITECTURE_DECISIONS, DECISION_LOG | claude-leader | 2026-10-26 |
| docs/setup.md | Doc | Herramientas, estructura del repo, comandos, entornos, MCP, problemas conocidos | RUNBOOK, ENVIRONMENTS, TROUBLESHOOTING | claude-leader | 2026-10-26 |
| docs/design_ui/ | Carpeta | Guía de diseño de interfaz y marca | — | frontend-lead | 2026-10-26 |
| docs/design_ui/DESIGN.md | Doc | Principios, tokens provisionales, componentes, flujo Figma → Kombai | — | frontend-lead | 2026-10-26 |
| docs/skills/ | Carpeta | Catálogo de skills del proyecto | — | claude-leader | 2026-10-26 |
| docs/skills/README.md | Doc | Catálogo de skills (las skills viven en `.claude/skills/`) | — | claude-leader | 2026-10-26 |
| docs/agents/ | Carpeta | Coordinación multiagente | 04-agents | claude-leader | 2026-10-26 |
| docs/agents/_registry.md | Doc | Este índice | — | todos (aditivo) | 2026-10-26 |
| docs/agents/tasks.md | Doc | Tablero de tareas + paquetes transversales | TASK_BOARD | todos (aditivo) | 2026-10-26 |
| docs/agents/PROTOCOL.md | Doc | Jerarquía, inicio, paquete de tarea, traspaso, estados, contexto | AGENT_PROTOCOL, AGENT_REGISTRY, HANDOFF_PROTOCOL, CONTEXT_POLICY | claude-leader | 2026-10-26 |
| docs/agents/claude-leader/profile.md | Doc | Perfil y nota de continuidad del Leader | — | claude-leader | 2026-10-26 |
| docs/deploy.md | Doc | Ficha de lanzamiento: desarrollo en Windows 11 y Linux, y lanzamiento con Docker Compose | RUNBOOK (lanzamiento) | claude-leader | 2026-10-26 |
| docs/modules/identity/ | Carpeta | SPEC y STATUS del módulo identity | 03-modules/identity | claude-leader | 2026-10-26 |
| docs/modules/audit/ | Carpeta | SPEC y STATUS del módulo audit | 03-modules/audit | claude-leader | 2026-10-27 |
| docs/modules/<módulo>/ | Carpeta (se crea al especificar cada módulo) | `SPEC.md` (especificación, contrato y plan de pruebas) + `STATUS.md` (plan, tareas y traspasos) | 03-modules/* | module-coordinator | — |

**Sin equivalente propio (por diseño):** QUALITY_GATES y RELEASE_CHECKLIST → skill `testing-and-quality-gates`; EVENTS_AND_STATES y DOMAIN_CONTRACTS → SPEC del módulo dueño; CHANGELOG → historial de git (D-013) + `decisions.md`.

## Pendientes de incorporar formalmente a la skill

Rutas que no encajan en la sección 1 de `coordinador-multiagente/SKILL.md`. Se listan hasta que el usuario pida actualizar la skill.

| Ruta | Propósito | Detectada por | Fecha |
|---|---|---|---|
| docs/decisions.md | Registro de decisiones | claude-leader | 2026-10-26 |
| docs/prompt_maestro.md | Contexto inicial original | claude-leader | 2026-10-26 |
| docs/agents/PROTOCOL.md | Protocolo multiagente detallado | claude-leader | 2026-10-26 |
| docs/modules/ | Especificación y estado por módulo | claude-leader | 2026-10-26 |
