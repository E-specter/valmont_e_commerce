"""GetEffectivePrices con un lector falso (CA-PROMOTIONS-10): duplicados, vacío y ausentes."""

from collections.abc import Collection
from dataclasses import FrozenInstanceError
from uuid import UUID, uuid4

import pytest

from valmont.modules.promotions.application import EffectivePrice, GetEffectivePrices

A, B, C = (uuid4() for _ in range(3))


def price(product_id: UUID, list_price: int = 1000, discount: int = 0) -> EffectivePrice:
    promotion = uuid4() if discount else None
    return EffectivePrice(product_id, list_price, list_price - discount, discount, promotion)


class FakeReader:
    def __init__(self, *rows: EffectivePrice) -> None:
        self.rows = {r.product_id: r for r in rows}
        self.calls: list[Collection[UUID]] = []

    def get_many(self, product_ids: Collection[UUID]) -> list[EffectivePrice]:
        self.calls.append(product_ids)
        return [self.rows[i] for i in product_ids if i in self.rows]


def test_returns_a_dict_keyed_by_product_id() -> None:
    row_a, row_b = price(A, 1000, 150), price(B)
    result = GetEffectivePrices(FakeReader(row_a, row_b))([A, B])

    assert result == {A: row_a, B: row_b}
    assert result[A].price == 850 and result[B].promotion_id is None


def test_without_ids_returns_empty_without_querying() -> None:
    reader = FakeReader(price(A))

    assert GetEffectivePrices(reader)([]) == {}
    assert reader.calls == []


def test_duplicates_are_ignored() -> None:
    reader = FakeReader(price(A))

    result = GetEffectivePrices(reader)([A, A, A])

    assert list(result) == [A]
    assert [sorted(call) for call in reader.calls] == [[A]]  # el lector no recibe repetidos


def test_unknown_ids_are_omitted() -> None:
    result = GetEffectivePrices(FakeReader(price(A)))([A, C])

    assert list(result) == [A]


def test_accepts_any_collection() -> None:
    use_case = GetEffectivePrices(FakeReader(price(A), price(B)))

    assert set(use_case({A, B})) == {A, B}
    assert set(use_case((A, B))) == {A, B}


def test_effective_price_is_immutable() -> None:
    with pytest.raises(FrozenInstanceError):
        price(A).price = 1  # type: ignore[misc]
