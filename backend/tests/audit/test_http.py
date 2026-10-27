from fastapi.testclient import TestClient
from sqlalchemy.sql import Insert

from valmont.main import create_app
from valmont.modules.audit.adapters.http import AuditRecorderDep
from valmont.modules.audit.domain import AuditEntry
from valmont.shared.db import SessionDep, get_session


class FakeSession:
    def __init__(self) -> None:
        self.statements: list[Insert] = []

    def execute(self, statement: Insert) -> None:
        self.statements.append(statement)


def test_recorder_writes_in_the_request_session_with_its_request_id() -> None:
    # AUDIT-R1: otra sesión sería otra transacción. AUDIT-R4: el X-Request-ID de la solicitud.
    app = create_app()
    app.dependency_overrides[get_session] = FakeSession

    @app.post("/test/audit")
    def audited(session: SessionDep, recorder: AuditRecorderDep) -> list[str | None]:
        recorder.record(AuditEntry("catalog.price_changed", "product", "p-1", after={"price": 1}))
        return [stmt.compile().params["request_id"] for stmt in session.statements]

    response = TestClient(app).post("/test/audit", headers={"X-Request-ID": "req-7"})

    assert response.json() == ["req-7"]
