import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from valmont.main import create_app
from valmont.shared.errors import AppError


@pytest.fixture
def app() -> FastAPI:
    app = create_app()

    @app.get("/test/app-error")
    def raise_app_error() -> None:
        raise AppError("out_of_stock", "Sin stock.", status_code=409, details={"sku": "A1"})

    @app.get("/test/crash")
    def crash() -> None:
        raise RuntimeError("detalle interno")

    @app.get("/test/items/{item_id}")
    def get_item(item_id: int) -> dict[str, int]:
        return {"item_id": item_id}

    return app


def test_app_error_returns_common_format_with_its_status(app: FastAPI) -> None:
    response = TestClient(app).get("/test/app-error")

    assert response.status_code == 409
    assert response.json() == {
        "error": {"code": "out_of_stock", "message": "Sin stock.", "details": {"sku": "A1"}}
    }


def test_validation_error_returns_422_with_errors_in_details(app: FastAPI) -> None:
    response = TestClient(app).get("/test/items/abc")

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"][0]["loc"] == ["path", "item_id"]
    assert "input" not in error["details"][0]


@pytest.mark.parametrize(
    ("method", "path", "status", "code"),
    [("GET", "/nope", 404, "not_found"), ("POST", "/health", 405, "method_not_allowed")],
)
def test_http_errors_use_common_format(
    app: FastAPI, method: str, path: str, status: int, code: str
) -> None:
    response = TestClient(app).request(method, path)

    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert "X-Request-ID" in response.headers


def test_unhandled_error_returns_500_without_trace_and_logs_it(
    app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get("/test/crash", headers={"X-Request-ID": "crash-1"})

    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "internal_error",
            "message": "Error interno del servidor.",
            "details": None,
        }
    }
    assert response.headers["X-Request-ID"] == "crash-1"
    [logged] = [r for r in caplog.records if r.exc_info]
    assert str(logged.exc_info[1]) == "detalle interno"
    assert logged.request_id == "crash-1"
