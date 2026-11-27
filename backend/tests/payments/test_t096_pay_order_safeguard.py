"""T-099 (CRÍTICO-1 de T-096) con falsos: `PayOrder` toma `lock_key` antes de todo y nunca
reproduce un intento ajeno a la solicitud después de haber confirmado el cobro. Sin BD."""

from uuid import UUID

import pytest

from tests.payments.pay_order_helpers import KEY, ORDER, USER, rig, stored
from valmont.modules.orders.application import PaymentOutcome
from valmont.modules.payments.domain import FailureCode, IdempotencyKeyReused, PaymentAttempt


def test_the_key_lock_is_taken_once_with_the_session_identity_before_any_lookup() -> None:
    r = rig()
    seen: list[str] = []
    lock, find = r.attempts.lock_key, r.attempts.find_by_key

    def spy_lock(user_id: UUID, key: str) -> None:
        seen.append("lock")
        lock(user_id, key)

    def spy_find(user_id: UUID, key: str) -> PaymentAttempt | None:
        seen.append("find")
        return find(user_id, key)

    r.attempts.lock_key = spy_lock  # type: ignore[method-assign]
    r.attempts.find_by_key = spy_find  # type: ignore[method-assign]

    r.pay("4242", key=KEY)

    assert r.attempts.locks == [(USER, KEY)]
    assert seen[0] == "lock" and seen.count("lock") == 1 and "find" in seen


def test_a_replay_also_takes_the_lock_first() -> None:
    original = stored(FailureCode.CARD_DECLINED)
    r = rig(rows=(original,))

    result = r.pay("4242", key=KEY)

    assert result.created is False and r.attempts.locks == [(USER, KEY)]
    assert r.effects() == []


def test_a_confirmed_charge_that_loses_the_key_is_409_and_never_replays_a_rejection() -> None:
    # La carrera del CRÍTICO-1: la clave aparece (rechazada) tras confirmar el cobro.
    loser = stored(FailureCode.CARD_DECLINED, order=ORDER, key=KEY)
    r = rig(late=loser, outcome=PaymentOutcome.PAID)

    with pytest.raises(IdempotencyKeyReused):
        r.pay("4242", key=KEY)

    assert r.orders.confirmed  # confirmó: la ruta hace rollback (lo prueba test_t096_races)
    assert r.audit.entries == []


def test_an_expired_confirmation_that_loses_the_key_still_replays_the_stored_attempt() -> None:
    # `EXPIRED` no cobra: reproducir lo guardado es seguro (solo PAID activa la salvaguarda).
    winner = stored(FailureCode.CARD_DECLINED, key=KEY)
    r = rig(late=winner, outcome=PaymentOutcome.EXPIRED)

    result = r.pay("4242", key=KEY)

    assert result.created is False and result.attempt == winner
    assert r.audit.entries == []


def test_a_rejection_that_loses_the_key_still_replays_the_stored_attempt() -> None:
    winner = stored(FailureCode.CARD_DECLINED, key=KEY)
    r = rig(late=winner, result=FailureCode.INSUFFICIENT_FUNDS)

    result = r.pay("9995", key=KEY)

    assert result.created is False and result.attempt == winner
    assert "confirm" not in r.calls
