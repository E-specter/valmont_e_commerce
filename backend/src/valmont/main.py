from fastapi import FastAPI

from valmont.modules.identity.adapters import http as identity_http
from valmont.shared.config import get_settings
from valmont.shared.errors import register_error_handlers
from valmont.shared.logs import configure_logging, request_id_middleware


def create_app() -> FastAPI:
    """Raíz de composición: aquí se registran los routers de cada módulo."""
    configure_logging(get_settings().log_level)
    app = FastAPI(title="Valmont API", version="0.1.0")
    register_error_handlers(app)
    app.middleware("http")(request_id_middleware)

    @app.get("/health", tags=["platform"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(identity_http.router)
    return app


app = create_app()
