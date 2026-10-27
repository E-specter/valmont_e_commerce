"""Casos de uso de administración con fakes que registran el orden de llamadas y los bloqueos.

El orden importa: el producto se bloquea antes que la categoría (FOR UPDATE → FOR SHARE), las
reglas se comprueban antes de escribir y la auditoría va después de la escritura.
"""

from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from tests.catalog.test_domain import make_category, make_product
from valmont.modules.audit.application import AuditEntry
from valmont.modules.catalog.application import (
    Actor,
    PublishProduct,
    UpdateCategory,
    UpdateProduct,
)
from valmont.modules.catalog.domain import (
    AdminProductView,
    Category,
    CategoryInUse,
    InvalidReference,
    NotPublishable,
    Product,
    ProductImage,
    ProductStatus,
)

ACTOR = Actor(uuid4(), "admin")
AT = datetime(2026, 10, 1, tzinfo=UTC)


class Fakes:
    """Productos, categorías y auditoría que anotan cada llamada en el mismo registro."""

    def __init__(self, product: Product, category: Category | None, images: int = 1) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.product = product
        self.category = category
        self.images = [
            ProductImage(uuid4(), product.id, f"p/{n}.webp", "Vista", n) for n in range(images)
        ]
        self.published_in_category = False
        self.entries: list[AuditEntry] = []

    # ProductRepository
    def lock(self, product_id: UUID) -> Product:
        self.calls.append(("products.lock",))
        return self.product

    def list_images(self, product_id: UUID) -> list[ProductImage]:
        self.calls.append(("products.list_images",))
        return self.images

    def update(self, product: Product) -> None:
        self.calls.append(("products.update",))
        self.product = product

    def get(self, product_id: UUID) -> AdminProductView:
        self.calls.append(("products.get",))
        category = self.category or make_category()
        return AdminProductView(self.product, category, None, None, self.images, AT, AT)

    # CategoryRepository
    def get_category(self, category_id: UUID, lock: str | None = None) -> Category | None:
        self.calls.append(("categories.get", lock))
        return self.category

    def has_published_products(self, category_id: UUID) -> bool:
        self.calls.append(("categories.has_published_products",))
        return self.published_in_category

    def update_category(self, category_id: UUID, values: Mapping[str, object]) -> Category:
        self.calls.append(("categories.update",))
        return replace(self.category, **values)

    # AuditRecorder
    def record(self, entry: AuditEntry) -> None:
        self.calls.append(("audit.record", entry.action))
        self.entries.append(entry)


class Categories:
    def __init__(self, fakes: Fakes) -> None:
        self.get = fakes.get_category
        self.has_published_products = fakes.has_published_products
        self.update = fakes.update_category


def published(**changes: object) -> Product:
    return make_product(**changes).published(AT)


def test_publish_locks_product_then_category_for_share_and_audits_after_writing() -> None:
    fakes = Fakes(make_product(), make_category())

    PublishProduct(fakes, Categories(fakes), fakes, clock=lambda: AT)(fakes.product.id, ACTOR)

    assert fakes.calls == [
        ("products.lock",),
        ("categories.get", "share"),
        ("products.list_images",),
        ("products.update",),
        ("audit.record", "catalog.product_published"),
        ("products.get",),
    ]
    assert (fakes.product.status, fakes.product.published_at) == (ProductStatus.PUBLISHED, AT)


def test_publish_that_breaks_catalog_r2_writes_and_audits_nothing() -> None:
    fakes = Fakes(make_product(), make_category(), images=0)

    with pytest.raises(NotPublishable):
        PublishProduct(fakes, Categories(fakes), fakes)(fakes.product.id, ACTOR)

    assert fakes.calls == [
        ("products.lock",),
        ("categories.get", "share"),
        ("products.list_images",),
    ]


def test_editing_a_published_product_checks_catalog_r2_before_writing() -> None:
    fakes = Fakes(published(), make_category())

    UpdateProduct(fakes, Categories(fakes), fakes)(fakes.product.id, {"price": 120000}, ACTOR)

    assert fakes.calls == [
        ("products.lock",),
        ("categories.get", "share"),
        ("products.list_images",),
        ("products.update",),
        ("audit.record", "catalog.price_changed"),
        ("products.get",),
    ]


@pytest.mark.parametrize(
    ("changes", "category", "missing"),
    [
        ({"price": 0}, make_category(), ("price",)),
        ({"description": ""}, make_category(), ("description",)),
        ({"category_id": uuid4()}, make_category(is_active=False), ("category",)),
        ({"order_policy": "made_to_order"}, make_category(), ("lead_time_days",)),
    ],
)
def test_edit_that_breaks_catalog_r2_on_a_published_product_changes_nothing(
    changes: dict[str, object], category: Category, missing: tuple[str, ...]
) -> None:
    fakes = Fakes(published(), category)

    with pytest.raises(NotPublishable) as error:
        UpdateProduct(fakes, Categories(fakes), fakes)(fakes.product.id, changes, ACTOR)

    assert error.value.missing == missing
    assert ("products.update",) not in fakes.calls
    assert fakes.entries == []


def test_moving_a_published_product_to_a_missing_category_is_an_invalid_reference() -> None:
    fakes = Fakes(published(), category=None)

    with pytest.raises(InvalidReference) as error:
        UpdateProduct(fakes, Categories(fakes), fakes)(
            fakes.product.id, {"category_id": uuid4()}, ACTOR
        )

    assert error.value.field == "category_id"
    assert ("products.update",) not in fakes.calls


def test_editing_a_draft_does_not_lock_its_category_nor_check_catalog_r2() -> None:
    fakes = Fakes(make_product(), make_category(is_active=False), images=0)

    UpdateProduct(fakes, Categories(fakes), fakes)(fakes.product.id, {"price": 0}, ACTOR)

    assert fakes.calls == [
        ("products.lock",),
        ("products.update",),
        ("audit.record", "catalog.price_changed"),
        ("products.get",),
    ]


def test_order_policy_audit_keeps_only_the_fields_that_change() -> None:
    # M-1 (AUDIT-R2): solo cambia el plazo, no la política.
    fakes = Fakes(make_product(order_policy="made_to_order", lead_time_days=30), make_category())

    UpdateProduct(fakes, Categories(fakes), fakes)(fakes.product.id, {"lead_time_days": 45}, ACTOR)

    [entry] = fakes.entries
    assert (entry.action, entry.before, entry.after) == (
        "catalog.order_policy_changed",
        {"lead_time_days": 30},
        {"lead_time_days": 45},
    )
    assert (entry.actor_id, entry.actor_role) == (ACTOR.user_id, "admin")


def test_deactivating_a_category_locks_it_for_update_before_looking_for_published() -> None:
    fakes = Fakes(make_product(), make_category())

    UpdateCategory(Categories(fakes))(fakes.category.id, {"is_active": False})

    assert fakes.calls == [
        ("categories.get", "update"),
        ("categories.has_published_products",),
        ("categories.update",),
    ]


def test_deactivating_a_category_with_published_products_changes_nothing() -> None:
    fakes = Fakes(make_product(), make_category())
    fakes.published_in_category = True

    with pytest.raises(CategoryInUse):
        UpdateCategory(Categories(fakes))(fakes.category.id, {"is_active": False})

    assert ("categories.update",) not in fakes.calls


def test_other_category_changes_take_no_lock() -> None:
    fakes = Fakes(make_product(), make_category())

    UpdateCategory(Categories(fakes))(fakes.category.id, {"name": "Otra"})

    assert fakes.calls == [("categories.update",)]
