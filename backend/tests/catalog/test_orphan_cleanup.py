"""T-018f: limpieza de archivos huérfanos de Storage (D-047 D-H4). Borra archivos: a fondo.

Capas, de menos a más real:
  - `find_orphan_files` y `CleanupOrphanImages` con fakes (unitarias);
  - `SupabaseImageStorage.list_files` con `httpx.MockTransport`;
  - el script `python -m valmont.scripts.cleanup_orphan_images` como proceso, contra un Storage
    falso por HTTP y una BD temporal propia (ninguna prueba toca el bucket `products` real);
  - integración: Storage local real en un bucket propio `t018f-test-*` que crea y borra la suite
    (nunca se borra nada que no haya subido ella) y la lectura de rutas de la BD de pruebas.
"""

import json
import logging
import os
import random
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import make_category, make_product, tiny_png
from tests.conftest import _temporary_database
from valmont.modules.catalog.adapters.persistence import (
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.adapters.storage import SupabaseImageStorage
from valmont.modules.catalog.application import (
    MAX_ORPHAN_DELETIONS,
    ORPHAN_GRACE,
    CleanupOrphanImages,
    OrphanLimitExceeded,
    OrphanReport,
    StorageUnavailable,
    StoredFile,
    find_orphan_files,
)
from valmont.modules.catalog.domain import ProductImage
from valmont.shared.config import get_settings

NOW = datetime(2026, 11, 27, 12, 0, tzinfo=UTC)
OLD = timedelta(days=3)
BACKEND = Path(__file__).resolve().parents[2]
FAKE_KEY = "clave-ficticia-de-t018f"


def stored(path: str, age: timedelta = OLD) -> StoredFile:
    return StoredFile(path, NOW - age)


def paths(files: list[StoredFile]) -> set[str]:
    return {f.path for f in files}


# ---------------------------------------------------------------------------------------------
# find_orphan_files: tabla
# ---------------------------------------------------------------------------------------------


def test_the_package_constants_are_24_hours_and_50_deletions() -> None:
    assert ORPHAN_GRACE == timedelta(hours=24)
    assert MAX_ORPHAN_DELETIONS == 50


@pytest.mark.parametrize(
    ("age", "referenced", "grace", "is_orphan"),
    [
        (OLD, True, ORPHAN_GRACE, False),  # referenciado, aunque viejo
        (OLD, False, ORPHAN_GRACE, True),  # huérfano viejo
        (timedelta(hours=1), False, ORPHAN_GRACE, False),  # huérfano joven: dentro de la gracia
        (timedelta(0), False, ORPHAN_GRACE, False),  # recién subido
        (timedelta(hours=-1), False, ORPHAN_GRACE, False),  # fecha futura (reloj desfasado)
        (ORPHAN_GRACE, False, ORPHAN_GRACE, False),  # límite exacto: created_at == now - grace
        (ORPHAN_GRACE + timedelta(microseconds=1), False, ORPHAN_GRACE, True),  # justo pasado
        (ORPHAN_GRACE - timedelta(microseconds=1), False, ORPHAN_GRACE, False),  # justo dentro
        (timedelta(microseconds=1), False, timedelta(0), True),  # grace=0: cualquier pasado
        (timedelta(0), False, timedelta(0), False),  # grace=0, mismo instante: no
        (timedelta(days=2), False, timedelta(days=3), False),  # gracia mayor protege
        (timedelta(days=2), True, timedelta(0), False),  # referenciado manda sobre grace=0
    ],
    ids=[
        "referenciado",
        "huerfano-viejo",
        "huerfano-joven",
        "recien-subido",
        "fecha-futura",
        "limite-exacto",
        "limite-mas-1us",
        "limite-menos-1us",
        "grace0-pasado",
        "grace0-ahora",
        "grace-mayor",
        "grace0-referenciado",
    ],
)
def test_find_orphan_files_table(
    age: timedelta, referenced: bool, grace: timedelta, is_orphan: bool
) -> None:
    file = stored("p/a.webp", age)

    found = find_orphan_files([file], {"p/a.webp"} if referenced else set(), NOW, grace)

    assert found == ([file] if is_orphan else [])


def test_find_orphan_files_default_grace_is_24_hours() -> None:
    young, old = (
        stored("p/young.webp", timedelta(hours=23)),
        stored("p/old.webp", timedelta(hours=25)),
    )

    assert find_orphan_files([young, old], set(), NOW) == [old]


def test_find_orphan_files_picks_only_the_old_unreferenced_in_a_mixed_list() -> None:
    files = [
        stored("p/ref-old.webp"),
        stored("p/orphan-old.webp"),
        stored("p/orphan-young.webp", timedelta(hours=2)),
        stored("q/other-old.webp", timedelta(days=30)),
    ]

    found = find_orphan_files(files, frozenset({"p/ref-old.webp"}), NOW)

    assert paths(found) == {"p/orphan-old.webp", "q/other-old.webp"}


@pytest.mark.parametrize(
    "reference",
    ["p/a.png", "P/A.WEBP", "p/a.webp ", "p/", "p", "a.webp", "/p/a.webp", "p/a.webp.bak"],
)
def test_a_reference_only_protects_the_exact_same_path(reference: str) -> None:
    # Coincidir por prefijo, mayúsculas, extensión o recorte protegería de más o de menos.
    assert paths(find_orphan_files([stored("p/a.webp")], {reference}, NOW)) == {"p/a.webp"}


def test_find_orphan_files_accepts_a_generator_and_does_not_mutate_its_inputs() -> None:
    files = [stored("p/a.webp"), stored("p/b.webp")]
    referenced = {"p/a.webp"}

    found = find_orphan_files((f for f in files), referenced, NOW)

    assert paths(found) == {"p/b.webp"}
    assert referenced == {"p/a.webp"}
    assert find_orphan_files([], set(), NOW) == []


def test_find_orphan_files_matches_an_independent_oracle_on_random_data() -> None:
    rng = random.Random(20261127)
    ages = [
        timedelta(0),
        timedelta(hours=1),
        ORPHAN_GRACE - timedelta(microseconds=1),
        ORPHAN_GRACE,
        ORPHAN_GRACE + timedelta(microseconds=1),
        timedelta(days=3),
        timedelta(days=400),
    ]
    files = [stored(f"{uuid4()}/{uuid4()}.webp", rng.choice(ages)) for _ in range(300)]
    referenced = {f.path for f in files if rng.random() < 0.4}

    found = find_orphan_files(files, referenced, NOW)

    expected = {
        f.path for f in files if f.path not in referenced and NOW - f.created_at > ORPHAN_GRACE
    }
    assert paths(found) == expected


# ---------------------------------------------------------------------------------------------
# CleanupOrphanImages con un Storage y una BD falsos que comparten un registro de eventos
# ---------------------------------------------------------------------------------------------


class Backend:
    """Hace de ImageInventory, ImagePathReader e ImageStorage a la vez, y anota el orden."""

    def __init__(self, files: list[StoredFile], referenced: set[str] | None = None) -> None:
        self.files = {f.path: f for f in files}
        self.referenced = set(referenced or ())
        self.events: list[str] = []
        self.deleted: list[str] = []
        self.fail_delete: set[str] = set()
        self.list_error: Exception | None = None
        self.read_error: Exception | None = None
        self.on_read: Callable[[Backend], None] | None = None

    def list_files(self) -> Iterator[StoredFile]:  # perezoso, como el adaptador real
        self.events.append("list:start")
        if self.list_error:
            raise self.list_error
        yield from list(self.files.values())
        self.events.append("list:end")

    def referenced_paths(self) -> set[str]:
        self.events.append("read")
        if self.read_error:
            raise self.read_error
        if self.on_read:
            self.on_read(self)
        return set(self.referenced)

    def put(self, path: str, data: bytes, content_type: str) -> None:
        raise AssertionError("la limpieza nunca sube archivos")

    def delete(self, path: str) -> None:
        self.events.append(f"delete:{path}")
        if path in self.fail_delete:
            raise StorageUnavailable
        self.deleted.append(path)
        self.files.pop(path, None)

    def case(self) -> CleanupOrphanImages:
        return CleanupOrphanImages(self, self, self, lambda: NOW)


def orphans(count: int, prefix: str = "o") -> list[StoredFile]:
    return [stored(f"{prefix}/{i}.webp") for i in range(count)]


def test_dry_run_is_the_default_and_never_deletes() -> None:
    backend = Backend(
        [stored("p/ref.webp"), stored("p/orphan.webp"), stored("p/young.webp", timedelta(hours=1))],
        {"p/ref.webp"},
    )

    report = backend.case()()  # sin argumentos: apply=False

    assert report == OrphanReport(scanned=3, orphans=("p/orphan.webp",), deleted=0, failed=0)
    assert not any(event.startswith("delete:") for event in backend.events)
    assert set(backend.files) == {"p/ref.webp", "p/orphan.webp", "p/young.webp"}


def test_dry_run_with_explicit_false_lists_every_candidate_and_changes_nothing() -> None:
    backend = Backend(orphans(5))

    report = backend.case()(apply=False)

    assert set(report.orphans) == {f"o/{i}.webp" for i in range(5)}
    assert (report.deleted, report.failed) == (0, 0)
    assert len(backend.files) == 5


def test_apply_deletes_only_the_old_files_without_a_row() -> None:
    backend = Backend(
        [
            stored("p/ref-old.webp"),
            stored("p/orphan-old.webp"),
            stored("q/orphan-old.webp", timedelta(days=9)),
            stored("p/orphan-young.webp", timedelta(hours=3)),
            stored("p/orphan-limit.webp", ORPHAN_GRACE),
        ],
        {"p/ref-old.webp"},
    )

    report = backend.case()(apply=True)

    assert sorted(backend.deleted) == ["p/orphan-old.webp", "q/orphan-old.webp"]
    assert set(backend.files) == {"p/ref-old.webp", "p/orphan-young.webp", "p/orphan-limit.webp"}
    assert (report.scanned, report.deleted, report.failed) == (5, 2, 0)
    assert sorted(report.orphans) == ["p/orphan-old.webp", "q/orphan-old.webp"]


def test_apply_with_nothing_orphaned_deletes_nothing() -> None:
    backend = Backend([stored("p/a.webp"), stored("p/b.webp")], {"p/a.webp", "p/b.webp"})

    report = backend.case()(apply=True)

    assert (report.orphans, report.deleted, report.failed) == ((), 0, 0)
    assert backend.deleted == []


def test_apply_with_an_empty_bucket_is_a_quiet_success() -> None:
    report = Backend([], {"p/a.webp"}).case()(apply=True)

    assert report == OrphanReport(scanned=0, orphans=(), deleted=0, failed=0)


def test_grace_argument_moves_the_protection_window() -> None:
    young = stored("p/young.webp", timedelta(hours=1))

    protected = Backend([young])
    protected.case()(apply=True, grace=timedelta(hours=2))
    assert protected.deleted == []

    expired = Backend([young])
    expired.case()(apply=True, grace=timedelta(0))
    assert expired.deleted == ["p/young.webp"]


def test_apply_never_deletes_a_referenced_path_nor_a_path_that_was_not_listed() -> None:
    rng = random.Random(7)
    ages = [timedelta(0), timedelta(hours=5), ORPHAN_GRACE, timedelta(days=2), timedelta(days=90)]
    files = [stored(f"{uuid4()}/{uuid4()}.webp", rng.choice(ages)) for _ in range(150)]
    referenced = {f.path for f in files if rng.random() < 0.5}
    backend = Backend(files, referenced)

    report = backend.case()(apply=True, max_deletions=1000)

    expected = {
        f.path for f in files if f.path not in referenced and NOW - f.created_at > ORPHAN_GRACE
    }
    assert set(backend.deleted) == expected
    assert not set(backend.deleted) & referenced
    assert set(backend.deleted) <= {f.path for f in files}
    assert report.deleted == len(expected)


# --- el tope (regla 3): más huérfanos que max_deletions → no se borra NADA y hay error --------


def test_more_orphans_than_the_default_limit_deletes_nothing_and_raises() -> None:
    backend = Backend(orphans(MAX_ORPHAN_DELETIONS + 1))

    with pytest.raises(OrphanLimitExceeded):
        backend.case()(apply=True)

    assert backend.deleted == []
    assert not any(event.startswith("delete:") for event in backend.events)
    assert len(backend.files) == MAX_ORPHAN_DELETIONS + 1


def test_exactly_the_limit_is_allowed_and_deletes_all_of_them() -> None:
    backend = Backend(orphans(MAX_ORPHAN_DELETIONS))

    report = backend.case()(apply=True)

    assert (report.deleted, report.failed) == (MAX_ORPHAN_DELETIONS, 0)
    assert backend.files == {}


@pytest.mark.parametrize(
    ("found", "limit", "raises"), [(3, 2, True), (2, 2, False), (1, 0, True), (0, 0, False)]
)
def test_custom_limit(found: int, limit: int, raises: bool) -> None:
    backend = Backend(orphans(found))

    if raises:
        with pytest.raises(OrphanLimitExceeded):
            backend.case()(apply=True, max_deletions=limit)
        assert backend.deleted == []
    else:
        assert backend.case()(apply=True, max_deletions=limit).deleted == found


def test_the_limit_counts_orphans_not_scanned_files() -> None:
    referenced = [stored(f"r/{i}.webp") for i in range(200)]
    backend = Backend([*referenced, *orphans(3)], {f.path for f in referenced})

    report = backend.case()(apply=True)

    assert report.deleted == 3 and report.scanned == 203
    assert len(backend.files) == 200


def test_young_files_do_not_count_towards_the_limit() -> None:
    young = [stored(f"y/{i}.webp", timedelta(hours=1)) for i in range(MAX_ORPHAN_DELETIONS + 10)]
    backend = Backend([*young, *orphans(2)])

    assert backend.case()(apply=True).deleted == 2
    assert len(backend.files) == MAX_ORPHAN_DELETIONS + 10


def test_a_suspiciously_empty_reference_set_over_a_full_bucket_deletes_nothing() -> None:
    # Si la BD "devolviera" cero rutas por un fallo, todo el bucket parecería huérfano.
    backend = Backend(orphans(MAX_ORPHAN_DELETIONS + 30))

    with pytest.raises(OrphanLimitExceeded):
        backend.case()(apply=True)

    assert backend.deleted == [] and len(backend.files) == MAX_ORPHAN_DELETIONS + 30


def test_the_limit_applies_before_any_deletion_not_midway() -> None:
    backend = Backend(orphans(4))

    with pytest.raises(OrphanLimitExceeded):
        backend.case()(apply=True, max_deletions=3)

    assert [e for e in backend.events if e.startswith("delete:")] == []


@pytest.mark.parametrize(
    "kwargs",
    [{"grace": timedelta(seconds=-1)}, {"max_deletions": -1}],
    ids=["gracia-negativa", "tope-negativo"],
)
def test_negative_grace_or_limit_is_a_value_error_before_listing_or_deleting(
    kwargs: dict[str, object],
) -> None:
    backend = Backend(orphans(3))

    with pytest.raises(ValueError):
        backend.case()(apply=True, **kwargs)  # type: ignore[arg-type]

    assert backend.events == [] and len(backend.files) == 3


# --- fallos ------------------------------------------------------------------------------------


def test_a_database_error_propagates_and_nothing_is_deleted() -> None:
    backend = Backend(orphans(3))
    backend.read_error = RuntimeError("la BD no responde")

    with pytest.raises(RuntimeError):
        backend.case()(apply=True)

    assert backend.deleted == [] and len(backend.files) == 3


def test_a_storage_listing_error_propagates_and_nothing_is_deleted() -> None:
    backend = Backend(orphans(3))
    backend.list_error = StorageUnavailable()

    with pytest.raises(StorageUnavailable):
        backend.case()(apply=True)

    assert backend.deleted == [] and len(backend.files) == 3


def test_a_failed_deletion_is_counted_and_the_rest_continue() -> None:
    backend = Backend([stored("p/a.webp"), stored("p/b.webp"), stored("p/c.webp")])
    backend.fail_delete = {"p/b.webp"}

    report = backend.case()(apply=True)

    assert (report.deleted, report.failed) == (2, 1)
    assert set(backend.files) == {"p/b.webp"}
    assert sorted(report.orphans) == ["p/a.webp", "p/b.webp", "p/c.webp"]
    # b se intentó entre a y c: el fallo no detuvo el bucle.
    assert backend.events.count("delete:p/c.webp") == 1


def test_every_deletion_failing_is_reported_without_raising() -> None:
    backend = Backend(orphans(3))
    backend.fail_delete = {f"o/{i}.webp" for i in range(3)}

    report = backend.case()(apply=True)

    assert (report.deleted, report.failed) == (0, 3)
    assert len(backend.files) == 3


# --- orden: primero el listado de archivos, después la BD --------------------------------------


def test_the_file_listing_is_fully_consumed_before_the_database_is_read() -> None:
    backend = Backend([stored("p/a.webp")], {"p/a.webp"})

    backend.case()()

    assert backend.events == ["list:start", "list:end", "read"]


def test_a_file_uploaded_between_listing_and_reading_is_never_deleted() -> None:
    backend = Backend([stored("p/old-orphan.webp")])

    def upload_meanwhile(
        b: Backend,
    ) -> None:  # llega después del listado y aún sin fila en el snapshot
        b.files["p/uploaded-meanwhile.webp"] = StoredFile(
            "p/uploaded-meanwhile.webp", NOW - timedelta(seconds=1)
        )

    backend.on_read = upload_meanwhile

    report = backend.case()(apply=True, grace=timedelta(0))  # incluso sin gracia

    assert backend.deleted == ["p/old-orphan.webp"]
    assert "p/uploaded-meanwhile.webp" in backend.files
    assert "p/uploaded-meanwhile.webp" not in report.orphans


def test_the_report_and_the_logs_only_carry_paths(caplog: pytest.LogCaptureFixture) -> None:
    backend = Backend([stored("p/a.webp"), stored("p/b.webp")])
    backend.fail_delete = {"p/b.webp"}

    with caplog.at_level(logging.DEBUG):
        report = backend.case()(apply=True)

    assert FAKE_KEY not in caplog.text
    assert all(isinstance(path, str) for path in report.orphans)


# ---------------------------------------------------------------------------------------------
# SupabaseImageStorage.list_files con httpx.MockTransport
# ---------------------------------------------------------------------------------------------

BASE = "http://supabase.test"


def iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class Tree:
    """Respuestas de /object/list con `limit` y `offset` reales; carpetas con `id` nulo."""

    def __init__(self) -> None:
        self.entries: dict[str, list[dict[str, object]]] = {}
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict[str, object]] = []

    def folder(self, name: str) -> None:
        self.entries.setdefault("", []).append({"name": name, "id": None, "created_at": None})
        self.entries.setdefault(name, [])

    def file(self, folder: str, name: str, created_at: datetime | None) -> None:
        entry = {"name": name, "id": str(uuid4()), "created_at": created_at and iso(created_at)}
        self.entries.setdefault(folder, []).append(entry)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert len(self.requests) < 500, "la paginación no avanza: bucle infinito"
        body = json.loads(request.content)
        self.bodies.append(body)
        prefix = str(body.get("prefix", "")).strip("/")
        limit, offset = int(body.get("limit", 100)), int(body.get("offset", 0))
        return httpx.Response(200, json=self.entries.get(prefix, [])[offset : offset + limit])

    def storage(self, bucket: str = "products") -> SupabaseImageStorage:
        return SupabaseImageStorage(BASE, FAKE_KEY, bucket, transport=httpx.MockTransport(self))


T1 = datetime(2026, 11, 20, 8, 30, 15, 123000, tzinfo=UTC)


def test_list_files_posts_to_the_bucket_list_endpoint_with_the_service_key() -> None:
    tree = Tree()
    tree.folder("prod-a")
    tree.file("prod-a", "img.webp", T1)

    assert [f.path for f in tree.storage().list_files()] == ["prod-a/img.webp"]

    first = tree.requests[0]
    assert (first.method, str(first.url)) == ("POST", f"{BASE}/storage/v1/object/list/products")
    assert first.headers["Authorization"] == f"Bearer {FAKE_KEY}"
    assert first.headers["apikey"] == FAKE_KEY
    assert tree.bodies[0].get("prefix", "") in ("", "/")  # primero la raíz


def test_list_files_uses_the_configured_bucket_only() -> None:
    tree = Tree()

    list(tree.storage("t018f-test-bucket").list_files())

    assert {str(r.url) for r in tree.requests} == {
        f"{BASE}/storage/v1/object/list/t018f-test-bucket"
    }


def test_list_files_walks_every_product_folder_and_parses_created_at_as_utc() -> None:
    tree = Tree()
    for folder in ("prod-a", "prod-b"):
        tree.folder(folder)
    tree.file("prod-a", "1.webp", T1)
    tree.file("prod-a", "2.png", T1 + timedelta(days=1))
    tree.file("prod-b", "3.jpg", T1 + timedelta(days=2))
    tree.folder("prod-vacia")

    files = list(tree.storage().list_files())

    assert {f.path: f.created_at for f in files} == {
        "prod-a/1.webp": T1,
        "prod-a/2.png": T1 + timedelta(days=1),
        "prod-b/3.jpg": T1 + timedelta(days=2),
    }
    assert all(
        f.created_at.tzinfo is not None and f.created_at.utcoffset() == timedelta(0) for f in files
    )
    assert all(isinstance(f, StoredFile) for f in files)


def test_list_files_ignores_entries_without_id_or_without_a_date() -> None:
    tree = Tree()
    tree.folder("prod-a")
    tree.entries["prod-a"] += [
        {"name": "subcarpeta", "id": None, "created_at": None},  # carpeta anidada
        {"name": "sin-id.webp", "id": None, "created_at": iso(T1)},
    ]
    tree.file("prod-a", "sin-fecha.webp", None)  # sin fecha no hay gracia segura
    tree.file("prod-a", "ok.webp", T1)

    assert [f.path for f in tree.storage().list_files()] == ["prod-a/ok.webp"]


def test_list_files_paginates_a_folder_with_hundreds_of_files() -> None:
    tree = Tree()
    tree.folder("prod-a")
    for n in range(257):
        tree.file("prod-a", f"{n}.webp", T1)

    files = [f.path for f in tree.storage().list_files()]

    assert len(files) == len(set(files)) == 257


def test_list_files_paginates_the_root_folder_list_too() -> None:
    tree = Tree()
    for n in range(230):
        tree.folder(f"p{n}")
    tree.file("p229", "last.webp", T1)
    tree.file("p0", "first.webp", T1)

    assert {f.path for f in tree.storage().list_files()} == {"p229/last.webp", "p0/first.webp"}


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text=f"fallo interno {FAKE_KEY}"),
        httpx.Response(403, json={"error": "Unauthorized"}),
        httpx.Response(302, headers={"Location": "http://otro.test/"}),
    ],
    ids=["500", "403", "redireccion"],
)
def test_list_files_failures_are_storage_unavailable_without_leaking_the_key(
    response: httpx.Response, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return response

    storage = SupabaseImageStorage(BASE, FAKE_KEY, transport=httpx.MockTransport(handler))

    with caplog.at_level(logging.DEBUG), pytest.raises(StorageUnavailable):
        list(storage.list_files())

    assert len(seen) == 1  # una redirección no se sigue
    assert FAKE_KEY not in caplog.text


def test_list_files_network_error_is_storage_unavailable() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"sin conexión ({FAKE_KEY})", request=request)

    storage = SupabaseImageStorage(BASE, FAKE_KEY, transport=httpx.MockTransport(fail))

    with pytest.raises(StorageUnavailable):
        list(storage.list_files())


def test_list_files_failing_midway_raises_instead_of_returning_a_partial_listing() -> None:
    tree = Tree()
    tree.folder("prod-a")
    tree.file("prod-a", "1.webp", T1)

    def flaky(request: httpx.Request) -> httpx.Response:
        if len(tree.requests) >= 1:  # la raíz responde; la carpeta falla
            return httpx.Response(500)
        return tree(request)

    storage = SupabaseImageStorage(BASE, FAKE_KEY, transport=httpx.MockTransport(flaky))

    with pytest.raises(StorageUnavailable):
        list(storage.list_files())


def test_list_files_never_sends_a_delete_or_an_upload() -> None:
    tree = Tree()
    tree.folder("prod-a")
    tree.file("prod-a", "1.webp", T1)

    list(tree.storage().list_files())

    assert {r.method for r in tree.requests} == {"POST"}
    assert all("/object/list/" in str(r.url) for r in tree.requests)


# ---------------------------------------------------------------------------------------------
# El script como proceso: Storage falso por HTTP, BD temporal propia, entorno controlado
# ---------------------------------------------------------------------------------------------


class FakeStorage:
    """Storage HTTP falso: lista (con paginación) y borra, y anota toda petición."""

    def __init__(self) -> None:
        self.tree: dict[str, dict[str, datetime]] = {}
        self.requests: list[tuple[str, str]] = []
        self.list_status = 200
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:  # silencio
                pass

            def _reply(self, status: int, payload: object) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                owner.requests.append(("POST", self.path))
                if self.path != "/storage/v1/object/list/products":
                    return self._reply(404, {"error": "bucket ajeno"})
                if owner.list_status != 200:
                    return self._reply(owner.list_status, {"error": "fallo"})
                prefix = str(body.get("prefix", "")).strip("/")
                if prefix == "":
                    entries = [{"name": n, "id": None, "created_at": None} for n in owner.tree]
                else:
                    entries = [
                        {"name": n, "id": str(uuid4()), "created_at": iso(at)}
                        for n, at in owner.tree.get(prefix, {}).items()
                    ]
                limit, offset = int(body.get("limit", 100)), int(body.get("offset", 0))
                self._reply(200, entries[offset : offset + limit])

            def do_DELETE(self) -> None:
                owner.requests.append(("DELETE", unquote(self.path)))
                root = "/storage/v1/object/products/"
                if not self.path.startswith(root):
                    return self._reply(404, {"error": "bucket ajeno"})
                folder, _, name = unquote(self.path[len(root) :]).partition("/")
                owner.tree.get(folder, {}).pop(name, None)
                self._reply(200, {"message": "Successfully deleted"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def deleted(self) -> list[str]:
        return [path for method, path in self.requests if method == "DELETE"]

    def remaining(self) -> set[str]:
        return {f"{folder}/{name}" for folder, files in self.tree.items() for name in files}

    def put(self, path: str, age: timedelta = OLD) -> None:
        folder, _, name = path.partition("/")
        self.tree.setdefault(folder, {})[name] = (datetime.now(UTC) - age).replace(microsecond=0)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake_storage() -> Iterator[FakeStorage]:
    fake = FakeStorage()
    yield fake
    fake.close()


@pytest.fixture(scope="module")
def script_db() -> Iterator[dict[str, object]]:
    """BD temporal propia (nunca la de desarrollo) con un producto publicado y uno borrador."""
    with _temporary_database("orph") as config:
        url = str(config.attributes["database_url"])
        engine = create_engine(url)
        refs: dict[str, object] = {"url": url}
        with Session(engine) as session:
            category = make_category("Limpieza")
            SqlCategoryRepository(session).add(category)
            repo = SqlProductRepository(session)
            published = make_product(category, "Publicado limpieza", days=1)
            draft = make_product(category, "Borrador limpieza", days=None)
            for key, product in (("published", published), ("draft", draft)):
                repo.add(product)
                path = f"{product.id}/{uuid4()}.webp"
                repo.add_image(ProductImage(uuid4(), product.id, path, "Vista", 0))
                refs[key] = path
            session.commit()
        engine.dispose()
        yield refs


def run_script(
    db_url: str, storage_url: str, *args: str, environment: str = "dev"
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "DATABASE_URL": db_url,
        "SUPABASE_URL": storage_url,
        "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY,
        "ENVIRONMENT": environment,
    }
    return subprocess.run(
        [sys.executable, "-m", "valmont.scripts.cleanup_orphan_images", *args],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )


def populate(fake: FakeStorage, refs: dict[str, object]) -> dict[str, str]:
    """Referenciados (publicado y borrador), huérfano viejo en producto con y sin fila, joven."""
    published, draft = str(refs["published"]), str(refs["draft"])
    names = {
        "old_orphan": f"{published.split('/')[0]}/{uuid4()}.webp",
        "stray": f"{uuid4()}/{uuid4()}.webp",  # carpeta de un producto que no existe
        "young_orphan": f"{draft.split('/')[0]}/{uuid4()}.webp",
    }
    fake.put(published)
    fake.put(draft)
    fake.put(names["old_orphan"])
    fake.put(names["stray"], timedelta(days=40))
    fake.put(names["young_orphan"], timedelta(hours=2))
    return names


def test_script_dry_run_by_default_lists_candidates_and_deletes_nothing(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    names = populate(fake_storage, script_db)
    before = fake_storage.remaining()

    result = run_script(str(script_db["url"]), fake_storage.url)

    assert result.returncode == 0, result.stderr
    assert fake_storage.deleted == []
    assert fake_storage.remaining() == before
    assert names["old_orphan"] in result.stdout and names["stray"] in result.stdout
    for protected in (names["young_orphan"], str(script_db["published"]), str(script_db["draft"])):
        assert protected not in result.stdout
    assert FAKE_KEY not in result.stdout + result.stderr


def test_script_apply_deletes_only_old_orphans_and_only_in_the_products_bucket(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    names = populate(fake_storage, script_db)

    result = run_script(str(script_db["url"]), fake_storage.url, "--apply")

    assert result.returncode == 0, result.stderr
    assert sorted(fake_storage.deleted) == sorted(
        f"/storage/v1/object/products/{names[k]}" for k in ("old_orphan", "stray")
    )
    # El producto despublicado (borrador) conserva su imagen; el joven, también.
    assert fake_storage.remaining() == {
        str(script_db["published"]),
        str(script_db["draft"]),
        names["young_orphan"],
    }
    allowed = ("/storage/v1/object/list/products", "/storage/v1/object/products/")
    assert all(path.startswith(allowed) for _, path in fake_storage.requests)
    assert FAKE_KEY not in result.stdout + result.stderr


def test_script_grace_hours_zero_includes_the_young_but_never_the_referenced(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    names = populate(fake_storage, script_db)

    result = run_script(str(script_db["url"]), fake_storage.url, "--apply", "--grace-hours", "0")

    assert result.returncode == 0, result.stderr
    assert fake_storage.remaining() == {str(script_db["published"]), str(script_db["draft"])}
    assert f"/storage/v1/object/products/{names['young_orphan']}" in fake_storage.deleted


def test_script_over_the_limit_exits_with_2_and_deletes_nothing(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    populate(fake_storage, script_db)  # 2 huérfanos viejos
    before = fake_storage.remaining()

    result = run_script(str(script_db["url"]), fake_storage.url, "--apply", "--max-deletions", "1")

    assert result.returncode == 2
    assert fake_storage.deleted == []
    assert fake_storage.remaining() == before


def test_script_with_a_whole_bucket_that_looks_orphaned_deletes_nothing(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    # Equivale a una BD que "no devuelve" referencias: 51 huérfanos viejos con el tope por defecto.
    for n in range(MAX_ORPHAN_DELETIONS + 1):
        fake_storage.put(f"{uuid4()}/{n}.webp")
    before = fake_storage.remaining()

    result = run_script(str(script_db["url"]), fake_storage.url, "--apply")

    assert result.returncode == 2
    assert fake_storage.deleted == [] and fake_storage.remaining() == before


def test_script_storage_error_exits_nonzero_and_deletes_nothing(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    populate(fake_storage, script_db)
    fake_storage.list_status = 500

    result = run_script(str(script_db["url"]), fake_storage.url, "--apply")

    assert result.returncode != 0
    assert fake_storage.deleted == []
    assert FAKE_KEY not in result.stdout + result.stderr


def test_script_with_storage_unreachable_exits_nonzero(script_db: dict[str, object]) -> None:
    dead = FakeStorage()
    url = dead.url
    dead.close()  # el puerto ya no escucha

    result = run_script(str(script_db["url"]), url, "--apply")

    assert result.returncode != 0
    assert FAKE_KEY not in result.stdout + result.stderr


def test_script_database_error_exits_nonzero_and_deletes_nothing(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    populate(fake_storage, script_db)
    # connect_timeout: sin él, psycopg espera más de un minuto a un puerto sin servidor en Windows.
    bad_db = "postgresql+psycopg://nadie@127.0.0.1:1/ninguna?connect_timeout=3"

    result = run_script(bad_db, fake_storage.url, "--apply")

    assert result.returncode != 0
    assert fake_storage.deleted == []
    assert "Traceback" not in result.stdout


@pytest.mark.parametrize(
    "args",
    [
        ["--apply", "--grace-hours", "abc"],
        ["--apply", "--max-deletions", "x"],
        ["--apply", "--no-existe"],
        ["--apply", "--grace-hours", "-1"],  # una gracia negativa borraría hasta lo recién subido
        ["--apply", "--max-deletions", "-1"],
    ],
    ids=[
        "gracia-no-numerica",
        "tope-no-numerico",
        "opcion-desconocida",
        "gracia-negativa",
        "tope-negativo",
    ],
)
def test_script_invalid_arguments_never_delete(
    script_db: dict[str, object], fake_storage: FakeStorage, args: list[str]
) -> None:
    names = populate(fake_storage, script_db)

    result = run_script(str(script_db["url"]), fake_storage.url, *args)

    assert result.returncode == 2  # argparse: argumento inválido
    assert fake_storage.requests == []  # ni siquiera listó
    assert names["young_orphan"] in fake_storage.remaining()


def test_script_does_not_refuse_prod_but_still_never_deletes_without_apply(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    populate(fake_storage, script_db)
    before = fake_storage.remaining()

    result = run_script(str(script_db["url"]), fake_storage.url, environment="prod")

    assert result.returncode == 0, result.stderr
    assert fake_storage.deleted == [] and fake_storage.remaining() == before


def test_script_json_report_is_one_line_with_paths_only(
    script_db: dict[str, object], fake_storage: FakeStorage
) -> None:
    names = populate(fake_storage, script_db)

    result = run_script(str(script_db["url"]), fake_storage.url, "--json")

    assert result.returncode == 0, result.stderr
    [line] = result.stdout.strip().splitlines()
    report = json.loads(line)
    assert (report["mode"], report["scanned"], report["deleted"], report["failed"]) == (
        "dry-run",
        5,
        0,
        0,
    )
    assert sorted(report["orphans"]) == sorted([names["old_orphan"], names["stray"]])


# ---------------------------------------------------------------------------------------------
# Integración: BD de pruebas y Storage local real (bucket propio)
# ---------------------------------------------------------------------------------------------


@pytest.mark.integration
def test_referenced_paths_returns_every_storage_path_whatever_the_product_status(
    db_session: Session,
) -> None:
    category = make_category("Rutas")
    SqlCategoryRepository(db_session).add(category)
    repo = SqlProductRepository(db_session)
    published = make_product(category, "Publicado rutas", days=1)
    draft = make_product(category, "Borrador rutas", days=None)
    unpublished = make_product(category, "Despublicado rutas", days=2)
    expected: set[str] = set()
    for product in (published, draft, unpublished):
        repo.add(product)
        for position in range(2):
            path = f"{product.id}/{uuid4()}.webp"
            repo.add_image(ProductImage(uuid4(), product.id, path, "Vista", position))
            expected.add(path)
    repo.add(make_product(category, "Sin imagenes rutas", days=3))
    db_session.execute(  # despublicar: el producto vuelve a borrador, sus imágenes siguen vivas
        text("UPDATE app.products SET status='draft' WHERE id = :id"),
        {"id": unpublished.id},
    )

    referenced = repo.referenced_paths()

    assert isinstance(referenced, set)
    assert expected <= referenced
    assert all(isinstance(path, str) for path in referenced)


@pytest.mark.integration
def test_cleanup_with_the_real_repository_keeps_every_referenced_image(
    db_session: Session,
) -> None:
    category = make_category("Limpieza real")
    SqlCategoryRepository(db_session).add(category)
    repo = SqlProductRepository(db_session)
    kept: list[str] = []
    for name, days in (("Publicado real", 1), ("Borrador real", None)):
        product = make_product(category, name, days=days)
        repo.add(product)
        path = f"{product.id}/{uuid4()}.webp"
        repo.add_image(ProductImage(uuid4(), product.id, path, "Vista", 0))
        kept.append(path)
    backend = Backend([stored(p, timedelta(days=30)) for p in kept] + [stored("x/huerfano.webp")])
    case = CleanupOrphanImages(backend, repo, backend, lambda: NOW)

    report = case(apply=True)

    assert backend.deleted == ["x/huerfano.webp"]
    assert set(kept) <= set(backend.files)
    assert report.deleted == 1


TEST_BUCKET_PREFIX = "t018f-test-"


@pytest.fixture
def bucket_factory() -> Iterator[Callable[[], SupabaseImageStorage]]:
    """Crea buckets `t018f-test-*` propios y, al final, vacía y borra solo esos."""
    settings = get_settings()
    key = settings.supabase_service_role_key
    if not (settings.supabase_url and key):
        pytest.fail("Falta SUPABASE_URL o la clave de servicio. Arranca Supabase: npm run db:start")
    base = f"{settings.supabase_url.rstrip('/')}/storage/v1"
    headers = {"Authorization": f"Bearer {key.get_secret_value()}"}
    created: list[SupabaseImageStorage] = []
    names: list[str] = []

    def make() -> SupabaseImageStorage:
        name = f"{TEST_BUCKET_PREFIX}{uuid4().hex[:8]}"
        response = httpx.post(
            f"{base}/bucket", headers=headers, json={"id": name, "name": name, "public": False}
        )
        assert response.status_code == 200, "no se pudo crear el bucket de pruebas"
        names.append(name)
        storage = SupabaseImageStorage(
            settings.supabase_url or "", key.get_secret_value(), bucket=name
        )
        created.append(storage)
        return storage

    yield make

    for name, storage in zip(names, created, strict=True):
        assert name.startswith(TEST_BUCKET_PREFIX) and name != "products"
        for file in list(storage.list_files()):  # solo NUESTRO bucket; lista entera antes de borrar
            storage.delete(file.path)
        httpx.delete(f"{base}/bucket/{name}", headers=headers)


def upload(storage: SupabaseImageStorage, folder: str, count: int = 1) -> list[str]:
    uploaded = [f"{folder}/{uuid4()}.png" for _ in range(count)]
    for path in uploaded:
        storage.put(path, tiny_png(), "image/png")
    return uploaded


@pytest.mark.integration
def test_real_storage_lists_folders_with_paths_and_utc_dates(
    bucket_factory: Callable[[], SupabaseImageStorage],
) -> None:
    storage = bucket_factory()
    before = datetime.now(UTC)
    expected = {*upload(storage, str(uuid4()), 2), *upload(storage, str(uuid4()))}

    files = list(storage.list_files())

    assert {f.path for f in files} == expected
    for f in files:  # Storage corre en Docker: se tolera un desfase de reloj de minutos
        assert f.created_at.tzinfo is not None
        assert (
            before - timedelta(minutes=10)
            <= f.created_at
            <= datetime.now(UTC) + timedelta(minutes=10)
        )


@pytest.mark.integration
def test_real_storage_listing_paginates_past_one_page(
    bucket_factory: Callable[[], SupabaseImageStorage],
) -> None:
    storage = bucket_factory()
    expected = set(upload(storage, str(uuid4()), 105))  # más que los 100 de una página

    assert {f.path for f in storage.list_files()} == expected


@pytest.mark.integration
def test_real_storage_dry_run_changes_nothing_and_apply_deletes_only_unreferenced_old_files(
    bucket_factory: Callable[[], SupabaseImageStorage],
) -> None:
    storage = bucket_factory()
    folder = str(uuid4())
    keep, orphan_a, orphan_b = upload(storage, folder, 3)
    later = lambda: datetime.now(UTC) + timedelta(minutes=30)  # noqa: E731  (grace=0, sin depender del reloj)

    def case(reader_paths: set[str]) -> CleanupOrphanImages:
        reader = Backend([], reader_paths)
        return CleanupOrphanImages(storage, reader, storage, later)

    dry = case({keep})(apply=False, grace=timedelta(0))
    assert sorted(dry.orphans) == sorted([orphan_a, orphan_b]) and dry.deleted == 0
    assert {f.path for f in storage.list_files()} == {keep, orphan_a, orphan_b}

    applied = case({keep})(apply=True, grace=timedelta(0))
    assert (applied.deleted, applied.failed) == (2, 0)
    assert {f.path for f in storage.list_files()} == {keep}


@pytest.mark.integration
def test_real_storage_a_fresh_upload_is_protected_by_the_grace(
    bucket_factory: Callable[[], SupabaseImageStorage],
) -> None:
    storage = bucket_factory()
    fresh = upload(storage, str(uuid4()))
    case = CleanupOrphanImages(storage, Backend([], set()), storage, lambda: datetime.now(UTC))

    report = case(apply=True)  # gracia por defecto de 24 h

    assert report.orphans == () and report.deleted == 0
    assert {f.path for f in storage.list_files()} == set(fresh)


@pytest.mark.integration
def test_real_storage_never_touches_another_bucket_with_the_same_paths(
    bucket_factory: Callable[[], SupabaseImageStorage],
) -> None:
    mine, other = bucket_factory(), bucket_factory()
    path = f"{uuid4()}/{uuid4()}.png"
    for storage in (mine, other):
        storage.put(path, tiny_png(), "image/png")
    case = CleanupOrphanImages(
        mine, Backend([], set()), mine, lambda: datetime.now(UTC) + timedelta(minutes=30)
    )

    assert case(apply=True, grace=timedelta(0)).deleted == 1

    assert list(mine.list_files()) == []
    assert [f.path for f in other.list_files()] == [path]


@pytest.mark.integration
def test_real_storage_limit_protects_the_bucket(
    bucket_factory: Callable[[], SupabaseImageStorage],
) -> None:
    storage = bucket_factory()
    uploaded = set(upload(storage, str(uuid4()), 3))
    case = CleanupOrphanImages(
        storage, Backend([], set()), storage, lambda: datetime.now(UTC) + timedelta(minutes=30)
    )

    with pytest.raises(OrphanLimitExceeded):
        case(apply=True, grace=timedelta(0), max_deletions=2)

    assert {f.path for f in storage.list_files()} == uploaded
