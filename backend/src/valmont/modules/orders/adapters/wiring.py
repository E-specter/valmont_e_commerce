"""Proveedores de los casos de uso de orders para payments (modules.md §3, excepción 7). Sin
lógica: construyen el caso de uso con los repositorios SQL y la sesión de la solicitud. Corren en
la transacción de quien los llama y no hacen commit. No importan `orders.adapters.http`.
"""

from typing import Annotated

from fastapi import Depends

from valmont.modules.audit.adapters.http import AuditRecorderDep
from valmont.modules.inventory.adapters.wiring import (
    get_consume_reservations,
    get_release_reservations,
)
from valmont.modules.inventory.application import ConsumeReservations, ReleaseReservations
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.application import (
    ConfirmOrderPayment,
    ExpireOverdueOrders,
    GetPayableOrder,
)
from valmont.shared.db import SessionDep


def get_get_payable_order(
    session: SessionDep,
    release: Annotated[ReleaseReservations, Depends(get_release_reservations)],
    audit: AuditRecorderDep,
) -> GetPayableOrder:
    orders = SqlOrderRepository(session)
    return GetPayableOrder(orders, ExpireOverdueOrders(orders, release, audit, SqlClock(session)))


def get_confirm_order_payment(
    session: SessionDep,
    consume: Annotated[ConsumeReservations, Depends(get_consume_reservations)],
    release: Annotated[ReleaseReservations, Depends(get_release_reservations)],
    audit: AuditRecorderDep,
) -> ConfirmOrderPayment:
    return ConfirmOrderPayment(
        SqlOrderRepository(session), consume, release, audit, SqlClock(session)
    )
