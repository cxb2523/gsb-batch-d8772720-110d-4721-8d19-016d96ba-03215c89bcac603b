"""Anthropic response mapping (SPEC.md, "Mapa de errores"). Pure functions.

Docs: https://platform.claude.com/docs/en/api/errors (checked 2026-11-04).
"""

from __future__ import annotations

from typing import Any

from mecha.core.models import ExpiryState, FundsState, LimitsState, Validity
from mecha.core.status import R_BILLING_ERROR, R_PERMISSION_DENIED
from mecha.providers.base import Finding, contains, provider_error, unexpected

# 400 messages meaning "no credit" (substring, case-insensitive; one fixture per variant).
CREDIT_MESSAGES = ("credit balance", "insufficient credits")


def _error(body: dict[str, Any] | None) -> tuple[str | None, str | None]:
    err = body.get("error") if body else None
    if isinstance(err, dict):
        return err.get("type"), err.get("message")
    return None, None


def map_error(status: int, body: dict[str, Any] | None) -> Finding:
    etype, message = _error(body)
    err = provider_error(etype or f"http_{status}", message)
    if status == 401 or etype == "authentication_error":
        return Finding(validity=Validity.invalid, error=err)
    if status == 402 or etype == "billing_error":
        return Finding(validity=Validity.valid, funds=FundsState.empty, error=err).red(
            R_BILLING_ERROR
        )
    if status == 400 and contains(message, *CREDIT_MESSAGES):
        return Finding(validity=Validity.valid, funds=FundsState.empty, error=err)
    if status == 403 or etype == "permission_error":
        return Finding(error=err).amber(R_PERMISSION_DENIED)
    if status == 429 or etype == "rate_limit_error":
        return Finding(validity=Validity.valid, limits=LimitsState.throttled, error=err)
    return unexpected(status, body)


# Admin API key status -> state (wired in phase 4 by enrichment).
def map_admin_key_status(status: str) -> Finding:
    """``GET /v1/organizations/api_keys`` item status."""
    if status == "active":
        return Finding(validity=Validity.valid)
    if status == "inactive":
        return Finding(validity=Validity.blocked)
    if status == "archived":
        return Finding(validity=Validity.revoked)
    if status == "expired":
        return Finding(expiry=ExpiryState.expired)
    return Finding(understood=False, error=provider_error("unknown_status", status))
