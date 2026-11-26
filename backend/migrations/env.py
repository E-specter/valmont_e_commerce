from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool, text

# Punto único de registro de modelos: importa aquí el adapters/persistence de cada módulo
# para que autogenerate vea sus tablas, p. ej.:
import valmont.modules.audit.adapters.persistence  # noqa: F401
import valmont.modules.cart.adapters.persistence  # noqa: F401
import valmont.modules.catalog.adapters.persistence  # noqa: F401
import valmont.modules.identity.adapters.persistence  # noqa: F401
import valmont.modules.inventory.adapters.persistence  # noqa: F401
import valmont.modules.promotions.adapters.persistence  # noqa: F401
import valmont.modules.wishlist.adapters.persistence  # noqa: F401
from valmont.shared.db import Base, get_engine

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

if context.is_offline_mode():
    raise SystemExit("El modo --sql no está soportado: las migraciones se aplican en línea.")


def include_name(name: str | None, type_: str, parent_names: dict[str, str | None]) -> bool:
    # Solo el esquema app: auth, storage, public, etc. son de Supabase y no se tocan.
    return name == "app" if type_ == "schema" else True


# Las pruebas pasan su BD en config.attributes; la CLI usa DATABASE_URL.
url = config.attributes.get("database_url")
engine = create_engine(url, poolclass=pool.NullPool) if url else get_engine()

with engine.begin() as connection:
    connection.execute(text("CREATE SCHEMA IF NOT EXISTS app"))
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        include_schemas=True,
        include_name=include_name,
        version_table_schema="app",
    )
    with context.begin_transaction():
        context.run_migrations()
