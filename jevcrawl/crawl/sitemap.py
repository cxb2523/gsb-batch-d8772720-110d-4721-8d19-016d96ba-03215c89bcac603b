"""Free discovery of deep pages from the site's own sitemap.xml.

Benchmark questions (and real ones) often target a page several clicks deep: one event among
hundreds, behind a calendar and "next page" links. Many sites list every page in a sitemap, and
the URL often names the page ("/events/open-session-equity-1-february-10-2023/"). We read the
sitemap once per crawl, keep the URLs whose path shares words with the goal (a free, lexical
filter) and hand those few to Jev as ordinary link candidates. Jev still decides; nothing is
fetched just because it is in the sitemap.
"""

from __future__ import annotations

import html
import re
import zlib
from dataclasses import dataclass
from urllib.parse import unquote, urljoin, urlsplit

from jevcrawl.fetch.http import MAX_BODY_BYTES, Fetcher
from jevcrawl.fetch.robots import Robots
from jevcrawl.log import get_logger
from jevcrawl.models import Link, SitemapFileRecord, SitemapReport
from jevcrawl.segment.links import Scope, canonical_url, goal_overlap, goal_words, is_skippable

log = get_logger("crawl.sitemap")

DEFAULT_PATHS = ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml")
SITEMAP_CONTEXT = "Listed in the site's sitemap (no anchor text; words come from the URL)"
MAX_FILES = 12  # sitemap files read per crawl (an index can list hundreds)
MAX_URLS = 50_000
MAX_UNZIPPED_BYTES = 10 * MAX_BODY_BYTES  # a gzip bomb must not unpack to gigabytes
_LOC = re.compile(rb"<loc>\s*(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?\s*</loc>", re.I | re.S)
_ROBOTS_SITEMAP = re.compile(r"^\s*sitemap\s*:\s*(\S+)", re.I | re.M)
_SEPARATORS = re.compile(r"[-_+.]+")
_EXTENSION = re.compile(r"\.(?:s?html?|php|aspx?|jsp)$", re.I)

# Per-file outcomes recorded in the SitemapReport; each attempted file gets exactly one.
PARSED = "parsed"
REQUEST_FAILED = "request_failed"
DECOMPRESS_FAILED = "decompress_failed"
EMPTY = "empty"


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _decode(body: bytes) -> bytes:
    if body[:2] == b"\x1f\x8b":
        try:  # wbits 16 + MAX_WBITS reads the gzip header; output stops at the cap
            return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(body, MAX_UNZIPPED_BYTES)
        except zlib.error:
            return b""
    return body


def _unpack(body: bytes) -> tuple[bytes | None, str | None, bool]:
    """Decode a possibly-gzipped sitemap body.

    Returns ``(decoded, error, truncated)``: ``error`` is :data:`DECOMPRESS_FAILED` when the
    gzip stream is corrupt, and ``truncated`` is set when the cap cut a valid stream short
    (the output filled the cap, so the body cannot have ended naturally). Plain (non-gzip)
    bodies pass through untouched.
    """
    if body[:2] != b"\x1f\x8b":
        return body, None, False
    dec = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        decoded = dec.decompress(body, MAX_UNZIPPED_BYTES)
    except zlib.error as exc:
        return None, f"{DECOMPRESS_FAILED}: {exc.__class__.__name__}", False
    return decoded, None, len(decoded) >= MAX_UNZIPPED_BYTES


async def _sitemap_files(robots: Robots, root_url: str) -> list[str]:
    """Sitemaps named in robots.txt, or the usual locations if it names none."""
    origin = _origin(root_url)
    body = await robots.body(origin)
    if body:
        named = _ROBOTS_SITEMAP.findall(body.decode("utf-8", "replace"))
        if named:
            return [urljoin(origin, url) for url in named]
    return [origin + path for path in DEFAULT_PATHS]


@dataclass
class SitemapDiscovery:
    """The URLs found in the sitemaps, together with the per-file audit trail."""

    urls: list[str]
    report: SitemapReport


async def discover_sitemaps(
    fetcher: Fetcher, robots: Robots, root_url: str, goal: str
) -> SitemapDiscovery:
    """Read the site's sitemaps (index files are followed, best-matching first), recording the
    outcome of every attempted file. Never raises: a broken file is counted and skipped."""
    words = goal_words(goal)
    report = SitemapReport(enabled=True)
    queue = await _sitemap_files(robots, root_url)
    done: set[str] = set()
    urls: list[str] = []
    stopped_by_cap = False
    while queue and len(done) < MAX_FILES and len(urls) < MAX_URLS:
        file_url = queue.pop(0)
        if file_url in done:
            continue
        done.add(file_url)
        try:
            fetched = await fetcher.fetch_raw_detailed(file_url)
            if not fetched.ok:
                reason = fetched.error or "no body returned"
                report.files.append(
                    SitemapFileRecord(file_url, REQUEST_FAILED, reason=reason)
                )
                continue
            assert fetched.body is not None
            body, error, truncated = _unpack(fetched.body)
            if error is not None:
                report.files.append(SitemapFileRecord(file_url, DECOMPRESS_FAILED, reason=error))
                continue
            if not body:
                report.files.append(
                    SitemapFileRecord(file_url, EMPTY, reason="response body was empty")
                )
                continue
            locs = [
                html.unescape(m.decode("utf-8", "replace")).strip()
                for m in _LOC.findall(body)
            ]
            if not locs:
                report.files.append(
                    SitemapFileRecord(
                        file_url, EMPTY, reason="no <loc> entries found in the sitemap"
                    )
                )
                continue
            report.files.append(
                SitemapFileRecord(
                    file_url, PARSED, urls_found=len(locs), truncated=truncated
                )
            )
            if b"<sitemapindex" in body[:4096].lower():
                # Child sitemaps whose names share words with the goal ("event-sitemap.xml") first.
                ranked = sorted(locs, key=lambda u: -goal_overlap(words, Link("", u, "", "", 0)))
                queue = ranked + queue
            else:
                urls.extend(locs)
        except Exception as exc:  # a broken sitemap must never break the crawl
            log.info("sitemap file %s failed: %r", file_url, exc)
            report.files.append(
                SitemapFileRecord(file_url, REQUEST_FAILED, reason=f"{type(exc).__name__}: {exc}")
            )
    stopped_by_cap = len(queue) > 0 and (len(done) >= MAX_FILES or len(urls) >= MAX_URLS)
    if stopped_by_cap:
        # Unique, not-yet-attempted files left behind by the MAX_FILES / MAX_URLS caps.
        report.files_remaining = len({u for u in queue if u not in done})
    log.info(
        "sitemap: %d files read (%d failed), %d urls, %d files left unread",
        report.files_succeeded,
        report.files_failed,
        len(urls),
        report.files_remaining,
    )
    return SitemapDiscovery(urls[:MAX_URLS], report)


async def sitemap_urls(fetcher: Fetcher, robots: Robots, root_url: str, goal: str) -> list[str]:
    """Page URLs listed in the site's sitemaps (index files are followed, best-matching first)."""
    return (await discover_sitemaps(fetcher, robots, root_url, goal)).urls


def slug_text(url: str) -> str:
    """Readable words from a URL path: ``events / open session equity 1 february 10 2023``."""
    segments = [s for s in unquote(urlsplit(url).path).split("/") if s]
    words = [_SEPARATORS.sub(" ", _EXTENSION.sub("", s)).strip() for s in segments[-3:]]
    return " / ".join(w for w in words if w)


def sitemap_links(
    urls: list[str],
    goal: str,
    scope: Scope,
    exclude: set[str],
    limit: int,
) -> list[Link]:
    """The ``limit`` sitemap URLs sharing the most words with the goal, as Jev link candidates.

    A URL must share at least two goal words (one if the goal has fewer than four), so a site
    with numeric URLs ("/info/2124/10671.htm") contributes nothing rather than noise.
    """
    words = goal_words(goal)
    if not words or limit <= 0:
        return []
    need = 1 if len(words) < 4 else 2
    scored: list[tuple[int, int, Link]] = []
    for position, raw in enumerate(dict.fromkeys(urls)):
        url = canonical_url(raw)
        if url in exclude or not scope.contains(url) or is_skippable(url):
            continue
        link = Link("", url, slug_text(url), SITEMAP_CONTEXT, position)
        overlap = goal_overlap(words, link)
        if overlap >= need:
            scored.append((-overlap, position, link))
    scored.sort(key=lambda row: (row[0], row[1]))
    best = [link for _, _, link in scored[:limit]]
    return [
        Link(f"S{i}", link.url, link.text, link.context, link.position)
        for i, link in enumerate(best)
    ]
