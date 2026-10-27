from collections.abc import Iterator
from functools import cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Engine, MetaData, create_engine
from sqlalchemy.orm import DeclarativeBase, Session

from valmont.shared.config import get_settings

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(schema="app", naming_convention=NAMING_CONVENTION)


@cache
def get_engine() -> Engine:
    url = get_settings().database_url
    if not url:
        raise RuntimeError("Falta DATABASE_URL en el entorno (backend/.env).")
    return create_engine(url, pool_pre_ping=True)


def get_session() -> Iterator[Session]:
    """Una transacción por solicitud: commit si todo va bien, rollback y re-raise si no."""
    with Session(get_engine()) as session, session.begin():
        yield session


# scope="function": el commit ocurre antes de enviar la respuesta, así que si falla el
# cliente recibe 500 y nunca un 200 de algo no guardado. Úsese siempre este alias.
SessionDep = Annotated[Session, Depends(get_session, scope="function")]
