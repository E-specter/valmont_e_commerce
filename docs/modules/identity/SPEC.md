# identity — Especificación
> Estado: IMPLEMENTADO en backend (T-016, verificado de punta a punta con Supabase real); contrato API pendiente de revisión por el consumidor frontend · **AMPLIACIÓN T-113 APROBADA (D-045) (§13, RF01.07: fecha de nacimiento y mayoría de edad) PROPUESTA, sin implementar** · Requisitos: RF01.01–RF01.07, RF11.02, RF13.01, RF13.02, RF13.04 · Decisiones: D-009, D-010, D-015, D-018, D-041 (P-8) · Dueño: backend · Última actualización: 2026-11-27 module-coordinator (T-113)

## 1. Problema y alcance

El backend debe saber **quién** hace cada solicitud y **qué rol** tiene, y el cliente debe poder mantener sus datos básicos y preferencias.

- **Incluye:** verificación del access token de Supabase en cada solicitud protegida; perfil del cliente (lectura y edición); roles `customer` y `admin`; dependencias de autenticación para el resto de módulos; registro del consentimiento a la política de privacidad (Ley 29733).
- **Delegado a Supabase Auth (sin endpoints en FastAPI):** registro, inicio y cierre de sesión, confirmación de correo y recuperación de acceso (RF01.01–RF01.04). Se configuran en `supabase/config.toml` y los usa el frontend con supabase-js.
- **Ampliación T-113 (§13):** fecha de nacimiento en el perfil y comprobación de los 18 años para comprar (RF01.07).
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

> **T-113:** `ProfileOut` y `ProfileUpdateIn` ganan `birth_date` (§13.7). Lo de abajo describe lo implementado en T-016 y no cambia.

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

---

## 13. Ampliación T-113: fecha de nacimiento y mayoría de edad para comprar (RF01.07, D-041 P-8)

> Estado: **PROPUESTO**. Lo implementado (§1–§12) no cambia. Las reglas marcadas "hipótesis" dependen de las preguntas P-IDENTITY-4…8 (§13.12); con la opción recomendada, esta sección es la especificación cerrada. Aprueban el contrato backend-lead y frontend-lead; el alcance, el Leader y el usuario.

### 13.1 Alcance

- **Incluye:** `birth_date` en el perfil (lectura y escritura por su dueño en `/me`); la comprobación de 18 años cumplidos (fecha de Lima) al crear un pedido; el caso de uso `EnsureAdult` que orders consume; el tratamiento como dato personal (Ley 29733, RNF10).
- **No incluye:** verificación documental de la edad (la fecha es **declarada**, ver §13.9); lectura por el administrador (la daría UC-IDENTITY-06, Fase 5, y no existe ruta de administración de perfiles); corrección de la fecha por el administrador (hipótesis P-IDENTITY-5: procedimiento documentado, tarea futura); la interfaz (T-131 y `/cuenta`); la política de supresión (P-IDENTITY-1 y orders R-5).

### 13.2 Casos de uso

| ID | Actor | Entrada | Resultado | Errores | RF |
|---|---|---|---|---|---|
| UC-IDENTITY-07 | Cliente o administrador | `PATCH /me` con `birth_date` | Fecha guardada si no había una; con la misma fecha, 200 sin cambios | 401, 409 `birth_date_locked`, 422 | RF01.07 |
| UC-IDENTITY-08 | Orders (caso de uso `EnsureAdult`, al crear un pedido) | `user_id`, `now` | Sin resultado si tiene 18 años cumplidos en la fecha de Lima de `now` | `BirthDateRequired`, `Underage` (orders: 409 `birth_date_required` / `underage`) | RF01.07 |
| UC-IDENTITY-02 (ampliado) | Cliente | `GET /me` | `ProfileOut` incluye `birth_date` (`null` si no hay) | 401 | RF01.06, RF01.07 |

### 13.3 Reglas

- **IDENTITY-R6 (formato):** `birth_date` entra y sale como `YYYY-MM-DD` (10 caracteres ASCII `[0-9]`, fecha de calendario real). Se rechazan con 422: hora o zona (`1990-05-17T00:00:00`), otros formatos (`17/05/1990`, `1990-5-17`, `19900517`), dígitos no ASCII, fechas inexistentes (`2001-02-29`), números, booleanos, cadenas vacías, con espacios sobrantes y `null`. `fromisoformat` de Python **no** basta (acepta `19900517`): se exige la expresión regular y después se valida el calendario.
- **IDENTITY-R7 (rango):** no posterior a la fecha de hoy en Lima y con **≤ 120 años cumplidos** (`MAX_AGE_YEARS = 120`). Hoy en Lima = `(now UTC − 5 h).date()`, con la hora del servidor (`UpdateProfile` ya recibe un reloj), nunca la del cliente. La BD añade `CHECK (birth_date >= DATE '1900-01-01')` (un `CHECK` no puede usar `now()`).
- **IDENTITY-R8 (mayoría de edad):** `MAJORITY_AGE = 18` años **cumplidos** en la fecha de Lima del momento de la comprobación (capacidad de ejercicio plena, Código Civil art. 42). Se cumple desde las 00:00 de Lima del día del cumpleaños; quien nació un 29 de febrero cumple el 1 de marzo en los años no bisiestos (hipótesis conservadora). Fórmula: `años = hoy.year − nac.year − ((hoy.month, hoy.day) < (nac.month, nac.day))`. Atajo heredado de orders R5: Lima = UTC−5 fijo (sin horario de verano); revisar si cambia la regla horaria.
- **IDENTITY-R9 (quién lee y escribe):**
  - **Escribe** solo su dueño, por `PATCH /me` (la identidad sale del token, R1). Ningún otro módulo escribe `app.profiles` (§2).
  - **Lee** su dueño (`GET /me`) y, cuando exista UC-IDENTITY-06, el administrador. **Ningún otro módulo la lee**: orders recibe `EnsureAdult`, que **no devuelve ni la fecha ni la edad** (solo lanza o no).
  - **No sale** en: logs, auditoría, listados, el cuerpo ni `details` de ningún error (ni de 422 ni de 409), pedidos, pagos, el asistente de IA (datos mínimos al proveedor, RNF10) ni el correo. Una 422 no repite el valor recibido (`validation_error.details` ya no lleva `input`, T-019).
  - `GET` y `PATCH /me` responden `Cache-Control: no-store` (llevan datos personales; mismo criterio que payments).
- **IDENTITY-R10 (inmutabilidad, hipótesis P-IDENTITY-5):** se fija **una vez**. Con la fecha ya guardada, el mismo valor es idempotente (200) y uno distinto → 409 `birth_date_locked`. Evita que un menor cambie la fecha para pasar la comprobación. La rectificación (derecho ARCO) se pide al administrador, que hoy solo puede hacerla por un procedimiento documentado (SQL con registro en auditoría **sin el valor**: `{"changed": true}`); un endpoint de administración queda como tarea futura. La fijación es atómica (`UPDATE … WHERE birth_date IS NULL`): dos solicitudes simultáneas con fechas distintas dejan una sola.
- **IDENTITY-R11 (sin borrado por PATCH):** `birth_date: null` → 422 (como `preferences`). Solo se borra al suprimir la cuenta (P-IDENTITY-1 y orders R-5; hipótesis: se elimina con el perfil o se anonimiza si hay pedidos).
- **IDENTITY-R12 (perfil sin fecha):** es válido (clientes anteriores a T-113 y altas sin fecha). Puede navegar y usar el carrito; no puede crear pedidos (R13).
- **IDENTITY-R13 (dónde se exige, ver §13.8):** en `CreateOrder` (UC-ORDERS-01), antes de tocar el carrito o el stock. Sin fecha → `birth_date_required`; menor → `underage`.
- **IDENTITY-R14 (auditoría):** en el MVP identity no audita la fijación de la fecha (identity no escribe en auditoría hoy y hay que evitar el valor). Si más adelante se audita (corrección por el administrador), `before` y `after` serán `{"changed": true}` sin la fecha. Una prueba comprueba que ninguna fila de `app.audit_log` contiene la fecha.

### 13.4 Modelo de dominio (`identity/domain.py`)

- `Profile` gana `birth_date: date | None = None`.
- Constantes `MAJORITY_AGE = 18`, `MAX_AGE_YEARS = 120`, `MIN_BIRTH_DATE = date(1900, 1, 1)` y `_LIMA = timezone(timedelta(hours=-5))` (propia: el dominio no importa el de orders).
- Funciones puras `lima_today`, `parse_birth_date`, `age_on`, `check_birth_date_range`, `is_adult` y los errores `BirthDateInvalid(ProfileError)`, `BirthDateLocked`, `BirthDateRequired`, `Underage` (firmas exactas en `STATUS.md`, T-138).
- `AgeRequirementError` es la base de `BirthDateRequired` y `Underage`; ninguna lleva la fecha ni la edad.

### 13.5 Persistencia (migración `0012`, aditiva y reversible)

```
app.profiles  (+)
  birth_date  date  NULL   CHECK (birth_date >= DATE '1900-01-01')   -- ck_profiles_birth_date_range
```

- `ADD COLUMN … NULL` sin valor por defecto: solo metadatos, sin reescribir la tabla; los clientes existentes quedan en `NULL` (R12).
- `downgrade`: quita el `CHECK` y la columna. **Destruye los datos de la columna**: en un entorno con clientes reales exige copia previa y aprobación del usuario (skill `database-migration-review`). Sin índice (no se consulta por fecha). Los privilegios de `valmont_app` ya son a nivel de tabla (`0006`).
- La fecha vive **solo en `app.profiles`**; no se copia a pedidos, pagos ni auditoría.

### 13.6 Dependencias

- **Expone:** `EnsureAdult` y las excepciones `BirthDateRequired` y `Underage` por `identity/application.py`; el proveedor `get_ensure_adult` en `identity/adapters/wiring.py` (`modules.md` §3, excepción 7, como orders para payments). Orders ya depende de identity (`modules.md` §3).
- **Consume:** nada nuevo.

### 13.7 Contrato API (PROPUESTO)

| Método | Ruta | Cambio | Errores nuevos |
|---|---|---|---|
| GET | `/api/v1/identity/me` | `ProfileOut.birth_date: string \| null` (`YYYY-MM-DD`) | — |
| PATCH | `/api/v1/identity/me` | `ProfileUpdateIn.birth_date` (opcional, no nulo, `YYYY-MM-DD`) | 409 `birth_date_locked`; 422 con `loc ["body","birth_date"]` |

- Errores 422 de `birth_date`: los de formato (R6) con `type` `value_error`; los de rango con `type` **`birth_date_future`** y **`birth_date_too_old`** (el frontend traduce por `type`, T-019). El `msg` no repite el valor.
- `409 birth_date_locked`: `{"error": {"code": "birth_date_locked", "message": "La fecha de nacimiento ya está registrada y no se puede cambiar.", "details": null}}`. Declarado en el OpenAPI de `PATCH /me`.
- Si el cuerpo trae otros campos y `birth_date` falla, no se escribe **nada** (una sola transacción por solicitud; la excepción deshace todo).
- **Orders (`POST /api/v1/orders`), errores nuevos (409, formato común, `details: null`):** `birth_date_required` ("Indica tu fecha de nacimiento para comprar.") y `underage` ("Debes tener 18 años cumplidos para comprar."). Ninguno lleva la fecha ni la edad. Se declaran en el OpenAPI junto a los otros 409 del alta. (Nombres alternativos si el Leader los prefiere: un único `age_not_verified`; se descartó porque la interfaz necesita distinguir "falta el dato" de "no puede comprar".)

### 13.8 Dónde se exige: análisis y propuesta

| Opción | A favor | En contra |
|---|---|---|
| **Al crear el pedido (propuesta)** | Es el momento en que el cliente se compromete y se reserva stock; un menor no llega a bloquear stock. Un solo punto y un solo módulo auditado que se toca. El pedido repetido por clave (200) no se vuelve a comprobar. | Un pedido `pendiente_pago` creado antes del despliegue podría pagarse sin comprobación durante ≤ 30 min (ventana de pago); es despreciable. |
| Al pagar | Defensa en profundidad. | Toca también payments (otro módulo auditado), añade un error al contrato de pago y un fallo tardío en la interfaz (después de reservar). Con R10 (fecha inmodificable) un pedido que pasó la comprobación sigue siendo válido al pagar. |
| En los dos sitios | Lo más estricto. | Doble coste y dos contratos; sin ganancia mientras la fecha no se pueda cambiar. |

**Propuesta:** solo al crear el pedido. Añadir el pago solo si el usuario elige que la fecha sea editable (P-IDENTITY-5, opción A).

**Cambio mínimo en orders** (lo hace T-139; orders está auditado):
1. `CreateOrder.__init__` recibe `adult: EnsureAdult` como **último** parámetro.
2. En `__call__`, justo después de `find_by_key` (repetición de clave) y **antes** de `PickupUnavailable` y de `PrepareCheckout`: `self._adult(user_id, now)` (el mismo `now` del reloj de la BD).
3. `_translated()` traduce `BirthDateRequired` → 409 `birth_date_required` y `Underage` → 409 `underage`; el OpenAPI (`_CONFLICT`) los documenta.
4. `get_create_order` añade `Depends(get_ensure_adult)`.
5. Orden de errores resultante: repetición (200) → edad → recojo no disponible → carrito vacío → … Hay que documentarlo en orders SPEC §3 (UC-ORDERS-01, errores) y en una regla ORDERS-R21 (a cargo del Leader, fuera de esta carpeta).

### 13.9 Seguridad y privacidad (Ley 29733, ISO/IEC 27001 y 27701)

- **Finalidad declarada:** verificar la mayoría de edad para comprar. `frontend/src/data/legal.ts` (sección "Datos que tratamos y su finalidad") ya dice "Fecha de nacimiento: verificar que eres mayor de edad para comprar. No se usa con fines comerciales."; es coherente con esta SPEC. **Faltan en el texto de demostración** (aviso para frontend-lead; aquí no se cambia): el plazo de conservación de este dato, que se pide en el registro bajo consentimiento, que no se comparte con terceros ni con el asistente de IA, y que la rectificación se solicita por el correo de contacto (R10). Lo revisará un abogado antes de producción (D-041 P-9).
- **Consentimiento:** el registro ya guarda `privacy_version` y `privacy_accepted_at`; la fecha se pide en el mismo formulario bajo ese consentimiento (la versión de la política debe subir si cambia el texto).
- **Minimización:** solo la fecha, sin documento de identidad; no se devuelve la edad calculada; el mensaje de `underage` no revela cuántos años tiene.
- **Confidencialidad:** `ProfileOut` solo la entrega al dueño (la identidad sale del token); sin ruta de lectura por otro usuario; `no-store`; sin registro del cuerpo (`hide_parameters=True` ya evita volcarla en los errores de SQLAlchemy).
- **Tránsito por Supabase Auth (riesgo R-IDENT-2):** con confirmación de correo no hay sesión al registrarse, así que, si se pide en el registro (P-IDENTITY-6 A), la fecha viaja en `user_metadata` hasta `/auth/callback`. Ahí queda en `raw_user_meta_data` y en el claim `user_metadata` de cada token mientras no se borre. Mitigación obligatoria para T-131: el callback la envía al backend y después la **borra** de los metadatos (`auth.updateUser({ data: { birth_date: null } })`), nunca la pone en una URL ni en un log, y el backend **no confía** en ese claim (solo acepta la fecha por `PATCH /me`, que la valida). Alternativa sin este riesgo: pedirla después de confirmar el correo (P-IDENTITY-6 B).
- **Declarada, no verificada:** cualquiera puede escribir una fecha falsa; el control es de buena fe y deja constancia. Si el negocio exige más (documento), es otra tarea.
- **Menores:** los datos de menores tienen protección reforzada; ver P-IDENTITY-7.
- **Supresión:** entra en la política pendiente (orders R-5, P-IDENTITY-1): al cerrar la cuenta se borra o anonimiza; con pedidos, el FK `RESTRICT` obliga a decidirlo antes de producción.

### 13.10 Criterios de aceptación

- [ ] **CA-IDENTITY-07** (UC-07; RF01.07): `PATCH /me {"birth_date": "1990-05-17"}` → 200 con `birth_date: "1990-05-17"`; `GET /me` lo devuelve; sin fecha, `null`.
- [ ] **CA-IDENTITY-08** (R6): `17/05/1990`, `1990-5-17`, `19900517`, `1990-05-17T00:00:00`, `1990-05-17T00:00:00Z`, `2001-02-29`, `""`, ` 1990-05-17`, `１９９０-05-17`, `19900517` (número), `true` y `null` → 422 `validation_error` con `loc ["body","birth_date"]`; ni `message` ni `details` contienen el valor enviado.
- [ ] **CA-IDENTITY-09** (R7): con reloj fijo, mañana de Lima → 422 `birth_date_future`; hoy de Lima → 200; exactamente 120 años → 200; 121 años → 422 `birth_date_too_old`; `1899-12-31` → 422; el `CHECK` de la BD rechaza `1899-12-31` insertado directamente.
- [ ] **CA-IDENTITY-10** (R7, zona): con `now = 2026-11-28T03:00Z` (22:00 del 27 en Lima), `2026-11-28` → 422 `birth_date_future`; con `now = 2026-11-28T05:00Z` (00:00 del 28 en Lima) → 200.
- [ ] **CA-IDENTITY-11** (R10, hipótesis): con la fecha fijada, otra distinta → 409 `birth_date_locked` y el valor original intacto; la misma → 200; dos solicitudes simultáneas con fechas distintas → una gana y la otra recibe 409 (integración, dos sesiones).
- [ ] **CA-IDENTITY-12** (atomicidad): `PATCH` con `birth_date` bloqueada y `full_name` nuevo → 409 y `full_name` sin cambiar; con `full_name` inválido y `birth_date` válida → 422 y nada escrito.
- [ ] **CA-IDENTITY-13** (R9, privacidad): durante un `PATCH` correcto, uno 422 y uno 409, ningún registro de log (todos los niveles) ni fila de `app.audit_log` contiene la fecha; `GET` y `PATCH /me` llevan `Cache-Control: no-store`; con el token de A, `GET /me` solo devuelve la fecha de A; el OpenAPI declara `birth_date` y el 409.
- [ ] **CA-IDENTITY-14** (UC-08; R8): `EnsureAdult` sin fecha → `BirthDateRequired`; el día anterior al 18.º cumpleaños (fecha de Lima) → `Underage`; el día del cumpleaños a las 00:00 de Lima → sin error; nacido el 29-02-2008: el 28-02-2026 → `Underage` y el 01-03-2026 → sin error; `now` sin zona horaria → `ValueError`; la excepción no contiene la fecha ni la edad.
- [ ] **CA-IDENTITY-15** (R13; RF01.07): `POST /orders` con carrito válido: sin fecha → 409 `birth_date_required`; menor → 409 `underage`; adulto → 201 como hoy. En los dos 409 no hay fila en `orders`, no se reserva stock, el carrito queda intacto y no hay entrada de auditoría; `details` es `null`.
- [ ] **CA-IDENTITY-16** (R13, orden): un menor con carrito vacío recibe `underage` (no `empty_selection`); con `pickup` sin boutique, `underage`; repetir la clave de un pedido existente → 200 sin invocar `EnsureAdult`.
- [ ] **CA-IDENTITY-17** (migración): `upgrade 0012` añade la columna `NULL` y los perfiles existentes quedan en `NULL`; `downgrade 0011` la quita; `alembic check` sin diferencias; `valmont_app` puede escribir `birth_date` (`tests/test_app_role.py`).
- [ ] **CA-IDENTITY-18** (aislamiento): `grep -rn birth_date backend/src/valmont/modules` solo da resultados dentro de `modules/identity/`; orders solo importa `EnsureAdult`, `BirthDateRequired` y `Underage`.

### 13.11 Plan de pruebas (las escribe qa-reviewer, D-033)

- **Unitarias (dominio y aplicación):** `parse_birth_date` (la lista de CA-08), `age_on`, `check_birth_date_range`, `is_adult` con fechas límite: día antes y día del cumpleaños, 29 de febrero, año bisiesto, 120 años, frontera de Lima (UTC−5). `UpdateProfile` con repositorio falso y reloj fijo: fija, repite, bloqueada, rango, `birth_date` más otros campos. `EnsureAdult` con repositorio falso.
- **HTTP:** CA-07, 08, 09, 12 y 13 con `TestClient`; el 422 con el formato común; OpenAPI.
- **Integración (`-m integration`):** persistencia de `birth_date`, `CHECK` de la BD, `set_birth_date_if_unset` concurrente (dos sesiones), reversibilidad de `0012`, `test_app_role`; en orders, `CreateOrder` con `EnsureAdult` real contra la BD (CA-15, CA-16) y un recorrido `journey` con un adulto.
- **Regresión de orders:** los constructores de `CreateOrder` en `tests/orders/` reciben el nuevo parámetro; ninguna expectativa existente cambia (sus clientes de prueba pasan a tener `birth_date` de adulto).
- **Seguridad (qa-reviewer, a fondo por tocar orders):** la fecha ausente de logs, auditoría y errores; un cliente no puede leer ni escribir la de otro (el cuerpo no admite `user_id`); intento de cambiar la fecha tras la compra.
- **E2E manual (el Leader, con Supabase local):** registro → confirmación → `PATCH` con la fecha → `POST /orders` con un adulto (201) y con un menor (409 `underage`); cuenta antigua sin fecha → 409 `birth_date_required`.

### 13.12 Preguntas abiertas (para el usuario; el Leader las formula)

| ID | Pregunta | Opciones | Recomendada | Decide |
|---|---|---|---|---|
| P-IDENTITY-4 | **Clientes que ya existen sin fecha.** | A) Se les pide antes de su primera compra: `birth_date_required` y la interfaz los lleva a `/cuenta`. B) Se les bloquea todo el sitio privado hasta completarla. C) Se asume mayor de edad (contradice D-041). | **A**: no estorba a quien solo navega y la regla se cumple en el único punto donde importa. | usuario |
| P-IDENTITY-5 | **¿Se puede corregir la fecha?** | A) Libre: el cliente la cambia cuando quiera (un menor podría cambiarla para comprar; haría falta exigirla también al pagar). B) Una sola vez; la corrección la hace soporte o el administrador (derecho de rectificación, Ley 29733). C) Editable solo hasta el primer pedido (exige que identity sepa de los pedidos: dependencia circular). | **B**: cierra la trampa más simple y cumple ARCO por canal humano; coste: más adelante hay que escribir un endpoint de administración (mientras tanto, el procedimiento SQL documentado). | usuario |
| P-IDENTITY-6 | **¿Se exige al registrarse o solo al comprar?** | A) Obligatoria en el registro (Figma y D-041): viaja en `user_metadata` hasta `/auth/callback` y allí se borra (R-IDENT-2). B) Se pide al confirmar el correo, en un paso "completa tu perfil", sin pasar por `user_metadata`. C) Solo al comprar. | **A**, por coherencia con el diseño y D-041; B si la revisión de seguridad rechaza el tránsito por `user_metadata`. | usuario |
| P-IDENTITY-7 | **¿Puede un menor crear una cuenta?** | A) No: el formulario lo rechaza sin enviar nada y no se guarda su fecha (minimización; la regla de compra sigue en el backend por si alguien usa la API directa). B) Sí, puede navegar pero no comprar (se guarda su fecha). | **A**: guarda menos datos de menores, que tienen protección reforzada (a validar con asesoría legal antes de producción). | usuario |
| P-IDENTITY-8 | **Alcance de la comprobación.** | A) Solo al crear el pedido (§13.8). B) También al pagar. | **A** mientras la fecha no sea editable. | Leader / backend-lead |
