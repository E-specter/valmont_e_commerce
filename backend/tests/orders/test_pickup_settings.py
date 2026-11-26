"""Datos de la boutique del recojo en `Settings` (T-071; E-4, ORDERS-R20 H-1). Sin BD: se
construye `Settings` con el entorno controlado, sin leer el `.env` real."""

import re
from pathlib import Path

import pytest

from valmont.shared.config import Settings

BACKEND = Path(__file__).resolve().parents[2]
VARIABLES = {
    "PICKUP_STORE_NAME": "pickup_store_name",
    "PICKUP_STORE_ADDRESS": "pickup_store_address",
    "PICKUP_STORE_HOURS": "pickup_store_hours",
}


@pytest.fixture(autouse=True)
def clean_pickup_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in VARIABLES:
        monkeypatch.delenv(variable, raising=False)


def test_the_three_pickup_settings_default_to_none() -> None:
    settings = Settings(_env_file=None)

    assert (
        settings.pickup_store_name,
        settings.pickup_store_address,
        settings.pickup_store_hours,
    ) == (None, None, None)


def test_the_three_pickup_settings_read_their_environment_variables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PICKUP_STORE_NAME", "Boutique Valmont Miraflores")
    monkeypatch.setenv("PICKUP_STORE_ADDRESS", "Av. Larco 1234, Miraflores, Lima")
    monkeypatch.setenv("PICKUP_STORE_HOURS", "Lunes a sábado, 10:00 a 19:00")

    settings = Settings(_env_file=None)

    assert settings.pickup_store_name == "Boutique Valmont Miraflores"
    assert settings.pickup_store_address == "Av. Larco 1234, Miraflores, Lima"
    assert settings.pickup_store_hours == "Lunes a sábado, 10:00 a 19:00"


def test_the_pickup_settings_read_the_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "PICKUP_STORE_NAME=Boutique\nPICKUP_STORE_ADDRESS=Calle 1\nPICKUP_STORE_HOURS=10 a 19\n",
        encoding="utf-8",
    )

    settings = Settings(_env_file=env_file)

    assert (
        settings.pickup_store_name,
        settings.pickup_store_address,
        settings.pickup_store_hours,
    ) == ("Boutique", "Calle 1", "10 a 19")


def test_each_pickup_setting_is_independent(monkeypatch: pytest.MonkeyPatch) -> None:
    # Cada una puede faltar sola: decidir si el recojo está disponible es del puerto (T-074).
    monkeypatch.setenv("PICKUP_STORE_NAME", "Boutique")

    settings = Settings(_env_file=None)

    assert settings.pickup_store_name == "Boutique"
    assert (settings.pickup_store_address, settings.pickup_store_hours) == (None, None)


def test_the_pickup_settings_are_plain_text_not_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PICKUP_STORE_NAME", "Boutique")
    settings = Settings(_env_file=None)
    assert type(settings.pickup_store_name) is str  # no SecretStr: el detalle del pedido lo muestra


def test_existing_settings_are_untouched_by_the_new_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    monkeypatch.setenv("PICKUP_STORE_NAME", "Boutique")

    settings = Settings(_env_file=None)

    assert settings.log_level == "WARNING"
    assert settings.environment == "dev"


def test_env_example_documents_the_three_variables_without_values() -> None:
    lines = (BACKEND / ".env.example").read_text(encoding="utf-8").splitlines()
    for variable in VARIABLES:
        documented = [ln for ln in lines if re.match(rf"\s*#?\s*{variable}=", ln)]
        assert documented, f"{variable} no está documentada en backend/.env.example"
        for line in documented:
            assert line.split("=", 1)[1].strip() == "", f"{variable} lleva un valor real"
