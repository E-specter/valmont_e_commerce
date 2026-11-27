"""Capas del módulo payments (T-092; modules.md §3, CA-PAYMENTS-18). Análisis estático con `ast`:
el dominio es Python puro y `application.py` solo toma de orders su `application`."""

import ast
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "valmont"
PAYMENTS = SRC / "modules" / "payments"
FRAMEWORKS = ("fastapi", "pydantic", "sqlalchemy", "httpx", "supabase", "starlette")
OTHER_INTERNALS = tuple(
    f"valmont.modules.{module}.{inner}"
    for module in ("orders", "cart", "inventory", "audit", "catalog", "identity")
    for inner in ("domain", "adapters.persistence")
)
FORBIDDEN_EVERYWHERE = OTHER_INTERNALS + (
    "valmont.modules.orders.adapters.http",
    "valmont.modules.orders.adapters.admin_http",
)
# modules.md §3: `AuditEntry` para los casos de uso y `CurrentUser` para los routers (como orders).
ALLOWED_INTERNALS = {
    "application.py": ("valmont.modules.audit.domain", "valmont.modules.audit.domain.AuditEntry"),
    "adapters/http.py": (
        "valmont.modules.identity.domain",
        "valmont.modules.identity.domain.CurrentUser",
    ),
}
PAYMENT_FILES = [
    PAYMENTS / "__init__.py",
    PAYMENTS / "domain.py",
    PAYMENTS / "application.py",
    PAYMENTS / "adapters" / "__init__.py",
    PAYMENTS / "adapters" / "simulated_gateway.py",
]


def imported_names(source: str) -> list[str]:
    names: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module)
            names += [f"{node.module}.{alias.name}" for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level > 0:
            names.append("." * node.level + (node.module or ""))
    return names


def starts_with_any(name: str, prefixes: tuple[str, ...]) -> bool:
    return any(name == p or name.startswith(p + ".") for p in prefixes)


def imports_of(path: Path) -> list[str]:
    return imported_names(path.read_text(encoding="utf-8"))


def test_the_import_scanner_detects_violations() -> None:
    source = (
        "from valmont.modules.orders import domain\n"
        "from fastapi import APIRouter\n"
        "import sqlalchemy.orm\n"
        "from . import x\n"
    )
    names = imported_names(source)
    assert [n for n in names if starts_with_any(n, OTHER_INTERNALS)] == [
        "valmont.modules.orders.domain"
    ]
    assert [n for n in names if starts_with_any(n, FRAMEWORKS)] == [
        "fastapi",
        "fastapi.APIRouter",
        "sqlalchemy.orm",
    ]
    assert "." in names


@pytest.mark.parametrize("path", PAYMENT_FILES, ids=lambda p: p.name)
def test_the_payments_files_exist(path: Path) -> None:
    assert path.is_file()


def test_the_domain_is_pure_python() -> None:
    names = imports_of(PAYMENTS / "domain.py")
    assert [n for n in names if starts_with_any(n, FRAMEWORKS)] == []
    assert [
        n for n in names if n.startswith(("valmont", "."))
    ] == []  # ni otros módulos ni el propio
    stdlib = sys.stdlib_module_names
    assert [n for n in names if n.split(".")[0] not in stdlib] == []


def test_the_domain_does_not_touch_clock_randomness_or_io() -> None:
    names = {n.split(".")[0] for n in imports_of(PAYMENTS / "domain.py")}
    assert not {"random", "secrets", "time", "os", "socket", "logging", "zoneinfo"} & names


def test_application_imports_from_orders_only_its_application() -> None:
    names = imports_of(PAYMENTS / "application.py")
    from_orders = [n for n in names if starts_with_any(n, ("valmont.modules.orders",))]
    assert from_orders, "application.py debe importar PayableOrder de orders.application"
    assert [
        n for n in from_orders if not starts_with_any(n, ("valmont.modules.orders.application",))
    ] == []
    assert [n for n in names if starts_with_any(n, FRAMEWORKS)] == []


def test_application_only_depends_on_the_payments_domain_and_orders_application() -> None:
    names = imports_of(PAYMENTS / "application.py")
    valmont = [n for n in names if n.startswith("valmont")]
    # modules.md §3 (7): los casos de uso reciben el puerto `AuditRecorder` y crean `AuditEntry`.
    assert [
        n
        for n in valmont
        if not starts_with_any(
            n,
            (
                "valmont.modules.payments.domain",
                "valmont.modules.orders.application",
                "valmont.modules.audit.application",
                "valmont.modules.audit.domain.AuditEntry",
                "valmont.modules.audit.domain",
            ),
        )
    ] == []


def test_the_simulated_gateway_has_no_framework_and_no_other_module() -> None:
    names = imports_of(PAYMENTS / "adapters" / "simulated_gateway.py")
    assert [n for n in names if starts_with_any(n, FRAMEWORKS)] == []
    assert [n for n in names if n.startswith("valmont.modules.orders")] == []


def test_nothing_in_payments_imports_domain_or_persistence_of_other_modules() -> None:
    files = sorted(PAYMENTS.rglob("*.py"))
    assert len(files) >= len(PAYMENT_FILES)
    for path in files:
        allowed = ALLOWED_INTERNALS.get(path.relative_to(PAYMENTS).as_posix(), ())
        hits = [
            n
            for n in imports_of(path)
            if starts_with_any(n, FORBIDDEN_EVERYWHERE) and n not in allowed
        ]
        assert hits == [], f"{path.relative_to(SRC)}: {hits}"
