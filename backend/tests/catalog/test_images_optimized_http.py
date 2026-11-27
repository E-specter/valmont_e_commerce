"""Subida de imágenes por HTTP con el optimizador (T-018i, D-047/D-048): WebP sin metadatos, los
tres 422 nuevos, 413/415/401/403 sin cambios y Storage sin tocar cuando algo falla.
"""

import pytest

from tests.catalog.catalog_helpers import InMemoryStorage, tiny_png
from tests.catalog.image_helpers import (
    RecordingOptimizer,
    animated,
    assert_clean_webp,
    assert_no_metadata_when_reopened,
    corrupt_samples,
    jpeg_declaring,
    jpeg_with_metadata,
    mpo_two_frames,
    png_declaring,
    png_with_alpha,
    riff_chunks,
)
from tests.catalog.test_admin_http import Untouchable
from tests.catalog.test_domain import make_product
from tests.catalog.test_images_http import BASE, CUSTOMER, OneProduct, make_client, upload
from tests.identity.identity_helpers import make_token
from valmont.modules.catalog.domain import (
    IMAGE_MAX_BYTES,
    AnimatedImage,
    ImageDimensionsExceeded,
    InvalidImage,
)


def stored_webp(storage: InMemoryStorage) -> bytes:
    [(path, (data, content_type))] = storage.files.items()
    assert path.endswith(".webp") and content_type == "image/webp"
    return data


def test_a_phone_jpeg_with_gps_is_stored_rotated_as_webp_without_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, storage = OneProduct(make_product()), InMemoryStorage()
    client = make_client(monkeypatch, repo, storage)
    original = jpeg_with_metadata((300, 200), orientation=6)

    response = upload(client, original, product_id=repo.product.id)

    assert response.status_code == 201, response.text
    assert response.json()["url"].endswith(".webp")
    assert repo.images[0].storage_path.endswith(".webp")
    data = stored_webp(storage)
    assert assert_no_metadata_when_reopened(data).size == (200, 300)
    assert assert_clean_webp(data) and b"ValmontCam" not in data
    assert all(
        original != stored for stored, _ in storage.files.values()
    )  # el original no se guarda


def test_a_png_with_transparency_is_stored_with_its_alpha(monkeypatch: pytest.MonkeyPatch) -> None:
    repo, storage = OneProduct(make_product()), InMemoryStorage()
    client = make_client(monkeypatch, repo, storage)

    assert upload(client, png_with_alpha(), product_id=repo.product.id).status_code == 201

    assert b"ALPH" in riff_chunks(stored_webp(storage))


def test_a_phone_mpo_jpeg_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    repo, storage = OneProduct(make_product()), InMemoryStorage()
    client = make_client(monkeypatch, repo, storage)

    response = upload(client, mpo_two_frames(), product_id=repo.product.id)

    assert response.status_code == 201, response.text
    assert assert_clean_webp(stored_webp(storage))


IMAGE_422 = {
    "corrupt-jpeg": (corrupt_samples()["jpeg-header-plus-garbage"], "invalid_image"),
    "truncated-png": (corrupt_samples()["png-truncated"], "invalid_image"),
    "pixel-bomb-png": (png_declaring(5000, 6000), "image_dimensions_exceeded"),
    "pixel-bomb-jpeg": (jpeg_declaring(9000, 9000), "image_dimensions_exceeded"),
    "apng": (animated("PNG"), "animated_image"),
    "animated-webp": (animated("WEBP"), "animated_image"),
}


@pytest.mark.parametrize(("data", "code"), IMAGE_422.values(), ids=IMAGE_422.keys())
def test_unreadable_oversized_or_animated_images_are_422_in_the_common_shape_and_store_nothing(
    monkeypatch: pytest.MonkeyPatch, data: bytes, code: str
) -> None:
    repo, storage = OneProduct(make_product()), InMemoryStorage()
    client = make_client(monkeypatch, repo, storage)

    response = upload(client, data, product_id=repo.product.id)

    assert response.status_code == 422
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code
    assert body["error"]["message"] and body["error"]["details"] is None
    for leak in ("PIL", "Pillow", "cannot identify", "BytesIO", "Traceback", "\\x"):
        assert leak not in response.text
    assert storage.files == {} and repo.images == []


def test_an_animated_gif_is_415_by_its_signature_before_pillow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    optimizer = RecordingOptimizer()
    client = make_client(monkeypatch, Untouchable(), Untouchable(), optimizer)

    response = upload(client, animated("GIF"))

    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"
    assert optimizer.calls == []


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (InvalidImage(), "invalid_image"),
        (ImageDimensionsExceeded(), "image_dimensions_exceeded"),
        (AnimatedImage(), "animated_image"),
    ],
)
def test_the_three_optimizer_errors_map_to_422_without_touching_storage(
    monkeypatch: pytest.MonkeyPatch, error: Exception, code: str
) -> None:
    client = make_client(monkeypatch, Untouchable(), Untouchable(), RecordingOptimizer(error=error))

    response = upload(client, tiny_png())

    assert response.status_code == 422
    assert response.json()["error"]["code"] == code


def test_an_unexpected_optimizer_failure_is_a_500_without_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = RuntimeError("detalle-interno-de-pillow")
    client = make_client(monkeypatch, Untouchable(), Untouchable(), RecordingOptimizer(error=error))

    response = upload(client, tiny_png())

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"
    assert "detalle-interno" not in response.text and "Traceback" not in response.text


def test_the_optimized_bytes_not_the_upload_reach_storage_through_the_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, storage, optimizer = OneProduct(make_product()), InMemoryStorage(), RecordingOptimizer()
    client = make_client(monkeypatch, repo, storage, optimizer)

    response = upload(client, tiny_png(), product_id=repo.product.id)

    assert response.status_code == 201
    [(path, (data, content_type))] = storage.files.items()
    assert (data, content_type) == (optimizer.result.data, "image/webp")
    assert path.endswith(".webp") and optimizer.inputs == [tiny_png()]


def test_exactly_five_mib_is_processed_and_one_byte_more_never_reaches_the_optimizer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, storage, optimizer = OneProduct(make_product()), InMemoryStorage(), RecordingOptimizer()
    client = make_client(monkeypatch, repo, storage, optimizer)

    ok = upload(client, tiny_png().ljust(IMAGE_MAX_BYTES, b"\0"), product_id=repo.product.id)
    over = upload(client, tiny_png().ljust(IMAGE_MAX_BYTES + 1, b"\0"), product_id=repo.product.id)

    assert ok.status_code == 201
    assert over.status_code == 413 and over.json()["error"]["code"] == "file_too_large"
    assert len(optimizer.inputs) == 1 and len(optimizer.inputs[0]) == IMAGE_MAX_BYTES


def test_a_five_mib_png_goes_through_the_real_optimizer(monkeypatch: pytest.MonkeyPatch) -> None:
    repo, storage = OneProduct(make_product()), InMemoryStorage()
    client = make_client(monkeypatch, repo, storage)

    response = upload(client, tiny_png().ljust(IMAGE_MAX_BYTES, b"\0"), product_id=repo.product.id)

    assert response.status_code == 201, response.text
    assert len(stored_webp(storage)) < IMAGE_MAX_BYTES  # el relleno no se guarda


def test_a_customer_or_an_anonymous_caller_never_reaches_the_optimizer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    optimizer = RecordingOptimizer()
    client = make_client(monkeypatch, Untouchable(), Untouchable(), optimizer)

    customer = {"Authorization": f"Bearer {make_token(str(CUSTOMER))}"}
    forbidden = client.post(
        f"{BASE}/products/{make_product().id}/images",
        data={"alt": "Vista"},
        files={"file": ("a.png", tiny_png(), "image/png")},
        headers=customer,
    )
    del client.headers["Authorization"]
    anonymous = upload(client, tiny_png())

    assert (forbidden.status_code, anonymous.status_code) == (403, 401)
    assert optimizer.calls == []
