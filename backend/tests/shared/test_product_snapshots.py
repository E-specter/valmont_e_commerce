"""Lector compartido `valmont.shared.product_snapshots` (T-066, D-039.4, CA-WISH-12).

La consulta se extrajo de cart sin cambiar su comportamiento: sus garantías (una sola consulta,
precio vigente, disponibilidad, primera imagen, solo publicados, `get_names`) ya las prueba
`tests/cart/test_catalog_reader.py` a través de `SqlCartCatalog`. Aquí: que ese alias ES el lector
compartido, que `image_url` tiene una sola implementación (cart y catalog la importan) y una
comprobación directa del lector.
"""

import ast
from dataclasses import FrozenInstanceError, fields
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_listed, captured, identity_of
from valmont.modules.cart import application as cart_application
from valmont.modules.cart.adapters import http as cart_http
from valmont.modules.cart.adapters import persistence as cart_persistence
from valmont.modules.catalog.adapters import http as catalog_http
from valmont.shared import product_snapshots
from valmont.shared.config import Settings
from valmont.shared.product_snapshots import ProductSnapshot, SqlProductSnapshots, image_url

SRC = Path(product_snapshots.__file__).parents[1]
PUBLIC_PATH = "/storage/v1/object/public/products/"


def use_settings(monkeypatch: pytest.MonkeyPatch, **values: object) -> Settings:
    settings = Settings(_env_file=None, **values)
    monkeypatch.setattr(product_snapshots, "get_settings", lambda: settings)
    return settings


# ---------------------------------------------------------------------------------------------
# CA-WISH-12: una sola implementación; cart sigue exponiendo los mismos nombres.
def test_cart_catalog_and_snapshot_are_the_shared_ones() -> None:
    assert cart_persistence.SqlCartCatalog is SqlProductSnapshots
    assert cart_application.ProductSnapshot is ProductSnapshot


def test_the_snapshot_has_the_fourteen_fields_of_the_spec_and_is_frozen() -> None:
    assert [f.name for f in fields(ProductSnapshot)] == [
        "product_id",
        "sku",
        "slug",
        "name",
        "image_path",
        "alt",
        "order_policy",
        "available",
        "availability_status",
        "lead_time_days",
        "list_price",
        "price",
        "discount_amount",
        "promotion_id",
    ]
    snap = ProductSnapshot(uuid4(), "SKU", "slug", "Nombre", None, None, "stock", 1, "in_stock",
                           None, 100, 90, 10, None)  # fmt: skip
    with pytest.raises(FrozenInstanceError):
        snap.price = 1  # type: ignore[misc]


def test_cart_no_longer_defines_its_own_image_url_or_product_query() -> None:
    http_tree = ast.parse(Path(cart_http.__file__).read_text(encoding="utf-8"))
    defined = {n.name for n in ast.walk(http_tree) if isinstance(n, ast.FunctionDef)}
    assert "_image_url" not in defined
    assert not hasattr(cart_http, "_image_url")
    assert cart_http.image_url is image_url

    persistence = Path(cart_persistence.__file__).read_text(encoding="utf-8").lower()
    for view in ("product_availability", "product_effective_price", "product_images"):
        assert view not in persistence  # la consulta vive solo en shared/


def test_catalog_delegates_to_the_shared_image_url_with_no_logic_of_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Decisión del Leader (T-066): `_image_url` de catalog es un envoltorio de una línea.
    assert catalog_http.image_url is image_url
    settings = Settings(_env_file=None, storage_public_url="https://cdn.valmont.test/")
    monkeypatch.setattr(catalog_http, "get_settings", lambda: settings)
    path = "heritage/frente 1.jpg"

    assert catalog_http._image_url(path) == image_url(path, settings)
    source = Path(catalog_http.__file__).read_text(encoding="utf-8")
    assert "storage/v1/object" not in source and "quote(" not in source


def test_the_public_storage_url_is_built_in_exactly_one_place() -> None:
    owners = [
        path.relative_to(SRC).as_posix()
        for path in SRC.rglob("*.py")
        if "storage/v1/object/public" in path.read_text(encoding="utf-8")
        and "storage.py" not in path.name  # el adaptador de subida usa otra ruta (object/<bucket>)
    ]

    assert owners == ["shared/product_snapshots.py"]


# ---------------------------------------------------------------------------------------------
# image_url: mismo comportamiento que las dos copias anteriores.
@pytest.mark.parametrize(
    ("values", "base"),
    [
        ({"storage_public_url": "https://cdn.valmont.test/"}, "https://cdn.valmont.test"),
        ({"supabase_url": "http://127.0.0.1:54321/"}, "http://127.0.0.1:54321"),
        (
            {"storage_public_url": "https://cdn.valmont.test", "supabase_url": "http://interno"},
            "https://cdn.valmont.test",
        ),
    ],
)
def test_image_url_prefers_the_public_storage_url_over_supabase_url(
    monkeypatch: pytest.MonkeyPatch, values: dict[str, str], base: str
) -> None:
    use_settings(monkeypatch, **values)

    assert image_url("heritage/a.jpg") == f"{base}{PUBLIC_PATH}heritage/a.jpg"


def test_image_url_percent_encodes_the_path_but_keeps_its_slashes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_settings(monkeypatch, supabase_url="http://127.0.0.1:54321")

    assert image_url("a b/ñ?#.jpg") == f"http://127.0.0.1:54321{PUBLIC_PATH}a%20b/%C3%B1%3F%23.jpg"


def test_image_url_uses_the_settings_it_is_given_instead_of_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_settings(monkeypatch, supabase_url="http://entorno")
    given = Settings(_env_file=None, supabase_url="http://dada")

    assert image_url("a.jpg", given) == f"http://dada{PUBLIC_PATH}a.jpg"


def test_image_url_without_any_base_is_a_configuration_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use_settings(monkeypatch)

    with pytest.raises(RuntimeError, match="STORAGE_PUBLIC_URL"):
        image_url("a.jpg")
    with pytest.raises(RuntimeError, match="SUPABASE_URL"):
        image_url("a.jpg", Settings(_env_file=None))


# ---------------------------------------------------------------------------------------------
# Lector directo (el resto de garantías: tests/cart/test_catalog_reader.py, por el alias).
@pytest.fixture
def reader(db_session: Session) -> SqlProductSnapshots:
    return SqlProductSnapshots(db_session)


@pytest.mark.integration
def test_the_shared_reader_returns_published_snapshots_in_one_select(
    db_session: Session, reader: SqlProductSnapshots
) -> None:
    live = add_listed(
        db_session, price=250000, on_hand=7, name="Heritage 38", image=("p/a.jpg", "A")
    )
    other = add_listed(db_session, policy="made_to_order")
    draft = add_listed(db_session, status="draft", on_hand=3)
    sku, slug, _ = identity_of(db_session, live)

    with captured(db_session) as statements:
        found = reader.get_published([live, other, draft, uuid4(), live])

    assert len(statements) == 1 and statements[0].lstrip().upper().startswith("SELECT")
    assert set(found) == {live, other}
    snap = found[live]
    assert isinstance(snap, ProductSnapshot) and isinstance(snap.product_id, UUID)
    assert (snap.sku, snap.slug, snap.name) == (sku, slug, "Heritage 38")
    assert (snap.price, snap.available, snap.availability_status) == (250000, 7, "in_stock")
    assert (snap.image_path, snap.alt) == ("p/a.jpg", "A")
    assert found[other].availability_status == "on_request"


@pytest.mark.integration
def test_the_shared_reader_get_names_covers_unpublished_and_empty_asks_do_not_query(
    db_session: Session, reader: SqlProductSnapshots
) -> None:
    draft = add_listed(db_session, status="draft", name="Reloj retirado")
    _, slug, _ = identity_of(db_session, draft)

    with captured(db_session) as statements:
        assert reader.get_published([]) == {} and reader.get_names([]) == {}
    assert statements == []

    assert reader.get_names([draft, uuid4()]) == {draft: ("Reloj retirado", slug)}
