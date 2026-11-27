"""Dominio de la fecha de nacimiento (T-138; SPEC identity §13, IDENTITY-R6 a R8)."""

from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from valmont.modules.identity import domain
from valmont.modules.identity.domain import (
    MAJORITY_AGE,
    MAX_AGE_YEARS,
    MIN_BIRTH_DATE,
    AgeRequirementError,
    BirthDateInvalid,
    BirthDateLocked,
    BirthDateRequired,
    Profile,
    ProfileError,
    Role,
    Underage,
    age_on,
    check_birth_date_range,
    is_adult,
    lima_today,
    parse_birth_date,
)

T0 = datetime(2026, 10, 26, 19, 58, tzinfo=UTC)
TODAY = date(2026, 11, 27)


def test_constants_follow_the_spec() -> None:
    assert (MAJORITY_AGE, MAX_AGE_YEARS, MIN_BIRTH_DATE) == (18, 120, date(1900, 1, 1))


def test_error_hierarchy() -> None:
    assert issubclass(BirthDateInvalid, ProfileError)
    assert issubclass(BirthDateRequired, AgeRequirementError)
    assert issubclass(Underage, AgeRequirementError)
    assert not issubclass(BirthDateLocked, ProfileError)
    assert not issubclass(AgeRequirementError, ProfileError)  # no sale como 422 de Pydantic


def test_profile_has_birth_date_as_last_optional_field() -> None:
    profile = Profile(user_id=None, role=Role.CUSTOMER, created_at=T0, updated_at=T0)

    assert profile.birth_date is None
    assert list(Profile.__dataclass_fields__)[-1] == "birth_date"


# --- lima_today (R7: (now UTC - 5 h).date()) ---


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (datetime(2026, 11, 28, 3, 0, tzinfo=UTC), date(2026, 11, 27)),  # 22:00 del 27 en Lima
        (datetime(2026, 11, 28, 4, 59, 59, tzinfo=UTC), date(2026, 11, 27)),
        (datetime(2026, 11, 28, 5, 0, tzinfo=UTC), date(2026, 11, 28)),  # 00:00 del 28 en Lima
        (datetime(2026, 11, 28, 0, 0, tzinfo=UTC), date(2026, 11, 27)),  # medianoche UTC
        (datetime(2027, 1, 1, 4, 59, tzinfo=UTC), date(2026, 12, 31)),  # cruce de año
        # Otra zona: el instante es 04:00Z del 28, o sea 23:00 del 27 en Lima.
        (datetime(2026, 11, 28, 6, 0, tzinfo=timezone(timedelta(hours=2))), date(2026, 11, 27)),
        (datetime(2026, 11, 27, 22, 0, tzinfo=timezone(timedelta(hours=-5))), date(2026, 11, 27)),
    ],
)
def test_lima_today_is_utc_minus_5_hours(now: datetime, expected: date) -> None:
    assert lima_today(now) == expected


def test_lima_today_rejects_naive_datetime() -> None:
    with pytest.raises(ValueError):  # noqa: PT011 (la SPEC fija ValueError, sin mensaje)
        lima_today(datetime(2026, 11, 28, 5, 0))


# --- parse_birth_date (R6) ---


def test_parse_birth_date_accepts_the_iso_format() -> None:
    assert parse_birth_date("1990-05-17") == date(1990, 5, 17)
    assert parse_birth_date("2000-02-29") == date(2000, 2, 29)


@pytest.mark.parametrize(
    "value",
    [
        "17/05/1990",
        "1990-5-17",
        "1990-05-7",
        "19900517",  # fromisoformat lo acepta: la SPEC exige la expresión regular
        "1990-05-17T00:00:00",
        "1990-05-17T00:00:00Z",
        "1990-05-17 ",
        " 1990-05-17",
        "1990-05-17\n",  # `$` de una regex sin fullmatch lo dejaría pasar
        "\t1990-05-17",
        "１９９０-05-17",  # dígitos anchos (no ASCII)
        "١٩٩٠-٠٥-١٧",  # arábigo-índicos
        "1990/05/17",
        "1990-05-17-",
        "-1990-05-17",
        "+1990-05-17",
        "",
        "   ",
        "hoy",
        "2001-02-29",  # no bisiesto
        "1900-02-29",  # 1900 no es bisiesto
        "1990-02-30",
        "1990-04-31",
        "1990-13-01",
        "1990-00-10",
        "1990-01-00",
        "0000-01-01",
        "1990-05-17\x00",
    ],
)
def test_parse_birth_date_rejects_everything_but_a_real_iso_calendar_date(value: str) -> None:
    with pytest.raises(ProfileError):
        parse_birth_date(value)


def test_parse_birth_date_error_does_not_echo_the_value() -> None:
    with pytest.raises(ProfileError) as error:
        parse_birth_date("1887-03-09T11:22:33")

    assert "1887" not in str(error.value)
    assert "03-09" not in str(error.value)


# --- age_on (R8): años cumplidos ---


@pytest.mark.parametrize(
    ("birth", "today", "age"),
    [
        (date(2008, 11, 28), date(2026, 11, 27), 17),  # el día antes del 18.º cumpleaños
        (date(2008, 11, 27), date(2026, 11, 27), 18),  # el día del cumpleaños
        (date(2008, 11, 26), date(2026, 11, 27), 18),
        (date(2008, 12, 31), date(2026, 11, 27), 17),  # mes posterior, día anterior
        (date(2008, 1, 31), date(2026, 11, 27), 18),  # mes anterior, día posterior
        (date(2026, 11, 27), date(2026, 11, 27), 0),  # nació hoy
        # 29 de febrero: en los años no bisiestos cumple el 1 de marzo (R8).
        (date(2008, 2, 29), date(2026, 2, 28), 17),
        (date(2008, 2, 29), date(2026, 3, 1), 18),
        (date(2008, 2, 29), date(2028, 2, 28), 19),  # 2028 es bisiesto: cumple el 29
        (date(2008, 2, 29), date(2028, 2, 29), 20),
        (date(2008, 2, 29), date(2028, 3, 1), 20),
        (date(2000, 2, 29), date(2001, 2, 28), 0),
        (date(2000, 2, 29), date(2001, 3, 1), 1),
    ],
)
def test_age_on_counts_completed_years(birth: date, today: date, age: int) -> None:
    assert age_on(birth, today) == age


@pytest.mark.parametrize(
    ("birth", "today", "adult"),
    [
        (date(2008, 11, 28), date(2026, 11, 27), False),
        (date(2008, 11, 27), date(2026, 11, 27), True),
        (date(2008, 2, 29), date(2026, 2, 28), False),
        (date(2008, 2, 29), date(2026, 3, 1), True),
        (date(2008, 2, 29), date(2028, 2, 28), True),  # ya cumplió 18 en 2026
        (date(2010, 2, 28), date(2028, 2, 27), False),
        (date(2010, 2, 28), date(2028, 2, 28), True),
        (date(1990, 5, 17), date(2026, 11, 27), True),
        (date(2020, 1, 1), date(2026, 11, 27), False),
    ],
)
def test_is_adult_is_18_completed_years(birth: date, today: date, adult: bool) -> None:
    assert is_adult(birth, today) is adult


def test_is_adult_with_the_lima_day_around_midnight() -> None:
    birth = date(2008, 11, 28)  # cumple 18 el 28 de noviembre (Lima)
    before_midnight_lima = datetime(2026, 11, 28, 4, 59, 59, tzinfo=UTC)  # 23:59:59 del 27
    midnight_lima = datetime(2026, 11, 28, 5, 0, tzinfo=UTC)  # 00:00 del 28

    assert not is_adult(birth, lima_today(before_midnight_lima))
    assert is_adult(birth, lima_today(midnight_lima))
    # A las 00:00Z del 28 la fecha UTC ya sería el cumpleaños, pero en Lima aún es el día 27.
    assert not is_adult(birth, lima_today(datetime(2026, 11, 28, 0, 0, tzinfo=UTC)))


# --- check_birth_date_range (R7) ---


def reason_of(birth: date, today: date) -> str | None:
    try:
        check_birth_date_range(birth, today)
    except BirthDateInvalid as error:
        return error.reason
    return None


@pytest.mark.parametrize(
    ("birth", "expected"),
    [
        (date(2026, 11, 28), "future"),  # mañana
        (date(2999, 1, 1), "future"),
        (date(2026, 11, 27), None),  # hoy
        (date(2026, 11, 26), None),
        (date(1906, 11, 27), None),  # 120 años exactos
        (date(1906, 11, 26), None),
        (date(1905, 11, 28), None),  # un día antes de cumplir 121: 120 años cumplidos
        (date(1905, 11, 27), "too_old"),  # cumple 121 hoy
        (date(1899, 12, 31), "too_old"),
        (date(1850, 1, 1), "too_old"),
    ],
)
def test_check_birth_date_range(birth: date, expected: str | None) -> None:
    assert reason_of(birth, TODAY) == expected


def test_check_birth_date_range_rejects_before_min_even_if_age_is_in_range() -> None:
    # Con un "hoy" de 1950, 1899-12-31 tendría 50 años: solo MIN_BIRTH_DATE lo detiene.
    assert reason_of(date(1899, 12, 31), date(1950, 1, 1)) == "too_old"
    assert reason_of(date(1900, 1, 1), date(1950, 1, 1)) is None


def test_birth_date_invalid_carries_only_the_reason() -> None:
    error = BirthDateInvalid("future")

    assert error.reason == "future"
    assert "2026" not in str(error)


def test_age_errors_carry_neither_date_nor_age() -> None:
    for exc in (BirthDateRequired(), Underage(), BirthDateLocked()):
        assert not any(char.isdigit() for char in str(exc))
        assert not any(isinstance(arg, date | int) for arg in exc.args)


def test_domain_module_stays_pure_python() -> None:
    # Capas hexagonales: el dominio no importa frameworks.
    text = Path(domain.__file__).read_text(encoding="utf-8")
    for forbidden in ("import fastapi", "import pydantic", "import sqlalchemy", "from fastapi"):
        assert forbidden not in text


def test_birth_date_underage_is_a_birth_date_invalid_with_its_own_reason() -> None:
    from valmont.modules.identity.domain import BirthDateUnderage

    error = BirthDateUnderage()

    assert isinstance(error, BirthDateInvalid)
    assert error.reason == "underage"
    assert not any(char.isdigit() for char in str(error))
