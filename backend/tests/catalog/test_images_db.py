"""CA-CATALOG-07 y CATALOG-R11 por HTTP contra PostgreSQL; Storage en memoria.

Cada solicitud corre en un SAVEPOINT, como la transacción de get_session: si falla, se deshace.
"""

from collections.abc import Iterator
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import Catalog, InMemoryStorage, make_image, tiny_png
from tests.catalog.image_helpers import (
    animated,
    assert_clean_webp,
    corrupt_samples,
    jpeg_with_metadata,
    png_declaring,
)
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.catalog.adapters import admin_http, http
from valmont.modules.catalog.adapters.persistence import SqlProductRepository
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import Settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ADMIN = uuid4()
BASE = "/api/v1/catalog/admin"
POSITIONS = text("SELECT id, position FROM app.product_images WHERE product_id = :id ORDER BY 2")


@pytest.fixture
def storage() -> InMemoryStorage:
    return InMemoryStorage()


@pytest.fixture
def client(
    db_session: Session, storage: InMemoryStorage, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    use_test_auth(monkeypatch)
    settings = Settings(_env_file=None, storage_public_url="https://cdn.valmont.test")
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    profiles = InMemoryProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    app.dependency_overrides[admin_http.get_image_storage] = lambda: storage

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    return TestClient(app, headers={"Authorization": f"Bearer {make_token(str(ADMIN))}"})


def positions(session: Session, product_id: UUID) -> list[tuple[str, int]]:
    return [(str(i), p) for i, p in session.execute(POSITIONS, {"id": product_id})]


def upload(client: TestClient, product_id: UUID, alt: str = "Vista") -> dict[str, str]:
    files = {"file": ("reloj.png", tiny_png(), "image/png")}
    response = client.post(f"{BASE}/products/{product_id}/images", data={"alt": alt}, files=files)
    assert response.status_code == 201, response.text
    return response.json()


def test_upload_stores_the_file_and_appends_the_row_at_the_next_position(
    client: TestClient, db_session: Session, catalog: Catalog, storage: InMemoryStorage
) -> None:
    draft = catalog.products["draco"]

    first, second = upload(client, draft.id, "Frente"), upload(client, draft.id, "Dorso")

    assert positions(db_session, draft.id) == [(first["id"], 0), (second["id"], 1)]
    assert set(storage.files) == {
        f"{draft.id}/{first['id']}.webp",
        f"{draft.id}/{second['id']}.webp",
    }
    assert first["url"] == (
        f"https://cdn.valmont.test/storage/v1/object/public/products/{draft.id}/{first['id']}.webp"
    )
    detail = client.get(f"{BASE}/products/{draft.id}").json()
    assert [image["alt"] for image in detail["images"]] == ["Frente", "Dorso"]
    assert detail["main_image"]["id"] == first["id"]


def test_upload_to_a_missing_product_is_404_and_stores_nothing(
    client: TestClient, storage: InMemoryStorage
) -> None:
    files = {"file": ("reloj.png", tiny_png(), "image/png")}

    response = client.post(f"{BASE}/products/{uuid4()}/images", data={"alt": "V"}, files=files)

    assert response.status_code == 404
    assert storage.files == {}


def test_storage_down_is_503_and_leaves_no_row(
    client: TestClient, db_session: Session, catalog: Catalog, storage: InMemoryStorage
) -> None:
    storage.fails = True
    draft = catalog.products["draco"]
    files = {"file": ("reloj.png", tiny_png(), "image/png")}

    response = client.post(f"{BASE}/products/{draft.id}/images", data={"alt": "V"}, files=files)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "storage_unavailable"
    assert positions(db_session, draft.id) == []


def test_reorder_swaps_positions_despite_the_unique_constraint(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    draft = catalog.products["draco"]
    a, b, c = (upload(client, draft.id, alt)["id"] for alt in ("A", "B", "C"))

    response = client.put(f"{BASE}/products/{draft.id}/images/order", json=[c, a, b])

    assert response.status_code == 200
    assert [image["id"] for image in response.json()] == [c, a, b]
    assert positions(db_session, draft.id) == [(c, 0), (a, 1), (b, 2)]
    assert [i["id"] for i in client.get(f"{BASE}/products/{draft.id}").json()["images"]] == [
        c,
        a,
        b,
    ]


@pytest.mark.parametrize(
    "pick",
    [
        pytest.param(lambda a, b: [a], id="falta-una"),
        pytest.param(lambda a, b: [a, b, str(uuid4())], id="sobra-una"),
        pytest.param(lambda a, b: [a, a], id="repetida"),
    ],
)
def test_reorder_without_exactly_all_the_ids_is_422_and_changes_nothing(
    client: TestClient, db_session: Session, catalog: Catalog, pick: object
) -> None:
    draft = catalog.products["draco"]
    a, b = (upload(client, draft.id, alt)["id"] for alt in ("A", "B"))

    response = client.put(f"{BASE}/products/{draft.id}/images/order", json=pick(a, b))  # type: ignore[operator]

    assert response.status_code == 422
    assert positions(db_session, draft.id) == [(a, 0), (b, 1)]


def test_reorder_of_a_missing_product_is_404(client: TestClient) -> None:
    assert client.put(f"{BASE}/products/{uuid4()}/images/order", json=[]).status_code == 404


def test_patch_alt_changes_only_the_alt(client: TestClient, catalog: Catalog) -> None:
    draft = catalog.products["draco"]
    image = upload(client, draft.id, "Antes")

    response = client.patch(
        f"{BASE}/products/{draft.id}/images/{image['id']}", json={"alt": "  Después "}
    )

    assert response.status_code == 200
    assert response.json() == image | {"alt": "Después"}


def test_patch_or_delete_an_image_of_another_product_is_404(
    client: TestClient, catalog: Catalog
) -> None:
    image = upload(client, catalog.products["draco"].id)
    other = catalog.products["boreal"].id
    path = f"{BASE}/products/{other}/images/{image['id']}"

    assert client.patch(path, json={"alt": "Otra"}).status_code == 404
    assert client.delete(path).status_code == 404


def test_catalog_r11_last_image_of_a_published_product_is_409_and_kept(
    client: TestClient, db_session: Session, catalog: Catalog, storage: InMemoryStorage
) -> None:
    published = catalog.products["aurora"]
    image = upload(client, published.id)

    response = client.delete(f"{BASE}/products/{published.id}/images/{image['id']}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "last_image"
    assert positions(db_session, published.id) == [(image["id"], 0)]
    assert f"{published.id}/{image['id']}.webp" in storage.files


def test_delete_removes_the_row_and_then_the_file(
    client: TestClient, db_session: Session, catalog: Catalog, storage: InMemoryStorage
) -> None:
    published = catalog.products["aurora"]
    kept, removed = upload(client, published.id, "Queda"), upload(client, published.id, "Se va")

    response = client.delete(f"{BASE}/products/{published.id}/images/{removed['id']}")

    assert (response.status_code, response.content) == (204, b"")
    assert positions(db_session, published.id) == [(kept["id"], 0)]
    # TestClient ejecuta la BackgroundTask antes de devolver la respuesta.
    assert set(storage.files) == {f"{published.id}/{kept['id']}.webp"}


def test_a_draft_can_lose_its_last_image(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    draft = catalog.products["draco"]
    image = upload(client, draft.id)

    response = client.delete(f"{BASE}/products/{draft.id}/images/{image['id']}")

    assert response.status_code == 204
    assert positions(db_session, draft.id) == []


def test_storage_failure_after_deleting_the_row_only_leaves_an_orphan_file(
    client: TestClient,
    db_session: Session,
    repo: SqlProductRepository,
    catalog: Catalog,
    storage: InMemoryStorage,
) -> None:
    draft = catalog.products["draco"]
    image = make_image(draft, 0)
    repo.add_image(image)
    storage.fails = True

    response = client.delete(f"{BASE}/products/{draft.id}/images/{image.id}")

    assert response.status_code == 204  # el aviso queda en el log; la fila ya no está
    assert positions(db_session, draft.id) == []


def test_upload_converts_to_webp_and_records_a_webp_path_in_the_row(
    client: TestClient, db_session: Session, catalog: Catalog, storage: InMemoryStorage
) -> None:
    draft = catalog.products["draco"]
    files = {"file": ("movil.jpg", jpeg_with_metadata(), "image/jpeg")}

    response = client.post(f"{BASE}/products/{draft.id}/images", data={"alt": "Movil"}, files=files)

    assert response.status_code == 201, response.text
    path = db_session.scalar(
        text("SELECT storage_path FROM app.product_images WHERE id = :id"),
        {"id": response.json()["id"]},
    )
    assert path == f"{draft.id}/{response.json()['id']}.webp"
    [(data, content_type)] = storage.files.values()
    assert content_type == "image/webp" and assert_clean_webp(data)
    assert response.json()["url"].endswith(".webp")


def test_a_rejected_image_leaves_neither_a_row_nor_a_file(
    client: TestClient, db_session: Session, catalog: Catalog, storage: InMemoryStorage
) -> None:
    draft = catalog.products["draco"]
    for data in (corrupt_samples()["png-truncated"], png_declaring(5000, 6000), animated("PNG")):
        files = {"file": ("x.png", data, "image/png")}

        response = client.post(
            f"{BASE}/products/{draft.id}/images", data={"alt": "Mala"}, files=files
        )

        assert response.status_code == 422, response.text

    assert positions(db_session, draft.id) == [] and storage.files == {}
