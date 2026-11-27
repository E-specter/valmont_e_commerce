"""Proveedor de `EnsureAdult` para orders (modules.md §3, excepción 7). Sin lógica: usa la sesión
de la solicitud (misma transacción). No importa `identity.adapters.http`.
"""

from valmont.modules.identity.adapters.persistence import SqlProfileRepository
from valmont.modules.identity.application import EnsureAdult
from valmont.shared.db import SessionDep


def get_ensure_adult(session: SessionDep) -> EnsureAdult:
    return EnsureAdult(SqlProfileRepository(session))
