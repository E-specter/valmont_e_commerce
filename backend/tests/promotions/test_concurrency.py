"""CA-PROMOTIONS-13 (R12): dos PATCH concurrentes sobre la misma promoción, cada uno en su propia
conexión y en hilos, contra valmont_test. Los datos se confirman, así que cada prueba borra al
final lo suyo. La auditoría es falsa: app.audit_log no admite DELETE y aquí no es el sujeto."""

import queue
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.promotions.promotions_helpers import add_category, add_product, add_promotion
from valmont.modules.promotions.adapters.persistence import SqlPromotionRepository
from valmont.modules.promotions.application import Actor, UpdatePromotion
from valmont.modules.promotions.domain import Promotion, PromotionScope

pytestmark = pytest.mark.integration

TIMEOUT = 10  # s; ninguna espera de estas pruebas debería acercarse
ACTOR = Actor(uuid4(), "admin")


class FakeAudit:
    def record(self, entry: object) -> None:
        pass


def in_transaction[T](engine: Engine, work: Callable[[Session], T]) -> T:
    """Una transacción en una conexión propia: commit si `work` termina, rollback si falla."""
    with Session(engine) as session, session.begin():
        return work(session)


def update(
    session: Session, promotion_id: UUID, **changes: object
) -> Promotion:  # el caso de uso real, con la fila bloqueada (R12)
    return UpdatePromotion(SqlPromotionRepository(session), FakeAudit())(
        promotion_id, changes, ACTOR
    )


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Callable[[], tuple[UUID, list[UUID], UUID]]]:
    """Crea y confirma una promoción `products` con dos productos; al final borra lo suyo."""
    made: list[tuple[UUID, list[UUID], UUID]] = []

    def create() -> tuple[UUID, list[UUID], UUID]:
        with Session(db_engine) as session, session.begin():
            category = add_category(session)
            products = [add_product(session, 100_000, category_id=category) for _ in range(4)]
            promotion = add_promotion(session, scope="products", product_ids=products[:2])
        made.append((promotion, products, category))
        return promotion, products, category

    yield create
    with Session(db_engine) as session, session.begin():
        for promotion, products, category in made:
            session.execute(
                text("DELETE FROM app.promotion_products WHERE promotion_id = :id"),
                {"id": promotion},
            )
            session.execute(text("DELETE FROM app.promotions WHERE id = :id"), {"id": promotion})
            session.execute(
                text("DELETE FROM app.products WHERE id = ANY(:ids)"), {"ids": products}
            )
            session.execute(text("DELETE FROM app.categories WHERE id = :id"), {"id": category})


def wait_until_blocked(engine: Engine, backend_pid: int) -> None:
    """Espera a que la conexión `backend_pid` esté esperando un bloqueo de otra transacción."""
    query = text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid")
    deadline = time.monotonic() + TIMEOUT
    with engine.connect() as connection:
        while time.monotonic() < deadline:
            waiting = connection.scalar(query, {"pid": backend_pid})
            connection.rollback()  # pg_stat_activity se congela dentro de una transacción
            if waiting == "Lock":
                return
            time.sleep(0.02)
    pytest.fail(f"La transacción {backend_pid} nunca llegó a esperar un bloqueo.")


def race(
    engine: Engine,
    first: Callable[[Session], object],
    second: Callable[[Session], object],
) -> None:
    """`first` edita y no confirma hasta que `second` está esperando el bloqueo de la fila: la
    carrera ocurre siempre. Gana al final el último en confirmar (`second`)."""
    first_done, first_may_commit = threading.Event(), threading.Event()
    second_pid: queue.Queue[int] = queue.Queue()

    def run_first(session: Session) -> None:
        first(session)
        first_done.set()
        assert first_may_commit.wait(TIMEOUT)

    def run_second(session: Session) -> None:
        second_pid.put(session.scalars(text("SELECT pg_backend_pid()")).one())
        second(session)

    with ThreadPoolExecutor(2) as pool:
        try:
            one = pool.submit(in_transaction, engine, run_first)
            assert first_done.wait(TIMEOUT)
            two = pool.submit(in_transaction, engine, run_second)
            wait_until_blocked(engine, second_pid.get(timeout=TIMEOUT))
        finally:
            first_may_commit.set()
        one.result(TIMEOUT)
        two.result(TIMEOUT)  # sin 500: el segundo espera, y luego aplica lo suyo


def state(engine: Engine, promotion_id: UUID) -> tuple[str, UUID | None, list[UUID], int]:
    with Session(engine) as session:
        row = session.execute(
            text("SELECT scope, category_id FROM app.promotions WHERE id = :id"),
            {"id": promotion_id},
        ).one()
        rows = session.scalars(
            text("SELECT product_id FROM app.promotion_products WHERE promotion_id = :id"),
            {"id": promotion_id},
        ).all()
        loaded = SqlPromotionRepository(session).get(promotion_id)
    assert loaded is not None
    assert sorted(loaded.product_ids) == sorted(rows)  # el dominio y las filas coinciden
    return row[0], row[1], sorted(rows), len(rows)


def test_two_patches_of_the_product_list_end_with_the_last_list_and_no_mixed_rows(
    db_engine: Engine, committed: Callable[[], tuple[UUID, list[UUID], UUID]]
) -> None:
    # CA-PROMOTIONS-13: la lista de la última transacción, sin filas mezcladas ni errores.
    promotion, products, _ = committed()
    a, b = [products[2], products[3]], [products[0], products[3]]

    race(
        db_engine,
        lambda s: update(s, promotion, product_ids=a),
        lambda s: update(s, promotion, product_ids=b),
    )

    scope, category, rows, count = state(db_engine, promotion)
    assert (scope, category, rows, count) == ("products", None, sorted(b), 2)


def test_a_scope_change_racing_a_product_list_change_ends_in_one_coherent_state(
    db_engine: Engine, committed: Callable[[], tuple[UUID, list[UUID], UUID]]
) -> None:
    # CA-PROMOTIONS-13 (alcance): products→catalog (descarta la lista) y después otra lista:
    # el PATCH que espera bloquea con la fila ya cambiada; el resultado es el de la segunda
    # transacción, que reinterpreta el estado actual (R14) y fija `products` con su lista.
    promotion, products, _ = committed()
    new_list = [products[2], products[3]]

    race(
        db_engine,
        lambda s: update(s, promotion, scope=PromotionScope.CATALOG),
        lambda s: update(s, promotion, scope=PromotionScope.PRODUCTS, product_ids=new_list),
    )

    assert state(db_engine, promotion) == ("products", None, sorted(new_list), 2)


def test_a_category_change_racing_a_scope_change_leaves_no_stale_products(
    db_engine: Engine, committed: Callable[[], tuple[UUID, list[UUID], UUID]]
) -> None:
    # La primera pasa a `category`; la segunda, a `catalog`: queda `catalog`, sin categoría
    # ni filas de productos (la FK compuesta de la BD impide las filas con otro alcance).
    promotion, _, category = committed()

    race(
        db_engine,
        lambda s: update(s, promotion, scope=PromotionScope.CATEGORY, category_id=category),
        lambda s: update(s, promotion, scope=PromotionScope.CATALOG),
    )

    assert state(db_engine, promotion) == ("catalog", None, [], 0)
