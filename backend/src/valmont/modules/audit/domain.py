import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

ENTITY_TYPE_MAX = 60
ENTITY_ID_MAX = 120

# AUDIT-R3: <módulo>.<verbo_en_pasado>. La migración 0003 repite el patrón en un CHECK.
_ACTION = re.compile(r"[a-z]+\.[a-z_]+")


@dataclass(frozen=True)
class AuditEntry:
    """Una operación crítica: quién (actor_id nulo = sistema, AUDIT-R5) cambió qué y cómo."""

    action: str
    entity_type: str
    entity_id: str
    actor_id: UUID | None = None
    actor_role: str | None = None
    before: dict[str, Any] | None = None  # AUDIT-R2: solo los campos que cambian
    after: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if not _ACTION.fullmatch(self.action):
            raise ValueError("La acción debe tener la forma <módulo>.<verbo_en_pasado>.")
        if not 1 <= len(self.entity_type) <= ENTITY_TYPE_MAX:
            raise ValueError(f"entity_type debe tener entre 1 y {ENTITY_TYPE_MAX} caracteres.")
        if not 1 <= len(self.entity_id) <= ENTITY_ID_MAX:
            raise ValueError(f"entity_id debe tener entre 1 y {ENTITY_ID_MAX} caracteres.")
        if self.before is None and self.after is None:
            raise ValueError("Se necesita before, after o ambos (AUDIT-R6).")
