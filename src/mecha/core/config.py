"""``config.toml`` in MECHA_HOME: defaults, Pydantic validation, warnings for unknown keys.

Environment variables are only for paths and secrets (MECHA_HOME, MECHA_PASSPHRASE[_FILE]);
everything else lives here.

Example::

    [thresholds]
    soon_days = 14
    low_funds_usd = 5

    [scheduler]
    enabled = true
    interval_hours = 6

    [providers.anthropic]
    version = "2026-10-21"
"""

from __future__ import annotations

import logging
import tomllib
from decimal import Decimal
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from mecha.core.errors import MechaError
from mecha.core.paths import data_dir

log = logging.getLogger(__name__)

CONFIG_NAME = "config.toml"


class _Section(BaseModel):
    # Unknown keys are kept (and reported) instead of failing: a typo must not lock you out.
    model_config = ConfigDict(extra="allow", frozen=True)


class ThresholdsConfig(_Section):
    soon_days: int = Field(14, ge=1, le=365)
    low_funds_usd: Decimal = Field(Decimal("5"), ge=0)
    # Length of a full fuse: the same time left looks the same on every card.
    fuse_horizon_days: int = Field(90, ge=1, le=3650)


class SchedulerConfig(_Section):
    enabled: bool = True
    interval_hours: float = Field(6, gt=0, le=24 * 7)
    min_interval_minutes: float = Field(5, ge=0)
    concurrency: int = Field(4, ge=1, le=32)
    per_provider: int = Field(2, ge=1, le=32)


class HttpConfig(_Section):
    timeout_seconds: float = Field(10, gt=0, le=120)
    retries: int = Field(3, ge=0, le=10)
    backoff_seconds: float = Field(0.5, ge=0, le=30)


class AnthropicConfig(_Section):
    version: str = "2026-10-21"


class ProbesConfig(_Section):
    """Active probes. `model = "auto"` picks the cheapest suitable model from the free model
    list; set a model id to pin it. `free = true` uses the free endpoint where one exists
    (Anthropic count_tokens, Gemini countTokens): undocumented whether it sees no-credit."""

    anthropic_model: str = "auto"
    openai_model: str = "auto"
    gemini_model: str = "auto"
    xai_model: str = "auto"
    free: bool = False
    min_interval_minutes: float = Field(60, ge=1)


class ProvidersConfig(_Section):
    anthropic: AnthropicConfig = AnthropicConfig()


class Config(_Section):
    thresholds: ThresholdsConfig = ThresholdsConfig()
    scheduler: SchedulerConfig = SchedulerConfig()
    http: HttpConfig = HttpConfig()
    providers: ProvidersConfig = ProvidersConfig()
    probes: ProbesConfig = ProbesConfig()


class ConfigError(MechaError):
    code = "config"


def unknown_keys(model: BaseModel, prefix: str = "") -> list[str]:
    out = [f"{prefix}{k}" for k in (model.model_extra or {})]
    for name in type(model).model_fields:
        value = getattr(model, name)
        if isinstance(value, BaseModel):
            out += unknown_keys(value, f"{prefix}{name}.")
    return out


def parse_config(text: str, source: str = CONFIG_NAME) -> Config:
    try:
        data: dict[str, Any] = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{source}: invalid TOML ({exc}).") from exc
    try:
        config = Config.model_validate(data)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        )
        raise ConfigError(f"{source}: {problems}") from exc
    for key in unknown_keys(config):
        log.warning("%s: unknown setting %r ignored", source, key)
    return config


def load_config(path: Path | None = None) -> Config:
    path = path or data_dir() / CONFIG_NAME
    if not path.exists():
        return Config()
    return parse_config(path.read_text(encoding="utf-8"), str(path))
