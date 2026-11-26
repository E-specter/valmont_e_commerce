from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Response
from pydantic import BaseModel, ConfigDict, Field

from valmont.modules.audit.adapters.http import AuditRecorderDep
from valmont.modules.cart.adapters.wiring import (
    get_prepare_checkout,
    get_remove_checked_out_items,
)
from valmont.modules.cart.application import (
    CheckoutBlocked,
    EmptySelection,
    PrepareCheckout,
    RemoveCheckedOutItems,
)
from valmont.modules.identity.adapters.http import current_user
from valmont.modules.identity.domain import CurrentUser
from valmont.modules.inventory.adapters.wiring import get_reserve_stock
from valmont.modules.inventory.application import InsufficientStock, ReserveStock
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.adapters.pickup import SettingsPickupStore
from valmont.modules.orders.application import (
    Clock,
    CreateOrder,
    OrderRepository,
    PickupStore,
    PickupStoreProvider,
)
from valmont.modules.orders.domain import (
    MAX_PENDING_ORDERS,
    ActorKind,
    DeliveryDetails,
    DeliveryInvalid,
    DeliveryMethod,
    Fulfillment,
    IdempotencyConflict,
    Order,
    OrderStatus,
    PickupUnavailable,
    TooManyPendingOrders,
    can_customer_cancel,
    format_order_number,
)
from valmont.shared.config import get_settings
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError, ErrorOut
from valmont.shared.money import Money
from valmont.shared.product_snapshots import ProductSnapshot, SqlProductSnapshots, image_url

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])


def _money(cents: int) -> Money:
    return Money(amount=cents)


# --- Entrada (SPEC §7; R13): esquema cerrado por modalidad, sin importes ni user_id ---


class _DeliveryBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recipient_name: str
    phone: str


class ShippingIn(_DeliveryBase):
    delivery_method: Literal["shipping"]
    department: str
    province: str
    district: str
    address_line: str
    reference: str | None = None


class PickupIn(_DeliveryBase):
    delivery_method: Literal["pickup"]


# Unión discriminada por `delivery_method`; el cuerpo cierra el esquema de cada variante.
DeliveryIn = Annotated[ShippingIn | PickupIn, Field(discriminator="delivery_method")]


class CreateOrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    delivery: DeliveryIn


def _to_domain(delivery: ShippingIn | PickupIn) -> DeliveryDetails:
    """Los límites y la normalización son del dominio (R13); un fallo es 422 con el campo."""
    values = delivery.model_dump(exclude={"delivery_method"})
    try:
        return DeliveryDetails(DeliveryMethod(delivery.delivery_method), **values)
    except DeliveryInvalid as exc:
        loc = ["body", "delivery", delivery.delivery_method, exc.field]
        detail = [{"loc": loc, "type": "value_error", "msg": exc.message}]
        raise AppError("validation_error", "Datos de entrada no válidos.", 422, detail) from None


# --- Salida ---


class OrderImageOut(BaseModel):
    url: str
    alt: str


class OrderLineOut(BaseModel):
    product_id: UUID
    sku: str
    name: str
    image: OrderImageOut | None  # D-041 P-7: del producto vivo; no se guarda en el pedido
    quantity: int
    list_price: Money
    unit_price: Money
    discount_amount: Money  # por unidad
    line_total: Money
    fulfillment: Fulfillment
    lead_time_days: int | None


class PickupStoreOut(BaseModel):
    name: str
    address: str
    hours: str


class DeliveryOut(BaseModel):
    delivery_method: DeliveryMethod
    recipient_name: str
    phone: str
    department: str | None
    province: str | None
    district: str | None
    address_line: str | None
    reference: str | None
    pickup_store: PickupStoreOut | None
    carrier: str | None
    tracking_code: str | None
    shipped_at: datetime | None


class HistoryEntryOut(BaseModel):
    from_status: OrderStatus | None
    status: OrderStatus
    at: datetime
    actor: ActorKind


class RefundOut(BaseModel):
    amount: Money
    at: datetime


class OrderDetailOut(BaseModel):
    id: UUID
    number: str
    status: OrderStatus
    total: Money
    item_count: int
    created_at: datetime
    expires_at: datetime | None
    estimated_delivery_on: str | None
    paid_at: datetime | None
    expires_in_seconds: int | None
    subtotal: Money
    shipping: Money
    lines: list[OrderLineOut]
    delivery: DeliveryOut
    refund: RefundOut | None
    history: list[HistoryEntryOut]
    can_cancel: bool

    @classmethod
    def build(
        cls,
        order: Order,
        now: datetime,
        store: PickupStore | None,
        products: dict[UUID, ProductSnapshot],
    ) -> OrderDetailOut:
        pending = order.status == OrderStatus.PENDING_PAYMENT
        d = order.delivery
        lines = []
        for line in order.lines:
            snap = products.get(line.product_id)
            image = (
                OrderImageOut(url=image_url(snap.image_path), alt=snap.alt or "")
                if snap and snap.image_path
                else None
            )
            lines.append(
                OrderLineOut(
                    product_id=line.product_id,
                    sku=line.sku,
                    name=line.name,
                    image=image,
                    quantity=line.quantity,
                    list_price=_money(line.list_price),
                    unit_price=_money(line.unit_price),
                    discount_amount=_money(line.discount_amount),
                    line_total=_money(line.line_total),
                    fulfillment=line.fulfillment,
                    lead_time_days=line.lead_time_days,
                )
            )
        pickup = (
            PickupStoreOut(name=store.name, address=store.address, hours=store.hours)
            if store and d.delivery_method == DeliveryMethod.PICKUP
            else None
        )
        refund = (
            RefundOut(amount=_money(order.refunded_amount), at=order.refunded_at)
            if order.refunded_amount is not None and order.refunded_at is not None
            else None
        )
        return cls(
            id=order.id,
            number=format_order_number(order.number or 0),
            status=order.status,
            total=_money(order.total_amount),
            item_count=sum(line.quantity for line in order.lines),
            created_at=order.created_at,
            expires_at=order.expires_at if pending else None,
            estimated_delivery_on=(
                order.estimated_delivery_on.isoformat() if order.estimated_delivery_on else None
            ),
            paid_at=order.paid_at,
            expires_in_seconds=(
                max(0, int((order.expires_at - now).total_seconds())) if pending else None
            ),
            subtotal=_money(order.subtotal_amount),
            shipping=_money(order.shipping_amount),
            lines=lines,
            delivery=DeliveryOut(
                delivery_method=d.delivery_method,
                recipient_name=d.recipient_name,
                phone=d.phone,
                department=d.department,
                province=d.province,
                district=d.district,
                address_line=d.address_line,
                reference=d.reference,
                pickup_store=pickup,
                # El dominio aún no los trae (llegan con las transiciones del administrador).
                carrier=None,
                tracking_code=None,
                shipped_at=None,
            ),
            refund=refund,
            history=[
                HistoryEntryOut(
                    from_status=h.from_status, status=h.to_status, at=h.at, actor=h.actor_kind
                )
                for h in order.history
            ],
            can_cancel=can_customer_cancel(order.status),
        )


# --- Proveedores ---


def get_orders(session: SessionDep) -> OrderRepository:
    return SqlOrderRepository(session)


def get_clock(session: SessionDep) -> Clock:
    return SqlClock(session)


def get_pickup_store() -> PickupStoreProvider:
    return SettingsPickupStore(get_settings())


def get_create_order(
    orders: Annotated[OrderRepository, Depends(get_orders)],
    prepare: Annotated[PrepareCheckout, Depends(get_prepare_checkout)],
    remove: Annotated[RemoveCheckedOutItems, Depends(get_remove_checked_out_items)],
    reserve: Annotated[ReserveStock, Depends(get_reserve_stock)],
    pickup_store: Annotated[PickupStoreProvider, Depends(get_pickup_store)],
    clock: Annotated[Clock, Depends(get_clock)],
    audit: AuditRecorderDep,
) -> CreateOrder:
    return CreateOrder(orders, prepare, remove, reserve, pickup_store, clock, audit)


def get_product_snapshots(session: SessionDep) -> SqlProductSnapshots:
    return SqlProductSnapshots(session)


# --- Errores ---


def _example(code: str, message: str, details: object = None) -> dict[str, object]:
    return {"value": {"error": {"code": code, "message": message, "details": details}}}


_PRODUCT = "00000000-0000-0000-0000-000000000001"
_CONFLICT = {
    "model": ErrorOut,
    "description": "`empty_selection`, `checkout_blocked`, `insufficient_stock`,"
    " `too_many_pending_orders`, `pickup_unavailable` o `idempotency_conflict`."
    " `details`: `issues` (checkout_blocked), `product_ids` (insufficient_stock),"
    " `max` (too_many_pending_orders); sin `details` en los demás.",
    "content": {
        "application/json": {
            "examples": {
                "empty_selection": _example("empty_selection", "No hay artículos seleccionados."),
                "checkout_blocked": _example(
                    "checkout_blocked",
                    "Hay artículos que no se pueden comprar.",
                    {"issues": [{"product_id": _PRODUCT, "status": "out_of_stock"}]},
                ),
                "insufficient_stock": _example(
                    "insufficient_stock",
                    "Otro cliente reservó antes las unidades.",
                    {"product_ids": [_PRODUCT]},
                ),
                "too_many_pending_orders": _example(
                    "too_many_pending_orders",
                    "Tienes demasiados pedidos pendientes de pago.",
                    {"max": MAX_PENDING_ORDERS},
                ),
                "pickup_unavailable": _example(
                    "pickup_unavailable", "El recojo en tienda no está disponible."
                ),
                "idempotency_conflict": _example(
                    "idempotency_conflict", "Solicitud en curso; reintente."
                ),
            }
        }
    },
}


def _conflict(code: str, message: str, details: object = None) -> AppError:
    return AppError(code, message, 409, details)


@contextmanager
def _translated() -> Iterator[None]:
    try:
        yield
    except EmptySelection:
        raise _conflict("empty_selection", "No hay artículos seleccionados.") from None
    except CheckoutBlocked as exc:
        issues = [{"product_id": i.product_id, "status": i.status.value} for i in exc.issues]
        raise _conflict(
            "checkout_blocked", "Hay artículos que no se pueden comprar.", {"issues": issues}
        ) from None
    except InsufficientStock as exc:
        raise _conflict(
            "insufficient_stock",
            "Otro cliente reservó antes las unidades.",
            {"product_ids": list(exc.product_ids)},
        ) from None
    except TooManyPendingOrders:
        raise _conflict(
            "too_many_pending_orders",
            "Tienes demasiados pedidos pendientes de pago.",
            {"max": MAX_PENDING_ORDERS},
        ) from None
    except PickupUnavailable:
        raise _conflict("pickup_unavailable", "El recojo en tienda no está disponible.") from None
    except IdempotencyConflict:
        raise _conflict("idempotency_conflict", "Solicitud en curso; reintente.") from None


IdempotencyKey = Annotated[
    str,
    Header(alias="idempotency-key", min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
]


@router.post(
    "",
    status_code=201,
    response_model=OrderDetailOut,
    responses={
        **{s: ERROR_RESPONSES[s] for s in (401, 422, 503)},
        200: {"model": OrderDetailOut, "description": "Repite la clave: el pedido original."},
        409: _CONFLICT,
    },
)
def create_order(
    body: CreateOrderIn,
    idempotency_key: IdempotencyKey,
    response: Response,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[CreateOrder, Depends(get_create_order)],
    clock: Annotated[Clock, Depends(get_clock)],
    store: Annotated[PickupStoreProvider, Depends(get_pickup_store)],
    products: Annotated[SqlProductSnapshots, Depends(get_product_snapshots)],
) -> OrderDetailOut:
    delivery = _to_domain(body.delivery)
    with _translated():
        result = use_case(user.user_id, idempotency_key, delivery)
    if not result.created:
        response.status_code = 200
    order = result.order
    snapshots = products.get_published([line.product_id for line in order.lines])
    return OrderDetailOut.build(order, clock.now(), store.get(), snapshots)
