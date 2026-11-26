---
name: backend-module-implementation
description: Implementa casos de uso del backend FastAPI de Valmont con arquitectura hexagonal y vertical slicing, dominio primero. Úsala en cualquier tarea que cree o modifique código de producción en backend/src/valmont (dominio, casos de uso, puertos, endpoints, repositorios). Las pruebas las escribe qa-reviewer (D-033).
---

# Implementación de módulo backend

Convenciones canónicas: `docs/modules.md` §4 (estructura y capas) y §7 (seguridad). Contrato: la sección "Contrato API" de `docs/modules/<módulo>/SPEC.md`.

## Precondiciones

- Paquete de tarea con "Puede modificar" explícito (`docs/agents/PROTOCOL.md` §3).
- Contrato `APROBADO` si la tarea crea o cambia endpoints; si no lo está, `BLOCKED` + skill `api-contract-review`.
- La persistencia real depende de D-010 y D-011. Mientras estén abiertas, implementa dominio y aplicación con fakes en memoria.

## Procedimiento

1. **Línea base:** el último veredicto de QA en el STATUS (no ejecutas ni escribes pruebas, D-028, D-033). Implementas contra las firmas públicas que fija el paquete; QA escribe las pruebas desde la SPEC en paralelo. Para documentación de FastAPI, SQLAlchemy, Alembic o Pydantic usa context7.
2. **Dominio:** escribe `src/valmont/modules/<módulo>/domain.py` con dataclasses e invariantes. Si se viola una regla, lanza una excepción de dominio; nunca `HTTPException`.
3. **Aplicación:** en `application.py`, un caso de uso por clase, que recibe sus puertos (`typing.Protocol`) en el constructor. Aquí van la transacción y la coordinación.
4. **Adaptador HTTP:** en `adapters/http.py`, `APIRouter(prefix="/api/v1/<módulo>", tags=["<módulo>"])` con esquemas Pydantic `<Nombre>In` y `<Nombre>Out`. El caso de uso se construye con `Depends`, y la sesión se pide **siempre** con `SessionDep` (`valmont.shared.db`), nunca con `Depends(get_session)`. Sin lógica de negocio en el router.
5. **Adaptador de persistencia:** en `adapters/persistence.py`, implementa los puertos con consultas parametrizadas u ORM; nunca concatenes SQL. Los modelos heredan de `valmont.shared.db.Base` (esquema `app`). Registra el módulo en `migrations/env.py` y genera la migración con `uv run alembic revision --autogenerate --rev-id 00NN -m "<cambio>"`; revísala con la skill `database-migration-review`.
6. **Registro:** incluye el router en `create_app()` de `src/valmont/main.py`. Es un archivo compartido: una línea, y menciónalo en el traspaso.
7. **Seguridad:** el propietario de los datos sale del contexto autenticado, nunca del cuerpo ni de la ruta. El rol se comprueba en el backend. Valida en los esquemas de entrada. No registres secretos ni datos personales.
8. **Comprobación de capas** (debe salir vacía):
   ```bash
   grep -rnE "^(from|import) (fastapi|pydantic|sqlalchemy|httpx|supabase)" src/valmont/modules/*/domain* src/valmont/modules/*/application*
   ```
9. Cierre:
   - **Análisis estático:** `ruff format`, `ruff check` y capas. Las pruebas las escribe y ejecuta qa-reviewer (D-028, D-033).
   - **Entrega preparada:** skill `version-control` §A.
   - **Traspaso:** skill `context-handoff` §C.

## Ejemplo mínimo de forma

```python
# src/valmont/modules/wishlist/domain.py
from dataclasses import dataclass


@dataclass(frozen=True)
class WishlistItem:
    customer_id: str
    product_id: str


# src/valmont/modules/wishlist/application.py
from typing import Protocol

from valmont.modules.wishlist.domain import WishlistItem


class WishlistRepository(Protocol):
    def add_if_absent(self, item: WishlistItem) -> None: ...


class AddToWishlist:
    def __init__(self, repo: WishlistRepository) -> None:
        self._repo = repo

    def __call__(self, customer_id: str, product_id: str) -> WishlistItem:
        item = WishlistItem(customer_id, product_id)
        self._repo.add_if_absent(item)  # RN-03: la BD impone la unicidad
        return item


# src/valmont/modules/wishlist/adapters/persistence.py (fragmento)
from sqlalchemy.dialects.postgresql import insert

def add_if_absent(self, item: WishlistItem) -> None:
    stmt = insert(WishlistRow).values(customer_id=item.customer_id, product_id=item.product_id)
    self._session.execute(stmt.on_conflict_do_nothing(index_elements=["customer_id", "product_id"]))
```

**Concurrencia:** nunca hagas "¿existe?" y después "inserta", ni "¿hay stock?" y después "descuenta". Dos solicitudes simultáneas pasan las dos la comprobación. Usa una sola sentencia que decida en la BD (`ON CONFLICT`, `UPDATE … WHERE disponible >= :q` y comprobar `rowcount`). Ver `docs/modules.md` §4.8.

## No hacer

- Añadir dependencias (`uv add`) sin aprobación de backend-lead.
- Escribir en tablas o importar el `domain` de otro módulo: usa su caso de uso público.
- Cambiar un contrato aprobado o el formato de error común.
- Crear o modificar pruebas, `conftest` o fixtures (D-033), ni debilitar o borrar las existentes para que pasen.
