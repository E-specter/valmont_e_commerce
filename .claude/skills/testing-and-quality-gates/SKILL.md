---
name: testing-and-quality-gates
description: Puertas de calidad de Valmont con los comandos reales del repositorio, qué puertas exige cada tipo de cambio, política ante fallos y formato de evidencia. Úsala antes de entregar o aceptar cualquier tarea, al revisar un traspaso, cuando una prueba falle, o cuando se pregunte cómo probar, validar o verificar algo.
---

# Pruebas y puertas de calidad

Estrategia por niveles: `docs/planning.md` ("Estrategia de pruebas"). Casos E2E prioritarios: `docs/prompt_maestro.md` §13.4.

## 1. Puertas disponibles

| Área | Puerta | Comando | Estado |
|---|---|---|---|
| Backend | Formato | `cd backend && uv run ruff format --check .` | activa |
| Backend | Lint | `cd backend && uv run ruff check .` | activa |
| Backend | Pruebas unitarias | `cd backend && uv run pytest -q` (excluye `integration`) | activa |
| Backend | Pruebas de integración (BD) | `cd backend && uv run pytest -m integration -q` (requiere `npm run db:start` en la raíz) | activa desde T-015 |
| Backend | Migraciones reversibles | `cd backend && uv run alembic downgrade base && uv run alembic upgrade head` (solo contra la BD local) | activa desde T-015 |
| Backend | Capas hexagonales | `grep -rnE "^(from\|import) (fastapi\|pydantic\|sqlalchemy\|httpx\|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*` (debe salir vacío) | activa en cuanto exista un módulo |
| Backend | Tipos | — | no configurada (proponer mypy o pyright a backend-lead) |
| Frontend | Tipos y diagnóstico Astro | `cd frontend && npm run check` | activa |
| Frontend | Build | `cd frontend && npm run build` | activa |
| Frontend | Lint | — | no configurada |
| E2E | Flujos de punta a punta | — | no configurada (Playwright propuesto para la Fase 3) |
| Seguridad | Secretos en el código | `git diff --cached \| grep -inE "(api[_-]?key\|secret\|password\|token)[\"' ]*[:=] *[\"'][^\"']{8,}[\"']"` (debe salir vacío; solo detecta valores literales entre comillas, así que `password: str` no da falso positivo) | activa |
| Seguridad | `.env.example` sin valores secretos | `grep -nE "^[A-Z_]*(KEY\|SECRET\|PASSWORD\|TOKEN)[A-Z_]*=.+" backend/.env.example` (debe salir vacío) | activa |
| Docs | Requisitos citados existen | `grep -c "^\| RFnn.mm \|" docs/requirements.md` debe dar 1 por cada ID citado (busca la fila que lo define, no una mención) | activa |

En la tabla, `\|` es un `|` escapado: en la terminal se escribe sin la barra invertida.

## 2. Qué puertas exige cada cambio

| Tipo de cambio | Obligatorias |
|---|---|
| Dominio o caso de uso | formato, lint, pruebas (unitarias nuevas), capas |
| Endpoint | lo anterior + pruebas HTTP + skill `api-contract-review` |
| Migración o esquema | skill `database-migration-review` + migraciones reversibles + `pytest -m integration` |
| Repositorio o endpoint que toca la BD | unitarias + `pytest -m integration` |
| Página o componente | check, build, lista `docs/design_ui/DESIGN.md` §9 |
| Autenticación, roles, datos de otro usuario, pagos o asistente | lo que corresponda + revisión de `qa-reviewer` |
| Solo documentación | IDs citados existen; `_registry.md` al día |

## 3. Política ante fallos

1. Ejecuta la línea base **antes** de cambiar nada; así distingues los fallos preexistentes de los introducidos.
2. Si algo falla, investiga la causa raíz. **Nunca** borres pruebas, debilites aserciones, añadas `skip`/`xfail` ni cambies la configuración para que pase.
3. Si un fallo preexistente bloquea tu tarea, regístralo en el STATUS como discrepancia y escala; no lo arregles fuera de tu alcance sin autorización.
4. Una tarea con puertas en rojo no pasa de `IN_PROGRESS`; como mucho, se entrega como parcial con el fallo explicado.

## 4. Formato de evidencia (en el traspaso)

```
uv run ruff format --check .  → 9 files already formatted
uv run ruff check .           → All checks passed!
uv run pytest -q              → 14 passed in 1.9s
npm run check                 → 0 errors, 0 warnings, 0 hints
npm run build                 → 6 page(s) built
NO EJECUTADO: E2E (no configurado)
```

Cada línea: el comando exacto y lo que se **observó**. Lo que no se ejecutó se declara con su motivo.
