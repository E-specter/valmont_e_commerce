import logging
import re

import pytest
from fastapi.testclient import TestClient

from valmont.main import create_app
from valmont.shared.logs import LOG_FORMAT


@pytest.fixture
def client() -> TestClient:
    app = create_app()

    @app.get("/test/logs")
    def emit_log() -> dict[str, str]:
        logging.getLogger("valmont.test").info("dentro de la solicitud")
        return {}

    return TestClient(app)


def test_valid_incoming_request_id_is_reused(client: TestClient) -> None:
    response = client.get("/health", headers={"X-Request-ID": "Abc-123"})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "Abc-123"


@pytest.mark.parametrize(
    "headers",
    [{}, {"X-Request-ID": "a" * 65}, {"X-Request-ID": "abc\n"}, {"X-Request-ID": "a_b c"}],
)
def test_missing_or_invalid_request_id_is_replaced(
    client: TestClient, headers: dict[str, str]
) -> None:
    response = client.get("/health", headers=headers)

    assert re.fullmatch(r"[0-9a-f]{32}", response.headers["X-Request-ID"])


def test_every_log_line_of_the_request_carries_its_id(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)

    client.get("/test/logs", headers={"X-Request-ID": "trace-1"})

    records = [r for r in caplog.records if r.name.startswith("valmont")]
    assert [r.getMessage() for r in records] == ["dentro de la solicitud", "GET /test/logs 200"]
    formatter = logging.Formatter(LOG_FORMAT)
    assert all("[trace-1]" in formatter.format(r) for r in records)
