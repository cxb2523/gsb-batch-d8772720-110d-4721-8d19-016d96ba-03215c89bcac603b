"""Local HTML fixtures for the scraper tests.

The real site is never contacted: every test builds listing/video/player
markup locally and swaps ``NoodleScraper._get`` for a dispatcher over those
pages. URLs follow the shapes the scraper requests.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noodle import NoodleScraper  # noqa: E402

SITE = "https://noodlemagazine.com"
LISTING_URL = f"{SITE}/video/test+query?p=0"


class FakeResponse:
    """Minimal stand-in for ``curl_cffi`` responses."""

    def __init__(self, text: str, url: str, status_code: int = 200):
        self.text = text
        self.url = url
        self.status_code = status_code


def listing_page(videos: list[dict]) -> str:
    """Build a listing page with one card per video.

    Each entry needs ``id``, ``title``, ``image`` and ``duration_text``.
    """
    cards = []
    for video in videos:
        cards.append(
            f"""
            <a class="item_link" href="/watch/{video['id']}">
                <img data-src="{video['image']}" alt="{video['title']}">
                <div class="i_info"><div class="title">{video['title']}</div></div>
                <div class="m_time">{video['duration_text']}</div>
            </a>
            """
        )
    return f'<html><body><div class="list_videos">{"".join(cards)}</div></body></html>'


def video_page(
    video_id: str,
    *,
    title: str | None = None,
    tags: str = "tag one, tag two",
    duration: int | None = 1234,
    player_path: str | None = None,
) -> str:
    """Video page: og:video points at the player, other og/video metas follow."""
    metas = []
    if player_path is not None:
        metas.append(
            f'<meta property="og:video" content="https://cdn.example.net{player_path}">'
        )
    if title is not None:
        metas.append(f'<meta property="og:title" content="{title}">')
    if tags is not None:
        metas.append(f'<meta property="video:tag" content="{tags}">')
    if duration is not None:
        metas.append(f'<meta property="video:duration" content="{duration}">')
    return f"<html><head>{''.join(metas)}</head><body>video {video_id}</body></html>"


def player_page(video_id: str, labels: tuple[str, ...] = ("480", "1080", "720")) -> str:
    """Player page with an inline ``window.playlist`` object, deliberately unsorted."""
    sources = ",".join(
        '{"label":"%s","file":"https://cdn.test/%s/%s.mp4"}'
        % (label, video_id, label)
        for label in labels
    )
    return (
        "<html><body><script>"
        f'window.playlist = {{"sources":[{sources}]}};'
        "</script></body></html>"
    )


def video_url(video_id: str) -> str:
    return f"{SITE}/watch/{video_id}"


def player_url(video_id: str) -> str:
    # og:video lives on a CDN host and is rewritten onto the site origin.
    return f"{SITE}/player/{video_id}"


class FakeUpstream:
    """Routes requested URLs to local markup and records every call."""

    def __init__(self, routes: dict[str, FakeResponse | Exception]):
        self.routes = routes
        self.calls: list[dict[str, str | None]] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self._delay = 0.0

    def set_delay(self, seconds: float) -> None:
        self._delay = seconds

    async def get(self, url: str, referer: str | None = None):
        self.calls.append({"url": url, "referer": referer})
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self._delay:
                await asyncio.sleep(self._delay)
            result = self.routes.get(url)
            if result is None:
                return FakeResponse("not found", url, status_code=404)
            if isinstance(result, Exception):
                raise result
            return result
        finally:
            self.in_flight -= 1

    def requested_urls(self) -> list[str]:
        return [call["url"] for call in self.calls]


@pytest.fixture
def upstream() -> FakeUpstream:
    site = FakeUpstream(
        {
            LISTING_URL: FakeResponse(
                listing_page(
                    [
                        {
                            "id": "v1",
                            "title": "First video",
                            "image": "https://img.test/1.jpg",
                            "duration_text": "1:00",
                        }
                    ]
                ),
                f"{SITE}/video/test+query?p=0",
            )
        }
    )
    return site


@pytest.fixture
def scraper(upstream: FakeUpstream) -> NoodleScraper:
    instance = NoodleScraper()
    instance._get = upstream.get  # type: ignore[method-assign]
    return instance
