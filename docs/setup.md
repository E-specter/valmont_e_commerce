# Entorno y operación — Valmont_E_Commerce

> Fuente canónica de herramientas, estructura del repositorio, comandos, entornos y problemas conocidos.
> Las versiones marcadas como "verificada" se comprobaron ejecutándolas el 2026-10-26.

## 1. Herramientas de la máquina de desarrollo

| Herramienta | Versión verificada | Uso |
|---|---|---|
| git | 2.56.0 | Control de versiones (repositorio aún no inicializado, D-013) |
| Node.js / npm | 26.12.1 / 12.2.1 | Frontend |
| uv | 0.12.1 | Backend: intérprete, dependencias y ejecución |
| Python (gestionado por uv) | 3.14.7 | Backend (`backend/.python-version`) |
| VS Code | 1.143.1 | Extensiones: Kombai 2.0.158, Astro 2.16.20, Figma 0.4.8 |
| Docker | **no instalado** | Necesario para Supabase self-hosted (D-011) |
| Supabase CLI / psql | **no instalados** | — |
| WSL2 (Ubuntu) | presente | Candidato para Docker Engine (D-011) |

## 2. Estructura del repositorio

```
valmont_e_commerce/
├── AGENTS.md                 instrucciones comunes a TODOS los agentes (Claude, Kombai, Codex…)
├── CLAUDE.md                 importa AGENTS.md + específico de Claude Code
├── backend/                  API FastAPI (uv)
├── frontend/                 sitio Astro (npm); frontend/AGENTS.md = guía oficial de Astro
├── docs/                     fuente de verdad (ver docs/agents/_registry.md)
├── .claude/
│   ├── agents/               subagentes de Claude Code (jerarquía, D-004)
│   └── skills/               skills del proyecto (catálogo: docs/skills/README.md)
├── .kombai/
│   ├── rules/                reglas de proyecto que Kombai aplica siempre
│   ├── design-systems/       sistema de diseño .ds de Kombai (se genera desde docs/design_ui/DESIGN.md)
│   └── canvas/               diseños .canvas del modo Design de Kombai
├── .vscode/settings.json     fija CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-valmont (credenciales FUERA del proyecto, D-013)
└── valmont_e_commerce.code-workspace
```

## 3. Comandos

### Backend (`cd backend`)

| Acción | Comando |
|---|---|
| Instalar o sincronizar dependencias | `uv sync` |
| Servidor de desarrollo | `uv run fastapi dev src/valmont/main.py` → http://127.0.0.1:8000/docs |
| Pruebas | `uv run pytest -q` |
| Lint | `uv run ruff check .` |
| Formato (verificar / aplicar) | `uv run ruff format --check .` / `uv run ruff format .` |
| Añadir dependencia | `uv add <paquete>` (requiere aprobación de backend-lead) |

### Frontend (`cd frontend`)

| Acción | Comando |
|---|---|
| Instalar dependencias | `npm install` |
| Servidor de desarrollo | `npx astro dev --background` (gestión: `astro dev stop` / `status` / `logs`) |
| Verificación de tipos | `npm run check` |
| Build | `npm run build` |
| Vista previa del build | `npm run preview` |

Las puertas de calidad completas están en la skill `testing-and-quality-gates`.

## 4. Entornos (PROPUESTO)

| Entorno | Propósito | Base de datos | Secretos |
|---|---|---|---|
| `dev` | Desarrollo local | Supabase self-hosted local (D-011) | `.env` local, fuera de git |
| `test` | Pruebas automatizadas | BD efímera o esquema aislado | Variables del runner |
| `prod` | Producción | Supabase self-hosted del servidor | Gestor de secretos del servidor |

Cada componente tendrá un `.env.example` sin valores reales cuando aparezca la primera variable.

## 5. MCP y herramientas de agentes

| Herramienta | Estado verificado (2026-10-26) | Notas |
|---|---|---|
| Figma (conector claude.ai) | disponible en la cuenta | Lectura de diseños por Claude; el flujo principal es Kombai (D-006) |
| Kombai MCP Server | no configurado | Requiere la **app de escritorio** de Kombai (no la extensión). Escribe en `~/.claude.json`, que las terminales de VS Code de este workspace **no** leen (usan `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-valmont`) |
| Astro docs MCP | no configurado | Opcional; mientras tanto, enlaces en `frontend/AGENTS.md` |
| Supabase MCP | no configurado | Requiere Supabase en ejecución (D-011); solo en `dev` y con aprobación si escribe |
| GitHub MCP | falla (HTTP 400, cabecera de autorización) | Revisar el token del conector |

## Problemas conocidos

| Problema | Causa | Cómo evitarlo |
|---|---|---|
| `EnterWorktree` falla | El repo no tiene commits (o no es repo git) | Resuelto con el commit base (D-013); si reaparece, comprobar `git log` |
| "Device or resource busy" al mover carpetas | Windows bloquea archivos abiertos (VS Code, `.venv`, terminales) | No mover `backend/` ni `frontend/`; cerrar los procesos o copiar en vez de mover |
| Kombai no ve el `AGENTS.md` de `frontend/` | Kombai solo lee el `AGENTS.md` de la raíz | Las reglas de Kombai van en `AGENTS.md` raíz o en `.kombai/rules/` |
