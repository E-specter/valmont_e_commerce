from fastapi import FastAPI


def create_app() -> FastAPI:
    """Raíz de composición: aquí se registran los routers de cada módulo."""
    app = FastAPI(title="Valmont API", version="0.1.0")

    @app.get("/health", tags=["platform"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
