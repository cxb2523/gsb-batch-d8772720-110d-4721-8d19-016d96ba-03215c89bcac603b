"""Offline tests for the per-channel breakdown in
application.collecting.discover_new_videos_via_rss.

Six scenarios, no real network anywhere:
  1. feed with videos the DB does not know yet -> new_videos + one videos.list
  2. feed whose entries are all already stored -> no_new_videos, no API call
  3. feed fetch raises (requests.ConnectionError) -> failed, error_type=network
  4. feed body is malformed XML -> failed, error_type=xml_parse
  5. max_total reached mid-round -> remaining channels skipped_limit, not
     failed, and the ids discovered before the cap still get stored
  6. retry_channel_ids restricts the round to the given channels; an empty
     list falls back to scanning every active tracked channel

Every RSS/HTTP interaction is monkeypatched (infrastructure.youtube.rss and
infrastructure.youtube.client), so this module never opens a socket. Uses the
same throwaway-schema setup as test_gone_tracking.py (tests/schema_scope.py).
Run with pytest, or directly: python3 tests/test_rss_discovery.py
"""
import os
import sys

import pytest
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
# One-off Postgres schema per process (see tests/schema_scope.py).
import schema_scope  # noqa: F401,E402

import infrastructure.postgres as db  # noqa: E402
import infrastructure.youtube.client as yt  # noqa: E402
import infrastructure.youtube.rss as rss  # noqa: E402
from application import collecting as collector  # noqa: E402

KEY = "test-key"

CH_A = "UC" + "rssdiscovA".ljust(22, "0")
CH_B = "UC" + "rssdiscovB".ljust(22, "0")
CH_C = "UC" + "rssdiscovC".ljust(22, "0")
# A channel that is tracked but INACTIVE: a full scan must skip it, an
# explicit retry list must still be allowed to target it.
CH_INACTIVE = "UC" + "rssdiscovZ".ljust(22, "0")


# ------------------------------------------------------------- test helpers

def _feed_xml(channel_id, video_ids):
    """Minimal but valid YouTube-style Atom feed, entries newest first."""
    entries = []
    for i, vid in enumerate(video_ids):
        entries.append(
            "  <entry>\n"
            f"    <yt:videoId>{vid}</yt:videoId>\n"
            f"    <yt:channelId>{channel_id}</yt:channelId>\n"
            f"    <title>title {vid}</title>\n"
            f"    <published>2026-11-0{i + 1}T10:00:00+00:00</published>\n"
            "  </entry>\n")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" '
        'xmlns="http://www.w3.org/2005/Atom">\n'
        f"  <yt:channelId>{channel_id}</yt:channelId>\n"
        + "".join(entries) +
        "</feed>\n")


def _api_video(vid, channel_id):
    """Shape store_videos() expects from a videos.list response item."""
    return {
        "id": vid,
        "snippet": {"channelId": channel_id, "title": f"title {vid}",
                    "publishedAt": "2026-11-01T10:00:00+00:00", "thumbnails": {}},
        "statistics": {"viewCount": "10", "likeCount": "1", "commentCount": "0"},
        "contentDetails": {"duration": "PT5M"},
    }


def setup_module(_=None):
    db.init_db()


@pytest.fixture(autouse=True)
def _no_real_http():
    """Belt-and-braces network guard: every test in this module must stub
    rss.fetch_channel_feed; any code path that still reaches the real
    requests transport fails loudly here instead of hitting YouTube."""
    def _blocked(*a, **kw):
        raise AssertionError("real HTTP request attempted in offline RSS test")
    original = requests.sessions.Session.request
    requests.sessions.Session.request = _blocked
    try:
        yield
    finally:
        requests.sessions.Session.request = original


def _clean():
    conn = db.get_conn()
    conn.execute("DELETE FROM videos")
    conn.execute("DELETE FROM tracked_channels")
    conn.commit()
    conn.close()


def _track(channel_id, active=True):
    conn = db.get_conn()
    conn.execute(
        "INSERT INTO tracked_channels (user_id, channel_id, active, added_at) "
        "VALUES (1,?,?,?) ON CONFLICT (user_id, channel_id) DO UPDATE SET active=?",
        (channel_id, 1 if active else 0, db.now_iso(), 1 if active else 0))
    conn.commit()
    conn.close()


def _seed_known_videos(channel_id, video_ids):
    conn = db.get_conn()
    for vid in video_ids:
        conn.execute(
            "INSERT INTO videos (video_id, channel_id, title, published_at) "
            "VALUES (?,?,?,?) ON CONFLICT (video_id) DO NOTHING",
            (vid, channel_id, vid, "2026-10-01T10:00:00+00:00"))
    conn.commit()
    conn.close()


def _stored_video_ids():
    conn = db.get_conn()
    rows = conn.execute("SELECT video_id FROM videos").fetchall()
    conn.close()
    return {r["video_id"] for r in rows}


def _by_channel(results):
    return {r["channel_id"]: r for r in results}


class _FeedRouter:
    """Stand-in for the RSS layer: per-channel XML bodies or exceptions.

    fetch_channel_feed is replaced with an instance method so a channel can be
    configured to raise a real requests exception (network/HTTP path), while
    parse_feed_strict stays the production parser exercised on malformed XML.
    """

    def __init__(self, bodies=None, failures=None):
        self.bodies = dict(bodies or {})
        self.failures = dict(failures or {})
        self.requested = []

    def fetch(self, channel_id, timeout=10.0):
        self.requested.append(channel_id)
        if channel_id in self.failures:
            raise self.failures[channel_id]
        return self.bodies[channel_id]


def _install(monkeypatch, router, videos_list_calls):
    monkeypatch.setattr(rss, "fetch_channel_feed", router.fetch)
    # Production XML parser stays real: malformed-body tests must go through
    # the actual ET.fromstring -> FeedParseError path.

    def _fake_videos_list(api_key, video_ids, *a, **kw):
        videos_list_calls.append(list(video_ids))
        # Channel id is not encoded in the id itself; the tests only store one
        # channel's new ids per call batch ordering, so map by lookup below.
        owner = _owner_for(video_ids)
        return [_api_video(vid, owner) for vid in video_ids]

    monkeypatch.setattr(yt, "videos_list", _fake_videos_list)


# video id -> owning channel, registered by each scenario's feed setup
_OWNERS = {}


def _owner_for(video_ids):
    for vid in video_ids:
        if vid in _OWNERS:
            return _OWNERS[vid]
    return CH_A


def _remember_owners(channel_id, video_ids):
    for vid in video_ids:
        _OWNERS[vid] = channel_id


# --------------------------------------------------------------- 1. new ones

def test_feed_with_new_videos_reports_new_outcome_and_stores_them(monkeypatch):
    _clean()
    _track(CH_A)
    _seed_known_videos(CH_A, ["old1"])
    new_ids = ["newA1", "newA2"]
    _remember_owners(CH_A, new_ids)
    router = _FeedRouter(bodies={CH_A: _feed_xml(CH_A, ["newA2", "newA1", "old1"])})
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY)

    assert out["channels_checked"] == 1
    assert out["channels_failed"] == 0
    assert out["channels_skipped"] == 0
    assert out["channels_with_new_videos"] == 1
    assert out["new_videos_found"] == 2
    assert out["videos_stored"] == 2
    row = _by_channel(out["channel_results"])[CH_A]
    assert row["outcome"] == collector.RSS_OUTCOME_NEW
    assert row["new_videos"] == 2
    assert row["error_type"] is None and row["error"] is None
    # summary consistency: rows add up to the totals
    assert sum(r["new_videos"] for r in out["channel_results"]) == out["new_videos_found"]
    # exactly one batched videos.list for both ids, RSS itself spent nothing
    assert api_calls == [["newA1", "newA2"]]
    assert out["quota"]["units_from_shared_pool"] == 1
    assert {"newA1", "newA2"} <= _stored_video_ids()
    assert out["retry_only"] is False


# ------------------------------------------------------------- 2. no new ones

def test_feed_with_only_known_videos_reports_no_new_and_makes_no_api_call(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    _seed_known_videos(CH_A, ["a1", "a2"])
    _seed_known_videos(CH_B, ["b1"])
    router = _FeedRouter(bodies={
        CH_A: _feed_xml(CH_A, ["a2", "a1"]),
        CH_B: _feed_xml(CH_B, ["b1"]),
    })
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY)

    assert out["channels_checked"] == 2
    assert out["channels_failed"] == 0
    assert out["new_videos_found"] == 0
    assert out["videos_stored"] == 0
    assert out["channels_with_new_videos"] == 0
    rows = _by_channel(out["channel_results"])
    assert rows[CH_A]["outcome"] == collector.RSS_OUTCOME_NO_NEW
    assert rows[CH_A]["new_videos"] == 0
    assert rows[CH_B]["outcome"] == collector.RSS_OUTCOME_NO_NEW
    assert api_calls == []  # nothing new -> no videos.list, zero quota
    assert out["quota"]["units_from_shared_pool"] == 0


# ------------------------------------------------------- 3. request failure

def test_request_exception_is_failed_network_and_does_not_stop_the_round(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    _remember_owners(CH_B, ["bnew1"])
    router = _FeedRouter(
        bodies={CH_B: _feed_xml(CH_B, ["bnew1"])},
        failures={CH_A: requests.exceptions.ConnectionError("DNS boom")},
    )
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY)

    rows = _by_channel(out["channel_results"])
    failed = rows[CH_A]
    assert failed["outcome"] == collector.RSS_OUTCOME_FAILED
    assert failed["new_videos"] == 0
    assert failed["error_type"] == "network"
    assert "ConnectionError" in failed["error"] and "DNS boom" in failed["error"]
    # the healthy channel in the same round still ran and produced results
    assert rows[CH_B]["outcome"] == collector.RSS_OUTCOME_NEW
    assert out["channels_failed"] == 1
    assert out["channels_checked"] == 1
    assert out["new_videos_found"] == 1
    assert api_calls == [["bnew1"]]


# HTTP errors from raise_for_status() are RequestExceptions too
def test_http_error_status_is_classified_as_network(monkeypatch):
    _clean()
    _track(CH_A)
    router = _FeedRouter(failures={CH_A: requests.exceptions.HTTPError("503 Server Error")})
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY)

    row = _by_channel(out["channel_results"])[CH_A]
    assert row["outcome"] == collector.RSS_OUTCOME_FAILED
    assert row["error_type"] == "network"
    assert "HTTPError" in row["error"]
    assert out["channels_failed"] == 1
    assert api_calls == []


# ---------------------------------------------------------- 4. malformed XML

def test_malformed_xml_is_failed_xml_parse_and_is_distinct_from_network(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    _remember_owners(CH_B, ["bnew1"])
    router = _FeedRouter(bodies={
        CH_A: "<feed><entry><yt:videoId>broken",  # not well-formed
        CH_B: _feed_xml(CH_B, ["bnew1"]),
    })
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY)

    rows = _by_channel(out["channel_results"])
    bad = rows[CH_A]
    assert bad["outcome"] == collector.RSS_OUTCOME_FAILED
    assert bad["error_type"] == "xml_parse"
    assert "FeedParseError" in bad["error"]
    # round survives: the other channel still gets checked and stored
    assert rows[CH_B]["outcome"] == collector.RSS_OUTCOME_NEW
    assert out["channels_failed"] == 1
    assert out["channels_checked"] == 1
    assert api_calls == [["bnew1"]]


def test_empty_feed_body_is_xml_parse_failure(monkeypatch):
    _clean()
    _track(CH_A)
    router = _FeedRouter(bodies={CH_A: ""})
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY)

    row = _by_channel(out["channel_results"])[CH_A]
    assert row["outcome"] == collector.RSS_OUTCOME_FAILED
    assert row["error_type"] == "xml_parse"


# ------------------------------------------------------------- 5. max_total

def test_max_total_marks_unprocessed_channels_skipped_but_keeps_discovered(monkeypatch):
    _clean()
    for ch in (CH_A, CH_B, CH_C):
        _track(ch)
    _remember_owners(CH_A, ["a1", "a2"])
    _remember_owners(CH_B, ["b1", "b2"])
    _remember_owners(CH_C, ["c1"])
    router = _FeedRouter(bodies={
        CH_A: _feed_xml(CH_A, ["a2", "a1"]),
        CH_B: _feed_xml(CH_B, ["b2", "b1"]),
        CH_C: _feed_xml(CH_C, ["c1"]),
    })
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY, max_total=3)

    rows = _by_channel(out["channel_results"])
    # A and B together already fill the cap; C is never fetched
    assert router.requested == [CH_A, CH_B]
    assert rows[CH_A]["outcome"] == collector.RSS_OUTCOME_NEW
    assert rows[CH_B]["outcome"] == collector.RSS_OUTCOME_NEW
    skipped = rows[CH_C]
    assert skipped["outcome"] == collector.RSS_OUTCOME_SKIPPED
    assert skipped["new_videos"] == 0
    assert skipped["error_type"] is None  # a skip is not a failure
    # aggregate bookkeeping
    assert out["channels_checked"] == 2
    assert out["channels_failed"] == 0
    assert out["channels_skipped"] == 1
    assert out["new_videos_found"] == 3
    assert out["videos_stored"] == 3
    assert sum(r["new_videos"] for r in out["channel_results"]) == 3
    # already-discovered ids are still stored in one batch, RSS cap or not
    assert len(api_calls) == 1 and len(api_calls[0]) == 3
    assert "c1" not in _stored_video_ids()


def test_max_total_truncates_oversized_first_channel_but_does_not_fail_it(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    ids_a = [f"a{i}" for i in range(5)]
    _remember_owners(CH_A, ids_a)
    router = _FeedRouter(bodies={CH_A: _feed_xml(CH_A, list(reversed(ids_a))),
                                 CH_B: _feed_xml(CH_B, ["b1"])})
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY, max_total=2)

    rows = _by_channel(out["channel_results"])
    # first channel is still a success, just capped to the remaining room
    assert rows[CH_A]["outcome"] == collector.RSS_OUTCOME_NEW
    assert rows[CH_A]["new_videos"] == 2
    assert rows[CH_B]["outcome"] == collector.RSS_OUTCOME_SKIPPED
    assert out["new_videos_found"] == 2
    assert out["channels_skipped"] == 1
    assert out["channels_failed"] == 0


# ------------------------------------------------------------- 6. retry run

def test_retry_channel_ids_checks_only_the_given_channels(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    _track(CH_INACTIVE, active=False)
    _remember_owners(CH_INACTIVE, ["z1"])
    router = _FeedRouter(bodies={
        CH_A: _feed_xml(CH_A, ["a1"]),
        CH_INACTIVE: _feed_xml(CH_INACTIVE, ["z1"]),
    })
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(
        KEY, retry_channel_ids=[CH_A, CH_INACTIVE])

    rows = _by_channel(out["channel_results"])
    assert set(rows) == {CH_A, CH_INACTIVE}  # CH_B never scanned
    assert router.requested == [CH_A, CH_INACTIVE]
    assert rows[CH_INACTIVE]["outcome"] == collector.RSS_OUTCOME_NEW
    assert out["retry_only"] is True
    assert out["new_videos_found"] == 2


def test_empty_retry_list_falls_back_to_all_active_tracked_channels(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    _track(CH_INACTIVE, active=False)
    router = _FeedRouter(bodies={
        CH_A: _feed_xml(CH_A, ["a1"]),
        CH_B: _feed_xml(CH_B, ["b1"]),
    })
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY, retry_channel_ids=[])

    rows = _by_channel(out["channel_results"])
    assert set(rows) == {CH_A, CH_B}  # inactive channel excluded by full scan
    assert router.requested == [CH_A, CH_B]
    assert out["retry_only"] is False


def test_retry_only_round_reports_failures_without_touching_other_channels(monkeypatch):
    _clean()
    _track(CH_A)
    _track(CH_B)
    router = _FeedRouter(
        failures={CH_A: requests.exceptions.ConnectionError("feed down")})
    api_calls = []
    _install(monkeypatch, router, api_calls)

    out = collector.discover_new_videos_via_rss(KEY, retry_channel_ids=[CH_A])

    assert [r["channel_id"] for r in out["channel_results"]] == [CH_A]
    assert router.requested == [CH_A]  # CH_B must not be touched
    row = out["channel_results"][0]
    assert row["outcome"] == collector.RSS_OUTCOME_FAILED
    assert row["error_type"] == "network"
    assert out["channels_failed"] == 1
    assert out["channels_checked"] == 0


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))
