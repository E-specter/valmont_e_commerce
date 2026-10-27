# audit — Especificación
> Estado: PROPUESTO (sin preguntas de negocio bloqueantes) · Requisitos: RF14.01, RF14.02 · Decisiones: D-010 · Dueño: backend · Última actualización: 2026-10-27 claude-leader

## 1. Problema y alcance

Las operaciones comerciales críticas deben dejar un rastro fiable de quién cambió qué, cuándo y de qué valor a qué valor (OE05).

- **Incluye:** la tabla `app.audit_log`, de solo inserción; el caso de uso para registrar una operación; el puerto que usan los demás módulos; la inmutabilidad impuesta en la propia BD.
- **No incluye:** la consulta y visualización en el backoffice (Fase 5) ni la política de retención (P-AUDIT-1).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Otros módulos (catalog, inventory, orders, payments, identity) | Registrar entradas dentro de su propia transacción | Leer, modificar ni borrar entradas |
| Administrador | Consultar el registro (Fase 5) | Modificar ni borrar entradas |
| Nadie | — | `UPDATE`, `DELETE` o `TRUNCATE` sobre `app.audit_log` |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-AUDIT-01 | Otro módulo | `AuditEntry(action, entity_type, entity_id, actor_id?, actor_role?, before?, after?)` | Una fila en `app.audit_log` dentro de la misma transacción que la operación auditada | Entrada inválida → `ValueError` en el dominio | RF14.01 |
| UC-AUDIT-02 | Cualquiera, por SQL | `UPDATE`, `DELETE` o `TRUNCATE` sobre `app.audit_log` | Error de la BD; nada cambia | — | RF14.02 |
| UC-AUDIT-03 | Administrador | Filtros por entidad, acción y fechas | Listado paginado (Fase 5) | 403 | RF14.01 |

## 4. Reglas de negocio

- **AUDIT-R1:** el registro comparte transacción con la operación auditada. Nunca hay una operación hecha sin rastro ni un rastro de algo que no ocurrió.
- **AUDIT-R2:** `before` y `after` guardan solo los campos que cambian. Nunca datos de tarjeta ni secretos; los datos personales solo si son el objeto del cambio (p. ej. el rol).
- **AUDIT-R3:** las acciones se nombran `<módulo>.<verbo_en_pasado>` (`^[a-z]+\.[a-z_]+$`), p. ej. `catalog.price_changed`, `inventory.stock_adjusted`, `orders.status_changed`, `payments.result_recorded`, `identity.role_changed`.
- **AUDIT-R4:** cada entrada guarda el `X-Request-ID` de la solicitud, para correlacionarla con los logs.
- **AUDIT-R5:** `actor_id` nulo significa "sistema" (p. ej. la expiración automática de pedidos, D-017).
- **AUDIT-R6:** al menos uno de `before` o `after` existe (alta: solo `after`; baja: solo `before`).

## 5. Modelo de dominio

- **AuditEntry** (inmutable): `action` (AUDIT-R3), `entity_type` (1–60 caracteres), `entity_id` (1–120 caracteres), `actor_id` (UUID opcional), `actor_role` (texto opcional), `before` y `after` (diccionarios opcionales, AUDIT-R6).

## 6. Persistencia

```
app.audit_log
  id           bigint       GENERATED ALWAYS AS IDENTITY  PK
  occurred_at  timestamptz  NOT NULL DEFAULT now()
  action       text         NOT NULL  CHECK (action ~ '^[a-z]+\.[a-z_]+$')
  entity_type  text         NOT NULL
  entity_id    text         NOT NULL
  actor_id     uuid         NULL
  actor_role   text         NULL
  request_id   text         NULL
  before       jsonb        NULL
  after        jsonb        NULL
  CHECK (before IS NOT NULL OR after IS NOT NULL)
  INDEX (entity_type, entity_id, occurred_at)
  INDEX (occurred_at)
```

- **Inmutabilidad:** una función `app.reject_audit_change()` con dos triggers: `BEFORE UPDATE OR DELETE FOR EACH ROW` y `BEFORE TRUNCATE FOR EACH STATEMENT`. Cualquier intento lanza una excepción.
- **Defensa adicional en producción (hito M1):** el rol `valmont_app` solo tendrá `INSERT` y `SELECT` sobre esta tabla.
- **Migración:** `0003`. El `downgrade` elimina triggers, función y tabla (solo para BD locales o de pruebas).

## 7. Contrato API

No hay endpoints en esta fase. La consulta del administrador (UC-AUDIT-03) se especifica con el backoffice (Fase 5).

## 8. Dependencias

- **Expone:** el puerto `AuditRecorder` (`modules/audit/application.py`, método `record(entry)`) y la dependencia `AuditRecorderDep` (`modules/audit/adapters/http.py`), que construye `SqlAuditRecorder` sobre la sesión de la solicitud (`SessionDep`).
- **Excepción documentada** en `docs/modules.md` §3: los routers de otros módulos importan `AuditRecorderDep`, y sus casos de uso reciben un `AuditRecorder`.
- **Consume:** `valmont.shared.logs.request_id_var` (AUDIT-R4).

## 9. Seguridad

- Inmutabilidad en la BD (triggers) y, en producción, por privilegios.
- Sin secretos ni datos de tarjeta (AUDIT-R2).
- El registro nunca se escribe en los logs de la aplicación.

## 10. Criterios de aceptación

- [ ] CA-AUDIT-01 (UC-AUDIT-01; RF14.01): `record` inserta una fila con todos los campos, `occurred_at` del servidor y el `request_id` de la solicitud en curso.
- [ ] CA-AUDIT-02 (AUDIT-R1): si la transacción que rodea al registro hace rollback, no queda ninguna fila.
- [ ] CA-AUDIT-03 (UC-AUDIT-02; RF14.02): `UPDATE`, `DELETE` y `TRUNCATE` sobre `app.audit_log` fallan y no cambian nada.
- [ ] CA-AUDIT-04 (AUDIT-R3, AUDIT-R6): una acción mal nombrada o sin `before` ni `after` se rechaza en el dominio, y también por los CHECK de la BD.
- [ ] CA-AUDIT-05: `alembic check` limpio; bajar y subir la migración funciona (prueba de reversibilidad existente).

## 11. Plan de pruebas

- **Unitarias:** validación de `AuditEntry`.
- **Integración (`-m integration`):** inserción con `request_id`; rollback; inmutabilidad ante `UPDATE`, `DELETE` y `TRUNCATE`; CHECK de la BD saltándose el dominio.

## 12. Preguntas abiertas

| ID | Pregunta | Hipótesis conservadora | Decide |
|---|---|---|---|
| P-AUDIT-1 | ¿Cuánto tiempo se conserva el registro? | Indefinidamente durante el MVP; se define antes de producción junto con la política de datos personales (Ley 29733) | usuario |
| P-AUDIT-2 | ¿Qué filtros y columnas necesita el backoffice? | Se especifican en la Fase 5 | usuario |
