"""Casos de uso de la fecha de nacimiento (T-138): UpdateProfile y EnsureAdult con repo falso."""

from collections.abc import Mapping
from dataclasses import fields
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

import pytest

from tests.identity.birth_date_helpers import NOW, OTHER_BIRTH, VALID_BIRTH, BirthDateProfiles
from valmont.modules.identity import application
from valmont.modules.identity.application import (
    BirthDateRequired,
    EnsureAdult,
    EnsureProfile,
    ProfileChanges,
    Underage,
    UpdateProfile,
)
from valmont.modules.identity.domain import (
    AgeRequirementError,
    BirthDateInvalid,
    BirthDateLocked,
    BirthDateUnderage,
    Preferences,
    Profile,
)


class SpyProfiles(BirthDateProfiles):
    """Anota los valores que llegan a update(): birth_date nunca debe pasar por ahí."""

    def __init__(self) -> None:
        super().__init__()
        self.update_values: list[Mapping[str, object]] = []

    def update(self, user_id: UUID, values: Mapping[str, object]) -> Profile:
        self.update_values.append(dict(values))
        return super().update(user_id, values)


@pytest.fixture
def repo() -> SpyProfiles:
    return SpyProfiles()


@pytest.fixture
def user_id(repo: SpyProfiles) -> UUID:
    user = uuid4()
    EnsureProfile(repo)(user)
    return user


def update_at(repo: SpyProfiles, now: datetime = NOW) -> UpdateProfile:
    return UpdateProfile(repo, clock=lambda: now)


# --- UpdateProfile ---


def test_changes_type_accepts_birth_date() -> None:
    assert "birth_date" in ProfileChanges.__annotations__


def test_sets_birth_date_when_unset(repo: SpyProfiles, user_id: UUID) -> None:
    profile = update_at(repo)(user_id, {"birth_date": VALID_BIRTH})

    assert profile.birth_date == VALID_BIRTH
    assert repo.get(user_id).birth_date == VALID_BIRTH
    assert all("birth_date" not in values for values in repo.update_values)


def test_same_birth_date_again_is_idempotent(repo: SpyProfiles, user_id: UUID) -> None:
    update = update_at(repo)
    first = update(user_id, {"birth_date": VALID_BIRTH})

    second = update(user_id, {"birth_date": VALID_BIRTH})

    assert second.birth_date == first.birth_date == VALID_BIRTH


def test_different_birth_date_is_locked_and_original_is_kept(
    repo: SpyProfiles, user_id: UUID
) -> None:
    update = update_at(repo)
    update(user_id, {"birth_date": VALID_BIRTH})

    with pytest.raises(BirthDateLocked):
        update(user_id, {"birth_date": OTHER_BIRTH})

    assert repo.get(user_id).birth_date == VALID_BIRTH


def test_locked_birth_date_writes_none_of_the_other_fields(
    repo: SpyProfiles, user_id: UUID
) -> None:
    update = update_at(repo)
    update(user_id, {"birth_date": VALID_BIRTH})
    repo.update_values.clear()

    with pytest.raises(BirthDateLocked):
        update(
            user_id, {"birth_date": OTHER_BIRTH, "full_name": "Ana Torres", "phone": "987654321"}
        )

    assert repo.update_values == []
    assert repo.get(user_id).full_name is None


def test_same_birth_date_with_other_fields_applies_the_rest(
    repo: SpyProfiles, user_id: UUID
) -> None:
    update = update_at(repo)
    update(user_id, {"birth_date": VALID_BIRTH})

    profile = update(user_id, {"birth_date": VALID_BIRTH, "full_name": " Ana  Torres "})

    assert (profile.full_name, profile.birth_date) == ("Ana Torres", VALID_BIRTH)


def test_birth_date_together_with_other_fields_writes_all(repo: SpyProfiles, user_id: UUID) -> None:
    changes: ProfileChanges = {
        "birth_date": VALID_BIRTH,
        "full_name": "Ana Torres",
        "preferences": Preferences(style="clásico"),
        "accept_privacy_version": "2026-10",
    }

    profile = update_at(repo)(user_id, changes)

    assert profile.birth_date == VALID_BIRTH
    assert profile.full_name == "Ana Torres"
    assert profile.preferences == Preferences(style="clásico")
    assert (profile.privacy_version, profile.privacy_accepted_at) == ("2026-10", NOW)


@pytest.mark.parametrize(
    ("birth", "reason"),
    [
        (date(2026, 11, 28), "future"),
        (date(2999, 1, 1), "future"),
        (date(1905, 11, 27), "too_old"),
        (date(1899, 12, 31), "too_old"),
    ],
)
def test_out_of_range_birth_date_is_rejected_before_anything_is_written(
    repo: SpyProfiles, user_id: UUID, birth: date, reason: str
) -> None:
    with pytest.raises(BirthDateInvalid) as error:
        update_at(repo)(user_id, {"birth_date": birth, "full_name": "Ana Torres"})

    assert error.value.reason == reason
    assert repo.set_calls == []  # el rango se comprueba PRIMERO
    assert repo.update_values == []
    assert repo.get(user_id).birth_date is None
    assert repo.get(user_id).full_name is None


def test_exactly_120_years_is_valid(repo: SpyProfiles, user_id: UUID) -> None:
    birth = date(1906, 11, 27)

    assert update_at(repo)(user_id, {"birth_date": birth}).birth_date == birth


def test_future_check_uses_the_lima_day_not_the_utc_day(repo: SpyProfiles, user_id: UUID) -> None:
    # 2026-11-28T03:00Z = 22:00 del 27 en Lima: el 28 aún es futuro.
    late_evening_lima = datetime(2026, 11, 28, 3, 0, tzinfo=UTC)
    with pytest.raises(BirthDateInvalid) as error:
        update_at(repo, late_evening_lima)(user_id, {"birth_date": date(2026, 11, 28)})
    assert error.value.reason == "future"

    # 2026-11-28T05:00Z = 00:00 del 28 en Lima: ya no es futura (hoy; con R7b es menor).
    midnight_lima = datetime(2026, 11, 28, 5, 0, tzinfo=UTC)
    with pytest.raises(BirthDateInvalid) as today_error:
        update_at(repo, midnight_lima)(user_id, {"birth_date": date(2026, 11, 28)})
    assert today_error.value.reason == "underage"
    adult_birth = date(2008, 11, 28)
    profile = update_at(repo, midnight_lima)(user_id, {"birth_date": adult_birth})
    assert profile.birth_date == adult_birth


# --- IDENTITY-R7b: de un menor no se guarda la fecha ---


@pytest.mark.parametrize(
    ("birth", "now"),
    [
        pytest.param(date(2026, 11, 27), NOW, id="hoy-de-lima"),
        pytest.param(date(2026, 11, 26), NOW, id="ayer"),
        pytest.param(date(2015, 3, 9), NOW, id="11-anios"),
        pytest.param(date(2008, 11, 28), NOW, id="18-anios-manana"),
        pytest.param(date(2008, 12, 31), NOW, id="18-anios-fin-de-anio"),
        # Cruce de medianoche de Lima: a las 04:59:59Z aún es el 27 en Lima.
        pytest.param(date(2008, 11, 28), datetime(2026, 11, 28, 4, 59, 59, tzinfo=UTC), id="lima"),
        # 29-feb-2008: cumple 18 el 1-mar-2026.
        pytest.param(date(2008, 2, 29), datetime(2026, 2, 28, 17, 0, tzinfo=UTC), id="29-feb"),
    ],
)
def test_minor_birth_date_is_rejected_with_no_effects(
    repo: SpyProfiles, user_id: UUID, birth: date, now: datetime
) -> None:
    with pytest.raises(BirthDateUnderage) as error:
        update_at(repo, now)(
            user_id, {"birth_date": birth, "full_name": "Ana Torres", "phone": "987654321"}
        )

    assert isinstance(error.value, BirthDateInvalid)
    assert error.value.reason == "underage"
    assert not any(char.isdigit() for char in str(error.value))
    assert repo.set_calls == []  # ni siquiera se intenta fijar
    assert repo.update_values == []  # ni el resto de campos
    assert repo.get(user_id).birth_date is None
    assert repo.get(user_id).full_name is None


@pytest.mark.parametrize(
    ("birth", "now"),
    [
        pytest.param(date(2008, 11, 27), NOW, id="18-anios-hoy"),
        pytest.param(date(2008, 11, 26), NOW, id="18-anios-ayer"),
        pytest.param(date(2008, 11, 28), datetime(2026, 11, 28, 5, 0, tzinfo=UTC), id="00-00-lima"),
        pytest.param(date(2008, 2, 29), datetime(2026, 3, 1, 17, 0, tzinfo=UTC), id="29-feb"),
    ],
)
def test_exactly_18_years_completed_in_lima_is_accepted(
    repo: SpyProfiles, user_id: UUID, birth: date, now: datetime
) -> None:
    profile = update_at(repo, now)(user_id, {"birth_date": birth, "full_name": "Ana Torres"})

    assert (profile.birth_date, profile.full_name) == (birth, "Ana Torres")


def test_minor_date_after_a_fixed_one_is_422_underage_not_409(
    repo: SpyProfiles, user_id: UUID
) -> None:
    # Orden actual documentado: rango -> menor -> fijación. Con la fecha ya fijada, una de menor
    # recibe BirthDateUnderage (422) y no BirthDateLocked (409); la fecha original sigue.
    update = update_at(repo)
    update(user_id, {"birth_date": VALID_BIRTH})
    repo.set_calls.clear()

    with pytest.raises(BirthDateUnderage):
        update(user_id, {"birth_date": date(2015, 3, 9)})

    assert repo.set_calls == []
    assert repo.get(user_id).birth_date == VALID_BIRTH


def test_range_errors_take_precedence_over_underage(repo: SpyProfiles, user_id: UUID) -> None:
    with pytest.raises(BirthDateInvalid) as future:
        update_at(repo)(user_id, {"birth_date": date(2026, 11, 28)})
    with pytest.raises(BirthDateInvalid) as old:
        update_at(repo)(user_id, {"birth_date": date(1850, 1, 1)})

    assert (future.value.reason, old.value.reason) == ("future", "too_old")
    assert not isinstance(future.value, BirthDateUnderage)


def test_update_without_birth_date_never_touches_it(repo: SpyProfiles, user_id: UUID) -> None:
    update = update_at(repo)
    update(user_id, {"birth_date": VALID_BIRTH})
    repo.set_calls.clear()

    profile = update(user_id, {"full_name": "Ana Torres"})
    again = update(user_id, {"preferences": Preferences(style="clásico")})

    assert profile.birth_date == again.birth_date == VALID_BIRTH
    assert repo.set_calls == []


def test_update_without_birth_date_leaves_it_null(repo: SpyProfiles, user_id: UUID) -> None:
    profile = update_at(repo)(user_id, {"full_name": "Ana Torres"})

    assert profile.birth_date is None


def test_only_birth_date_returns_the_stored_profile(repo: SpyProfiles, user_id: UUID) -> None:
    profile = update_at(repo)(user_id, {"birth_date": VALID_BIRTH})

    assert profile == repo.get(user_id)


def test_invalid_other_field_does_not_make_birth_date_invalid(
    repo: SpyProfiles, user_id: UUID
) -> None:
    # CA-12 (aplicación): con full_name inválido el use case levanta ProfileError; la
    # transacción de la solicitud deshace la fijación (se comprueba en la prueba de integración).
    from valmont.modules.identity.domain import ProfileError

    with pytest.raises(ProfileError):
        update_at(repo)(user_id, {"birth_date": VALID_BIRTH, "full_name": "   "})


def test_race_lost_to_the_same_value_continues(repo: SpyProfiles, user_id: UUID) -> None:
    # set_birth_date_if_unset devuelve False y la fila ya trae el mismo valor: no es un bloqueo.
    repo.with_birth_date(user_id, VALID_BIRTH)

    profile = update_at(repo)(user_id, {"birth_date": VALID_BIRTH, "full_name": "Ana"})

    assert profile.full_name == "Ana"


def test_birth_date_state_is_per_user(repo: SpyProfiles, user_id: UUID) -> None:
    other = uuid4()
    EnsureProfile(repo)(other)
    update = update_at(repo)

    update(user_id, {"birth_date": VALID_BIRTH})

    assert repo.get(other).birth_date is None
    assert update(other, {"birth_date": OTHER_BIRTH}).birth_date == OTHER_BIRTH


# --- EnsureAdult (UC-IDENTITY-08, R8, R9) ---


def adult_check(repo: SpyProfiles) -> EnsureAdult:
    return EnsureAdult(repo)


def test_ensure_adult_without_birth_date_raises_required(repo: SpyProfiles, user_id: UUID) -> None:
    with pytest.raises(BirthDateRequired):
        adult_check(repo)(user_id, NOW)


def test_ensure_adult_passes_for_an_adult_and_returns_nothing(
    repo: SpyProfiles, user_id: UUID
) -> None:
    repo.with_birth_date(user_id, VALID_BIRTH)

    assert adult_check(repo)(user_id, NOW) is None


@pytest.mark.parametrize(
    ("birth", "now", "adult"),
    [
        # Día anterior al 18.º cumpleaños (fecha de Lima) → menor.
        (date(2008, 11, 28), datetime(2026, 11, 27, 17, 0, tzinfo=UTC), False),
        (date(2008, 11, 28), datetime(2026, 11, 28, 4, 59, 59, tzinfo=UTC), False),
        # Las 00:00 de Lima del día del cumpleaños → mayor.
        (date(2008, 11, 28), datetime(2026, 11, 28, 5, 0, tzinfo=UTC), True),
        (date(2008, 11, 27), datetime(2026, 11, 27, 5, 0, tzinfo=UTC), True),
        (date(2008, 11, 27), datetime(2026, 11, 27, 4, 59, 59, tzinfo=UTC), False),
        # Medianoche UTC: en Lima todavía es el día anterior.
        (date(2008, 11, 28), datetime(2026, 11, 28, 0, 0, tzinfo=UTC), False),
        # 29-02-2008: el 28-02-2026 menor; el 01-03-2026 mayor (hipótesis conservadora de R8).
        (date(2008, 2, 29), datetime(2026, 2, 28, 17, 0, tzinfo=UTC), False),
        (date(2008, 2, 29), datetime(2026, 3, 1, 17, 0, tzinfo=UTC), True),
        (date(2008, 2, 29), datetime(2026, 3, 1, 4, 59, tzinfo=UTC), False),  # aún 28-feb en Lima
        # Un recién nacido y una persona de 120 años.
        (date(2026, 11, 27), NOW, False),
        (date(1906, 11, 27), NOW, True),
    ],
)
def test_ensure_adult_edges_in_lima(
    repo: SpyProfiles, user_id: UUID, birth: date, now: datetime, adult: bool
) -> None:
    repo.with_birth_date(user_id, birth)

    if adult:
        adult_check(repo)(user_id, now)
    else:
        with pytest.raises(Underage):
            adult_check(repo)(user_id, now)


def test_ensure_adult_rejects_naive_now(repo: SpyProfiles, user_id: UUID) -> None:
    repo.with_birth_date(user_id, VALID_BIRTH)

    with pytest.raises(ValueError):  # noqa: PT011 (la SPEC fija ValueError, sin mensaje)
        adult_check(repo)(user_id, datetime(2026, 11, 27, 17, 0))


def test_ensure_adult_looks_only_at_the_given_user(repo: SpyProfiles, user_id: UUID) -> None:
    minor = uuid4()
    repo.with_birth_date(user_id, VALID_BIRTH)
    repo.with_birth_date(minor, date(2015, 1, 1))

    adult_check(repo)(user_id, NOW)
    with pytest.raises(Underage):
        adult_check(repo)(minor, NOW)


@pytest.mark.parametrize("birth", [None, date(2015, 3, 9)])
def test_ensure_adult_errors_leak_neither_the_date_nor_the_age(
    repo: SpyProfiles, user_id: UUID, birth: date | None
) -> None:
    repo.with_birth_date(user_id, birth)

    with pytest.raises(AgeRequirementError) as error:
        adult_check(repo)(user_id, NOW)

    exc = error.value
    assert exc.args == () or all(isinstance(arg, str) for arg in exc.args)
    text = f"{exc!s}{exc!r}{vars(exc)}"
    assert not any(char.isdigit() for char in text)
    assert "2015" not in text
    assert exc.__cause__ is None
    assert exc.__context__ is None  # no arrastra una excepción con la fecha


def test_ensure_adult_does_not_write(repo: SpyProfiles, user_id: UUID) -> None:
    repo.with_birth_date(user_id, VALID_BIRTH)
    snapshot = dict(repo.rows)

    adult_check(repo)(user_id, NOW)

    assert repo.rows == snapshot
    assert repo.update_values == []
    assert repo.set_calls == []


def test_application_reexports_the_age_errors_for_orders() -> None:
    for name in ("BirthDateRequired", "Underage", "EnsureAdult"):
        assert name in application.__all__
    assert application.BirthDateRequired.__mro__[1].__name__ == "AgeRequirementError"
    assert {f.name for f in fields(Profile)} >= {"birth_date"}
