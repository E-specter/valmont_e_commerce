"""Casos de uso de imágenes (T-029) con fakes que anotan el orden de llamadas.

El orden importa: el producto se bloquea antes de contar sus imágenes (CATALOG-R11 frente a una
publicación concurrente), el archivo se sube antes de insertar la fila y, si la fila no entra,
se borra el archivo.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from tests.catalog.catalog_helpers import tiny_png
from tests.catalog.test_domain import make_product
from valmont.modules.catalog.application import (
    AddProductImage,
    RemoveProductImage,
    ReorderProductImages,
    StorageUnavailable,
    UpdateProductImage,
    discard_file,
)
from valmont.modules.catalog.domain import (
    CatalogConflict,
    CatalogError,
    CatalogNotFound,
    LastImage,
    Product,
    ProductImage,
    UnsupportedImage,
)

AT = datetime(2026, 10, 1, tzinfo=UTC)


class Fakes:
    """Productos e ImageStorage que anotan cada llamada en el mismo registro."""

    def __init__(self, product: Product | None, images: int = 0) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.product = product
        product_id = product.id if product else uuid4()
        self.images = [
            ProductImage(uuid4(), product_id, f"{product_id}/{n}.png", f"Vista {n}", n)
            for n in range(images)
        ]
        self.add_fails = False
        self.storage_fails = False

    # ProductRepository
    def lock(self, product_id: UUID) -> Product | None:
        self.calls.append(("products.lock",))
        return self.product

    def list_images(self, product_id: UUID) -> list[ProductImage]:
        self.calls.append(("products.list_images",))
        return list(self.images)

    def add_image(self, image: ProductImage) -> None:
        self.calls.append(("products.add_image", image.position))
        if self.add_fails:
            raise CatalogConflict("position")
        self.images.append(image)

    def update_image_alt(self, product_id: UUID, image_id: UUID, alt: str) -> ProductImage | None:
        self.calls.append(("products.update_image_alt",))
        return next((i for i in self.images if i.id == image_id), None)

    def delete_image(self, image_id: UUID) -> None:
        self.calls.append(("products.delete_image",))

    def set_image_order(self, product_id: UUID, image_ids: list[UUID]) -> None:
        self.calls.append(("products.set_image_order", tuple(image_ids)))

    # ImageStorage
    def put(self, path: str, data: bytes, content_type: str) -> None:
        self.calls.append(("storage.put", content_type))
        if self.storage_fails:
            raise StorageUnavailable

    def delete(self, path: str) -> None:
        self.calls.append(("storage.delete", path))
        if self.storage_fails:
            raise StorageUnavailable


def test_upload_locks_the_product_uploads_and_then_inserts_at_the_next_position() -> None:
    product = make_product()
    fakes = Fakes(product, images=2)

    image = AddProductImage(fakes, fakes)(product.id, tiny_png(), "  Vista frontal ")

    assert fakes.calls == [
        ("products.lock",),
        ("products.list_images",),
        ("storage.put", "image/png"),
        ("products.add_image", 2),
    ]
    assert (image.product_id, image.position, image.alt) == (product.id, 2, "Vista frontal")
    # Ruta generada por el servidor: {product_id}/{uuid}.{ext}; el nombre del cliente no cuenta.
    assert image.storage_path == f"{product.id}/{image.id}.png"


def test_first_image_takes_position_zero() -> None:
    fakes = Fakes(make_product())

    image = AddProductImage(fakes, fakes)(fakes.product.id, tiny_png(), "Vista")

    assert image.position == 0


def test_invalid_file_or_alt_touches_neither_the_product_nor_storage() -> None:
    fakes = Fakes(make_product())

    with pytest.raises(UnsupportedImage):
        AddProductImage(fakes, fakes)(fakes.product.id, b"GIF89a", "Vista")
    with pytest.raises(CatalogError):
        AddProductImage(fakes, fakes)(fakes.product.id, tiny_png(), "a" * 151)

    assert ("storage.put", "image/png") not in fakes.calls
    assert ("products.add_image", 0) not in fakes.calls


def test_upload_to_a_missing_product_is_not_found_and_uploads_nothing() -> None:
    fakes = Fakes(product=None)

    with pytest.raises(CatalogNotFound):
        AddProductImage(fakes, fakes)(uuid4(), tiny_png(), "Vista")

    assert fakes.calls == [("products.lock",)]


def test_when_the_row_cannot_be_inserted_the_uploaded_file_is_deleted() -> None:
    fakes = Fakes(make_product())
    fakes.add_fails = True

    with pytest.raises(CatalogConflict):
        AddProductImage(fakes, fakes)(fakes.product.id, tiny_png(), "Vista")

    put, add, delete = fakes.calls[-3:]
    assert (put[0], add[0], delete[0]) == ("storage.put", "products.add_image", "storage.delete")
    assert str(delete[1]).startswith(f"{fakes.product.id}/")


def test_storage_failure_on_upload_inserts_no_row() -> None:
    fakes = Fakes(make_product())
    fakes.storage_fails = True

    with pytest.raises(StorageUnavailable):
        AddProductImage(fakes, fakes)(fakes.product.id, tiny_png(), "Vista")

    assert fakes.calls[-1] == ("storage.put", "image/png")


def test_remove_locks_the_product_before_counting_and_returns_the_path_to_delete() -> None:
    fakes = Fakes(make_product().published(AT), images=2)
    image = fakes.images[1]

    path = RemoveProductImage(fakes)(fakes.product.id, image.id)

    assert fakes.calls == [
        ("products.lock",),
        ("products.list_images",),
        ("products.delete_image",),
    ]
    assert path == image.storage_path  # el archivo lo borra el router tras el commit


def test_catalog_r11_removing_the_last_image_of_a_published_product_changes_nothing() -> None:
    fakes = Fakes(make_product().published(AT), images=1)

    with pytest.raises(LastImage):
        RemoveProductImage(fakes)(fakes.product.id, fakes.images[0].id)

    assert ("products.delete_image",) not in fakes.calls


@pytest.mark.parametrize("product", [None, make_product()], ids=["producto", "imagen"])
def test_remove_a_missing_product_or_image_is_not_found(product: Product | None) -> None:
    fakes = Fakes(product, images=1)

    with pytest.raises(CatalogNotFound):
        RemoveProductImage(fakes)(uuid4(), uuid4())

    assert ("products.delete_image",) not in fakes.calls


def test_reorder_locks_the_product_and_stores_the_new_order() -> None:
    fakes = Fakes(make_product(), images=2)
    a, b = fakes.images

    ordered = ReorderProductImages(fakes)(fakes.product.id, [b.id, a.id])

    assert fakes.calls == [
        ("products.lock",),
        ("products.list_images",),
        ("products.set_image_order", (b.id, a.id)),
    ]
    assert [(image.id, image.position) for image in ordered] == [(b.id, 0), (a.id, 1)]


def test_reorder_without_exactly_all_the_ids_changes_nothing() -> None:
    fakes = Fakes(make_product(), images=2)

    with pytest.raises(CatalogError):
        ReorderProductImages(fakes)(fakes.product.id, [fakes.images[0].id])

    assert all(call[0] != "products.set_image_order" for call in fakes.calls)


def test_update_alt_of_a_missing_image_is_not_found() -> None:
    fakes = Fakes(make_product())

    with pytest.raises(CatalogNotFound):
        UpdateProductImage(fakes)(fakes.product.id, uuid4(), "Otra")


def test_discard_file_only_warns_when_storage_fails(caplog: pytest.LogCaptureFixture) -> None:
    fakes = Fakes(make_product())
    fakes.storage_fails = True

    with caplog.at_level(logging.WARNING):
        discard_file(fakes, "producto/imagen.png")

    assert fakes.calls == [("storage.delete", "producto/imagen.png")]
    assert "producto/imagen.png" in caplog.text
