"""
Local, network-free tests for Spotify.audio_features.

The HTTP layer is replaced by FakeTransport (see conftest.py), so these
tests never touch www.chosic.com or any other real endpoint.
"""

import requests


def _features(track_id, tempo):
    return {
        "id": track_id,
        "tempo": tempo,
        "key": 5,
        "mode": 1,
        "danceability": 0.7,
        "energy": 0.8,
    }


# --------------------------------------------------------------------------
# All successes
# --------------------------------------------------------------------------

def test_all_success(sp, transport_factory):
    routes = {
        "id-a": {"type": "ok", "payload": _features("id-a", 120.0)},
        "id-b": {"type": "ok", "payload": _features("id-b", 96.5)},
    }
    transport = transport_factory(routes)

    result = sp.audio_features(["id-a", "id-b"])

    assert [item["trackId"] for item in result["items"]] == ["id-a", "id-b"]
    assert all(item["status"] == "ok" for item in result["items"])
    assert result["items"][0]["features"] == _features("id-a", 120.0)
    assert result["items"][1]["features"] == _features("id-b", 96.5)
    assert "error" not in result["items"][0]
    assert transport.requested == ["id-a", "id-b"]
    assert result["summary"] == {
        "total": 2, "success": 2, "failed": 0, "retryable": 0
    }
    # Original per-request throttle preserved: one sleep between two requests.
    assert sp.sleep_calls == [sp.AUDIO_FEATURES_THROTTLE_SECONDS]


# --------------------------------------------------------------------------
# Partial failures: one bad track never aborts the rest of the batch
# --------------------------------------------------------------------------

def test_partial_failure_each_failure_mode(sp, transport_factory):
    routes = {
        "ok-1": {"type": "ok", "payload": _features("ok-1", 110.0)},
        "net-1": {
            "type": "network",
            "error": requests.exceptions.ConnectionError("boom"),
        },
        "rate-1": {"type": "status", "status": 429},
        "srv-1": {"type": "status", "status": 503},
        "json-1": {"type": "bad_json"},
        "miss-1": {"type": "status", "status": 404},
        "ok-2": {"type": "ok", "payload": _features("ok-2", 140.0)},
    }
    transport = transport_factory(routes)

    result = sp.audio_features(
        ["ok-1", "net-1", "rate-1", "srv-1", "json-1", "miss-1", "ok-2"]
    )
    items = result["items"]

    # Order matches the input one-for-one.
    assert [item["trackId"] for item in items] == [
        "ok-1", "net-1", "rate-1", "srv-1", "json-1", "miss-1", "ok-2"
    ]

    by_id = {item["trackId"]: item for item in items}

    # Successes.
    assert by_id["ok-1"]["status"] == "ok"
    assert by_id["ok-1"]["features"]["tempo"] == 110.0
    assert by_id["ok-2"]["status"] == "ok"
    assert by_id["ok-2"]["features"]["tempo"] == 140.0

    # Every failure carries error text and a retryable flag, no features.
    for failed_id in ("net-1", "rate-1", "srv-1", "json-1", "miss-1"):
        item = by_id[failed_id]
        assert item["status"] == "error"
        assert isinstance(item["error"], str) and item["error"]
        assert isinstance(item["retryable"], bool)
        assert "features" not in item

    # Network errors, 429/5xx and unparseable JSON are retryable;
    # a 404 (other 4xx) is a permanent failure for that track.
    assert by_id["net-1"]["retryable"] is True
    assert "network error" in by_id["net-1"]["error"]
    assert by_id["rate-1"]["retryable"] is True
    assert by_id["srv-1"]["retryable"] is True
    assert "503" in by_id["srv-1"]["error"]
    assert by_id["json-1"]["retryable"] is True
    assert "invalid JSON" in by_id["json-1"]["error"]
    assert by_id["miss-1"]["retryable"] is False

    # All tracks were still attempted.
    assert transport.requested == [
        "ok-1", "net-1", "rate-1", "srv-1", "json-1", "miss-1", "ok-2"
    ]
    assert result["summary"] == {
        "total": 7, "success": 2, "failed": 5, "retryable": 4
    }


# --------------------------------------------------------------------------
# All failures
# --------------------------------------------------------------------------

def test_all_failure(sp, transport_factory):
    routes = {
        "a": {"type": "network",
              "error": requests.exceptions.Timeout("timed out")},
        "b": {"type": "status", "status": 500},
        "c": {"type": "bad_json"},
    }
    transport = transport_factory(routes)

    result = sp.audio_features(["a", "b", "c"])

    assert all(item["status"] == "error" for item in result["items"])
    assert [item["trackId"] for item in result["items"]] == ["a", "b", "c"]
    assert all(item["retryable"] for item in result["items"])
    assert transport.requested == ["a", "b", "c"]
    assert result["summary"] == {
        "total": 3, "success": 0, "failed": 3, "retryable": 3
    }


# --------------------------------------------------------------------------
# Empty list
# --------------------------------------------------------------------------

def test_empty_list(sp, transport_factory):
    transport = transport_factory({})

    result = sp.audio_features([])

    assert result["items"] == []
    assert result["summary"] == {
        "total": 0, "success": 0, "failed": 0, "retryable": 0
    }
    assert transport.requested == []
    assert sp.sleep_calls == []


# --------------------------------------------------------------------------
# Single string argument (not wrapped in a list by the caller)
# --------------------------------------------------------------------------

def test_single_string_input(sp, transport_factory):
    transport = transport_factory(
        {"solo": {"type": "ok", "payload": _features("solo", 128.0)}}
    )

    result = sp.audio_features("solo")

    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["trackId"] == "solo"
    assert item["status"] == "ok"
    assert item["features"] == _features("solo", 128.0)
    assert transport.requested == ["solo"]
    assert result["summary"] == {
        "total": 1, "success": 1, "failed": 0, "retryable": 0
    }
    # A lone request needs no throttle wait.
    assert sp.sleep_calls == []


def test_single_string_failure(sp, transport_factory):
    transport = transport_factory({"solo": {"type": "status", "status": 429}})

    result = sp.audio_features("solo")

    assert result["items"][0]["status"] == "error"
    assert result["items"][0]["retryable"] is True
    assert result["summary"]["failed"] == 1
    assert transport.requested == ["solo"]


# --------------------------------------------------------------------------
# Spotify URLs are normalized with urlToId
# --------------------------------------------------------------------------

def test_spotify_urls_normalized(sp, transport_factory):
    transport = transport_factory(
        {"4tyjNEHKos3lZPYAfTiMKH": {
            "type": "ok",
            "payload": _features("4tyjNEHKos3lZPYAfTiMKH", 100.0),
        }}
    )

    url = ("https://open.spotify.com/track/4tyjNEHKos3lZPYAfTiMKH"
           "?si=b6fd0ef9ebca4a0c")
    result = sp.audio_features([url])

    assert result["items"][0]["trackId"] == "4tyjNEHKos3lZPYAfTiMKH"
    assert transport.requested == ["4tyjNEHKos3lZPYAfTiMKH"]
    assert transport.urls[0].endswith(
        "/api/tools/audio-features/4tyjNEHKos3lZPYAfTiMKH"
    )


# --------------------------------------------------------------------------
# Selective rerun: only retryable failures are re-requested, order is kept
# --------------------------------------------------------------------------

def test_rerun_only_requests_failed_and_keeps_order(sp, transport_factory):
    first_routes = {
        "t1": {"type": "ok", "payload": _features("t1", 100.0)},
        "t2": {"type": "status", "status": 429},      # retryable, then recovers
        "t3": {"type": "ok", "payload": _features("t3", 130.0)},
        "t4": {"type": "bad_json"},                    # still retryable, still fails
        "t5": {"type": "network",
               "error": requests.exceptions.ConnectionError("down")},
    }
    transport = transport_factory(first_routes)

    first = sp.audio_features(["t1", "t2", "t3", "t4", "t5"])
    assert first["summary"] == {
        "total": 5, "success": 2, "failed": 3, "retryable": 3
    }
    first_requests = list(transport.requested)
    assert first_requests == ["t1", "t2", "t3", "t4", "t5"]

    # The caller reruns through the same entry point, handing back the result.
    # t2 now succeeds; t4/t5 remain broken.
    transport.routes["t2"] = {"type": "ok", "payload": _features("t2", 124.0)}
    sp.sleep_calls.clear()

    second = sp.audio_features(
        ["t1", "t2", "t3", "t4", "t5"], previousResult=first
    )
    items = second["items"]

    # Only the three retryable failures were requested again.
    assert transport.requested[len(first_requests):] == ["t2", "t4", "t5"]
    assert "t1" not in transport.requested[len(first_requests):]
    assert "t3" not in transport.requested[len(first_requests):]

    # Result still aligned to the original input order.
    assert [item["trackId"] for item in items] == ["t1", "t2", "t3", "t4", "t5"]

    by_id = {item["trackId"]: item for item in items}
    assert by_id["t1"]["status"] == "ok"
    assert by_id["t1"]["features"] == _features("t1", 100.0)
    assert by_id["t3"]["status"] == "ok"
    assert by_id["t3"]["features"] == _features("t3", 130.0)
    assert by_id["t2"]["status"] == "ok"
    assert by_id["t2"]["features"] == _features("t2", 124.0)
    assert by_id["t4"]["status"] == "error"
    assert by_id["t4"]["retryable"] is True
    assert by_id["t5"]["status"] == "error"
    assert by_id["t5"]["retryable"] is True

    assert second["summary"] == {
        "total": 5, "success": 3, "failed": 2, "retryable": 2
    }

    # Throttle applies only between the three real rerun requests
    # (2 sleeps), never for the two cached successes.
    assert sp.sleep_calls == [
        sp.AUDIO_FEATURES_THROTTLE_SECONDS,
        sp.AUDIO_FEATURES_THROTTLE_SECONDS,
    ]


def test_rerun_accepts_items_list_directly(sp, transport_factory):
    transport = transport_factory({
        "t1": {"type": "ok", "payload": _features("t1", 100.0)},
        "t2": {"type": "status", "status": 500},
    })

    first = sp.audio_features(["t1", "t2"])
    baseline = len(transport.requested)

    # Passing just the "items" list must work as well as the full object.
    second = sp.audio_features(
        ["t1", "t2"], previousResult=first["items"]
    )

    new_requests = transport.requested[baseline:]
    assert new_requests == ["t2"]  # only the failure is retried
    assert [item["trackId"] for item in second["items"]] == ["t1", "t2"]
    assert second["items"][0]["status"] == "ok"


def test_non_retryable_failure_is_not_refetched(sp, transport_factory):
    transport = transport_factory({"gone": {"type": "status", "status": 404}})

    first = sp.audio_features(["gone"])
    assert first["items"][0]["retryable"] is False
    assert transport.requested == ["gone"]

    second = sp.audio_features(["gone"], previousResult=first)

    # A permanent error is carried forward without another request.
    assert transport.requested == ["gone"]
    assert second["items"][0]["status"] == "error"
    assert second["items"][0]["retryable"] is False
    assert second["summary"] == {
        "total": 1, "success": 0, "failed": 1, "retryable": 0
    }


def test_rerun_includes_a_new_track(sp, transport_factory):
    transport = transport_factory({
        "t1": {"type": "ok", "payload": _features("t1", 100.0)},
        "t2": {"type": "status", "status": 429},
        "t3": {"type": "ok", "payload": _features("t3", 150.0)},
    })

    first = sp.audio_features(["t1", "t2"])

    # A later batch reuses prior work and also fetches a brand-new id.
    second = sp.audio_features(
        ["t1", "t2", "t3"], previousResult=first
    )

    assert transport.requested == ["t1", "t2", "t2", "t3"]
    assert [item["trackId"] for item in second["items"]] == ["t1", "t2", "t3"]
    assert second["items"][2]["features"] == _features("t3", 150.0)


# --------------------------------------------------------------------------
# Request plumbing: fresh session per track, language cookie, custom UA
# --------------------------------------------------------------------------

def test_session_and_headers_per_track(sp, transport_factory):
    transport = transport_factory({
        "t1": {"type": "ok", "payload": _features("t1", 100.0)},
        "t2": {"type": "ok", "payload": _features("t2", 110.0)},
    })

    sp.audio_features(["t1", "t2"])

    # A separate session is created for each track.
    assert len(transport.sessions) == 2
    for session in transport.sessions:
        assert session.cookies.jar.get("pll_language") == "en"
        assert "User-Agent" in session.headers
        assert session.last_headers["x-requested-with"] == "XMLHttpRequest"
        assert session.last_headers["app"] == "playlist_generator"
