from typing import Protocol

from valmont.modules.audit.domain import AuditEntry


class AuditRecorder(Protocol):
    """Puerto que reciben los casos de uso de otros módulos (modules.md §3, excepción 2)."""

    def record(self, entry: AuditEntry) -> None:
        """Registra la entrada en la transacción en curso de quien llama (AUDIT-R1)."""
        ...
