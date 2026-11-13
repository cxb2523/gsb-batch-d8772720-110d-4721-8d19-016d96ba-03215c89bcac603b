"""Stable failure outcomes for user-controlled scrapes (engine="scrape").

Two interception classes must be distinguishable to callers:

* ``robots_disallowed`` — robots.txt explicitly disallows the path and
  ``strict_mode`` is enabled.
* ``redirect_blocked`` — a redirect landed on an SSRF-blocked target.

The responses must carry the stable reason code, the blocked original URL
and host, and (for redirects) the final URL — with query strings redacted.
Normal-path semantics (fail-open robots, successful fetches) are unchanged.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.testclient import TestClient

from jiro.errors import (
    RedirectBlockedError,
    RobotsDisallowedError,
    SSRFError,
)
from jiro.scraping.client import ScrapingClient


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def _make_settings(*, enabled: bool, strict: bool) -> MagicMock:
    settings = MagicMock()
    settings.timeout = 5.0
    settings.retries = 0
    settings.user_agent_rotation = False
    settings.host = "testserver.local"
    settings.robots_txt = {
        "enabled": enabled,
        "strict_mode": strict,
        "user_agent": "JiroBot/1.0",
        "cache_ttl_seconds": 3600,
    }
    settings.rate_limits_per_engine = {}
    settings.get.return_value = 20.0  # scraping.retry_budget_seconds
    return settings


@pytest.fixture
def strict_client() -> ScrapingClient:
    return ScrapingClient(_make_settings(enabled=True, strict=True))


@pytest.fixture
def lenient_client() -> ScrapingClient:
    return ScrapingClient(_make_settings(enabled=True, strict=False))


class _FakeResponse:
    """Minimal response object with a redirect ``url`` attribute."""

    def __init__(self, text: str = "<html>ok</html>", status_code: int = 200,
                 url: str | None = None) -> None:
        self.text = text
        self.status_code = status_code
        self.url = url


# --------------------------------------------------------------------------
# robots.txt — strict-mode interception
# --------------------------------------------------------------------------

class TestRobotsDisallowed:
    @pytest.mark.asyncio
    async def test_strict_disallowed_raises_stable_error(self, strict_client):
        robots_body = "User-agent: *\nDisallow: /private\n"
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = robots_body
        mock_cm = MagicMock()
        mock_cm.__aenter__.return_value.get = AsyncMock(return_value=mock_resp)

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch("httpx.AsyncClient", return_value=mock_cm):
            with pytest.raises(RobotsDisallowedError) as exc_info:
                await strict_client.get(
                    "https://example.com/private/secret", engine="scrape"
                )

        err = exc_info.value
        assert err.code == "robots_disallowed"
        assert err.status_code == 403
        assert err.details["reason"] == "robots_disallowed"
        assert err.details["host"] == "example.com"
        assert err.details["path"] == "/private/secret"
        # The requested URL is echoed back so the caller can match it.
        assert err.details["url"] == "https://example.com/private/secret"
        # No request to the target origin may have been issued.
        assert strict_client._robots_cache["example.com"][0] is False

    @pytest.mark.asyncio
    async def test_query_params_are_redacted_in_robots_error(self, strict_client):
        robots_body = "User-agent: *\nDisallow: /private\n"
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = robots_body
        mock_cm = MagicMock()
        mock_cm.__aenter__.return_value.get = AsyncMock(return_value=mock_resp)

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch("httpx.AsyncClient", return_value=mock_cm):
            with pytest.raises(RobotsDisallowedError) as exc_info:
                await strict_client.get(
                    "https://example.com/private?token=supersecret&a=1",
                    engine="scrape",
                )

        url_field = exc_info.value.details["url"]
        assert "[redacted]" in url_field
        assert "supersecret" not in url_field
        assert "token" not in url_field

    @pytest.mark.asyncio
    async def test_cached_disallow_still_raises(self, strict_client):
        # Pre-seed a negative cache entry; no robots fetch should happen.
        strict_client._robots_cache["example.com"] = (False, float("inf"))
        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch("httpx.AsyncClient") as mock_client:
            with pytest.raises(RobotsDisallowedError) as exc_info:
                await strict_client.get(
                    "https://example.com/private/x", engine="scrape"
                )
            mock_client.assert_not_called()

        assert exc_info.value.code == "robots_disallowed"
        assert exc_info.value.details["host"] == "example.com"

    @pytest.mark.asyncio
    async def test_non_strict_disallow_does_not_block(self, lenient_client):
        robots_body = "User-agent: *\nDisallow: /private\n"
        mock_robots = MagicMock()
        mock_robots.status_code = 200
        mock_robots.text = robots_body
        robots_cm = MagicMock()
        robots_cm.__aenter__.return_value.get = AsyncMock(return_value=mock_robots)

        fake = _FakeResponse(url="https://example.com/private/x")
        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch("httpx.AsyncClient", return_value=robots_cm), \
             patch.object(lenient_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            text, response = await lenient_client.get(
                "https://example.com/private/x", engine="scrape"
            )

        assert response is fake
        assert text == fake.text

    @pytest.mark.asyncio
    async def test_robots_fetch_failure_fails_open(self, strict_client):
        robots_cm = MagicMock()
        robots_cm.__aenter__.return_value.get = AsyncMock(
            side_effect=OSError("network down")
        )
        fake = _FakeResponse(url="https://example.com/anything")
        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch("httpx.AsyncClient", return_value=robots_cm), \
             patch.object(strict_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            text, response = await strict_client.get(
                "https://example.com/anything", engine="scrape"
            )

        assert response is fake
        # Fail-open result is cached for the host.
        assert strict_client._robots_cache["example.com"][0] is True

    @pytest.mark.asyncio
    async def test_allowed_path_proceeds_normally(self, strict_client):
        robots_body = "User-agent: *\nDisallow: /private\n"
        mock_robots = MagicMock()
        mock_robots.status_code = 200
        mock_robots.text = robots_body
        robots_cm = MagicMock()
        robots_cm.__aenter__.return_value.get = AsyncMock(return_value=mock_robots)

        fake = _FakeResponse(url="https://example.com/public")
        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch("httpx.AsyncClient", return_value=robots_cm), \
             patch.object(strict_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            text, response = await strict_client.get(
                "https://example.com/public", engine="scrape"
            )

        assert response is fake
        assert strict_client._robots_cache["example.com"][0] is True


# --------------------------------------------------------------------------
# Redirect SSRF interception
# --------------------------------------------------------------------------

class TestRedirectBlocked:
    @pytest.mark.asyncio
    async def test_redirect_to_private_ip_raises_stable_error(self, lenient_client):
        # robots disabled on this fixture path via enabled=True but the host
        # returns an allow-all policy; focus on redirect validation.
        lenient_client._respect_robots = False
        initial_url = "https://example.com/redirect"
        final_url = (
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
        )
        fake = _FakeResponse(url=final_url)

        async def _validate(url, **kwargs):
            # Initial target is fine; only the redirect target is blocked.
            if url == final_url:
                raise SSRFError(f"blocked target IP in {url}")
            return None

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(side_effect=_validate)), \
             patch.object(lenient_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            with pytest.raises(RedirectBlockedError) as exc_info:
                await lenient_client.get(initial_url, engine="scrape")

        err = exc_info.value
        assert err.code == "redirect_blocked"
        assert err.status_code == 400
        assert err.details["reason"] == "redirect_blocked"
        assert err.details["host"] == "example.com"
        assert err.details["url"] == "https://example.com/redirect"
        assert err.details["final_host"] == "169.254.169.254"
        assert err.details["final_url"].startswith(
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
        )
        # Backward-compatible alias kept alongside the canonical field name.
        assert err.details["redirect_url"] == err.details["final_url"]
        # The internal validation message must not leak verbatim.
        assert "blocked target IP" not in err.message

    @pytest.mark.asyncio
    async def test_redirect_blocked_is_an_ssrf_error(self, lenient_client):
        # Existing SSRFError guards (and runtime permanent-failure
        # classification) must keep matching the new error.
        lenient_client._respect_robots = False
        initial_url = "https://example.com/go"
        final_url = "http://10.0.0.5/admin"
        fake = _FakeResponse(url=final_url)

        async def _validate(url, **kwargs):
            if url == final_url:
                raise SSRFError("blocked target IP: 10.0.0.5")
            return None

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(side_effect=_validate)), \
             patch.object(lenient_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            with pytest.raises(SSRFError) as exc_info:
                await lenient_client.get(initial_url, engine="scrape")

        assert isinstance(exc_info.value, RedirectBlockedError)

    @pytest.mark.asyncio
    async def test_redirect_query_params_redacted(self, lenient_client):
        lenient_client._respect_robots = False
        initial_url = "https://example.com/start?orig=1"
        final_url = "http://192.168.1.1/internal?api_key=hunter2&x=1"
        fake = _FakeResponse(url=final_url)

        async def _validate(url, **kwargs):
            if url == final_url:
                raise SSRFError("blocked")
            return None

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(side_effect=_validate)), \
             patch.object(lenient_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            with pytest.raises(RedirectBlockedError) as exc_info:
                await lenient_client.get(initial_url, engine="scrape")

        details = exc_info.value.details
        assert "hunter2" not in str(details)
        assert "api_key" not in str(details)
        assert details["url"] == "https://example.com/start?[redacted]"
        assert details["final_url"] == "http://192.168.1.1/internal?[redacted]"

    @pytest.mark.asyncio
    async def test_redirect_not_retried(self, lenient_client):
        # A blocked redirect is a terminal security decision, not a
        # retryable transport failure.
        lenient_client._respect_robots = False
        lenient_client.retries = 3
        initial_url = "https://example.com/r"
        final_url = "http://127.0.0.1:9000/"
        fake = _FakeResponse(url=final_url)

        async def _validate(url, **kwargs):
            if url == final_url:
                raise SSRFError("blocked")
            return None

        do_request = AsyncMock(return_value=fake)
        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(side_effect=_validate)), \
             patch.object(lenient_client, "_do_request", new=do_request):
            with pytest.raises(RedirectBlockedError):
                await lenient_client.get(initial_url, engine="scrape")

        assert do_request.await_count == 1

    @pytest.mark.asyncio
    async def test_unchanged_redirect_passes_validation(self, lenient_client):
        lenient_client._respect_robots = False
        fake = _FakeResponse(url="https://example.com/public")
        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(return_value=None)), \
             patch.object(lenient_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            text, response = await lenient_client.get(
                "https://example.com/public", engine="scrape"
            )

        assert response is fake


# --------------------------------------------------------------------------
# Initial-target SSRF (distinct code from redirect_blocked)
# --------------------------------------------------------------------------

class TestInitialSSRF:
    @pytest.mark.asyncio
    async def test_initial_private_target_uses_ssrf_code(self, strict_client):
        strict_client._respect_robots = False

        async def _reject(url, **kwargs):
            raise SSRFError("blocked host: localhost")

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(side_effect=_reject)):
            with pytest.raises(SSRFError) as exc_info:
                await strict_client.get(
                    "http://localhost:8000/admin", engine="scrape"
                )

        err = exc_info.value
        # Must NOT be conflated with the redirect outcome.
        assert err.code == "ssrf_blocked"
        assert not isinstance(err, RedirectBlockedError)
        assert err.details["reason"] == "ssrf_blocked"
        assert err.details["host"] == "localhost"
        assert err.details["url"] == "http://localhost:8000/admin"

    @pytest.mark.asyncio
    async def test_initial_target_query_redacted(self, strict_client):
        strict_client._respect_robots = False

        async def _reject(url, **kwargs):
            raise SSRFError("blocked")

        with patch("jiro.scraping.client.async_validate_target_url",
                   new=AsyncMock(side_effect=_reject)):
            with pytest.raises(SSRFError) as exc_info:
                await strict_client.get(
                    "http://localhost:8000/x?password=hunter2",
                    engine="scrape",
                )

        assert "hunter2" not in str(exc_info.value.details)
        assert exc_info.value.details["url"] == (
            "http://localhost:8000/x?[redacted]"
        )


# --------------------------------------------------------------------------
# Defenses are scoped to user-controlled targets only
# --------------------------------------------------------------------------

class TestEngineScoping:
    @pytest.mark.asyncio
    async def test_non_scrape_engine_skips_robots_and_ssrf(self, strict_client):
        strict_client._respect_robots = True
        fake = _FakeResponse()
        with patch("jiro.scraping.client.async_validate_target_url") as validate, \
             patch.object(strict_client, "_enforce_robots") as robots, \
             patch.object(strict_client, "_do_request",
                          new=AsyncMock(return_value=fake)):
            text, response = await strict_client.get(
                "https://example.com/", engine="social"
            )

        validate.assert_not_called()
        robots.assert_not_called()
        assert response is fake


# --------------------------------------------------------------------------
# Serialized shape (what the /scrape caller actually receives)
# --------------------------------------------------------------------------

class TestCurlAdapterExposesFinalUrl:
    def test_adapter_url_property_delegates_to_response(self):
        # The curl_cffi transport wraps responses in _CurlResponseAdapter.
        # Without a delegated ``url`` property the post-redirect SSRF check
        # would silently no-op on the default transport.
        from jiro.scraping.client import _CurlResponseAdapter

        raw = MagicMock()
        raw.url = "http://10.0.0.5/after-redirect"
        adapter = _CurlResponseAdapter(raw)
        assert str(adapter.url) == "http://10.0.0.5/after-redirect"


class TestErrorSerialization:
    def test_robots_payload_shape(self):
        err = RobotsDisallowedError(
            "robots.txt disallows scraping example.com",
            details={
                "reason": "robots_disallowed",
                "url": "https://example.com/p?[redacted]",
                "host": "example.com",
                "path": "/p",
            },
        )
        payload = err.to_dict()
        assert payload["error_code"] == "robots_disallowed"
        assert payload["details"]["reason"] == "robots_disallowed"
        assert payload["details"]["host"] == "example.com"
        assert "traceback" not in str(payload).lower()

    def test_redirect_payload_shape(self):
        err = RedirectBlockedError(
            "redirect target blocked: http://10.0.0.1/?[redacted]",
            details={
                "reason": "redirect_blocked",
                "url": "https://example.com/start?[redacted]",
                "host": "example.com",
                "final_url": "http://10.0.0.1/?[redacted]",
                "redirect_url": "http://10.0.0.1/?[redacted]",
                "final_host": "10.0.0.1",
            },
        )
        payload = err.to_dict()
        assert payload["error_code"] == "redirect_blocked"
        assert payload["details"]["final_host"] == "10.0.0.1"
        # The two reason identifiers must never collapse into one string.
        assert payload["error_code"] != "robots_disallowed"


# --------------------------------------------------------------------------
# End-to-end /scrape route: the JSON the caller actually receives
# --------------------------------------------------------------------------

class _FakeRouteResponse:
    def __init__(self) -> None:
        self.status_code = 200
        self.text = (
            "<html><head><title>OK</title></head>"
            "<body><article><p>hello world</p></article></body></html>"
        )
        self.url = None


def _robots_error(url: str, **kwargs):
    raise RobotsDisallowedError(
        "robots.txt disallows scraping example.com",
        details={
            "reason": "robots_disallowed",
            "url": "https://example.com/private?[redacted]",
            "host": "example.com",
            "path": "/private",
        },
    )


def _redirect_error(url: str, **kwargs):
    raise RedirectBlockedError(
        "redirect target blocked: http://10.0.0.1/?[redacted]",
        details={
            "reason": "redirect_blocked",
            "url": "https://example.com/start?[redacted]",
            "host": "example.com",
            "final_url": "http://10.0.0.1/?[redacted]",
            "redirect_url": "http://10.0.0.1/?[redacted]",
            "final_host": "10.0.0.1",
        },
    )


class TestScrapeRouteFailureOutcomes:
    def test_robots_disallowed_response(self, settings):
        from jiro.server import create_app

        with TestClient(create_app(settings)) as client:
            client.app.state.scraper_client.get = AsyncMock(
                side_effect=_robots_error
            )
            r = client.post(
                "/scrape",
                json={"url": "https://example.com/private?token=abc"},
            )

        assert r.status_code == 403
        body = r.json()
        assert body["error_code"] == "robots_disallowed"
        assert body["details"]["reason"] == "robots_disallowed"
        assert body["details"]["host"] == "example.com"
        assert body["details"]["path"] == "/private"
        # Sensitive query material must never reach the caller.
        assert "abc" not in str(body)
        assert "token" not in str(body)
        assert "Traceback" not in str(body)

    def test_redirect_blocked_response(self, settings):
        from jiro.server import create_app

        with TestClient(create_app(settings)) as client:
            client.app.state.scraper_client.get = AsyncMock(
                side_effect=_redirect_error
            )
            r = client.post(
                "/scrape",
                json={"url": "https://example.com/start?secret=xyz"},
            )

        assert r.status_code == 400
        body = r.json()
        # Distinguishable from the robots outcome.
        assert body["error_code"] == "redirect_blocked"
        assert body["error_code"] != "robots_disallowed"
        details = body["details"]
        assert details["reason"] == "redirect_blocked"
        assert details["host"] == "example.com"
        assert details["final_host"] == "10.0.0.1"
        assert details["final_url"] == "http://10.0.0.1/?[redacted]"
        assert "xyz" not in str(body)
        assert "secret" not in str(body)
        assert "Traceback" not in str(body)

    def test_batch_marks_failed_item_with_stable_code(self, settings):
        from jiro.server import create_app

        with TestClient(create_app(settings)) as client:
            async def _get(url, **kwargs):
                if "bad" in url:
                    raise _robots_error(url)
                return _FakeRouteResponse().text, _FakeRouteResponse()

            client.app.state.scraper_client.get = AsyncMock(side_effect=_get)
            r = client.post(
                "/scrape/batch",
                json=[
                    {"url": "https://example.com/good"},
                    {"url": "https://example.com/bad"},
                ],
            )

        assert r.status_code == 200
        results = r.json()["results"]
        failed = [item for item in results if "error_code" in item]
        assert len(failed) == 1
        assert failed[0]["error_code"] == "robots_disallowed"
        assert failed[0]["details"]["reason"] == "robots_disallowed"
        ok = [item for item in results if "error_code" not in item]
        assert len(ok) == 1
        assert ok[0]["url"] == "https://example.com/good"
        assert ok[0]["status_code"] == 200
        assert "content" in ok[0]

    def test_success_path_keeps_fields_and_cached_flag(self, settings):
        from jiro.server import create_app

        with TestClient(create_app(settings)) as client:
            fake = _FakeRouteResponse()
            client.app.state.scraper_client.get = AsyncMock(
                return_value=(fake.text, fake)
            )
            first = client.post(
                "/scrape", json={"url": "https://example.com/page"}
            )
            second = client.post(
                "/scrape", json={"url": "https://example.com/page"}
            )

        assert first.status_code == 200
        payload = first.json()
        # Original response fields are untouched.
        assert payload["url"] == "https://example.com/page"
        assert payload["status_code"] == 200
        assert "content" in payload and "title" in payload
        assert payload["cached"] is False
        # Second identical request is served from the cache.
        assert second.status_code == 200
        assert second.json()["cached"] is True
