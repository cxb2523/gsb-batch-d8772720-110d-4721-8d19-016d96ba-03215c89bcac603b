"""Async source scraper.

Pulls a configured set of sources concurrently, parses each payload, and
returns the deduplicated union. Per-source success and failure counts are
recorded into a ``SourceHealthBook`` so chronically dead sources can be
auto-skipped on subsequent runs.

Per-source outcomes
-------------------
By default :func:`scrape` returns the original ``protocol -> set of proxies``
mapping. Pass ``return_results=True`` to additionally receive one
:class:`SourceResult` record per participating source, describing how the
source ended this round (success / non-200 / request error / empty payload /
unparseable payload / auto-skipped). A pre-allocated list may instead be
passed via the ``results`` sink parameter; the mapping return type never
changes, so existing callers are unaffected.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import Enum

import aiohttp

from .parser import Proxy, parse
from .protocols import Protocol
from .sources import Source, SourceHealthBook

# Realistic User-Agents. Picked from the latest stable browser versions
# known at release time; rotated to reduce per-source fingerprinting.
_USER_AGENTS: tuple[str, ...] = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
)


class SourceOutcome(str, Enum):
    """How a single source ended during one scrape round.

    Inheriting from ``str`` keeps the values directly usable in JSON output
    and log lines (same convention as :class:`~proxy_scraper.protocols.Protocol`).
    """

    SUCCESS = "success"
    HTTP_ERROR = "http_error"
    REQUEST_ERROR = "request_error"
    EMPTY_RESPONSE = "empty_response"
    NO_PROXIES = "no_proxies"
    SKIPPED = "skipped"


@dataclass(frozen=True, slots=True)
class SourceResult:
    """The outcome of fetching one :class:`Source` during a scrape round."""

    url: str
    protocol: Protocol
    outcome: SourceOutcome
    detail: str = ""

    def to_dict(self) -> dict:
        """JSON-serializable view of this record."""
        return {
            "url": self.url,
            "protocol": self.protocol.value,
            "outcome": self.outcome.value,
            "detail": self.detail,
        }


@dataclass(frozen=True, slots=True)
class ScrapeReport:
    """Aggregate return value when per-source outcomes are requested.

    ``proxies`` is exactly the mapping :func:`scrape` returns by default.
    """

    proxies: dict[Protocol, set[Proxy]]
    results: list[SourceResult] = field(default_factory=list)


def _pick_headers(source: Source) -> dict[str, str]:
    """Build request headers, fanning the User-Agent to reduce per-source fingerprinting."""
    base = {"User-Agent": random.choice(_USER_AGENTS)}
    base.update(source.headers)
    return base


def _skipped_result(source: Source, consecutive_failures: int) -> SourceResult:
    return SourceResult(
        url=source.url,
        protocol=source.protocol,
        outcome=SourceOutcome.SKIPPED,
        detail=(
            f"auto-skipped after {consecutive_failures} consecutive failures "
            "(health-book threshold reached)"
        ),
    )


async def _fetch_one(
    session: aiohttp.ClientSession,
    source: Source,
    *,
    timeout: float,
    health: SourceHealthBook,
) -> tuple[set[Proxy], SourceResult]:
    """Fetch and parse one source, returning its proxies and outcome record.

    A stale source (five consecutive failures) is never contacted: no
    network request is made and its consecutive-failure counter is left
    untouched.
    """
    if health.is_stale(source):
        consecutive = health.get(source).consecutive_failures
        return set(), _skipped_result(source, consecutive)
    try:
        async with session.get(
            source.url,
            headers=_pick_headers(source),
            timeout=aiohttp.ClientTimeout(total=timeout),
            allow_redirects=True,
        ) as resp:
            if resp.status != 200:
                health.record_failure(source)
                return set(), SourceResult(
                    url=source.url,
                    protocol=source.protocol,
                    outcome=SourceOutcome.HTTP_ERROR,
                    detail=f"HTTP {resp.status}",
                )
            text = await resp.text(errors="ignore")
    except asyncio.TimeoutError as exc:
        # Timeouts are called out explicitly so "blocked/slow" is not
        # confused with a dead source when triaging the per-source report.
        health.record_failure(source)
        return set(), SourceResult(
            url=source.url,
            protocol=source.protocol,
            outcome=SourceOutcome.REQUEST_ERROR,
            detail=f"request timed out after {timeout:g}s: {exc.__class__.__name__}",
        )
    except (aiohttp.ClientError, OSError) as exc:
        health.record_failure(source)
        return set(), SourceResult(
            url=source.url,
            protocol=source.protocol,
            outcome=SourceOutcome.REQUEST_ERROR,
            detail=f"request error: {exc.__class__.__name__}: {exc}",
        )
    except Exception as exc:
        # All remaining error classes — failures are recorded but never
        # raised, so one bad source never blocks the rest of the run.
        health.record_failure(source)
        return set(), SourceResult(
            url=source.url,
            protocol=source.protocol,
            outcome=SourceOutcome.REQUEST_ERROR,
            detail=f"request error: {exc.__class__.__name__}: {exc}",
        )

    if not text:
        health.record_failure(source)
        return set(), SourceResult(
            url=source.url,
            protocol=source.protocol,
            outcome=SourceOutcome.EMPTY_RESPONSE,
            detail="HTTP 200 but the response body was empty",
        )

    parsed = parse(text, expected=source.protocol)
    if parsed:
        health.record_success(source, count=len(parsed))
        return parsed, SourceResult(
            url=source.url,
            protocol=source.protocol,
            outcome=SourceOutcome.SUCCESS,
            detail=f"parsed {len(parsed)} prox{'y' if len(parsed) == 1 else 'ies'}",
        )

    # Got a response but no proxies — counts as a "soft" failure for
    # health purposes (likely the source changed format).
    health.record_failure(source)
    return set(), SourceResult(
        url=source.url,
        protocol=source.protocol,
        outcome=SourceOutcome.NO_PROXIES,
        detail=f"response had content ({len(text)} chars) but no proxies could be parsed",
    )


async def scrape(
    sources: Iterable[Source],
    *,
    concurrency: int = 50,
    timeout: float = 15.0,
    health: SourceHealthBook | None = None,
    session: aiohttp.ClientSession | None = None,
    return_results: bool = False,
    results: list[SourceResult] | None = None,
) -> dict[Protocol, set[Proxy]] | ScrapeReport:
    """Fetch and parse all sources in parallel.

    By default returns a mapping of protocol -> set of proxies (already
    deduplicated across all sources for that protocol).

    Per-source outcomes are opt-in:

    - pass ``return_results=True`` to get a :class:`ScrapeReport` holding
      both the proxy mapping and one :class:`SourceResult` per source;
    - or pass a list as ``results`` — it is filled with the outcome
      records in input order while the return value stays the plain
      mapping (handy for adding observability without touching call sites).

    ``session`` may be an injectable ``aiohttp.ClientSession`` (or a fake
    exposing the same async context-manager ``get`` interface) for tests;
    when omitted a session is created and closed internally.

    Sources skipped by the health book (five consecutive failures) emit a
    ``SKIPPED`` record without any network request and without changing
    their consecutive-failure count.
    """
    sources = tuple(sources)
    if not sources:
        if return_results:
            return ScrapeReport(proxies={}, results=[])
        return {}

    health = health or SourceHealthBook(auto_load=False)
    out: dict[Protocol, set[Proxy]] = {}
    collected: list[SourceResult] = []

    async def run_with(client: aiohttp.ClientSession) -> None:
        sem = asyncio.Semaphore(concurrency)

        async def run(src: Source) -> tuple[set[Proxy], SourceResult]:
            async with sem:
                return await _fetch_one(client, src, timeout=timeout, health=health)

        tasks = [asyncio.create_task(run(s)) for s in sources]
        fetched = await asyncio.gather(*tasks, return_exceptions=False)

        for src, (proxies, result) in zip(sources, fetched):
            out.setdefault(src.protocol, set()).update(proxies)
            collected.append(result)

    if session is not None:
        # Injectable session — caller owns its lifecycle, we never close it.
        await run_with(session)
    else:
        connector = aiohttp.TCPConnector(limit=concurrency, ttl_dns_cache=300, ssl=False)
        async with aiohttp.ClientSession(connector=connector) as owned_session:
            await run_with(owned_session)

    if results is not None:
        results.extend(collected)

    if return_results:
        return ScrapeReport(proxies=out, results=collected)
    return out
