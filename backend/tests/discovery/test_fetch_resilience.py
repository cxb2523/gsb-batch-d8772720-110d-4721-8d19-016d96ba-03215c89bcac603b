"""Two failures the transport used to hide: a dead proxy and a replaced browser.

Both gaps share a shape. Something in the fetch layer *did* recover — a failed
proxy fell back to a direct connection, a crashed Chromium was rebuilt — but the
recovery was invisible to everyone downstream:

* the failed proxy was recorded on the per-search selector, and selectors are
  built fresh per search (``build_proxy_selector``), so the next search cycled
  onto the same dead endpoint and paid the same failure before falling back;
* the crash and rebuild left no mark on ``FetchStats``, so a successful fetch
  that only succeeded after swapping browsers looked identical to one that used
  the first browser, and a crash loop looked like a slow search.

Everything here runs against a local, scripted transport: fake HTTP pool, fake
browser session, fake/controllable proxy selector. None of it touches the network
or requires scrapling to be installed, because the behaviour under test is the
bookkeeping around a failure — not the failure itself.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.discovery.fetch import session as session_module
from app.discovery.fetch.proxy import DeadProxyRegistry, ProxySelector
from app.discovery.fetch.ratelimit import DomainRateLimiter, RateRule
from app.discovery.fetch.session import FetchSession
from app.discovery.types import FetchStatus, FetchTier

URL = "https://example.invalid/page"
PROXY_A = "http://127.0.0.1:8101"
PROXY_B = "http://127.0.0.1:8102"
HTML = "<html><body><p>" + "real content " * 400 + "</p></body></html>"


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def _limiter() -> DomainRateLimiter:
    """A limiter that never sleeps: pacing is covered elsewhere."""
    return DomainRateLimiter(default=RateRule(0.0, burst=100), jitter=0.0, adaptive=False)


def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    async def instant(_seconds: float) -> None:
        return None

    monkeypatch.setattr(session_module.asyncio, "sleep", instant)


# ---------------------------------------------------------------------------
# Transport doubles
# ---------------------------------------------------------------------------


@dataclass
class FakeResponse:
    """Minimal stand-in for a scrapling Response — only the fields we read."""

    url: str = URL
    status: int = 200
    body: bytes = HTML.encode()
    headers: dict[str, str] = field(default_factory=dict)


class FakeHttpPool:
    """Scripted HTTP transport: each call pops the next outcome.

    A call carrying a ``proxy`` kwarg is routed through ``proxy_outcomes`` so a
    test can make the proxy fail while the direct connection succeeds.
    """

    def __init__(
        self,
        *,
        direct: list[Any] | None = None,
        proxied: list[Any] | None = None,
    ) -> None:
        self._direct = list(direct or [FakeResponse()])
        self._proxied = list(proxied if proxied is not None else self._direct)
        self.calls: list[dict[str, Any]] = []

    async def get(self, url: str, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        script = self._proxied if kwargs.get("proxy") else self._direct
        outcome = script.pop(0) if len(script) > 1 else script[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def aclose(self) -> None:
        return None


class ProxyConnectError(Exception):
    """A proxy failure by every marker ``_looks_like_proxy_failure`` looks for."""


class TargetClosedError(Exception):
    """Same name Playwright gives the error; ``_browser_is_gone`` matches on it."""


class ScriptedBrowsers:
    """Factory for fake browser sessions, with one shared script of outcomes.

    Outcomes are consumed in order across *all* instances, because that is how
    the real flow behaves: a crashed session is discarded, a replacement is
    entered, and the very next fetch lands on the replacement.
    """

    def __init__(self, outcomes: list[Any]) -> None:
        self._outcomes = list(outcomes)
        self.instances: list[FakeBrowserSession] = []

    def __call__(self, **_kwargs: Any) -> FakeBrowserSession:
        instance = FakeBrowserSession(self)
        self.instances.append(instance)
        return instance

    def next_outcome(self, url: str) -> Any:
        """Consume the next scripted outcome; exhausted script means "succeeds".

        An empty script is the common case (one crash, then a healthy
        replacement), so treating it as success keeps the tests about the
        recovery rather than about restating a default.
        """
        outcome = self._outcomes.pop(0) if self._outcomes else None
        if isinstance(outcome, Exception):
            return outcome
        return outcome or FakeResponse(url=url)

    @property
    def created(self) -> int:
        return len(self.instances)


class FakeBrowserSession:
    """Stand-in for ``AsyncStealthySession``: ``__aenter__`` yields itself."""

    def __init__(self, factory: ScriptedBrowsers) -> None:
        self._factory = factory
        self.closed = False
        self.fetch_calls = 0

    async def __aenter__(self) -> FakeBrowserSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        self.closed = True

    async def fetch(self, url: str, **_kwargs: Any) -> Any:
        self.fetch_calls += 1
        outcome = self._factory.next_outcome(url)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeProxySelector:
    """A proxy selector whose rotation we can watch and pre-seed.

    ``dead`` is shared between instances deliberately: in production the memory
    lives process-wide (``DeadProxyRegistry``), while each search constructs a
    *fresh* selector. Sharing the set here models exactly that.
    """

    def __init__(self, proxies: list[str], *, dead: set[str] | None = None) -> None:
        self.proxies = list(proxies)
        self.dead = dead if dead is not None else set()
        self.issued: list[str | None] = []
        self.failed: list[str] = []

    def for_url(self, _url: str) -> str | None:
        for proxy in self.proxies:
            if proxy not in self.dead:
                self.issued.append(proxy)
                return proxy
        self.issued.append(None)
        return None

    def mark_failed(self, proxy: str) -> None:
        self.failed.append(proxy)
        self.dead.add(proxy)

    def describe(self) -> str:
        return f"fake proxy: {len(self.proxies) - len(self.dead)}/{len(self.proxies)} alive"


def _session(**kwargs: Any) -> FetchSession:
    return FetchSession(rate_limiter=_limiter(), **kwargs)


# ---------------------------------------------------------------------------
# Proxy memory: unit level, on the real selector
# ---------------------------------------------------------------------------


class TestProxySelectorMemory:
    def test_a_selector_built_for_the_next_search_skips_a_proxy_an_earlier_one_buried(self) -> None:
        """The bug: dead-proxy knowledge used to die with the search that found it."""
        registry = DeadProxyRegistry()
        first = ProxySelector(primary=PROXY_A, pool=[PROXY_B], dead=registry)
        handed_out = first.for_url(URL)
        assert handed_out is not None, "the fixture must actually hand out a proxy"

        first.mark_failed(handed_out)

        second = ProxySelector(primary=PROXY_A, pool=[PROXY_B], dead=registry)
        handed_out = [second.for_url(URL) for _ in range(2)]
        assert PROXY_A not in handed_out, f"a proxy known dead was selected again by a later search: {handed_out}"
        assert handed_out == [PROXY_B, PROXY_B], "the surviving proxy must still be used"

    def test_one_dead_proxy_does_not_retire_the_others(self) -> None:
        registry = DeadProxyRegistry()
        selector = ProxySelector(primary=PROXY_A, pool=[PROXY_B], dead=registry)
        registry.add(PROXY_A)

        assert selector.for_url(URL) == PROXY_B

    def test_all_proxies_dead_goes_direct_instead_of_raising(self) -> None:
        registry = DeadProxyRegistry()
        selector = ProxySelector(primary=PROXY_A, pool=[PROXY_B], dead=registry)
        selector.mark_failed(PROXY_A)
        selector.mark_failed(PROXY_B)

        assert selector.for_url(URL) is None, "an exhausted proxy pool must mean 'direct', never an error"
        assert selector.describe().startswith("proxy: 0/2 alive")

    def test_without_any_proxy_selector_returns_none(self) -> None:
        selector = ProxySelector(dead=DeadProxyRegistry())

        assert selector.for_url(URL) is None
        assert selector.enabled is False

    def test_default_selectors_share_the_process_registry(self) -> None:
        from app.discovery.fetch.proxy import process_dead_proxies

        selector = ProxySelector(primary=PROXY_A)

        assert selector._dead is process_dead_proxies()


# ---------------------------------------------------------------------------
# Proxy failure inside the session
# ---------------------------------------------------------------------------


class TestProxyFallbackInSession:
    def test_a_failed_proxy_is_retired_on_the_selector_and_the_fetch_goes_direct(self) -> None:
        selector = FakeProxySelector([PROXY_A, PROXY_B])
        session = _session(proxy=selector, stealth_enabled=False)
        session._http = FakeHttpPool(
            direct=[FakeResponse()],
            proxied=[ProxyConnectError("proxy connect failed: tunnel refused")],
        )

        result = run(session.get(URL, escalate=False))

        assert result.ok, "one dead proxy must not cost us the page"
        assert selector.failed == [PROXY_A], "the dead proxy was never reported to the selector"
        assert [call.get("proxy") for call in session._http.calls] == [PROXY_A, None], (
            "the retry after a proxy failure must drop the proxy and go direct"
        )

    def test_a_proxy_buried_by_one_search_is_not_reused_by_the_next(self) -> None:
        first_selector = FakeProxySelector([PROXY_A, PROXY_B])
        first = _session(proxy=first_selector, stealth_enabled=False)
        first._http = FakeHttpPool(
            direct=[FakeResponse()],
            proxied=[ProxyConnectError("proxy connect failed: tunnel refused")],
        )
        run(first.get(URL, escalate=False))

        # A new search builds a new selector over the same memory.
        second_selector = FakeProxySelector([PROXY_A, PROXY_B], dead=first_selector.dead)
        second = _session(proxy=second_selector, stealth_enabled=False)
        second._http = FakeHttpPool(direct=[FakeResponse()], proxied=[FakeResponse()])

        result = run(second.get(URL, escalate=False))

        assert result.ok
        assert second_selector.issued == [PROXY_B], (
            f"the next search re-selected a proxy already judged dead: {second_selector.issued}"
        )
        assert [call.get("proxy") for call in second._http.calls] == [PROXY_B, None] or [
            call.get("proxy") for call in second._http.calls
        ] == [PROXY_B], f"the dead proxy was used again: {second._http.calls}"

    def test_when_every_proxy_is_dead_the_search_connects_directly_without_error(self) -> None:
        selector = FakeProxySelector([PROXY_A, PROXY_B], dead={PROXY_A, PROXY_B})
        session = _session(proxy=selector, stealth_enabled=False)
        session._http = FakeHttpPool(direct=[FakeResponse()])

        result = run(session.get(URL, escalate=False))

        assert result.ok
        assert selector.issued == [None]
        assert all(call.get("proxy") is None for call in session._http.calls), "an exhausted pool must go direct"


# ---------------------------------------------------------------------------
# Browser crash and rebuild
# ---------------------------------------------------------------------------


class TestBrowserRebuildAccounting:
    def test_a_crash_then_a_healthy_rebuild_counts_one_of_each(self) -> None:
        browsers = ScriptedBrowsers([TargetClosedError("Target page, context or browser has been closed")])
        session = _session(stealth_enabled=True, real_chrome=False)
        session._stealth_session_factory = lambda: browsers

        result = run(session.get(URL, tier=FetchTier.STEALTH))

        assert result.ok, f"the rebuilt browser should have served the page, got {result.describe()}"
        assert browsers.created == 2, "the dead browser must be replaced once"
        assert session.stats.browser_crashes == 1
        assert session.stats.browser_restarts == 1
        assert session.stats.stealth_tier == 1

        as_dict = session.stats.as_dict()
        assert as_dict["browser_crashes"] == 1, "the crash is invisible outside the session"
        assert as_dict["browser_restarts"] == 1, "the rebuild is invisible outside the session"
        run(session.aclose())

    def test_the_closed_wording_is_recognised_too(self) -> None:
        """Same condition surfaces as a plain Error from some call sites."""
        browsers = ScriptedBrowsers([RuntimeError("Browser has been closed.")])
        session = _session(stealth_enabled=True, real_chrome=False)
        session._stealth_session_factory = lambda: browsers

        result = run(session.get(URL, tier=FetchTier.STEALTH))

        assert result.ok
        assert session.stats.browser_crashes == 1
        assert session.stats.browser_restarts == 1
        run(session.aclose())

    def test_a_second_crash_after_the_rebuild_fails_without_inflating_the_counts(self) -> None:
        browsers = ScriptedBrowsers(
            [
                TargetClosedError("Target page, context or browser has been closed"),
                TargetClosedError("Target page, context or browser has been closed"),
            ]
        )
        session = _session(stealth_enabled=True, real_chrome=False)
        session._stealth_session_factory = lambda: browsers

        result = run(session.get(URL, tier=FetchTier.STEALTH))

        assert not result.ok, "a browser that dies twice must be reported as a failure"
        assert result.status is FetchStatus.ERROR
        assert browsers.created == 2, f"the retry loop rebuilt more than once: {browsers.created} browsers"
        # A crash is counted when it triggers a rebuild. The second crash does not
        # trigger one, so the numbers stay at one crash and one restart rather
        # than growing with every retry attempt.
        assert session.stats.browser_crashes == 1
        assert session.stats.browser_restarts == 1
        run(session.aclose())

    def test_a_timeout_does_not_rebuild_the_browser(self) -> None:
        """Only a browser that is *gone* is recoverable by restarting it."""
        browsers = ScriptedBrowsers([TimeoutError("page load timed out")])
        session = _session(stealth_enabled=True, real_chrome=False)
        session._stealth_session_factory = lambda: browsers

        result = run(session.get(URL, tier=FetchTier.STEALTH))

        assert not result.ok
        assert result.status is FetchStatus.TIMEOUT
        assert browsers.created == 1
        assert session.stats.browser_crashes == 0
        assert session.stats.browser_restarts == 0
        run(session.aclose())


# ---------------------------------------------------------------------------
# Behaviour that must not change
# ---------------------------------------------------------------------------


class TestExistingBehaviourIsPreserved:
    def test_a_retryable_http_status_still_retries_with_backoff(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _no_backoff(monkeypatch)
        session = _session(stealth_enabled=False)
        session._http = FakeHttpPool(direct=[FakeResponse(status=500), FakeResponse(status=500), FakeResponse()])

        result = run(session.get(URL, escalate=False))

        assert result.ok
        assert len(session._http.calls) == 3, "a retryable error must still get its attempts"

    def test_a_403_is_authoritative_and_is_not_retried(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _no_backoff(monkeypatch)
        session = _session(stealth_enabled=False)
        session._http = FakeHttpPool(direct=[FakeResponse(status=403)])

        result = run(session.get(URL, escalate=False))

        assert result.status is FetchStatus.BLOCKED
        assert len(session._http.calls) == 1, "retrying a refusal only deepens the ban"

    def test_a_404_is_authoritative_and_is_not_retried(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _no_backoff(monkeypatch)
        session = _session(stealth_enabled=False)
        session._http = FakeHttpPool(direct=[FakeResponse(status=404)])

        result = run(session.get(URL, escalate=False))

        assert result.status is FetchStatus.NOT_FOUND
        assert len(session._http.calls) == 1

    def test_a_worse_browser_result_does_not_mask_a_usable_http_result(self) -> None:
        """Escalation is a promotion attempt, not a replacement."""
        browsers = ScriptedBrowsers([TimeoutError("browser timed out")])
        session = _session(stealth_enabled=True, real_chrome=False)
        session._stealth_session_factory = lambda: browsers
        # A thin 200: usable, but below ``min_html_bytes``, so it escalates.
        session._http = FakeHttpPool(direct=[FakeResponse(body=b"<html><body>thin</body></html>")])

        result = run(session.get(URL, min_html_bytes=2_000))

        assert result.ok and result.tier is FetchTier.HTTP, "a failed browser attempt replaced a usable HTTP response"
        assert session.stats.escalations == 1
        assert session.stats.browser_crashes == 0
        run(session.aclose())

    def test_a_cache_hit_counts_as_a_hit_not_as_another_fetch(self) -> None:
        session = _session(stealth_enabled=False)
        session._http = FakeHttpPool(direct=[FakeResponse()])

        first = run(session.get(URL, escalate=False))
        second = run(session.get(URL, escalate=False))

        assert first is second
        assert len(session._http.calls) == 1, "the second call went back to the network"
        assert session.stats.cache_hits == 1
        assert session.stats.fetches == 1, "a cache hit must not increment the fetch count"
