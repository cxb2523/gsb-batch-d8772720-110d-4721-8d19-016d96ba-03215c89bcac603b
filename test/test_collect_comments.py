"""Tests for hasdata_tiktok_mcp.collect_comments.

All responses are fabricated locally through an injected fake fetcher; no test
touches the network. Sleeps are faked too, so rate-limit backoffs run instantly.
"""
import json

import pytest

from hasdata_tiktok_mcp.collect import (
    COMPLETE,
    FAILED,
    OK,
    MissingApiKeyError,
    collect_comments,
)

VIDEO_ID = "7677375185028271391"


def page(comments, next_token=None, total=None):
    """Build a fake response body in the comments endpoint's shape."""
    pagination = {}
    if next_token is not None:
        pagination["nextPageToken"] = next_token
    if total is not None:
        pagination["total"] = total
    return {"comments": comments, "pagination": pagination}


def comment(cid, likes, reply_count=0, text=""):
    return {"id": cid, "text": text, "likes": likes, "replyCount": reply_count}


class FakeFetcher:
    """Routes (params predicate -> queued responses) and records every call."""

    def __init__(self):
        self.calls = []
        self.routes = []

    def add(self, predicate, *responses):
        self.routes.append((predicate, list(responses)))

    async def __call__(self, params, api_key):
        assert api_key == "test-key"
        self.calls.append(dict(params))
        for predicate, responses in self.routes:
            if predicate(params):
                assert responses, f"unexpected extra request: {params}"
                response = responses.pop(0)
                if isinstance(response, Exception):
                    raise response
                return response
        raise AssertionError(f"no route for params: {params}")


def ok(payload):
    return (200, json.dumps(payload))


class FakeSleep:
    def __init__(self):
        self.delays = []

    async def __call__(self, seconds):
        self.delays.append(seconds)


@pytest.fixture
def sleeper():
    return FakeSleep()


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setenv("HASDATA_API_KEY", "test-key")


def top_level(params):
    return params.get("videoId") == VIDEO_ID and "commentId" not in params


def replies_to(comment_id):
    return lambda params: params.get("commentId") == comment_id


async def test_two_full_pages_and_thread_expansion(sleeper):
    fetcher = FakeFetcher()
    top_comments = [
        comment("c1", 10, reply_count=5),
        comment("c2", 90, reply_count=3),
        comment("c3", 50, reply_count=0),  # no replies, never expanded
        comment("c4", 70, reply_count=8),
        comment("c5", 30, reply_count=2),
    ]
    fetcher.add(
        top_level,
        ok(page(top_comments[:3], next_token="tok2", total=123)),
        ok(page(top_comments[3:], total=123)),
    )
    # expand_top=3 by likes among replyCount>0: c2 (90), c4 (70), c3? no —
    # c3 has replyCount 0, so the third is c5 (30).
    fetcher.add(replies_to("c2"), ok(page([comment("r21", 1)])))
    fetcher.add(replies_to("c4"), ok(page([comment("r41", 2)])))
    fetcher.add(replies_to("c5"), ok(page([comment("r51", 3)])))

    result = await collect_comments(VIDEO_ID, pages=3, fetch=fetcher, sleep=sleeper)

    assert result["status"] == COMPLETE
    assert result["total"] == 123
    # Top-level comments keep their original order.
    assert [c["id"] for c in result["comments"]] == ["c1", "c2", "c3", "c4", "c5"]
    # Expansion picked the three most-liked comments with replies.
    assert [t["commentId"] for t in result["threads"]] == ["c2", "c4", "c5"]
    for thread in result["threads"]:
        assert thread["status"] == COMPLETE
        assert thread["pages"] == [{"page": 1, "outcome": OK, "nextPageToken": None}]
        assert len(thread["replies"]) == 1
    # Ids travelled as strings; page 2 of the top level carried the token.
    assert fetcher.calls[0] == {"videoId": VIDEO_ID}
    assert fetcher.calls[1] == {"videoId": VIDEO_ID, "nextPageToken": "tok2"}
    assert all(isinstance(c.get("commentId", "x"), str) for c in fetcher.calls)
    assert len(fetcher.calls) == 5  # 2 top-level pages + 3 reply pages
    assert sleeper.delays == []


async def test_second_page_empty_stops_paging(sleeper):
    fetcher = FakeFetcher()
    fetcher.add(
        top_level,
        ok(page([comment("c1", 5)], next_token="tok2", total=1)),
        ok({"pagination": {}}),  # no "comments" key -> empty, not an error
    )

    result = await collect_comments(VIDEO_ID, pages=5, fetch=fetcher, sleep=sleeper)

    assert [c["id"] for c in result["comments"]] == ["c1"]
    assert result["status"] == COMPLETE  # empty is a normal end, not a failure
    assert result["total"] == 1
    assert result["threads"] == []
    # The empty page stopped paging: exactly two requests went out.
    assert len(fetcher.calls) == 2


async def test_first_page_429_then_retry_succeeds(sleeper):
    fetcher = FakeFetcher()
    fetcher.add(
        top_level,
        (429, "Too Many Requests"),
        ok(page([comment("c1", 5)], total=7)),
    )

    result = await collect_comments(VIDEO_ID, pages=2, fetch=fetcher, sleep=sleeper)

    assert result["status"] == COMPLETE
    assert result["total"] == 7
    assert [c["id"] for c in result["comments"]] == ["c1"]
    assert sleeper.delays == [1]  # one backoff before the successful retry
    assert len(fetcher.calls) == 2


async def test_rate_limit_retries_exhausted_keeps_nothing_but_records(sleeper):
    fetcher = FakeFetcher()
    fetcher.add(
        top_level,
        (429, "Too Many Requests"),
        (200, "concurrency_limit reached"),
        (429, "Too Many Requests"),
        (429, "Too Many Requests"),
    )

    result = await collect_comments(VIDEO_ID, pages=3, fetch=fetcher, sleep=sleeper)

    assert result["status"] == FAILED  # first page failed
    assert result["comments"] == []
    assert result["threads"] == []
    assert result["total"] is None
    # 1 initial attempt + 3 retries with 1/2/4s backoff, then rate_limited.
    assert len(fetcher.calls) == 4
    assert sleeper.delays == [1, 2, 4]


async def test_rate_limit_after_first_page_is_partial(sleeper):
    fetcher = FakeFetcher()
    fetcher.add(
        top_level,
        ok(page([comment("c1", 5)], next_token="tok2", total=9)),
        (429, "Too Many Requests"),
        (429, "Too Many Requests"),
        (429, "Too Many Requests"),
        (429, "Too Many Requests"),
    )

    result = await collect_comments(VIDEO_ID, pages=3, fetch=fetcher, sleep=sleeper)

    assert result["status"] == "partial"
    assert [c["id"] for c in result["comments"]] == ["c1"]  # page 1 kept
    assert result["total"] == 9
    assert len(fetcher.calls) == 5  # page 1 + 4 attempts on page 2


async def test_first_page_missing_data_key_is_empty(sleeper):
    fetcher = FakeFetcher()
    fetcher.add(top_level, ok({"pagination": {}}))  # no "comments" key at all

    result = await collect_comments(VIDEO_ID, pages=2, fetch=fetcher, sleep=sleeper)

    assert result["status"] == COMPLETE
    assert result["comments"] == []
    assert result["threads"] == []
    assert result["total"] is None
    assert len(fetcher.calls) == 1  # empty stops paging, no page 2 request


async def test_missing_api_key_raises_before_any_request(monkeypatch, sleeper):
    monkeypatch.delenv("HASDATA_API_KEY")
    fetcher = FakeFetcher()

    with pytest.raises(MissingApiKeyError):
        await collect_comments(VIDEO_ID, pages=1, fetch=fetcher, sleep=sleeper)

    assert fetcher.calls == []
