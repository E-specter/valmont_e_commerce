"""Capas del módulo orders (T-071 y T-072; modules.md §3 y excepción (7)). Análisis estático de
los imports con `ast`: no importa el código, así que funciona aunque aún no exista."""

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "valmont"
ORDERS = SRC / "modules" / "orders"

FRAMEWORKS = ("fastapi", "pydantic", "sqlalchemy", "httpx", "supabase", "starlette")
# Dominio y adapters persistentes de los módulos con los que orders se compone (E-1).
FORBIDDEN_OF_OTHERS = tuple(
    f"valmont.modules.{module}.{inner}"
    for module in ("cart", "inventory")
    for inner in ("domain", "adapters.persistence")
)


def imported_names(source: str) -> list[str]:
    """Nombres con punto de todo lo importado; `from a import b` da `a.b` y `a`."""
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
    # Garantía de la propia prueba: sin esto, un escáner roto daría siempre "limpio".
    source = (
        "from valmont.modules.cart import domain\n"
        "from valmont.modules.inventory.adapters import persistence\n"
        "import sqlalchemy.orm\n"
    )
    names = imported_names(source)
    assert [n for n in names if starts_with_any(n, FORBIDDEN_OF_OTHERS)] == [
        "valmont.modules.cart.domain",
        "valmont.modules.inventory.adapters.persistence",
    ]
    assert [n for n in names if starts_with_any(n, FRAMEWORKS)] == ["sqlalchemy.orm"]


def test_the_orders_package_exists() -> None:
    assert (ORDERS / "__init__.py").is_file()
    assert (ORDERS / "domain.py").is_file()


def test_the_domain_is_pure_python() -> None:
    # T-072: sin frameworks, sin otros módulos y sin zoneinfo (desfase fijo UTC-5, R5).
    names = imported_names((ORDERS / "domain.py").read_text(encoding="utf-8"))
    banned = FRAMEWORKS + ("zoneinfo", "tzdata", "dateutil", "pytz", "valmont.modules")
    offenders = [n for n in names if starts_with_any(n, banned)]
    assert offenders == []


def test_the_domain_does_not_import_the_application_or_adapters_of_orders() -> None:
    names = imported_names((ORDERS / "domain.py").read_text(encoding="utf-8"))
    assert [n for n in names if "orders" in n.split(".")] == []


def orders_sources() -> list[Path]:
    return sorted(ORDERS.rglob("*.py"))


@pytest.mark.parametrize("path", orders_sources(), ids=lambda p: p.relative_to(ORDERS).as_posix())
def test_orders_does_not_import_domain_or_persistence_of_cart_or_inventory(path: Path) -> None:
    # T-071 / E-1: solo `application` y `adapters.wiring` de otros módulos.
    names = imported_names(path.read_text(encoding="utf-8"))
    offenders = [n for n in names if starts_with_any(n, FORBIDDEN_OF_OTHERS)]
    assert offenders == []


def test_application_has_no_framework_imports() -> None:
    # modules.md: `application` no depende de fastapi, pydantic ni sqlalchemy.
    application = ORDERS / "application.py"
    if not application.exists():
        pytest.skip("application.py llega con T-073")
    names = imported_names(application.read_text(encoding="utf-8"))
    assert [n for n in names if starts_with_any(n, FRAMEWORKS)] == []


def test_the_wiring_modules_are_the_only_new_cross_module_seams() -> None:
    # Excepción (7): el cableado vive en `adapters/wiring.py` de cada módulo que ofrece casos
    # de uso internos, y solo ahí; no hay lógica de negocio ni rutas.
    for module in ("cart", "inventory"):
        wiring = SRC / "modules" / module / "adapters" / "wiring.py"
        assert wiring.is_file(), wiring
        source = wiring.read_text(encoding="utf-8")
        assert "APIRouter" not in source
        assert "@router" not in source
        assert ".commit(" not in source
