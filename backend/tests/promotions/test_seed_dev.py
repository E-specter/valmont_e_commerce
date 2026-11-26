"""Semilla de demostración de promotions (T-052): dos promociones, idempotente y sin prod."""

from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import InMemoryStorage
from tests.catalog.test_admin_http import Untouchable
from valmont.scripts import seed_dev
from valmont.shared.config import Settings

DEMO = text(
    "SELECT p.id, p.name, p.kind, p.percent_off, p.amount_off_cents, p.scope, p.category_id,"
    " p.is_active, p.starts_at <= now() AND now() < p.ends_at AS in_force,"
    " p.ends_at - now() AS remaining,"
    " (SELECT array_agg(pp.product_id) FROM app.promotion_products pp WHERE pp.promotion_id = p.id)"
    " FROM app.promotions p WHERE p.name LIKE 'Demo:%' ORDER BY p.kind"
)
AUDITED = text(
    "SELECT count(*) FROM app.audit_log a JOIN app.promotions p ON a.entity_id = p.id::text"
    " WHERE a.entity_type = 'promotion' AND a.action = 'promotions.promotion_created'"
    " AND a.actor_id IS NULL AND p.name LIKE 'Demo:%'"
)
TOTAL = text("SELECT count(*) FROM app.promotions")


def demo_rows(session: Session) -> list[Any]:
    return list(session.execute(DEMO))


def test_refuses_to_run_in_prod_without_touching_the_database_or_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # La semilla de promociones cuelga de seed_dev: en prod no se escribe nada.
    monkeypatch.setattr(
        seed_dev, "get_settings", lambda: Settings(_env_file=None, environment="prod")
    )
    monkeypatch.setattr(seed_dev, "get_engine", Untouchable)
    monkeypatch.setattr(seed_dev, "get_image_storage", Untouchable)

    with pytest.raises(SystemExit) as exit_:
        seed_dev.main()

    assert "prod" in str(exit_.value.code)


@pytest.mark.integration
def test_seed_creates_the_two_demo_promotions_once_with_a_system_audit(
    db_session: Session,
) -> None:
    storage = InMemoryStorage()
    before = db_session.scalar(TOTAL)

    first = seed_dev.seed(db_session, storage)
    after_first = db_session.scalar(TOTAL)
    second = seed_dev.seed(db_session, storage)

    # Idempotente por nombre: la segunda ejecución no crea nada ni vuelve a auditar.
    assert first["promociones"] == 2 and second["promociones"] == 0
    assert db_session.scalar(TOTAL) == after_first == before + 2
    rows = demo_rows(db_session)
    assert len(rows) == 2
    assert db_session.scalar(AUDITED) == 2  # creadas con CreatePromotion y actor del sistema


@pytest.mark.integration
def test_demo_promotions_are_a_percent_on_two_products_and_a_fixed_amount_on_a_category(
    db_session: Session,
) -> None:
    seed_dev.seed(db_session, InMemoryStorage())

    fixed, percent = demo_rows(db_session)  # ORDER BY kind: fixed_amount, percent

    assert (percent.kind, percent.percent_off, percent.amount_off_cents) == ("percent", 15, None)
    assert (percent.scope, percent.category_id) == ("products", None)
    assert len(percent[10]) == 2
    skus = set(
        db_session.scalars(
            text("SELECT sku FROM app.products WHERE id = ANY(:ids)"), {"ids": percent[10]}
        )
    )
    assert all(sku.startswith("DEMO-") for sku in skus) and len(skus) == 2
    assert (fixed.kind, fixed.percent_off, fixed.amount_off_cents) == ("fixed_amount", None, 20000)
    assert (fixed.scope, fixed[10]) == ("category", None)
    slug = db_session.scalar(
        text("SELECT slug FROM app.categories WHERE id = :id"), {"id": fixed.category_id}
    )
    assert slug in {c["slug"] for c in seed_dev.CATEGORIES}
    # Vigentes desde hoy durante varias semanas (R3).
    for row in (fixed, percent):
        assert row.is_active and row.in_force
        assert row.remaining.days >= 21


@pytest.mark.integration
def test_demo_promotions_show_both_kinds_and_the_best_final_price_wins(
    db_session: Session,
) -> None:
    # CA-PROMOTIONS-18 con los datos de la semilla: en cada producto cubierto gana la promoción
    # que deja el menor precio final (R5), y se ven los dos tipos.
    seed_dev.seed(db_session, InMemoryStorage())
    fixed, percent = demo_rows(db_session)
    rows = db_session.execute(
        text(
            "SELECT v.product_id, v.list_price_cents, v.effective_price_cents, v.promotion_id,"
            " p.category_id FROM app.product_effective_price v JOIN app.products p"
            " ON p.id = v.product_id WHERE p.sku LIKE 'DEMO-%'"
        )
    ).all()

    winners = set()
    covered = 0
    for product_id, listed, price, promotion_id, category_id in rows:
        candidates = {}
        if product_id in percent[10]:
            candidates[percent.id] = listed - (listed * 15 + 50) // 100
        if category_id == fixed.category_id:
            candidates[fixed.id] = listed - min(20000, listed - 1)
        if not candidates:
            assert (price, promotion_id) == (listed, None)
            continue
        covered += 1
        assert price == min(candidates.values()) < listed
        assert candidates[promotion_id] == price
        winners.add(promotion_id)
    assert covered >= 3 and winners == {fixed.id, percent.id}
