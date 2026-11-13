"""Core data types shared across fetch, segment, decide and crawl."""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field, replace
from typing import Any

# Characters per Jev token, measured on the real API (jev-1.13.0, 8000-character samples of
# Wikipedia text: en 2.38, fr 2.07, de 2.23, ar 1.46, ru 1.45, zh 1.13). The values below are a
# little lower than the measurements so that the estimate errs on the high side.
ASCII_CHARS_PER_TOKEN = 2.1
OTHER_CHARS_PER_TOKEN = 1.4  # Arabic, Cyrillic, accented Latin, ...
CJK_CHARS_PER_TOKEN = 1.0  # Chinese, Japanese, Korean
_NON_ASCII = re.compile("[^\x00-\x7f]")
_CJK = re.compile("[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]")


def estimate_tokens(text: str) -> int:
    """Token estimate for budgeting and packing; real cost comes from ``usage``.

    Script-aware: a flat characters-per-token ratio underestimates non-English text by 2x or
    more (Jev answered HTTP 400 ``max_tokens_exceeded`` on a large Arabic page that a 3.5
    characters-per-token estimate had put well under the limit).
    """
    non_ascii = len(_NON_ASCII.findall(text))
    cjk = len(_CJK.findall(text))
    ascii_chars = len(text) - non_ascii
    return math.ceil(
        ascii_chars / ASCII_CHARS_PER_TOKEN
        + (non_ascii - cjk) / OTHER_CHARS_PER_TOKEN
        + cjk / CJK_CHARS_PER_TOKEN
    )


@dataclass(frozen=True)
class Block:
    """A verbatim span of page text. ``page.text[char_start:char_end] == text``."""

    id: str
    url: str
    heading_path: str
    text: str
    char_start: int
    char_end: int
    tokens_est: int
    link_chars: int = 0
    relevance: float | None = None

    def with_relevance(self, relevance: float | None) -> Block:
        """Return a copy carrying a Jev relevance score (``None`` in degraded mode)."""
        return replace(self, relevance=relevance)

    def to_public(self) -> dict[str, Any]:
        """The block as returned to agents."""
        return {
            "url": self.url,
            "heading_path": self.heading_path,
            "text": self.text,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "relevance": None if self.relevance is None else round(self.relevance, 4),
        }


@dataclass(frozen=True)
class Link:
    """A candidate link found in the main content of a page."""

    id: str
    url: str
    text: str
    context: str
    position: int
    block_id: str | None = None  # the block the link sits in, if that block survived segmentation


@dataclass(frozen=True)
class Page:
    """A fetched and segmented page. ``text`` is all block texts joined by a blank line."""

    url: str
    final_url: str
    status: int
    title: str
    lang: str
    text: str
    text_sha256: str
    blocks: list[Block] = field(default_factory=list)
    links: list[Link] = field(default_factory=list)
    needs_js: bool = False


@dataclass
class Stats:
    """What a crawl cost, which model answered, and why it stopped."""

    pages_fetched: int = 0
    tokens_raw: int = 0
    tokens_returned: int = 0
    jev_calls: int = 0
    cache_hits: int = 0
    jev_input_tokens: int = 0
    jev_cost_usd: float = 0.0
    model: str | None = None
    degraded: bool = False
    degraded_reason: str | None = None
    needs_js_urls: list[str] = field(default_factory=list)  # need JavaScript, not rendered
    js_rendered_urls: list[str] = field(default_factory=list)  # rendered in a browser
    stopped_because: str | None = None
    elapsed_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Plain-dict form for tool output."""
        return asdict(self)


@dataclass(frozen=True)
class SitemapFileRecord:
    """What happened when the discovery phase tried to read one sitemap file.

    ``outcome`` is one of ``parsed`` (the file parsed, ``urls_found`` locs came out of it),
    ``request_failed`` (the HTTP request did not return a body), ``decompress_failed``
    (the gzip stream could not be unpacked) or ``empty`` (the body held no usable content).
    Failures carry a short machine-readable ``reason``; ``truncated`` marks a gzip body whose
    decompression stopped at the size cap rather than at the end of the stream.
    """

    url: str
    outcome: str
    reason: str | None = None
    urls_found: int = 0
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Plain-dict form for tool output."""
        return asdict(self)


@dataclass
class SitemapReport:
    """Per-file audit trail and counters for one crawl's sitemap discovery phase."""

    enabled: bool = False
    files: list[SitemapFileRecord] = field(default_factory=list)
    # Files still queued when the MAX_FILES or MAX_URLS cap stopped discovery.
    files_remaining: int = 0
    # Sitemap URLs that passed the lexical goal filter and were handed to the decision model.
    candidate_links: int = 0

    @classmethod
    def disabled(cls) -> SitemapReport:
        """The explicit marker used when sitemap discovery is switched off."""
        return cls(enabled=False)

    @property
    def files_attempted(self) -> int:
        """Every file the discovery phase actually requested."""
        return len(self.files)

    @property
    def files_succeeded(self) -> int:
        """Files that parsed into loc entries (including loc-less but well-formed files)."""
        return sum(1 for f in self.files if f.outcome == "parsed")

    @property
    def files_failed(self) -> int:
        """Files whose request, decompression or content made them unusable."""
        return sum(1 for f in self.files if f.outcome != "parsed")

    def to_dict(self) -> dict[str, Any]:
        """Plain-dict form for tool output."""
        return {
            "enabled": self.enabled,
            "files_attempted": self.files_attempted,
            "files_succeeded": self.files_succeeded,
            "files_failed": self.files_failed,
            "files_remaining": self.files_remaining,
            "candidate_links": self.candidate_links,
            "files": [f.to_dict() for f in self.files],
        }


@dataclass
class CrawlResult:
    """The output contract returned to the agent."""

    blocks: list[Block] = field(default_factory=list)
    uncertain: list[Block] = field(default_factory=list)
    pages: list[dict[str, Any]] = field(default_factory=list)
    stats: Stats = field(default_factory=Stats)
    # Audit trail of the free sitemap discovery phase; explicitly disabled when not used.
    sitemap: SitemapReport = field(default_factory=SitemapReport.disabled)

    def to_dict(self) -> dict[str, Any]:
        """Plain-dict form for tool output."""
        return {
            "blocks": [b.to_public() for b in self.blocks],
            "uncertain": [b.to_public() for b in self.uncertain],
            "pages": self.pages,
            "stats": self.stats.to_dict(),
            "sitemap": self.sitemap.to_dict(),
        }
