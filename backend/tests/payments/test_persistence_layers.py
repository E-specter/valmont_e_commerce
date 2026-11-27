"""Capas del adaptador de persistencia de payments (T-093; modules.md §3, CA-PAYMENTS-18): sin BD.
Análisis estático con `ast` y de texto: el adaptador solo conoce su propio módulo y `shared`; las
FK a orders y profiles se declaran como cadenas (E-P2), sin importar nada de esos módulos."""

import ast
import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "valmont"
PERSISTENCE = SRC / "modules" / "payments" / "adapters" / "persistence.py"
OTHER_MODULES = ("orders", "cart", "inventory", "audit", "catalog", "identity", "promotions")
CARD_DATA = ("card_number", "cardnumber", "cardholder", "holder", "cvv", "cvc", "expiry")


def imported_modules() -> list[str]:
    names: list[str] = []
    for node in ast.walk(ast.parse(PERSISTENCE.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names.append("." * node.level + (node.module or ""))
    return names


def test_the_persistence_adapter_exists() -> None:
    assert PERSISTENCE.is_file()


def test_the_adapter_imports_nothing_from_other_modules() -> None:
    offenders = [
        name
        for name in imported_modules()
        for other in OTHER_MODULES
        if name.startswith(f"valmont.modules.{other}")
    ]

    assert offenders == []


def test_the_adapter_imports_only_its_own_module_and_shared_among_valmont_packages() -> None:
    own = [name for name in imported_modules() if name.startswith("valmont")]

    assert all(name.startswith(("valmont.modules.payments", "valmont.shared")) for name in own), own


def test_the_adapter_has_no_relative_imports_into_other_packages() -> None:
    assert [name for name in imported_modules() if name.startswith(".")] == []


@pytest.mark.parametrize("word", CARD_DATA)
def test_the_adapter_never_names_a_column_for_card_number_holder_expiry_or_cvv(word: str) -> None:
    # RF05.04: el modelo no declara ni una columna para esos datos.
    source = PERSISTENCE.read_text(encoding="utf-8").lower()

    assert re.search(rf"{word}", source) is None


def test_the_adapter_does_not_log_nor_print() -> None:
    # R7: nada de la solicitud va a logs; el adaptador ni siquiera abre un logger.
    names = imported_modules()
    source = PERSISTENCE.read_text(encoding="utf-8")

    assert "logging" not in names
    assert "print(" not in source
