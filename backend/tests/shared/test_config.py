from pathlib import Path

import pytest
from pydantic import ValidationError

from valmont.shared.config import Settings


def test_settings_load_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    settings = Settings(_env_file=None)

    assert (settings.environment, settings.log_level) == ("test", "DEBUG")


def test_settings_ignore_unknown_keys_in_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("DATABASE_URL=postgresql://x\nLOG_LEVEL=WARNING\n", encoding="utf-8")

    assert Settings(_env_file=env_file).log_level == "WARNING"


def test_settings_reject_unknown_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "staging")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)
