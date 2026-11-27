from fastapi import FastAPI

from valmont.modules.cart.adapters import http as cart_http
from valmont.modules.catalog.adapters import admin_http as catalog_admin_http
from valmont.modules.catalog.adapters import http as catalog_http
from valmont.modules.identity.adapters import http as identity_http
from valmont.modules.inventory.adapters import admin_http as inventory_admin_http
from valmont.modules.orders.adapters import admin_http as orders_admin_http
from valmont.modules.orders.adapters import http as orders_http
from valmont.modules.payments.adapters import http as payments_http
from valmont.modules.promotions.adapters import admin_http as promotions_admin_http
from valmont.modules.wishlist.adapters import http as wishlist_http
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
    app.include_router(catalog_http.router)
    app.include_router(catalog_admin_http.router)
    app.include_router(inventory_admin_http.router)
    app.include_router(promotions_admin_http.router)
    app.include_router(cart_http.router)
    app.include_router(wishlist_http.router)
    app.include_router(orders_admin_http.router)  # antes: `/admin` no lo captura `/{order_id}`
    app.include_router(orders_http.router)
    app.include_router(payments_http.router)
    return app


app = create_app()
