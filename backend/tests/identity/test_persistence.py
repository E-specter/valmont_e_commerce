from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.identity.adapters.persistence import ProfileRow, SqlProfileRepository
from valmont.modules.identity.application import EnsureProfile, UpdateProfile
from valmont.modules.identity.domain import Preferences, Profile, Role
from valmont.shared import db

pytestmark = pytest.mark.integration


def count_rows(session: Session, user_id: UUID) -> int:
    query = select(func.count()).select_from(ProfileRow).filter_by(user_id=user_id)
    return session.scalar(query)


def ensure_in_own_transaction(engine: Engine, user_id: UUID) -> Profile:
    with Session(engine) as session, session.begin():
        return EnsureProfile(SqlProfileRepository(session))(user_id)


@pytest.fixture
def committed_user(db_engine: Engine) -> Iterator[UUID]:
    """Usuario para pruebas que confirman transacciones reales; se borra al terminar."""
    user_id = uuid4()
    yield user_id
    with db_engine.begin() as connection:
        connection.execute(delete(ProfileRow).filter_by(user_id=user_id))


def test_ensure_profile_is_idempotent_and_uses_server_defaults(db_session: Session) -> None:
    user_id = uuid4()
    ensure = EnsureProfile(SqlProfileRepository(db_session))

    first, second = ensure(user_id), ensure(user_id)

    assert first == second
    assert (first.role, first.preferences, first.marketing_opt_in) == (
        Role.CUSTOMER,
        Preferences(),
        False,
    )
    assert first.created_at.tzinfo is not None
    assert count_rows(db_session, user_id) == 1


def test_two_simultaneous_first_requests_leave_one_row(
    db_engine: Engine, committed_user: UUID
) -> None:
    with ThreadPoolExecutor(max_workers=1) as pool, Session(db_engine) as first:
        with first.begin():
            EnsureProfile(SqlProfileRepository(first))(committed_user)
            second = pool.submit(ensure_in_own_transaction, db_engine, committed_user)
            # La segunda espera al INSERT sin confirmar de la primera en vez de duplicarlo.
            assert not wait([second], timeout=0.5).done
        assert second.result(timeout=5).user_id == committed_user

    with Session(db_engine) as session:
        assert count_rows(session, committed_user) == 1


def test_update_profile_persists_only_sent_fields(db_session: Session) -> None:
    user_id = uuid4()
    repo = SqlProfileRepository(db_session)
    EnsureProfile(repo)(user_id)
    prefs = Preferences("clásico", 300000, 900000, ("acero", "oro rosa"))
    update_profile = UpdateProfile(repo)
    update_profile(user_id, {"full_name": "Ana Torres", "preferences": prefs})

    returned = update_profile(user_id, {"accept_privacy_version": "2026-10"})

    db_session.expire_all()
    stored = repo.get(user_id)
    assert returned == stored
    assert (stored.full_name, stored.preferences) == ("Ana Torres", prefs)
    assert stored.privacy_version == "2026-10"
    assert stored.privacy_accepted_at is not None
    raw = db_session.scalar(
        text("SELECT preferences FROM app.profiles WHERE user_id = :id"), {"id": user_id}
    )
    assert raw["budget_min"] == 300000  # céntimos, no Money


@pytest.mark.parametrize("values", [{"role": "root"}, {"preferences": []}])
def test_profiles_table_enforces_its_checks(db_session: Session, values: dict[str, object]) -> None:
    user_id = uuid4()
    SqlProfileRepository(db_session).add_if_absent(user_id)

    with pytest.raises(IntegrityError):
        db_session.execute(update(ProfileRow).filter_by(user_id=user_id).values(**values))


def test_get_me_twice_with_same_token_then_patch_through_the_api(
    db_engine: Engine, committed_user: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    use_test_auth(monkeypatch)
    monkeypatch.setattr(db, "get_engine", lambda: db_engine)
    client = TestClient(create_app())
    headers = {"Authorization": f"Bearer {make_token(str(committed_user))}"}

    assert client.get("/api/v1/identity/me", headers=headers).status_code == 200
    assert client.get("/api/v1/identity/me", headers=headers).status_code == 200
    patched = client.patch("/api/v1/identity/me", headers=headers, json={"phone": "987 654 321"})
    reread = client.get("/api/v1/identity/me", headers=headers).json()

    assert patched.status_code == 200
    assert reread["phone"] == "987654321"
    with Session(db_engine) as session:
        assert count_rows(session, committed_user) == 1
