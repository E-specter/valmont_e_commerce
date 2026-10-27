# identity — Especificación
> Estado: IMPLEMENTADO en backend (T-016, verificado de punta a punta con Supabase real); contrato API pendiente de revisión por el consumidor frontend · Requisitos: RF01.01–RF01.06, RF11.02, RF13.01, RF13.02, RF13.04 · Decisiones: D-009, D-010, D-015, D-018 · Dueño: backend · Última actualización: 2026-10-27 claude-leader

## 1. Problema y alcance

El backend debe saber **quién** hace cada solicitud y **qué rol** tiene, y el cliente debe poder mantener sus datos básicos y preferencias.

- **Incluye:** verificación del access token de Supabase en cada solicitud protegida; perfil del cliente (lectura y edición); roles `customer` y `admin`; dependencias de autenticación para el resto de módulos; registro del consentimiento a la política de privacidad (Ley 29733).
- **Delegado a Supabase Auth (sin endpoints en FastAPI):** registro, inicio y cierre de sesión, confirmación de correo y recuperación de acceso (RF01.01–RF01.04). Se configuran en `supabase/config.toml` y los usa el frontend con supabase-js.
- **No incluye:** interfaz (frontend); gestión de roles por un administrador con auditoría y listado de clientes (Fase 5, UC-IDENTITY-06).

## 2. Actores y permisos

| Actor | Puede | No puede |
|---|---|---|
| Visitante | Registrarse e iniciar sesión (en Supabase Auth) | Llamar a `/api/v1/identity/*` |
| Cliente (`customer`) | Ver y editar su propio perfil | Cambiar su rol; ver otros perfiles |
| Administrador (`admin`) | Lo mismo que el cliente; pasar `require_admin`; consultar clientes (Fase 5) | Cambiar roles desde `/me` |
| Otros módulos | Usar `current_user` y `require_admin` (excepción de `modules.md` §3) | Escribir en `app.profiles` |

## 3. Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-IDENTITY-00 | Visitante | Formularios del frontend → Supabase Auth | Cuenta creada, sesión iniciada o cerrada, acceso recuperado | Los de Supabase Auth | RF01.01, RF01.02, RF01.03, RF01.04 |
| UC-IDENTITY-01 | Cualquier ruta protegida | `Authorization: Bearer <token>` | `CurrentUser(user_id, role)` | 401 `unauthenticated` | RF01.05 |
| UC-IDENTITY-02 | Cliente | `GET /api/v1/identity/me` | Su perfil; se crea al vuelo con rol `customer` la primera vez | 401 | RF01.06, RF13.01 |
| UC-IDENTITY-03 | Cliente | `PATCH /api/v1/identity/me` | Perfil actualizado | 401, 422 `validation_error` | RF01.06, RF11.02 |
| UC-IDENTITY-04 | Cliente | `PATCH …/me` con `accept_privacy_version` | `privacy_version` + `privacy_accepted_at` fijados por el servidor | 401, 422 | RNF10 |
| UC-IDENTITY-05 | Ruta de administración | `CurrentUser` | Continúa si `role = admin` | 403 `forbidden` | RF13.02 |
| UC-IDENTITY-06 | Administrador | Listado de clientes (Fase 5) | Clientes según permisos | 403 | RF13.04 |

## 4. Reglas de negocio

- **Globales aplicables:** RN-10 (cada cliente solo accede a sus datos).
- **IDENTITY-R1:** el rol nunca se cambia desde `/me`. Si el cuerpo trae un campo no permitido (`role`, `user_id`…), se responde 422.
- **IDENTITY-R2:** un perfil nuevo nace con `role = customer`. El primer administrador se fija con SQL documentado en `docs/deploy.md`.
- **IDENTITY-R3:** `privacy_accepted_at` lo fija el servidor (`now()`); el cliente solo envía la versión aceptada.
- **IDENTITY-R4:** el correo vive solo en Supabase Auth; el perfil no lo duplica (minimización, Ley 29733).
- **IDENTITY-R5:** el perfil se crea con `INSERT … ON CONFLICT DO NOTHING`. Dos primeras solicitudes simultáneas producen una sola fila (`modules.md` §4.8).

## 5. Modelo de dominio

- **Profile:** `user_id` (UUID), `role` (`customer` | `admin`), `full_name` (opcional, 1–120 caracteres sin espacios sobrantes), `phone` (opcional, `^\+?[0-9]{6,15}$` tras quitar espacios), `preferences`, `privacy_version` (opcional, ≤ 20 caracteres), `privacy_accepted_at`, `marketing_opt_in` (bool).
- **Preferences** (objeto de valor): `style` (texto opcional, ≤ 40), `budget_min` y `budget_max` (dinero opcional en céntimos PEN, ≥ 0), `materials` (lista de hasta 10 textos ≤ 40).
  - Invariante: si `budget_min` y `budget_max` existen, entonces `budget_min ≤ budget_max`.
- **CurrentUser:** `user_id`, `role`. Es lo único que otros módulos reciben.

## 6. Persistencia

```
app.profiles
  user_id              uuid         PK                       (= claim sub)
  role                 text         NOT NULL DEFAULT 'customer'  CHECK (role IN ('customer','admin'))
  full_name            text         NULL
  phone                text         NULL
  preferences          jsonb        NOT NULL DEFAULT '{}'    CHECK (jsonb_typeof(preferences) = 'object')
  privacy_version      text         NULL
  privacy_accepted_at  timestamptz  NULL
  marketing_opt_in     boolean      NOT NULL DEFAULT false
  created_at           timestamptz  NOT NULL DEFAULT now()
  updated_at           timestamptz  NOT NULL DEFAULT now()
```

- Sin FK a `auth.users`: ese esquema lo gestiona Supabase y no existe en la BD de pruebas. La integridad la da el token verificado (el `sub` es un usuario real de Supabase Auth).
- Las preferencias se guardan en céntimos (`{"style": …, "budget_min": 300000, …}`); la API las expone con el formato de dinero de la convención.
- Revisión: skill `database-migration-review`.

## 7. Contrato API (PROPUESTO)

| Método | Ruta | Auth | Request | Response | Errores |
|---|---|---|---|---|---|
| GET | `/api/v1/identity/me` | customer \| admin | — | 200 `ProfileOut` | 401 |
| PATCH | `/api/v1/identity/me` | customer \| admin | `ProfileUpdateIn` (todos los campos opcionales; campos extra prohibidos) | 200 `ProfileOut` | 401, 422 |

```jsonc
// ProfileOut
{
  "user_id": "3f1c…",
  "role": "customer",
  "full_name": "Ana Torres",
  "phone": "+51987654321",
  "preferences": {
    "style": "clásico",
    "budget_min": {"amount": 300000, "currency": "PEN"},
    "budget_max": {"amount": 900000, "currency": "PEN"},
    "materials": ["acero", "oro rosa"]
  },
  "privacy_version": "2026-10",
  "privacy_accepted_at": "2026-10-26T20:00:00Z",
  "marketing_opt_in": false,
  "created_at": "2026-10-26T19:58:00Z",
  "updated_at": "2026-10-26T20:00:00Z"
}

// ProfileUpdateIn (cualquier subconjunto)
{"full_name": "…", "phone": "…", "preferences": {…}, "marketing_opt_in": true, "accept_privacy_version": "2026-10"}
```

**Notas de contrato (revisión de frontend-lead, 2026-10-27; APROBADO CON CAMBIOS):**
- `preferences` en `PATCH` **reemplaza el objeto entero**: el cliente envía siempre el objeto completo.
- `full_name: null` y `phone: null` borran el dato; `preferences`, `marketing_opt_in` y `accept_privacy_version` no admiten `null` (422).
- `preferences.materials` contiene códigos de `/api/v1/catalog/attributes` (`case_materials[].code`), aprobado por el usuario.
- `validation_error.details` = `[{"loc": ["body", campo…], "type": str, "msg": str}]` (sin `input` ni `url`); el frontend traduce por `type` (T-019).
- `Money.currency` es obligatorio en el esquema de salida del OpenAPI (T-019).

Errores con el formato común `{"error": {"code", "message", "details"}}`, declarados en el OpenAPI: `unauthenticated` (401), `forbidden` (403), `validation_error` (422), `auth_unavailable` (503).

## 8. Dependencias

- **Consume:** Supabase Auth (emite los tokens; claves públicas en su JWKS, en `SUPABASE_URL`; D-018).
- **Expone:** `current_user` y `require_admin` (`modules/identity/adapters/http.py`); el caso de uso `EnsureProfile`.

## 9. Seguridad

- **Verificación del token (D-018):** firma ES256 con las claves del JWKS de Supabase, `audience="authenticated"`, `iss` igual al emisor esperado, `exp`, `sub` e `iss` obligatorios, `sub` debe ser un UUID. Cualquier otro `alg` (incluidos `none` y HS256) → 401. JWKS inalcanzable → 503 `auth_unavailable`.
- **Entradas de texto:** se rechazan los caracteres de control y los sustitutos UTF-16 sueltos (422); un NUL llegaba a PostgreSQL y provocaba un 500 (hallazgo de QA).
- **Identidad:** el `user_id` sale solo del token, nunca del cuerpo ni de la ruta.
- **401 frente a 403:** 401 = no autenticado; 403 = autenticado sin rol suficiente.
- **Logs:** no se registran tokens ni cuerpos de solicitud.
- **Ley 29733:** minimización (sin correo duplicado, sin documento de identidad), consentimiento registrado con versión y fecha, marketing con consentimiento aparte.

## 10. Criterios de aceptación

- [x] CA-IDENTITY-01 (UC-01, UC-02; RF01.05, RF01.06): con un token válido, `GET /me` → 200, y dos llamadas dejan una sola fila en `app.profiles`.
- [x] CA-IDENTITY-02 (UC-01; RF01.05): sin cabecera, cabecera mal formada, firma inválida, token caducado, `aud` distinto de `authenticated` o `sub` ausente o no UUID → 401 `unauthenticated` con el formato común.
- [x] CA-IDENTITY-03 (UC-03; RF01.06, RF11.02): `PATCH` actualiza solo los campos enviados; `role` en el cuerpo → 422; `budget_min > budget_max` → 422; teléfono inválido → 422.
- [x] CA-IDENTITY-04 (UC-04; RNF10): `accept_privacy_version` fija `privacy_accepted_at` con la hora del servidor.
- [x] CA-IDENTITY-05 (UC-05; RF13.01, RF13.02): con `require_admin`, un `customer` → 403 `forbidden` y un `admin` → pasa.
- [x] CA-IDENTITY-06 (UC-00; RF01.01–RF01.04): de punta a punta con Supabase local, registro → confirmación en Mailpit → token real → `GET /me` → 200.

## 11. Plan de pruebas

- **Unitarias:** invariante de `Preferences`; normalización de `full_name` y `phone`.
- **HTTP:** tokens fabricados en la prueba con PyJWT y un secreto de prueba (válido, caducado, firma o `aud` incorrectos, sin `sub`); `require_admin` con una ruta de prueba.
- **Integración** (`-m integration`): `EnsureProfile` idempotente, incluidas dos sesiones que insertan el mismo `user_id`; PATCH persistido.
- **E2E manual (CA-IDENTITY-06):** contra Supabase local, con los pasos de `docs/deploy.md`.

## 12. Preguntas abiertas

| ID | Pregunta | Hipótesis conservadora | Decide |
|---|---|---|---|
| P-IDENTITY-1 | Derecho de cancelación (Ley 29733): ¿eliminar la cuenta desde el perfil en el MVP? | Fuera del backend de la Fase 1; se pregunta al construir la pantalla de perfil (Fase 4) | usuario |
| P-IDENTITY-2 | ¿Taxonomía cerrada de estilos y materiales? | Texto libre acotado hasta definir el catálogo (Fase 2) y el asistente (Fase 6) | usuario |
| P-IDENTITY-3 | Texto y versión de la política de privacidad | El backend solo guarda la versión aceptada; el contenido legal lo aporta el usuario | usuario |
