"""State engine (SPEC.md, "Reglas del semáforo"). Pure functions, no I/O.

Priority: red > amber > grey > green. ``local`` is the neutral state of OAuth credentials
(validity ``not_applicable``): it applies only when nothing is red or amber and never mixes
with grey. Offline conditions (retiring key type, known expiry dates) are always evaluated,
even when the remote check could not run.

A remote check produces an :class:`Observation`; :func:`evaluate` merges it with the
credential's offline facts *at a given time*, so expiry keeps ticking between checks.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

from pydantic import BaseModel, Field

from mecha.core.models import (
    CheckResult,
    CheckStatus,
    Credential,
    CredentialKind,
    Expiry,
    ExpiryState,
    Funds,
    FundsInfo,
    FundsState,
    HttpTrace,
    Limits,
    LimitsState,
    Mode,
    Overall,
    ProviderError,
    Reason,
    Signal,
    Source,
    Validity,
)

RED_VALIDITY = {Validity.invalid, Validity.revoked, Validity.blocked}
PROBE_LIMITS_TTL = timedelta(hours=1)

# Reason codes (translated by CLI/UI).
R_NOT_CHECKED = "not_checked"  # «sin comprobar»
R_CHECK_FAILED = "check_failed"  # «falló la comprobación»
R_VALIDITY_UNKNOWN = "validity_unknown"
R_LOCAL_ONLY = "local_only"
R_VALID = "valid"
R_FUNDS_LOW_ESTIMATED = "funds_low_estimated"  # «saldo bajo (estimado)», never red
R_EXPOSED = "exposed_in_plaintext"  # «también en texto plano en N sitios de riesgo» (scan)
R_OWNER_NO_ACCESS = "owner_no_project_access"  # «su propietario ya no tiene acceso al proyecto»
R_LINKED_UNREADABLE = "linked_file_unreadable"  # a linked session file is missing/unreadable
R_PROBE_MISCONFIGURED = "probe_misconfigured"  # the probe model no longer exists (404)
R_PROBE_UNCERTAIN = "probe_uncertain"  # a paid POST timed out after sending: maybe billed
R_BILLING_ERROR = "billing_error"  # «problema de facturación»
R_PERMISSION_DENIED = "permission_denied"  # «sin permiso»


@dataclass(frozen=True)
class Thresholds:
    soon_days: int = 14
    low_funds_usd: Decimal = Decimal("5")


class Observation(BaseModel):
    """What one remote request taught us. Every field is optional: unknown stays unknown."""

    mode: Mode = "passive"
    check_status: CheckStatus
    observed_at: datetime
    validity: Validity | None = None
    funds: Funds | None = None
    funds_source: Source = "api"
    expiry: Expiry | None = None  # from the provider (e.g. an admin API), not offline facts
    limits: Limits | None = None
    account: dict[str, str] = Field(default_factory=dict)
    account_source: dict[str, Source] = Field(default_factory=dict)
    notes: list[Reason] = Field(default_factory=list)  # provider-specific reasons
    # Why a failed check failed, when it is more specific than "check failed".
    failure: str | None = None
    probe_model: str | None = None  # model used by an active probe
    http: HttpTrace | None = None
    error: ProviderError | None = None


def expiry_state(expires_at: datetime | None, now: datetime, th: Thresholds) -> ExpiryState:
    if expires_at is None:
        return ExpiryState.unknown
    if expires_at <= now:
        return ExpiryState.expired
    if expires_at - now < timedelta(days=th.soon_days):
        return ExpiryState.soon
    return ExpiryState.scheduled


def compute_overall(
    *,
    kind: CredentialKind,
    validity: Validity,
    funds: FundsState,
    expiry: ExpiryState,
    limits: LimitsState | None,
    retiring: bool,
    check_status: CheckStatus,
    notes: Sequence[Reason] = (),
    failure: str | None = None,
) -> tuple[Overall, list[Reason]]:
    red: list[str] = []
    # A 401 on a key whose known expiry has passed is shown as expired, not invalid.
    if validity in RED_VALIDITY and not (
        validity is Validity.invalid and expiry is ExpiryState.expired
    ):
        red.append(f"validity_{validity.value}")
    # "billing problem" already explains empty funds; don't list both.
    if funds is FundsState.empty and not any(n.code == R_BILLING_ERROR for n in notes):
        red.append("funds_empty")
    if expiry is ExpiryState.expired:
        red.append("expired")
    red += [n.code for n in notes if n.overall is Overall.red]

    amber: list[str] = []
    if expiry is ExpiryState.soon:
        amber.append("expires_soon")
    if funds is FundsState.low:
        amber.append("funds_low")
    if funds is FundsState.capped:
        amber.append("funds_capped")
    if limits is LimitsState.throttled:
        amber.append("throttled")
    if retiring:
        amber.append("retiring_key_type")
    amber += [n.code for n in notes if n.overall is Overall.amber]

    reasons = [Reason(code=c, overall=Overall.red) for c in red]
    reasons += [Reason(code=c, overall=Overall.amber) for c in amber]
    if red:
        return Overall.red, reasons
    if amber:
        return Overall.amber, reasons

    if kind.is_oauth:
        return Overall.local, [Reason(code=R_LOCAL_ONLY, overall=Overall.local)]

    if check_status is CheckStatus.not_checked:
        return Overall.grey, [Reason(code=R_NOT_CHECKED, overall=Overall.grey)]
    if check_status is CheckStatus.failed:
        return Overall.grey, [Reason(code=failure or R_CHECK_FAILED, overall=Overall.grey)]
    if validity is Validity.valid:
        return Overall.green, [Reason(code=R_VALID, overall=Overall.green)]
    return Overall.grey, [Reason(code=R_VALIDITY_UNKNOWN, overall=Overall.grey)]


def known_expiry(cred: Credential) -> tuple[datetime | None, Source]:
    """Earliest expiry known without a new request: manual date, JWT ``exp``, subscription
    end, or a date an API reported earlier (kept as a fact, so a failed check keeps it)."""
    candidates: list[tuple[datetime, Source]] = []
    api = cred.facts.expires_at
    if api is not None and api.value is not None:
        candidates.append((api.value, api.source))
    if cred.manual_expires_at is not None:
        candidates.append((cred.manual_expires_at, "manual"))
    if cred.token_expires_at is not None:
        candidates.append((cred.token_expires_at, "jwt"))
    if cred.subscription_until is not None:
        candidates.append((cred.subscription_until, "jwt"))
    if not candidates:
        return None, "inferred"
    return min(candidates, key=lambda c: c[0])


def evaluate(
    cred: Credential,
    obs: Observation | None,
    now: datetime,
    th: Thresholds | None = None,
) -> CheckResult:
    """Merge the latest observation (if any) with offline facts, evaluated at ``now``."""
    th = th or Thresholds()
    oauth = cred.kind.is_oauth
    if oauth:
        obs = None  # principle 4: OAuth credentials are never checked remotely

    # Validity and funds come from the observation; offline they are unknown / n.a.
    v_source: Source
    f_source: Source
    if oauth:
        validity, v_source, v_at = Validity.not_applicable, "inferred", now
        funds, f_source, f_at = Funds(state=FundsState.not_applicable), "inferred", now
    elif obs is None or obs.check_status is not CheckStatus.ok:
        validity, v_source, v_at = Validity.unknown, "inferred", now
        funds, f_source, f_at = Funds(state=FundsState.unknown), "inferred", now
    else:
        validity, v_source, v_at = obs.validity or Validity.unknown, "api", obs.observed_at
        funds = obs.funds or Funds(state=FundsState.unknown)
        f_source, f_at = (obs.funds_source if obs.funds else "inferred"), obs.observed_at

    # Facts reported earlier by an API (admin/management enrichment, an active probe, the
    # key itself) survive later checks that know nothing about them: a passive check must
    # not turn an "out of funds" card back to green, nor a failed check lose a known date.
    facts = cred.facts
    if not oauth:
        # The most recent evidence wins: a key reactivated in the console turns green on its
        # next direct check, even if an older admin listing still said "revoked".
        if (
            facts.status is not None
            and facts.status.value in RED_VALIDITY
            and (validity is Validity.unknown or facts.status.observed_at > v_at)
        ):
            validity, v_source, v_at = (
                facts.status.value,
                facts.status.source,
                facts.status.observed_at,
            )
        if facts.funds is not None and (
            funds.state is FundsState.unknown or facts.funds.observed_at > f_at
        ):
            funds, f_source, f_at = facts.funds.value, facts.funds.source, facts.funds.observed_at

    # Expiry: a date reported by the provider wins over offline facts; "none" (never
    # expires) only comes from the provider. The state is always recomputed at `now`.
    api_expiry = obs.expiry if obs and obs.check_status is CheckStatus.ok else None
    offline_at, offline_source = known_expiry(cred)
    expires_at: datetime | None
    e_source: Source
    if api_expiry and api_expiry.expires_at is not None:
        expires_at, e_source = api_expiry.expires_at, "api"
        if offline_at is not None and offline_at < expires_at:
            expires_at, e_source = offline_at, offline_source
    else:
        expires_at, e_source = offline_at, offline_source
    e_state = expiry_state(expires_at, now, th)
    never = (api_expiry is not None and api_expiry.state is ExpiryState.none) or (
        facts.expires_at is not None and facts.expires_at.value is None
    )
    if e_state is ExpiryState.unknown and never:
        e_state, e_source = ExpiryState.none, "api"
    elif e_state is ExpiryState.unknown and api_expiry and api_expiry.state is ExpiryState.expired:
        e_state, e_source = ExpiryState.expired, "api"

    check_status = obs.check_status if obs else CheckStatus.not_checked
    ok = obs is not None and obs.check_status is CheckStatus.ok
    limits = obs.limits if ok and obs else None
    limits_source: Source = "header"
    limits_at = obs.observed_at if obs else now
    # A rate limit seen by an active probe is transient: it counts for an hour at most.
    if (
        limits is None
        and not oauth
        and facts.limits is not None
        and now - facts.limits.observed_at < PROBE_LIMITS_TTL
    ):
        limits, limits_source, limits_at = (
            facts.limits.value,
            facts.limits.source,
            facts.limits.observed_at,
        )
    notes = obs.notes if ok and obs else []
    if cred.kind is CredentialKind.oauth_file and "file_error" in facts.account:
        notes = [*notes, Reason(code=R_LINKED_UNREADABLE, overall=Overall.amber)]
    if not oauth:
        # API-reported warnings are amber at most: red needs real proof.
        notes = [*notes, *(Reason(code=f.code, overall=Overall.amber) for f in facts.reasons)]
        # Found in plaintext in a risky place (mecha scan): amber, never red.
        if facts.exposure is not None and facts.exposure.risky > 0:
            notes = [*notes, Reason(code=R_EXPOSED, overall=Overall.amber)]
        info = facts.funds_info
        # The organization estimate may warn on the admin key that reads the Costs API (and
        # only there): amber «low funds (estimated)», never red, even at or below zero.
        if (
            info is not None
            and info.by is None
            and cred.kind is CredentialKind.admin_key
            and info.value.amount < th.low_funds_usd
        ):
            notes = [*notes, Reason(code=R_FUNDS_LOW_ESTIMATED, overall=Overall.amber)]

    overall, reasons = compute_overall(
        kind=cred.kind,
        validity=validity,
        funds=funds.state,
        expiry=e_state,
        limits=limits.state if limits else None,
        retiring=cred.retiring,
        check_status=check_status,
        notes=notes,
        failure=obs.failure if obs and not ok else None,
    )
    checked_at = obs.observed_at if obs else now
    return CheckResult(
        credential_id=cred.id,
        checked_at=checked_at,
        mode=obs.mode if obs else "offline",
        check_status=check_status,
        overall=overall,
        reasons=reasons,
        validity=Signal[Validity](value=validity, source=v_source, observed_at=v_at),
        funds=Signal[Funds](value=funds, source=f_source, observed_at=f_at),
        expiry=Signal[Expiry](
            value=Expiry(state=e_state, expires_at=expires_at),
            source=e_source,
            observed_at=obs.observed_at if obs and e_source == "api" else now,
        ),
        limits=(
            Signal[Limits](value=limits, source=limits_source, observed_at=limits_at)
            if limits
            else None
        ),
        funds_info=(
            Signal[FundsInfo](
                value=facts.funds_info.value,
                source=facts.funds_info.source,
                observed_at=facts.funds_info.observed_at,
            )
            if facts.funds_info and not oauth
            else None
        ),
        last_used_at=(
            Signal[datetime](
                value=facts.last_used_at.value,
                source=facts.last_used_at.source,
                observed_at=facts.last_used_at.observed_at,
            )
            if facts.last_used_at
            else None
        ),
        account={**_fact_account(cred), **_account(obs)},
        http=obs.http if obs else None,
        error=obs.error if obs else None,
    )


def _fact_account(cred: Credential) -> dict[str, Signal[str]]:
    return {
        k: Signal[str](value=f.value, source=f.source, observed_at=f.observed_at)
        for k, f in cred.facts.account.items()
    }


def _account(obs: Observation | None) -> dict[str, Signal[str]]:
    if obs is None or obs.check_status is not CheckStatus.ok:
        return {}
    return {
        k: Signal[str](
            value=v, source=obs.account_source.get(k, "api"), observed_at=obs.observed_at
        )
        for k, v in obs.account.items()
    }


def evaluate_offline(cred: Credential, now: datetime, th: Thresholds | None = None) -> CheckResult:
    return evaluate(cred, None, now, th)


def worst(overalls: list[Overall]) -> Overall | None:
    order = [Overall.red, Overall.amber, Overall.grey, Overall.local, Overall.green]
    return next((o for o in order if o in overalls), None)


def exit_code_for(overalls: list[Overall], *, strict: bool = False) -> int:
    """Nagios contract: 0 OK (green/grey/local), 1 WARNING (amber), 2 CRITICAL (red).

    With ``strict``, grey ("could not check") is UNKNOWN (3). Red still wins; grey beats amber
    because "I could not check" must not be reported as a mere warning.
    """
    if Overall.red in overalls:
        return 2
    if strict and Overall.grey in overalls:
        return 3
    if Overall.amber in overalls:
        return 1
    return 0
