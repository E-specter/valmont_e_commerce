"""Funciones puras de orders (T-072): número visible (R14) y fecha estimada (R5, CA-ORDERS-07)."""

from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from valmont.modules.orders.domain import estimated_delivery_on, format_order_number


@pytest.mark.parametrize(
    ("number", "expected"),
    [
        (1, "VAL-000001"),
        (123, "VAL-000123"),
        (999_999, "VAL-999999"),
        (1_000_000, "VAL-1000000"),  # R14: crece sin tope, no se trunca
        (1_234_567, "VAL-1234567"),
    ],
)
def test_format_order_number(number: int, expected: str) -> None:
    assert format_order_number(number) == expected


def at(year: int, month: int, day: int, hour: int = 12, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


@pytest.mark.parametrize("lead_times", [[], [None], [None, None]])
def test_no_made_to_order_lead_time_means_no_estimate(lead_times: list[int | None]) -> None:
    assert estimated_delivery_on(at(2026, 12, 1), lead_times) is None


def test_a_single_lead_time_adds_natural_days() -> None:
    assert estimated_delivery_on(at(2026, 12, 1), [5]) == date(2026, 12, 6)


def test_the_estimate_uses_the_greatest_lead_time_and_ignores_none() -> None:
    assert estimated_delivery_on(at(2026, 12, 1), [3, 10, None, 7]) == date(2026, 12, 11)


def test_the_estimate_returns_a_date_not_a_datetime() -> None:
    result = estimated_delivery_on(at(2026, 12, 1), [1])
    assert type(result) is date


def test_the_lead_times_can_be_any_iterable() -> None:
    generator: Iterable[int | None] = (n for n in (2, None, 9))
    assert estimated_delivery_on(at(2026, 12, 1), generator) == date(2026, 12, 10)


@pytest.mark.parametrize(
    ("created_at", "lead", "expected"),
    [
        # 04:59 UTC = 23:59 del día anterior en Lima (UTC-5): la fecha base es 30 nov.
        (at(2026, 12, 1, 4, 59), 1, date(2026, 12, 1)),
        # 05:00 UTC = 00:00 en Lima: la fecha base ya es 1 dic.
        (at(2026, 12, 1, 5, 0), 1, date(2026, 12, 2)),
        # 03:00 UTC sigue en la noche del día anterior en Lima aunque UTC ya cambió de día.
        (at(2026, 12, 1, 3, 0), 3, date(2026, 12, 3)),
        # Fin de día en UTC: 23:30 UTC = 18:30 en Lima, el mismo día.
        (at(2026, 12, 1, 23, 30), 2, date(2026, 12, 3)),
        # Cruce de mes y de año.
        (at(2026, 12, 30, 15, 0), 3, date(2027, 1, 2)),
        # 2027 no es bisiesto.
        (at(2027, 2, 27, 15, 0), 2, date(2027, 3, 1)),
    ],
)
def test_the_base_date_is_the_lima_date_of_created_at(
    created_at: datetime, lead: int, expected: date
) -> None:
    assert estimated_delivery_on(created_at, [lead]) == expected


def test_a_timestamp_in_another_zone_is_converted_to_lima_first() -> None:
    # 06:00+02:00 = 04:00 UTC = 23:00 del 30 nov en Lima.
    created = datetime(2026, 12, 1, 6, 0, tzinfo=timezone(timedelta(hours=2)))
    assert estimated_delivery_on(created, [1]) == date(2026, 12, 1)
