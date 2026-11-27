"""Aislamiento de la fecha de nacimiento (T-138; CA-IDENTITY-18, IDENTITY-R9) y capas."""

import ast
import re
from pathlib import Path

import pytest

MODULES = Path(__file__).resolve().parents[2] / "src" / "valmont" / "modules"
IDENTITY = MODULES / "identity"
# Lo único que otro módulo puede importar de identity sobre la edad (SPEC §13.8, firmas de T-138).
ALLOWED_FROM_IDENTITY = {
    "valmont.modules.identity.application": {"EnsureAdult", "BirthDateRequired", "Underage"},
    "valmont.modules.identity.adapters.wiring": {"get_ensure_adult"},
}


def python_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*.py") if "__pycache__" not in p.parts]


def test_birth_date_appears_only_inside_identity() -> None:
    offenders = [
        str(path.relative_to(MODULES))
        for path in python_files(MODULES)
        if IDENTITY not in path.parents and re.search(r"birth_?date", path.read_text("utf-8"), re.I)
    ]

    assert offenders == []


def test_birth_date_is_absent_from_shared_and_main() -> None:
    src = MODULES.parent
    offenders = [
        str(path.relative_to(src))
        for path in [src / "main.py", *python_files(src / "shared")]
        if re.search(r"birth_?date", path.read_text("utf-8"), re.I)
    ]

    assert offenders == []


def identity_imports(path: Path) -> list[tuple[str, set[str]]]:
    found = []
    for node in ast.walk(ast.parse(path.read_text("utf-8"))):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(
            "valmont.modules.identity"
        ):
            found.append((node.module, {alias.name for alias in node.names}))
    return found


def test_other_modules_import_from_identity_only_what_the_spec_allows() -> None:
    # Hoy orders solo usa current_user/CurrentUser (T-016); T-139 añadirá EnsureAdult y los dos
    # errores. Nadie importa el perfil completo, el repositorio ni la fila.
    forbidden = {
        "Profile",
        "ProfileRow",
        "SqlProfileRepository",
        "ProfileRepository",
        "UpdateProfile",
    }
    violations = []
    for path in python_files(MODULES):
        if IDENTITY in path.parents:
            continue
        for module, names in identity_imports(path):
            if module.endswith("adapters.persistence") or names & forbidden:
                violations.append((str(path.relative_to(MODULES)), module, sorted(names)))
            allowed = ALLOWED_FROM_IDENTITY.get(module)
            if allowed is not None and not names <= allowed:
                violations.append((str(path.relative_to(MODULES)), module, sorted(names)))

    assert violations == []


@pytest.mark.parametrize("layer", ["domain.py", "application.py"])
def test_identity_core_layers_import_no_framework(layer: str) -> None:
    tree = ast.parse((IDENTITY / layer).read_text("utf-8"))
    imported = {
        (node.module or "").split(".")[0]
        if isinstance(node, ast.ImportFrom)
        else alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, ast.Import | ast.ImportFrom)
        for alias in (node.names if isinstance(node, ast.Import) else [None])
    }

    assert not imported & {"fastapi", "pydantic", "sqlalchemy", "httpx", "supabase"}


def test_wiring_does_not_import_the_http_adapter() -> None:
    modules = {module for module, _ in identity_imports(IDENTITY / "adapters" / "wiring.py")}

    assert "valmont.modules.identity.adapters.http" not in modules
