"""Pasarela simulada (SPEC R12, D-043): decide solo por `card_last4`; sin azar, reloj ni E/S."""

from valmont.modules.payments.application import GatewayCharge, GatewayResult
from valmont.modules.payments.domain import FailureCode, GatewayUnavailable

_REJECTIONS = {
    "0002": FailureCode.CARD_DECLINED,
    "9995": FailureCode.INSUFFICIENT_FUNDS,
    "0069": FailureCode.EXPIRED_CARD,
}


class SimulatedGateway:
    name = "simulated"

    def authorize(self, charge: GatewayCharge) -> GatewayResult:
        last4 = charge.method.card_last4
        if last4 == "0119":
            raise GatewayUnavailable("Pasarela no disponible")
        return GatewayResult(_REJECTIONS.get(last4))
