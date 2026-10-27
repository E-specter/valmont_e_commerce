---
name: module-planning
description: Especifica y planifica un módulo de Valmont (identity, catalog, inventory, promotions, cart, wishlist, orders, payments, reports, audit, assistant). Úsala al iniciar o replanificar un módulo, cuando se pida su SPEC, plan, casos de uso, criterios de aceptación o descomposición en tareas, o antes de delegar trabajo de un módulo. Produce docs/modules/<módulo>/SPEC.md y STATUS.md con paquetes de tarea verificables.
---

# Planificación de módulo

Entrada: el nombre del módulo y el `task_id` de la tarea de planificación. Salida: `docs/modules/<módulo>/SPEC.md`, `docs/modules/<módulo>/STATUS.md`, filas nuevas en `docs/agents/tasks.md` y un traspaso.

## Procedimiento

1. **Contexto** (skill `context-handoff` §A):
   - fila del módulo en `docs/modules.md` §3, convenciones §4–§5 y seguridad §7;
   - requisitos del grupo: `grep -n "^| RF02\." docs/requirements.md` (ajusta el grupo) y las RN citadas;
   - decisiones que lo afectan: `grep -n "<módulo>" docs/decisions.md`;
   - código existente: `backend/src/valmont/modules/<módulo>/` y las páginas del área.
2. **SPEC.md** con la plantilla de abajo. Cada RF del módulo debe aparecer en al menos un caso de uso **y** en al menos un criterio de aceptación. Lo ambiguo va a "Preguntas abiertas" con una hipótesis conservadora; no se inventa.
3. **Trazabilidad**: la lista esperada es la columna RF de la fila del módulo en `docs/modules.md` §3 (expande los rangos: `RF06.04–06` = RF06.04, RF06.05, RF06.06), no el grupo completo, porque algunos grupos se reparten entre módulos. Cada ID esperado debe aparecer en la SPEC:
   ```bash
   for id in RF06.04 RF06.05 RF06.06; do grep -q "$id" docs/modules/inventory/SPEC.md || echo "FALTA $id"; done
   ```
   Sin salida = cobertura completa.
4. **Tareas**: pequeñas (un caso de uso, un endpoint o una pantalla cada una), ordenadas por dependencia, con backend y frontend separados. Usa **solo** los IDs del rango que te reservó quien delegó (campo "IDs reservados" del paquete). Si no hay rango, pídelo: calcular el "siguiente libre" choca con otros agentes que planifican en paralelo.
5. **STATUS.md** con el plan y un paquete por tarea (plantilla de `docs/agents/PROTOCOL.md` §3). Añade una fila por tarea en `docs/agents/tasks.md`.
6. **Registro**: añade `docs/modules/<módulo>/` a `docs/agents/_registry.md` si es nuevo.
7. **Escalar**: si el módulo necesita cambiar una entidad o un contrato compartido, deja la propuesta como `PROPUESTA` en `docs/decisions.md` y márcala como dependencia de las tareas afectadas.
8. **Traspaso** (`PROTOCOL.md` §5). La SPEC queda `PROPUESTO` hasta que la aprueben backend-lead y frontend-lead (contrato API) o el Leader (alcance).

## Plantilla `SPEC.md`

```markdown
# <módulo> — Especificación
> Estado: PROPUESTO · Requisitos: RFnn.* · Dueño: <rol> · Última actualización: <fecha> <agente>

## 1. Problema y alcance
Incluye: … · No incluye: …

## 2. Actores y permisos
| Actor | Puede | No puede |

## 3. Casos de uso
| ID | Actor | Entrada | Resultado | Errores | RF |
(IDs: UC-<MÓDULO>-NN)

## 4. Reglas de negocio
Globales aplicables: RN-xx (por referencia). Locales: <MÓDULO>-R1, …

## 5. Modelo de dominio
Entidades, objetos de valor e invariantes. Máquina de estados (estado → evento → estado) si aplica.

## 6. Persistencia
Tablas, PK/FK, UNIQUE, CHECK e índices (revisar con la skill database-migration-review).

## 7. Contrato API (PROPUESTO)
| Método | Ruta | Auth | Request | Response | Errores |
(seguir la skill api-contract-review)

## 8. Dependencias
Consume: <módulo.puerto> · Expone: <casos de uso públicos>

## 9. Seguridad
Aislamiento por usuario, validaciones, auditoría (RF14), datos personales.

## 10. Criterios de aceptación
- [ ] CA-<MÓDULO>-01 (UC-…, RF…): <comprobable>

## 11. Plan de pruebas
Unitarias · integración · contrato · E2E · casos de borde.

## 12. Preguntas abiertas
| ID | Pregunta | Hipótesis conservadora | Decide |
```

## Plantilla `STATUS.md`

```markdown
# <módulo> — Estado
> Fase: · Estado del módulo: · Última actualización: <fecha> <agente>

## Plan
| ID | Título | Rol | Depende de | Estado |

## Paquetes de tarea
(uno por tarea, plantilla PROTOCOL.md §3)

## Traspasos
(más reciente arriba, plantilla PROTOCOL.md §5)

## Discrepancias y riesgos
```
