from typing import Annotated

from fastapi import Depends

from valmont.modules.audit.adapters.persistence import SqlAuditRecorder
from valmont.modules.audit.application import AuditRecorder
from valmont.shared.db import SessionDep


def get_audit_recorder(session: SessionDep) -> AuditRecorder:
    return SqlAuditRecorder(session)


# Sin endpoints (SPEC §7). FastAPI comparte el SessionDep de la solicitud: misma transacción.
AuditRecorderDep = Annotated[AuditRecorder, Depends(get_audit_recorder)]
