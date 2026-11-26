"""Proveedores de los casos de uso públicos de cart para otros módulos (modules.md §3, excepción 7).

Sin lógica: construyen el caso de uso con los repositorios SQL y la sesión de la solicitud.
Corren en la transacción de quien los llama y no hacen commit.
"""

from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import PrepareCheckout, RemoveCheckedOutItems
from valmont.shared.db import SessionDep


def get_prepare_checkout(session: SessionDep) -> PrepareCheckout:
    return PrepareCheckout(SqlCartRepository(session), SqlCartCatalog(session))


def get_remove_checked_out_items(session: SessionDep) -> RemoveCheckedOutItems:
    return RemoveCheckedOutItems(SqlCartRepository(session))
