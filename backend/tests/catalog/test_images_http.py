"""Imágenes de producto por HTTP sin BD (T-029): validación de la subida, errores y OpenAPI."""

import json
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from tests.catalog.catalog_helpers import InMemoryStorage, tiny_png
from tests.catalog.test_admin_http import Untouchable
from tests.catalog.test_domain import make_product
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.catalog.adapters import admin_http, http
from valmont.modules.catalog.domain import IMAGE_MAX_BYTES, Product, ProductImage
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import Settings

ADMIN = uuid4()
BASE = "/api/v1/catalog/admin"
CDN = "https://cdn.valmont.test"
GIF = b"GIF89a" + b"\x00" * 32


class OneProduct:
    """ProductRepository mínimo para la subida: un producto y sus imágenes en memoria."""

    def __init__(self, product: Product) -> None:
        self.product = product
        self.images: list[ProductImage] = []

    def lock(self, product_id: UUID) -> Product | None:
        return self.product if product_id == self.product.id else None

    def list_images(self, product_id: UUID) -> list[ProductImage]:
        return list(self.images)

    def add_image(self, image: ProductImage) -> None:
        self.images.append(image)


def make_client(monkeypatch: pytest.MonkeyPatch, repo: object, storage: object) -> TestClient:
    use_test_auth(monkeypatch)
    settings = Settings(_env_file=None, storage_public_url=CDN)
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    profiles = InMemoryProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    app.dependency_overrides[http.get_product_repository] = lambda: repo
    app.dependency_overrides[admin_http.get_image_storage] = lambda: storage
    headers = {"Authorization": f"Bearer {make_token(str(ADMIN))}"}
    return TestClient(app, headers=headers, raise_server_exceptions=False)


@pytest.fixture
def untouched(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Ni el repositorio ni Storage se pueden usar: la solicitud debe fallar antes."""
    return make_client(monkeypatch, Untouchable(), Untouchable())


def upload(
    client: TestClient, data: bytes, alt: str | None = "Vista frontal", product_id: object = None
) -> object:
    form = {} if alt is None else {"alt": alt}
    files = {"file": ("../../reloj.gif", data, "image/gif")}  # nombre y tipo del cliente: ignorados
    return client.post(f"{BASE}/products/{product_id or uuid4()}/images", data=form, files=files)


def test_upload_detects_the_type_by_signature_and_ignores_the_client_name_and_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo, storage = OneProduct(make_product()), InMemoryStorage()
    client = make_client(monkeypatch, repo, storage)

    response = upload(client, tiny_png(), alt="  Vista frontal ", product_id=repo.product.id)

    assert response.status_code == 201
    body = response.json()
    [image] = repo.images
    assert body == {
        "id": str(image.id),
        "url": f"{CDN}/storage/v1/object/public/products/{repo.product.id}/{image.id}.png",
        "alt": "Vista frontal",
    }
    assert storage.files == {f"{repo.product.id}/{image.id}.png": (tiny_png(), "image/png")}


def test_upload_with_another_signature_is_415(untouched: TestClient) -> None:
    response = upload(untouched, GIF)

    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"


def test_file_one_byte_over_the_limit_is_413(untouched: TestClient) -> None:
    response = upload(untouched, tiny_png().ljust(IMAGE_MAX_BYTES + 1, b"\x00"))

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


def test_body_over_the_limit_is_413_before_reading_it_or_checking_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(monkeypatch, Untouchable(), Untouchable())
    del client.headers["Authorization"]

    response = upload(client, tiny_png().ljust(IMAGE_MAX_BYTES + 128 * 1024, b"\x00"))

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


def test_body_without_content_length_is_413(untouched: TestClient) -> None:
    def chunks() -> object:
        yield b"--x\r\n"

    response = untouched.post(
        f"{BASE}/products/{uuid4()}/images",
        content=chunks(),  # type: ignore[arg-type]
        headers={"Content-Type": "multipart/form-data; boundary=x"},
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


@pytest.mark.parametrize(
    ("alt", "field"),
    [
        (None, "alt"),
        ("", "alt"),
        ("a" * 151, "alt"),
        ("con\x00nul", "alt"),
    ],
)
def test_upload_validates_alt_with_422_on_its_field(
    untouched: TestClient, alt: str | None, field: str
) -> None:
    response = upload(untouched, tiny_png(), alt=alt)

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["body", field]]


def test_upload_without_file_is_422_on_file(untouched: TestClient) -> None:
    response = untouched.post(f"{BASE}/products/{uuid4()}/images", data={"alt": "Vista"})

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["body", "file"]]


def test_upload_to_a_missing_product_is_404_and_uploads_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = InMemoryStorage()
    client = make_client(monkeypatch, OneProduct(make_product()), storage)

    response = upload(client, tiny_png())

    assert response.status_code == 404
    assert storage.files == {}


def test_storage_failure_is_503_without_details(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = OneProduct(make_product())
    client = make_client(monkeypatch, repo, InMemoryStorage(fails=True))

    response = upload(client, tiny_png(), product_id=repo.product.id)

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "storage_unavailable",
            "message": "El almacenamiento de imágenes no está disponible.",
            "details": None,
        }
    }
    assert repo.images == []


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", f"/images/{uuid4()}", {"alt": ""}),
        ("PATCH", f"/images/{uuid4()}", {"alt": "a" * 151}),
        ("PATCH", f"/images/{uuid4()}", {"alt": "Otra", "position": 0}),
        ("PATCH", f"/images/{uuid4()}", {}),
        ("PUT", "/images/order", {"ids": []}),
        ("PUT", "/images/order", ["no-uuid"]),
        ("DELETE", "/images/no-uuid", None),
    ],
)
def test_image_bodies_and_ids_are_validated(
    untouched: TestClient, method: str, path: str, body: object
) -> None:
    response = untouched.request(method, f"{BASE}/products/{uuid4()}{path}", json=body)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_openapi_declares_the_upload_as_multipart_with_its_errors() -> None:
    document = create_app().openapi()
    operation = document["paths"][f"{BASE}/products/{{product_id}}/images"]["post"]

    assert set(operation["responses"]) == {"201", "401", "403", "404", "413", "415", "422", "503"}
    assert "`storage_unavailable`" in operation["responses"]["503"]["description"]
    form = operation["requestBody"]["content"]["multipart/form-data"]["schema"]["$ref"]
    schema = document["components"]["schemas"][form.rsplit("/", 1)[1]]
    assert set(schema["required"]) == {"file", "alt"}
    created = operation["responses"]["201"]["content"]["application/json"]["schema"]
    assert created == {"$ref": "#/components/schemas/ProductImageOut"}
    image = document["components"]["schemas"]["ProductImageOut"]
    assert set(image["properties"]) == {"id", "url", "alt"}  # sin storage_path
    delete = document["paths"][f"{BASE}/products/{{product_id}}/images/{{image_id}}"]["delete"]
    assert set(delete["responses"]) >= {"204", "404", "409"}
    assert "HTTPValidationError" not in json.dumps(document)
