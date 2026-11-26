"""Dominio y puerto de wishlist sin BD (T-066; WISH-R4, R5, R1 en lo que el paquete implementa).

El dominio de T-066 es solo la constante del tope blando, `WishlistFull`, el estado de un artículo
y el puerto con `WishlistEntry`. Contar antes de insertar (R4) y la idempotencia del caso de uso son
de T-068; la unicidad (RN-03) y la idempotencia del repositorio se prueban contra la BD en
`test_persistence.py`.
"""

import ast
from dataclasses import FrozenInstanceError, fields
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from uuid import uuid4

import pytest

from valmont.modules.wishlist import application, domain
from valmont.modules.wishlist.application import WishlistEntry, WishlistRepository
from valmont.modules.wishlist.domain import WISHLIST_MAX_ITEMS, WishlistFull, WishlistItemStatus

NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)


def test_the_soft_cap_is_fifty_items() -> None:
    # WISH-R4 / D-039.2: constante del dominio, no un CHECK ni una configuración.
    assert WISHLIST_MAX_ITEMS == 50
    assert isinstance(WISHLIST_MAX_ITEMS, int) and not isinstance(WISHLIST_MAX_ITEMS, bool)


def test_wishlist_full_is_a_plain_domain_exception() -> None:
    assert issubclass(WishlistFull, Exception)
    with pytest.raises(WishlistFull):
        raise WishlistFull


def test_item_status_has_exactly_available_and_unavailable() -> None:
    # WISH-R5: agotado no es un estado de la lista.
    assert issubclass(WishlistItemStatus, StrEnum)
    assert {status.name: status.value for status in WishlistItemStatus} == {
        "AVAILABLE": "available",
        "UNAVAILABLE": "unavailable",
    }
    assert WishlistItemStatus("available") is WishlistItemStatus.AVAILABLE
    assert f"{WishlistItemStatus.UNAVAILABLE}" == "unavailable"  # se serializa como texto
    with pytest.raises(ValueError):
        WishlistItemStatus("out_of_stock")


def test_wishlist_entry_holds_product_and_added_at_and_is_immutable() -> None:
    product_id = uuid4()
    entry = WishlistEntry(product_id=product_id, added_at=NOW)

    assert [f.name for f in fields(entry)] == ["product_id", "added_at"]
    assert (entry.product_id, entry.added_at) == (product_id, NOW)
    assert entry == WishlistEntry(product_id, NOW)
    with pytest.raises(FrozenInstanceError):
        entry.added_at = NOW.replace(year=2027)  # type: ignore[misc]


def test_the_repository_port_exposes_list_add_and_remove() -> None:
    for name in ("list_for_user", "add", "remove"):
        assert callable(getattr(WishlistRepository, name))


# Capas: el dominio y el puerto no importan frameworks (skill testing-and-quality-gates).
@pytest.mark.parametrize("module", [domain, application])
def test_domain_and_application_import_no_framework(module: object) -> None:
    source = Path(module.__file__).read_text(encoding="utf-8")  # type: ignore[attr-defined]
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
        elif isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)

    assert not imported & {"fastapi", "pydantic", "sqlalchemy", "httpx", "supabase"}


# Capas entre módulos (CA-WISH-11): wishlist no importa domain ni adapters de otros módulos.
def test_wishlist_does_not_import_other_modules_internals() -> None:
    root = Path(domain.__file__).parent
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = (
                [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else [a.name for a in node.names]
                if isinstance(node, ast.Import)
                else []
            )
            offenders += [
                f"{path.name}: {name}"
                for name in names
                if name.startswith("valmont.modules.")
                and not name.startswith("valmont.modules.wishlist")
                and name != "valmont.modules.identity.adapters.http"  # current_user (SPEC §8)
                and name != "valmont.modules.identity.domain"  # CurrentUser
            ]

    assert offenders == []
