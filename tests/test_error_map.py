"""Phase 2 criterion: every row of SPEC.md's error map has a fixture producing the expected state.

Passive-endpoint rows run through the real plugin (respx serves the fixture). Rows that belong
to active probes, admin APIs or OpenRouter (wired in phase 4) exercise the same pure mapping
functions in ``errors.py``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from mecha.core.http import HttpSettings, make_client
from mecha.core.models import (
    CheckResult,
    CheckStatus,
    Credential,
    CredentialKind,
    ExpiryState,
    FundsState,
    LimitsState,
    Overall,
    ProviderId,
    Validity,
)
from mecha.core.status import evaluate
from mecha.providers import get_provider
from mecha.providers.anthropic.errors import map_admin_key_status
from mecha.providers.base import ProviderContext, observation
from mecha.providers.openrouter.errors import map_key_info
from mecha.providers.xai.errors import map_management_key_item

pytestmark = pytest.mark.anyio

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
FAST = HttpSettings(timeout_seconds=1, retries=3, backoff_seconds=0)

HOSTS = {
    ProviderId.anthropic: "api.anthropic.com",
    ProviderId.openai: "api.openai.com",
    ProviderId.gemini: "generativelanguage.googleapis.com",
    ProviderId.xai: "api.x.ai",
}


def fixture(provider: str, name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / provider / f"{name}.json").read_text())
    assert data["source"], "every fixture names its source"
    return data


def cred(
    provider: ProviderId, kind: CredentialKind = CredentialKind.api_key, **kw: Any
) -> Credential:
    return Credential(
        id="01TESTCRED",
        label="t",
        provider=provider,
        kind=kind,
        redacted="x…",
        fingerprint="f" * 12,
        created_at=NOW - timedelta(days=30),
        **kw,
    )


async def run(provider: ProviderId, name: str, c: Credential | None = None) -> CheckResult:
    fx = fixture(provider.value, name)
    c = c or cred(provider)
    plugin = get_provider(provider)
    assert plugin is not None
    with respx.mock as router:
        router.route(host=HOSTS[provider]).mock(
            return_value=httpx.Response(fx["status"], json=fx["body"], headers=fx["headers"])
        )
        async with make_client(plugin.routes(c.kind), FAST) as http:
            obs = await plugin.check_passive(
                c, "secret-not-real", http, ProviderContext(now=NOW, http=FAST)
            )
    return evaluate(c, obs, NOW)


def codes(r: CheckResult) -> set[str]:
    return {x.code for x in r.reasons}


# --- rows ------------------------------------------------------------------------------

Case = tuple[str, str, Callable[[], Any]]  # (row id, description, async or sync check)


async def all_401() -> None:
    for provider, name in (
        (ProviderId.anthropic, "invalid_key"),
        (ProviderId.openai, "invalid_key"),
        (ProviderId.gemini, "unauthenticated"),
    ):
        r = await run(provider, name)
        assert r.validity.value is Validity.invalid, provider
        assert r.overall is Overall.red
        assert "validity_invalid" in codes(r)
    # ...unless its known expiry has passed: then it is shown as expired.
    expired = cred(ProviderId.anthropic, manual_expires_at=NOW - timedelta(days=1))
    r = await run(ProviderId.anthropic, "invalid_key", expired)
    assert r.overall is Overall.red
    assert "expired" in codes(r)
    assert "validity_invalid" not in codes(r)


async def all_403() -> None:
    for provider, name in (
        (ProviderId.anthropic, "permission_denied"),
        (ProviderId.openai, "forbidden_region"),
        (ProviderId.gemini, "permission_denied"),
        (ProviderId.xai, "forbidden"),
    ):
        r = await run(provider, name)
        assert r.overall is Overall.amber, provider
        assert r.check_status is CheckStatus.ok, "a 403 is an answer, not a failed check"
        assert "permission_denied" in codes(r)


async def all_429() -> None:
    for provider, name in (
        (ProviderId.anthropic, "rate_limited"),
        (ProviderId.xai, "rate_limited"),
    ):
        r = await run(provider, name)
        assert r.limits is not None
        assert r.limits.value.state is LimitsState.throttled
        assert r.overall is Overall.amber


async def all_network() -> None:
    for provider, name in (
        (ProviderId.anthropic, "overloaded"),
        (ProviderId.anthropic, "server_error"),
        (ProviderId.openai, "overloaded"),
        (ProviderId.gemini, "unavailable"),
    ):
        r = await run(provider, name)
        assert r.overall is Overall.grey, (provider, name)
        assert "check_failed" in codes(r)
    # timeouts and connection errors
    plugin = get_provider(ProviderId.xai)
    assert plugin is not None
    with respx.mock as router:
        route = router.route(host="api.x.ai").mock(side_effect=httpx.ConnectTimeout("t"))
        async with make_client(plugin.routes(CredentialKind.api_key), FAST) as http:
            obs = await plugin.check_passive(
                cred(ProviderId.xai), "s", http, ProviderContext(now=NOW, http=FAST)
            )
    assert route.call_count == 4  # 1 + 3 retries
    assert evaluate(cred(ProviderId.xai), obs, NOW).overall is Overall.grey


async def anthropic_credit() -> None:
    for name in ("credit_balance_low", "insufficient_credits"):
        r = await run(ProviderId.anthropic, name)
        assert r.funds.value.state is FundsState.empty, name
        assert r.overall is Overall.red


async def anthropic_billing() -> None:
    r = await run(ProviderId.anthropic, "billing_error")
    assert r.funds.value.state is FundsState.empty
    assert r.overall is Overall.red
    assert "billing_error" in codes(r)
    assert "funds_empty" not in codes(r)  # one explanation, not two


def anthropic_admin_status() -> None:
    item = fixture("anthropic", "admin_api_keys_ok")["body"]["data"][0]
    assert map_admin_key_status(item["status"]).validity is Validity.valid
    assert map_admin_key_status("inactive").validity is Validity.blocked
    assert map_admin_key_status("archived").validity is Validity.revoked
    assert map_admin_key_status("expired").expiry is ExpiryState.expired
    assert not map_admin_key_status("something-new").understood


async def openai_credit() -> None:
    for name in ("credit_balance_exhausted", "insufficient_quota"):
        r = await run(ProviderId.openai, name)
        assert r.funds.value.state is FundsState.empty, name
        assert r.overall is Overall.red


async def openai_spend_limit() -> None:
    for name in ("organization_spend_limit", "project_spend_limit", "organization_usage_limit"):
        r = await run(ProviderId.openai, name)
        assert r.funds.value.state is FundsState.capped, name
        assert r.overall is Overall.amber


async def openai_rate_limit() -> None:
    for name in ("rate_limited", "slow_down"):
        r = await run(ProviderId.openai, name)
        assert r.limits is not None, name
        assert r.limits.value.state is LimitsState.throttled, name
        assert r.funds.value.state is FundsState.unknown


async def openai_missing_scopes() -> None:
    r = await run(ProviderId.openai, "missing_scopes")
    assert r.overall is Overall.amber
    assert "permission_denied" in codes(r)
    assert r.validity.value is not Validity.invalid


async def gemini_invalid() -> None:
    for name in ("unauthenticated", "bad_request_api_key_invalid"):
        r = await run(ProviderId.gemini, name)
        assert r.validity.value is Validity.invalid, name


async def gemini_restricted() -> None:
    """Amber when it depends on where the call comes from; red when it fails from anywhere."""
    for name, code in (
        ("ip_restricted", "gemini_ip_restricted"),
        ("referrer_restricted", "gemini_referrer_restricted"),
        ("android_app_restricted", "gemini_android_app_restricted"),
        ("ios_app_restricted", "gemini_ios_app_restricted"),
    ):
        r = await run(ProviderId.gemini, name)
        assert r.overall is Overall.amber, name
        assert code in codes(r), name
        assert "permission_denied" not in codes(r), "the specific reason replaces the generic one"
    for name, code in (
        ("service_blocked", "gemini_service_blocked"),
        ("service_disabled", "gemini_api_disabled"),
        ("billing_disabled", "gemini_billing_disabled"),  # arrives as 400 FAILED_PRECONDITION
        ("consumer_suspended", "gemini_project_suspended"),
    ):
        r = await run(ProviderId.gemini, name)
        assert r.overall is Overall.red, name
        assert code in codes(r), name
        assert "permission_denied" not in codes(r), name


async def gemini_leaked() -> None:
    r = await run(ProviderId.gemini, "leaked")
    assert r.validity.value is Validity.blocked
    assert r.overall is Overall.red


async def gemini_prepay() -> None:
    for name in ("payment_required", "prepay_depleted_429"):
        r = await run(ProviderId.gemini, name)
        assert r.funds.value.state is FundsState.empty, name
        assert r.overall is Overall.red


async def gemini_quota() -> None:
    r = await run(ProviderId.gemini, "quota_free_tier")
    assert r.limits is not None
    assert r.limits.value.state is LimitsState.throttled
    assert r.account["plan"].value == "free_tier"
    assert r.account["plan"].source == "inferred"


async def gemini_aq_unsupported() -> None:
    r = await run(ProviderId.gemini, "aq_access_token_type_unsupported")
    assert r.validity.value is Validity.invalid
    assert "gemini_aq_rejected" in codes(r)
    assert "validity_invalid" in codes(r)


async def xai_invalid() -> None:
    r = await run(ProviderId.xai, "invalid_key")  # 400, not the documented 401
    assert r.validity.value is Validity.invalid
    assert r.overall is Overall.red
    mgmt = cred(ProviderId.xai, CredentialKind.management_key)
    fx = fixture("xai", "management_invalid_key")
    plugin = get_provider(ProviderId.xai)
    assert plugin is not None
    with respx.mock as router:
        router.route(host="management-api.x.ai").mock(
            return_value=httpx.Response(fx["status"], json=fx["body"])
        )
        async with make_client(plugin.routes(mgmt.kind), FAST) as http:
            obs = await plugin.check_passive(mgmt, "s", http, ProviderContext(now=NOW, http=FAST))
    assert evaluate(mgmt, obs, NOW).validity.value is Validity.invalid


async def xai_flags() -> None:
    for name, code in (
        ("api_key_team_blocked", "team_blocked"),
        ("api_key_disabled", "key_disabled"),
        ("api_key_blocked", "key_blocked"),
    ):
        r = await run(ProviderId.xai, name)
        assert r.validity.value is Validity.blocked, name
        assert code in codes(r)
        assert r.overall is Overall.red


def xai_mgmt_expired() -> None:
    item = fixture("xai", "management_api_keys")["body"]["apiKeys"][0]
    f = map_management_key_item(item, NOW)
    assert f.expiry is ExpiryState.expired
    assert f.validity is Validity.valid  # "disabled": "false" (string in the docs example)
    assert map_management_key_item({**item, "disabled": "true"}, NOW).validity is Validity.blocked
    future = {**item, "expireTime": "2030-01-01T00:00:00Z"}
    assert map_management_key_item(future, NOW).expiry is ExpiryState.scheduled
    r = evaluate(cred(ProviderId.xai), observation(f, now=NOW, http=None), NOW)
    assert r.overall is Overall.red


def openrouter_empty() -> None:
    ok = map_key_info(fixture("openrouter", "key_ok")["body"], NOW)
    assert ok.funds is FundsState.ok
    assert str(ok.funds_amount) == "74.5"
    empty = map_key_info(fixture("openrouter", "key_exhausted")["body"], NOW)
    assert empty.funds is FundsState.empty
    r = evaluate(cred(ProviderId.openrouter), observation(empty, now=NOW, http=None), NOW)
    assert r.overall is Overall.red


async def probe_404() -> None:
    from tests.test_check import Clock
    from tests.test_probes import test_missing_probe_model_is_misconfigured_not_invalid

    await test_missing_probe_model_is_misconfigured_not_invalid(Clock())


async def probe_timeout() -> None:
    from tests.test_check import Clock
    from tests.test_probes import test_probe_timeout_is_uncertain_and_never_resent

    await test_probe_timeout_is_uncertain_and_never_resent(Clock())


CASES: dict[str, Callable[[], Any]] = {
    "all-401": all_401,
    "all-403": all_403,
    "all-429": all_429,
    "all-network": all_network,
    "anthropic-credit": anthropic_credit,
    "anthropic-billing": anthropic_billing,
    "anthropic-admin-status": anthropic_admin_status,
    "openai-credit": openai_credit,
    "openai-spend-limit": openai_spend_limit,
    "openai-rate-limit": openai_rate_limit,
    "openai-missing-scopes": openai_missing_scopes,
    "gemini-invalid": gemini_invalid,
    "gemini-restricted": gemini_restricted,
    "gemini-leaked": gemini_leaked,
    "gemini-prepay": gemini_prepay,
    "gemini-quota": gemini_quota,
    "gemini-aq-unsupported": gemini_aq_unsupported,
    "xai-invalid": xai_invalid,
    "xai-flags": xai_flags,
    "xai-mgmt-expired": xai_mgmt_expired,
    "openrouter-empty": openrouter_empty,
    "probe-404": probe_404,
    "probe-timeout": probe_timeout,
}


def spec_row_ids() -> list[str]:
    spec = (ROOT / "SPEC.md").read_text(encoding="utf-8")
    section = spec[spec.index("### Mapa de errores") : spec.index("## Arquitectura y stack")]
    return re.findall(r"^\| `([a-z0-9-]+)` \|", section, re.MULTILINE)


def test_every_spec_row_has_a_case() -> None:
    ids = spec_row_ids()
    assert ids, "error map table not found in SPEC.md"
    assert sorted(ids) == sorted(CASES), "SPEC.md error map and tests/test_error_map.py differ"


@pytest.mark.parametrize("row_id", sorted(CASES))
async def test_error_map_row(row_id: str) -> None:
    result = CASES[row_id]()
    if hasattr(result, "__await__"):
        await result


def test_every_fixture_is_used() -> None:
    source = Path(__file__).read_text()
    test_files = "".join(p.read_text() for p in Path(__file__).parent.glob("test_*.py"))
    for path in FIXTURES.rglob("*.json"):
        assert f'"{path.stem}"' in test_files or f"'{path.stem}'" in source, path
