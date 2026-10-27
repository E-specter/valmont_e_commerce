---
name: api-contract-review
description: Propone, revisa y aprueba contratos de la API de Valmont entre backend (FastAPI) y frontend (Astro). Úsala antes de crear, cambiar o eliminar un endpoint, un campo de request/response o un código de error; cuando el frontend necesite datos que el contrato no cubre; y al revisar que el OpenAPI implementado coincide con la SPEC.
---

# Revisión de contratos de API

Política: `docs/modules.md` §6. El contrato vive en la sección "Contrato API" de `docs/modules/<módulo>/SPEC.md`; la verdad implementada es el OpenAPI de FastAPI.

## Procedimiento

1. **Ubica al dueño:** el módulo que posee el recurso. Solo su SPEC define el contrato; los demás lo referencian.
2. **Redacta o modifica la entrada:** método · ruta (`/api/v1/<módulo>/…`) · auth (`public` | `customer` | `admin`) · request (campos, tipos, obligatoriedad, validación) · response · errores (códigos del formato común) · paginación · idempotencia (obligatoria en operaciones de pago, RF05.03).
3. **Clasifica el cambio:**
   - **compatible:** endpoint nuevo, campo opcional nuevo en la respuesta, código de error nuevo documentado;
   - **incompatible:** renombrar o eliminar un campo o endpoint, cambiar un tipo, convertir en obligatorio un campo del request, cambiar la semántica.
   Un cambio incompatible requiere la aprobación de backend-lead **y** frontend-lead, y la del Leader si afecta a más de un módulo, además de un plan de migración de los consumidores.
4. **Lista de revisión:**
   - [ ] Los importes los calcula el servidor; el request nunca trae precios ni totales (RN-09).
   - [ ] Los recursos propios se resuelven por la sesión; no hay `customer_id` en el request de un cliente (RN-10).
   - [ ] Las respuestas no exponen datos de otros usuarios ni campos internos.
   - [ ] Los errores usan `{"error": {"code", "message", "details"}}` (`docs/modules.md` §4.4).
   - [ ] Las convenciones de §5 se respetan.
5. **Aprobación:** marca la entrada como `APROBADO (<fecha>, <roles>)` en la SPEC. Hasta entonces nadie la implementa.
6. **Verificación tras implementar:**
   ```bash
   cd backend && uv run python -c "import json; from valmont.main import app; print(json.dumps(app.openapi()['paths'].get('/api/v1/<ruta>'), indent=2, ensure_ascii=False))"
   ```
   Compara con la SPEC. Si difieren, gana la SPEC aprobada: se corrige el código o se tramita un cambio de contrato.

## 5. Convenciones (APROBADAS el 2026-10-26; el dinero sigue D-015)

| Aspecto | Convención |
|---|---|
| Nombres JSON | `snake_case` de punta a punta (el mismo que en Python; sin capa de mapeo) |
| Dinero | entero en céntimos + código ISO 4217: `{"amount": 125000, "currency": "PEN"}` = S/ 1 250,00 |
| Fechas | ISO 8601 en UTC (`2026-10-26T20:00:00Z`) |
| Paginación | `?page=1&page_size=20` → `{"items": [...], "total": N, "page": 1, "page_size": 20}` |
| Identificadores | UUID en texto |
| Versionado | prefijo `/api/v1`; un cambio incompatible sin migración posible abre `/api/v2` |
