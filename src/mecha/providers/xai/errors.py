"""xAI response mapping (SPEC.md, "Mapa de errores"). Pure functions.

Docs (checked 2026-11-04): https://docs.x.ai/developers/rest-api-reference/inference/other.md
(``GET /v1/api-key``), .../management/auth.md and https://docs.x.ai/developers/debugging.md.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from mecha.core.models import ExpiryState, Funds, FundsState, LimitsState, Validity
from mecha.core.status import R_PERMISSION_DENIED
from mecha.providers.base import Finding, contains, provider_error, unexpected

INVALID_KEY_MESSAGES = ("incorrect api key", "invalid bearer token")
R_TEAM_BLOCKED = "team_blocked"  # «equipo bloqueado» (the API gives no reason)
R_KEY_DISABLED = "key_disabled"
R_KEY_BLOCKED = "key_blocked"


def _time(value: object) -> datetime | None:
    """xAI documents some times as 'Unix timestamp' but shows ISO strings: accept both."""
    if isinstance(value, int | float) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, tz=UTC)
    if isinstance(value, str) and value:
        if value.isdigit():
            return datetime.fromtimestamp(int(value), tz=UTC)
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def map_api_key_info(body: dict[str, Any]) -> Finding:
    """``GET /v1/api-key``: any flag set to true means blocked."""
    finding = Finding(validity=Validity.valid)
    for flag, code in (
        ("team_blocked", R_TEAM_BLOCKED),
        ("api_key_disabled", R_KEY_DISABLED),
        ("api_key_blocked", R_KEY_BLOCKED),
    ):
        if body.get(flag) is True:
            finding.validity = Validity.blocked
            finding.red(code)
    for src, key in (("team_id", "team_id"), ("api_key_id", "api_key_id"), ("name", "key_name")):
        if isinstance(body.get(src), str) and body[src]:
            finding.account[key] = body[src]
    return finding


def map_management_validation(body: dict[str, Any]) -> Finding:
    """``GET /auth/management-keys/validation`` (management keys)."""
    finding = Finding(validity=Validity.valid)
    team = body.get("scopeId") or body.get("teamId")
    if isinstance(team, str) and team:
        finding.account["team_id"] = team
    if isinstance(body.get("apiKeyId"), str):
        finding.account["api_key_id"] = body["apiKeyId"]
    return finding


def map_management_key_item(item: dict[str, Any], now: datetime) -> Finding:
    """An item of ``GET /auth/teams/{teamId}/api-keys`` (enrichment, phase 4)."""
    # The docs' example sends booleans as strings ("disabled": "false"): accept both.
    disabled = item.get("disabled") in (True, "true", "True")
    finding = Finding(validity=Validity.blocked if disabled else Validity.valid)
    expires = _time(item.get("expireTime"))
    if expires is not None:
        finding.expires_at = expires
        finding.expiry = ExpiryState.expired if expires <= now else ExpiryState.scheduled
    return finding


def map_error(status: int, body: dict[str, Any] | None) -> Finding:
    message = None
    if body:
        raw = body.get("error")
        if isinstance(raw, dict):
            message = raw.get("message")
        elif isinstance(raw, str):
            message = raw
        elif isinstance(body.get("message"), str):
            message = body["message"]
    code = body.get("code") if body else None
    err_obj = provider_error(str(code) if code is not None else f"http_{status}", message)
    # The docs say 401, but the live API answers an unknown key with
    # 400 {"code": "invalid-argument", "error": "Incorrect API key provided. ..."}.
    if status == 401 or (status == 400 and contains(message, *INVALID_KEY_MESSAGES)):
        return Finding(validity=Validity.invalid, error=err_obj)
    if status == 403:
        return Finding(error=err_obj).amber(R_PERMISSION_DENIED)
    if status == 429:
        return Finding(validity=Validity.valid, limits=LimitsState.throttled, error=err_obj)
    return unexpected(status, body)


def _cents(obj: object) -> int | None:
    """xAI amounts: {"val": "<USD cents>"} objects or plain strings."""
    raw = obj.get("val") if isinstance(obj, dict) else obj
    try:
        return int(str(raw)) if raw is not None else None
    except ValueError:
        return None


def team_balance(
    prepaid: dict[str, Any],
    limits: dict[str, Any],
    invoice: dict[str, Any],
    low_usd: Decimal,
) -> tuple[Funds, dict[str, str]]:
    """Prepaid credit + margin under the postpaid monthly spending limit.

    Prepaid ``total.val`` is negative when credit is available (purchases are negative
    changes, spend positive; the docs example shows -1000 after buying 10 USD), so the
    balance is ``-total``. Postpaid: ``effectiveSl`` (soft limit actually applied) minus the
    current cycle's ``amountBeforeVat``. Red only when neither prepaid nor margin is left.
    """
    prepaid_cents = max(0, -(_cents(prepaid.get("total")) or 0))
    raw_sl = limits.get("spendingLimits")
    sl: dict[str, Any] = raw_sl if isinstance(raw_sl, dict) else {}
    limit_cents = (
        _cents(sl.get("effectiveSl")) or _cents(invoice.get("effectiveSpendingLimit")) or 0
    )
    raw_core = invoice.get("coreInvoice")
    core: dict[str, Any] = raw_core if isinstance(raw_core, dict) else {}
    used_cents = max(0, _cents(core.get("amountBeforeVat")) or 0)
    margin_cents = max(0, limit_cents - used_cents)
    available = Decimal(prepaid_cents + margin_cents) / 100
    if available <= 0:
        state = FundsState.empty
    elif available < low_usd:
        state = FundsState.low
    else:
        state = FundsState.ok
    account = {
        "prepaid_usd": f"{Decimal(prepaid_cents) / 100:.2f}",
        "postpaid_margin_usd": f"{Decimal(margin_cents) / 100:.2f}",
    }
    return Funds(state=state, amount=available, currency="USD"), account
