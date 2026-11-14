"""OpenRouter mapping (phase 4 wires the plugin). Pure functions.

Docs: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.md
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from mecha.core.models import ExpiryState, FundsState, LimitsState, Validity
from mecha.core.status import R_PERMISSION_DENIED
from mecha.providers.base import Finding, provider_error, unexpected


def map_key_info(body: dict[str, Any], now: datetime, low_usd: Decimal = Decimal("5")) -> Finding:
    inner = body.get("data")
    data: dict[str, Any] = inner if isinstance(inner, dict) else body
    finding = Finding(validity=Validity.valid)
    limit, remaining = data.get("limit"), data.get("limit_remaining")
    if limit is None:
        finding.funds = FundsState.not_applicable  # no credit limit on this key
    elif remaining is not None:
        try:
            amount = Decimal(str(remaining))
        except InvalidOperation:
            amount = None
        if amount is not None:
            if amount <= 0:
                finding.funds = FundsState.empty
            elif amount < low_usd:
                finding.funds = FundsState.low
            else:
                finding.funds = FundsState.ok
            finding.funds_amount, finding.funds_currency = amount, "USD"
    expires = data.get("expires_at")
    if isinstance(expires, str) and expires:
        at = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        at = at if at.tzinfo else at.replace(tzinfo=UTC)
        finding.expires_at = at
        finding.expiry = ExpiryState.expired if at <= now else ExpiryState.scheduled
    elif "expires_at" in data and expires is None:
        finding.expiry = ExpiryState.none
    if data.get("is_free_tier") is True:
        finding.account["plan"] = "free_tier"
    return finding


def map_error(status: int, body: dict[str, Any] | None) -> Finding:
    err = body.get("error") if body else None
    message = err.get("message") if isinstance(err, dict) else None
    error = provider_error(f"http_{status}", message)
    if status == 401:
        return Finding(validity=Validity.invalid, error=error)
    if status == 402:
        return Finding(validity=Validity.valid, funds=FundsState.empty, error=error)
    if status == 403:
        return Finding(error=error).amber(R_PERMISSION_DENIED)
    if status == 429:
        return Finding(validity=Validity.valid, limits=LimitsState.throttled, error=error)
    return unexpected(status, body)
