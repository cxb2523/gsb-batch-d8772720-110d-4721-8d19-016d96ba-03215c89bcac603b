"""The Scraper entry point.

Scraper picks a fetch strategy (static HTML, real browser, or JSON API) —
or decides automatically — and returns a Page. It also carries the
single-page-following `crawl()` helper and hands out authenticated Sessions.
"""

from __future__ import annotations

import time

import requests

from .page import Page
from .selectors import _split_selector, _value_from
from .session import Session
from .url import DEFAULT_UA, _decoded_html, _raise_for_status

# Per-page outcomes reported by Scraper.crawl(detailed=True). The flat record
# list could never say why the walk stopped — these four make it explicit:
#   success        the page fetched fine and the walk moved (or continued) on
#   request_failed the fetch raised; the page kept no records and the walk
#                  stops there without guessing the next URL
#   no_next_page   the page fetched fine but exposed no next-page link
#   pages_limit    the page fetched fine and the `pages` budget was spent —
#                  a deliberate truncation, never conflated with no_next_page
CRAWL_SUCCESS = "success"
CRAWL_REQUEST_FAILED = "request_failed"
CRAWL_NO_NEXT_PAGE = "no_next_page"
CRAWL_PAGES_LIMIT = "pages_limit"


class Scraper:
    """Entry point. Pick a strategy or let it decide on its own."""

    def __init__(self, user_agent: str = DEFAULT_UA, delay: float = 0.0, timeout: int = 15):
        self.user_agent = user_agent
        self.delay = delay
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": user_agent})

    # --- strategies -----------------------------------------------------------
    def static(self, url: str) -> Page:
        """Technique 1: static HTML with requests."""
        t0 = time.perf_counter()
        r = self._session.get(url, timeout=self.timeout)
        _raise_for_status(r)
        self._wait()
        return Page(
            url=url,
            html=_decoded_html(r),
            method="static",
            elapsed=round(time.perf_counter() - t0, 3),
            status=r.status_code,
        )

    def api(self, url: str, params: dict | None = None) -> Page:
        """Technique 3: requests an API and stores the JSON."""
        t0 = time.perf_counter()
        r = self._session.get(url, params=params, timeout=self.timeout)
        _raise_for_status(r)
        self._wait()
        try:
            data = r.json()
        except ValueError as e:
            ctype = r.headers.get("content-type", "unknown")
            raise ValueError(f"{url} did not return JSON (content-type: {ctype})") from e
        return Page(
            url=url,
            data=data,
            method="api",
            elapsed=round(time.perf_counter() - t0, 3),
            status=r.status_code,
        )

    def browser(self, url: str, wait: str | None = None, scroll: bool = False) -> Page:
        """Technique 2: real browser (Playwright) for JS-rendered sites."""
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise ImportError(
                "Scraper.browser() needs the 'browser' extra: "
                "pip install bytecrawl[browser] && playwright install chromium"
            ) from e

        t0 = time.perf_counter()
        with sync_playwright() as p:
            nav = p.chromium.launch(headless=True)
            pg = nav.new_page()
            resp = pg.goto(url, wait_until="networkidle")
            if wait:
                pg.wait_for_selector(wait)
            if scroll:
                pg.mouse.wheel(0, 100000)
                pg.wait_for_timeout(500)
            html = pg.content()
            status = resp.status if resp else 0
            nav.close()
        self._wait()
        return Page(
            url=url,
            html=html,
            method="browser",
            elapsed=round(time.perf_counter() - t0, 3),
            status=status,
        )

    def fetch(self, url: str, strategy: str = "auto") -> Page:
        """Fetches the page. strategy: auto | static | browser.

        'auto' downloads statically and, if the page looks empty (typical of
        SPAs that render with JS), retries with a browser.
        """
        if strategy == "static":
            return self.static(url)
        if strategy == "browser":
            return self.browser(url)
        # auto
        page = self.static(url)
        text = page.soup.get_text(strip=True)
        if len(text) < 200:  # heuristic: almost no content -> probably JS
            return self.browser(url)
        return page

    # --- crawling -----------------------------------------------------------
    def crawl(
        self,
        start: str,
        item: str,
        fields: dict[str, str],
        next_page: str | None = None,
        pages: int | None = None,
        base: str | None = None,
        detailed: bool = False,
    ) -> list[dict] | dict:
        """Walks multiple pages following the next-page link and extracts 'fields'.

        start:     initial URL.
        item:      selector for each record.
        fields:    fields to extract (see Page.extract).
        next_page: selector for the next-page link (e.g. "li.next a::attr(href)").
        pages:     optional page limit.
        base:      prefix for relative URLs (otherwise inferred from the host).
        detailed:  when False (the default) returns the flat list of records,
                   exactly as before — including raising if a page's request
                   fails. When True, returns a dict instead:

                       {
                         "pages": [   # one entry per page actually attempted
                           {"page": 1, "url": ..., "count": 2,
                            "outcome": "success", "error": None},
                           ...
                         ],
                         "records": [ ...all records from every successful page... ],
                       }

                   Every outcome constant is exported alongside Scraper:
                   CRAWL_SUCCESS, CRAWL_REQUEST_FAILED, CRAWL_NO_NEXT_PAGE and
                   CRAWL_PAGES_LIMIT. A failed page is reported (outcome
                   "request_failed", `error` carries the exception text, count
                   0) and the walk stops without guessing another URL; every
                   record extracted earlier stays in `records` — even when the
                   very first page fails, in which case `records` is empty but
                   the failed page's outcome remains readable.
        """
        from urllib.parse import urljoin

        url: str | None = start
        records: list[dict] = []
        report: list[dict] = []
        n = 0
        while url:
            n += 1
            try:
                page = self.static(url)
            except Exception as e:
                # Default mode keeps the historical contract: the exception
                # propagates. Detailed mode keeps every record already taken
                # and accounts for this page instead of losing the walk.
                if not detailed:
                    raise
                report.append(
                    {
                        "page": n,
                        "url": url,
                        "count": 0,
                        "outcome": CRAWL_REQUEST_FAILED,
                        "error": f"{type(e).__name__}: {e}",
                    }
                )
                break
            rows = page.extract(item, fields)
            records.extend(rows)

            if pages and n >= pages:
                outcome = CRAWL_PAGES_LIMIT
                next_url = None
            elif not next_page:
                outcome = CRAWL_NO_NEXT_PAGE
                next_url = None
            else:
                sel, op, arg = _split_selector(next_page)
                node = page.soup.select_one(sel)
                op = op if op != "text" else "attr"
                href = _value_from(node, op, arg or "href") if node else None
                if not href:
                    outcome = CRAWL_NO_NEXT_PAGE
                    next_url = None
                else:
                    outcome = CRAWL_SUCCESS
                    next_url = urljoin(base or url, href)

            if detailed:
                report.append(
                    {
                        "page": n,
                        "url": url,
                        "count": len(rows),
                        "outcome": outcome,
                        "error": None,
                    }
                )
            url = next_url

        if detailed:
            return {"pages": report, "records": records}
        return records

    # --- session --------------------------------------------------------------
    def session(self) -> Session:
        return Session(self)

    def _wait(self):
        if self.delay:
            time.sleep(self.delay)
