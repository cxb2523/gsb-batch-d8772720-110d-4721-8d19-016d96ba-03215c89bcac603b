"""Per-source outcome tests for the async scraper.

No real network is touched: a fake ``aiohttp``-style session is injected into
``scrape()``. The fakes cover every outcome class:

    - success (with the parsed proxy count in the detail)
    - HTTP non-200
    - request exception / timeout
    - empty response body
    - content that parses into zero proxies
    - auto-skip after five consecutive failures

The skipped-source tests additionally prove that no request is made and that
the source's consecutive-failure counter is identical before and after the
round.
"""

from __future__ import annotations

import asyncio
import json

import aiohttp
import pytest

from proxy_scraper.parser import Proxy
from proxy_scraper.protocols import Protocol
from proxy_scraper.scraper import (
    ScrapeReport,
    SourceOutcome,
    SourceResult,
    scrape,
)
from proxy_scraper.sources import Source, SourceHealthBook

# ---------------------------------------------------------------------------
# Fakes — minimal stand-ins for the aiohttp session/response surface that
# ``_fetch_one`` actually uses (async context manager + status + text()).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, status: int = 200, text: str = "") -> None:
        self.status = status
        self._text = text

    async def text(self, errors: str = "ignore") -> str:
        return self._text

    async def __aenter__(self) -> FakeResponse:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _RaisingRequest:
    """Async context manager whose entry raises, like a failing session.get."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def __aenter__(self) -> None:
        raise self._error

    async def __aexit__(self, *exc: object) -> bool:
        return False


class FakeSession:
    """In-memory session: maps a source URL to a response or raised error."""

    def __init__(self, routes: dict[str, FakeResponse | Exception]) -> None:
        self._routes = routes
        self.calls: list[str] = []

    def get(self, url: str, **kwargs: object):
        self.calls.append(url)
        route = self._routes[url]
        if isinstance(route, Exception):
            return _RaisingRequest(route)
        return route


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

URL_OK = "https://example.test/ok.txt"
URL_404 = "https://example.test/missing.txt"
URL_503 = "https://example.test/down.txt"
URL_EMPTY = "https://example.test/empty.txt"
URL_GARBAGE = "https://example.test/garbage.txt"
URL_TIMEOUT = "https://example.test/slow.txt"
URL_CLIENTERR = "https://example.test/reset.txt"
URL_SKIP = "https://example.test/skipped.txt"


def _source(url: str, protocol: Protocol = Protocol.HTTP) -> Source:
    return Source(url, protocol)


@pytest.fixture
def fake_session() -> FakeSession:
    return FakeSession(
        {
            URL_OK: FakeResponse(200, "1.2.3.4:8080\n5.6.7.8:3128\n"),
            URL_404: FakeResponse(404, "not found"),
            URL_503: FakeResponse(503, "service unavailable"),
            URL_EMPTY: FakeResponse(200, ""),
            URL_GARBAGE: FakeResponse(200, "this page contains no proxy entries at all"),
            URL_TIMEOUT: asyncio.TimeoutError(),
            URL_CLIENTERR: aiohttp.ClientConnectionError("connection reset"),
        }
    )


def _by_url(results: list[SourceResult]) -> dict[str, SourceResult]:
    return {r.url: r for r in results}


# ---------------------------------------------------------------------------
# Default behavior — backwards compatible mapping return.
# ---------------------------------------------------------------------------


async def test_scrape_without_flag_returns_plain_mapping(fake_session: FakeSession) -> None:
    sources = [_source(URL_OK), _source(URL_404)]
    out = await scrape(sources, session=fake_session)

    # Original return type and shape — no ScrapeReport, no extra keys.
    assert isinstance(out, dict)
    assert out == {Protocol.HTTP: {Proxy("1.2.3.4", 8080), Proxy("5.6.7.8", 3128)}}


async def test_scrape_empty_sources_without_flag_returns_empty_dict() -> None:
    assert await scrape([], return_results=True) == ScrapeReport(proxies={}, results=[])
    assert await scrape([]) == {}


# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------


async def test_success_outcome_reports_proxy_count(
    fake_session: FakeSession,
) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(URL_OK)
    report = await scrape([src], session=fake_session, health=health, return_results=True)

    assert isinstance(report, ScrapeReport)
    assert len(report.results) == 1
    result = report.results[0]
    assert result.url == URL_OK
    assert result.protocol == Protocol.HTTP
    assert result.outcome is SourceOutcome.SUCCESS
    assert result.outcome.value == "success"
    assert "2" in result.detail
    assert report.proxies[Protocol.HTTP] == {Proxy("1.2.3.4", 8080), Proxy("5.6.7.8", 3128)}
    # Success still clears the consecutive-failure counter.
    assert health.get(src).consecutive_failures == 0
    assert health.get(src).successes == 1


async def test_success_clears_preexisting_consecutive_failures(
    fake_session: FakeSession,
) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(URL_OK)
    for _ in range(4):
        health.record_failure(src)
    assert health.get(src).consecutive_failures == 4

    await scrape([src], session=fake_session, health=health, return_results=True)

    assert health.get(src).consecutive_failures == 0


# ---------------------------------------------------------------------------
# HTTP non-200
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("url", [URL_404, URL_503])
async def test_http_error_outcome(fake_session: FakeSession, url: str) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(url)
    report = await scrape([src], session=fake_session, health=health, return_results=True)

    result = report.results[0]
    assert result.outcome is SourceOutcome.HTTP_ERROR
    assert result.protocol == Protocol.HTTP
    status = 404 if url == URL_404 else 503
    assert str(status) in result.detail
    # Non-200 still counts as a failure for health purposes.
    assert health.get(src).consecutive_failures == 1
    assert not any(report.proxies.values())


# ---------------------------------------------------------------------------
# Request exception / timeout
# ---------------------------------------------------------------------------


async def test_timeout_outcome(fake_session: FakeSession) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(URL_TIMEOUT)
    report = await scrape([src], session=fake_session, health=health, return_results=True)

    result = report.results[0]
    assert result.outcome is SourceOutcome.REQUEST_ERROR
    assert "timed out" in result.detail
    assert health.get(src).consecutive_failures == 1


async def test_client_error_outcome(fake_session: FakeSession) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(URL_CLIENTERR)
    report = await scrape([src], session=fake_session, health=health, return_results=True)

    result = report.results[0]
    assert result.outcome is SourceOutcome.REQUEST_ERROR
    assert "ClientConnectionError" in result.detail
    assert health.get(src).consecutive_failures == 1


# ---------------------------------------------------------------------------
# Empty response and unparseable content
# ---------------------------------------------------------------------------


async def test_empty_response_outcome(fake_session: FakeSession) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(URL_EMPTY)
    report = await scrape([src], session=fake_session, health=health, return_results=True)

    result = report.results[0]
    assert result.outcome is SourceOutcome.EMPTY_RESPONSE
    assert result.detail
    assert health.get(src).consecutive_failures == 1


async def test_no_proxies_outcome(fake_session: FakeSession) -> None:
    health = SourceHealthBook(auto_load=False)
    src = _source(URL_GARBAGE)
    report = await scrape([src], session=fake_session, health=health, return_results=True)

    result = report.results[0]
    assert result.outcome is SourceOutcome.NO_PROXIES
    assert "no proxies" in result.detail
    assert health.get(src).consecutive_failures == 1


# ---------------------------------------------------------------------------
# Auto-skip — no request, counter untouched
# ---------------------------------------------------------------------------


async def test_skipped_source_makes_no_request_and_keeps_counter(
    fake_session: FakeSession,
) -> None:
    health = SourceHealthBook(auto_load=False)
    skipped = _source(URL_SKIP)
    for _ in range(5):
        health.record_failure(skipped)
    before = health.get(skipped).consecutive_failures
    assert before == 5
    assert health.is_stale(skipped)

    # A healthy source rides along so the run also exercises a real fetch.
    healthy = _source(URL_OK)
    report = await scrape(
        [skipped, healthy],
        session=fake_session,
        health=health,
        return_results=True,
    )

    results = _by_url(report.results)
    skip_result = results[URL_SKIP]
    assert skip_result.outcome is SourceOutcome.SKIPPED
    assert skip_result.protocol == Protocol.HTTP
    assert "5" in skip_result.detail
    assert results[URL_OK].outcome is SourceOutcome.SUCCESS

    # No network request was issued for the skipped source...
    assert URL_SKIP not in fake_session.calls
    assert fake_session.calls == [URL_OK]
    # ...and its consecutive-failure counter is byte-for-byte unchanged.
    assert health.get(skipped).consecutive_failures == before
    assert health.get(skipped).failures == 5
    assert health.get(skipped).successes == 0


async def test_skipped_source_yields_no_proxies(fake_session: FakeSession) -> None:
    health = SourceHealthBook(auto_load=False)
    skipped = _source(URL_SKIP)
    for _ in range(5):
        health.record_failure(skipped)

    report = await scrape([skipped], session=fake_session, health=health, return_results=True)

    assert not any(report.proxies.values())
    assert report.results[0].outcome is SourceOutcome.SKIPPED
    assert fake_session.calls == []


async def test_skipped_counter_survives_persistence_roundtrip(
    tmp_path,
    fake_session: FakeSession,
) -> None:
    path = tmp_path / "sources_health.json"
    health = SourceHealthBook(path=path, auto_load=False)
    skipped = _source(URL_SKIP)
    for _ in range(5):
        health.record_failure(skipped)
    health.save()

    # JSON persistence format and the >= 5 threshold remain unchanged.
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw[skipped.key]["consecutive_failures"] == 5

    reloaded = SourceHealthBook(path=path)
    report = await scrape(
        [skipped], session=fake_session, health=reloaded, return_results=True
    )
    assert report.results[0].outcome is SourceOutcome.SKIPPED
    assert reloaded.get(skipped).consecutive_failures == 5
    assert fake_session.calls == []


# ---------------------------------------------------------------------------
# Full mixed round + alternative ``results`` sink API
# ---------------------------------------------------------------------------


async def test_mixed_round_records_every_source_in_input_order(
    fake_session: FakeSession,
) -> None:
    sources = [
        _source(URL_OK),
        _source(URL_404),
        _source(URL_TIMEOUT),
        _source(URL_EMPTY),
        _source(URL_GARBAGE),
    ]
    report = await scrape(sources, session=fake_session, return_results=True)

    assert [r.url for r in report.results] == [s.url for s in sources]
    outcomes = _by_url(report.results)
    assert outcomes[URL_OK].outcome is SourceOutcome.SUCCESS
    assert outcomes[URL_404].outcome is SourceOutcome.HTTP_ERROR
    assert outcomes[URL_TIMEOUT].outcome is SourceOutcome.REQUEST_ERROR
    assert outcomes[URL_EMPTY].outcome is SourceOutcome.EMPTY_RESPONSE
    assert outcomes[URL_GARBAGE].outcome is SourceOutcome.NO_PROXIES
    # Every participating source produced exactly one record.
    assert len(report.results) == len(sources)


async def test_results_sink_keeps_plain_mapping_return(
    fake_session: FakeSession,
) -> None:
    sink: list[SourceResult] = []
    sources = [_source(URL_OK), _source(URL_SKIP)]

    health = SourceHealthBook(auto_load=False)
    for _ in range(5):
        health.record_failure(_source(URL_SKIP))

    out = await scrape(sources, session=fake_session, health=health, results=sink)

    # Return type is unchanged even though outcomes were requested...
    assert isinstance(out, dict)
    assert Protocol.HTTP in out
    assert len(sink) == 2
    assert _by_url(sink)[URL_SKIP].outcome is SourceOutcome.SKIPPED
    assert URL_SKIP not in fake_session.calls


async def test_results_sink_and_flag_together(fake_session: FakeSession) -> None:
    sink: list[SourceResult] = []
    report = await scrape(
        [_source(URL_OK)],
        session=fake_session,
        return_results=True,
        results=sink,
    )
    assert isinstance(report, ScrapeReport)
    assert sink == report.results


async def test_source_result_is_json_serializable(fake_session: FakeSession) -> None:
    report = await scrape(
        [_source(URL_OK, Protocol.SOCKS5)],
        session=fake_session,
        return_results=True,
    )
    payload = report.results[0].to_dict()
    encoded = json.dumps(payload)  # must not raise
    assert json.loads(encoded) == {
        "url": URL_OK,
        "protocol": "socks5",
        "outcome": "success",
        "detail": report.results[0].detail,
    }
