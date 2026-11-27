"""T-018i contra el Storage local real (npm run db:start): lo que sube el administrador llega al
bucket como WebP sin metadatos y se sirve por su URL pública con `Content-Type: image/webp`.

La suite crea su propio bucket (`t018i-<aleatorio>`, solo `image/webp`, 5 MiB) y lo vacía y borra
al terminar: no toca ningún archivo del bucket `products`.
"""

from collections.abc import Iterator
from uuid import uuid4

import httpx
import pytest

from tests.catalog.image_helpers import (
    assert_clean_webp,
    assert_no_metadata_when_reopened,
    jpeg_with_metadata,
    mpo_two_frames,
    png_with_alpha,
)
from tests.catalog.test_domain import make_product
from tests.catalog.test_images_http import OneProduct, make_client, upload
from valmont.modules.catalog.adapters.storage import SupabaseImageStorage
from valmont.modules.catalog.application import StorageUnavailable
from valmont.shared.config import get_settings

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def bucket() -> Iterator[tuple[str, str, dict[str, str]]]:
    settings = get_settings()
    key = settings.supabase_service_role_key
    if not (settings.supabase_url and key):
        pytest.fail("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Arranca: npm run db:start")
    url, secret = settings.supabase_url.rstrip("/"), key.get_secret_value()
    headers = {"Authorization": f"Bearer {secret}", "apikey": secret}
    name = f"t018i-{uuid4().hex[:12]}"
    body = {
        "id": name,
        "name": name,
        "public": True,
        "file_size_limit": 5 * 1024 * 1024,
        "allowed_mime_types": ["image/webp"],  # el propio bucket rechaza cualquier otro tipo
    }
    created = httpx.post(f"{url}/storage/v1/bucket", headers=headers, json=body, timeout=10)
    assert created.status_code == 200, created.text
    try:
        yield url, name, headers
    finally:  # solo el bucket propio: se vacía y se borra
        httpx.post(f"{url}/storage/v1/bucket/{name}/empty", headers=headers, timeout=10)
        gone = httpx.delete(f"{url}/storage/v1/bucket/{name}", headers=headers, timeout=10)
        assert gone.status_code == 200, f"quedó el bucket {name}: {gone.text}"


def fetch(bucket: tuple[str, str, dict[str, str]], product_url: str) -> httpx.Response:
    url, name, _ = bucket
    path = product_url.split("/products/", 1)[1]
    return httpx.get(f"{url}/storage/v1/object/public/{name}/{path}", timeout=10)


def client_and_repo(
    monkeypatch: pytest.MonkeyPatch, bucket: tuple[str, str, dict[str, str]]
) -> tuple[object, OneProduct]:
    url, name, _ = bucket
    key = get_settings().supabase_service_role_key
    assert key is not None
    storage = SupabaseImageStorage(url, key.get_secret_value(), bucket=name)
    repo = OneProduct(make_product())
    return make_client(monkeypatch, repo, storage), repo


def test_a_phone_jpeg_with_gps_is_served_as_rotated_webp_without_metadata(
    monkeypatch: pytest.MonkeyPatch, bucket: tuple[str, str, dict[str, str]]
) -> None:
    client, repo = client_and_repo(monkeypatch, bucket)

    response = upload(client, jpeg_with_metadata((300, 200), 6), product_id=repo.product.id)

    assert response.status_code == 201, response.text
    public_url = response.json()["url"]
    assert public_url.endswith(".webp")
    served = fetch(bucket, public_url)
    assert served.status_code == 200
    assert served.headers["content-type"].split(";")[0] == "image/webp"
    assert assert_clean_webp(served.content)
    assert assert_no_metadata_when_reopened(served.content).size == (200, 300)  # girada


def test_png_alpha_and_phone_mpo_reach_a_bucket_that_only_accepts_webp(
    monkeypatch: pytest.MonkeyPatch, bucket: tuple[str, str, dict[str, str]]
) -> None:
    client, repo = client_and_repo(monkeypatch, bucket)

    for original in (png_with_alpha(), mpo_two_frames()):
        response = upload(client, original, product_id=repo.product.id)

        assert response.status_code == 201, response.text
        served = fetch(bucket, response.json()["url"])
        assert served.status_code == 200 and assert_clean_webp(served.content)
        assert served.content != original


def test_the_own_bucket_really_refuses_non_webp_so_the_check_above_means_something(
    bucket: tuple[str, str, dict[str, str]],
) -> None:
    url, name, _ = bucket
    key = get_settings().supabase_service_role_key
    assert key is not None
    storage = SupabaseImageStorage(url, key.get_secret_value(), bucket=name)

    with pytest.raises(StorageUnavailable):
        storage.put(f"t018i/{uuid4()}.jpg", jpeg_with_metadata(), "image/jpeg")
