import unicodedata
from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from valmont.modules.identity.adapters.http import require_admin
from valmont.modules.orders.adapters.http import (
    HistoryEntryOut,
    OrderDetailOut,
    OrderSummaryOut,
    get_clock,
    get_expire_overdue_orders,
    get_orders,
    get_pickup_store,
    get_product_snapshots,
)
from valmont.modules.orders.application import (
    AdminOrderQuery,
    Clock,
    ExpireOverdueOrders,
    GetAdminOrder,
    ListAdminOrders,
    OrderRepository,
    PickupStoreProvider,
)
from valmont.modules.orders.domain import (
    OrderNotFound,
    OrderStatus,
    admin_targets,
    format_order_number,
)
from valmont.shared.errors import ERROR_RESPONSES, AppError
from valmont.shared.money import Money
from valmont.shared.product_snapshots import SqlProductSnapshots

# Excepción documentada en modules.md §3: require_admin (y su CurrentUser) desde identity.
# Se declara antes que el router del cliente (main.py): `/admin` no lo captura `/{order_id}`.
router = APIRouter(prefix="/api/v1/orders/admin", tags=["orders"])

# --- Salida (SPEC §7) ---


class AdminOrderSummaryOut(OrderSummaryOut):
    user_id: UUID
    recipient_name: str
    district: str | None


class AdminOrderPageOut(BaseModel):
    items: list[AdminOrderSummaryOut]
    total: int
    page: int
    page_size: int


class AdminHistoryEntryOut(HistoryEntryOut):
    actor_id: UUID | None
    note: str | None


class AdminOrderDetailOut(OrderDetailOut):
    user_id: UUID
    history: list[AdminHistoryEntryOut]  # type: ignore[assignment]
    can_transition_to: list[OrderStatus]


# --- Proveedores ---


def get_list_admin_orders(
    orders: Annotated[OrderRepository, Depends(get_orders)],
    expire: Annotated[ExpireOverdueOrders, Depends(get_expire_overdue_orders)],
) -> ListAdminOrders:
    return ListAdminOrders(orders, expire)


def get_get_admin_order(
    orders: Annotated[OrderRepository, Depends(get_orders)],
    expire: Annotated[ExpireOverdueOrders, Depends(get_expire_overdue_orders)],
) -> GetAdminOrder:
    return GetAdminOrder(orders, expire)


_ERRORS = {s: ERROR_RESPONSES[s] for s in (401, 403, 422, 503)}


@router.get(
    "",
    response_model=AdminOrderPageOut,
    responses=_ERRORS,
    dependencies=[Depends(require_admin)],
)
def list_orders(
    use_case: Annotated[ListAdminOrders, Depends(get_list_admin_orders)],
    status: Annotated[OrderStatus | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    created_from: Annotated[date | None, Query()] = None,
    created_to: Annotated[date | None, Query()] = None,
    page: Annotated[int, Query(ge=1, le=1000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=50)] = 20,
) -> AdminOrderPageOut:
    # Cc (NUL rompe un text de PostgreSQL) y Cs (sustituto suelto), como R13.
    if q and any(unicodedata.category(c) in ("Cc", "Cs") for c in q):
        detail = [
            {"loc": ["query", "q"], "type": "value_error", "msg": "Caracteres no permitidos."}
        ]
        raise AppError("validation_error", "Datos de entrada no válidos.", 422, detail)
    result = use_case(AdminOrderQuery(status, q, created_from, created_to, page, page_size))
    return AdminOrderPageOut(
        items=[
            AdminOrderSummaryOut(
                id=o.id,
                number=format_order_number(o.number),
                status=o.status,
                total=Money(amount=o.total_amount),
                item_count=o.item_count,
                created_at=o.created_at,
                expires_at=o.expires_at if o.status == OrderStatus.PENDING_PAYMENT else None,
                estimated_delivery_on=(
                    o.estimated_delivery_on.isoformat() if o.estimated_delivery_on else None
                ),
                user_id=o.user_id,
                recipient_name=o.recipient_name,
                district=o.district,
            )
            for o in result.items
        ],
        total=result.total,
        page=result.page,
        page_size=result.page_size,
    )


@router.get(
    "/{order_id}",
    response_model=AdminOrderDetailOut,
    responses={s: ERROR_RESPONSES[s] for s in (401, 403, 404, 422, 503)},
    dependencies=[Depends(require_admin)],
)
def get_order(
    order_id: UUID,
    use_case: Annotated[GetAdminOrder, Depends(get_get_admin_order)],
    clock: Annotated[Clock, Depends(get_clock)],
    store: Annotated[PickupStoreProvider, Depends(get_pickup_store)],
    products: Annotated[SqlProductSnapshots, Depends(get_product_snapshots)],
) -> AdminOrderDetailOut:
    try:
        order = use_case(order_id)
    except OrderNotFound:
        raise AppError("not_found", "Pedido no encontrado.", 404) from None
    snapshots = products.get_published([line.product_id for line in order.lines])
    base = OrderDetailOut.build(order, clock.now(), store.get(), snapshots)
    targets = admin_targets(order.status, order.delivery.delivery_method)
    return AdminOrderDetailOut(
        **base.model_dump(exclude={"history"}),
        user_id=order.user_id,
        history=[
            AdminHistoryEntryOut(
                from_status=h.from_status,
                status=h.to_status,
                at=h.at,
                actor=h.actor_kind,
                actor_id=h.actor_id,
                note=h.note,
            )
            for h in order.history
        ],
        can_transition_to=[s for s in OrderStatus if s in targets],
    )
