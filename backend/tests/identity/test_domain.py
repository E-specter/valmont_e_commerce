from collections.abc import Callable

import pytest

from valmont.modules.identity.domain import (
    Preferences,
    ProfileError,
    clean_text,
    normalize_full_name,
    normalize_phone,
    normalize_privacy_version,
)

# Cc (\x00 no cabe en un text de PostgreSQL; \t lo ocultaría un split) y un sustituto suelto
# (no se puede codificar en UTF-8).
FORBIDDEN_CHARS = ["\x00", "\x1f", "\t", "\x7f", "\ud800", "\udfff"]


def test_preferences_allow_equal_or_partial_budget() -> None:
    assert Preferences(budget_min=300000, budget_max=300000).budget_max == 300000
    assert Preferences(budget_min=900000).budget_max is None


def test_preferences_reject_budget_min_above_budget_max() -> None:
    with pytest.raises(ProfileError):
        Preferences(budget_min=900001, budget_max=900000)


def test_preferences_strip_texts_and_store_materials_as_tuple() -> None:
    prefs = Preferences(style=" clásico ", materials=[" acero", "oro rosa "])

    assert (prefs.style, prefs.materials) == ("clásico", ("acero", "oro rosa"))


@pytest.mark.parametrize(
    "kwargs",
    [
        {"budget_min": -1},
        {"budget_max": -1},
        {"style": "   "},
        {"style": "a" * 41},
        {"materials": ["  "]},
        {"materials": ["a" * 41]},
        {"materials": ["a"] * 11},
        {"style": "clásico\x00"},
        {"materials": ["acero\ud800"]},
    ],
)
def test_preferences_enforce_their_invariants(kwargs: dict[str, object]) -> None:
    with pytest.raises(ProfileError):
        Preferences(**kwargs)


def test_full_name_collapses_extra_spaces() -> None:
    assert normalize_full_name("  Ana   Torres ") == "Ana Torres"


@pytest.mark.parametrize("value", ["", "   ", "a" * 121])
def test_full_name_must_have_1_to_120_characters(value: str) -> None:
    with pytest.raises(ProfileError):
        normalize_full_name(value)


def test_phone_drops_spaces() -> None:
    assert normalize_phone(" +51 987 654 321 ") == "+51987654321"


@pytest.mark.parametrize("value", ["12345", "1" * 16, "+51-987654321", "51+987654", "abc123456"])
def test_phone_must_be_6_to_15_digits_with_optional_plus(value: str) -> None:
    with pytest.raises(ProfileError):
        normalize_phone(value)


def test_privacy_version_is_stripped_and_at_most_20_characters() -> None:
    assert normalize_privacy_version(" 2026-10 ") == "2026-10"
    with pytest.raises(ProfileError):
        normalize_privacy_version("   ")
    with pytest.raises(ProfileError):
        normalize_privacy_version("x" * 21)


@pytest.mark.parametrize("char", FORBIDDEN_CHARS)
@pytest.mark.parametrize(
    ("normalize", "value"),
    [
        (normalize_full_name, "Ana Torres"),
        (normalize_phone, "987654321"),
        (normalize_privacy_version, "2026-10"),
        (lambda value: clean_text(value, 40), "clásico"),
    ],
)
def test_texts_reject_control_characters_and_lone_surrogates(
    normalize: Callable[[str], str], value: str, char: str
) -> None:
    with pytest.raises(ProfileError):
        normalize(f"{value}{char}")
    with pytest.raises(ProfileError):
        normalize(f"{char}{value}")
