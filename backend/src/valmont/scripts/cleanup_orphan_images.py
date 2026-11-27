"""Limpieza de archivos huérfanos del bucket products (T-018f, D-047 D-H4).

    uv run python -m valmont.scripts.cleanup_orphan_images [--apply] [--grace-hours N]
        [--max-deletions N] [--json]

Sin --apply solo informa. Borra los archivos sin fila en app.product_images y más viejos que la
gracia. Para el temporizador: --json imprime una línea con el informe; salida 0 = correcto,
1 = Storage no responde o algún borrado falló, 2 = más huérfanos que el tope (no se borra nada).
Solo imprime rutas (UUID): ni claves ni datos personales.
"""

import argparse
import json
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from valmont.modules.catalog.adapters.admin_http import get_image_storage
from valmont.modules.catalog.adapters.persistence import SqlProductRepository
from valmont.modules.catalog.adapters.storage import SupabaseImageStorage
from valmont.modules.catalog.application import (
    MAX_ORPHAN_DELETIONS,
    ORPHAN_GRACE,
    CleanupOrphanImages,
    OrphanLimitExceeded,
    StorageUnavailable,
)
from valmont.shared.db import get_engine

EXIT_OK, EXIT_FAILED, EXIT_LIMIT = 0, 1, 2


def _non_negative(kind: Callable[[str], float]) -> Callable[[str], float]:
    def parse(text: str) -> float:
        value = kind(text)
        if value < 0:
            raise argparse.ArgumentTypeError("no puede ser negativo")  # argparse sale con 2
        return value

    return parse


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="borra de verdad (por defecto, no)")
    parser.add_argument(
        "--grace-hours", type=_non_negative(float), default=ORPHAN_GRACE.total_seconds() / 3600
    )
    parser.add_argument("--max-deletions", type=_non_negative(int), default=MAX_ORPHAN_DELETIONS)
    parser.add_argument("--json", action="store_true", help="informe en una línea JSON")
    args = parser.parse_args(argv)

    storage = get_image_storage()
    assert isinstance(storage, SupabaseImageStorage)  # el compositor real lista y borra
    try:
        with Session(get_engine()) as session:
            cleanup = CleanupOrphanImages(
                storage, SqlProductRepository(session), storage, lambda: datetime.now(UTC)
            )
            report = cleanup(
                apply=args.apply,
                grace=timedelta(hours=args.grace_hours),
                max_deletions=args.max_deletions,
            )
    except OrphanLimitExceeded as exc:
        print(f"ERROR: {exc}. No se borró nada.", file=sys.stderr)
        return EXIT_LIMIT
    except StorageUnavailable:
        print("ERROR: Storage no responde.", file=sys.stderr)
        return EXIT_FAILED

    mode = "apply" if args.apply else "dry-run"
    if args.json:
        print(
            json.dumps(
                {
                    "mode": mode,
                    "scanned": report.scanned,
                    "orphans": report.orphans,
                    "deleted": report.deleted,
                    "failed": report.failed,
                }
            )
        )
    else:
        print(
            f"[{mode}] {report.scanned} archivos, {len(report.orphans)} huérfanos, "
            f"{report.deleted} borrados, {report.failed} fallos"
        )
        for path in report.orphans:
            print(f"  {path}")
    return EXIT_FAILED if report.failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
