"""Ayudas de la mayoría de edad al crear el pedido (T-139): fechas de prueba y escritura directa de
`birth_date` en `app.profiles`. Los valores son ficticios (ninguno se parece a un secreto)."""

from datetime import date

from sqlalchemy import text
from sqlalchemy.orm import Session

ADULT_BIRTH = date(1990, 5, 17)  # mayor de edad en cualquier día de las pruebas
MINOR_BIRTH = date(2012, 3, 4)  # 14 años en 2026
# Cadenas que no deben aparecer en ninguna respuesta, registro ni fila de auditoría.
MINOR_TEXTS = ("2012-03-04", "2012", "03-04", "04/03")


def set_birth_date(session: Session, user: object, birth_date: date | None) -> None:
    session.execute(
        text("UPDATE app.profiles SET birth_date = :b WHERE user_id = :u"),
        {"b": birth_date, "u": user},
    )


def birth_date_of(session: Session, user: object) -> date | None:
    query = text("SELECT birth_date FROM app.profiles WHERE user_id = :u")
    return session.scalar(query, {"u": user})
