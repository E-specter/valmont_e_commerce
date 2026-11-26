# Catálogo de skills del proyecto

> Las skills viven en `.claude/skills/<nombre>/SKILL.md`, formato estándar Agent Skills (front-matter `name` + `description`). Claude Code las carga solas; cualquier otro agente puede **leer el archivo** y seguir sus pasos, porque son Markdown sin dependencias de un proveedor.
> Las reglas que aplican (qué hacer y quién decide) están en `docs/`; las skills describen **cómo** hacerlo y citan `docs/` en vez de copiarlo.

## a) Skills del proyecto

| Skill | Para qué | Cuándo usarla | La precargan | Estado |
|---|---|---|---|---|
| [`context-handoff`](../../.claude/skills/context-handoff/SKILL.md) | Inicio de tarea con contexto mínimo, traspaso estructurado, compactación y reanudación | Al empezar y al terminar cualquier tarea; antes de compactar | todos los subagentes | IMPLEMENTADA |
| [`module-planning`](../../.claude/skills/module-planning/SKILL.md) | Crear o actualizar `SPEC.md` y `STATUS.md` de un módulo y descomponerlo en paquetes de tarea | Al iniciar un módulo o replanificarlo | backend-lead, frontend-lead, module-coordinator | IMPLEMENTADA |
| [`backend-module-implementation`](../../.claude/skills/backend-module-implementation/SKILL.md) | Implementar un caso de uso con arquitectura hexagonal + vertical slicing (las pruebas las escribe QA, D-033) | Tareas de backend | backend-dev | IMPLEMENTADA |
| [`frontend-module-implementation`](../../.claude/skills/frontend-module-implementation/SKILL.md) | Implementar páginas, componentes e islas Astro a partir de Figma MCP (D-031) | Tareas de frontend | frontend-lead, frontend-dev | IMPLEMENTADA |
| [`testing-and-quality-gates`](../../.claude/skills/testing-and-quality-gates/SKILL.md) | Puertas de calidad con comandos reales, política ante fallos y formato de evidencia | Antes de entregar o aceptar cualquier tarea | todos los subagentes | IMPLEMENTADA |
| [`api-contract-review`](../../.claude/skills/api-contract-review/SKILL.md) | Proponer, revisar y versionar contratos de API | Antes de crear o cambiar un endpoint | backend-lead, frontend-lead, qa-reviewer | IMPLEMENTADA |
| [`database-migration-review`](../../.claude/skills/database-migration-review/SKILL.md) | Revisar esquemas y migraciones: integridad, reversibilidad, riesgo destructivo | Antes de crear o aplicar una migración | backend-lead, backend-dev | IMPLEMENTADA (la herramienta depende de D-010) |
| [`version-control`](../../.claude/skills/version-control/SKILL.md) | Commits atómicos, informe de commits, paquete de push, integración en `main` y hooks | Al cerrar cada aporte atómico y antes de cada push | backend-lead, frontend-lead, module-coordinator, backend-dev, frontend-dev | IMPLEMENTADA (D-026) |
| `ai-tool-security-review` | Revisar herramientas del asistente: autorización, minimización, prompt injection | Fase 6 | — | PLANIFICADA (el prompt maestro §16.2 pide no crearla por anticipado) |

## b) Skills y herramientas externas por rol (D-035)

| Herramienta | Qué es | Quién la usa | Cuándo |
|---|---|---|---|
| ponytail | Plugin: cambio mínimo completo | todos | siempre |
| superpowers | Plugin de procesos | Leader: `brainstorming` antes de diseñar un módulo, `dispatching-parallel-agents`, `verification-before-completion` antes de declarar algo hecho. QA: `test-driven-development`, `systematic-debugging` ante fallos | según el proceso |
| claude-mem | Plugin de memoria | todos: `mem-search` antes de explorar. Leader: `work_state_write` para listas de trabajo | al empezar una tarea; al llevar listas de trabajo |
| find-skills | Skill de terceros (CLI `skills`) | Leader | cuando falte una capacidad; instalar requiere su aprobación |
| frontend-design | Plugin de acabado visual | frontend-lead, frontend-dev | acabado visual de la interfaz |
| modern-web-guidance | Skill de terceros (CLI `skills`) | frontend-dev, frontend-lead | obligatoria en HTML, CSS y JS de cliente |
| figma:figma-design-to-code / figma-code-connect | Skills del plugin `figma` | frontend-lead (extrae BRIEF/VIEWS); frontend-dev (por nodo) | implementar o extraer diseño desde Figma (D-031) |
| playwright | Plugin | QA: E2E y capturas; frontend-lead: fidelidad visual | pruebas de punta a punta y revisión visual |
| code-simplifier | Plugin (subagente) | Leader | sobre diffs preparados de más de ~200 líneas, antes de QA |
| context7 | Plugin (MCP, OAuth) | todos | documentación de FastAPI, SQLAlchemy, Alembic, Pydantic y Astro |
| MCP `astro-docs` | `.mcp.json` | frontend | dudas de Astro |
| MCP `supabase-local` | `.mcp.json` | backend-lead, QA | lectura y diagnóstico de la BD de desarrollo; el esquema solo cambia con Alembic |
| CLI oficiales | uv, `npx supabase`, astro, npm, git, skills | todos | comandos de `docs/setup.md` §3 |

La skill de usuario `actualizar-requerimientos-rf` no se usa en este proyecto (D-003). `coordinador-multiagente` se aplica junto con [PROTOCOL.md](../agents/PROTOCOL.md).

## Crear una skill nueva

Solo ante un procedimiento repetido que ya se haya hecho al menos una vez a mano. Carpeta `.claude/skills/<nombre-en-kebab-case>/SKILL.md`, menos de 500 líneas, `description` con el caso de uso al principio. Añadir su fila aquí y en `docs/agents/_registry.md` si crea documentos.
