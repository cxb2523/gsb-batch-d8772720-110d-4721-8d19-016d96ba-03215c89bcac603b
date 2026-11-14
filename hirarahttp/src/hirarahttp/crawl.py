"""site_map and link_check: a small, polite, same-site crawler.

Every fetch goes through ``http_request`` and so through the SSRF guard, hop
by hop. The crawler stays on the start URL's host, honours robots.txt by
default, caps pages, depth and concurrency, and never executes anything: it
reads links out of HTML and nothing more.

Every candidate URL gets an explicit outcome (``fetched``, ``budget``,
``depth`` or ``robots``); see ``pages_outcome`` on the crawl meta and on
:func:`site_map`. A previous ``pages_outcome`` can be passed back as
``resume`` to continue an interrupted run without re-fetching known pages.
"""

from __future__ import annotations

import asyncio
import posixpath
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from .config import HttpConfig
from .request import http_request

ASSET_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".css", ".js", ".mjs",
    ".pdf", ".zip", ".gz", ".mp3", ".mp4", ".webm", ".woff", ".woff2", ".ttf", ".xml",
    ".json", ".txt", ".csv", ".avif", ".bmp", ".tar", ".dmg", ".exe",
})
SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "sms:", "about:", "blob:")
LINK_ATTRS = {"a": "href", "link": "href", "img": "src", "script": "src", "iframe": "src",
              "source": "src", "video": "src", "audio": "src", "area": "href"}

# Outcomes recorded in pages_outcome.
FETCHED, BUDGET, DEPTH, ROBOTS = "fetched", "budget", "depth", "robots"
OUTCOMES = frozenset({FETCHED, BUDGET, DEPTH, ROBOTS})
# Resume entries with these outcomes are the starting points of a resumed run;
# everything known to be finished (fetched / robots) is skipped.
RESUME_SEED_OUTCOMES = frozenset({BUDGET, DEPTH})


class CrawlError(ValueError):
    """Caller-facing crawl failure."""


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, str]] = []  # (tag, url, text)
        self.base: str | None = None
        self.title_parts: list[str] = []
        self._in_title = False
        self._anchor: list | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "base" and a.get("href") and self.base is None:
            self.base = a["href"]
        if tag == "title":
            self._in_title = True
        attr = LINK_ATTRS.get(tag)
        if attr and a.get(attr):
            if tag == "link" and "stylesheet" not in (a.get("rel") or "") and \
                    "icon" not in (a.get("rel") or ""):
                return
            entry = [tag, a[attr].strip(), ""]
            self.links.append(entry)  # type: ignore[arg-type]
            if tag == "a":
                self._anchor = entry

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "a":
            self._anchor = None

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
        if self._anchor is not None and len(self._anchor[2]) < 120:
            self._anchor[2] = (self._anchor[2] + " " + data.strip()).strip()[:120]


def normalise(url: str, *, keep_query: bool = True) -> str:
    url, _ = urldefrag(url)
    parts = urlsplit(url)
    path = parts.path or "/"
    if path != "/" and "//" in path:
        path = posixpath.normpath(path) + ("/" if path.endswith("/") else "")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path,
                       parts.query if keep_query else "", ""))


def _is_asset(url: str) -> bool:
    return posixpath.splitext(urlsplit(url).path.lower())[1] in ASSET_EXTS


def _is_http_url(url: object) -> bool:
    if not isinstance(url, str) or not url.strip():
        return False
    parts = urlsplit(url.strip())
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def _validate_resume(resume: object, allowed_host: str) -> list[dict]:
    """Validate a caller-supplied ``pages_outcome`` before any request fires.

    Each entry needs a valid absolute http(s) URL on the start URL's host and
    a known outcome. Raises :class:`CrawlError` with a reason on the first bad
    entry, so an invalid resume never issues a request (robots.txt included).
    """
    if not isinstance(resume, list):
        raise CrawlError("resume must be a list of pages_outcome entries")
    clean: list[dict] = []
    for index, entry in enumerate(resume):
        where = f"resume entry {index}"
        if not isinstance(entry, dict):
            raise CrawlError(f"{where} must be an object")
        url = entry.get("url")
        if not _is_http_url(url):
            raise CrawlError(f"{where} has an invalid url: {url!r}")
        url = url.strip()
        if urlsplit(url).netloc.lower() != allowed_host:
            raise CrawlError(
                f"{where} url {url!r} is off the start host {allowed_host!r}; "
                "site_map only crawls one site")
        outcome = entry.get("outcome")
        if outcome not in OUTCOMES:
            raise CrawlError(f"{where} has an unknown outcome: {outcome!r}")
        depth = entry.get("depth", 0)
        if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0:
            raise CrawlError(f"{where} has an invalid depth: {depth!r}")
        found_on = entry.get("found_on")
        if found_on is not None and not isinstance(found_on, str):
            raise CrawlError(f"{where} has an invalid found_on: {found_on!r}")
        clean.append({"url": url, "outcome": outcome, "depth": depth,
                      "found_on": found_on})
    return clean


@dataclass
class Page:
    url: str
    depth: int
    status: int | None = None
    content_type: str | None = None
    title: str | None = None
    bytes: int | None = None
    elapsed_ms: int | None = None
    final_url: str | None = None
    error: str | None = None
    links: list[tuple[str, str, str]] = field(default_factory=list)  # (tag, absolute url, text)

    def as_dict(self) -> dict:
        return {
            "url": self.url,
            "depth": self.depth,
            "status": self.status,
            "content_type": self.content_type,
            "title": self.title,
            "bytes": self.bytes,
            "elapsed_ms": self.elapsed_ms,
            "final_url": self.final_url if self.final_url != self.url else None,
            "links_out": len(self.links),
            "error": self.error,
        }


async def _robots(start: str, config: HttpConfig, agent: str) -> RobotFileParser | None:
    parts = urlsplit(start)
    result = await http_request(urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", "")),
                                config=config, max_bytes=512_000)
    if result.status is None or not 200 <= result.status < 300 or not result.body:
        return None
    parser = RobotFileParser()
    parser.parse(result.body.splitlines())
    return parser


async def crawl(start: str, *, config: HttpConfig, max_pages: int = 50, max_depth: int = 3,
                respect_robots: bool = True, keep_query: bool = False,
                concurrency: int = 4, resume: list[dict] | None = None) -> tuple[list[Page], dict]:
    start = (start or "").strip()
    parts = urlsplit(start)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise CrawlError("url must be an absolute http(s) URL")
    host = parts.netloc.lower()
    # Validate resume before anything (robots.txt included) can make a request.
    resume_entries = _validate_resume(resume, host) if resume is not None else []
    max_pages = max(1, min(int(max_pages), 1000))
    max_depth = max(0, min(int(max_depth), 10))
    agent = "hirara"
    robots = await _robots(start, config, agent) if respect_robots else None

    root = normalise(start, keep_query=True)
    # Every known URL appears exactly once here. Entries queued for fetching
    # carry outcome=None until their fate is decided.
    outcomes: dict[str, dict] = {}
    queue: list[str] = []
    pages: list[Page] = []
    sem = asyncio.Semaphore(max(1, min(int(concurrency), 16)))

    def register(url: str, depth: int, found_on: str | None,
                 outcome: str | None, *, status: int | None = None,
                 error: str | None = None) -> dict | None:
        """First discovery wins; a URL is recorded at most once."""
        if url in outcomes:
            return None
        entry = {"url": url, "depth": depth, "outcome": outcome, "status": status,
                 "error": error, "found_on": found_on}
        outcomes[url] = entry
        return entry

    # Seed from the previous run: finished URLs are skipped, budget/depth URLs
    # become this run's starting points (subject to this run's constraints).
    for item in resume_entries:
        url = normalise(item["url"], keep_query=keep_query)
        entry = register(url, item["depth"], item["found_on"], item["outcome"])
        if entry is None or item["outcome"] not in RESUME_SEED_OUTCOMES:
            continue
        if robots is not None and not robots.can_fetch(agent, url):
            entry["outcome"] = ROBOTS
            continue
        if entry["depth"] > max_depth:
            entry["outcome"] = DEPTH
            continue
        entry["outcome"] = None
        queue.append(url)

    # The start URL anchors a fresh run; in resume mode it is usually already
    # known. Only queue it when this is the first time we see it, otherwise the
    # resume loop above already decided its fate.
    root_entry = register(root, 0, None, None)
    if root_entry is not None:
        queue.append(root)

    def discover(page_url: str, depth: int, links: list[tuple[str, str, str]]) -> None:
        """Give every same-site candidate an explicit, single outcome."""
        if depth >= max_depth:
            child_depth = depth + 1
            for tag, link, _ in links:
                if tag != "a" or urlsplit(link).netloc.lower() != host or _is_asset(link):
                    continue
                key = normalise(link, keep_query=keep_query)
                entry = register(key, child_depth, page_url, None)
                if entry is None:
                    continue
                # robots.txt is an absolute policy, checked ahead of the depth cap.
                entry["outcome"] = (ROBOTS if robots is not None
                                    and not robots.can_fetch(agent, key) else DEPTH)
            return
        for tag, link, _ in links:
            if tag != "a" or urlsplit(link).netloc.lower() != host or _is_asset(link):
                continue
            key = normalise(link, keep_query=keep_query)
            entry = register(key, depth + 1, page_url, None)
            if entry is None:
                continue
            if robots is not None and not robots.can_fetch(agent, key):
                entry["outcome"] = ROBOTS
                continue
            queue.append(key)

    async def fetch(url: str, depth: int) -> Page:
        page = Page(url=url, depth=depth)
        async with sem:
            result = await http_request(url, config=config)
        page.status, page.error = result.status, result.error
        page.elapsed_ms, page.final_url = result.elapsed_ms, result.final_url
        page.bytes = result.bytes_downloaded
        ctype = (result.response_headers or {}).get("content-type", "")
        page.content_type = ctype.split(";")[0].strip() or None
        if result.body and "html" in ctype.lower() and result.body_encoding != "base64":
            parser = _LinkParser()
            try:
                parser.feed(result.body)
            except Exception:  # noqa: BLE001 — malformed HTML yields what it yields
                pass
            page.title = " ".join("".join(parser.title_parts).split())[:200] or None
            base = urljoin(result.final_url or url, parser.base) if parser.base else (result.final_url or url)
            for tag, href, text in parser.links:
                if href.lower().startswith(SKIP_SCHEMES) or href.startswith("#"):
                    continue
                absolute = urljoin(base, href)
                if urlsplit(absolute).scheme not in ("http", "https"):
                    continue
                page.links.append((tag, normalise(absolute, keep_query=True), text))
        return page

    while queue and len(pages) < max_pages:
        batch = queue[: max_pages - len(pages)]
        queue = queue[len(batch):]
        results = await asyncio.gather(*(fetch(u, outcomes[u]["depth"]) for u in batch))
        for page in results:
            pages.append(page)
            entry = outcomes[page.url]
            entry["outcome"] = FETCHED
            entry["status"] = page.status
            entry["error"] = page.error
            discover(page.url, page.depth, page.links)

    # Anything still queued when the page budget ran out stays unvisited.
    for url in queue:
        outcomes[url]["outcome"] = BUDGET

    pages_outcome = sorted(
        ({k: v[k] for k in ("url", "depth", "outcome", "status", "error", "found_on")}
         for v in outcomes.values()),
        key=lambda item: (item["depth"], item["url"]),
    )
    blocked_by_robots = [item["url"] for item in pages_outcome if item["outcome"] == ROBOTS]
    meta = {
        "robots": robots,
        "robots_txt": robots is not None,
        "skipped_by_robots": blocked_by_robots[:200],
        "unvisited": sum(1 for item in pages_outcome if item["outcome"] == BUDGET),
        "truncated": any(item["outcome"] == BUDGET for item in pages_outcome),
        "pages_outcome": pages_outcome,
    }
    return pages, meta


async def site_map(url: str, *, config: HttpConfig, max_pages: int = 50, max_depth: int = 3,
                   respect_robots: bool = True, keep_query: bool = False,
                   resume: list[dict] | None = None) -> dict:
    pages, meta = await crawl(url, config=config, max_pages=max_pages, max_depth=max_depth,
                              respect_robots=respect_robots, keep_query=keep_query,
                              resume=resume)
    meta.pop("robots")
    by_status: dict[str, int] = {}
    for p in pages:
        key = str(p.status) if p.status is not None else "error"
        by_status[key] = by_status.get(key, 0) + 1
    lines = [f"{len(pages)} page(s) from {url}" + (" (more not visited)" if meta["truncated"] else "")]
    for p in sorted(pages, key=lambda x: (x.depth, x.url))[:200]:
        status = p.status if p.status is not None else "ERR"
        lines.append(f"{'  ' * p.depth}{status} {urlsplit(p.url).path or '/'}"
                     + (f" — {p.title}" if p.title else ""))
    return {
        "url": url,
        "pages": [p.as_dict() for p in sorted(pages, key=lambda x: (x.depth, x.url))],
        "count": len(pages),
        "by_status": by_status,
        **meta,
        "text": "\n".join(lines),
        "error": None,
    }


async def link_check(url: str, *, config: HttpConfig, scope: str = "page", max_pages: int = 20,
                     max_links: int = 500, check_external: bool = True,
                     respect_robots: bool = True, concurrency: int = 8) -> dict:
    if scope not in ("page", "site"):
        raise CrawlError("scope must be page or site")
    pages, meta = await crawl(url, config=config, max_pages=1 if scope == "page" else max_pages,
                              max_depth=0 if scope == "page" else 5,
                              respect_robots=respect_robots, keep_query=False)
    if pages and pages[0].status is None:
        raise CrawlError(f"could not fetch {url}: {pages[0].error}")

    robots = meta.pop("robots")
    known = {p.url: p for p in pages}
    host = urlsplit(url).netloc.lower()
    found_on: dict[str, list[str]] = {}
    texts: dict[str, str] = {}
    skipped: set[str] = set()
    for p in pages:
        for _tag, link, text in p.links:
            internal = urlsplit(link).netloc.lower() == host
            if not check_external and not internal:
                continue
            if internal and robots is not None and not robots.can_fetch("hirara", link):
                skipped.add(link)
                continue
            found_on.setdefault(link, [])
            if p.url not in found_on[link]:
                found_on[link].append(p.url)
            if text and link not in texts:
                texts[link] = text
    links = list(found_on)[: max(1, min(int(max_links), 5000))]
    sem = asyncio.Semaphore(max(1, min(int(concurrency), 32)))

    async def check(link: str) -> dict:
        page = known.get(link)
        if page is not None:
            return {"url": link, "status": page.status, "final_url": page.final_url,
                    "error": page.error}
        async with sem:
            r = await http_request(link, method="HEAD", config=config)
            if r.status in (403, 405, 501) or (r.status is None and not (r.error or "").startswith("blocked")):
                r = await http_request(link, config=config, max_bytes=1024)
        return {"url": link, "status": r.status, "final_url": r.final_url, "error": r.error}

    results = await asyncio.gather(*(check(link) for link in links))
    broken, redirected, blocked, ok = [], [], [], 0
    for res in results:
        item = {**res, "found_on": found_on[res["url"]][:5], "text": texts.get(res["url"])}
        err = res.get("error") or ""
        if err.startswith("blocked"):
            blocked.append(item)
        elif res["status"] is None or res["status"] >= 400:
            broken.append(item)
        else:
            ok += 1
            if res.get("final_url") and normalise(res["final_url"]) != res["url"]:
                redirected.append(item)
    lines = [f"checked {len(results)} link(s) on {len(pages)} page(s): {len(broken)} broken, "
             f"{len(redirected)} redirected, {len(blocked)} blocked by policy"]
    for b in broken[:30]:
        lines.append(f"BROKEN {b['status'] or b['error']} {b['url']} (on {b['found_on'][0]})")
    return {
        "url": url,
        "scope": scope,
        "pages_checked": len(pages),
        "links_checked": len(results),
        "links_found": len(found_on),
        "ok": ok,
        "broken": broken,
        "redirected": redirected[:200],
        "blocked": blocked[:200],
        "skipped_by_robots": sorted(skipped)[:200],
        "truncated": len(found_on) > len(links) or meta["truncated"],
        "text": "\n".join(lines),
        "error": None,
    }


__all__ = ["CrawlError", "crawl", "link_check", "normalise", "site_map"]
