"""Dominio de promotions sin BD: R1 (tipo y valor), R2 (vigencia), R4 (alcance) y R9 (estado)."""

from dataclasses import FrozenInstanceError
from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

import pytest

from valmont.modules.promotions.domain import (
    AMOUNT_MAX,
    NAME_MAX,
    PERCENT_MAX,
    PERCENT_MIN,
    PRODUCTS_MAX,
    Promotion,
    PromotionError,
    PromotionKind,
    PromotionScope,
    PromotionStatus,
)

START = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
END = START + timedelta(days=30)
PERCENT, FIXED = PromotionKind.PERCENT, PromotionKind.FIXED_AMOUNT
PRODUCTS, CATEGORY, CATALOG = (
    PromotionScope.PRODUCTS,
    PromotionScope.CATEGORY,
    PromotionScope.CATALOG,
)
REPEATED = uuid4()


def make(**changes: object) -> Promotion:
    """Promoción válida (15 % sobre un producto); `changes` sustituye campos."""
    fields: dict[str, object] = {
        "id": uuid4(),
        "name": "Otoño de prueba",
        "kind": PERCENT,
        "percent_off": 15,
        "amount_off": None,
        "scope": PRODUCTS,
        "category_id": None,
        "product_ids": (uuid4(),),
        "starts_at": START,
        "ends_at": END,
        "is_active": True,
    }
    return Promotion(**{**fields, **changes})


def test_constants_and_enums_match_the_contract() -> None:
    assert (PERCENT_MIN, PERCENT_MAX, AMOUNT_MAX, PRODUCTS_MAX, NAME_MAX) == (
        1,
        90,
        2_147_483_647,
        100,
        120,
    )
    assert [k.value for k in PromotionKind] == ["percent", "fixed_amount"]
    assert [s.value for s in PromotionScope] == ["products", "category", "catalog"]
    assert [s.value for s in PromotionStatus] == ["inactive", "scheduled", "active", "expired"]
    assert issubclass(PromotionError, ValueError)


def test_promotion_is_immutable() -> None:
    with pytest.raises(FrozenInstanceError):
        make().is_active = False  # type: ignore[misc]


# CA-PROMOTIONS-01/08/16 (R1): tipo y valor; el valor del otro tipo debe ser None.
@pytest.mark.parametrize(
    "changes",
    [
        {"percent_off": PERCENT_MIN},
        {"percent_off": PERCENT_MAX},
        {"kind": FIXED, "percent_off": None, "amount_off": 1},
        {"kind": FIXED, "percent_off": None, "amount_off": AMOUNT_MAX},
        {"kind": FIXED, "percent_off": None, "amount_off": 20000},
    ],
)
def test_valid_kind_and_value_boundaries(changes: dict[str, object]) -> None:
    assert make(**changes)


@pytest.mark.parametrize(
    "changes",
    [
        {"percent_off": 0},
        {"percent_off": PERCENT_MAX + 1},
        {"percent_off": -5},
        {"percent_off": None},  # percent sin valor
        {"amount_off": 1000},  # percent con el valor del otro tipo
        {"kind": FIXED, "percent_off": None, "amount_off": 0},
        {"kind": FIXED, "percent_off": None, "amount_off": -1},
        {"kind": FIXED, "percent_off": None, "amount_off": AMOUNT_MAX + 1},
        {"kind": FIXED, "percent_off": None, "amount_off": None},  # fixed sin valor
        {"kind": FIXED, "percent_off": 15, "amount_off": 1000},  # ambos
    ],
)
def test_invalid_kind_and_value_are_rejected(changes: dict[str, object]) -> None:
    with pytest.raises(PromotionError):
        make(**changes)


# R2: vigencia con zona horaria y ends_at > starts_at.
def test_ends_at_must_be_after_starts_at() -> None:
    assert make(ends_at=START + timedelta(microseconds=1))
    for ends_at in (START, START - timedelta(seconds=1)):
        with pytest.raises(PromotionError):
            make(ends_at=ends_at)


@pytest.mark.parametrize("field", ["starts_at", "ends_at"])
def test_naive_datetimes_are_rejected(field: str) -> None:
    with pytest.raises(PromotionError):
        make(**{field: datetime(2027, 1, 1)})


def test_any_timezone_is_accepted_when_aware() -> None:
    lima = timezone(timedelta(hours=-5))
    assert make(starts_at=START.astimezone(lima), ends_at=END.astimezone(lima))


# R4: alcance.
def test_valid_scopes() -> None:
    ids = tuple(uuid4() for _ in range(PRODUCTS_MAX))
    assert make(product_ids=ids).product_ids == ids  # tope exacto: 100
    assert make(scope=CATEGORY, category_id=uuid4(), product_ids=())
    assert make(scope=CATALOG, product_ids=())


@pytest.mark.parametrize(
    "changes",
    [
        {"product_ids": ()},  # products sin productos
        {"product_ids": tuple(uuid4() for _ in range(PRODUCTS_MAX + 1))},
        {"product_ids": (REPEATED, REPEATED)},  # repetidos
        {"category_id": uuid4()},  # products con categoría
        {"scope": CATEGORY, "category_id": None, "product_ids": ()},  # category sin categoría
        {"scope": CATEGORY, "category_id": uuid4()},  # category con productos
        {"scope": CATALOG, "category_id": uuid4(), "product_ids": ()},  # catalog con categoría
        {"scope": CATALOG},  # catalog con productos
    ],
)
def test_invalid_scopes_are_rejected(changes: dict[str, object]) -> None:
    with pytest.raises(PromotionError):
        make(**changes)


# CA-PROMOTIONS-06 (R3/R9): status_at, intervalo semiabierto [starts_at, ends_at).
@pytest.mark.parametrize(
    ("is_active", "now", "status"),
    [
        (True, START - timedelta(seconds=1), PromotionStatus.SCHEDULED),
        (True, START, PromotionStatus.ACTIVE),
        (True, START + timedelta(days=10), PromotionStatus.ACTIVE),
        (True, END - timedelta(microseconds=1), PromotionStatus.ACTIVE),
        (True, END, PromotionStatus.EXPIRED),
        (True, END + timedelta(days=1), PromotionStatus.EXPIRED),
        (False, START - timedelta(days=1), PromotionStatus.INACTIVE),
        (False, START + timedelta(days=1), PromotionStatus.INACTIVE),
        (False, END + timedelta(days=1), PromotionStatus.INACTIVE),
    ],
)
def test_status_at(is_active: bool, now: datetime, status: PromotionStatus) -> None:
    assert make(is_active=is_active).status_at(now) is status


# SPEC §5 y §7: name de 1 a 120 caracteres, texto plano sin caracteres de control ni solo espacios.
@pytest.mark.parametrize("name", ["x", "x" * NAME_MAX, "Relojes de otoño"])
def test_valid_names(name: str) -> None:
    assert make(name=name)


@pytest.mark.parametrize("name", ["", "   ", "\t\n", "x" * (NAME_MAX + 1), "a\x00b", "a\nb"])
def test_invalid_names_are_rejected(name: str) -> None:
    with pytest.raises(PromotionError):
        make(name=name)
