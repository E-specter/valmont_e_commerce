from collections.abc import Callable, Coroutine, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from functools import cache
from typing import Annotated, Any, Self
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    File,
    Form,
    Path,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.routing import APIRoute
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationInfo,
    field_validator,
    model_validator,
)

from valmont.modules.audit.adapters.http import AuditRecorderDep
from valmont.modules.catalog.adapters.http import (
    Attributes,
    AttributeValueOut,
    Categories,
    CategoryRefOut,
    ProductImageOut,
    Products,
    SearchText,
    SpecOut,
)
from valmont.modules.catalog.adapters.image_optimizer import PillowImageOptimizer
from valmont.modules.catalog.adapters.storage import SupabaseImageStorage
from valmont.modules.catalog.application import (
    Actor,
    AddProductImage,
    CreateCategory,
    CreateProduct,
    ImageOptimizer,
    ImageStorage,
    PublishProduct,
    RemoveProductImage,
    ReorderProductImages,
    StorageUnavailable,
    UnpublishProduct,
    UpdateAttributeValue,
    UpdateCategory,
    UpdateProduct,
    UpdateProductImage,
    discard_file,
)
from valmont.modules.catalog.domain import (
    ALT_MAX,
    CATEGORY_DESCRIPTION_MAX,
    CATEGORY_NAME_MAX,
    DESCRIPTION_MAX,
    IMAGE_MAX_BYTES,
    LABEL_MAX,
    NAME_MAX,
    PAGE_SIZE_DEFAULT,
    PAGE_SIZE_MAX,
    SKU_MAX,
    SLUG_MAX,
    SPEC_LABEL_MAX,
    SPEC_VALUE_MAX,
    SPECS_MAX,
    AdminProductQuery,
    AdminProductView,
    AnimatedImage,
    AttributeKind,
    AttributeValue,
    CatalogConflict,
    CatalogError,
    CatalogNotFound,
    Category,
    CategoryInUse,
    ImageDimensionsExceeded,
    ImageTooLarge,
    InvalidImage,
    InvalidReference,
    LastImage,
    NotPublishable,
    OrderPolicy,
    ProductStatus,
    SlugLocked,
    SpecEntry,
    UnsupportedImage,
    check_slug,
    check_specs,
    clean_text,
    slugify,
)

# Excepción documentada en modules.md §3: require_admin (y su CurrentUser) desde identity.
from valmont.modules.identity.adapters.http import CurrentUser, require_admin
from valmont.shared.config import get_settings
from valmont.shared.errors import ERROR_RESPONSES, AppError, ErrorOut
from valmont.shared.money import Money

INT4_MAX = 2**31 - 1  # columnas integer de la SPEC §6: un valor mayor sería un 500 de la BD

# --- Actor y errores ---


def current_actor(user: Annotated[CurrentUser, Depends(require_admin)]) -> Actor:
    return Actor(user.user_id, user.role.value)  # sale del token y del perfil, nunca del cuerpo


ActorDep = Annotated[Actor, Depends(current_actor)]


def _errors(*statuses: int, conflicts: tuple[str, ...] = ()) -> dict[int | str, dict[str, Any]]:
    """Errores de una ruta; el 409 lista solo los códigos que esa ruta puede devolver."""
    responses: dict[int | str, dict[str, Any]] = {s: ERROR_RESPONSES[s] for s in statuses}
    if conflicts:
        codes = ", ".join(f"`{code}`" for code in conflicts)
        missing = " `details.missing` lista lo que falta." if _UNMET in conflicts else ""
        responses[409] = {"model": ErrorOut, "description": f"Conflicto: {codes}.{missing}"}
    return responses


_UNMET = "publish_requirements_unmet"


def _name_gives_a_slug(name: str, info: ValidationInfo) -> str:
    """Sin slug, se genera del nombre (CATALOG-R3): si no se puede, el 422 va en name."""
    if "slug" in info.data and info.data["slug"] is None:
        slugify(name)
    return name


def _not_found() -> AppError:
    return AppError("not_found", "No existe.", 404)


def _invalid(field: str | None, type_: str, message: str) -> AppError:
    # Mismo formato que validation_error de shared/errors.py (T-019: loc, type, msg).
    loc = ["body", field] if field else ["body"]
    details = [{"loc": loc, "type": type_, "msg": message}]
    return AppError("validation_error", "Datos de entrada no válidos.", 422, details)


@contextmanager
def _domain_errors() -> Iterator[None]:
    """Traduce los errores del dominio a los códigos de la SPEC §7."""
    try:
        yield
    except CatalogNotFound:
        raise _not_found() from None
    except CatalogConflict as exc:
        raise AppError(f"{exc.field}_taken", str(exc), 409) from None
    except SlugLocked as exc:
        raise AppError("slug_locked", str(exc), 409) from None
    except NotPublishable as exc:
        details = {"missing": list(exc.missing)}
        raise AppError("publish_requirements_unmet", str(exc), 409, details) from None
    except CategoryInUse as exc:
        raise AppError("category_in_use", str(exc), 409) from None
    except LastImage as exc:
        raise AppError("last_image", str(exc), 409) from None
    except ImageTooLarge as exc:
        raise AppError("file_too_large", str(exc), 413) from None
    except UnsupportedImage as exc:
        raise AppError("unsupported_media_type", str(exc), 415) from None
    except InvalidImage:
        raise AppError("invalid_image", "La imagen está dañada o no se puede leer.", 422) from None
    except ImageDimensionsExceeded:
        message = "La imagen tiene demasiados píxeles."
        raise AppError("image_dimensions_exceeded", message, 422) from None
    except AnimatedImage:
        message = "No se aceptan imágenes animadas."
        raise AppError("animated_image", message, 422) from None
    except StorageUnavailable:
        message = "El almacenamiento de imágenes no está disponible."
        raise AppError("storage_unavailable", message, 503) from None
    except InvalidReference as exc:
        raise _invalid(exc.field, "reference_not_found", str(exc)) from None
    except CatalogError as exc:
        raise _invalid(None, "value_error", str(exc)) from None


def _code(code: str) -> str:
    """Un código con otro formato no puede existir: 404 sin llegar a la BD."""
    try:
        return check_slug(code)
    except CatalogError:
        raise _not_found() from None


# --- Esquemas de entrada (campos extra prohibidos: un status en el cuerpo → 422) ---

# Los topes solo se declaran en el OpenAPI (json_schema_extra): validar antes de normalizar
# rechazaría textos que recortados caben (T-018e).
Sku = Annotated[
    str,
    Field(json_schema_extra={"maxLength": SKU_MAX}),
    AfterValidator(lambda v: clean_text(v, SKU_MAX)),
]
Name = Annotated[
    str,
    Field(json_schema_extra={"maxLength": NAME_MAX}),
    AfterValidator(lambda v: clean_text(v, NAME_MAX)),
]
Description = Annotated[
    str,
    Field(json_schema_extra={"maxLength": DESCRIPTION_MAX}),
    AfterValidator(lambda v: clean_text(v, DESCRIPTION_MAX, required=False, multiline=True)),
]
Slug = Annotated[str, Field(json_schema_extra={"maxLength": SLUG_MAX}), AfterValidator(check_slug)]
Diameter = Annotated[Decimal, Field(gt=0, max_digits=4, decimal_places=1)]
NonNegative = Annotated[StrictInt, Field(ge=0, le=INT4_MAX)]
Positive = Annotated[StrictInt, Field(gt=0, le=INT4_MAX)]
Position = Annotated[StrictInt, Field(ge=-INT4_MAX, le=INT4_MAX)]
CategoryName = Annotated[
    str,
    Field(json_schema_extra={"maxLength": CATEGORY_NAME_MAX}),
    AfterValidator(lambda v: clean_text(v, CATEGORY_NAME_MAX)),
]
CategoryDescription = Annotated[
    str,
    Field(json_schema_extra={"maxLength": CATEGORY_DESCRIPTION_MAX}),
    AfterValidator(lambda v: clean_text(v, CATEGORY_DESCRIPTION_MAX, required=False)),
]
Label = Annotated[
    str,
    Field(json_schema_extra={"maxLength": LABEL_MAX}),
    AfterValidator(lambda v: clean_text(v, LABEL_MAX)),
]


def _fits_price_column(money: Money) -> Money:
    if money.amount > INT4_MAX:
        raise ValueError(f"El importe admite como máximo {INT4_MAX} céntimos.")
    return money


Price = Annotated[Money, AfterValidator(_fits_price_column)]


class SpecIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: Annotated[str, Field(json_schema_extra={"maxLength": SPEC_LABEL_MAX})]
    value: Annotated[str, Field(json_schema_extra={"maxLength": SPEC_VALUE_MAX})]


Specs = Annotated[
    list[SpecIn],
    Field(json_schema_extra={"maxItems": SPECS_MAX}),
    AfterValidator(lambda specs: check_specs(SpecEntry(s.label, s.value) for s in specs)),
]


class ProductCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: Sku
    slug: Slug | None = None  # None: se genera del nombre (CATALOG-R3)
    name: Name
    description: Description  # puede ir vacía en un borrador
    category_id: UUID
    price: Price
    order_policy: OrderPolicy
    lead_time_days: Positive | None = None
    movement_code: Slug | None = None
    case_material_code: Slug | None = None
    case_diameter_mm: Diameter | None = None
    water_resistance_m: NonNegative | None = None
    specs: Specs

    _check_name = field_validator("name")(_name_gives_a_slug)

    def to_fields(self) -> dict[str, object]:
        fields = {name: getattr(self, name) for name in type(self).model_fields}
        return fields | {"price": self.price.amount}


class ProductUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Omitibles pero no nulos: Pydantic no valida el default, así que un null explícito → 422.
    sku: Sku = None
    slug: Slug = None
    name: Name = None
    description: Description = None
    category_id: UUID = None
    price: Price = None
    order_policy: OrderPolicy = None
    specs: Specs = None
    # Atributos opcionales: null los borra.
    lead_time_days: Positive | None = None
    movement_code: Slug | None = None
    case_material_code: Slug | None = None
    case_diameter_mm: Diameter | None = None
    water_resistance_m: NonNegative | None = None

    def to_changes(self) -> dict[str, object]:
        changes = {name: getattr(self, name) for name in self.model_fields_set}
        if "price" in changes:
            changes["price"] = self.price.amount
        return changes


class AdminProductListIn(BaseModel):
    status: ProductStatus | None = None
    q: SearchText | None = None
    page: int = Field(1, ge=1, le=1000)
    page_size: int = Field(PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX)

    @model_validator(mode="after")
    def _check_query(self) -> Self:
        self.to_domain()  # CatalogError es un ValueError: 422 con el formato común
        return self

    def to_domain(self) -> AdminProductQuery:
        return AdminProductQuery(self.status, self.q, self.page, self.page_size)


class CategoryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: Slug | None = None  # None: se genera del nombre
    name: CategoryName
    description: CategoryDescription | None = None
    position: Position = 0
    is_active: StrictBool = True

    _check_name = field_validator("name")(_name_gives_a_slug)


class CategoryUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: Slug = None
    name: CategoryName = None
    description: CategoryDescription | None = None  # null la borra
    position: Position = None
    is_active: StrictBool = None

    def to_changes(self) -> dict[str, object]:
        changes = {name: getattr(self, name) for name in self.model_fields_set}
        if "description" in changes:
            changes["description"] = changes["description"] or None  # "" también la borra
        return changes


class AttributeValueIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Slug
    label: Label
    position: Position = 0
    is_active: StrictBool = True


class AttributeValueUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")  # el code va en la ruta y no cambia

    label: Label = None
    position: Position = None
    is_active: StrictBool = None


# --- Esquemas de salida (SPEC §7: AdminProduct, AdminCategory, AdminAttributeValue) ---

UtcDatetime = Annotated[datetime, AfterValidator(lambda value: value.astimezone(UTC))]


class AdminProductOut(BaseModel):
    id: UUID
    slug: str
    sku: str
    name: str
    category: CategoryRefOut
    price: Money
    movement: AttributeValueOut | None
    case_material: AttributeValueOut | None
    case_diameter_mm: float | None
    water_resistance_m: int | None
    main_image: ProductImageOut | None  # un borrador puede no tener imágenes
    description: str
    specs: list[SpecOut]
    images: list[ProductImageOut]
    status: ProductStatus
    order_policy: OrderPolicy
    lead_time_days: int | None
    category_id: UUID
    movement_code: str | None
    case_material_code: str | None
    published_at: UtcDatetime | None  # primera publicación (CATALOG-R3)
    created_at: UtcDatetime
    updated_at: UtcDatetime

    @classmethod
    def from_domain(cls, view: AdminProductView) -> Self:
        product = view.product
        images = [ProductImageOut.from_domain(image) for image in view.images]
        diameter = product.case_diameter_mm
        return cls(
            id=product.id,
            slug=product.slug,
            sku=product.sku,
            name=product.name,
            category=CategoryRefOut(slug=view.category.slug, name=view.category.name),
            price=Money(amount=product.price),
            movement=AttributeValueOut.from_domain(view.movement),
            case_material=AttributeValueOut.from_domain(view.case_material),
            case_diameter_mm=None if diameter is None else float(diameter),
            water_resistance_m=product.water_resistance_m,
            main_image=images[0] if images else None,
            description=product.description,
            specs=[SpecOut(label=spec.label, value=spec.value) for spec in product.specs],
            images=images,
            status=product.status,
            order_policy=product.order_policy,
            lead_time_days=product.lead_time_days,
            category_id=product.category_id,
            movement_code=product.movement_code,
            case_material_code=product.case_material_code,
            published_at=product.published_at,
            created_at=view.created_at,
            updated_at=view.updated_at,
        )


class AdminProductPageOut(BaseModel):
    items: list[AdminProductOut]
    total: int
    page: int
    page_size: int


class AdminCategoryOut(BaseModel):
    id: UUID
    slug: str
    name: str
    description: str | None
    position: int
    is_active: bool

    @classmethod
    def from_domain(cls, category: Category) -> Self:
        return cls(**vars(category))


class AdminAttributeValueOut(BaseModel):
    code: str
    label: str
    position: int
    is_active: bool

    @classmethod
    def from_domain(cls, value: AttributeValue) -> Self:
        return cls(**vars(value))


class AdminAttributesOut(BaseModel):
    movements: list[AdminAttributeValueOut]
    case_materials: list[AdminAttributeValueOut]


# --- Rutas (todas con require_admin: 401 sin token válido, 403 si no es admin) ---

router = APIRouter(
    prefix="/api/v1/catalog/admin",
    tags=["catalog-admin"],
    dependencies=[Depends(require_admin)],
    responses=_errors(401, 403, 503),
)


@router.get("/products", responses=_errors(422))
def list_products(
    params: Annotated[AdminProductListIn, Query()], repo: Products
) -> AdminProductPageOut:
    query = params.to_domain()
    page = repo.list_all(query)
    return AdminProductPageOut(
        items=[AdminProductOut.from_domain(view) for view in page.items],
        total=page.total,
        page=query.page,
        page_size=query.page_size,
    )


@router.get("/products/{product_id}", responses=_errors(404, 422))
def get_product(product_id: UUID, repo: Products) -> AdminProductOut:
    if (view := repo.get(product_id)) is None:
        raise _not_found()
    return AdminProductOut.from_domain(view)


@router.post(
    "/products", status_code=201, responses=_errors(422, conflicts=("sku_taken", "slug_taken"))
)
def create_product(
    body: ProductCreateIn, repo: Products, audit: AuditRecorderDep, actor: ActorDep
) -> AdminProductOut:
    with _domain_errors():
        return AdminProductOut.from_domain(CreateProduct(repo, audit)(body.to_fields(), actor))


@router.patch(
    "/products/{product_id}",
    responses=_errors(
        404,
        422,
        conflicts=("sku_taken", "slug_taken", "slug_locked", _UNMET),  # R2 si publicado
    ),
)
def update_product(
    product_id: UUID,
    body: ProductUpdateIn,
    repo: Products,
    categories: Categories,
    audit: AuditRecorderDep,
    actor: ActorDep,
) -> AdminProductOut:
    with _domain_errors():
        view = UpdateProduct(repo, categories, audit)(product_id, body.to_changes(), actor)
    return AdminProductOut.from_domain(view)


@router.post("/products/{product_id}/publish", responses=_errors(404, 422, conflicts=(_UNMET,)))
def publish_product(
    product_id: UUID,
    repo: Products,
    categories: Categories,
    audit: AuditRecorderDep,
    actor: ActorDep,
) -> AdminProductOut:
    with _domain_errors():
        view = PublishProduct(repo, categories, audit)(product_id, actor)
    return AdminProductOut.from_domain(view)


@router.post("/products/{product_id}/unpublish", responses=_errors(404, 422))
def unpublish_product(
    product_id: UUID, repo: Products, audit: AuditRecorderDep, actor: ActorDep
) -> AdminProductOut:
    with _domain_errors():
        return AdminProductOut.from_domain(UnpublishProduct(repo, audit)(product_id, actor))


@router.get("/categories")
def list_categories(repo: Categories) -> list[AdminCategoryOut]:
    return [AdminCategoryOut.from_domain(category) for category in repo.list_all()]


@router.post("/categories", status_code=201, responses=_errors(422, conflicts=("slug_taken",)))
def create_category(body: CategoryIn, repo: Categories) -> AdminCategoryOut:
    with _domain_errors():
        return AdminCategoryOut.from_domain(CreateCategory(repo)(body.model_dump()))


@router.patch(
    "/categories/{category_id}",
    responses=_errors(404, 422, conflicts=("slug_taken", "category_in_use")),
)
def update_category(
    category_id: UUID, body: CategoryUpdateIn, repo: Categories
) -> AdminCategoryOut:
    with _domain_errors():
        return AdminCategoryOut.from_domain(UpdateCategory(repo)(category_id, body.to_changes()))


@router.get("/attributes")
def list_attributes(repo: Attributes) -> AdminAttributesOut:
    def values(kind: AttributeKind) -> list[AdminAttributeValueOut]:
        return [AdminAttributeValueOut.from_domain(v) for v in repo.list_all(kind)]

    return AdminAttributesOut(
        movements=values(AttributeKind.MOVEMENT),
        case_materials=values(AttributeKind.CASE_MATERIAL),
    )


def _attribute_routes(path: str, kind: AttributeKind) -> None:
    """POST y PATCH de una lista de valores (movement-types y case-materials)."""

    responses = _errors(422, conflicts=("code_taken",))

    @router.post(path, status_code=201, responses=responses, name=f"create_{kind}")
    def create(body: AttributeValueIn, repo: Attributes) -> AdminAttributeValueOut:
        with _domain_errors():
            value = AttributeValue(**body.model_dump())
            repo.add(kind, value)
        return AdminAttributeValueOut.from_domain(value)

    @router.patch(f"{path}/{{code}}", responses=_errors(404, 422), name=f"update_{kind}")
    def update(
        code: Annotated[str, Path(json_schema_extra={"maxLength": SLUG_MAX})],
        body: AttributeValueUpdateIn,
        repo: Attributes,
    ) -> AdminAttributeValueOut:
        changes = {name: getattr(body, name) for name in body.model_fields_set}
        with _domain_errors():
            value = UpdateAttributeValue(repo)(kind, _code(code), changes)
        return AdminAttributeValueOut.from_domain(value)


_attribute_routes("/movement-types", AttributeKind.MOVEMENT)
_attribute_routes("/case-materials", AttributeKind.CASE_MATERIAL)


# --- Imágenes (T-029; SPEC §7 y §9) ---


@cache
def get_image_storage() -> ImageStorage:
    """Un cliente para toda la app. Las pruebas lo sustituyen con dependency_overrides."""
    settings = get_settings()
    key = settings.supabase_service_role_key
    if not (settings.supabase_url and key and key.get_secret_value()):
        raise RuntimeError("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (backend/.env).")
    return SupabaseImageStorage(settings.supabase_url, key.get_secret_value())


Storage = Annotated[ImageStorage, Depends(get_image_storage)]


def get_image_optimizer() -> ImageOptimizer:
    return PillowImageOptimizer()


Optimizer = Annotated[ImageOptimizer, Depends(get_image_optimizer)]
Alt = Annotated[
    str,
    Field(json_schema_extra={"maxLength": ALT_MAX}),
    AfterValidator(lambda v: clean_text(v, ALT_MAX)),
]
_MAX_MIB = IMAGE_MAX_BYTES // 2**20
_BODY_MAX = IMAGE_MAX_BYTES + 64 * 1024  # el archivo más el resto del multipart (alt, límites)
_IMAGE_ERRORS: dict[int | str, dict[str, Any]] = {
    413: {"model": ErrorOut, "description": f"`file_too_large`: más de {_MAX_MIB} MiB."},
    415: {
        "model": ErrorOut,
        "description": "`unsupported_media_type`: por su firma, no es JPEG, PNG ni WebP.",
    },
    422: {
        "model": ErrorOut,
        "description": "`invalid_image`, `image_dimensions_exceeded` o `animated_image`.",
    },
    503: {
        "model": ErrorOut,
        "description": "`auth_unavailable` o `storage_unavailable`: Auth o Storage no responden.",
    },
}


class _BoundedBodyRoute(APIRoute):
    """Rechaza el cuerpo por su Content-Length antes de que FastAPI lo lea (SPEC §9). Sin
    Content-Length tampoco se lee: su tamaño no se podría acotar."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            length = request.headers.get("content-length", "")
            if not length.isdigit() or int(length) > _BODY_MAX:
                message = f"La imagen no puede superar {_MAX_MIB} MiB (con Content-Length)."
                raise AppError("file_too_large", message, 413)
            return await handler(request)

        return bounded


class ImageUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alt: Alt


def upload_image(
    product_id: UUID,
    file: Annotated[UploadFile, File()],
    alt: Annotated[Alt, Form()],
    repo: Products,
    storage: Storage,
    optimizer: Optimizer,
) -> ProductImageOut:
    # Como mucho el límite + 1 bytes: lo justo para saber si lo supera. Se ignoran el nombre y
    # el Content-Type del archivo: el tipo sale de su firma.
    data = file.file.read(IMAGE_MAX_BYTES + 1)
    with _domain_errors():
        return ProductImageOut.from_domain(
            AddProductImage(repo, storage, optimizer)(product_id, data, alt)
        )


router.add_api_route(
    "/products/{product_id}/images",
    upload_image,
    methods=["POST"],
    status_code=201,
    responses=_errors(404, 422) | _IMAGE_ERRORS,
    route_class_override=_BoundedBodyRoute,
)


@router.patch("/products/{product_id}/images/{image_id}", responses=_errors(404, 422))
def update_image(
    product_id: UUID, image_id: UUID, body: ImageUpdateIn, repo: Products
) -> ProductImageOut:
    with _domain_errors():
        return ProductImageOut.from_domain(UpdateProductImage(repo)(product_id, image_id, body.alt))


@router.put("/products/{product_id}/images/order", responses=_errors(404, 422))
def reorder_images(
    product_id: UUID, image_ids: Annotated[list[UUID], Body()], repo: Products
) -> list[ProductImageOut]:
    with _domain_errors():
        images = ReorderProductImages(repo)(product_id, image_ids)
    return [ProductImageOut.from_domain(image) for image in images]


@router.delete(
    "/products/{product_id}/images/{image_id}",
    status_code=204,
    responses=_errors(404, 422, conflicts=("last_image",)),
)
def delete_image(
    product_id: UUID,
    image_id: UUID,
    repo: Products,
    storage: Storage,
    background: BackgroundTasks,
) -> None:
    with _domain_errors():
        path = RemoveProductImage(repo)(product_id, image_id)
    # Corre tras enviar la respuesta, y por tanto tras el commit (SessionDep): si la transacción
    # falla, la fila sigue y el archivo también.
    background.add_task(discard_file, storage, path)
