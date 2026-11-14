"""Outbound client: allowed hosts only, HTTPS only, no redirects, no headers in logs."""

from __future__ import annotations

import logging

import httpx
import pytest
import respx

from mecha.core.http import (
    DisallowedRequestError,
    HttpSettings,
    NetworkError,
    Route,
    make_client,
    send,
)
from mecha.core.models import CredentialKind, ProviderId
from mecha.providers import ENABLED, get_provider

pytestmark = pytest.mark.anyio


def anywhere(host: str) -> tuple[Route, ...]:
    """Every GET path on one host (for transport-level tests)."""
    return (Route("GET", host, "/.*"), Route("POST", host, "/.*"))


FAST = HttpSettings(timeout_seconds=1, retries=3, backoff_seconds=0)


async def no_sleep(_: float) -> None:
    return None


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/v1/models",
        "https://api.anthropic.com.evil.example/v1/models",
        "https://api.openai.com/v1/models",  # allowed for OpenAI, not for this client
        "https://api.anthropic.com:8443/v1/models",
        "http://api.anthropic.com/v1/models",
    ],
)
async def test_rejects_any_other_destination(url: str) -> None:
    with respx.mock(assert_all_called=False) as router:
        route = router.route().mock(return_value=httpx.Response(200, json={}))
        async with make_client(anywhere("api.anthropic.com"), FAST) as client:
            with pytest.raises(DisallowedRequestError):
                await send(client, "GET", url, settings=FAST, sleep=no_sleep)
        assert not route.called, "nothing may leave the machine"


async def test_allowed_host_passes() -> None:
    with respx.mock as router:
        router.get("https://api.anthropic.com/v1/models").mock(return_value=httpx.Response(200))
        async with make_client(anywhere("api.anthropic.com"), FAST) as client:
            ex = await send(client, "GET", "https://api.anthropic.com/v1/models", settings=FAST)
    assert ex.response.status_code == 200
    assert ex.attempts == 1


async def test_redirects_are_never_followed() -> None:
    with respx.mock(assert_all_called=False) as router:
        router.get("https://api.anthropic.com/v1/models").mock(
            return_value=httpx.Response(302, headers={"location": "https://evil.example/steal"})
        )
        evil = router.get("https://evil.example/steal").mock(return_value=httpx.Response(200))
        async with make_client(anywhere("api.anthropic.com"), FAST) as client:
            ex = await send(client, "GET", "https://api.anthropic.com/v1/models", settings=FAST)
    assert ex.response.status_code == 302
    assert not evil.called


async def test_retries_5xx_then_fails() -> None:
    delays: list[float] = []

    async def record(d: float) -> None:
        delays.append(d)

    settings = HttpSettings(timeout_seconds=1, retries=3, backoff_seconds=0.5)
    with respx.mock as router:
        route = router.get("https://api.x.ai/v1/api-key").mock(return_value=httpx.Response(503))
        async with make_client(anywhere("api.x.ai"), settings) as client:
            with pytest.raises(NetworkError, match="HTTP 503 after 4 attempts"):
                await send(
                    client, "GET", "https://api.x.ai/v1/api-key", settings=settings, sleep=record
                )
    assert route.call_count == 4
    assert delays == [0.5, 1.0, 2.0]  # exponential backoff


async def test_retries_timeouts_and_recovers() -> None:
    with respx.mock as router:
        router.get("https://api.x.ai/v1/api-key").mock(
            side_effect=[httpx.ConnectTimeout("t"), httpx.ConnectError("c"), httpx.Response(200)]
        )
        async with make_client(anywhere("api.x.ai"), FAST) as client:
            ex = await send(
                client, "GET", "https://api.x.ai/v1/api-key", settings=FAST, sleep=no_sleep
            )
    assert ex.attempts == 3


async def test_4xx_is_not_retried() -> None:
    with respx.mock as router:
        route = router.get("https://api.x.ai/v1/api-key").mock(return_value=httpx.Response(429))
        async with make_client(anywhere("api.x.ai"), FAST) as client:
            ex = await send(
                client, "GET", "https://api.x.ai/v1/api-key", settings=FAST, sleep=no_sleep
            )
    assert ex.response.status_code == 429
    assert route.call_count == 1


async def test_headers_never_reach_the_logs(caplog: pytest.LogCaptureFixture) -> None:
    secret = "xai-HEADERCANARY" + "x" * 60
    caplog.set_level(logging.DEBUG)
    with respx.mock as router:
        router.get("https://api.x.ai/v1/api-key").mock(return_value=httpx.Response(200, json={}))
        async with make_client(anywhere("api.x.ai"), FAST) as client:
            await send(
                client,
                "GET",
                "https://api.x.ai/v1/api-key",
                headers={"authorization": f"Bearer {secret}"},
                settings=FAST,
            )
    assert "HEADERCANARY" not in caplog.text
    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() >= logging.WARNING


def test_honours_proxy_and_ca_settings_but_never_redirects() -> None:
    client = make_client(anywhere("api.x.ai"))
    assert client.trust_env is True  # HTTPS_PROXY / SSL_CERT_FILE for corporate networks
    assert client.follow_redirects is False
    assert client.auth is None  # no .netrc: httpx only uses it with an explicit NetRCAuth


async def test_guard_still_blocks_other_hosts_behind_a_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.corp.example:3128")
    with respx.mock(assert_all_called=False) as router:
        route = router.route().mock(return_value=httpx.Response(200))
        async with make_client(anywhere("api.x.ai"), FAST) as client:
            with pytest.raises(DisallowedRequestError):
                await send(client, "GET", "https://evil.example/", settings=FAST, sleep=no_sleep)
            ok = await send(client, "GET", "https://api.x.ai/v1/api-key", settings=FAST)
    assert ok.response.status_code == 200
    assert route.call_count == 1


def test_client_requires_hosts() -> None:
    with pytest.raises(ValueError, match="at least one allowed route"):
        make_client(())


@pytest.mark.parametrize("provider_id", ENABLED)
def test_every_plugin_declares_official_hosts_only(provider_id: ProviderId) -> None:
    provider = get_provider(provider_id)
    assert provider is not None
    expected = {
        "anthropic": {"api.anthropic.com"},
        "openai": {"api.openai.com"},
        "gemini": {"generativelanguage.googleapis.com"},
        "xai": {"api.x.ai", "management-api.x.ai"},
        "openrouter": {"openrouter.ai"},
    }[provider.id.value]
    hosts = {r.host for kind in CredentialKind for r in provider.routes(kind)}
    assert hosts == expected


@pytest.mark.parametrize("provider_id", ENABLED)
def test_admin_and_management_keys_only_read(provider_id: ProviderId) -> None:
    provider = get_provider(provider_id)
    assert provider is not None
    for kind in (CredentialKind.admin_key, CredentialKind.management_key):
        assert all(r.method == "GET" for r in provider.routes(kind)), (provider_id, kind)


@pytest.mark.parametrize("provider_id", ENABLED)
def test_oauth_credentials_have_no_routes(provider_id: ProviderId) -> None:
    provider = get_provider(provider_id)
    assert provider is not None
    for kind in (CredentialKind.oauth_token, CredentialKind.oauth_file):
        assert provider.routes(kind) == ()


def _routes(provider: ProviderId, kind: CredentialKind) -> tuple[Route, ...]:
    plugin = get_provider(provider)
    assert plugin is not None
    return plugin.routes(kind)


@pytest.mark.parametrize(
    ("provider", "kind", "method", "url"),
    [
        # An OpenAI admin key could delete keys or create projects: never allowed.
        (
            ProviderId.openai,
            CredentialKind.admin_key,
            "DELETE",
            "https://api.openai.com/v1/organization/projects/p1/api_keys/k1",
        ),
        (
            ProviderId.openai,
            CredentialKind.admin_key,
            "POST",
            "https://api.openai.com/v1/organization/admin_api_keys",
        ),
        (
            ProviderId.openai,
            CredentialKind.admin_key,
            "POST",
            "https://api.openai.com/v1/organization/projects",
        ),
        (
            ProviderId.openai,
            CredentialKind.admin_key,
            "GET",
            "https://api.openai.com/v1/organization/users",
        ),
        (
            ProviderId.anthropic,
            CredentialKind.admin_key,
            "POST",
            "https://api.anthropic.com/v1/organizations/api_keys/k1",
        ),
        (
            ProviderId.anthropic,
            CredentialKind.admin_key,
            "GET",
            "https://api.anthropic.com/v1/models",
        ),
        # An xAI management key only reaches management-api.x.ai, and only to read.
        (ProviderId.xai, CredentialKind.management_key, "GET", "https://api.x.ai/v1/api-key"),
        (
            ProviderId.xai,
            CredentialKind.management_key,
            "POST",
            "https://management-api.x.ai/auth/teams/t1/api-keys",
        ),
        (
            ProviderId.xai,
            CredentialKind.management_key,
            "DELETE",
            "https://management-api.x.ai/auth/api-keys/k1",
        ),
        (
            ProviderId.xai,
            CredentialKind.management_key,
            "POST",
            "https://management-api.x.ai/v1/billing/teams/t1/prepaid/top-up",
        ),
        # A normal key never reaches the management API.
        (
            ProviderId.xai,
            CredentialKind.api_key,
            "GET",
            "https://management-api.x.ai/auth/management-keys/validation",
        ),
        # Path tricks.
        (
            ProviderId.openai,
            CredentialKind.admin_key,
            "GET",
            "https://api.openai.com/v1/organization/projects/../users/api_keys",
        ),
        (
            ProviderId.openai,
            CredentialKind.admin_key,
            "GET",
            "https://api.openai.com/v1/organization/projects/p1/api_keys/k1",
        ),
    ],
)
async def test_forbidden_routes_never_leave(
    provider: ProviderId, kind: CredentialKind, method: str, url: str
) -> None:
    with respx.mock(assert_all_called=False) as router:
        route = router.route().mock(return_value=httpx.Response(200, json={}))
        async with make_client(_routes(provider, kind), FAST) as client:
            with pytest.raises(DisallowedRequestError):
                await send(client, method, url, settings=FAST, sleep=no_sleep)
    assert not route.called


async def test_allowed_admin_reads_pass() -> None:
    with respx.mock as router:
        router.route(host="api.openai.com").mock(return_value=httpx.Response(200, json={}))
        async with make_client(_routes(ProviderId.openai, CredentialKind.admin_key), FAST) as c:
            for path in (
                "/v1/organization/projects",
                "/v1/organization/projects/proj_abc-1/api_keys",
                "/v1/organization/costs",
            ):
                ex = await send(c, "GET", f"https://api.openai.com{path}", settings=FAST)
                assert ex.response.status_code == 200


async def test_post_is_never_retried_and_a_timeout_is_uncertain() -> None:
    routes = _routes(ProviderId.anthropic, CredentialKind.api_key)
    with respx.mock as router:
        route = router.route(method="POST", host="api.anthropic.com").mock(
            side_effect=httpx.ReadTimeout("slow")
        )
        async with make_client(routes, FAST) as client:
            with pytest.raises(NetworkError) as exc:
                await send(
                    client,
                    "POST",
                    "https://api.anthropic.com/v1/messages",
                    json={},
                    settings=FAST,
                    sleep=no_sleep,
                )
    assert route.call_count == 1, "a POST that may have been billed is not sent twice"
    assert exc.value.uncertain


async def test_post_connect_error_is_not_uncertain_and_5xx_not_retried() -> None:
    routes = _routes(ProviderId.anthropic, CredentialKind.api_key)
    with respx.mock as router:
        route = router.route(method="POST", host="api.anthropic.com").mock(
            side_effect=httpx.ConnectError("down")
        )
        async with make_client(routes, FAST) as client:
            with pytest.raises(NetworkError) as exc:
                await send(
                    client,
                    "POST",
                    "https://api.anthropic.com/v1/messages",
                    settings=FAST,
                    sleep=no_sleep,
                )
        assert route.call_count == 1
        assert not exc.value.uncertain  # the request never reached the provider
        route.mock(return_value=httpx.Response(529))
        async with make_client(routes, FAST) as client:
            ex = await send(
                client,
                "POST",
                "https://api.anthropic.com/v1/messages",
                settings=FAST,
                sleep=no_sleep,
            )
        assert ex.response.status_code == 529  # returned as-is, not retried
