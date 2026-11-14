"""Gemini response mapping (SPEC.md, "Mapa de errores"). Pure functions.

Docs (checked 2026-11-04): https://aistudio.google.com/docs/api-errors and
https://aistudio.google.com/docs/troubleshooting. ``/v1beta`` endpoints use the Google API
error model (``error.code`` number, ``error.status``, ``error.details``); the Interactions
API uses snake_case string codes. Both shapes are accepted.
"""

from __future__ import annotations

from typing import Any

from mecha.core.models import FundsState, LimitsState, Validity
from mecha.core.status import R_PERMISSION_DENIED
from mecha.providers.base import Finding, contains, provider_error, unexpected

LEAKED = ("reported as leaked",)  # official: "Your API key was reported as leaked. ..."
PREPAY_DEPLETED = ("prepayment credits are depleted",)  # 429 variant (third-party reports)
INVALID_KEY_REASONS = frozenset({"API_KEY_INVALID"})
# Any invalid AQ. key gets 401 ACCESS_TOKEN_TYPE_UNSUPPORTED (verified live), and so do real
# keys hit by the known account issue: a hint, not a diagnosis.
R_AQ_HINT = "gemini_aq_rejected"
DETAIL_ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo"
# google.api.ErrorReason (googleapis/google/api/error_reason.proto, checked 2026-11-05) ->
# our reason and severity. Rule: AMBER when it depends on where the call comes from (an
# IP-restricted key fails from a laptop and works on its server); RED when it fails from
# anywhere (the key is useless for Gemini). Reasons that cannot occur for an API key
# listing models (OAuth access tokens, resource creation, MISSING_ORIGIN…) are not mapped
# and fall back to the generic "no permission".
CALLER_DEPENDENT: dict[str, str] = {
    "API_KEY_IP_ADDRESS_BLOCKED": "gemini_ip_restricted",
    "API_KEY_HTTP_REFERRER_BLOCKED": "gemini_referrer_restricted",
    "API_KEY_ANDROID_APP_BLOCKED": "gemini_android_app_restricted",
    "API_KEY_IOS_APP_BLOCKED": "gemini_ios_app_restricted",
    "SECURITY_POLICY_VIOLATED": "gemini_vpc_sc_blocked",
    "ORG_RESTRICTION_VIOLATION": "gemini_org_restriction",
    "TLS_ORG_POLICY_VIOLATED": "gemini_tls_policy",
    "TLS_CIPHER_RESTRICTION_VIOLATED": "gemini_tls_policy",
}
FAILS_EVERYWHERE: dict[str, str] = {
    "API_KEY_SERVICE_BLOCKED": "gemini_service_blocked",
    "SERVICE_DISABLED": "gemini_api_disabled",
    "BILLING_DISABLED": "gemini_billing_disabled",
    "CONSUMER_SUSPENDED": "gemini_project_suspended",
    "GCP_SUSPENDED": "gemini_project_suspended",
    "CONSUMER_INVALID": "gemini_project_invalid",
    "RESOURCE_USAGE_RESTRICTION_VIOLATED": "gemini_org_policy_blocked",
    "ENDPOINT_USAGE_RESTRICTION_VIOLATED": "gemini_org_policy_blocked",
    "IAM_PERMISSION_DENIED": "gemini_iam_denied",
}
DETAIL_QUOTA_FAILURE = "type.googleapis.com/google.rpc.QuotaFailure"


def _error(body: dict[str, Any] | None) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    err = body.get("error") if body else None
    if not isinstance(err, dict):
        return None, None, []
    code = err.get("status") or (err.get("code") if isinstance(err.get("code"), str) else None)
    details = [d for d in err.get("details") or [] if isinstance(d, dict)]
    return code, err.get("message"), details


def _reasons(details: list[dict[str, Any]]) -> set[str]:
    return {str(d.get("reason")) for d in details if d.get("@type") == DETAIL_ERROR_INFO}


def _quota_ids(details: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for d in details:
        if d.get("@type") == DETAIL_QUOTA_FAILURE:
            out += [str(v.get("quotaId", "")) for v in d.get("violations") or []]
    return out


def map_error(status: int, body: dict[str, Any] | None) -> Finding:
    code, message, details = _error(body)
    err = provider_error(code or f"http_{status}", message)
    text = f"{message or ''} {' '.join(_reasons(details))} {code or ''}"
    if contains(message, *LEAKED):
        return Finding(validity=Validity.blocked, error=err)
    if status == 401:
        finding = Finding(validity=Validity.invalid, error=err)
        if contains(text, "ACCESS_TOKEN_TYPE_UNSUPPORTED"):
            finding.red(R_AQ_HINT)
        return finding
    if status == 400 and (
        _reasons(details) & INVALID_KEY_REASONS or contains(message, "api key not valid")
    ):
        return Finding(validity=Validity.invalid, error=err)
    if status == 402:
        return Finding(validity=Validity.valid, funds=FundsState.empty, error=err)
    if status in (400, 403):  # billing disabled may also come as 400 FAILED_PRECONDITION
        reasons = _reasons(details)
        red = sorted({FAILS_EVERYWHERE[r] for r in reasons if r in FAILS_EVERYWHERE})
        amber = sorted({CALLER_DEPENDENT[r] for r in reasons if r in CALLER_DEPENDENT})
        if red or amber or status == 403:
            finding = Finding(error=err)
            for code in red:
                finding.red(code)
            for code in amber or ([] if red else [R_PERMISSION_DENIED]):
                finding.amber(code)
            return finding
    if status == 429:
        if contains(message, *PREPAY_DEPLETED):
            return Finding(validity=Validity.valid, funds=FundsState.empty, error=err)
        # Monthly spend cap: error text not documented yet -> no `capped` mapping
        # (docs/providers.md). Everything else on 429 is a rate limit.
        finding = Finding(validity=Validity.valid, limits=LimitsState.throttled, error=err)
        if any("freetier" in q.lower() for q in _quota_ids(details)):
            finding.account["plan"] = "free_tier"
            finding.account_source["plan"] = "inferred"
        return finding
    return unexpected(status, body)
