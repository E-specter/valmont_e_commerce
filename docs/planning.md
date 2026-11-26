# Planificación — Valmont_E_Commerce

> Fuente canónica del plan maestro, la fase actual y el estado general.
> Tareas: [agents/tasks.md](agents/tasks.md) · Decisiones: [decisions.md](decisions.md) · Requisitos: [requirements.md](requirements.md).
> Vocabulario de estado: PROPUESTO · PLANIFICADO · EN DESARROLLO · IMPLEMENTADO · PROBADO · REVISADO · INTEGRADO · LISTO PARA ENTREGA.

## Estado actual (2026-11-26, cierre de sesión)

- **En `main` (`b044e3f`; publicado hasta `8a58d21`, falta el push de los últimos commits):**
  - Fase 1 y el hito M1 completos.
  - **Backend de la Fase 2 integrado:** identity, audit, catalog, inventory, **promotions** (T-050…T-053), **cart** (T-055…T-059) y **wishlist** (T-065…T-068).
  - Lectura compartida de productos en `shared/product_snapshots.py` (D-039).
  - Migraciones 0001–0009.
  - Último recuento de QA: 1081 unitarias + 856 de integración (T-067/T-068).
- **Configuración de Claude (T-108, D-031…D-036):** hecha. Figma por MCP en lugar de Kombai, modelos y esfuerzo por rol, QA escribe y ejecuta las pruebas, integración en `main` con `scripts/review-up.sh` tras cada tarea, plugins, skills y MCP en `.claude/` y `.mcp.json`, y commits sin firma de IA.
- **orders:** SPEC aprobada (T-070, D-040). Envío y recojo en tienda; el usuario confirmó las hipótesis del recojo (una boutique en configuración, nombre y teléfono de quien recoge, `listo_para_recojo`). **T-071 (costuras `wiring.py` y datos de la boutique en `shared/config.py`) y T-072 (dominio) están READY**; pueden ir en una sola entrega, porque tocan archivos distintos.
- **Diseño:** Figma conectado (archivo `xRC4mg5JmdqlZ6mbv97kGO`). **T-110 (brief desde `guide_design_brand`) y T-111 (vistas `landing`, `auth`, `products`, `orders`, `wishlist`, `pay`) están READY**; se hacen en una sola pasada de frontend-lead. Alcance en `docs/agents/tasks.md`.
- **Siguiente, en paralelo:** (1) T-110+T-111 con frontend-lead; (2) T-071+T-072 con backend-dev ∥ qa-reviewer. Después: T-073…T-080 (orders), payments (T-090…), las pantallas desde VIEWS y reports.
- **Decisiones abiertas:** D-012 (estilos) y D-014 (islas); se deciden con la evidencia de T-111.

## Ruta al MVP (desde 2026-11-26): dos pistas en paralelo

La interfaz no espera al backend completo: catalog, inventory e identity ya tienen API. Cada tarea termina con QA → commit → `main` → `scripts/review-up.sh` → revisión manual del usuario (D-034).

| Orden | Pista backend (backend-lead) | Pista frontend (frontend-lead) | Hito revisable en `main` |
|---|---|---|---|
| 1 | SPEC de promotions (T-050) → implementación (T-051…T-054) | T-110 brief desde Figma → T-111 vistas, matriz de reutilización, D-012 y D-014 | Brief y vistas aprobados |
| 2 | cart (T-055…T-064) | Sistema de diseño: tokens + componentes `ui/` | Catálogo de componentes |
| 3 | wishlist (T-065…T-069) | Inicio, listado con filtros y ficha de producto (API de catalog) | **Tienda navegable** (Fase 3) |
| 4 | orders (T-070…T-089) | Registro, sesión y perfil (identity); carrito y deseos | Cuenta y carrito |
| 5 | payments simulados (T-090…T-099) | Checkout, pago simulado y seguimiento | **Compra de punta a punta** (Fase 4) |
| 6 | reports y endurecimiento T-018 | Backoffice: productos, inventario, promociones, pedidos, reportes | **Backoffice** (Fase 5) |
| 7 | assistant (3 modos, herramientas autorizadas) | Interfaz del asistente | **Asistente** (Fase 6) |
| 8 | Regresión, seguridad (QA con Opus en orders, payments y assistant) | E2E con Playwright, a11y, rendimiento | **MVP listo** (Fase 7) |

Dentro de cada pista, el código (dev) y las pruebas (QA) del mismo paquete avanzan en paralelo (D-033).

## Fases

| Fase | Objetivo | Criterio de salida | Estado |
|---|---|---|---|
| 0 | Diagnóstico y preparación | Diagnóstico, `docs/` base, protocolos y plan coherentes con el repositorio | COMPLETADA |
| 1 | Fundamentos técnicos | Entornos funcionando: backend y frontend base, Supabase local, configuración por entorno, errores y logging, migraciones, auth decidida, puertas de calidad | COMPLETADA en backend y BD (2026-10-27); frontend: esqueleto hecho, D-012 y D-014 abiertas |
| 2 | Dominio comercial y datos | Entidades, restricciones, estados y migraciones de identity, audit, catalog, inventory, cart, wishlist, orders y payments con pruebas de persistencia | EN DESARROLLO (identity, audit, catalog e inventory integrados; M1 completo) |
| 3 | Experiencia de catálogo | Sistema visual desde Figma/Kombai; inicio, catálogo, filtros, ficha y promociones con datos reales | PLANIFICADO |
| 4 | Compra y cuenta | Registro, sesión, perfil, carrito con selección, deseos, pedido, entrega, pago simulado y seguimiento de punta a punta | PLANIFICADO |
| 5 | Administración | Backoffice protegido: productos, inventario, promociones, pedidos, clientes, auditoría y reportes | PLANIFICADO |
| 6 | Asistente de IA | Tres modos con herramientas autorizadas, aislamiento de datos y evaluación de respuestas | PLANIFICADO |
| 7 | Endurecimiento y entrega | Regresión, E2E, seguridad, rendimiento, accesibilidad y runbook; versión reproducible | PLANIFICADO |

No se avanza a una fase dependiente sin sus fundamentos críticos.

## Orden de trabajo: backend y base de datos

| Orden | Tarea | Depende de | Paralelizable con |
|---|---|---|---|
| 1 | T-012 Credenciales fuera + git base | Que el usuario cierre VS Code | 2 (los docs ya están, T-013) |
| 2 | T-014 Docker Desktop → T-006 Supabase local | Puerta Docker (confirmación) | 3 |
| 3 | T-007 Base del backend (configuración, errores, logs) | T-012 | 2 |
| 4 | T-015 Capa de datos (SQLAlchemy + Alembic, esquema `app`) | T-006 | 5 |
| 5 | T-008 SPEC de identity → T-016 autenticación | Campos del perfil (pregunta) · T-015 | — |
| 6 | T-017 Ficha de lanzamiento `docs/deploy.md` | T-014…T-016 verificados | — |
| 7 | Fase 2: audit → catalog → inventory → promotions → cart → wishlist → orders → payments, con el hito M1 tras inventory | Fase 1 | Por módulos independientes |

T-009 (SPEC de catalog) se ejecuta dentro del ciclo de catalog de la Fase 2. Pista de frontend (Kombai, en paralelo): T-010 sistema de diseño, que depende de D-012 y de la URL del frame de Figma.

## Estrategia de pruebas

| Nivel | Qué valida | Herramienta | Desde |
|---|---|---|---|
| Unitarias | Reglas de dominio, cálculos, transiciones de estado | pytest | Fase 1 |
| Integración | Adaptadores, BD, auth | pytest + BD de pruebas | Fase 2 |
| Contrato | OpenAPI ↔ cliente del frontend | snapshot de OpenAPI + tipos generados (pendiente) | Fase 2 |
| E2E | Flujos completos (prompt maestro §13.4) | Playwright (propuesto) | Fase 3 |
| Seguridad | Roles, aislamiento por usuario, inyección, prompt injection | pytest + revisión `qa-reviewer` | Fase 2 |

## Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Sin Docker: no hay Supabase local | Bloquea la persistencia y la auth (Fase 1–2) | Resolver D-011; mientras tanto, trabajar en dominio puro y SPECs |
| Salida de Kombai fuera del sistema de diseño o de la arquitectura | Deuda visual y lógica en la UI | Reglas en `.kombai/rules/` + revisión obligatoria de frontend-lead |
| Kombai sin soporte explícito de islas de Astro | Interactividad mal ubicada | Kombai genera componentes sin estado; las islas las implementa frontend-dev |
| Sin activos de marca oficiales | Identidad provisional | Tokens marcados como PROPUESTA en `DESIGN.md` hasta tener Figma |
| Contexto de agentes desbordado | Trabajo repetido o incoherente | Protocolo de contexto y traspaso ([agents/PROTOCOL.md](agents/PROTOCOL.md)) |
