from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import Text, Uuid, column, select, table
from sqlalchemy.orm import Session

from valmont.modules.audit.adapters.http import AuditRecorderDep

# Excepción documentada en modules.md §3: require_admin (y su CurrentUser) desde identity.
from valmont.modules.identity.adapters.http import CurrentUser, require_admin
from valmont.modules.promotions.adapters.persistence import (
    InvalidReference,
    PromotionRow,
    SqlEffectivePriceReader,
    SqlPromotionRepository,
)
from valmont.modules.promotions.application import (
    ActivatePromotion,
    Actor,
    CreatePromotion,
    DeactivatePromotion,
    GetPromotion,
    ListPromotions,
    PromotionNotFound,
    PromotionRepository,
    UpdatePromotion,
)
from valmont.modules.promotions.domain import (
    NAME_MAX,
    PRODUCTS_MAX,
    Promotion,
    PromotionError,
    PromotionKind,
    PromotionScope,
    PromotionStatus,
)
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError
from valmont.shared.money import Money

PAGE_SIZE_DEFAULT = 24  # como catalog (SPEC §7)

# Topes solo declarados en el OpenAPI (T-018e): el dominio recorta y valida.
Name = Annotated[str, Field(json_schema_extra={"maxLength": NAME_MAX})]
ProductIds = Annotated[list[UUID], Field(json_schema_extra={"maxItems": PRODUCTS_MAX})]
PAGE_SIZE_MAX = 48

# Lecturas de presentación (sku, nombre, categoría): tablas ligeras de catalog, solo lectura.
_products = table(
    "products", column("id", Uuid), column("sku", Text), column("name", Text), schema="app"
)
_categories = table(
    "categories", column("id", Uuid), column("slug", Text), column("name", Text), schema="app"
)

# --- Actor, repositorio y errores ---


def current_actor(user: Annotated[CurrentUser, Depends(require_admin)]) -> Actor:
    return Actor(user.user_id, user.role.value)  # sale del token y del perfil, nunca del cuerpo


ActorDep = Annotated[Actor, Depends(current_actor)]


def get_promotions(session: SessionDep) -> PromotionRepository:
    return SqlPromotionRepository(session)


Promotions = Annotated[PromotionRepository, Depends(get_promotions)]


def _invalid(field: str | None, type_: str, message: str) -> AppError:
    # Mismo formato que validation_error de shared/errors.py (loc, type, msg).
    loc = ["body", field] if field else ["body"]
    details = [{"loc": loc, "type": type_, "msg": message}]
    return AppError("validation_error", "Datos de entrada no válidos.", 422, details)


@contextmanager
def _domain_errors() -> Iterator[None]:
    """Traduce los errores del dominio y de las FK a los códigos de la SPEC §7."""
    try:
        yield
    except PromotionNotFound:
        raise AppError("not_found", "No existe.", 404) from None
    except InvalidReference as exc:
        raise _invalid(exc.field, "reference_not_found", "No existe.") from None
    except PromotionError as exc:
        # El dominio nombra el campo antes de los dos puntos ("ends_at: debe ser posterior…").
        field = str(exc).partition(":")[0]
        raise _invalid(field if field.isidentifier() else None, "value_error", str(exc)) from None


def _errors(*statuses: int) -> dict[int | str, dict[str, Any]]:
    return {status: ERROR_RESPONSES[status] for status in statuses}


# --- Esquemas de entrada (campos extra prohibidos) ---


def _cents(money: Money | None) -> int | None:
    return None if money is None else money.amount


class PromotionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    kind: PromotionKind
    percent_off: StrictInt | None = None
    amount_off: Money | None = None
    scope: PromotionScope
    product_ids: ProductIds | None = None
    category_id: UUID | None = None
    starts_at: AwareDatetime
    ends_at: AwareDatetime

    def to_fields(self) -> dict[str, object]:
        fields = {name: getattr(self, name) for name in type(self).model_fields}
        return fields | {"amount_off": _cents(self.amount_off)}


class PromotionUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Omitibles pero no nulos: Pydantic no valida el default, así que un null explícito → 422.
    name: Name = None  # type: ignore[assignment]
    kind: PromotionKind = None  # type: ignore[assignment]
    scope: PromotionScope = None  # type: ignore[assignment]
    starts_at: AwareDatetime = None  # type: ignore[assignment]
    ends_at: AwareDatetime = None  # type: ignore[assignment]
    # Anulables: null descarta el valor (R14).
    percent_off: StrictInt | None = None
    amount_off: Money | None = None
    product_ids: ProductIds | None = None
    category_id: UUID | None = None

    def to_changes(self) -> dict[str, object]:
        changes = {name: getattr(self, name) for name in self.model_fields_set}
        if "amount_off" in changes:
            changes["amount_off"] = _cents(self.amount_off)
        return changes


class PromotionListIn(BaseModel):
    status: PromotionStatus | None = None
    scope: PromotionScope | None = None
    page: int = Field(1, ge=1, le=1000)
    page_size: int = Field(PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX)


# --- Esquemas de salida (SPEC §7) ---

UtcDatetime = Annotated[datetime, AfterValidator(lambda value: value.astimezone(UTC))]


class CategoryRefOut(BaseModel):
    id: UUID
    slug: str
    name: str


class PromotionProductOut(BaseModel):
    id: UUID
    sku: str
    name: str
    list_price: Money
    price: Money  # precio vigente hoy con la mejor promoción (puede ser otra)


class PromotionSummaryOut(BaseModel):
    id: UUID
    name: str
    kind: PromotionKind
    percent_off: int | None
    amount_off: Money | None
    scope: PromotionScope
    category: CategoryRefOut | None
    starts_at: UtcDatetime
    ends_at: UtcDatetime
    is_active: bool
    status: PromotionStatus
    product_count: int
    created_at: UtcDatetime
    updated_at: UtcDatetime


class PromotionDetailOut(PromotionSummaryOut):
    products: list[PromotionProductOut]


class PromotionPageOut(BaseModel):
    items: list[PromotionSummaryOut]
    total: int
    page: int
    page_size: int


def _summaries(session: Session, promotions: list[Promotion]) -> list[PromotionSummaryOut]:
    """Una consulta para las marcas de fila y otra para las categorías, no una por promoción."""
    if not promotions:
        return []
    now = datetime.now(UTC)  # R9: el servidor calcula el estado
    stamps = {
        row.id: row
        for row in session.execute(
            select(PromotionRow.id, PromotionRow.created_at, PromotionRow.updated_at).where(
                PromotionRow.id.in_([p.id for p in promotions])
            )
        )
    }
    category_ids = {p.category_id for p in promotions if p.category_id is not None}
    categories = {
        row.id: CategoryRefOut(id=row.id, slug=row.slug, name=row.name)
        for row in session.execute(select(_categories).where(_categories.c.id.in_(category_ids)))
    }
    return [
        PromotionSummaryOut(
            id=p.id,
            name=p.name,
            kind=p.kind,
            percent_off=p.percent_off,
            amount_off=None if p.amount_off is None else Money(amount=p.amount_off),
            scope=p.scope,
            category=categories.get(p.category_id) if p.category_id else None,
            starts_at=p.starts_at,
            ends_at=p.ends_at,
            is_active=p.is_active,
            status=p.status_at(now),
            product_count=len(p.product_ids),
            created_at=stamps[p.id].created_at,
            updated_at=stamps[p.id].updated_at,
        )
        for p in promotions
    ]


def _detail(session: Session, promotion: Promotion) -> PromotionDetailOut:
    summary = _summaries(session, [promotion])[0]
    products: list[PromotionProductOut] = []
    if promotion.product_ids:
        prices = {
            price.product_id: price
            for price in SqlEffectivePriceReader(session).get_many(promotion.product_ids)
        }
        rows = session.execute(
            select(_products)
            .where(_products.c.id.in_(promotion.product_ids))
            .order_by(_products.c.sku)
        )
        products = [
            PromotionProductOut(
                id=row.id,
                sku=row.sku,
                name=row.name,
                list_price=Money(amount=prices[row.id].list_price),
                price=Money(amount=prices[row.id].price),
            )
            for row in rows
        ]
    return PromotionDetailOut(**dict(summary), products=products)


# --- Rutas (todas con require_admin: 401 sin token válido, 403 si no es admin) ---

router = APIRouter(
    prefix="/api/v1/promotions/admin",
    tags=["promotions-admin"],
    dependencies=[Depends(require_admin)],
    responses=_errors(401, 403, 503),
)


@router.get("/promotions", responses=_errors(422))
def list_promotions(
    params: Annotated[PromotionListIn, Query()], repo: Promotions, session: SessionDep
) -> PromotionPageOut:
    found, total = ListPromotions(repo)(params.status, params.scope, params.page, params.page_size)
    return PromotionPageOut(
        items=_summaries(session, found),
        total=total,
        page=params.page,
        page_size=params.page_size,
    )


@router.post("/promotions", status_code=201, responses=_errors(422))
def create_promotion(
    body: PromotionIn,
    repo: Promotions,
    audit: AuditRecorderDep,
    actor: ActorDep,
    session: SessionDep,
) -> PromotionDetailOut:
    with _domain_errors():
        promotion = CreatePromotion(repo, audit)(body.to_fields(), actor)
    return _detail(session, promotion)


@router.get("/promotions/{promotion_id}", responses=_errors(404, 422))
def get_promotion(promotion_id: UUID, repo: Promotions, session: SessionDep) -> PromotionDetailOut:
    with _domain_errors():
        promotion = GetPromotion(repo)(promotion_id)
    return _detail(session, promotion)


@router.patch("/promotions/{promotion_id}", responses=_errors(404, 422))
def update_promotion(
    promotion_id: UUID,
    body: PromotionUpdateIn,
    repo: Promotions,
    audit: AuditRecorderDep,
    actor: ActorDep,
    session: SessionDep,
) -> PromotionDetailOut:
    changes = body.to_changes()
    if not changes:
        raise _invalid(None, "value_error", "Se necesita al menos un campo.")
    with _domain_errors():
        promotion = UpdatePromotion(repo, audit)(promotion_id, changes, actor)
    return _detail(session, promotion)


@router.post("/promotions/{promotion_id}/activate", responses=_errors(404, 422))
def activate_promotion(
    promotion_id: UUID,
    repo: Promotions,
    audit: AuditRecorderDep,
    actor: ActorDep,
    session: SessionDep,
) -> PromotionDetailOut:
    with _domain_errors():
        promotion = ActivatePromotion(repo, audit)(promotion_id, actor)
    return _detail(session, promotion)


@router.post("/promotions/{promotion_id}/deactivate", responses=_errors(404, 422))
def deactivate_promotion(
    promotion_id: UUID,
    repo: Promotions,
    audit: AuditRecorderDep,
    actor: ActorDep,
    session: SessionDep,
) -> PromotionDetailOut:
    with _domain_errors():
        promotion = DeactivatePromotion(repo, audit)(promotion_id, actor)
    return _detail(session, promotion)
