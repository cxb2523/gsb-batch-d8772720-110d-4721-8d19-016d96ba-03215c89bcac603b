"""Passive checks of each plugin against official-docs examples."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
import respx

from mecha.core.capabilities import load_capabilities
from mecha.core.http import HttpSettings, make_client
from mecha.core.models import CredentialKind, LimitsState, Overall, ProviderId, Validity
from mecha.core.status import evaluate
from mecha.providers import ENABLED, get_provider
from mecha.providers.base import ProviderContext
from tests.test_error_map import cred, fixture

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
FAST = HttpSettings(timeout_seconds=1, retries=0, backoff_seconds=0)
SECRET = "test-secret-not-a-real-key"


async def call(
    provider: ProviderId, kind: CredentialKind, url: str, fx_name: str, version: str = "2026-10-21"
) -> tuple[Any, httpx.Request]:
    fx = fixture(provider.value, fx_name)
    plugin = get_provider(provider)
    assert plugin is not None
    with respx.mock as router:
        route = router.get(url__startswith=url).mock(
            return_value=httpx.Response(fx["status"], json=fx["body"], headers=fx["headers"])
        )
        async with make_client(plugin.routes(kind), FAST) as http:
            c = cred(provider, kind)
            ctx = ProviderContext(now=NOW, http=FAST, anthropic_version=version)
            obs = await plugin.check_passive(c, SECRET, http, ctx)
        request: httpx.Request = route.calls.last.request
    return evaluate(c, obs, NOW), request


async def test_anthropic_models() -> None:
    r, req = await call(
        ProviderId.anthropic,
        CredentialKind.api_key,
        "https://api.anthropic.com/v1/models",
        "models_ok",
    )
    assert req.headers["x-api-key"] == SECRET
    assert req.headers["anthropic-version"] == "2026-10-21"
    assert "authorization" not in req.headers
    assert r.overall is Overall.green
    assert r.account["models"].value == "2"
    assert r.account["org_id"].source == "header"
    assert r.limits is not None
    assert r.limits.value.requests is not None
    assert r.limits.value.requests.remaining == 3999
    assert r.http is not None
    assert "x-api-key" not in r.http.headers


async def test_anthropic_version_comes_from_config() -> None:
    _, req = await call(
        ProviderId.anthropic,
        CredentialKind.api_key,
        "https://api.anthropic.com/v1/models",
        "models_ok",
        version="2023-06-01",
    )
    assert req.headers["anthropic-version"] == "2023-06-01"


async def test_anthropic_admin_key_uses_admin_endpoint() -> None:
    r, req = await call(
        ProviderId.anthropic,
        CredentialKind.admin_key,
        "https://api.anthropic.com/v1/organizations/api_keys",
        "admin_api_keys_ok",
    )
    assert req.url.params["limit"] == "1"
    assert r.validity.value is Validity.valid


async def test_openai_models_and_rate_limit_headers() -> None:
    r, req = await call(
        ProviderId.openai, CredentialKind.api_key, "https://api.openai.com/v1/models", "models_ok"
    )
    assert req.headers["authorization"] == f"Bearer {SECRET}"
    assert r.overall is Overall.green
    assert r.account["org_id"].value == "org-example"
    limits = r.limits
    assert limits is not None
    assert limits.value.state is LimitsState.ok
    assert limits.value.tokens is not None
    assert limits.value.tokens.remaining == 149984
    assert limits.value.tokens.reset == NOW.replace(minute=6)  # "6m0s"


async def test_openai_admin_key_uses_admin_endpoint() -> None:
    r, _ = await call(
        ProviderId.openai,
        CredentialKind.admin_key,
        "https://api.openai.com/v1/organization/admin_api_keys",
        "admin_api_keys_ok",
    )
    assert r.validity.value is Validity.valid


async def test_gemini_key_in_header_never_in_url() -> None:
    r, req = await call(
        ProviderId.gemini,
        CredentialKind.api_key,
        "https://generativelanguage.googleapis.com/v1beta/models",
        "models_ok",
    )
    assert req.headers["x-goog-api-key"] == SECRET
    assert SECRET not in str(req.url)
    assert "key" not in req.url.params
    assert req.url.params["pageSize"] == "1000"
    assert r.overall is Overall.green
    assert r.account["models"].value == "2"


async def test_gemini_aiza_stays_amber_when_valid() -> None:
    fx = fixture("gemini", "models_ok")
    plugin = get_provider(ProviderId.gemini)
    assert plugin is not None
    c = cred(ProviderId.gemini, retiring=True)
    with respx.mock as router:
        router.route(host="generativelanguage.googleapis.com").mock(
            return_value=httpx.Response(200, json=fx["body"])
        )
        async with make_client(plugin.routes(c.kind), FAST) as http:
            obs = await plugin.check_passive(c, SECRET, http, ProviderContext(now=NOW, http=FAST))
    r = evaluate(c, obs, NOW)
    assert r.validity.value is Validity.valid
    assert r.overall is Overall.amber
    assert [x.code for x in r.reasons] == ["retiring_key_type"]


async def test_xai_api_key() -> None:
    r, req = await call(
        ProviderId.xai, CredentialKind.api_key, "https://api.x.ai/v1/api-key", "api_key_ok"
    )
    assert req.headers["authorization"] == f"Bearer {SECRET}"
    assert r.overall is Overall.green
    assert r.account["team_id"].value == "5ea6f6bd-7815-4b8a-9135-28b2d7ba6722"
    assert r.account["api_key_id"].value == "ae1e1841-4326-4b36-a8a9-8a1a7237db11"


async def test_xai_management_key() -> None:
    r, req = await call(
        ProviderId.xai,
        CredentialKind.management_key,
        "https://management-api.x.ai/auth/management-keys/validation",
        "management_validation_ok",
    )
    assert req.url.host == "management-api.x.ai"
    assert r.overall is Overall.green
    assert r.account["team_id"].value == "65c1e471-205f-4566-9c5a-07198badf4ce"


async def test_non_json_success_is_grey() -> None:
    plugin = get_provider(ProviderId.xai)
    assert plugin is not None
    with respx.mock as router:
        router.route(host="api.x.ai").mock(return_value=httpx.Response(200, text="<html>"))
        async with make_client(plugin.routes(CredentialKind.api_key), FAST) as http:
            obs = await plugin.check_passive(
                cred(ProviderId.xai), SECRET, http, ProviderContext(now=NOW, http=FAST)
            )
    assert evaluate(cred(ProviderId.xai), obs, NOW).overall is Overall.grey


async def test_provider_messages_are_scrubbed() -> None:
    """An error message echoing a key-shaped string must not be stored verbatim."""
    leaked = "sk-ant-api03-" + "E" * 60
    plugin = get_provider(ProviderId.anthropic)
    assert plugin is not None
    body = {
        "type": "error",
        "error": {"type": "authentication_error", "message": f"bad key {leaked}"},
    }
    with respx.mock as router:
        router.route(host="api.anthropic.com").mock(return_value=httpx.Response(401, json=body))
        async with make_client(plugin.routes(CredentialKind.api_key), FAST) as http:
            obs = await plugin.check_passive(
                cred(ProviderId.anthropic), SECRET, http, ProviderContext(now=NOW, http=FAST)
            )
    assert obs.error is not None
    assert leaked not in obs.error.message


# --- capability matrix (the contract) ------------------------------------------------------


def test_capabilities_cover_every_provider() -> None:
    caps = load_capabilities()
    assert set(caps) == set(ProviderId)


@pytest.mark.parametrize("provider_id", ENABLED)
def test_capabilities_match_plugin_endpoints(provider_id: ProviderId) -> None:
    plugin = get_provider(provider_id)
    caps = load_capabilities()[provider_id]
    assert plugin is not None
    for kind, endpoint in caps.passive.items():
        method, path = endpoint.split(" ", 1)
        assert method == "GET"
        base, plugin_path, _ = plugin.endpoint(kind)
        assert plugin_path == path, (provider_id, kind)
        assert httpx.URL(base).host in plugin.allowed_hosts


@pytest.mark.parametrize(
    "reason", sorted(__import__("mecha.providers.gemini.errors", fromlist=["x"]).CALLER_DEPENDENT)
)
def test_gemini_caller_dependent_reasons_are_amber(reason: str) -> None:
    from mecha.core.models import Overall as O
    from mecha.providers.gemini.errors import map_error

    body = {
        "error": {
            "code": 403,
            "status": "PERMISSION_DENIED",
            "message": "x",
            "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}],
        }
    }
    finding = map_error(403, body)
    assert [n.overall for n in finding.notes] == [O.amber], reason


@pytest.mark.parametrize(
    "reason", sorted(__import__("mecha.providers.gemini.errors", fromlist=["x"]).FAILS_EVERYWHERE)
)
def test_gemini_fails_everywhere_reasons_are_red(reason: str) -> None:
    from mecha.core.models import Overall as O
    from mecha.providers.gemini.errors import map_error

    for status in (400, 403):
        body = {
            "error": {
                "code": status,
                "status": "x",
                "message": "x",
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}
                ],
            }
        }
        finding = map_error(status, body)
        assert [n.overall for n in finding.notes] == [O.red], (reason, status)


def test_gemini_reason_texts_exist() -> None:
    from mecha.cli import REASON_TEXT
    from mecha.providers.gemini.errors import CALLER_DEPENDENT, FAILS_EVERYWHERE

    for code in {*CALLER_DEPENDENT.values(), *FAILS_EVERYWHERE.values()}:
        assert code in REASON_TEXT, code


def test_gemini_plain_400_is_not_a_permission_problem() -> None:
    from mecha.providers.gemini.errors import map_error

    finding = map_error(
        400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "bad"}}
    )
    assert not finding.understood  # unknown 400 stays grey, not amber
