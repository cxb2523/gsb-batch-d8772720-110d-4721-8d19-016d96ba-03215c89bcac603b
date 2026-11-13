"""Tests for Abrasio.fetch_pages — bounded concurrency batch fetching.

The fast tests replace the browser with a lightweight page object that talks to
the local HTTP server from ``conftest.py``; they exercise the batch scheduler,
failure classification and retry logic without needing Chrome. A final
integration test runs the same scenarios through a real Abrasio session when a
browser binary is available locally.
"""

import asyncio
import html as html_lib
import os
import re
from pathlib import Path

import httpx
import pytest

from abrasio import Abrasio, AbrasioConfig, AbrasioError
from abrasio._batch import (
    FailureReason,
    _html_to_text,
    fetch_pages_batch,
)


class FakeResponse:
    def __init__(self, status):
        self.status = status


class PageTracker:
    """Records page lifecycle so tests can assert limits and no leaks."""

    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.opened = 0
        self.closed = 0
        self.active_urls = {}
        self.max_active_per_url = {}

    def opened_page(self, url=None):
        self.active += 1
        self.opened += 1
        self.max_active = max(self.max_active, self.active)

    def closed_page(self):
        self.active -= 1
        self.closed += 1

    def enter_url(self, url):
        count = self.active_urls.get(url, 0) + 1
        self.active_urls[url] = count
        self.max_active_per_url[url] = max(self.max_active_per_url.get(url, 0), count)

    def leave_url(self, url):
        self.active_urls[url] = self.active_urls.get(url, 0) - 1


class FakePage:
    """Minimal async Page implementation backed by an httpx client."""

    def __init__(self, client, tracker, *, hang_urls=()):
        self._client = client
        self._tracker = tracker
        self._hang_urls = set(hang_urls)
        self._html = ""
        self._current_url = None
        self._closed = False
        self._tracker.opened_page()

    async def goto(self, url, timeout=None, wait_until=None):
        self._tracker.enter_url(url)
        try:
            if url in self._hang_urls:
                await asyncio.sleep(3600)
            kwargs = {} if timeout is None else {"timeout": timeout / 1000}
            response = await self._client.get(url, **kwargs)
            self._html = response.text
            self._current_url = str(response.url)
            return FakeResponse(response.status_code)
        finally:
            self._tracker.leave_url(url)

    async def title(self):
        match = re.search(r"<title>(.*?)</title>", self._html, re.I | re.S)
        return html_lib.unescape(match.group(1)).strip() if match else ""

    async def content(self):
        return self._html

    async def inner_text(self, selector="body"):
        return _html_to_text(self._html)

    async def evaluate(self, expression):
        return _html_to_text(self._html)

    @property
    def url(self):
        return self._current_url

    async def close(self):
        if not self._closed:
            self._closed = True
            self._tracker.closed_page()


class FakePageFactory:
    def __init__(self, *, hang_urls=(), fail_urls=()):
        self.tracker = PageTracker()
        self._hang_urls = set(hang_urls)
        self._fail_urls = set(fail_urls)
        self._client = httpx.AsyncClient(follow_redirects=True)

    async def __call__(self):
        return FakePage(self._client, self.tracker, hang_urls=self._hang_urls)

    async def aclose(self):
        await self._client.aclose()


@pytest.fixture
async def factory(http_server):
    """Factory bound to the test server, closed after each test."""
    f = FakePageFactory()

    async def page():
        # A factory that fails for a designated URL is covered separately; this
        # factory always succeeds at creating a page.
        return await f()

    f.page = page
    try:
        yield f
    finally:
        await f.aclose()


def _url(base_url, path):
    return f"{base_url}{path}"


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


async def test_concurrency_limit_is_enforced(factory, base_url, reset_server):
    urls = [_url(base_url, f"/ok/{i}") for i in range(8)]
    results = await fetch_pages_batch(
        factory.page, urls, max_concurrency=2, timeout=10
    )

    assert len(results) == len(urls)
    assert factory.tracker.max_active <= 2
    # Proves the queue actually admits new work for as long as it takes.
    assert factory.tracker.max_active == 2
    assert factory.tracker.opened == len(urls)
    assert factory.tracker.active == 0
    assert factory.tracker.opened == factory.tracker.closed
    assert all(r.ok for r in results)


async def test_concurrency_one_is_sequential(factory, base_url, reset_server):
    urls = [_url(base_url, f"/ok/{i}") for i in range(4)]
    results = await fetch_pages_batch(
        factory.page, urls, max_concurrency=1, timeout=10
    )

    assert factory.tracker.max_active == 1
    assert factory.tracker.opened == factory.tracker.closed == 4
    assert [r.url for r in results] == urls


async def test_invalid_concurrency_is_rejected(factory, base_url, reset_server):
    with pytest.raises(ValueError):
        await fetch_pages_batch(
            factory.page, [_url(base_url, "/ok/0")], max_concurrency=0
        )


# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------


async def test_failure_classes_and_success_fields(factory, base_url, reset_server):
    urls = [
        _url(base_url, "/ok/1"),
        _url(base_url, "/slow/5"),
        _url(base_url, "/blocked"),
        _url(base_url, "/empty"),
        _url(base_url, "/challenge"),
        _url(base_url, "/ok/2"),
    ]
    results = await fetch_pages_batch(
        factory.page, urls, max_concurrency=3, timeout=1
    )

    by_url = {r.url: r for r in results}
    assert [r.url for r in results] == urls

    ok1 = by_url[_url(base_url, "/ok/1")]
    assert ok1.status == "success"
    assert ok1.attempts == 1
    assert ok1.reason is None
    assert ok1.title == "Page 1"
    assert "Body text for page 1." in ok1.text

    slow = by_url[_url(base_url, "/slow/5")]
    assert slow.status == "failed"
    assert slow.reason == FailureReason.TIMEOUT
    assert slow.title is None and slow.text is None

    blocked = by_url[_url(base_url, "/blocked")]
    assert blocked.status == "failed"
    assert blocked.reason == FailureReason.BLOCKED
    assert blocked.status_code == 403

    empty = by_url[_url(base_url, "/empty")]
    assert empty.status == "failed"
    assert empty.reason == FailureReason.EMPTY
    assert empty.title == "Nothing here"
    assert empty.text is None

    challenge = by_url[_url(base_url, "/challenge")]
    assert challenge.status == "failed"
    assert challenge.reason == FailureReason.BLOCKED

    ok2 = by_url[_url(base_url, "/ok/2")]
    assert ok2.status == "success"
    assert ok2.title == "Page 2"


async def test_empty_body_is_empty_not_error(factory, base_url, reset_server):
    result = await fetch_pages_batch(
        factory.page, [_url(base_url, "/empty")], max_concurrency=1, timeout=5
    )
    assert len(result) == 1
    assert result[0].reason == FailureReason.EMPTY
    assert result[0].status == "failed"


async def test_duplicate_urls_never_run_concurrently(factory, base_url, reset_server):
    # A duplicated URL must not be fetched by two tasks at once, and the
    # results must still mirror the input order.
    url = _url(base_url, "/ok/dup")
    results = await fetch_pages_batch(
        factory.page, [url, url, url], max_concurrency=3, timeout=10
    )
    assert [r.url for r in results] == [url, url, url]
    assert all(r.ok for r in results)
    assert factory.tracker.max_active_per_url[url] == 1


# ---------------------------------------------------------------------------
# Retries
# ---------------------------------------------------------------------------


async def test_retries_until_success(factory, base_url, reset_server, http_server):
    url = _url(base_url, "/flaky/2")
    results = await fetch_pages_batch(
        factory.page, [url], max_concurrency=1, retries=3, retry_backoff=0, timeout=5
    )

    assert len(results) == 1
    assert results[0].status == "success"
    assert results[0].attempts == 3  # 2 blocked attempts + 1 success
    assert http_server.hits["/flaky/2"] == 3
    assert factory.tracker.opened == factory.tracker.closed == 3


async def test_retry_exhaustion_stops_attempting(factory, base_url, reset_server, http_server):
    url = _url(base_url, "/flaky/999")  # never recovers
    results = await fetch_pages_batch(
        factory.page, [url], max_concurrency=1, retries=2, retry_backoff=0, timeout=5
    )

    result = results[0]
    assert result.status == "failed"
    assert result.reason == FailureReason.BLOCKED
    assert result.attempts == 3  # retries=2 → exactly 3 attempts, no more
    assert http_server.hits["/flaky/999"] == 3
    # No leaked pages across the retry loop.
    assert factory.tracker.opened == factory.tracker.closed == 3
    assert factory.tracker.active == 0


async def test_no_retries_means_single_attempt(factory, base_url, reset_server, http_server):
    url = _url(base_url, "/flaky/999")
    results = await fetch_pages_batch(
        factory.page, [url], max_concurrency=1, retries=0, timeout=5
    )
    assert results[0].attempts == 1
    assert http_server.hits["/flaky/999"] == 1


async def test_timeout_page_is_retried_and_closes_pages(factory, base_url, reset_server):
    url = _url(base_url, "/ok/never")  # irrelevant; we hang before navigating
    f = FakePageFactory(hang_urls={url})

    async def page():
        return await f()

    try:
        results = await fetch_pages_batch(
            page, [url], max_concurrency=1, retries=1, timeout=0.3
        )
    finally:
        await f.aclose()

    assert results[0].status == "failed"
    assert results[0].reason == FailureReason.TIMEOUT
    assert results[0].attempts == 2
    assert f.tracker.opened == f.tracker.closed == 2
    assert f.tracker.active == 0


# ---------------------------------------------------------------------------
# Isolation and ordering
# ---------------------------------------------------------------------------


async def test_batch_order_matches_input_regardless_of_latency(factory, base_url, reset_server):
    # First URL is slow, later ones are fast: results must still line up.
    urls = [
        _url(base_url, "/slow/0.4"),
        _url(base_url, "/ok/1"),
        _url(base_url, "/ok/2"),
        _url(base_url, "/blocked"),
    ]
    results = await fetch_pages_batch(
        factory.page, urls, max_concurrency=4, timeout=5
    )
    assert [r.url for r in results] == urls
    assert [r.ok for r in results] == [True, True, True, False]


async def test_one_failure_does_not_abort_batch(factory, base_url, reset_server):
    urls = [
        _url(base_url, "/ok/a"),
        _url(base_url, "/blocked"),
        _url(base_url, "/ok/b"),
    ]
    results = await fetch_pages_batch(
        factory.page, urls, max_concurrency=2, timeout=5
    )
    assert len(results) == 3
    assert results[0].ok and results[2].ok
    assert not results[1].ok


async def test_factory_failure_is_recorded_per_url(base_url, reset_server):
    class PageOpenError(Exception):
        pass

    calls = {"n": 0}

    async def page_factory():
        calls["n"] += 1
        if calls["n"] == 2:
            raise PageOpenError("could not open page")
        return object()  # placeholder page; will fail when used

    # Every URL ends in a failure record; the batch never raises.
    urls = [_url(base_url, "/ok/1"), _url(base_url, "/ok/2"), _url(base_url, "/ok/3")]
    results = await fetch_pages_batch(page_factory, urls, max_concurrency=1, timeout=1)
    assert len(results) == 3
    assert all(not r.ok for r in results)
    assert results[1].reason == FailureReason.ERROR
    assert "could not open page" in results[1].error


async def test_empty_input_returns_empty_list(factory):
    assert await fetch_pages_batch(factory.page, [], max_concurrency=5) == []


async def test_string_input_is_a_single_url(factory, base_url, reset_server):
    url = _url(base_url, "/ok/1")
    results = await fetch_pages_batch(factory.page, url, max_concurrency=1, timeout=5)
    assert len(results) == 1
    assert results[0].url == url


async def test_result_is_dict_like(factory, base_url, reset_server):
    results = await fetch_pages_batch(
        factory.page, [_url(base_url, "/ok/1")], max_concurrency=1, timeout=5
    )
    r = results[0]
    assert r["url"] == r.url
    assert r.to_dict()["status"] == "success"
    assert r.to_dict()["ok"] is True


# ---------------------------------------------------------------------------
# Abrasio.fetch_pages entry point (session guard)
# ---------------------------------------------------------------------------


async def test_fetch_pages_requires_started_session():
    browser = Abrasio(AbrasioConfig(auto_configure_region=False, locale="en-US",
                                    timezone="America/New_York"))
    with pytest.raises(AbrasioError) as excinfo:
        await browser.fetch_pages(["http://127.0.0.1:1/ok"])
    assert "not started" in str(excinfo.value).lower()


async def test_fetch_pages_rejects_bad_options(http_server):
    # The session guard fires first; validation lives in the batch helper.
    with pytest.raises(ValueError):
        async def factory():
            return object()

        await fetch_pages_batch(factory, ["x"], max_concurrency=0)
    with pytest.raises(ValueError):
        await fetch_pages_batch(factory, ["x"], retries=-1)
    with pytest.raises(ValueError):
        await fetch_pages_batch(factory, ["x"], timeout=0)


# ---------------------------------------------------------------------------
# Real browser integration (skipped when no browser binary is available)
# ---------------------------------------------------------------------------

def _bundled_chromium_candidates():
    """Chromium binaries installed by ``patchright install chromium``."""
    local_appdata = os.environ.get("LOCALAPPDATA")
    if not local_appdata:
        return []
    root = Path(local_appdata) / "ms-playwright"
    if not root.is_dir():
        return []
    return [
        str(path)
        for path in sorted(root.glob("chromium-*/chrome-win64/chrome.exe"), reverse=True)
    ]


def _find_browser():
    candidates = [os.environ.get("ABRASIO_TEST_EXECUTABLE")]
    candidates += _bundled_chromium_candidates()
    candidates += [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


@pytest.mark.skipif(_find_browser() is None, reason="no local Chrome/Chromium available")
async def test_fetch_pages_through_real_browser(base_url, reset_server):
    class InstrumentedAbrasio(Abrasio):
        """Counts pages open at once to verify the real session obeys the cap."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.open_pages = 0
            self.max_open_pages = 0

        async def new_page(self, **kwargs):
            page = await super().new_page(**kwargs)
            self.open_pages += 1
            self.max_open_pages = max(self.max_open_pages, self.open_pages)

            original_close = page.close

            async def close(*args, **kwargs):
                self.open_pages -= 1
                return await original_close(*args, **kwargs)

            page.close = close
            return page

    browser = InstrumentedAbrasio(
        AbrasioConfig(
            headless=True,
            executable_path=_find_browser(),
            auto_configure_region=False,
            locale="en-US",
            timezone="America/New_York",
            timeout=5000,
        )
    )
    urls = [
        _url(base_url, "/ok/1"),
        _url(base_url, "/ok/3"),
        _url(base_url, "/slow/3"),
        _url(base_url, "/empty"),
        _url(base_url, "/blocked"),
        _url(base_url, "/ok/2"),
    ]
    async with browser:
        results = await browser.fetch_pages(
            urls, max_concurrency=2, timeout=1.5, retries=1, retry_backoff=0
        )
        # All pages must be closed by the time the batch returns.
        assert browser.open_pages == 0

    assert browser.max_open_pages <= 2
    assert [r.url for r in results] == urls
    assert results[0].ok and results[0].title == "Page 1"
    assert "Body text for page 1." in results[0].text
    assert results[1].ok and results[1].title == "Page 3"
    assert results[2].reason == FailureReason.TIMEOUT
    assert results[3].reason == FailureReason.EMPTY
    assert results[4].reason == FailureReason.BLOCKED
    assert results[5].ok and results[5].title == "Page 2"
    # Retried failures record both attempts.
    assert results[2].attempts == 2
    assert results[4].attempts == 2


# ---------------------------------------------------------------------------
# Sync API
# ---------------------------------------------------------------------------


def test_sync_api_delegates_fetch_pages():
    from abrasio.sync_api import Abrasio as SyncAbrasio

    calls = {}

    async def fake_fetch_pages(urls, **kwargs):
        calls["urls"] = urls
        calls["kwargs"] = kwargs
        return ["sentinel"]

    browser = SyncAbrasio(AbrasioConfig(auto_configure_region=False, locale="en-US",
                                        timezone="America/New_York"))
    try:
        browser._async_abrasio.fetch_pages = fake_fetch_pages
        result = browser.fetch_pages(["http://x"], max_concurrency=2, retries=1)
    finally:
        browser._stop_loop()

    assert result == ["sentinel"]
    assert calls["urls"] == ["http://x"]
    assert calls["kwargs"] == {"max_concurrency": 2, "retries": 1}


# ---------------------------------------------------------------------------
# Failure-reason mapping
# ---------------------------------------------------------------------------


def test_exception_reason_mapping():
    from patchright.async_api import TimeoutError as PlaywrightTimeoutError

    from abrasio import BlockedError
    from abrasio._batch import _exception_reason

    assert _exception_reason(PlaywrightTimeoutError("Timeout 30000ms exceeded")) == (
        FailureReason.TIMEOUT
    )
    assert _exception_reason(asyncio.TimeoutError()) == FailureReason.TIMEOUT
    assert _exception_reason(BlockedError(url="http://x", status_code=403)) == (
        FailureReason.BLOCKED
    )
    assert _exception_reason(RuntimeError("boom")) == FailureReason.ERROR
