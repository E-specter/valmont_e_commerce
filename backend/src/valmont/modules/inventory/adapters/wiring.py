"""Proveedores de los casos de uso públicos de inventory para otros módulos (modules.md §3,
excepción 7). Sin lógica: construyen el caso de uso con los repositorios SQL y la sesión de la
solicitud. Corren en la transacción de quien los llama y no hacen commit.
"""

from valmont.modules.inventory.adapters.persistence import (
    SqlMovementRepository,
    SqlProductPolicies,
    SqlReservationRepository,
    SqlStockRepository,
)
from valmont.modules.inventory.application import (
    ConsumeReservations,
    ReleaseReservations,
    ReserveStock,
)
from valmont.shared.db import SessionDep


def get_reserve_stock(session: SessionDep) -> ReserveStock:
    return ReserveStock(
        SqlProductPolicies(session), SqlStockRepository(session), SqlReservationRepository(session)
    )


def get_consume_reservations(session: SessionDep) -> ConsumeReservations:
    return ConsumeReservations(
        SqlStockRepository(session),
        SqlReservationRepository(session),
        SqlMovementRepository(session),
    )


def get_release_reservations(session: SessionDep) -> ReleaseReservations:
    return ReleaseReservations(SqlReservationRepository(session))
