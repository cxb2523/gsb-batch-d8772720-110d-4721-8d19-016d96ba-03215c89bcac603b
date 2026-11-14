"""Tools used by the AI content optimization agent."""

from .title_scraper import (
    MAX_SCRAPE_RETRIES,
    AttemptOutcome,
    AttemptRecord,
    ScrapeStatus,
    TitleScrapeError,
    TitleScrapeResult,
    TitleScraperExecutor,
    TitleScraperTool,
    extract_title,
    make_unlocker_fetcher,
    scrape_title,
)

__all__ = [
    "MAX_SCRAPE_RETRIES",
    "AttemptOutcome",
    "AttemptRecord",
    "ScrapeStatus",
    "TitleScrapeError",
    "TitleScrapeResult",
    "TitleScraperExecutor",
    "TitleScraperTool",
    "extract_title",
    "make_unlocker_fetcher",
    "scrape_title",
]
