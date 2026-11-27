"""Puertos de payments y pasarela simulada (T-092; PAYMENTS-R12, D-043; CA-PAYMENTS-02 tabla de R12,
CA-PAYMENTS-12). Sin BD. La pasarela decide solo por los 4 últimos dígitos, sin azar ni reloj, y
nunca recibe ni guarda el número completo ni el CVV."""

import ast
import dataclasses
import inspect
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from valmont.modules.orders.application import PayableOrder
from valmont.modules.payments import application as ports
from valmont.modules.payments.adapters import simulated_gateway as gateway_module
from valmont.modules.payments.adapters.simulated_gateway import SimulatedGateway
from valmont.modules.payments.application import (
    GatewayCharge,
    GatewayResult,
    OrderPayments,
    PaymentAttemptRepository,
    PaymentGateway,
    PaymentResult,
)
from valmont.modules.payments.domain import (
    GATEWAY_SIMULATED,
    AttemptStatus,
    FailureCode,
    GatewayUnavailable,
    PaymentAttempt,
    PaymentMethod,
    new_attempt,
)

SOURCE = Path(inspect.getsourcefile(gateway_module) or "")

TABLE = {
    "0002": FailureCode.CARD_DECLINED,
    "9995": FailureCode.INSUFFICIENT_FUNDS,
    "0069": FailureCode.EXPIRED_CARD,
}
APPROVED = [
    "4242",
    "0000",
    "0001",
    "0003",
    "1234",
    "9999",
    "9994",
    "9996",
    "0068",
    "0070",
    "0118",
    "0120",
    "2000",
    "0200",
    "2002",
    "5555",
]
CARD_DATA_NAMES = {"cvv", "cvc", "cvv2", "card_number", "pan", "number", "expiry", "exp_month"}


def charge(last4: str, *, amount: int = 250000, reference: UUID | None = None) -> GatewayCharge:
    return GatewayCharge(reference or uuid4(), amount, PaymentMethod(last4))


# --- tabla de D-043 ------------------------------------------------------------------------


@pytest.mark.parametrize(("last4", "code"), list(TABLE.items()))
def test_the_special_cards_are_rejected_with_their_reason(last4: str, code: FailureCode) -> None:
    result = SimulatedGateway().authorize(charge(last4))
    assert result == GatewayResult(code)
    assert result.failure_code is code
    assert result.approved is False


def test_0119_means_the_gateway_is_down() -> None:
    with pytest.raises(GatewayUnavailable):
        SimulatedGateway().authorize(charge("0119"))


def test_the_unavailable_message_does_not_repeat_the_card_digits() -> None:
    with pytest.raises(GatewayUnavailable) as exc:
        SimulatedGateway().authorize(charge("0119"))
    assert "0119" not in str(exc.value) and "0119" not in repr(exc.value)


@pytest.mark.parametrize("last4", APPROVED)
def test_every_other_card_is_approved(last4: str) -> None:
    result = SimulatedGateway().authorize(charge(last4))
    assert result == GatewayResult(None)
    assert result.failure_code is None
    assert result.approved is True


def test_all_ten_thousand_endings_follow_the_table() -> None:
    gateway = SimulatedGateway()
    for n in range(10_000):
        last4 = f"{n:04d}"
        if last4 == "0119":
            with pytest.raises(GatewayUnavailable):
                gateway.authorize(charge(last4))
        else:
            assert gateway.authorize(charge(last4)).failure_code == TABLE.get(last4)


def test_the_outcome_is_deterministic() -> None:
    gateway = SimulatedGateway()
    for last4 in [*TABLE, *APPROVED]:
        results = {gateway.authorize(charge(last4)) for _ in range(25)}
        assert len(results) == 1
    assert SimulatedGateway().authorize(charge("0002")) == gateway.authorize(charge("0002"))


def test_the_outcome_does_not_depend_on_amount_or_reference() -> None:
    gateway = SimulatedGateway()
    for amount in (1, 250000, 10**9):
        assert gateway.authorize(charge("0002", amount=amount)).failure_code is (
            FailureCode.CARD_DECLINED
        )
        assert gateway.authorize(charge("4242", amount=amount)).approved


def test_the_simulated_gateway_satisfies_the_port() -> None:
    gateway: PaymentGateway = SimulatedGateway()
    assert gateway.name == "simulated" == GATEWAY_SIMULATED
    assert SimulatedGateway.name == "simulated"
    assert callable(gateway.authorize)
    assert list(inspect.signature(SimulatedGateway.authorize).parameters) == ["self", "charge"]
    # El nombre cabe en PaymentAttempt.gateway (1-30 caracteres).
    assert 1 <= len(gateway.name) <= 30


# --- sin número completo, CVV, estado ni efectos -------------------------------------------


def test_the_gateway_takes_a_charge_with_only_the_last_four_digits() -> None:
    assert [f.name for f in dataclasses.fields(GatewayCharge)] == ["reference", "amount", "method"]
    assert [f.name for f in dataclasses.fields(PaymentMethod)] == ["card_last4"]
    params = inspect.signature(SimulatedGateway.authorize).parameters
    assert not CARD_DATA_NAMES & set(params)
    assert not CARD_DATA_NAMES & {f.name for f in dataclasses.fields(GatewayCharge)}


def test_the_gateway_source_has_no_card_number_cvv_or_io() -> None:
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    identifiers: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            identifiers.add(node.id.lower())
        elif isinstance(node, ast.Attribute):
            identifiers.add(node.attr.lower())
        elif isinstance(node, ast.arg):
            identifiers.add(node.arg.lower())
        elif isinstance(node, ast.keyword) and node.arg:
            identifiers.add(node.arg.lower())
    assert not CARD_DATA_NAMES & identifiers
    assert not {"print", "open", "input", "eval", "exec", "logger", "logging"} & identifiers

    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
    # Sin azar, reloj, red ni archivos; solo el dominio y los puertos del propio módulo.
    assert set(imported) <= {
        "valmont.modules.payments.application",
        "valmont.modules.payments.domain",
    }


def test_the_gateway_keeps_no_state_and_stores_nothing_about_the_card() -> None:
    gateway = SimulatedGateway()
    before = dict(vars(gateway))
    for last4 in ("4242", "0002", "9995", "0069"):
        gateway.authorize(charge(last4))
    with pytest.raises(GatewayUnavailable):
        gateway.authorize(charge("0119"))
    assert vars(gateway) == before == {}
    assert {k for k in vars(SimulatedGateway) if not k.startswith("__")} == {"name", "authorize"}


def test_the_gateway_rejects_a_full_card_number_by_construction() -> None:
    # PaymentMethod ya no deja pasar 16 dígitos: la pasarela jamás los ve.
    with pytest.raises(ValueError):
        PaymentMethod("4242424242424242")
    with pytest.raises(TypeError):
        SimulatedGateway().authorize(  # type: ignore[call-arg]
            charge("4242"), card_number="4242424242424242", cvv="123"
        )


# --- tipos del puerto ----------------------------------------------------------------------


def test_gateway_result_approved_reflects_the_failure_code() -> None:
    assert GatewayResult(None).approved is True
    for code in FailureCode:
        assert GatewayResult(code).approved is False
    assert [f.name for f in dataclasses.fields(GatewayResult)] == ["failure_code"]


def test_gateway_charge_and_result_are_frozen() -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        charge("4242").amount = 1  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        GatewayResult(None).failure_code = FailureCode.CARD_DECLINED  # type: ignore[misc]


def test_the_ports_are_protocols_with_the_contract_members() -> None:
    assert getattr(PaymentGateway, "_is_protocol", False)
    assert getattr(PaymentAttemptRepository, "_is_protocol", False)
    assert "name" in PaymentGateway.__annotations__
    assert {"authorize"} <= set(vars(PaymentGateway))
    assert {"add", "find_by_key", "list_for_order", "count_rejected"} <= set(
        vars(PaymentAttemptRepository)
    )
    assert list(inspect.signature(PaymentAttemptRepository.add).parameters) == ["self", "attempt"]
    assert list(inspect.signature(PaymentAttemptRepository.find_by_key).parameters) == [
        "self",
        "user_id",
        "key",
    ]
    assert list(inspect.signature(PaymentAttemptRepository.list_for_order).parameters) == [
        "self",
        "user_id",
        "order_id",
    ]
    assert list(inspect.signature(PaymentAttemptRepository.count_rejected).parameters) == [
        "self",
        "user_id",
        "order_id",
    ]


def test_the_result_types_have_the_contract_fields() -> None:
    assert [f.name for f in dataclasses.fields(PaymentResult)] == ["attempt", "created"]
    assert [f.name for f in dataclasses.fields(OrderPayments)] == [
        "order",
        "attempts",
        "can_pay",
        "attempts_left",
    ]
    hints = {f.name: f.type for f in dataclasses.fields(OrderPayments)}
    assert hints["order"] in (PayableOrder, "PayableOrder")
    assert {"PaymentAttempt"} <= {PaymentAttempt.__name__}
    assert ports.PayableOrder is PayableOrder


def test_a_rejected_result_carries_its_reason_and_an_approved_one_does_not() -> None:
    # Contrato del puerto: motivo presente <=> rechazo, y ese par alimenta `new_attempt`.
    for last4 in ["4242", *TABLE]:
        result = SimulatedGateway().authorize(charge(last4))
        assert (result.failure_code is not None) == (not result.approved)
        made = new_attempt(
            attempt_id=uuid4(),
            order_id=uuid4(),
            user_id=uuid4(),
            idempotency_key="idem-0123456789abcdef",
            amount=1000,
            method=PaymentMethod(last4),
            gateway=GATEWAY_SIMULATED,
            failure_code=result.failure_code,
        )
        expected = AttemptStatus.APPROVED if result.approved else AttemptStatus.REJECTED
        assert made.status is expected
        assert made.failure_code is TABLE.get(last4)
