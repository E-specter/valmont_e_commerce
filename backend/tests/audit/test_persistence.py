from uuid import uuid4

import pytest
from sqlalchemy import Engine, func, insert, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from valmont.modules.audit.adapters.persistence import AuditLogRow, SqlAuditRecorder
from valmont.modules.audit.domain import AuditEntry
from valmont.shared.logs import request_id_var

pytestmark = pytest.mark.integration

# Ninguna prueba confirma filas: la tabla no admite DELETE y quedarían para siempre en la BD.
SNAPSHOT = text("SELECT * FROM app.audit_log WHERE entity_id = :id")


def make_entry(**changes: object) -> AuditEntry:
    fields = {"action": "catalog.price_changed", "entity_type": "product", "after": {"price": 1}}
    return AuditEntry(**{**fields, "entity_id": str(uuid4()), **changes})


def count_rows(session: Session, entity_id: str) -> int:
    query = select(func.count()).select_from(AuditLogRow).filter_by(entity_id=entity_id)
    return session.scalar(query)


@pytest.mark.parametrize(("current", "stored"), [("req-123", "req-123"), ("-", None)])
def test_record_inserts_every_field_with_server_time_and_request_id(
    db_session: Session, current: str, stored: str | None
) -> None:
    entry = make_entry(actor_id=uuid4(), actor_role="admin", before={"price": 0})
    token = request_id_var.set(current)
    try:
        SqlAuditRecorder(db_session).record(entry)
    finally:
        request_id_var.reset(token)

    row = db_session.scalars(select(AuditLogRow).filter_by(entity_id=entry.entity_id)).one()
    assert (row.action, row.entity_type, row.actor_id, row.actor_role) == (
        entry.action,
        entry.entity_type,
        entry.actor_id,
        entry.actor_role,
    )
    assert (row.before, row.after, row.request_id) == (entry.before, entry.after, stored)
    # now() es el inicio de la transacción: solo coincide si la hora la puso el servidor.
    assert row.occurred_at == db_session.scalar(select(func.now()))


def test_missing_before_is_stored_as_sql_null_not_json_null(db_session: Session) -> None:
    entry = make_entry()
    SqlAuditRecorder(db_session).record(entry)

    query = text("SELECT before IS NULL FROM app.audit_log WHERE entity_id = :id")
    assert db_session.scalar(query, {"id": entry.entity_id}) is True


def test_rollback_of_the_audited_operation_leaves_no_row(db_engine: Engine) -> None:
    entry = make_entry()

    with pytest.raises(RuntimeError), Session(db_engine) as session, session.begin():
        SqlAuditRecorder(session).record(entry)
        assert count_rows(session, entry.entity_id) == 1
        raise RuntimeError("falla la operación auditada")

    with Session(db_engine) as session:
        assert count_rows(session, entry.entity_id) == 0


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE app.audit_log SET after = '{}' WHERE entity_id = :id",
        "DELETE FROM app.audit_log WHERE entity_id = :id",
        "TRUNCATE app.audit_log",
    ],
)
def test_audit_log_rejects_update_delete_and_truncate(db_session: Session, statement: str) -> None:
    # Con el usuario de la conexión de pruebas, propietario de la tabla: el peor caso disponible.
    entry = make_entry()
    SqlAuditRecorder(db_session).record(entry)
    original = db_session.execute(SNAPSHOT, {"id": entry.entity_id}).all()

    with pytest.raises(DBAPIError, match="solo inserción"), db_session.begin_nested():
        db_session.execute(text(statement), {"id": entry.entity_id})

    assert db_session.execute(SNAPSHOT, {"id": entry.entity_id}).all() == original


@pytest.mark.parametrize(
    "values",
    [
        {"action": "Catalog.price-changed", "after": {"price": 1}},
        {"action": "catalog.price_changed\n", "after": {"price": 1}},
        {"action": "catalog.price_changed"},
    ],
)
def test_audit_log_checks_reject_what_the_domain_rejects(
    db_session: Session, values: dict[str, object]
) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(AuditLogRow).values(entity_type="product", entity_id="p-1", **values)
        )
