"""Scraping subpackage: fetch a page, then extract data from it.

Public surface: :class:`Scraper` (the entry point), the :class:`Page` it
returns, :class:`Session` for authenticated flows, and :func:`normalize`
for turning hrefs into canonical URLs.
"""

from __future__ import annotations

from .page import Page
from .scraper import (
    CRAWL_NO_NEXT_PAGE,
    CRAWL_PAGES_LIMIT,
    CRAWL_REQUEST_FAILED,
    CRAWL_SUCCESS,
    Scraper,
)
from .session import Session
from .url import BlockedError, RateLimitError, normalize

__all__ = [
    "Page",
    "Session",
    "Scraper",
    "normalize",
    "BlockedError",
    "RateLimitError",
    "CRAWL_SUCCESS",
    "CRAWL_REQUEST_FAILED",
    "CRAWL_NO_NEXT_PAGE",
    "CRAWL_PAGES_LIMIT",
]
