from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Money(BaseModel):
    """Dinero en la API: céntimos enteros (sin float) y una sola moneda en el MVP."""

    # T-019: en la salida currency siempre viaja, así que el OpenAPI la marca obligatoria
    # (Money-Output); en la entrada sigue siendo opcional con PEN por defecto (Money-Input).
    model_config = ConfigDict(
        extra="forbid", frozen=True, json_schema_serialization_defaults_required=True
    )

    amount: int = Field(ge=0, strict=True)
    currency: Literal["PEN"] = "PEN"
