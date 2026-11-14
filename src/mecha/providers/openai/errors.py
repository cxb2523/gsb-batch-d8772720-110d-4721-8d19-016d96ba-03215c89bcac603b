"""OpenAI response mapping (SPEC.md, "Mapa de errores"). Pure functions.

Docs: https://developers.openai.com/api/docs/guides/error-codes (checked 2026-11-04).
Billing errors are identified by ``error.code``; ``error.type`` may still be
``insufficient_quota`` for any of them, so codes are checked first.
"""

from __future__ import annotations

from typing import Any

from mecha.core.models import FundsState, LimitsState, Validity
from mecha.core.status import R_PERMISSION_DENIED
from mecha.providers.base import Finding, contains, provider_error, unexpected

EMPTY_CODES = frozenset({"credit_balance_exhausted"})
CAPPED_CODES = frozenset(
    {
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded",
    }
)
# 401 for a restricted key lacking the endpoint's scope (e.g. api.model.read for /v1/models).
# The docs list "does not have the required permissions" as a 401 cause; the exact text is
# not documented, so match variants.
SCOPE_MESSAGES = ("missing scopes", "insufficient permissions")


def _error(body: dict[str, Any] | None) -> tuple[str | None, str | None, str | None]:
    err = body.get("error") if body else None
    if isinstance(err, dict):
        return err.get("code"), err.get("type"), err.get("message")
    return None, None, None


def map_error(status: int, body: dict[str, Any] | None) -> Finding:
    code, etype, message = _error(body)
    err = provider_error(code or etype or f"http_{status}", message)
    if status == 401:
        if contains(message, *SCOPE_MESSAGES):
            return Finding(validity=Validity.valid, error=err).amber(R_PERMISSION_DENIED)
        return Finding(validity=Validity.invalid, error=err)
    if status == 403:
        return Finding(error=err).amber(R_PERMISSION_DENIED)
    if status == 429:
        if code in CAPPED_CODES:
            return Finding(validity=Validity.valid, funds=FundsState.capped, error=err)
        # credit_balance_exhausted, or the broader insufficient_quota type as a variant.
        if code in EMPTY_CODES or etype == "insufficient_quota":
            return Finding(validity=Validity.valid, funds=FundsState.empty, error=err)
        return Finding(validity=Validity.valid, limits=LimitsState.throttled, error=err)
    return unexpected(status, body)
