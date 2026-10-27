from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Money(BaseModel):
    """Dinero en la API: céntimos enteros (sin float) y una sola moneda en el MVP."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    amount: int = Field(ge=0, strict=True)
    currency: Literal["PEN"] = "PEN"
