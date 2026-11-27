"""`valmont.shared.text` (T-018d, D-047 D-H2): tabla de `has_unsafe_chars` y `has_visible_char`, y
las capas: shared no importa módulos y los módulos ya no llevan su copia del filtro.

Sin BD. Los casos se escriben con escapes: el archivo no contiene ningún carácter invisible."""

import ast
import re
import sys
import unicodedata
from pathlib import Path

import pytest

from valmont.shared.text import has_unsafe_chars, has_visible_char

SRC = Path(__file__).resolve().parents[2] / "src" / "valmont"

# Cada punto de código del paquete: Cf bidi, ancho cero, guion blando y rellenos invisibles.
BIDI = [
    0x061C,
    0x200E,
    0x200F,
    *range(0x202A, 0x202F),
    *range(0x2066, 0x206A),
]
ZERO_WIDTH = [*range(0x200B, 0x200E), 0x2060, 0xFEFF, 0x00AD]
FILLERS = [0x2800, 0x3164, 0xFFA0, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x034F]
REJECTED = BIDI + ZERO_WIDTH + FILLERS
FILLER_SET = {chr(cp) for cp in FILLERS}


# --- has_unsafe_chars: rechazos ---


@pytest.mark.parametrize("cp", REJECTED, ids=lambda cp: f"U+{cp:04X}")
def test_every_listed_code_point_is_unsafe_alone_and_inside_a_text(cp: int) -> None:
    char = chr(cp)

    assert has_unsafe_chars(char)
    assert has_unsafe_chars(f"Ana{char}Torres")
    assert has_unsafe_chars(f"{char}Ana")
    assert has_unsafe_chars(f"Ana{char}")


@pytest.mark.parametrize("value", ["a\x00b", "a\x07b", "a\x1fb", "a\x7fb", "a\x85b", "a\tb"])
def test_controls_cc_are_still_unsafe(value: str) -> None:
    assert has_unsafe_chars(value)


@pytest.mark.parametrize("value", ["\ud800", "a\udfffb", "\udc00"])
def test_lone_surrogates_cs_are_still_unsafe(value: str) -> None:
    assert has_unsafe_chars(value)


def test_the_zero_width_joiner_inside_a_compound_emoji_is_unsafe() -> None:
    # Decisión del Leader: un emoji compuesto con ZWJ se rechaza.
    assert has_unsafe_chars("\U0001f469‍\U0001f4bb")


def test_every_cf_cc_and_cs_code_point_is_unsafe() -> None:
    missed = [
        f"U+{cp:04X}"
        for cp in range(sys.maxunicode + 1)
        if unicodedata.category(chr(cp)) in ("Cc", "Cs", "Cf") and not has_unsafe_chars(chr(cp))
    ]

    assert missed == []


# --- has_unsafe_chars: lo legítimo pasa ---

LEGITIMATE = [
    "José Núñez",
    "Calle 5 de Mayo #123, Lima",
    "Reloj de pulsera — edición 1925",
    "Peña Ümit Ángel",
    "O’Brien ‘x’ “Hola” «Hola»",
    "Jean-Luc – Montblanc ‐ x",
    "é ä ñ",  # letra + marca combinante
    "李小龍",
    "Ελένη",
    "Иван Петров",
    "محمد",
    "שלום",
    "हिन्दी",
    "ภาษาไทย",
    "한국어",
    "\U0001f600 ⌚ ❤️ \U0001f1f5\U0001f1ea",  # emojis simples, con selector y bandera
    "Acero 316L, 40 mm; ½",
    "a  b",
    " ",  # espacio duro: Zs, no es Cf
    "",
]


@pytest.mark.parametrize("value", LEGITIMATE)
def test_legitimate_text_is_safe(value: str) -> None:
    assert not has_unsafe_chars(value)


def test_every_letter_mark_number_punctuation_symbol_and_space_outside_the_fillers_is_safe() -> (
    None
):
    wrongly_flagged = [
        f"U+{cp:04X}"
        for cp in range(sys.maxunicode + 1)
        if (unicodedata.category(chr(cp))[0] in "LMNPS" or unicodedata.category(chr(cp)) == "Zs")
        and chr(cp) not in FILLER_SET
        and has_unsafe_chars(chr(cp))
    ]

    assert wrongly_flagged == []


# --- el parámetro allow ---


def test_allow_exempts_only_the_listed_characters() -> None:
    assert has_unsafe_chars("a\nb")
    assert not has_unsafe_chars("a\nb", allow="\n")
    assert has_unsafe_chars("a\tb", allow="\n")
    assert has_unsafe_chars("a\rb", allow="\n")
    assert has_unsafe_chars("a\x00b", allow="\n")
    assert has_unsafe_chars("a\ud800b", allow="\n")


def test_allow_newline_does_not_open_the_door_to_bidi_or_invisibles() -> None:
    for cp in REJECTED:
        assert has_unsafe_chars(f"linea 1\nlinea {chr(cp)}2", allow="\n"), hex(cp)


# --- has_visible_char ---


@pytest.mark.parametrize(
    "value",
    [
        "",
        " ",
        "   ",
        " ",
        " ",
        "　",
        " ",
        "\x00",
        "\t\n",
        "\ud800",
        "​",
        "‮",
        "﻿",
        "­",
        "⠀",
        "ㅤ",
        "ﾠ",
        "ᅟᅠ",
        "឴឵",
        "͏",
        " ㅤ ​ ",
    ],
)
def test_text_without_a_visible_part_has_no_visible_char(value: str) -> None:
    assert not has_visible_char(value)


@pytest.mark.parametrize(
    "value",
    [
        "a",
        "Ana",
        "  Ana  ",
        "ñ",
        "李",
        "م",
        "\U0001f600",
        "1",
        "-",
        "#",
        "ㅤa",  # un visible basta: el rechazo del relleno es de has_unsafe_chars
        "​x",
        "é",
    ],
)
def test_text_with_some_visible_char_has_one(value: str) -> None:
    assert has_visible_char(value)


def test_a_lone_combining_mark_is_not_a_visible_character_by_itself_but_a_filler_is_never() -> None:
    # Una marca suelta (Mn) no es Z* ni C*: cuenta como visible según el paquete.
    assert has_visible_char("́")
    assert not has_visible_char("͏")


# --- Capas ---


def _imports(path: Path) -> list[str]:
    names: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.append(node.module)
            names += [f"{node.module}.{alias.name}" for alias in node.names]
    return names


def test_shared_text_does_not_import_any_module() -> None:
    names = _imports(SRC / "shared" / "text.py")

    assert not [n for n in names if n == "valmont.modules" or n.startswith("valmont.modules.")]
    assert not [n for n in names if n.split(".")[0] in {"fastapi", "pydantic", "sqlalchemy"}]


DOMAINS = [
    "identity/domain.py",
    "orders/domain.py",
    "catalog/domain.py",
    "inventory/domain.py",
    "promotions/domain.py",
]


@pytest.mark.parametrize("domain", DOMAINS)
def test_each_domain_uses_the_shared_filter_and_keeps_no_copy(domain: str) -> None:
    source = (SRC / "modules" / domain).read_text(encoding="utf-8")

    assert "from valmont.shared.text import" in source
    assert not re.search(r"unicodedata\.category", source)
    assert '"Cc"' not in source and "'Cc'" not in source


def test_the_transition_body_uses_the_shared_filter() -> None:
    source = (SRC / "modules" / "orders" / "adapters" / "admin_http.py").read_text(encoding="utf-8")
    start = source.index("class TransitionIn")
    end = source.find("\nclass ", start + 1)
    body = source[start : end if end != -1 else len(source)]

    assert "has_unsafe_chars" in body
    assert "unicodedata" not in body
    assert "from valmont.shared.text import" in source


def test_no_module_keeps_a_private_copy_of_the_old_filter() -> None:
    # El filtro de búsqueda `q` de orders (Cc/Cs, no se guarda) está protegido por el paquete.
    allowed = {Path("orders/adapters/admin_http.py")}
    offenders = [
        str(path.relative_to(SRC / "modules"))
        for path in (SRC / "modules").rglob("*.py")
        if re.search(r"""["']Cc["']""", path.read_text(encoding="utf-8"))
        and path.relative_to(SRC / "modules") not in allowed
    ]

    assert offenders == []


@pytest.mark.parametrize("value", ["\ue000", "\u0378", " \ue000\u0378 "])
def test_private_use_and_unassigned_code_points_are_not_visible_nor_unsafe(value: str) -> None:
    # Co y Cn no son Cf: pasan has_unsafe_chars, pero no cuentan como parte visible (C*).
    assert not has_unsafe_chars(value)
    assert not has_visible_char(value)
