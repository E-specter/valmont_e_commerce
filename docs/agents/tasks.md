# Tablero de tareas

> Escritura aditiva: cada agente agrega o actualiza solo sus filas (skill `coordinador-multiagente` §6).
> Estados y plantillas: [PROTOCOL.md](PROTOCOL.md) §3, §5, §6. Los paquetes de las tareas de módulo viven en `docs/modules/<módulo>/STATUS.md`; los de tareas transversales, abajo.

| ID | Descripción | Rol | Agente | RF / D | Documentos | Estado | Notas de continuidad |
|---|---|---|---|---|---|---|---|
| T-001 | Base documental `docs/` desde cero | docs, arquitectura | claude-leader | OE07 | requirements, modules, planning, setup, decisions | DONE | — |
| T-002 | Protocolo de agentes, subagentes y skills | docs, arquitectura | claude-leader | OE07, D-004 | agents/PROTOCOL.md, skills/README.md | IN_REVIEW | Validar con la primera delegación real (T-007) |
| T-003 | Configuración de Kombai y flujo Figma | ui | claude-leader | D-006 | design_ui/DESIGN.md, `.kombai/rules/` | DONE | Generar el `.ds` en T-010 |
| T-004 | Esqueleto backend FastAPI + uv con `/health` | arquitectura | claude-leader | D-007 | modules.md §4, setup.md §3 | DONE | ruff, pytest (1/1) y servidor con `curl` verificados |
| T-005 | Esqueleto frontend Astro 7 | arquitectura | claude-leader | D-008 | modules.md §5, setup.md §3 | DONE | `astro check` 0 errores, build OK |
| T-006 | Supabase local (CLI vía npx + `supabase/config.toml`) | arquitectura | claude-leader | D-011 | setup.md §4 | BLOCKED | Espera a T-014; requiere la puerta Docker |
| T-007 | Base del backend: configuración por entorno, errores centralizados, logging con id de solicitud | backend | backend-dev (revisa claude-leader) | RNF09, RNF05 | modules.md §4 | READY | Paquete abajo; arranca después del commit base (T-012) |
| T-008 | SPEC del módulo `identity` | requisitos, backend | claude-leader | RF01, RF11.02, RF13, D-009 | requirements.md RF01, RF13 | READY | Preguntar al usuario los campos del perfil (Ley 29733) |
| T-009 | SPEC del módulo `catalog` | requisitos | module-coordinator | RF02, RF06.01–03 | requirements.md RF02, RF06 | READY | Usar la skill `module-planning` |
| T-010 | Sistema de diseño Kombai (`.ds`) y primer componente desde Figma | ui | frontend-lead + Kombai | D-006, D-012 | design_ui/DESIGN.md | BLOCKED | Requiere D-012 y la URL del frame de Figma |
| T-011 | Inicializar git y commit base | — | usuario | D-013 | decisions.md D-013 | CANCELLED | Fusionada en T-012 |
| T-012 | Credenciales fuera del proyecto + `git init` + commit base | — | claude-leader + usuario | D-013 | decisions.md D-013 | DONE | Credenciales en `%USERPROFILE%\.claude-valmont`; commit base `f931a54` en `main`; trabajo en la rama `worktree-fase1-backend-db` |
| T-013 | Documentación al día con D-009…D-017 y correcciones de la auditoría | docs | claude-leader | D-009…D-017 | decisions, requirements, modules, skills | DONE | — |
| T-014 | Instalar Docker Desktop | arquitectura | claude-leader | D-011 | setup.md §1 | IN_PROGRESS | Confirmado por el usuario el 2026-10-26; instalación con winget en curso |
| T-015 | Capa de datos: SQLAlchemy + Alembic, esquema `app`, BD de pruebas | backend | claude-leader / backend-dev | D-010 | modules.md §4 | BACKLOG | Depende de T-006 |
| T-016 | Autenticación: verificación del JWT, `app.profiles`, `current_user` / `require_admin` | backend, seguridad | backend-dev + qa-reviewer | RF01.05, RF13.01, RF13.02, D-009 | SPEC de identity | BACKLOG | Depende de T-008 y T-015 |
| T-017 | Ficha de lanzamiento `docs/deploy.md` (Windows 11 / Linux) | docs, arquitectura | claude-leader | D-011 | setup.md | BACKLOG | Los pasos de desarrollo se escriben al verificarse en T-014…T-016 |

**Rangos reservados para la Fase 2** (PROTOCOL §6): audit T-020–T-024 · catalog T-025–T-039 · inventory T-040–T-049 · promotions T-050–T-054 · cart T-055–T-064 · wishlist T-065–T-069 · orders T-070–T-089 · payments T-090–T-099 · hito M1 de lanzamiento T-100–T-104.

Estados válidos: `BACKLOG` · `SPECIFICATION` · `READY` · `IN_PROGRESS` · `BLOCKED` · `IN_REVIEW` · `INTEGRATION` · `DONE` · `CANCELLED`.

## Paquetes de tareas transversales

### T-007 — Base del backend (configuración, errores, logging)
- Objetivo: el backend carga su configuración por entorno, responde a cualquier error con un formato JSON único y registra cada solicitud con un id.
- Responsable: backend-dev (revisa claude-leader) · Módulo: plataforma (`shared/`) · Requisitos: RNF09, RNF05, RNF02
- Leer: `docs/modules.md` §4 y §7; `backend/src/valmont/main.py`; `backend/tests/test_health.py`
- Contratos aplicables: formato de error de `modules.md` §4.4
- Dependencias: ninguna
- Puede modificar: `backend/src/valmont/main.py`, `backend/src/valmont/shared/**`, `backend/tests/**`, `backend/.env.example`, y `backend/pyproject.toml` + `backend/uv.lock` solo para dos cosas: `uv add pydantic-settings` (hoy llega de forma transitiva) y cambiar `fastapi[standard]` por `fastapi[standard-no-fastapi-cloud-cli]` (auditoría #16)
- Protegido: `frontend/**`, `docs/**` (salvo el traspaso en este archivo)
- Resultado esperado: `shared/config.py` (Settings con `ENVIRONMENT`), `shared/errors.py` (excepción base de la app + handlers), middleware de id de solicitud (`X-Request-ID`), `.env.example`
- Criterios de aceptación: (1) un error de dominio de prueba devuelve `{"error": {"code", "message", "details"}}` con el código HTTP correcto; (2) un error no controlado devuelve 500 con el mismo formato y sin traza; (3) toda respuesta incluye `X-Request-ID`: se reutiliza el entrante solo si cumple `^[A-Za-z0-9-]{1,64}$` (si no, se genera un UUID4, para evitar inyección en logs), y cada línea de log de la solicitud lleva ese id; (4) `/health` sigue funcionando y `uv run fastapi dev src/valmont/main.py` arranca
- Pruebas obligatorias: `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, con pruebas nuevas para (1)–(3)
- Seguridad: no exponer trazas ni datos internos en las respuestas; no registrar cabeceras de autorización
- Estado inicial: READY
- IDs reservados: ninguno (tarea hoja)
- Escalar si: hace falta otra dependencia, o el formato de error no cubre un caso
