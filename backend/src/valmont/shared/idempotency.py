from typing import Annotated

from fastapi import Header
from pydantic import AfterValidator

IDEMPOTENCY_KEY_PATTERN = r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"

# Solo un UUID (T-018c, D-H1); mayúsculas y minúsculas son la misma clave.
IdempotencyKey = Annotated[
    str,
    Header(alias="idempotency-key", min_length=36, max_length=36, pattern=IDEMPOTENCY_KEY_PATTERN),
    AfterValidator(str.lower),
]
