import pytest
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import Catalog, seed_catalog
from valmont.modules.catalog.adapters.persistence import SqlProductRepository


@pytest.fixture
def repo(db_session: Session) -> SqlProductRepository:
    return SqlProductRepository(db_session)


@pytest.fixture
def catalog(db_session: Session) -> Catalog:
    return seed_catalog(db_session)
