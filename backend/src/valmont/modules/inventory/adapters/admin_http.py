from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt

from valmont.modules.audit.adapters.http import AuditRecorderDep

# Excepción documentada en modules.md §3: require_admin (y su CurrentUser) desde identity.
from valmont.modules.identity.adapters.http import CurrentUser, require_admin
from valmont.modules.inventory.adapters.persistence import (
    SqlAvailabilityReader,
    SqlMovementRepository,
    SqlSettingsRepository,
    SqlStockReader,
    SqlStockRepository,
)
from valmont.modules.inventory.application import (
    Actor,
    ChangeThreshold,
    MovementRepository,
    RecordMovement,
    SettingsRepository,
    StockReader,
)
from valmont.modules.inventory.domain import (
    NOTE_MAX,
    PAGE_SIZE_DEFAULT,
    PAGE_SIZE_MAX,
    AvailabilityStatus,
    InsufficientStock,
    InvalidMovement,
    MovementKind,
    NoChange,
    ProductNotFound,
    StockMovement,
    StockQuery,
    StockReserved,
    StockView,
    has_control_chars,
)
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError, ErrorOut

INT4_MAX = 2**31 - 1  # columnas integer de la SPEC §6: un valor mayor sería un 500 de la BD
MOVEMENTS_MAX = 50  # últimos movimientos del detalle (SPEC §7)

# --- Dependencias (todas comparten el SessionDep de la solicitud: una transacción) ---


def current_actor(user: Annotated[CurrentUser, Depends(require_admin)]) -> Actor:
    return Actor(user.user_id, user.role.value)  # sale del token y del perfil, nunca del cuerpo


def get_stock_reader(session: SessionDep) -> StockReader:
    return SqlStockReader(session)


def get_movement_repository(session: SessionDep) -> MovementRepository:
    return SqlMovementRepository(session)


def get_settings_repository(session: SessionDep) -> SettingsRepository:
    return SqlSettingsRepository(session)


def get_record_movement(session: SessionDep, audit: AuditRecorderDep) -> RecordMovement:
    return RecordMovement(
        SqlStockRepository(session),
        SqlAvailabilityReader(session),
        SqlMovementRepository(session),
        audit,
    )


def get_change_threshold(session: SessionDep, audit: AuditRecorderDep) -> ChangeThreshold:
    return ChangeThreshold(SqlSettingsRepository(session), audit)


ActorDep = Annotated[Actor, Depends(current_actor)]
Stock = Annotated[StockReader, Depends(get_stock_reader)]
Movements = Annotated[MovementRepository, Depends(get_movement_repository)]
Settings = Annotated[SettingsRepository, Depends(get_settings_repository)]

# --- Errores ---


def _errors(*statuses: int) -> dict[int | str, dict[str, Any]]:
    return {status: ERROR_RESPONSES[status] for status in statuses}


_MOVEMENT_ERRORS = _errors(404) | {
    409: {
        "model": ErrorOut,
        "description": "Conflicto: `insufficient_stock` (tiene prioridad) o `stock_reserved`."
        " `details` lleva `on_hand` y `reserved`, leídos bajo el bloqueo.",
    },
    422: {
        "model": ErrorOut,
        "description": "`validation_error` (`details[].loc` marca el campo) o `no_change`:"
        " la cantidad contada coincide con `on_hand`.",
    },
}


def _not_found() -> AppError:
    return AppError("not_found", "Producto no encontrado.", 404)


def _invalid(field: str | None, message: str) -> AppError:
    # Mismo formato que validation_error de shared/errors.py (T-019: loc, type, msg).
    loc = ["body", field] if field else ["body"]
    details = [{"loc": loc, "type": "value_error", "msg": message}]
    return AppError("validation_error", "Datos de entrada no válidos.", 422, details)


def _conflict(code: str, message: str, on_hand: int | None, reserved: int | None) -> AppError:
    # El admin siempre los trae (admin_movement); None solo en la ruta de reservas de orders.
    return AppError(code, message, 409, {"on_hand": on_hand, "reserved": reserved})  # O1


@contextmanager
def _domain_errors() -> Iterator[None]:
    """Traduce los errores del dominio a los códigos de la SPEC §7."""
    try:
        yield
    except ProductNotFound:
        raise _not_found() from None
    except NoChange:  # antes que InvalidMovement, de la que hereda (INVENTORY-R9)
        message = "La cantidad contada coincide con el stock: no hay nada que registrar."
        raise AppError("no_change", message, 422) from None
    except InvalidMovement as exc:
        raise _invalid(exc.field, str(exc)) from None
    except InsufficientStock as exc:
        message = "El stock no puede quedar en negativo."
        raise _conflict("insufficient_stock", message, exc.on_hand, exc.reserved) from None
    except StockReserved as exc:
        message = "El stock no puede quedar por debajo de lo reservado por pedidos."
        raise _conflict("stock_reserved", message, exc.on_hand, exc.reserved) from None


# --- Esquemas de entrada (campos extra prohibidos) ---


def _search_text(value: str) -> str:
    # Un \x00 rompería la consulta (500): 422 con loc ["query", "q"].
    if has_control_chars(value):
        raise ValueError("El texto contiene caracteres de control no permitidos.")
    return value.strip()


SearchText = Annotated[str, Field(max_length=100), AfterValidator(_search_text)]


class StockListIn(BaseModel):
    q: SearchText | None = None  # vacío equivale a no buscar
    status: AvailabilityStatus | None = None
    page: int = Field(1, ge=1, le=1000)
    page_size: int = Field(PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX)

    def to_domain(self) -> StockQuery:
        return StockQuery(self.q or None, self.status, self.page, self.page_size)


# venta solo la registra el sistema al consumir reservas (INVENTORY-R5): aquí es un 422.
AdminMovementKind = Literal["entrada", "ajuste_inventario", "merma", "devolucion"]


class MovementIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: AdminMovementKind
    # En ajuste_inventario, la cantidad contada (0 vale); en el resto, unidades (≥ 1, lo
    # comprueba el dominio con loc en quantity).
    quantity: Annotated[StrictInt, Field(ge=0, le=INT4_MAX)]
    # Tope solo declarado (T-018e): el dominio recorta y valida.
    note: Annotated[str, Field(json_schema_extra={"maxLength": NOTE_MAX})] | None = None
    # el dominio la normaliza y la valida (INVENTORY-R5)


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    low_stock_threshold: Annotated[StrictInt, Field(ge=1, le=INT4_MAX)]  # INVENTORY-R3


# --- Esquemas de salida (SPEC §7) ---

UtcDatetime = Annotated[datetime, AfterValidator(lambda value: value.astimezone(UTC))]


class StockItemOut(BaseModel):
    product_id: UUID
    sku: str
    name: str
    product_status: Literal["draft", "published"]  # estado en catalog (O3)
    on_hand: int
    reserved: int  # reservas activas no vencidas (INVENTORY-R1)
    available: int
    status: AvailabilityStatus  # lo calcula el servidor (INVENTORY-R2)

    @classmethod
    def from_domain(cls, view: StockView) -> Self:
        return cls(**vars(view))


class StockMovementOut(BaseModel):
    id: int
    product_id: UUID
    kind: MovementKind
    quantity_delta: int
    on_hand_after: int
    note: str | None  # texto plano: la interfaz nunca la inyecta como HTML
    actor_id: UUID | None
    order_id: UUID | None
    created_at: UtcDatetime

    @classmethod
    def from_domain(cls, movement: StockMovement) -> Self:
        return cls(**vars(movement))


class StockItemDetailOut(StockItemOut):
    movements: list[StockMovementOut]  # el más reciente primero


class StockPageOut(BaseModel):
    items: list[StockItemOut]
    total: int
    page: int
    page_size: int


class SettingsOut(BaseModel):
    low_stock_threshold: int


# --- Rutas (todas con require_admin: 401 sin token válido, 403 si no es admin) ---

router = APIRouter(
    prefix="/api/v1/inventory/admin",
    tags=["inventory-admin"],
    dependencies=[Depends(require_admin)],
    responses=_errors(401, 403, 503),
)


@router.get("/stock", responses=_errors(422))
def list_stock(params: Annotated[StockListIn, Query()], reader: Stock) -> StockPageOut:
    query = params.to_domain()
    page = reader.list_all(query)
    return StockPageOut(
        items=[StockItemOut.from_domain(view) for view in page.items],
        total=page.total,
        page=query.page,
        page_size=query.page_size,
    )


@router.get("/stock/{product_id}", responses=_errors(404, 422))
def get_stock(product_id: UUID, reader: Stock, movements: Movements) -> StockItemDetailOut:
    if (view := reader.get(product_id)) is None:
        raise _not_found()
    recent = movements.list_recent(product_id, MOVEMENTS_MAX)
    return StockItemDetailOut(
        **vars(view), movements=[StockMovementOut.from_domain(m) for m in recent]
    )


@router.post("/stock/{product_id}/movements", status_code=201, responses=_MOVEMENT_ERRORS)
def record_movement(
    product_id: UUID,
    body: MovementIn,
    record: Annotated[RecordMovement, Depends(get_record_movement)],
    actor: ActorDep,
) -> StockMovementOut:
    with _domain_errors():
        movement = record(product_id, MovementKind(body.kind), body.quantity, body.note, actor)
    return StockMovementOut.from_domain(movement)


@router.get("/settings")
def read_settings(settings: Settings) -> SettingsOut:
    return SettingsOut(**vars(settings.get()))


@router.patch("/settings", responses=_errors(422))
def update_settings(
    body: SettingsIn,
    change: Annotated[ChangeThreshold, Depends(get_change_threshold)],
    actor: ActorDep,
) -> SettingsOut:
    return SettingsOut(**vars(change(body.low_stock_threshold, actor)))
