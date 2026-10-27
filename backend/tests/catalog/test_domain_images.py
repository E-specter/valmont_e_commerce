"""Reglas de imágenes (T-029): tipo por la firma del archivo, tamaño, CATALOG-R11 y orden."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from tests.catalog.catalog_helpers import tiny_png
from tests.catalog.test_domain import make_product
from valmont.modules.catalog.domain import (
    IMAGE_MAX_BYTES,
    CatalogError,
    ImageTooLarge,
    LastImage,
    ProductImage,
    UnsupportedImage,
    image_format,
    order_images,
)

AT = datetime(2026, 10, 1, tzinfo=UTC)
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 16


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (JPEG, ("jpg", "image/jpeg")),
        (tiny_png(), ("png", "image/png")),
        (WEBP, ("webp", "image/webp")),
    ],
)
def test_image_format_comes_from_the_file_signature(data: bytes, expected: tuple[str, str]) -> None:
    assert image_format(data) == expected


@pytest.mark.parametrize(
    "data",
    [
        pytest.param(b"", id="vacio"),
        pytest.param(b"GIF89a" + b"\x00" * 16, id="gif"),
        pytest.param(b"<svg xmlns='http://www.w3.org/2000/svg'/>", id="svg"),
        pytest.param(b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 16, id="riff-no-webp"),
        pytest.param(b"\x89PNG\r\n", id="png-truncado"),
        pytest.param(b"\xff\xd8", id="jpeg-truncado"),
    ],
)
def test_other_signatures_are_unsupported(data: bytes) -> None:
    with pytest.raises(UnsupportedImage):
        image_format(data)


def test_image_up_to_the_limit_is_accepted_and_one_byte_more_is_too_large() -> None:
    assert image_format(JPEG.ljust(IMAGE_MAX_BYTES, b"\x00"))[0] == "jpg"

    with pytest.raises(ImageTooLarge):
        image_format(JPEG.ljust(IMAGE_MAX_BYTES + 1, b"\x00"))


def test_catalog_r11_last_image_of_a_published_product_cannot_be_removed() -> None:
    with pytest.raises(LastImage):
        make_product().published(AT).ensure_image_can_be_removed(image_count=1)


@pytest.mark.parametrize(
    ("published", "count"), [(True, 2), (False, 1)], ids=["publicado-con-dos", "borrador"]
)
def test_other_images_can_be_removed(published: bool, count: int) -> None:
    product = make_product().published(AT) if published else make_product()

    product.ensure_image_can_be_removed(image_count=count)


def images(count: int) -> list[ProductImage]:
    product_id = uuid4()
    return [
        ProductImage(uuid4(), product_id, f"{product_id}/{n}.png", f"Vista {n}", n)
        for n in range(count)
    ]


def test_order_images_renumbers_from_zero_in_the_given_order() -> None:
    current = images(3)
    a, b, c = current

    ordered = order_images(current, [c.id, a.id, b.id])

    assert [(image.id, image.position) for image in ordered] == [(c.id, 0), (a.id, 1), (b.id, 2)]


@pytest.mark.parametrize(
    "pick",
    [
        pytest.param(lambda ids: ids[:2], id="falta-una"),
        pytest.param(lambda ids: [*ids, uuid4()], id="sobra-una"),
        pytest.param(lambda ids: [ids[0], ids[0], ids[1]], id="repetida"),
        pytest.param(lambda ids: [ids[0], ids[1], uuid4()], id="ajena"),
        pytest.param(lambda ids: [], id="vacia"),
    ],
)
def test_order_images_needs_exactly_all_the_ids_of_the_product(pick: object) -> None:
    current = images(3)

    with pytest.raises(CatalogError):
        order_images(current, pick([image.id for image in current]))  # type: ignore[operator]
