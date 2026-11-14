"""Load ``data/capabilities.toml`` (the capability contract)."""

from __future__ import annotations

import tomllib
from datetime import date
from decimal import ROUND_CEILING, Decimal
from functools import cache
from importlib.resources import files
from typing import Any, Literal

from pydantic import BaseModel

from mecha.core.models import CredentialKind, ProviderId

Level = Literal["yes", "no", "admin_key", "management_key", "admin_estimate", "error_only"]


class ProbeInfo(BaseModel):
    endpoint: str
    default_model: str
    input_tokens: int
    output_tokens: int
    input_usd_per_mtok: Decimal
    output_usd_per_mtok: Decimal
    prices_checked: date
    prices_source: str
    free_probe: str | None = None

    def usd_per_probe(self) -> Decimal:
        return (
            self.input_tokens * self.input_usd_per_mtok
            + self.output_tokens * self.output_usd_per_mtok
        ) / Decimal(1_000_000)

    def usd_per_month(self, interval_hours: float) -> Decimal:
        """Cost with the scheduler's frequency (30-day month)."""
        per_month = Decimal(str(30 * 24 / interval_hours))
        return self.usd_per_probe() * per_month


def month_label(usd: Decimal) -> str:
    """Rounded *up* to the cent: what decides whether to turn a probe on."""
    if usd < Decimal("0.01"):
        return "< 0.01"
    return str((usd * 100).to_integral_value(rounding=ROUND_CEILING) / 100)


class Capabilities(BaseModel):
    name: str
    validate_: Level
    funds: Level
    expiry: Level
    active_probe: str
    passive: dict[CredentialKind, str]


def _load() -> dict[str, Any]:
    text = files("mecha.data").joinpath("capabilities.toml").read_text(encoding="utf-8")
    return tomllib.loads(text)


@cache
def load_probes() -> dict[ProviderId, ProbeInfo]:
    return {ProviderId(k): ProbeInfo.model_validate(v) for k, v in _load()["probes"].items()}


@cache
def load_capabilities() -> dict[ProviderId, Capabilities]:
    raw = _load()["providers"]
    out: dict[ProviderId, Capabilities] = {}
    for key, value in raw.items():
        value = {**value, "validate_": value.pop("validate")}
        out[ProviderId(key)] = Capabilities.model_validate(value)
    return out
