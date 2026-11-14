"""Behaviour of ``with_sources=1`` searches, exercised against local HTML.

Covers the three outcomes the API must distinguish:

* all results enriched successfully,
* some enriched, some kept as listing data with a readable failure reason,
* every enrichment failing while the page itself still returns.

The listing page itself is always one request; enrichment adds at most two
requests per video (video page + player page).
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import (
    LISTING_URL,
    SITE,
    FakeResponse,
    FakeUpstream,
    listing_page,
    player_page,
    player_url,
    video_page,
    video_url,
)

VIDEOS = [
    {"id": "v1", "title": "First video", "image": "https://img.test/1.jpg", "duration_text": "1:00"},
    {"id": "v2", "title": "Second video", "image": "https://img.test/2.jpg", "duration_text": "2:00"},
    {"id": "v3", "title": "Third video", "image": "https://img.test/3.jpg", "duration_text": "3:00"},
]


def build_upstream(*, ok: tuple[str, ...], failures: dict[str, FakeResponse] | None = None) -> FakeUpstream:
    """Listing page + per-video routes.

    ``ok`` lists videos that resolve fully; ``failures`` maps a video id to the
    response its video page should return (``None`` route = 404).
    """
    routes: dict[str, FakeResponse | Exception] = {
        LISTING_URL: FakeResponse(listing_page(VIDEOS), f"{SITE}/video/test+query?p=0")
    }
    for video_id in ok:
        routes[video_url(video_id)] = FakeResponse(
            video_page(
                video_id,
                title=f"Title {video_id}",
                tags="alpha, beta",
                duration=3600 + int(video_id[1:]),
                player_path=f"/player/{video_id}",
            ),
            video_url(video_id),
        )
        routes[player_url(video_id)] = FakeResponse(
            player_page(video_id), player_url(video_id)
        )
    for video_id, response in (failures or {}).items():
        routes[video_url(video_id)] = response
    return FakeUpstream(routes)


def enrich(scraper, upstream: FakeUpstream):
    scraper._get = upstream.get  # type: ignore[method-assign]
    return asyncio.run(scraper.search_videos("test query", 0, with_sources=True))


def test_all_results_enriched_in_one_page(scraper):
    upstream = build_upstream(ok=("v1", "v2", "v3"))
    result = enrich(scraper, upstream)

    assert "error" not in result
    assert [video["id"] for video in result["videos"]] == ["v1", "v2", "v3"]

    for video in result["videos"]:
        assert video["sources_status"] == "ok"
        assert video["sources_error"] is None
        # Listing fields survive enrichment.
        assert video["title"]
        assert video["image"]
        assert video["duration_text"]
        # Enrichment payload is merged in.
        assert video["tags"] == ["alpha", "beta"]
        assert video["player_url"] == player_url(video["id"])
        assert video["sources"]

    # One listing request + exactly two per video, and nothing else.
    assert upstream.requested_urls() == [LISTING_URL] + [
        url
        for video in VIDEOS
        for url in (video_url(video["id"]), player_url(video["id"]))
    ]


@pytest.mark.parametrize("video_id", [video["id"] for video in VIDEOS])
def test_sources_are_sorted_high_to_low(scraper, video_id):
    upstream = build_upstream(ok=("v1", "v2", "v3"))
    result = enrich(scraper, upstream)
    video = next(v for v in result["videos"] if v["id"] == video_id)

    assert [source["label"] for source in video["sources"]] == ["1080", "720", "480"]


def test_sources_with_p_suffix_labels_sort_numerically(scraper):
    """Labels like ``1080p`` are compared by their number, not as text."""
    upstream = build_upstream(ok=("v1", "v2", "v3"))
    upstream.routes[player_url("v1")] = FakeResponse(
        player_page("v1", labels=("240p", "1080p", "720p", "480p")), player_url("v1")
    )

    result = enrich(scraper, upstream)
    v1 = result["videos"][0]

    assert [source["label"] for source in v1["sources"]] == [
        "1080p",
        "720p",
        "480p",
        "240p",
    ]


def test_partial_failure_keeps_listing_fields_and_reason(scraper):
    """v1 and v3 resolve; v2's video page is missing (404)."""
    upstream = build_upstream(
        ok=("v1", "v3"),
        failures={"v2": FakeResponse("gone", video_url("v2"), status_code=404)},
    )
    result = enrich(scraper, upstream)

    assert "error" not in result
    assert [video["id"] for video in result["videos"]] == ["v1", "v2", "v3"]

    v1, v2, v3 = result["videos"]
    assert v1["sources_status"] == "ok"
    assert v2["sources_status"] == "failed"
    assert v2["sources_error"] == "video page could not be loaded"
    assert v3["sources_status"] == "ok"

    # The failed entry keeps exactly the listing-stage fields.
    assert v2["title"] == "Second video"
    assert v2["image"] == "https://img.test/2.jpg"
    assert v2["duration"] == 120
    assert v2["duration_text"] == "2:00"
    assert "sources" not in v2
    assert "player_url" not in v2

    # Mixed order is the source-site order, untouched by failures.
    assert [video["title"] for video in result["videos"]] == [
        "First video",
        "Second video",
        "Third video",
    ]


@pytest.mark.parametrize(
    ("broken", "reason"),
    [
        # No og:video -> no player to ask.
        ("missing_player", "player URL is missing from the video page"),
        # Player page returns 404.
        ("player_404", "player page could not be loaded"),
        # Player page loads but has no usable window.playlist.
        ("bad_playlist", "playlist could not be parsed"),
    ],
)
def test_failure_reasons_are_specific(scraper, broken, reason):
    upstream = build_upstream(ok=("v1", "v3"))
    if broken == "missing_player":
        upstream.routes[video_url("v2")] = FakeResponse(
            video_page("v2", title="T", duration=120, player_path=None),
            video_url("v2"),
        )
    elif broken == "player_404":
        upstream.routes[video_url("v2")] = FakeResponse(
            video_page("v2", title="T", duration=120, player_path="/player/v2"),
            video_url("v2"),
        )
        upstream.routes[player_url("v2")] = FakeResponse(
            "gone", player_url("v2"), status_code=404
        )
    else:
        upstream.routes[video_url("v2")] = FakeResponse(
            video_page("v2", title="T", duration=120, player_path="/player/v2"),
            video_url("v2"),
        )
        upstream.routes[player_url("v2")] = FakeResponse(
            "<html><body>no playlist here</body></html>", player_url("v2")
        )

    result = enrich(scraper, upstream)
    v2 = result["videos"][1]
    assert v2["sources_status"] == "failed"
    assert v2["sources_error"] == reason
    assert v2["title"] == "Second video"
    assert v2["duration_text"] == "2:00"
    assert "sources" not in v2


def test_all_failures_still_return_the_whole_page(scraper):
    """Every video page 404s: the response stays a normal paginated result."""
    upstream = build_upstream(
        ok=(),
        failures={
            video["id"]: FakeResponse("gone", video_url(video["id"]), status_code=404)
            for video in VIDEOS
        },
    )
    result = enrich(scraper, upstream)

    assert "error" not in result
    assert result["query"] == "test query"
    assert len(result["videos"]) == len(VIDEOS)
    for video in result["videos"]:
        assert video["sources_status"] == "failed"
        assert video["sources_error"] == "video page could not be loaded"
        assert video["id"] in {entry["id"] for entry in VIDEOS}
        assert video["image"].startswith("https://img.test/")
        assert video["duration_text"]

    # Exactly one request per video, no fan-out when the video page fails.
    assert len(upstream.calls) == 1 + len(VIDEOS)


def test_precise_duration_replaces_listing_estimate(scraper):
    """A successful enrichment prefers the player page's precise duration."""
    upstream = build_upstream(ok=("v1", "v2", "v3"))
    result = enrich(scraper, upstream)

    v1 = result["videos"][0]
    assert v1["duration"] == 3601
    assert v1["duration_text"] == "1:00:01"


def test_missing_player_duration_keeps_listing_duration(scraper):
    """When the player page has no video:duration meta, the listing value stays."""
    upstream = build_upstream(ok=("v1", "v3"))
    upstream.routes[video_url("v2")] = FakeResponse(
        video_page("v2", title="Title v2", duration=None, player_path="/player/v2"),
        video_url("v2"),
    )
    upstream.routes[player_url("v2")] = FakeResponse(player_page("v2"), player_url("v2"))
    result = enrich(scraper, upstream)

    v2 = result["videos"][1]
    assert v2["sources_status"] == "ok"
    assert v2["duration"] == 120
    assert v2["duration_text"] == "2:00"


def test_empty_playlist_is_a_success_not_a_failure(scraper):
    """A reachable video that genuinely has no direct links is not a failure."""
    upstream = build_upstream(ok=("v1", "v3"))
    upstream.routes[video_url("v2")] = FakeResponse(
        video_page("v2", title="Title v2", player_path="/player/v2"), video_url("v2")
    )
    upstream.routes[player_url("v2")] = FakeResponse(
        '<script>window.playlist = {"sources": []};</script>', player_url("v2")
    )

    result = enrich(scraper, upstream)
    v2 = result["videos"][1]

    assert v2["sources_status"] == "ok"
    assert v2["sources_error"] is None
    assert v2["sources"] == []
    assert v2["player_url"] == player_url("v2")


def test_transport_error_is_reported_not_raised(scraper):
    """A thrown request error becomes a per-entry failure, not a 500."""

    class Boom(Exception):
        pass

    upstream = build_upstream(ok=("v1", "v3"))
    upstream.routes[video_url("v2")] = Boom("connection reset")
    result = enrich(scraper, upstream)

    assert [v["sources_status"] for v in result["videos"]] == ["ok", "failed", "ok"]
    assert result["videos"][1]["sources_error"] == "sources could not be fetched"
    assert result["videos"][1]["title"] == "Second video"


def test_get_video_by_id_still_returns_none_on_failure(scraper):
    """The single-video path keeps its old contract (None, not an exception)."""
    upstream = build_upstream(ok=("v1",))
    upstream.routes[video_url("v2")] = FakeResponse(
        "gone", video_url("v2"), status_code=404
    )
    scraper._get = upstream.get  # type: ignore[method-assign]

    assert asyncio.run(scraper.get_video_by_id("v2")) is None
    assert asyncio.run(scraper.get_video_by_id("v1"))["sources"]


def test_without_sources_makes_no_video_requests(scraper):
    upstream = build_upstream(ok=("v1", "v2", "v3"))
    scraper._get = upstream.get  # type: ignore[method-assign]
    result = asyncio.run(scraper.search_videos("test query", 0, with_sources=False))

    assert upstream.requested_urls() == [LISTING_URL]
    assert [video["id"] for video in result["videos"]] == ["v1", "v2", "v3"]
    for video in result["videos"]:
        assert "sources" not in video
        assert "sources_status" not in video


def test_enrichment_concurrency_is_bounded(scraper):
    """The page is enriched with bounded concurrency, never all at once."""
    from noodle import MAX_ENRICH_CONCURRENCY

    many = [
        {
            "id": f"v{i}",
            "title": f"Video {i}",
            "image": f"https://img.test/{i}.jpg",
            "duration_text": "1:00",
        }
        for i in range(1, 21)
    ]
    upstream = FakeUpstream(
        {LISTING_URL: FakeResponse(listing_page(many), f"{SITE}/video/test+query?p=0")}
    )
    for video in many:
        video_id = video["id"]
        upstream.routes[video_url(video_id)] = FakeResponse(
            video_page(video_id, player_path=f"/player/{video_id}"), video_url(video_id)
        )
        upstream.routes[player_url(video_id)] = FakeResponse(
            player_page(video_id), player_url(video_id)
        )
    upstream.set_delay(0.005)

    scraper._get = upstream.get  # type: ignore[method-assign]
    result = asyncio.run(scraper.search_videos("test query", 0, with_sources=True))

    assert all(video["sources_status"] == "ok" for video in result["videos"])
    assert [video["id"] for video in result["videos"]] == [v["id"] for v in many]
    assert upstream.max_in_flight <= MAX_ENRICH_CONCURRENCY
    assert len(upstream.calls) == 1 + 2 * len(many)
