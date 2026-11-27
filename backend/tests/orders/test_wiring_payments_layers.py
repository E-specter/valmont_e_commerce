"""Costura de orders para payments (T-091; modules.md §3 excepción 7, CA-PAYMENTS-18 parte de
orders). Análisis estático con `ast` (no importa el código) más una comprobación de que el módulo
no expone rutas."""

import ast
from pathlib import Path

import pytest
from fastapi import APIRouter

from valmont.modules.orders.adapters import wiring

SRC = Path(__file__).resolve().parents[2] / "src" / "valmont"
WIRING = SRC / "modules" / "orders" / "adapters" / "wiring.py"
PAYMENTS = SRC / "modules" / "payments"
OTHERS_FORBIDDEN = tuple(
    f"valmont.modules.{module}.{inner}"
    for module in ("orders", "cart", "inventory", "audit")
    for inner in ("domain", "adapters.persistence")
) + ("valmont.modules.orders.adapters.http", "valmont.modules.orders.adapters.admin_http")


def imported_names(source: str) -> list[str]:
    names: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module)
            names += [f"{node.module}.{alias.name}" for alias in node.names]
    return names


def starts_with_any(name: str, prefixes: tuple[str, ...]) -> bool:
    return any(name == p or name.startswith(p + ".") for p in prefixes)


def test_the_import_scanner_detects_violations() -> None:
    source = (
        "from valmont.modules.orders import domain\nimport valmont.modules.orders.adapters.http\n"
    )
    hits = [n for n in imported_names(source) if starts_with_any(n, OTHERS_FORBIDDEN)]
    assert hits == ["valmont.modules.orders.domain", "valmont.modules.orders.adapters.http"]


def test_wiring_does_not_import_the_http_adapter_of_orders() -> None:
    # El paquete de T-091: se construye igual que `get_orders`, sin importar ese archivo.
    names = imported_names(WIRING.read_text(encoding="utf-8"))
    assert [n for n in names if starts_with_any(n, ("valmont.modules.orders.adapters.http",))] == []
    assert [n for n in names if "admin_http" in n] == []


def test_wiring_does_not_import_the_domain_of_any_module_nor_other_persistence() -> None:
    names = imported_names(WIRING.read_text(encoding="utf-8"))
    forbidden = (
        "valmont.modules.orders.domain",
        "valmont.modules.cart.domain",
        "valmont.modules.inventory.domain",
        "valmont.modules.audit.domain",
        "valmont.modules.cart.adapters",
        "valmont.modules.inventory.adapters.persistence",
        "valmont.modules.audit.adapters.persistence",
        "valmont.modules.payments",
    )
    assert [n for n in names if starts_with_any(n, forbidden)] == []


def test_wiring_only_takes_other_modules_through_application_and_wiring() -> None:
    names = imported_names(WIRING.read_text(encoding="utf-8"))
    modules = [n for n in names if n.startswith("valmont.modules.") and n.count(".") >= 3]
    allowed = (
        "valmont.modules.audit.adapters.http",  # AuditRecorderDep
        "valmont.modules.inventory.adapters.wiring",
        "valmont.modules.inventory.application",
        "valmont.modules.orders.adapters.persistence",  # su propio módulo
        "valmont.modules.orders.application",
    )
    assert [n for n in modules if not starts_with_any(n, allowed)] == []


def test_wiring_exposes_no_routes() -> None:
    assert [n for n, v in vars(wiring).items() if isinstance(v, APIRouter)] == []
    assert not hasattr(wiring, "router")
    source = WIRING.read_text(encoding="utf-8")
    tree = ast.parse(source)
    decorated = [
        n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.decorator_list
    ]
    assert decorated == []
    assert "APIRouter" not in source


@pytest.mark.parametrize("name", ["get_get_payable_order", "get_confirm_order_payment"])
def test_the_providers_are_plain_functions_without_decorators(name: str) -> None:
    assert callable(getattr(wiring, name))
    tree = ast.parse(WIRING.read_text(encoding="utf-8"))
    [func] = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name]
    assert func.decorator_list == []


def test_wiring_has_no_business_logic_or_commit() -> None:
    # Sin lógica (R-13): ni commit ni condicionales ni bucles ni identidad de usuario.
    tree = ast.parse(WIRING.read_text(encoding="utf-8"))
    banned = (ast.If, ast.For, ast.While, ast.Try, ast.Raise)
    assert [type(n).__name__ for n in ast.walk(tree) if isinstance(n, banned)] == []
    source = WIRING.read_text(encoding="utf-8")
    assert ".commit(" not in source and ".flush(" not in source
    assert "user_id" not in source


def test_payments_never_imports_the_domain_or_persistence_of_other_modules() -> None:
    # CA-PAYMENTS-18: payments solo toca `application` de orders (y su costura de wiring).
    files = list(PAYMENTS.rglob("*.py"))
    assert files, "el paquete payments debe existir"
    for path in files:
        names = imported_names(path.read_text(encoding="utf-8"))
        hits = [n for n in names if starts_with_any(n, OTHERS_FORBIDDEN)]
        assert hits == [], f"{path.name}: {hits}"
