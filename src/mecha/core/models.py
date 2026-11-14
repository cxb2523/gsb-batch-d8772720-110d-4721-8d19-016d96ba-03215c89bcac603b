"""Domain models (SPEC.md, "Modelo de estados" and "Modelo de datos y API REST").

No model here ever carries a plaintext secret.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProviderId(StrEnum):
    anthropic = "anthropic"
    openai = "openai"
    gemini = "gemini"
    xai = "xai"
    openrouter = "openrouter"


class CredentialKind(StrEnum):
    api_key = "api_key"
    admin_key = "admin_key"
    management_key = "management_key"
    oauth_token = "oauth_token"  # noqa: S105 - an enum value
    oauth_file = "oauth_file"

    @property
    def is_oauth(self) -> bool:
        return self in (CredentialKind.oauth_token, CredentialKind.oauth_file)


class Validity(StrEnum):
    valid = "valid"
    invalid = "invalid"
    revoked = "revoked"
    blocked = "blocked"
    not_applicable = "not_applicable"
    unknown = "unknown"


class FundsState(StrEnum):
    ok = "ok"
    low = "low"
    empty = "empty"
    capped = "capped"
    not_applicable = "not_applicable"
    unknown = "unknown"


class ExpiryState(StrEnum):
    none = "none"
    scheduled = "scheduled"
    soon = "soon"
    expired = "expired"
    unknown = "unknown"


class LimitsState(StrEnum):
    ok = "ok"
    throttled = "throttled"
    unknown = "unknown"


class Overall(StrEnum):
    green = "green"
    amber = "amber"
    red = "red"
    grey = "grey"
    local = "local"


class CheckStatus(StrEnum):
    """Whether a remote check produced data. Distinguishes «sin comprobar» from «falló»."""

    not_checked = "not_checked"
    failed = "failed"
    ok = "ok"


Source = Literal["api", "header", "jwt", "file", "manual", "inferred"]
Mode = Literal["offline", "passive", "active", "enrich"]


class Signal[T](BaseModel):
    value: T
    source: Source
    observed_at: datetime


class Funds(BaseModel):
    state: FundsState
    amount: Decimal | None = None
    currency: str | None = None


class Expiry(BaseModel):
    state: ExpiryState
    expires_at: datetime | None = None


class RateWindow(BaseModel):
    limit: int | None = None
    remaining: int | None = None
    reset: datetime | None = None


class Limits(BaseModel):
    state: LimitsState
    requests: RateWindow | None = None
    tokens: RateWindow | None = None


class Budget(BaseModel):
    amount: Decimal
    currency: str = "USD"
    purchased_at: datetime


class HttpTrace(BaseModel):
    endpoint: str
    status: int | None
    latency_ms: float | None
    headers: dict[str, str] = Field(default_factory=dict)  # already redacted


class ProviderError(BaseModel):
    code: str
    message: str


class Reason(BaseModel):
    """Why the overall colour is what it is; ``code`` is translated by the UI/CLI."""

    code: str
    overall: Overall


class Fact[T](BaseModel):
    """Something an API told us about a credential that must survive later checks: an
    admin key's view of a child, a management balance, what an active probe found."""

    value: T
    source: Source
    observed_at: datetime
    by: str | None = None  # credential id of the admin/management key that reported it
    scope: str | None = None  # "team" / "organization" when it is not about this key alone


class FundsInfo(BaseModel):
    """Informational funds (never changes the traffic light): e.g. an organization-wide
    balance estimated from the Costs API, shown on the child keys."""

    amount: Decimal
    currency: str = "USD"
    until: datetime  # last day included in the estimate
    estimated: bool = True


class ReasonFact(BaseModel):
    """An API-reported reason that is a warning, not proof of failure (e.g. the key's owner
    lost access to the project): it colours the card amber, never red."""

    code: str
    overall: Overall
    observed_at: datetime
    by: str | None = None


class ExposureSummary(BaseModel):
    """How many places a stored key was also found in plaintext (mecha scan). Counts only:
    the locations themselves are kept encrypted (store.exposures)."""

    risky: int = 0
    info: int = 0
    scanned_at: datetime


class CredentialFacts(BaseModel):
    expires_at: Fact[datetime | None] | None = None  # value None: the API says it never expires
    status: Fact[Validity] | None = None  # e.g. revoked/blocked according to an admin API
    last_used_at: Fact[datetime] | None = None
    funds: Fact[Funds] | None = None  # affects the traffic light (probe, team balance, own key)
    funds_info: Fact[FundsInfo] | None = None  # shown only, never colours the card
    limits: Fact[Limits] | None = None  # from an active probe
    account: dict[str, Fact[str]] = Field(default_factory=dict)
    reasons: list[ReasonFact] = Field(default_factory=list)
    exposure: ExposureSummary | None = None
    last_probe_at: datetime | None = None
    probe_model: str | None = None


class Credential(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    label: str
    provider: ProviderId
    kind: CredentialKind
    pattern_id: str | None = None
    redacted: str
    fingerprint: str
    tags: list[str] = Field(default_factory=list)
    notes: str | None = None
    linked_path: str | None = None
    parent_id: str | None = None
    manual_expires_at: datetime | None = None
    manual_budget: Budget | None = None
    active_probe: bool = False
    created_at: datetime
    # Non-secret facts derived offline at add time (JWT claims, retiring key type…).
    token_expires_at: datetime | None = None
    subscription_until: datetime | None = None
    retiring: bool = False
    facts: CredentialFacts = Field(default_factory=CredentialFacts)


class CheckResult(BaseModel):
    credential_id: str
    checked_at: datetime
    mode: Mode
    check_status: CheckStatus
    overall: Overall
    reasons: list[Reason] = Field(default_factory=list)
    validity: Signal[Validity]
    funds: Signal[Funds]
    expiry: Signal[Expiry]
    limits: Signal[Limits] | None = None
    funds_info: Signal[FundsInfo] | None = None  # informational, never colours the card
    last_used_at: Signal[datetime] | None = None
    account: dict[str, Signal[str]] = Field(default_factory=dict)
    http: HttpTrace | None = None
    error: ProviderError | None = None
