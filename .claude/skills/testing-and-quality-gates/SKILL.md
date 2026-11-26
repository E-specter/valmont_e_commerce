---
name: testing-and-quality-gates
description: Puertas de calidad de Valmont con los comandos reales del repositorio, qué puertas exige cada tipo de cambio, política ante fallos y formato de evidencia. Úsala antes de entregar o aceptar cualquier tarea, al revisar un traspaso, cuando una prueba falle, o cuando se pregunte cómo probar, validar o verificar algo.
---

# Pruebas y puertas de calidad

Estrategia por niveles: `docs/planning.md` ("Estrategia de pruebas"). Casos E2E prioritarios: `docs/prompt_maestro.md` §13.4.

**Quién hace qué (D-028, D-033):**
- `qa-reviewer` (auditor QA) **escribe y ejecuta** las pruebas, y solo su resultado cuenta como evidencia. Son pruebas: pytest (unitarias y de integración), las migraciones reversibles, `alembic check`, `npm run build` y E2E.
- Quien implementa (`backend-dev`, `frontend-dev`) escribe solo código de producción: no crea ni modifica pruebas, `conftest` ni fixtures. Puede pasar el análisis estático (formato, lint, capas, `npm run check`, secretos) para detectar erratas.
- Los líderes, el coordinador y el Leader piden la verificación a `qa-reviewer`.

**Modos de `qa-reviewer`:**
- **Modo A, escribir pruebas:** a partir de la SPEC y contra las firmas públicas del paquete, en paralelo al desarrollador. Una prueba por criterio de aceptación, más las negativas y las de seguridad (acceso a datos ajenos, roles, entradas inválidas). E2E con Playwright cuando el paquete lo pida.
- **Modo B, ejecutar puertas:** sobre lo preparado por el desarrollador, con el formato de evidencia del §4.

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
| E2E | Flujos de punta a punta | — | no configurada (Playwright, plugin de D-035; la escribe y ejecuta QA, Fase 3) |
| Seguridad | Secretos en el código | `git diff --cached \| grep -inE "(api[_-]?key\|secret\|password\|token)[\"' ]*[:=] *[\"'][^\"']{8,}[\"']"` (debe salir vacío; solo detecta valores literales entre comillas, así que `password: str` no da falso positivo) | activa |
| Seguridad | `.env.example` sin valores secretos | `grep -nE "^[A-Z_]*(KEY\|SECRET\|PASSWORD\|TOKEN)[A-Z_]*=.+" backend/.env.example` (debe salir vacío) | activa |
| Docs | Requisitos citados existen | `grep -c "^\| RFnn.mm \|" docs/requirements.md` debe dar 1 por cada ID citado (busca la fila que lo define, no una mención) | activa |

En la tabla, `\|` es un `|` escapado: en la terminal se escribe sin la barra invertida.

## 2. Qué puertas exige cada cambio

| Tipo de cambio | Obligatorias |
|---|---|
| Dominio o caso de uso | formato, lint, pruebas unitarias nuevas (escritas por QA, modo A), capas |
| Endpoint | lo anterior + pruebas HTTP + skill `api-contract-review` |
| Migración o esquema | skill `database-migration-review` + migraciones reversibles + `pytest -m integration` |
| Repositorio o endpoint que toca la BD | unitarias + `pytest -m integration` |
| Página o componente | check, build, lista `docs/design_ui/DESIGN.md` §9 |
| Cualquier cambio de código | `qa-reviewer` ejecuta las puertas sobre lo preparado (D-028) |
| Autenticación, roles, datos de otro usuario, stock, pedidos, pagos o asistente | lo que corresponda + revisión de seguridad a fondo de `qa-reviewer` |
| Solo documentación | IDs citados existen; `_registry.md` al día |

## 3. Política ante fallos

1. **Línea base:** es el último veredicto aprobado de qa-reviewer, anotado en el STATUS. Con ella, QA distingue los fallos preexistentes de los introducidos.
2. Si algo falla, investiga la causa raíz. **Nunca** borres pruebas, debilites aserciones, añadas `skip`/`xfail` ni cambies la configuración para que pase.
3. Si un fallo preexistente bloquea tu tarea, regístralo en el STATUS como discrepancia y escala; no lo arregles fuera de tu alcance sin autorización.
4. Si qa-reviewer ve una puerta en rojo, la tarea vuelve a `IN_PROGRESS` y no hay commit hasta su `APROBADO`.

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
- qa-reviewer añade el commit base (`git rev-parse --short HEAD`) y la huella de lo preparado (`git diff --cached | git hash-object --stdin`, con `git diff` vacío).
- Quien implementa declara `NO EJECUTADO: pruebas (D-028, D-033)`.
