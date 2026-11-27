import io
import logging
import re
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from tests.shared.hardening_helpers import HEX32
from valmont.main import create_app
from valmont.modules.audit.adapters.http import AuditRecorderDep
from valmont.modules.audit.domain import AuditEntry
from valmont.shared.db import SessionDep, get_session
from valmont.shared.logs import (
    LOG_FORMAT,
    QUIET_LOGGERS,
    SafeFormatter,
    configure_logging,
    redact_db_detail,
)

UUID_ID = "7e3a1c5d-0b2f-4c8e-9d41-5a6b7c8d9e0f"
HEX_ID = "0123456789abcdef0123456789abcdef"
PAN = "4111111111111111"
# Valores que el servidor nunca debe reutilizar como identificador de solicitud (T-018b, prueba 4).
BAD_IDS = [
    "1234567890123456",  # solo numérico
    "abc-123",
    "a" * 64,
    "a" * 65,
    "abc\n",
    "trace\nINFO falsa linea de log",
    "con\x00nulo",
    "con\ttabulador",
    "a_b c",
    "4111111111111",  # 13 dígitos
    "4111111111111111111",  # 19 dígitos
    PAN,
    "4111-1111-1111-1111",
    "7e3a1c5d-0b2f-4c8e-9d41-5a6b7c8d9e0",  # 31 hex con guiones: grupo corto
    "7e3a1c5d-0b2f-4c8e-9d41-5a6b7c8d9e0f0",  # grupo largo
    "7e3a1c5d0b2f4c8e9d415a6b7c8d9e0",  # 31 hex
    "7e3a1c5d0b2f4c8e9d415a6b7c8d9e0f0",  # 33 hex
    "g" * 32,  # 32 caracteres no hexadecimales
    "urn:uuid:" + UUID_ID,
    "{" + UUID_ID + "}",
    UUID_ID + " ",
    "Abc-123",  # el patrón anterior `[A-Za-z0-9-]{1,64}` lo admitía
    "trace-1",
]


@pytest.fixture
def client() -> TestClient:
    app = create_app()

    @app.get("/test/logs")
    def emit_log() -> dict[str, str]:
        logging.getLogger("valmont.test").info("dentro de la solicitud")
        return {}

    return TestClient(app)


@pytest.mark.parametrize("request_id", [UUID_ID, HEX_ID])
def test_valid_incoming_request_id_is_reused(client: TestClient, request_id: str) -> None:
    response = client.get("/health", headers={"X-Request-ID": request_id})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == request_id


@pytest.mark.parametrize("headers", [{}, *({"X-Request-ID": value} for value in BAD_IDS)])
def test_missing_or_invalid_request_id_is_replaced(
    client: TestClient, headers: dict[str, str]
) -> None:
    response = client.get("/health", headers=headers)

    assert re.fullmatch(r"[0-9a-f]{32}", response.headers["X-Request-ID"])
    assert response.headers["X-Request-ID"] != headers.get("X-Request-ID")


def test_every_log_line_of_the_request_carries_its_id(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)

    client.get("/test/logs", headers={"X-Request-ID": UUID_ID})

    records = [r for r in caplog.records if r.name.startswith("valmont")]
    assert [r.getMessage() for r in records] == ["dentro de la solicitud", "GET /test/logs 200"]
    formatter = logging.Formatter(LOG_FORMAT)
    assert all(f"[{UUID_ID}]" in formatter.format(r) for r in records)


@pytest.mark.parametrize("bad", BAD_IDS)
def test_a_rejected_request_id_never_reaches_the_logs_and_the_new_one_does(
    client: TestClient, valmont_log: io.StringIO, bad: str
) -> None:
    response = client.get("/test/logs", headers={"X-Request-ID": bad})

    new_id = response.headers["X-Request-ID"]
    output = valmont_log.getvalue()
    assert HEX32.fullmatch(new_id)
    assert f"[{new_id}]" in output
    assert bad not in output
    # una línea de log falsa inyectada por el encabezado no debe existir
    assert "falsa linea de log" not in output
    assert all(line.startswith("20") or not line for line in output.splitlines())


@pytest.mark.parametrize("request_id", [UUID_ID, HEX_ID])
def test_a_valid_request_id_is_in_the_log_line(
    client: TestClient, valmont_log: io.StringIO, request_id: str
) -> None:
    client.get("/test/logs", headers={"X-Request-ID": request_id})

    assert f"[{request_id}] valmont.test: dentro de la solicitud" in valmont_log.getvalue()


@pytest.mark.parametrize("bad", [PAN, "1234567890123456", "abc-123", "a" * 64])
def test_a_replaced_request_id_is_the_one_audit_records(bad: str) -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.statements: list[object] = []

        def execute(self, statement: object) -> None:
            self.statements.append(statement)

    app = create_app()
    app.dependency_overrides[get_session] = FakeSession

    @app.post("/test/audit")
    def audited(session: SessionDep, recorder: AuditRecorderDep) -> list[str | None]:
        recorder.record(AuditEntry("catalog.price_changed", "product", str(uuid4()), after={}))
        return [stmt.compile().params["request_id"] for stmt in session.statements]

    response = TestClient(app).post("/test/audit", headers={"X-Request-ID": bad})

    [recorded] = response.json()
    assert recorded == response.headers["X-Request-ID"]
    assert HEX32.fullmatch(recorded)
    assert recorded != bad


# --- configure_logging: sqlalchemy.engine y httpcore nunca bajan de WARNING ---


def test_quiet_loggers_are_the_expected_ones() -> None:
    assert set(QUIET_LOGGERS) == {"sqlalchemy.engine", "httpcore"}


@pytest.mark.parametrize("level", ["DEBUG", "INFO", "WARNING"])
def test_configure_logging_keeps_the_quiet_loggers_at_warning(
    valmont_log: io.StringIO, level: str
) -> None:
    configure_logging(level)

    assert logging.getLogger().level == getattr(logging, level)
    for name in QUIET_LOGGERS:
        assert logging.getLogger(name).getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("sqlalchemy.engine.Engine").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpcore.http11").getEffectiveLevel() == logging.WARNING


def test_the_quiet_loggers_stay_quiet_when_the_handler_already_existed(
    valmont_log: io.StringIO,
) -> None:
    configure_logging("DEBUG")
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.DEBUG)  # alguien los subió

    configure_logging("DEBUG")  # create_app puede repetirse

    for name in QUIET_LOGGERS:
        assert logging.getLogger(name).getEffectiveLevel() == logging.WARNING


def test_with_debug_the_sql_engine_dumps_neither_statements_nor_parameters(
    valmont_log: io.StringIO,
) -> None:
    configure_logging("DEBUG")
    engine = create_engine("sqlite://")  # sin BD externa: el volcado sería idéntico
    leaked = "valor-que-no-debe-salir-9d41"

    with engine.connect() as connection:
        connection.execute(text("SELECT :v AS columna_de_prueba"), {"v": leaked})

    output = valmont_log.getvalue()
    assert leaked not in output
    assert "columna_de_prueba" not in output
    assert "sqlalchemy.engine" not in output
    engine.dispose()


# --- redact_db_detail y el formateador seguro ---

UNIQUE_TRACE = (
    "Traceback (most recent call last):\n"
    '  File "x.py", line 1, in f\n'
    "sqlalchemy.exc.IntegrityError: (psycopg.errors.UniqueViolation) duplicate key value violates "
    'unique constraint "uq_orders_user_id_idempotency_key"\n'
    "DETAIL:  Key (user_id, idempotency_key)=(0f1e2d3c-aaaa-4bbb-8ccc-123456789abc, "
    "clave-privada-4242) already exists.\n"
    "[SQL: INSERT INTO app.orders (user_id) VALUES (%(user_id)s)]\n"
)


def test_redact_db_detail_removes_every_value_and_keeps_the_constraint() -> None:
    result = redact_db_detail(UNIQUE_TRACE)

    assert "clave-privada-4242" not in result
    assert "0f1e2d3c-aaaa-4bbb-8ccc-123456789abc" not in result
    assert "DETAIL:  Key" not in result
    assert "uq_orders_user_id_idempotency_key" in result
    assert "[SQL: INSERT INTO app.orders" in result  # el resto de la traza no se toca


@pytest.mark.parametrize(
    "detail",
    [
        "DETAIL:  Key (product_id)=(9a8b7c6d-1111-4222-8333-abcdefabcdef) is not present in table "
        '"products".',
        "DETAIL:  Failing row contains (valor-secreto-xyz, 12, null).",
        "DETAIL:  Key (email)=(ana.privada@example.com) already exists.",
    ],
)
def test_redact_db_detail_covers_other_detail_shapes(detail: str) -> None:
    result = redact_db_detail(f'violates constraint "c_demo"\n{detail}\n')

    for leaked in ("9a8b7c6d", "valor-secreto-xyz", "ana.privada", "example.com"):
        assert leaked not in result
    assert 'constraint "c_demo"' in result


MULTILINE_VALUES = [
    pytest.param("linea-uno-privada\nlinea-dos-privada", id="un-salto"),
    pytest.param("a-privada\nb-privada\n\nc-privada\nd-privada", id="varios-saltos"),
    pytest.param("a-privada\r\nb-privada\r\nc-privada", id="crlf"),
]
MULTILINE_DETAILS = [
    pytest.param("Key (note)=({value}) already exists.", id="key"),
    pytest.param("Failing row contains (1, {value}, 3).", id="failing-row"),
]


@pytest.mark.parametrize("detail", MULTILINE_DETAILS)
@pytest.mark.parametrize("value", MULTILINE_VALUES)
def test_redact_db_detail_removes_values_that_span_several_lines(value: str, detail: str) -> None:
    trace = (
        'IntegrityError: violates constraint "c_nota"\n'
        f"DETAIL:  {detail.format(value=value)}\n"
        "[SQL: INSERT INTO app.notes (note) VALUES (%(note)s)]\n"
        "(Background on this error at: https://sqlalche.me/e/21/gkpj)\n"
    )

    result = redact_db_detail(trace)

    for fragment in ("privada", "linea-uno", "linea-dos"):
        assert fragment not in result
    assert 'violates constraint "c_nota"' in result
    assert "[SQL: INSERT INTO app.notes (note) VALUES (%(note)s)]" in result
    assert "(Background on this error at: https://sqlalche.me/e/21/gkpj)" in result


@pytest.mark.parametrize("detail", MULTILINE_DETAILS)
@pytest.mark.parametrize("value", MULTILINE_VALUES)
def test_redact_db_detail_at_the_end_of_the_text_without_sql_marker(
    value: str, detail: str
) -> None:
    result = redact_db_detail(
        f'violates constraint "c_nota"\nDETAIL:  {detail.format(value=value)}'
    )

    assert "privada" not in result
    assert 'violates constraint "c_nota"' in result


def test_redact_db_detail_stops_at_the_parameters_marker_too() -> None:
    trace = (
        "DETAIL:  Key (note)=(uno-privada\ndos-privada) already exists.\n"
        "[parameters: {'note': 'x'}]\nresto de la traza\n"
    )

    result = redact_db_detail(trace)

    assert "privada" not in result
    assert "[parameters: {'note': 'x'}]" in result and "resto de la traza" in result


def test_the_formatter_keeps_sqlstate_and_constraint_when_the_value_has_line_breaks() -> None:
    formatter = SafeFormatter(LOG_FORMAT)
    error = FakeDbError("23505", "uq_demo_note", "primera-privada\nsegunda-privada")
    try:
        raise error
    except FakeDbError as exc:
        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "Error", None, None)
        record.exc_info = (type(exc), exc, exc.__traceback__)
        record.request_id = "-"
        output = formatter.format(record)

    assert "privada" not in output
    assert "sqlstate=23505" in output and "constraint=uq_demo_note" in output


def test_redact_db_detail_leaves_text_without_detail_unchanged() -> None:
    plain = "Traceback (most recent call last):\nValueError: dato no valido\n"

    assert redact_db_detail(plain) == plain
    assert redact_db_detail("") == ""


def test_redact_db_detail_is_idempotent() -> None:
    once = redact_db_detail(UNIQUE_TRACE)

    assert redact_db_detail(once) == once


class FakeDiag:
    def __init__(self, sqlstate: str | None, constraint: str | None) -> None:
        self.sqlstate = sqlstate
        self.constraint_name = constraint


class FakeDbError(Exception):
    """Como `psycopg.errors.Error`: lleva `.diag`; su texto trae el `DETAIL` con los valores."""

    def __init__(self, sqlstate: str | None, constraint: str | None, value: str) -> None:
        super().__init__(
            "duplicate key value violates unique constraint "
            f'"{constraint}"\nDETAIL:  Key (code)=({value}) already exists.'
        )
        self.diag = FakeDiag(sqlstate, constraint)


def emit(error: BaseException) -> None:
    """Registra `error` con `logger.exception` en el handler `valmont` y devuelve la salida."""
    try:
        raise error
    except BaseException:
        logging.getLogger("valmont.test").exception("Error no controlado")


def test_the_valmont_handler_uses_the_safe_formatter(valmont_log: io.StringIO) -> None:
    handler = next(h for h in logging.getLogger().handlers if h.get_name() == "valmont")

    assert isinstance(handler.formatter, SafeFormatter)


def test_safe_formatter_redacts_the_detail_and_adds_sqlstate_and_constraint() -> None:
    formatter = SafeFormatter(LOG_FORMAT)
    error = FakeDbError("23505", "uq_demo_code", "valor-unico-7f3a")  # no va en la línea `raise`
    try:
        raise error
    except FakeDbError as exc:
        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "Error", None, None)
        record.exc_info = (type(exc), exc, exc.__traceback__)
        record.request_id = "-"
        output = formatter.format(record)

    assert "valor-unico-7f3a" not in output
    assert "DETAIL:  Key" not in output
    assert "uq_demo_code" in output
    assert "sqlstate=23505" in output and "constraint=uq_demo_code" in output


@pytest.mark.parametrize("how", ["cause", "context", "orig"])
def test_the_db_error_is_found_in_the_whole_chain(how: str, valmont_log: io.StringIO) -> None:
    inner = FakeDbError("23503", "fk_demo_ref", "valor-secreto-xyz")
    try:
        try:
            raise inner
        except FakeDbError as caught:
            if how == "cause":
                raise RuntimeError("envuelto") from caught
            if how == "context":
                raise RuntimeError("envuelto")  # noqa: B904 - el contexto implícito es el caso
            raise IntegrityError("INSERT INTO x VALUES (1)", None, caught) from None
    except Exception:
        logging.getLogger("valmont.test").exception("Error no controlado")

    output = valmont_log.getvalue()
    assert "valor-secreto-xyz" not in output
    assert "sqlstate=23503" in output and "constraint=fk_demo_ref" in output


def test_a_constraint_less_error_prints_a_dash(valmont_log: io.StringIO) -> None:
    emit(FakeDbError("40001", None, "valor-privado-aa11"))

    output = valmont_log.getvalue()
    assert "sqlstate=40001 constraint=-" in output
    assert "valor-privado-aa11" not in output


def test_an_error_that_is_not_from_the_database_is_logged_as_usual(
    valmont_log: io.StringIO,
) -> None:
    emit(ValueError("fallo corriente"))

    output = valmont_log.getvalue()
    assert "ValueError: fallo corriente" in output
    assert "[BD]" not in output


def test_log_format_is_unchanged() -> None:
    assert LOG_FORMAT == "%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s"
