"""Fixtures de las pruebas del endurecimiento (T-018a/b): el flujo de logs del handler `valmont`."""

import io
import logging
from collections.abc import Iterator

import pytest

from valmont.shared.logs import configure_logging

QUIET = ("sqlalchemy.engine", "httpcore")


@pytest.fixture
def valmont_log() -> Iterator[io.StringIO]:
    """Lo que escribe el handler `valmont` con su formateador real (`caplog` tiene el suyo).

    Restaura el flujo, el nivel de la raíz y los de los loggers silenciados al terminar."""
    configure_logging("INFO")
    root = logging.getLogger()
    handler = next(h for h in root.handlers if h.get_name() == "valmont")
    saved = {name: logging.getLogger(name).level for name in ("", *QUIET)}
    stream = io.StringIO()
    previous = handler.setStream(stream)
    yield stream
    handler.setStream(previous)
    for name, level in saved.items():
        logging.getLogger(name).setLevel(level)
