"""`CreateOrder` y la mayoría de edad (T-139; CA-IDENTITY-15 y 16, IDENTITY-R13, D-045). Sin BD:
repositorios, carrito, inventario, reloj, boutique y auditoría falsos; `EnsureAdult` real sobre un
repositorio de perfiles en memoria, o un falso que anota sus llamadas.

Orden de UC-ORDERS-01 con la edad: reloj → repetición de clave (200, sin comprobar) → edad →
recojo no disponible → carrito → … Un 409 de edad no deja ningún efecto."""

import ast
import inspect
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from tests.identity.birth_date_helpers import BirthDateProfiles
from tests.orders.orders_age_helpers import ADULT_BIRTH, MINOR_BIRTH
from tests.orders.orders_create_helpers import (
    KEY,
    NOW,
    Harness,
    checkout_line,
    harness,
    run,
)
from tests.orders.orders_helpers import pickup_delivery
from valmont.modules.cart.application import EmptySelection
from valmont.modules.identity.application import BirthDateRequired, EnsureAdult, Underage
from valmont.modules.orders.application import CreateOrder
from valmont.modules.orders.domain import PickupUnavailable, TooManyPendingOrders

IDENTITY = "valmont.modules.identity"
USER = uuid4()
OTHER = uuid4()
WRITES = ("reserve", "add", "remove", "audit")
FLOW_WITH_AGE = ["find", "adult", "prepare", "count", "reserve", "add", "remove", "audit"]


class ExplodingProfiles(BirthDateProfiles):
    """Cualquier lectura del perfil falla: prueba que la edad NO se consultó."""

    def get(self, user_id: UUID) -> Any:
        raise AssertionError("se leyó el perfil: la edad no debía comprobarse")


def real_adult(birth_date: date | None, user: UUID = USER) -> EnsureAdult:
    """`EnsureAdult` real sobre un perfil en memoria con esa fecha (None: sin fecha)."""
    profiles = BirthDateProfiles()
    profiles.with_birth_date(user, birth_date)
    return EnsureAdult(profiles)  # type: ignore[arg-type]


def steps(h: Harness) -> list[str]:
    return [c for c in h.calls if c not in ("clock", "store")]


def untouched(h: Harness) -> None:
    """Un 409 de edad no toca nada: ni carrito, ni stock, ni pedido, ni auditoría."""
    assert not [c for c in h.calls if c in ("prepare", "count", "store", *WRITES)]
    assert h.orders.added == [] and h.remove.args == [] and h.reserve.args == []
    assert h.audit.entries == [] and h.prepare.args == []


def stored_order() -> Any:
    """Un pedido ya creado (con el flujo de un adulto), para sembrar la repetición de clave."""
    return run(harness(checkout_line()), USER).order


# --------------------------------------------------------------------------------------------
# Firma pública
def test_the_constructor_takes_adult_last_and_it_is_required() -> None:
    parameters = list(inspect.signature(CreateOrder.__init__).parameters.values())[1:]

    assert [p.name for p in parameters][-1] == "adult"
    assert parameters[-1].default is inspect.Parameter.empty
    assert len(parameters) == 8


def test_a_create_order_without_adult_cannot_be_built() -> None:
    with pytest.raises(TypeError):
        CreateOrder(*([object()] * 7))  # type: ignore[call-arg]


# --------------------------------------------------------------------------------------------
# CA-IDENTITY-15: sin fecha, menor y adulto
def test_an_adult_creates_the_order_and_the_flow_only_gains_the_age_step() -> None:
    h = harness(checkout_line(), checkout_line(), log_adult=True)

    result = run(h, USER)

    assert result.created is True
    assert steps(h) == FLOW_WITH_AGE


def test_an_adult_with_the_real_check_gets_the_same_order_as_without_it() -> None:
    plain = harness(checkout_line())
    checked = harness(checkout_line(), adult=real_adult(ADULT_BIRTH))

    before, after = run(plain, USER).order, run(checked, USER).order

    assert (after.status, after.total_amount, after.user_id, len(after.lines)) == (
        before.status,
        before.total_amount,
        before.user_id,
        len(before.lines),
    )
    assert [e.action for e in checked.audit.entries] == ["orders.created"]
    assert steps(checked) == steps(plain)


def test_without_a_birth_date_the_order_is_rejected_with_birth_date_required() -> None:
    h = harness(checkout_line(), adult=real_adult(None))

    with pytest.raises(BirthDateRequired):
        run(h, USER)

    untouched(h)


def test_a_minor_is_rejected_with_underage_and_nothing_is_touched() -> None:
    h = harness(checkout_line(), adult=real_adult(MINOR_BIRTH))

    with pytest.raises(Underage):
        run(h, USER)

    untouched(h)


def test_the_two_errors_are_distinct_types() -> None:
    assert not issubclass(BirthDateRequired, Underage)
    assert not issubclass(Underage, BirthDateRequired)


# --------------------------------------------------------------------------------------------
# CA-IDENTITY-16: orden
def test_a_minor_with_an_empty_cart_gets_underage_not_empty_selection() -> None:
    h = harness(adult=real_adult(MINOR_BIRTH))
    h.prepare.error = EmptySelection()

    with pytest.raises(Underage):
        run(h, USER)

    untouched(h)  # `prepare` ni siquiera se llamó


def test_without_a_birth_date_and_an_empty_cart_it_is_birth_date_required() -> None:
    h = harness(adult=real_adult(None))
    h.prepare.error = EmptySelection()

    with pytest.raises(BirthDateRequired):
        run(h, USER)

    untouched(h)


def test_a_minor_choosing_pickup_without_a_boutique_gets_underage_not_pickup_unavailable() -> None:
    h = harness(checkout_line(), store=None, adult=real_adult(MINOR_BIRTH))

    with pytest.raises(Underage):
        run(h, USER, delivery=pickup_delivery())

    untouched(h)  # ni siquiera se consultó la boutique


def test_an_adult_choosing_pickup_without_a_boutique_still_gets_pickup_unavailable() -> None:
    h = harness(checkout_line(), store=None, adult=real_adult(ADULT_BIRTH))

    with pytest.raises(PickupUnavailable):
        run(h, USER, delivery=pickup_delivery())

    assert "prepare" not in h.calls


def test_an_adult_with_an_empty_cart_still_gets_empty_selection() -> None:
    h = harness(adult=real_adult(ADULT_BIRTH))
    h.prepare.error = EmptySelection()

    with pytest.raises(EmptySelection):
        run(h, USER)


def test_an_adult_at_the_pending_limit_still_gets_too_many_pending_orders() -> None:
    h = harness(checkout_line(), adult=real_adult(ADULT_BIRTH))
    h.orders.pending = 3

    with pytest.raises(TooManyPendingOrders):
        run(h, USER)

    assert "reserve" not in h.calls


def test_the_age_is_checked_after_the_key_lookup_and_before_pickup_and_prepare() -> None:
    h = harness(checkout_line(), log_adult=True)
    h.adult.error = Underage()

    with pytest.raises(Underage):
        run(h, USER, delivery=pickup_delivery())

    assert h.calls == ["clock", "find", "adult"]


def test_the_age_check_gets_the_token_user_and_the_clock_instant_once() -> None:
    h = harness(checkout_line())

    run(h, USER)

    assert h.adult.args == [(USER, NOW)]  # el primer `now` del reloj: el mismo del pedido
    assert h.clock.ticks == 1  # una sola lectura de la hora (R6)
    assert h.orders.added[0].created_at == NOW


def test_a_failed_check_looks_the_key_up_only_once() -> None:
    h = harness(checkout_line())
    h.adult.error = Underage()

    with pytest.raises(Underage):
        run(h, USER)

    assert h.orders.find_args == [(USER, KEY)]


# --------------------------------------------------------------------------------------------
# R8: la repetición de una clave ya creada no vuelve a comprobar la edad
def test_a_replayed_key_returns_the_order_without_reading_the_profile() -> None:
    adult = EnsureAdult(ExplodingProfiles())  # type: ignore[arg-type]
    h = harness(checkout_line(), adult=adult)
    saved = stored_order()
    h.orders.stored[(USER, KEY)] = saved

    result = run(h, USER)

    assert result.created is False and result.order is saved
    untouched(h)


def test_a_replayed_key_does_not_invoke_ensure_adult_even_if_it_would_fail() -> None:
    h = harness(checkout_line())
    h.adult.error = Underage()
    h.orders.stored[(USER, KEY)] = stored_order()

    result = run(h, USER)

    assert result.created is False
    assert h.adult.args == []


def test_a_minor_using_the_key_of_another_users_order_gets_underage_and_not_that_order() -> None:
    """La clave es por usuario: la del pedido de otro no es una repetición; se comprueba la edad
    del que llama y no se le devuelve el pedido ajeno."""
    h = harness(checkout_line(), adult=real_adult(MINOR_BIRTH, OTHER))
    h.orders.stored[(USER, KEY)] = stored_order()

    with pytest.raises(Underage):
        run(h, OTHER)

    assert h.orders.find_args == [(OTHER, KEY)]
    untouched(h)


def test_a_missing_profile_is_an_error_never_an_adult_by_default() -> None:
    h = harness(checkout_line(), adult=EnsureAdult(BirthDateProfiles()))  # type: ignore[arg-type]

    with pytest.raises(KeyError):
        run(h, USER)

    untouched(h)


# --------------------------------------------------------------------------------------------
# Límite de la mayoría de edad en Lima (UTC−5), con reloj fijo
class FixedClock:
    def __init__(self, now: datetime) -> None:
        self.value = now

    def now(self) -> datetime:
        return self.value


def utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


@pytest.mark.parametrize(
    ("now", "born", "allowed"),
    [
        ("2026-11-28T03:00:00", "2008-11-27", True),  # cumple 18 hoy en Lima (22:00 del 27)
        ("2026-11-28T03:00:00", "2008-11-28", False),  # los cumple mañana
        ("2026-11-28T04:59:59", "2008-11-28", False),  # en UTC ya es 28, en Lima aún no
        ("2026-11-28T05:00:00", "2008-11-28", True),  # 00:00 del 28 en Lima
        ("2026-11-28T05:00:00", "2008-11-29", False),
        ("2026-11-27T04:59:59", "2008-11-27", False),  # 23:59:59 del 26 en Lima
        ("2026-11-27T05:00:00", "2008-11-27", True),
        ("2026-03-01T05:00:00", "2008-02-29", True),  # nacido un 29 de febrero: cumple el 1-mar
        ("2026-03-01T04:59:59", "2008-02-29", False),
    ],
)
def test_the_18th_birthday_is_judged_on_the_lima_calendar_day(
    now: str, born: str, allowed: bool
) -> None:
    adult = real_adult(date.fromisoformat(born))
    h = harness(checkout_line(), adult=adult, clock=FixedClock(utc(now)))

    if allowed:
        assert run(h, USER).created is True
    else:
        with pytest.raises(Underage):
            run(h, USER)
        untouched(h)


def test_a_clock_without_a_time_zone_is_a_programming_error_not_an_adult() -> None:
    naive = FixedClock(datetime(2026, 11, 28, 5, 0))
    h = harness(checkout_line(), adult=real_adult(ADULT_BIRTH), clock=naive)

    with pytest.raises(ValueError, match="zona horaria"):
        run(h, USER)

    untouched(h)


# --------------------------------------------------------------------------------------------
# Privacidad: las excepciones no llevan la fecha ni la edad
@pytest.mark.parametrize(("born", "error"), [(MINOR_BIRTH, Underage), (None, BirthDateRequired)])
def test_the_errors_carry_neither_the_birth_date_nor_the_age(
    born: date | None, error: type[Exception]
) -> None:
    h = harness(checkout_line(), adult=real_adult(born))

    with pytest.raises(error) as caught:
        run(h, USER)

    exposed = f"{caught.value!s} {caught.value!r} {caught.value.args} {vars(caught.value)}"
    for text in ("2012", "03-04", "04/03", "14", "años", "edad"):
        assert text not in exposed, text
    assert not any(isinstance(v, datetime | date | int) for v in vars(caught.value).values())


# --------------------------------------------------------------------------------------------
# Capas: el núcleo de orders solo conoce el puerto de identity, no sus adaptadores ni su fila
ORDERS = Path(__file__).resolve().parents[2] / "src" / "valmont" / "modules" / "orders"


def identity_imports(path: Path) -> set[tuple[str, str]]:
    tree = ast.parse(path.read_text("utf-8"))
    return {
        (node.module or "", alias.name)
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(IDENTITY)
        for alias in node.names
    }


def test_the_orders_domain_does_not_know_identity() -> None:
    assert identity_imports(ORDERS / "domain.py") == set()


def test_the_orders_use_cases_import_only_the_ensure_adult_port_and_its_two_errors() -> None:
    assert identity_imports(ORDERS / "application.py") <= {
        (f"{IDENTITY}.application", name)
        for name in ("EnsureAdult", "BirthDateRequired", "Underage")
    }
    assert (f"{IDENTITY}.application", "EnsureAdult") in identity_imports(ORDERS / "application.py")
