# Planificación — Valmont_E_Commerce

> Fuente canónica del plan maestro, la fase actual y el estado general.
> Tareas: [agents/tasks.md](agents/tasks.md) · Decisiones: [decisions.md](decisions.md) · Requisitos: [requirements.md](requirements.md).
> Vocabulario de estado: PROPUESTO · PLANIFICADO · EN DESARROLLO · IMPLEMENTADO · PROBADO · REVISADO · INTEGRADO · LISTO PARA ENTREGA.

## Estado actual (2026-10-26)

- **Fase actual:** cierre de la Fase 0 e inicio de la Fase 1.
- **Implementado y probado:** esqueleto del backend (`GET /health`, 1 prueba, lint y formato limpios, servidor verificado con `curl`) y esqueleto del frontend (`astro check` sin errores, build correcto).
- **Implementado, sin probar con agentes:** protocolos de agentes, subagentes, skills y reglas de Kombai. Su uso real se validará en la primera tarea delegada (T-007).
- **Decisiones:** aprobadas D-009, D-010, D-011, D-013, D-015, D-016 y D-017 (auth, datos, entorno, git, país, cancelación, stock). Siguen abiertas D-012 (estilos) y D-014 (islas), de la pista de frontend.
- **Pendiente del usuario:** cerrar VS Code para mover las credenciales (T-012) y confirmar la instalación de Docker Desktop (T-014, puerta Docker).
- **Sin porcentaje de avance:** aún no hay requisitos funcionales implementados (0 de 66 RF atómicos).
- **Plan aprobado de backend y BD:** etapas 0–2 de abajo (Fase 1 completa → Fase 2 módulo a módulo + hito M1 de lanzamiento portable).

## Fases

| Fase | Objetivo | Criterio de salida | Estado |
|---|---|---|---|
| 0 | Diagnóstico y preparación | Diagnóstico, `docs/` base, protocolos y plan coherentes con el repositorio | REVISADO (pendiente de que el usuario apruebe las decisiones abiertas) |
| 1 | Fundamentos técnicos | Entornos funcionando: backend y frontend base, Supabase local, configuración por entorno, errores y logging, migraciones, auth decidida, puertas de calidad | EN DESARROLLO |
| 2 | Dominio comercial y datos | Entidades, restricciones, estados y migraciones de identity, audit, catalog, inventory, cart, wishlist, orders y payments con pruebas de persistencia | PLANIFICADO |
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
