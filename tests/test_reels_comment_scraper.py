"""Offline tests for the resumable Reels comment scraper example.

No network, no credentials: every test injects a fake Instagram client whose
``comment.list`` serves locally constructed responses keyed by ``min_id``.
"""
from __future__ import annotations

from examples import reels_comment_scraper as scraper
from instagramflow.modules.media import MediaModule


class FakeResponse:
    def __init__(self, payload=None, error: Exception | None = None):
        self.payload = payload
        self.error = error


class FakeCommentModule:
    """Serves scripted responses and records the cursor sequence."""

    def __init__(self, responses):
        # Responses are consumed in request order; the key is informational.
        self._responses = list(responses)
        self.calls: list[tuple[int, str | None]] = []

    def list(self, media_id, min_id=None):
        self.calls.append((media_id, min_id))
        if not self._responses:
            raise AssertionError(
                f"unexpected extra page request (min_id={min_id!r})"
            )
        response = self._responses.pop(0)
        if response.error is not None:
            raise response.error
        return response.payload


class FakeMediaModule:
    pk_from_code = staticmethod(MediaModule.pk_from_code)

    def info(self, media_id):
        return {
            "items": [
                {"pk": media_id, "caption": {"text": "viral reel caption"}}
            ]
        }


class FakeIG:
    def __init__(self, responses):
        self.comment = FakeCommentModule(responses)
        self.media = FakeMediaModule()
        self.closed = False

    def close(self):
        self.closed = True


def comment(pk, username="alice", text="nice", likes=1):
    return {
        "pk": pk,
        "text": text,
        "comment_like_count": likes,
        "user": {"username": username, "full_name": username.title()},
    }


def test_multi_page_walk_passes_next_min_id_and_reports_success_pages():
    ig = FakeIG(
        [
            FakeResponse(
                {
                    "comments": [comment(1, "alice"), comment(2, "bob")],
                    "next_min_id": "cursor-b",
                }
            ),
            FakeResponse(
                {
                    "comments": [comment(3, "carol")],
                    "next_min_id": "cursor-c",
                }
            ),
            FakeResponse({"comments": [comment(4, "dave")]}),
        ]
    )

    result = scraper.scrape_leads_from_post(
        "CGgDsi7JQdS", ig=ig, verbose=False
    )

    # Cursor from each page is fed into the very next request, in order.
    assert [call[1] for call in ig.comment.calls] == [None, "cursor-b", "cursor-c"]
    assert all(call[0] == MediaModule.pk_from_code("CGgDsi7JQdS") for call in ig.comment.calls)

    assert [lead["username"] for lead in result.leads] == [
        "alice",
        "bob",
        "carol",
        "dave",
    ]
    assert [page.status for page in result.pages] == [
        scraper.PAGE_SUCCESS,
        scraper.PAGE_SUCCESS,
        scraper.PAGE_SUCCESS,
    ]
    assert [page.new_items for page in result.pages] == [2, 1, 1]
    assert [page.next_min_id for page in result.pages] == [
        "cursor-b",
        "cursor-c",
        None,
    ]
    assert result.last_cursor is None
    assert result.stop_reason == "complete"
    assert ig.closed is False  # caller-owned client must not be closed


def test_url_is_reduced_to_shortcode_for_pk_conversion():
    ig = FakeIG([FakeResponse({"comments": []})])

    result = scraper.scrape_leads_from_post(
        "https://www.instagram.com/reel/CGgDsi7JQdS/?utm_source=ig_web/",
        ig=ig,
        verbose=False,
    )

    assert result.media_pk == MediaModule.pk_from_code("CGgDsi7JQdS")
    assert ig.comment.calls == [(result.media_pk, None)]


def test_empty_page_is_recorded_and_stops_the_walk():
    ig = FakeIG([FakeResponse({"comments": [], "next_min_id": None})])

    result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)

    assert len(result.pages) == 1
    page = result.pages[0]
    assert page.status == scraper.PAGE_EMPTY
    assert page.items_received == 0
    assert page.new_items == 0
    assert result.leads == []
    assert result.stop_reason == "empty"
    assert len(ig.comment.calls) == 1


def test_request_failure_keeps_error_and_retry_cursor():
    ig = FakeIG(
        [
            FakeResponse(
                {"comments": [comment(1)], "next_min_id": "cursor-b"}
            ),
            FakeResponse(error=RuntimeError("signing server unreachable")),
        ]
    )

    result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)

    assert [page.status for page in result.pages] == [
        scraper.PAGE_SUCCESS,
        scraper.PAGE_FAILED,
    ]
    failed = result.pages[-1]
    assert failed.page == 2
    assert failed.request_min_id == "cursor-b"
    assert failed.error is not None
    assert "RuntimeError" in failed.error
    assert "signing server unreachable" in failed.error
    assert failed.new_items == 0

    # The failed page's own request cursor is the resume point.
    assert result.last_cursor == "cursor-b"
    assert result.stop_reason == "failed"
    assert [lead["pk"] for lead in result.leads] == ["1"]


def test_cursor_that_does_not_advance_is_flagged_and_stops_looping():
    ig = FakeIG(
        [
            FakeResponse(
                {"comments": [comment(1)], "next_min_id": "cursor-b"}
            ),
            FakeResponse(
                {"comments": [comment(2, "bob")], "next_min_id": "cursor-b"}
            ),
        ]
    )

    result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)

    # Exactly two requests: the repeated cursor is detected, not followed.
    assert [call[1] for call in ig.comment.calls] == [None, "cursor-b"]
    stalled = result.pages[-1]
    assert stalled.status == scraper.PAGE_CURSOR_STALLED
    assert stalled.request_min_id == "cursor-b"
    assert stalled.next_min_id == "cursor-b"
    assert stalled.error is not None
    assert stalled.new_items == 1
    assert result.stop_reason == "cursor_stalled"
    assert result.last_cursor == "cursor-b"


def test_duplicate_pks_are_skipped_but_counted_in_page_outcome():
    duplicate = comment(1, "alice")
    ig = FakeIG(
        [
            FakeResponse(
                {
                    "comments": [duplicate, comment(2, "bob")],
                    "next_min_id": "cursor-b",
                }
            ),
            FakeResponse(
                {
                    # Comment 1 also comes back on page 2; comment 2 repeats
                    # within the same page.
                    "comments": [comment(1, "alice"), comment(2, "bob"), comment(3, "carol")],
                    "next_min_id": "cursor-c",
                }
            ),
            FakeResponse({"comments": []}),
        ]
    )

    result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)

    assert [lead["pk"] for lead in result.leads] == ["1", "2", "3"]
    first, second, third = result.pages
    assert first.items_received == 2
    assert first.new_items == 2
    assert first.duplicate_items == 0

    assert second.items_received == 3
    assert second.new_items == 1
    assert second.duplicate_items == 2
    assert second.status == scraper.PAGE_SUCCESS

    assert third.status == scraper.PAGE_EMPTY


def test_missing_user_and_text_use_placeholders_without_crashing_page():
    ig = FakeIG(
        [
            FakeResponse(
                {
                    "comments": [
                        comment(1, "alice", "great"),
                        {"pk": 2, "comment_like_count": 0},  # no user, no text
                        {"pk": 3, "user": {"username": "bob"}, "text": None},
                        "not-a-dict",
                    ],
                    "next_min_id": "cursor-b",
                }
            ),
            FakeResponse({"comments": []}),
        ]
    )

    result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)

    page = result.pages[0]
    assert page.status == scraper.PAGE_SUCCESS
    assert page.items_received == 4
    assert page.new_items == 3
    assert page.malformed_items == 1
    assert page.missing_user == 1
    assert page.missing_text == 2

    by_pk = {lead["pk"]: lead for lead in result.leads}
    assert by_pk["1"]["username"] == "alice"
    assert by_pk["2"]["username"] == scraper.MISSING_USER_PLACEHOLDER
    assert by_pk["2"]["comment"] == scraper.MISSING_TEXT_PLACEHOLDER
    assert by_pk["2"]["user_missing"] is True
    assert by_pk["3"]["username"] == "bob"
    assert by_pk["3"]["comment"] == scraper.MISSING_TEXT_PLACEHOLDER
    assert by_pk["3"]["text_missing"] is True
    assert result.leads[0]["like_count"] == 1


def test_resume_from_breakpoint_skips_collected_pages_and_dedupes():
    first_run = FakeIG(
        [
            FakeResponse(
                {
                    "comments": [comment(1, "alice"), comment(2, "bob")],
                    "next_min_id": "cursor-b",
                }
            ),
            FakeResponse(error=TimeoutError("read timed out")),
        ]
    )
    partial = scraper.scrape_leads_from_post(
        "CGgDsi7JQdS", ig=first_run, verbose=False
    )
    assert partial.stop_reason == "failed"
    assert partial.last_cursor == "cursor-b"
    assert partial.seen_pks == ["1", "2"]

    # Resume: begin at the failed page's cursor, carrying known pks forward.
    second_run = FakeIG(
        [
            FakeResponse(
                {
                    "comments": [
                        comment(1, "alice"),  # re-served by the API
                        comment(3, "carol"),
                    ],
                    "next_min_id": "cursor-c",
                }
            ),
            FakeResponse({"comments": [comment(4, "dave")]}),
        ]
    )
    resumed = scraper.scrape_leads_from_post(
        "CGgDsi7JQdS",
        ig=second_run,
        start_cursor=partial.last_cursor,
        seen_pks=partial.seen_pks,
        verbose=False,
    )

    assert second_run.comment.calls[0][1] == "cursor-b"
    assert [lead["pk"] for lead in resumed.leads] == ["3", "4"]
    assert resumed.pages[0].duplicate_items == 1
    assert resumed.pages[0].new_items == 1
    assert resumed.stop_reason == "complete"
    assert resumed.last_cursor is None
    assert resumed.seen_pks == ["1", "2", "3", "4"]


def test_malformed_payloads_are_recorded_as_failed_pages():
    for payload in ([], {"comments": "oops"}, {"comments": None, "next_min_id": None}):
        ig = FakeIG([FakeResponse(payload)])
        result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)
        page = result.pages[0]
        if payload == {"comments": None, "next_min_id": None}:
            # Explicit null comments is treated as an empty page, not an error.
            assert page.status == scraper.PAGE_EMPTY
        else:
            assert page.status == scraper.PAGE_FAILED
            assert page.error


def test_max_pages_stops_with_resume_cursor():
    ig = FakeIG(
        [
            FakeResponse(
                {"comments": [comment(1)], "next_min_id": "cursor-b"}
            ),
            FakeResponse(
                {"comments": [comment(2)], "next_min_id": "cursor-c"}
            ),
        ]
    )

    result = scraper.scrape_leads_from_post(
        "CGgDsi7JQdS", ig=ig, max_pages=2, verbose=False
    )

    assert [call[1] for call in ig.comment.calls] == [None, "cursor-b"]
    assert len(result.leads) == 2
    assert result.stop_reason == "max_pages"
    assert result.last_cursor == "cursor-c"


def test_to_dict_is_json_serialisable_and_contains_resume_state():
    ig = FakeIG([FakeResponse({"comments": [], "next_min_id": "cursor-b"})])
    result = scraper.scrape_leads_from_post("CGgDsi7JQdS", ig=ig, verbose=False)

    payload = result.to_dict()

    import json

    encoded = json.dumps(payload)
    assert '"last_cursor": "cursor-b"' in encoded
    assert payload["pages"][0]["status"] == scraper.PAGE_EMPTY
    assert payload["stop_reason"] == "empty"
