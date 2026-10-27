import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from valmont.main import create_app
from valmont.shared import db
from valmont.shared.config import Settings
from valmont.shared.db import SessionDep
from valmont.shared.errors import AppError


def test_engine_requires_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(db, "get_settings", lambda: Settings(_env_file=None))
    db.get_engine.cache_clear()

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        db.get_engine()


@pytest.fixture
def app(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setattr(db, "get_engine", lambda: db_engine)
    app = create_app()

    @app.post("/test/deferred-violation")
    def deferred_violation(session: SessionDep, fail: bool = False) -> dict[str, str]:
        # Una restricción diferida solo se comprueba en el COMMIT.
        session.execute(text("CREATE TEMP TABLE t (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)"))
        session.execute(text("INSERT INTO t VALUES (1), (1)"))
        if fail:
            raise AppError("conflict", "Fallo de negocio.", status_code=409)
        return {"status": "ok"}

    return app


@pytest.mark.integration
def test_commit_failure_returns_500_before_any_200_is_sent(app: FastAPI) -> None:
    response = TestClient(app, raise_server_exceptions=False).post("/test/deferred-violation")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"


@pytest.mark.integration
def test_error_in_endpoint_rolls_back_instead_of_committing(app: FastAPI) -> None:
    response = TestClient(app, raise_server_exceptions=False).post(
        "/test/deferred-violation", params={"fail": True}
    )

    # Un commit habría fallado por la restricción diferida y devuelto 500.
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
