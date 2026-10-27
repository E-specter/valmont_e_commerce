"""SupabaseImageStorage contra el Storage local real (bucket products; npm run db:start).

Usa la configuración de backend/.env tal como la usa la app (get_image_storage y la URL pública
de la SPEC §6). Cada prueba borra lo que sube.
"""

from uuid import uuid4

import httpx
import pytest

from tests.catalog.catalog_helpers import tiny_png
from valmont.modules.catalog.adapters.admin_http import get_image_storage
from valmont.modules.catalog.adapters.http import _image_url
from valmont.modules.catalog.adapters.storage import SupabaseImageStorage
from valmont.modules.catalog.application import ImageStorage, StorageUnavailable
from valmont.shared.config import get_settings

pytestmark = pytest.mark.integration


@pytest.fixture
def storage() -> ImageStorage:
    try:
        return get_image_storage()
    except RuntimeError as exc:
        pytest.fail(f"{exc} Arranca Supabase: npm run db:start", pytrace=False)


def test_upload_is_served_by_its_public_url_and_delete_removes_it(storage: ImageStorage) -> None:
    path = f"t029-prueba/{uuid4()}.png"

    storage.put(path, tiny_png(), "image/png")
    try:
        public = httpx.get(_image_url(path), timeout=5)
        assert public.status_code == 200
        assert (public.content, public.headers["content-type"]) == (tiny_png(), "image/png")
    finally:
        storage.delete(path)

    assert httpx.get(_image_url(path), timeout=5).status_code in (400, 404)


def test_upload_without_a_valid_service_key_is_rejected(storage: ImageStorage) -> None:
    url = get_settings().supabase_url or ""
    intruder = SupabaseImageStorage(url, "clave-no-valida")

    with pytest.raises(StorageUnavailable):
        intruder.put(f"t029-prueba/{uuid4()}.png", tiny_png(), "image/png")
