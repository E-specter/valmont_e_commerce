"""Fecha de nacimiento contra la BD (T-138; CA-IDENTITY-11, 12, 13, 14, 17). Integración."""

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.identity.birth_date_helpers import NOW, OTHER_BIRTH, VALID_BIRTH
from tests.identity.identity_helpers import make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.identity.adapters.persistence import ProfileRow, SqlProfileRepository
from valmont.modules.identity.adapters.wiring import get_ensure_adult
from valmont.modules.identity.application import (
    BirthDateRequired,
    EnsureProfile,
    Underage,
    UpdateProfile,
)
from valmont.modules.identity.domain import BirthDateLocked, ProfileError
from valmont.shared import db

pytestmark = pytest.mark.integration

ME = "/api/v1/identity/me"
SENT = date(1987, 3, 21)
AUDIT_WITH_DATE = text(
    "SELECT count(*) FROM app.audit_log WHERE COALESCE(before::text, '') ~ :pattern"
    " OR COALESCE(after::text, '') ~ :pattern OR entity_id ~ :pattern"
)
AUDIT_COUNT = text("SELECT count(*) FROM app.audit_log")


@pytest.fixture
def committed_user(db_engine: Engine) -> Iterator[UUID]:
    """Usuario para pruebas que confirman transacciones reales; se borra al terminar."""
    user_id = uuid4()
    yield user_id
    with db_engine.begin() as connection:
        connection.execute(delete(ProfileRow).filter_by(user_id=user_id))


@pytest.fixture
def api(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    monkeypatch.setattr(db, "get_engine", lambda: db_engine)
    return TestClient(create_app())


def headers_for(user_id: UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(str(user_id))}"}


def stored_birth(engine: Engine, user_id: UUID) -> date | None:
    with Session(engine) as session:
        return session.scalar(select(ProfileRow.birth_date).filter_by(user_id=user_id))


def set_in_own_transaction(engine: Engine, user_id: UUID, birth: date) -> bool:
    with Session(engine) as session, session.begin():
        return SqlProfileRepository(session).set_birth_date_if_unset(user_id, birth)


# --- Persistencia ---


def test_new_profile_has_null_birth_date(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)

    profile = EnsureProfile(repo)(user_id)

    assert profile.birth_date is None


def test_set_birth_date_if_unset_writes_once_and_keeps_the_first_value(
    db_session: Session,
) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)

    first = repo.set_birth_date_if_unset(user_id, VALID_BIRTH)
    second = repo.set_birth_date_if_unset(user_id, OTHER_BIRTH)
    same = repo.set_birth_date_if_unset(user_id, VALID_BIRTH)

    assert (first, second, same) == (True, False, False)
    db_session.expire_all()
    assert repo.get(user_id).birth_date == VALID_BIRTH


def test_set_birth_date_if_unset_on_a_missing_profile_is_false(db_session: Session) -> None:
    assert SqlProfileRepository(db_session).set_birth_date_if_unset(uuid4(), VALID_BIRTH) is False


def test_set_birth_date_if_unset_touches_only_that_profile(db_session: Session) -> None:
    mine, other = uuid4(), uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(mine)
    EnsureProfile(repo)(other)

    repo.set_birth_date_if_unset(mine, VALID_BIRTH)

    db_session.expire_all()
    assert repo.get(other).birth_date is None


def test_birth_date_round_trips_through_the_repository(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)
    UpdateProfile(repo, clock=lambda: NOW)(user_id, {"birth_date": VALID_BIRTH})

    db_session.expire_all()

    stored = repo.get(user_id)
    assert stored.birth_date == VALID_BIRTH
    assert isinstance(stored.birth_date, date) and not isinstance(stored.birth_date, datetime)


def test_update_does_not_alter_birth_date(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)
    repo.set_birth_date_if_unset(user_id, VALID_BIRTH)

    repo.update(user_id, {"full_name": "Ana Torres"})

    db_session.expire_all()
    assert repo.get(user_id).birth_date == VALID_BIRTH


def test_check_constraint_rejects_a_date_before_1900(db_session: Session) -> None:
    user_id = uuid4()
    EnsureProfile(SqlProfileRepository(db_session))(user_id)

    with pytest.raises(IntegrityError, match="birth_date_range"):
        db_session.execute(
            update(ProfileRow).filter_by(user_id=user_id).values(birth_date=date(1899, 12, 31))
        )


def test_check_constraint_accepts_the_1900_boundary_and_null(db_session: Session) -> None:
    user_id = uuid4()
    EnsureProfile(SqlProfileRepository(db_session))(user_id)

    db_session.execute(
        update(ProfileRow).filter_by(user_id=user_id).values(birth_date=date(1900, 1, 1))
    )
    db_session.execute(update(ProfileRow).filter_by(user_id=user_id).values(birth_date=None))


def test_check_constraint_rejects_raw_sql_too(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(
            text("INSERT INTO app.profiles (user_id, birth_date) VALUES (:id, DATE '1899-12-31')"),
            {"id": uuid4()},
        )


# --- Concurrencia (R10: UPDATE ... WHERE birth_date IS NULL) ---


def test_two_simultaneous_sets_leave_exactly_one_value(
    db_engine: Engine, committed_user: UUID
) -> None:
    with Session(db_engine) as session, session.begin():
        EnsureProfile(SqlProfileRepository(session))(committed_user)

    with ThreadPoolExecutor(max_workers=1) as pool, Session(db_engine) as first:
        with first.begin():
            won = SqlProfileRepository(first).set_birth_date_if_unset(committed_user, VALID_BIRTH)
            second = pool.submit(set_in_own_transaction, db_engine, committed_user, OTHER_BIRTH)
            # La segunda espera al UPDATE sin confirmar en vez de pisarlo.
            assert not wait([second], timeout=0.5).done
        lost = second.result(timeout=5)

    assert (won, lost) == (True, False)
    assert stored_birth(db_engine, committed_user) == VALID_BIRTH


def test_two_simultaneous_patches_with_different_dates_leave_one_and_a_409(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    headers = headers_for(committed_user)
    assert api.get(ME, headers=headers).status_code == 200  # el perfil existe antes de la carrera
    dates = ["1990-05-17", "1991-01-01"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda value: api.patch(ME, headers=headers, json={"birth_date": value}), dates
            )
        )

    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = next(r for r in responses if r.status_code == 200).json()["birth_date"]
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json()["error"]["code"] == "birth_date_locked"
    assert stored_birth(db_engine, committed_user) == date.fromisoformat(winner)
    assert api.get(ME, headers=headers).json()["birth_date"] == winner


def test_two_simultaneous_patches_with_the_same_date_are_both_200(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    headers = headers_for(committed_user)
    api.get(ME, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda _: api.patch(ME, headers=headers, json={"birth_date": "1990-05-17"}),
                range(2),
            )
        )

    assert [r.status_code for r in responses] == [200, 200]
    assert stored_birth(db_engine, committed_user) == date(1990, 5, 17)


# --- Atomicidad (CA-12) ---


def test_failure_after_the_date_is_set_rolls_everything_back(
    db_engine: Engine, committed_user: UUID
) -> None:
    with Session(db_engine) as session, session.begin():
        EnsureProfile(SqlProfileRepository(session))(committed_user)

    with pytest.raises(ProfileError), Session(db_engine) as session, session.begin():
        # El dominio fija primero la fecha y falla después con el nombre: la transacción de la
        # solicitud lo deshace todo.
        UpdateProfile(SqlProfileRepository(session), clock=lambda: NOW)(
            committed_user, {"birth_date": VALID_BIRTH, "full_name": "   "}
        )

    assert stored_birth(db_engine, committed_user) is None


def test_locked_date_through_the_api_keeps_full_name_and_date(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    headers = headers_for(committed_user)
    api.patch(ME, headers=headers, json={"birth_date": "1990-05-17", "full_name": "Ana Torres"})

    response = api.patch(
        ME, headers=headers, json={"birth_date": "1991-01-01", "full_name": "Otra Persona"}
    )

    assert response.status_code == 409
    body = api.get(ME, headers=headers).json()
    assert (body["birth_date"], body["full_name"]) == ("1990-05-17", "Ana Torres")


def test_invalid_full_name_with_valid_date_through_the_api_writes_nothing(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    headers = headers_for(committed_user)
    api.get(ME, headers=headers)

    response = api.patch(ME, headers=headers, json={"birth_date": "1990-05-17", "full_name": " "})

    assert response.status_code == 422
    assert stored_birth(db_engine, committed_user) is None


def test_usecase_locked_error_through_sql_repository(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)
    update_profile = UpdateProfile(repo, clock=lambda: NOW)
    update_profile(user_id, {"birth_date": VALID_BIRTH})

    assert update_profile(user_id, {"birth_date": VALID_BIRTH}).birth_date == VALID_BIRTH
    with pytest.raises(BirthDateLocked):
        update_profile(user_id, {"birth_date": OTHER_BIRTH})


# --- Privacidad (CA-13): auditoría y lectura entre usuarios ---


def test_no_audit_row_carries_the_birth_date_and_identity_writes_none(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    headers = headers_for(committed_user)
    with Session(db_engine) as session:
        before = session.scalar(AUDIT_COUNT)

    api.patch(ME, headers=headers, json={"birth_date": SENT.isoformat()})  # 200
    api.patch(ME, headers=headers, json={"birth_date": "1993-08-14"})  # 409
    api.patch(ME, headers=headers, json={"birth_date": "2999-12-31"})  # 422
    api.get(ME, headers=headers)

    with Session(db_engine) as session:
        assert session.scalar(AUDIT_COUNT) == before  # identity no audita en el MVP (R14)
        for pattern in ("1987-03-21", "1993-08-14", "2999-12-31", "1987"):
            assert session.scalar(AUDIT_WITH_DATE, {"pattern": pattern}) == 0, pattern


def test_each_user_reads_only_their_own_date_from_the_database(
    api: TestClient, db_engine: Engine
) -> None:
    ana, luis = uuid4(), uuid4()
    try:
        api.patch(ME, headers=headers_for(ana), json={"birth_date": "1990-05-17"})
        api.patch(ME, headers=headers_for(luis), json={"birth_date": "1985-12-24"})

        assert api.get(ME, headers=headers_for(ana)).json()["birth_date"] == "1990-05-17"
        assert api.get(ME, headers=headers_for(luis)).json()["birth_date"] == "1985-12-24"
        stranger = api.get(ME, headers=headers_for(uuid4())).json()
        assert stranger["birth_date"] is None
    finally:
        with db_engine.begin() as connection:
            connection.execute(delete(ProfileRow).where(ProfileRow.user_id.in_([ana, luis])))


def test_body_user_id_cannot_set_the_date_of_another_profile(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    victim = uuid4()
    try:
        api.get(ME, headers=headers_for(victim))

        response = api.patch(
            ME,
            headers=headers_for(committed_user),
            json={"birth_date": "1990-05-17", "user_id": str(victim)},
        )

        assert response.status_code == 422
        assert stored_birth(db_engine, victim) is None
        assert stored_birth(db_engine, committed_user) is None
    finally:
        with db_engine.begin() as connection:
            connection.execute(delete(ProfileRow).filter_by(user_id=victim))


# --- EnsureAdult con el proveedor real (misma transacción) ---


def test_get_ensure_adult_uses_the_sql_repository_in_the_same_transaction(
    db_session: Session,
) -> None:
    adult, minor, nameless = uuid4(), uuid4(), uuid4()
    repo = SqlProfileRepository(db_session)
    for user in (adult, minor, nameless):
        EnsureProfile(repo)(user)
    repo.set_birth_date_if_unset(adult, date(1990, 5, 17))
    repo.set_birth_date_if_unset(minor, date(2015, 3, 9))  # sin confirmar: misma transacción
    ensure_adult = get_ensure_adult(db_session)
    now = datetime(2026, 11, 27, 17, 0, tzinfo=UTC)

    assert ensure_adult(adult, now) is None
    with pytest.raises(Underage):
        ensure_adult(minor, now)
    with pytest.raises(BirthDateRequired):
        ensure_adult(nameless, now)


def test_ensure_adult_at_midnight_of_lima_against_the_database(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)
    repo.set_birth_date_if_unset(user_id, date(2008, 11, 28))
    ensure_adult = get_ensure_adult(db_session)

    with pytest.raises(Underage):
        ensure_adult(user_id, datetime(2026, 11, 28, 4, 59, 59, tzinfo=UTC))
    assert ensure_adult(user_id, datetime(2026, 11, 28, 5, 0, tzinfo=UTC)) is None


def test_profiles_count_is_unchanged_by_birth_date_writes(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)
    repo.set_birth_date_if_unset(user_id, VALID_BIRTH)
    repo.set_birth_date_if_unset(user_id, OTHER_BIRTH)

    query = select(func.count()).select_from(ProfileRow).filter_by(user_id=user_id)
    assert db_session.scalar(query) == 1


def test_minor_date_through_the_api_writes_nothing_to_the_database(
    api: TestClient, db_engine: Engine, committed_user: UUID
) -> None:
    headers = headers_for(committed_user)
    api.get(ME, headers=headers)
    minor = datetime.now(UTC).date().replace(year=datetime.now(UTC).year - 10)

    response = api.patch(
        ME, headers=headers, json={"birth_date": minor.isoformat(), "full_name": "Ana Torres"}
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"][0]["type"] == "birth_date_underage"
    assert stored_birth(db_engine, committed_user) is None
    assert api.get(ME, headers=headers).json()["full_name"] is None  # IDENTITY-R7b
