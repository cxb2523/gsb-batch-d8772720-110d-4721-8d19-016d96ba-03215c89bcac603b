"""Tests for the /render collection outcome field.

The outcome tells callers whether a fetch attempt really rendered the page
or never got one. These tests drive the real render route against a stub
browser layer so each failure path is fully controllable without spawning
Chromium:

* a handcrafted local page (inlined HTML) for the success path,
* a navigation that raises the patchright timeout,
* a route handler that aborts the request (outbound policy / blocklist),
* a saturated request queue (QueueFullError),
* a pool with no healthy worker (browser unavailable).

Validation failures happen before any fetch and must not carry an outcome.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

import pytest
from patchright.async_api import TimeoutError as PlaywrightTimeoutError

from veilrender.routes import render as render_module
from veilrender._vendor.httpserver import App, Request
from veilrender.browser import QueueFullError
from veilrender.config import settings
from veilrender.filters import make_route_handler

# A handcrafted "local page": served entirely from in-memory HTML, so the
# success path exercises the real readability/markdown/link extraction code.
SAMPLE_HTML = """
<!DOCTYPE html>
<html lang="en">
<head><title>Outcome Test Page</title></head>
<body>
  <h1>Rendered heading</h1>
  <p>This page exists solely to prove a successful fetch round-trips.</p>
  <ul>
    <li><a href="https://example.com/a">First link</a></li>
    <li><a href="https://example.com/b">Second link</a></li>
    <li><a href="#anchor">Anchor (ignored)</a></li>
    <li><a href="javascript:void(0)">JS link (ignored)</a></li>
  </ul>
</body>
</html>
"""

BLOCKED_DOMAIN = "blocked-by-policy.test"


# ---------------------------------------------------------------------------
# Patchright-level fakes
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status


class _BlockedNavigationError(Exception):
    """Mirror of the error patchright raises after route.abort()."""


class _FakeRoute:
    def __init__(self, url: str) -> None:
        self.request = type("_FakeRequest", (), {"url": url})()
        self.aborted = False

    async def abort(self, reason: str = "failed") -> None:
        self.aborted = True
        self._abort_reason = reason

    async def continue_(self, **_kwargs) -> None:
        pass


class _FakePage:
    """Playwright Page stand-in wired to the manager's real route handler."""

    def __init__(self, html: str, url: str, route_handler, *, behavior: str) -> None:
        self._html = html
        self._url = url
        self._route_handler = route_handler
        self._behavior = behavior
        self.routes: list = []

    async def route(self, pattern: str, handler) -> None:
        self.routes.append((pattern, handler))

    async def goto(self, url: str, **_kwargs) -> _FakeResponse:
        # Reproduce page.route() semantics: the installed handler sees the
        # request before navigation proceeds.
        if self._route_handler is not None:
            route = _FakeRoute(url)
            await self._route_handler(route)
            if route.aborted:
                raise _BlockedNavigationError(
                    f"net::ERR_BLOCKED_BY_CLIENT at {url} ({route._abort_reason})"
                )

        if self._behavior == "timeout":
            raise PlaywrightTimeoutError(
                f"page.goto: Timeout 1000ms exceeded while navigating to {url}"
            )
        if self._behavior == "timeout_after_goto":
            # goto completes, but reading the page afterwards stalls. That
            # timeout escapes _do_render (only goto is wrapped) and reaches
            # the route-level timeout handling.
            return _FakeResponse(200)
        if self._behavior == "hang":
            # Never resolves — used to trip the outer request deadline.
            await asyncio.Event().wait()
        return _FakeResponse(200)

    async def title(self) -> str:
        if self._behavior == "timeout_after_goto":
            raise PlaywrightTimeoutError("page.title: Timeout 1000ms exceeded")
        return "Outcome Test Page"

    @property
    def url(self) -> str:
        return self._url

    async def content(self) -> str:
        return self._html


class _FakeContext:
    def __init__(self, page: _FakePage) -> None:
        self._page = page

    async def new_page(self) -> _FakePage:
        return self._page

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Worker / BrowserManager stubs
# ---------------------------------------------------------------------------


class _StubWorker:
    """Worker stand-in; no browser process is ever launched."""

    def __init__(
        self,
        *,
        tier: int,
        label: str,
        healthy: bool = True,
        force_wait_until=None,
    ) -> None:
        self.tier = tier
        self.label = label
        self.healthy = healthy
        self.force_wait_until = force_wait_until


class _StubBrowserManager:
    """Replaces the module-level browser_manager inside the render route."""

    def __init__(
        self,
        *,
        behavior: str = "ok",
        html: str = SAMPLE_HTML,
        url: str = "https://example.com/page",
        tier: int = 1,
        label: str = "beta",
        blocklist: frozenset[str] = frozenset(),
        max_queue: int = 0,
        queue_depth: int = 0,
        fail_pick: bool = False,
    ) -> None:
        self._behavior = behavior
        self._html = html
        self._url = url
        self._max_queue = max_queue
        self._queue_depth_value = queue_depth
        self._fail_pick = fail_pick
        self._workers = [_StubWorker(tier=tier, label=label)]
        self.get_page_calls = 0
        # Real policy handler so an abort travels the same code path as
        # production filters.make_route_handler().
        self._route_handler = make_route_handler(blocklist)

    def has_fallback_tier(self, current_tier: int) -> bool:
        return any(w.healthy and w.tier > current_tier for w in self._workers)

    @contextlib.asynccontextmanager
    async def get_page(self, *, min_tier: int = 0):
        self.get_page_calls += 1
        if self._max_queue > 0 and self._queue_depth_value >= self._max_queue:
            raise QueueFullError("Request queue depth limit reached")
        if self._fail_pick:
            raise RuntimeError("No healthy browser workers available")

        worker = min(
            (w for w in self._workers if w.healthy and w.tier >= min_tier),
            key=lambda w: w.tier,
        )
        page = _FakePage(
            self._html,
            self._url,
            self._route_handler,
            behavior=self._behavior,
        )
        ctx = _FakeContext(page)
        yield ctx, page, worker.label, worker.force_wait_until


# ---------------------------------------------------------------------------
# Route harness
# ---------------------------------------------------------------------------


def _make_app(monkeypatch, manager: _StubBrowserManager) -> App:
    monkeypatch.setattr(render_module, "browser_manager", manager)
    # URL validation performs real DNS; the render route's policy decisions
    # are what these tests exercise, so make the up-front/redirect checks a
    # pass-through (the dedicated ordering test below uses the real one).
    monkeypatch.setattr(render_module, "validate_url", lambda url: url)
    app = App()
    render_module.register(app)
    return app


async def _post_render(app: App, payload: dict) -> tuple[int, dict]:
    request = Request(
        method="POST",
        path="/render",
        query_string="",
        headers={"content-type": "application/json"},
        body=json.dumps(payload).encode("utf-8"),
        client_addr=("127.0.0.1", 51234),
        app=app,
    )
    route = next(iter(app._routes))
    response = await route.handler(request)
    return response.status_code, json.loads(response.body.decode("utf-8"))


def _run(coro) -> object:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------


def test_success_outcome_keeps_content_and_links(monkeypatch) -> None:
    manager = _StubBrowserManager()
    app = _make_app(monkeypatch, manager)

    status, body = _run(
        _post_render(
            app,
            {"url": "https://example.com/page", "formats": ["html", "markdown"]},
        )
    )

    assert status == 200
    # Content pipeline unchanged by the outcome work.
    assert body["content"]["html"] == SAMPLE_HTML
    assert "Rendered heading" in body["content"]["markdown"]
    assert body["metadata"] == {
        "title": "Outcome Test Page",
        "url": "https://example.com/page",
        "status_code": 200,
    }
    # Link extraction behaves exactly as before (anchor/javascript dropped).
    assert body["links"] == [
        {"url": "https://example.com/a", "text": "First link"},
        {"url": "https://example.com/b", "text": "Second link"},
    ]
    outcome = body["outcome"]
    assert outcome == {"status": "success", "engine": "beta", "reason": ""}


def test_success_outcome_reports_alpha_engine(monkeypatch) -> None:
    manager = _StubBrowserManager(tier=0, label="alpha")
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": "https://example.com/page"}))

    assert status == 200
    assert body["outcome"]["status"] == "success"
    assert body["outcome"]["engine"] == "alpha"
    assert body["outcome"]["reason"] == ""


# ---------------------------------------------------------------------------
# Navigation timeout
# ---------------------------------------------------------------------------


def test_navigation_timeout_outcome(monkeypatch) -> None:
    manager = _StubBrowserManager(behavior="timeout_after_goto")
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": "https://example.com/slow"}))

    assert status == 504
    outcome = body["outcome"]
    assert outcome["status"] == "timeout"
    assert outcome["engine"] == "beta"
    assert "Timeout" in outcome["reason"]
    # A failure must never present fabricated page content.
    assert body["content"] == {}
    assert body["links"] == []
    assert body["error"] == "Render timed out"


def test_goto_timeout_captured_as_partial_is_not_failure(monkeypatch) -> None:
    """A goto timeout the pipeline deliberately degrades to partial content
    still returns a success outcome — the page was fetched, just incompletely.
    """
    manager = _StubBrowserManager(behavior="timeout")
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": "https://example.com/slow"}))

    assert status == 200
    assert body["outcome"]["status"] == "success"
    assert body["metadata"]["partial"] is True
    # The partial HTML is whatever the engine had captured, not fabricated.
    assert body["content"]["html"] == SAMPLE_HTML


def test_request_deadline_timeout_outcome(monkeypatch) -> None:
    """A navigation that hangs past the hard deadline is a timeout too."""
    monkeypatch.setattr(settings, "request_deadline", 1)
    manager = _StubBrowserManager(behavior="hang")
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": "https://example.com/hanging"}))

    assert status == 504
    assert body["outcome"]["status"] == "timeout"
    assert body["outcome"]["engine"] == "beta"
    assert body["content"] == {}
    assert body["links"] == []


# ---------------------------------------------------------------------------
# Outbound policy / blocklist interception
# ---------------------------------------------------------------------------


def test_blocked_navigation_outcome(monkeypatch) -> None:
    manager = _StubBrowserManager(
        url=f"https://{BLOCKED_DOMAIN}/page",
        blocklist=frozenset({BLOCKED_DOMAIN}),
    )
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": f"https://{BLOCKED_DOMAIN}/page"}))

    assert status == 400
    outcome = body["outcome"]
    assert outcome["status"] == "blocked"
    assert outcome["engine"] == "beta"
    assert "blockedbyclient" in outcome["reason"]
    assert body["error"] == "Destination blocked by outbound request policy"
    assert body["content"] == {}
    assert body["links"] == []


def test_blocked_is_not_classified_as_timeout(monkeypatch) -> None:
    """The route-handler abort must win over any timeout interpretation."""
    manager = _StubBrowserManager(
        url=f"https://{BLOCKED_DOMAIN}/page",
        blocklist=frozenset({BLOCKED_DOMAIN}),
        behavior="timeout",  # the abort fires first inside goto()
    )
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": f"https://{BLOCKED_DOMAIN}/page"}))

    assert status == 400
    assert body["outcome"]["status"] == "blocked"
    assert body["outcome"]["status"] != "timeout"


# ---------------------------------------------------------------------------
# Queue full
# ---------------------------------------------------------------------------


def test_queue_full_outcome(monkeypatch) -> None:
    manager = _StubBrowserManager(max_queue=1, queue_depth=1)
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": "https://example.com/page"}))

    assert status == 503
    outcome = body["outcome"]
    assert outcome["status"] == "queue_full"
    # No worker slot was acquired, so no engine label exists to report.
    assert outcome["engine"] == ""
    assert "queue" in outcome["reason"].lower()
    assert body["content"] == {}
    assert body["links"] == []
    assert body["error"] == "Server overloaded, try again later"


# ---------------------------------------------------------------------------
# Browser unavailable
# ---------------------------------------------------------------------------


def test_browser_unavailable_outcome(monkeypatch) -> None:
    manager = _StubBrowserManager(fail_pick=True)
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {"url": "https://example.com/page"}))

    assert status == 502
    outcome = body["outcome"]
    assert outcome["status"] == "browser_unavailable"
    assert outcome["engine"] == ""
    assert "No healthy browser workers available" in outcome["reason"]
    assert body["content"] == {}
    assert body["links"] == []


# ---------------------------------------------------------------------------
# Validation runs first and never produces an outcome
# ---------------------------------------------------------------------------


def test_validation_failure_has_no_outcome(monkeypatch) -> None:
    manager = _StubBrowserManager()
    # Keep the real validate_url for this test.
    app = App()
    render_module.register(app)
    monkeypatch.setattr(render_module, "browser_manager", manager)

    status, body = _run(_post_render(app, {"url": "ftp://example.com/file"}))

    assert status == 400
    assert "outcome" not in body
    assert "error" in body
    # The fetch layer was never reached.
    assert manager.get_page_calls == 0


def test_missing_url_has_no_outcome(monkeypatch) -> None:
    manager = _StubBrowserManager()
    app = _make_app(monkeypatch, manager)

    status, body = _run(_post_render(app, {}))

    assert status == 400
    assert "outcome" not in body
    assert manager.get_page_calls == 0


def test_selector_clip_style_validation_precedes_fetch(monkeypatch) -> None:
    """Parameter validation must short-circuit before any browser work.

    The selector/clip exclusivity lives on the screenshot endpoint; here the
    render-side equivalent is URL validation. Both share the guarantee that
    a rejected request never reaches the browser layer.
    """
    manager = _StubBrowserManager()
    app = App()
    render_module.register(app)
    monkeypatch.setattr(render_module, "browser_manager", manager)

    status, body = _run(_post_render(app, {"url": "http://127.0.0.1:8080/admin"}))

    assert status == 400
    assert "outcome" not in body
    assert manager.get_page_calls == 0


# ---------------------------------------------------------------------------
# Failure classification unit coverage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("net::ERR_BLOCKED_BY_CLIENT", "blocked"),
        ("route abort: blockedbyclient", "blocked"),
        ("No healthy browser workers available", "browser_unavailable"),
        ("Target page, context or browser has been closed", "browser_unavailable"),
        ("Connection closed", "browser_unavailable"),
        ("Navigation failed because page crashed!", "error"),
        ("Download is starting", "error"),
    ],
)
def test_classify_failure(message: str, expected: str) -> None:
    assert render_module._classify_failure(Exception(message)) == expected
