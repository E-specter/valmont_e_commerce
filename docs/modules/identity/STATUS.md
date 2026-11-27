# identity — Estado
> Fase: 1 (T-016) y ampliación T-113 (RF01.07) · Estado del módulo: DONE en backend (falta que el frontend revise el contrato); ampliación T-113: SPEC §13 en revisión, implementación (T-138, T-139) a la espera de decisiones · Última actualización: 2026-11-27 module-coordinator (T-113)

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-008 | SPEC de identity | claude-leader | D-009 | IN_REVIEW (falta que el frontend revise el contrato) |
| T-016 | Verificación del JWT, `app.profiles`, `current_user` / `require_admin`, `GET` y `PATCH /me` | backend-dev + qa-reviewer | T-007, T-015 | DONE |
| T-113 | Ampliación de la SPEC: fecha de nacimiento y mayoría de edad para comprar (§13) | module-coordinator | D-041 (P-8), RF01.07 | DONE (D-045) |
| T-138 | identity backend: migración `0012`, dominio, `UpdateProfile`, `EnsureAdult`, `GET`/`PATCH /me` con `birth_date`, wiring | backend-dev + qa-reviewer | T-113 aprobada; P-IDENTITY-5 | DONE (026c5db) |
| T-139 | orders: exigir la mayoría de edad al crear el pedido (cambio mínimo) | backend-dev + qa-reviewer (revisión de seguridad a fondo) | T-138 (firmas; la integración exige T-138 integrada); P-IDENTITY-4, P-IDENTITY-8 | READY |

## Paquetes de tarea

### T-016 — Autenticación y perfil (identity)
- Objetivo: cada solicitud protegida conoce `CurrentUser(user_id, role)` a partir del token de Supabase, y el cliente lee y edita su perfil (`GET` y `PATCH /api/v1/identity/me`).
- Responsable: backend-dev (revisan claude-leader y qa-reviewer) · Módulo: identity · Requisitos: RF01.05, RF01.06, RF11.02, RF13.01, RF13.02, RNF10 · Decisiones: D-009, D-010, D-015
- Leer: `docs/modules/identity/SPEC.md` (completa: es el contrato); `docs/modules.md` §3 (excepción de auth) y §4; `.claude/skills/backend-module-implementation/SKILL.md`; `.claude/skills/database-migration-review/SKILL.md`; `backend/src/valmont/shared/{config,errors,db}.py`; `backend/migrations/env.py`; `backend/tests/conftest.py`.
- Contratos aplicables: SPEC §7 (ProfileOut, ProfileUpdateIn, códigos `unauthenticated`/`forbidden`/`validation_error`) y formato de error de `modules.md` §4.4.
- Dependencias: T-007 y T-015 (hechas).
- Puede modificar: `backend/src/valmont/shared/auth.py` (nuevo), `backend/src/valmont/shared/money.py` (nuevo: `Money` = `{amount: int ≥ 0, currency: "PEN"}`, reutilizable por otros módulos), `backend/src/valmont/shared/config.py` (añadir `supabase_jwt_secret: SecretStr | None = None`), `backend/src/valmont/modules/__init__.py` y `backend/src/valmont/modules/identity/**` (nuevos), `backend/src/valmont/main.py` (registrar el router), `backend/migrations/env.py` (solo la línea de registro del módulo), `backend/migrations/versions/0002_*.py` (nuevo, `--rev-id 0002`), `backend/tests/**`, `backend/pyproject.toml` + `backend/uv.lock` (solo `uv add pyjwt`).
- Protegido: `docs/**`, `frontend/**`, `supabase/**`, `.claude/**`, `backend/.env` (no leas ni imprimas el secreto real).
- Resultado esperado:
  1. `shared/auth.py`: `verify_token(token) -> TokenClaims(user_id: UUID, email: str | None)` con PyJWT: `algorithms=["HS256"]` (solo ese), `audience="authenticated"`, `options={"require": ["exp", "sub"]}`; `sub` debe ser un UUID válido; cualquier fallo → `AppError("unauthenticated", …, 401)` con la cabecera `WWW-Authenticate: Bearer`. El secreto viene de `Settings.supabase_jwt_secret`; si falta, error de configuración (500, sin revelar el motivo al cliente). El `role` del token de Supabase (`authenticated`) **no** es el rol de la app.
  2. `modules/identity/domain.py`: `Profile`, `Preferences` (invariante `budget_min ≤ budget_max`), `Role` (`customer` | `admin`), normalización de `full_name` (1–120, sin espacios sobrantes) y `phone` (`^\+?[0-9]{6,15}$` tras quitar espacios). Python puro.
  3. `modules/identity/application.py`: puerto `ProfileRepository` (Protocol) y casos de uso `EnsureProfile` (idempotente) y `UpdateProfile` (solo los campos enviados; `preferences` se reemplaza completo; `accept_privacy_version` fija `privacy_version` y `privacy_accepted_at` con la hora del servidor).
  4. `modules/identity/adapters/persistence.py`: `ProfileRow(Base)` = `app.profiles` exactamente como la SPEC §6 (CHECK de rol y de `jsonb_typeof`, defaults de servidor); creación con `INSERT … ON CONFLICT (user_id) DO NOTHING` + lectura (nunca "comprobar y luego insertar").
  5. `modules/identity/adapters/http.py`: `current_user` (cabecera `Authorization: Bearer` → `verify_token` → `EnsureProfile` → `CurrentUser`), `require_admin` (403 `forbidden`), router `/api/v1/identity` con `GET /me` y `PATCH /me`; esquemas Pydantic con `extra="forbid"` en la entrada (un `role` o `user_id` en el cuerpo → 422); salida con dinero en el formato `Money` y fechas ISO 8601 UTC. La sesión, siempre con `SessionDep`.
  6. Migración `0002` generada con `uv run alembic revision --autogenerate --rev-id 0002 -m "identity profiles"` y revisada a mano (CHECK, defaults y downgrade que borra la tabla).
- Criterios de aceptación: CA-IDENTITY-01 a CA-IDENTITY-05 de la SPEC §10 (el 06 E2E lo ejecuta el Leader con Supabase real). Además: tokens firmados con otro secreto, con `alg` distinto de HS256 (p. ej. `none`), caducados, con `aud` incorrecto o sin `sub` → 401; dos llamadas a `GET /me` con el mismo token → una sola fila en `app.profiles`.
- Pruebas obligatorias (desde `backend/`): `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, `uv run pytest -m integration -q`, la comprobación de capas de la skill de puertas (`grep … src/valmont/modules/*/domain* src/valmont/modules/*/application*` vacía), `uv run alembic upgrade head` + `uv run alembic check` contra la BD de desarrollo, y `downgrade` a `0001` + `upgrade head` sobre `valmont_test` (la prueba de reversibilidad existente). Los tokens de prueba se fabrican con PyJWT y un secreto de prueba; `get_settings` está cacheado (`cache_clear` o `dependency_overrides` en las pruebas).
- Seguridad: no registrar tokens, cabeceras de autorización ni cuerpos; el `user_id` sale solo del token; mensajes 401 genéricos (no revelar si falló la firma o la caducidad).
- Estado inicial: READY · IDs reservados: ninguno (tarea hoja)
- Escalar si: el contrato de la SPEC no cubre un caso, hace falta otra dependencia, o algo exige tocar el esquema `auth` de Supabase.

### T-113 — Ampliación de la SPEC de identity: fecha de nacimiento y mayoría de edad
- Objetivo: `SPEC.md` §13 cerrada y aprobada, con las preguntas de negocio resueltas por el usuario.
- Responsable: module-coordinator · Módulo: identity · Requisitos: RF01.07 · Decisiones: D-041 (P-8), D-015
- Leer: `docs/decisions.md` D-041 punto 8; `SPEC.md` §13; orders SPEC §3 (UC-ORDERS-01) y §4 (R8, R9, R18); `docs/modules/ui/STATUS.md` T-128, T-131 y T-126.
- Estado: **IN_REVIEW**. Falta: aprobación del contrato (backend-lead y frontend-lead), respuestas del usuario a P-IDENTITY-4…8 (SPEC §13.12) y la actualización de los documentos ajenos listados en "Discrepancias y riesgos" (los hace el Leader).

### T-138 — identity backend: fecha de nacimiento y `EnsureAdult`
- Objetivo: el perfil guarda `birth_date` (migración `0012`), `GET` y `PATCH /me` la exponen con las reglas R6–R12 y orders puede pedir `EnsureAdult`.
- Responsable: backend-dev (pruebas: qa-reviewer; revisan backend-lead y el Leader) · Módulo: identity · Requisitos: RF01.07, RNF10 · Decisiones: D-041 (P-8)
- Leer: `docs/modules/identity/SPEC.md` §13 completa (es el contrato) y §5–§7; `backend/src/valmont/modules/identity/**`; `backend/migrations/versions/0002_identity_profiles.py` y `0011_payments.py` (estilo de migración); `.claude/skills/backend-module-implementation/SKILL.md` y `database-migration-review/SKILL.md`; `backend/src/valmont/modules/orders/adapters/wiring.py` (patrón del proveedor).
- Contratos aplicables: SPEC §13.7 (ProfileOut, ProfileUpdateIn, 409 `birth_date_locked`, 422 `birth_date_future` / `birth_date_too_old`).
- Dependencias: T-113 aprobada; P-IDENTITY-5 (si el usuario no elige B, se retira `set_birth_date_if_unset` y `BirthDateLocked`, y el resto no cambia).
- Puede modificar: `backend/src/valmont/modules/identity/domain.py`, `application.py`, `adapters/http.py`, `adapters/persistence.py`, `adapters/wiring.py` (nuevo); `backend/migrations/versions/0012_profile_birth_date.py` (nuevo).
- Protegido (no tocar): `backend/src/valmont/modules/orders/**` (T-139), `shared/**`, `main.py`, `migrations/env.py` (el módulo ya está registrado), `backend/tests/**` (solo qa-reviewer), `docs/**`, `frontend/**`, `supabase/**`.
- Resultado esperado y **firmas públicas** (QA escribe las pruebas contra ellas; no se cambian sin escalar):
  - `identity/domain.py`:
    ```python
    MAJORITY_AGE: Final = 18
    MAX_AGE_YEARS: Final = 120
    MIN_BIRTH_DATE: Final = date(1900, 1, 1)

    class BirthDateInvalid(ProfileError):
        reason: Literal["future", "too_old"]
        def __init__(self, reason: Literal["future", "too_old"]) -> None: ...
    class BirthDateLocked(Exception): ...
    class AgeRequirementError(Exception): ...        # sin fecha ni edad en el mensaje ni en los atributos
    class BirthDateRequired(AgeRequirementError): ...
    class Underage(AgeRequirementError): ...

    def lima_today(now: datetime) -> date: ...        # (now UTC − 5 h).date(); ValueError si `now` no tiene zona horaria
    def parse_birth_date(value: str) -> date: ...      # R6: regex ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ + calendario real; ProfileError si no
    def age_on(birth_date: date, today: date) -> int: ...  # años cumplidos (R8); 29-feb cumple el 1-mar
    def check_birth_date_range(birth_date: date, today: date) -> None: ...  # BirthDateInvalid("future") si > today; ("too_old") si age_on > MAX_AGE_YEARS; también si < MIN_BIRTH_DATE (too_old)
    def is_adult(birth_date: date, today: date) -> bool: ...  # age_on(...) >= MAJORITY_AGE
    # Profile gana: birth_date: date | None = None   (último campo, con valor por defecto)
    ```
  - `identity/application.py`:
    ```python
    class ProfileRepository(Protocol):          # + un método; los demás no cambian
        def set_birth_date_if_unset(self, user_id: UUID, birth_date: date) -> bool: ...
        # True si escribió (la columna era NULL); False si ya había un valor. Atómico (UPDATE … WHERE birth_date IS NULL).
    class ProfileChanges(TypedDict, total=False):   # + birth_date: date
    class UpdateProfile:                         # constructor y llamada sin cambios de firma
        def __init__(self, repo: ProfileRepository, clock: Callable[[], datetime] = ...) -> None: ...
        def __call__(self, user_id: UUID, changes: ProfileChanges) -> Profile: ...
        # Si "birth_date" in changes, PRIMERO: today = lima_today(clock()); check_birth_date_range (BirthDateInvalid);
        # set_birth_date_if_unset → si False y repo.get(user_id).birth_date != valor → BirthDateLocked (igual → sigue).
        # Después, el resto de campos como hoy. Si solo venía birth_date, devuelve repo.get(user_id).
    class EnsureAdult:
        def __init__(self, repo: ProfileRepository) -> None: ...
        def __call__(self, user_id: UUID, now: datetime) -> None: ...
        # repo.get(user_id).birth_date is None → BirthDateRequired; not is_adult(fecha, lima_today(now)) → Underage. No devuelve nada.
    __all__ = [..., "BirthDateRequired", "Underage", "EnsureAdult"]   # reexportación para orders
    ```
  - `identity/adapters/persistence.py`: `ProfileRow.birth_date: Mapped[date | None] = mapped_column(Date)` y `CheckConstraint("birth_date >= DATE '1900-01-01'", name="birth_date_range")`; `_to_domain` copia `birth_date`; `SqlProfileRepository.set_birth_date_if_unset(self, user_id: UUID, birth_date: date) -> bool` (`update(ProfileRow).where(user_id == …, birth_date IS NULL).values(birth_date=…, updated_at=func.now())`, `rowcount == 1`). `update()` no recibe `birth_date`.
  - `identity/adapters/wiring.py` (nuevo; no importa `identity.adapters.http`): `def get_ensure_adult(session: SessionDep) -> EnsureAdult` (con `SqlProfileRepository(session)`: la misma transacción de la solicitud).
  - `identity/adapters/http.py`:
    - `ProfileUpdateIn.birth_date`: opcional, no nulo (null → 422, mismo patrón que `preferences`), `str` validado con `parse_birth_date`.
    - `ProfileOut.birth_date: date | None` (JSON `YYYY-MM-DD`); `from_domain` la copia.
    - `get_me` y `update_me` reciben `response: Response` y fijan `Cache-Control: no-store`.
    - `update_me` traduce `BirthDateInvalid` → `AppError("validation_error", "Datos de entrada no válidos.", 422, [{"loc": ["body", "birth_date"], "type": "birth_date_future" | "birth_date_too_old", "msg": <texto fijo sin el valor>}])` y `BirthDateLocked` → `AppError("birth_date_locked", "La fecha de nacimiento ya está registrada y no se puede cambiar.", 409)`. El OpenAPI de `PATCH /me` declara además del 422 un 409 local: `{409: {"model": ErrorOut, "description": "`birth_date_locked`: la fecha ya está registrada."}}` (`ERROR_RESPONSES` de `shared/errors.py` no trae 409 y ese archivo está protegido).
  - `backend/migrations/versions/0012_profile_birth_date.py` (`--rev-id 0012`, `down_revision = "0011"`): `upgrade` = `op.add_column("profiles", sa.Column("birth_date", sa.Date(), nullable=True), schema="app")` + `op.create_check_constraint(op.f("ck_profiles_birth_date_range"), "profiles", "birth_date >= DATE '1900-01-01'", schema="app")`; `downgrade` = quita el `CHECK` y la columna. Generada con `alembic revision --autogenerate` y revisada a mano; `alembic check` sin diferencias.
- Criterios de aceptación: SPEC §13.10, CA-IDENTITY-07 a CA-IDENTITY-14, CA-IDENTITY-17 y CA-IDENTITY-18.
- Pruebas obligatorias (las escribe y ejecuta qa-reviewer, D-033): las de SPEC §13.11 (unitarias de dominio y aplicación, HTTP, integración, migración y seguridad); puertas: `uv run ruff format --check .`, `uv run ruff check .`, `uv run pytest -q`, `uv run pytest -m integration -q`, comprobación de capas de la skill de puertas, `uv run alembic upgrade head` + `uv run alembic check`, `downgrade` a `0011` + `upgrade head` sobre `valmont_test`, `tests/test_app_role.py`.
- Seguridad: la fecha no se registra en logs ni en errores (ni la edad), el `msg` de 422 no repite el valor, nada en la auditoría, `Cache-Control: no-store`, la identidad solo sale del token. La migración de `downgrade` destruye datos: no se ejecuta en un entorno con clientes reales sin copia y aprobación del usuario.
- Revisión manual (el usuario, tras integrar): en http://localhost:8000/docs, con "Authorize" y el token de una cuenta de prueba, `PATCH /api/v1/identity/me` con `{"birth_date": "1990-05-17"}` → 200; repetirlo con `"1991-01-01"` → 409 `birth_date_locked`; con `"2999-01-01"` → 422.
- Estado inicial: **BLOCKED** (aprobación del contrato y P-IDENTITY-5). READY en cuanto el usuario confirme la opción B (recomendada) y backend-lead y frontend-lead aprueben.
- Entrega: cambio preparado sin commit (`git add <rutas>`) y mensaje propuesto: `feat(identity): fecha de nacimiento en el perfil y EnsureAdult (T-138)`.
- IDs reservados: ninguno. (T-138 y T-139 salen del bloque T-138/T-139 que `ui/STATUS.md` deja libre y que ningún documento usa; el Leader debe confirmarlo o dar otro rango.)
- Escalar si: orders o payments necesitan leer la fecha (se pide un caso de uso, nunca la columna); el usuario elige otra opción en P-IDENTITY-5; hace falta tocar `shared/` o `env.py`.

### T-139 — orders: exigir la mayoría de edad al crear el pedido (cambio mínimo)
- Objetivo: `POST /api/v1/orders` rechaza con 409 `birth_date_required` o `underage` antes de tocar el carrito o el stock; el resto del comportamiento no cambia.
- Responsable: backend-dev (pruebas: qa-reviewer, **revisión de seguridad a fondo**: orders está auditado) · Módulo: orders (consume identity) · Requisitos: RF01.07, RF04.01 · Decisiones: D-041 (P-8), D-040
- Leer: `docs/modules/identity/SPEC.md` §13.7–§13.8 y §13.10 (CA-IDENTITY-15 y 16); `docs/modules/orders/SPEC.md` §3 (UC-ORDERS-01), R4, R8, R9; `backend/src/valmont/modules/orders/application.py` (`CreateOrder`) y `adapters/http.py` (`get_create_order`, `_translated`, `_CONFLICT`).
- Contratos aplicables: SPEC identity §13.7 (errores 409 de orders). El resto del contrato de orders no cambia.
- Dependencias: T-138 (las firmas de `EnsureAdult`, `BirthDateRequired`, `Underage` y `get_ensure_adult` ya están cerradas arriba; el desarrollo puede ir en paralelo, la integración exige T-138 integrada); P-IDENTITY-4 opción A y P-IDENTITY-8 opción A.
- Puede modificar: `backend/src/valmont/modules/orders/application.py` (solo `CreateOrder`: un parámetro y una llamada; y los imports), `backend/src/valmont/modules/orders/adapters/http.py` (solo `get_create_order`, `_translated`, la documentación y ejemplos de `_CONFLICT`).
- Protegido: `orders/domain.py`, `orders/adapters/persistence.py`, `orders/adapters/wiring.py`, `orders/adapters/admin_http.py`, payments, `identity/**` (T-138), `backend/tests/**`, `docs/**`.
- Resultado esperado y **firmas públicas**:
  ```python
  # orders/application.py
  from valmont.modules.identity.application import BirthDateRequired, EnsureAdult, Underage
  class CreateOrder:
      def __init__(self, orders, prepare, remove, reserve, pickup_store, clock, audit,
                   adult: EnsureAdult) -> None: ...        # `adult`, ÚLTIMO parámetro y obligatorio (sin valor por defecto)
      def __call__(self, user_id: UUID, idempotency_key: str, delivery: DeliveryDetails) -> CreatedOrder: ...
      # Orden: now = clock.now(); find_by_key (repetición → 200 SIN comprobar edad);
      #        self._adult(user_id, now); PickupUnavailable; PrepareCheckout; … (sin más cambios)
  # orders/adapters/http.py
  def get_create_order(..., audit: AuditRecorderDep, adult: Annotated[EnsureAdult, Depends(get_ensure_adult)]) -> CreateOrder
  # get_ensure_adult: valmont.modules.identity.adapters.wiring
  # _translated(): BirthDateRequired → AppError("birth_date_required", "Indica tu fecha de nacimiento para comprar.", 409)
  #                Underage        → AppError("underage", "Debes tener 18 años cumplidos para comprar.", 409)   # details = None
  ```
  Ni la fecha ni la edad aparecen en la respuesta, el log ni la auditoría. El OpenAPI de `POST /orders` lista los dos códigos en la descripción y los ejemplos del 409.
- Criterios de aceptación: SPEC identity §13.10, CA-IDENTITY-15 y CA-IDENTITY-16; ninguna prueba existente de orders cambia de expectativa.
- Pruebas obligatorias (qa-reviewer): las de §13.11 para orders (sin fecha, menor, adulto; sin reserva ni pedido ni carrito modificado ni auditoría en los 409; menor con carrito vacío y con `pickup` sin boutique; repetición de clave sin invocar `EnsureAdult`; `CreateOrder` con `EnsureAdult` real y falso); los constructores de `CreateOrder` en `tests/orders/` (helpers, `test_create_order_concurrency.py`, `test_journey.py`) reciben el parámetro nuevo; puertas completas, ya que orders está auditado (`ruff format --check`, `ruff check`, `pytest -q`, `pytest -m integration -q`, capas).
- Seguridad: revisión de qa-reviewer a fondo (aislamiento, errores sin datos, orden de comprobaciones, sin efecto en R4 ni en la idempotencia R8).
- Revisión manual (el usuario): con una cuenta de prueba sin fecha, `POST /api/v1/orders` con carrito válido → 409 `birth_date_required`; tras `PATCH /me` con una fecha de adulto → 201; con una fecha de menor (otra cuenta) → 409 `underage`.
- Estado inicial: **BLOCKED** (T-138 y decisiones). READY cuando T-138 esté aprobada o sus firmas confirmadas.
- Entrega: cambio preparado sin commit y mensaje propuesto: `feat(orders): exigir 18 años cumplidos al crear el pedido (T-139)`.
- IDs reservados: ninguno.
- Escalar si: el cambio exige tocar el dominio o la persistencia de orders, o rompe una prueba existente de forma que no sea el constructor nuevo; el usuario elige comprobar también al pagar (P-IDENTITY-8 B: sería otra tarea en payments).

## Traspasos

### Traspaso T-139 (backend-dev) — IN_REVIEW
1. Tarea: T-139. 2. Estado: IN_REVIEW (implementado, sin probar).
3. Hecho: `orders/application.py`: `CreateOrder(..., audit, adult: EnsureAdult)` (último, obligatorio) y `self._adult(user_id, now)` tras `find_by_key` y antes de `PickupUnavailable`/`PrepareCheckout`. `orders/adapters/http.py`: `get_create_order` con `adult` (`Depends(get_ensure_adult)`), `_translated` (`BirthDateRequired` → 409 `birth_date_required`; `Underage` → 409 `underage`, sin `details`), descripción y ejemplos del 409.
4. Firmas: exactamente las del paquete.
5. Estático: `uv run ruff format .` → 273 files left unchanged; `uv run ruff check .` → All checks passed!; `import valmont.main` → ok.
6. NO EJECUTADO: pruebas (D-028, D-033). Los constructores de `CreateOrder` en `tests/orders/` deben recibir `adult` (lo hace QA).
7. Seguridad: ni fecha ni edad en errores, logs ni auditoría; excepciones sin datos; sin cambios en R4/R8. Rollback: el 409 sale como `AppError` dentro de la misma ruta, igual que los demás.
8. Nota: orders/http.py no fija `Cache-Control: no-store` en ningún error (no hay patrón); no lo añadí. Si se quiere, es decisión de QA/Leader.
9. Commits: ninguno — preparado (`orders/application.py`, `orders/adapters/http.py`, este STATUS). Mensaje: `feat(orders): exigir mayoría de edad al crear el pedido (T-139)`.

### Traspaso T-138 (backend-dev) — IN_REVIEW
1. Tarea: T-138. 2. Estado: IN_REVIEW (implementado, sin probar; pruebas de QA pendientes).
3. Hecho: `domain.py` (constantes, `BirthDateInvalid/Locked`, `AgeRequirementError/BirthDateRequired/Underage`, `lima_today`, `parse_birth_date`, `age_on`, `check_birth_date_range`, `is_adult`, `Profile.birth_date`); `application.py` (`set_birth_date_if_unset`, `UpdateProfile` con `birth_date`, `EnsureAdult`, `__all__`); `persistence.py` (columna, CHECK, `set_birth_date_if_unset` atómico); `wiring.py` nuevo (`get_ensure_adult`); `http.py` (`birth_date` en In/Out, `no-store`, 422 `birth_date_future|too_old`, 409 `birth_date_locked`); migración `0012`.
4. Firmas: exactamente las del paquete, sin cambios.
5. Estático: `uv run ruff format .` y `ruff check .` limpios en mi código; falla E501 en `backend/tests/identity/birth_date_helpers.py:1` (archivo de QA, línea de 102 caracteres; no lo toco).
6. Migración (BD local): `alembic upgrade head` → 0012; `alembic check` → "No new upgrade operations detected"; `downgrade -1` → 0011; `upgrade head` → 0012 (head). El autogenerate no detecta CHECK: añadido a mano (`ck_profiles_birth_date_range`).
7. Importar la app y `wiring` → ok. Capas (grep de la skill) → vacía.
8. NO EJECUTADO: pruebas (D-028, D-033).
9. Seguridad: la fecha no va a logs, errores ni `msg`; las excepciones no llevan fecha ni edad; sin auditoría; `Cache-Control: no-store` en GET y PATCH /me; no se toca `main.py`, `env.py`, `shared/`, orders.
10. Notas: `test_app_role.py` no cambia (columna nueva, sin tabla nueva). Si el cuerpo trae `birth_date` igual a la ya fijada, es idempotente (200).
11. Riesgos: ninguno abierto. Bloqueos: ninguno.
12. Commits: ninguno — preparado (6 archivos de identity y migración). Mensaje: `feat(identity): fecha de nacimiento fijable una vez y verificación de mayoría de edad (T-138)`.

#### Traspaso T-113 — 2026-11-27 — module-coordinator
1. Estado final: IN_REVIEW (solo documentación). T-138 y T-139 quedan BLOQUEADAS por decisiones del usuario y por la aprobación del contrato.
2. Cambios: `SPEC.md` §13 (reglas IDENTITY-R6…R14, modelo, migración `0012`, contrato, dónde se exige, privacidad, CA-IDENTITY-07…18, plan de pruebas, P-IDENTITY-4…8); paquetes T-113, T-138 y T-139 con firmas exactas.
3. Archivos: `docs/modules/identity/SPEC.md`, `docs/modules/identity/STATUS.md`.
4. Decisiones: ninguna nueva (propuestas por aprobar: dónde se exige = solo al crear el pedido; fecha fijable una vez; errores 409 `birth_date_required` y `underage`).
5. Pruebas ejecutadas: ninguna (solo documentación). Comprobaciones de lectura: la última migración es `0011` (siguiente `0012`, sin otra rama que la use); T-138 y T-139 no figuran en ningún documento.
6. Pruebas no ejecutadas: todas las de T-138 y T-139 (las escribe y ejecuta qa-reviewer, D-033).
7. Dependencias pendientes: respuestas del usuario P-IDENTITY-4…8; aprobación del contrato por backend-lead y frontend-lead; confirmar el rango T-138/T-139.
8. Riesgos: ver "Discrepancias y riesgos" (R-IDENT-1…R-IDENT-5).
9. Preguntas: SPEC §13.12.
10. Documentación actualizada: ver 3.
11. Siguiente acción recomendada: el Leader plantea P-IDENTITY-4…7 al usuario con las opciones del §13.12; con la recomendada (A, B, A, A) T-138 pasa a READY.
12. Commits: ninguno — preparado. Rutas: `docs/modules/identity/SPEC.md`, `docs/modules/identity/STATUS.md`. Mensaje propuesto: `docs(identity): fecha de nacimiento y mayoría de edad para comprar (T-113)`.

#### Revisión T-016 — 2026-10-27 — qa-reviewer + claude-leader
- **E2E con Supabase real (claude-leader):** registro 200 → login sin confirmar 400 `email_not_confirmed` → correo en Mailpit → enlace 303 → login 200 → token **ES256** → `GET /me` **401**. Causa: la verificación solo aceptaba HS256. Decisión del usuario: D-018 (JWKS).
- **qa-reviewer: CAMBIOS REQUERIDOS.** BLOQUEANTE-1: un `\x00` en textos de entrada → 500 y nombre y teléfono en el log. IMPORTANTE-1: `create_engine` sin `hide_parameters`. IMPORTANTE-2: el OpenAPI no declara el formato real de los errores. Menores M1–M6 (strip y min_length, bool estricto, invariantes en el dominio, pruebas que faltan). Verificado sin problemas: aislamiento por usuario, `extra="forbid"`, `require_admin`, `ON CONFLICT` concurrente, CHECKs y downgrade de `0002`, ausencia de email y de tokens en los logs.
- **Ronda 1 (backend-dev):** 64 pruebas unitarias + 11 de integración en verde; migración `0002` aplicada; puertas limpias. Interpretaciones aceptadas por el Leader: 401 vía `HTTPException` (para llevar `WWW-Authenticate`); `null` en `full_name` y `phone` borra el valor y en los demás campos → 422; `Money.currency` por defecto `PEN`.
- **Ronda 2 (backend-dev):** JWKS con PyJWKClient (`algorithms=["ES256"]`, `aud`, `iss`, `exp`, `sub`; 503 `auth_unavailable` si Auth no responde; `pyjwt[crypto]`); rechazo de caracteres Cc/Cs en el dominio; `hide_parameters=True`; `ErrorOut`/`ERROR_RESPONSES` en el OpenAPI; M1–M3, M5 y M6; `__init__.py` en `tests/`. Pruebas de mutación: sin el rechazo de controles fallan 13/15; con `hide_parameters=False` falla la prueba del log.
- **Verificación del Leader:** `ruff format --check` → 34 files already formatted · `ruff check` → All checks passed! · `pytest -q` → 133 passed · `pytest -m integration -q` → 12 passed · JWKS real: 1 clave EC P-256 `ES256`/`sig` con `kid` · **E2E (CA-IDENTITY-06):** registro 200 → login sin confirmar 400 → Mailpit → confirmación 303 → login 200 → token ES256 → `GET /me` ×2 200/200 `customer` (1 fila en BD) → `PATCH` 200 (nombre normalizado, privacidad aceptada) → `role` en el cuerpo 422 → token basura 401.
- **Re-verificación de qa-reviewer: APROBADO.** Cerrados BLOQUEANTE-1, IMPORTANTE-1 e IMPORTANTE-2. Ataques al JWKS real (otra clave, confusión de algoritmo, secreto heredado de la CLI, `none`) → 401; JWKS caído con clave en caché → 200 y sin caché → 503; PyJWT 2.15.1 limita el refresco por `kid` desconocido a uno cada 30 s. Menores pendientes → T-018.

## Discrepancias y riesgos

- No hay FK a `auth.users` (decisión de la SPEC §6): un perfil puede quedar huérfano si se borra el usuario en Supabase Auth. Se trata junto con P-IDENTITY-1 (cancelación de cuenta).
- Las claves públicas del JWKS se cachean por `kid` sin caducidad: tras revocar una clave en Supabase hay que reiniciar el backend (anotado en `docs/deploy.md` §C).
- `current_user` ejecuta un `INSERT … ON CONFLICT DO NOTHING` por solicitud autenticada (no escribe si el perfil existe). Revisar si la carga lo exige.
- El contrato de la SPEC §7 está implementado pero sigue en PROPUESTO hasta que lo revise el consumidor frontend (T-008).

### T-113 (fecha de nacimiento)

- **R-IDENT-1 (documentos ajenos por actualizar, los hace el Leader):** (a) `docs/agents/tasks.md`: filas T-138 y T-139 y T-113 a `IN_REVIEW`; (b) `docs/requirements.md`: RF01.07 a `PROPUESTO` con la SPEC §13; (c) orders SPEC §3 (UC-ORDERS-01: errores `birth_date_required` y `underage`) y regla ORDERS-R21 (orden de comprobaciones); (d) `docs/design_ui/VIEWS.md` §4.4 y H-18, que aún dicen "no hay campo de fecha de nacimiento"; (e) `docs/modules/ui/STATUS.md`: G-1 y T-131.
- **R-IDENT-2 (tránsito por Supabase Auth):** si la fecha se pide en el registro, viaja en `user_metadata` y queda en Auth y en los tokens hasta que `/auth/callback` la borre. Mitigación en SPEC §13.9. Debe revisarlo qa-reviewer a fondo en T-131.
- **R-IDENT-3 (T-131 incompleta tal como está redactada):** su "Puede modificar" no incluye `frontend/src/pages/auth/callback.ts` (de T-126, ya integrado), que es quien hace el `PATCH /me` y tendría que enviar `birth_date` y borrarla de los metadatos. Además `/cuenta` (T-129) no tiene el campo, y un cliente antiguo recibe `birth_date_required` sin lugar donde corregirlo (P-IDENTITY-4 A lo necesita), y el checkout debe traducir `birth_date_required` y `underage`. Habrá que ampliar T-131 o abrir otra tarea de ui. El registro con confirmación de correo hace el `PATCH` **al confirmar**, no al enviar el formulario (R-UI-2).
- **R-IDENT-4 (rectificación, Ley 29733):** con la fecha fijable una vez no hay forma de corregirla desde la aplicación; hace falta el procedimiento SQL documentado (con entrada de auditoría sin el valor) o un endpoint de administración. Un error de tecleo en el registro deja al cliente sin poder comprar hasta que el administrador intervenga. Mitigación en la interfaz: pedir confirmación visible de la fecha antes de enviar.
- **R-IDENT-5 (declarada, no verificada; texto legal):** la comprobación es una declaración. `legal.ts` debe ampliarse (conservación, no compartir con terceros ni con la IA, rectificación) y lo revisará un abogado; los menores tienen protección reforzada.
- **R-IDENT-6 (suposiciones a confirmar):** la regla del 29 de febrero (cumple el 1 de marzo), el máximo de 120 años y Lima = UTC−5 fijo son hipótesis conservadoras; el artículo 42 del Código Civil se cita por D-041 sin consultar una fuente jurídica.
