# Catálogo de skills del proyecto

> Las skills viven en `.claude/skills/<nombre>/SKILL.md`, formato estándar Agent Skills (front-matter `name` + `description`). Claude Code las carga solas; cualquier otro agente puede **leer el archivo** y seguir sus pasos, porque son Markdown sin dependencias de un proveedor.
> Las reglas que aplican (qué hacer y quién decide) están en `docs/`; las skills describen **cómo** hacerlo y citan `docs/` en vez de copiarlo.

| Skill | Para qué | Cuándo usarla | La precargan | Estado |
|---|---|---|---|---|
| [`context-handoff`](../../.claude/skills/context-handoff/SKILL.md) | Inicio de tarea con contexto mínimo, traspaso estructurado, compactación y reanudación | Al empezar y al terminar cualquier tarea; antes de compactar | todos los subagentes | IMPLEMENTADA |
| [`module-planning`](../../.claude/skills/module-planning/SKILL.md) | Crear o actualizar `SPEC.md` y `STATUS.md` de un módulo y descomponerlo en paquetes de tarea | Al iniciar un módulo o replanificarlo | backend-lead, frontend-lead, module-coordinator | IMPLEMENTADA |
| [`backend-module-implementation`](../../.claude/skills/backend-module-implementation/SKILL.md) | Implementar un caso de uso con arquitectura hexagonal + vertical slicing y TDD | Tareas de backend | backend-dev | IMPLEMENTADA |
| [`frontend-module-implementation`](../../.claude/skills/frontend-module-implementation/SKILL.md) | Implementar páginas, componentes e islas Astro e integrar la salida de Kombai/Figma | Tareas de frontend | frontend-lead, frontend-dev | IMPLEMENTADA |
| [`testing-and-quality-gates`](../../.claude/skills/testing-and-quality-gates/SKILL.md) | Puertas de calidad con comandos reales, política ante fallos y formato de evidencia | Antes de entregar o aceptar cualquier tarea | todos los subagentes | IMPLEMENTADA |
| [`api-contract-review`](../../.claude/skills/api-contract-review/SKILL.md) | Proponer, revisar y versionar contratos de API | Antes de crear o cambiar un endpoint | backend-lead, frontend-lead, qa-reviewer | IMPLEMENTADA |
| [`database-migration-review`](../../.claude/skills/database-migration-review/SKILL.md) | Revisar esquemas y migraciones: integridad, reversibilidad, riesgo destructivo | Antes de crear o aplicar una migración | backend-lead, backend-dev | IMPLEMENTADA (la herramienta depende de D-010) |
| `ai-tool-security-review` | Revisar herramientas del asistente: autorización, minimización, prompt injection | Fase 6 | — | PLANIFICADA (el prompt maestro §16.2 pide no crearla por anticipado) |

## Skills externas (nivel usuario, no versionadas en este repo)

| Skill | Uso en este proyecto |
|---|---|
| `coordinador-multiagente` | Convención de `docs/`, registro y tablero. Se aplica junto con [PROTOCOL.md](../agents/PROTOCOL.md). |
| `actualizar-requerimientos-rf` | **No aplica** (dominio de cobranzas; renumera los RF). Ver D-003. |

## Kombai

Kombai lee sus skills de `.kombai/skills/`, no de `.claude/skills/`. Se le aplican `AGENTS.md` y `.kombai/rules/valmont-frontend.md`; no se duplican skills para él mientras no haya una necesidad observada.

## Crear una skill nueva

Solo ante un procedimiento repetido que ya se haya hecho al menos una vez a mano. Carpeta `.claude/skills/<nombre-en-kebab-case>/SKILL.md`, menos de 500 líneas, `description` con el caso de uso al principio. Añadir su fila aquí y en `docs/agents/_registry.md` si crea documentos.
