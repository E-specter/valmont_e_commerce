from datetime import UTC, datetime
from uuid import uuid4

import pytest

from tests.identity.identity_helpers import InMemoryProfiles
from valmont.modules.identity.application import EnsureProfile, UpdateProfile
from valmont.modules.identity.domain import Preferences, ProfileError, Role

NOW = datetime(2026, 10, 26, 20, 0, tzinfo=UTC)


def test_ensure_profile_creates_customer_once() -> None:
    repo, user_id = InMemoryProfiles(), uuid4()
    ensure = EnsureProfile(repo)

    first, second = ensure(user_id), ensure(user_id)

    assert first == second
    assert first.role is Role.CUSTOMER
    assert list(repo.rows) == [user_id]


def test_update_profile_changes_only_sent_fields_and_replaces_preferences() -> None:
    repo, user_id = InMemoryProfiles(), uuid4()
    EnsureProfile(repo)(user_id)
    update = UpdateProfile(repo, clock=lambda: NOW)
    update(user_id, {"phone": "+51987654321", "preferences": Preferences(style="clásico")})

    profile = update(user_id, {"preferences": Preferences(materials=("acero",))})

    assert profile.phone == "+51987654321"
    assert profile.preferences == Preferences(materials=("acero",))
    assert profile.privacy_accepted_at is None


def test_accept_privacy_version_sets_server_time() -> None:
    repo, user_id = InMemoryProfiles(), uuid4()
    EnsureProfile(repo)(user_id)

    profile = UpdateProfile(repo, clock=lambda: NOW)(user_id, {"accept_privacy_version": "2026-10"})

    assert (profile.privacy_version, profile.privacy_accepted_at) == ("2026-10", NOW)


def test_update_profile_normalizes_texts_for_any_caller() -> None:
    repo, user_id = InMemoryProfiles(), uuid4()
    EnsureProfile(repo)(user_id)
    update = UpdateProfile(repo, clock=lambda: NOW)

    profile = update(user_id, {"full_name": " Ana  Torres ", "accept_privacy_version": " v1 "})

    assert (profile.full_name, profile.privacy_version) == ("Ana Torres", "v1")
    with pytest.raises(ProfileError):
        update(user_id, {"phone": "987654321\x00"})
    assert repo.get(user_id).phone is None
