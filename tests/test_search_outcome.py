"""Offline unit tests for the observable ending of ``Client.search``.

Both network-facing collaborators (``_post`` and ``scrape_stream``) are
mocked, so no real HTTP traffic or event-loop networking is required.
"""

import asyncio

import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from missav_api import api


class OutcomeRecorder:
    """Records every SearchOutcome callback invocation."""

    def __init__(self):
        self.outcomes: list[api.SearchOutcome] = []

    def __call__(self, outcome: api.SearchOutcome) -> None:
        self.outcomes.append(outcome)

    @property
    def calls(self) -> int:
        return len(self.outcomes)


class _Boom(Exception):
    pass


def _make_client() -> api.Client:
    # Bypass Client.__init__: no BaseCore/session is needed because _post and
    # scrape_stream are replaced with mocks.
    client = object.__new__(api.Client)
    client.core = object()
    return client


def _streaming_source(items, closed=None):
    async def source():
        try:
            for item in items:
                yield item
        finally:
            if closed is not None:
                closed.append(True)

    return source


@pytest.mark.asyncio
async def test_search_empty_upstream_reports_empty_without_scraping():
    client = _make_client()
    recorder = OutcomeRecorder()
    post = AsyncMock(return_value={"recomms": []})

    with (
        patch.object(api, "_post", post),
        patch.object(api, "scrape_stream") as stream_factory,
    ):
        results = [
            result
            async for result in client.search("nothing", video_count=3, on_outcome=recorder)
        ]

    assert results == []
    post.assert_awaited_once()
    # An empty upstream answer must never start the scraping stream.
    stream_factory.assert_not_called()
    assert recorder.calls == 1
    outcome = recorder.outcomes[0]
    assert isinstance(outcome, api.SearchOutcome)
    assert outcome.status == "empty"
    assert outcome.query == "nothing"
    assert outcome.requested_count == 3
    assert outcome.yielded_count == 0


@pytest.mark.asyncio
async def test_search_full_consumption_reports_completed():
    client = _make_client()
    recorder = OutcomeRecorder()
    items = [SimpleNamespace(succeeded=True) for _ in range(3)]
    post = AsyncMock(return_value={"recomms": [{"id": "a"}, {"id": "b"}]})

    with (
        patch.object(api, "_post", post),
        patch.object(
            api, "scrape_stream", side_effect=lambda **kwargs: _streaming_source(items)()
        ),
    ):
        results = [
            result
            async for result in client.search("query", video_count=2, on_outcome=recorder)
        ]

    assert results == items
    post.assert_awaited_once()
    assert recorder.calls == 1
    outcome = recorder.outcomes[0]
    assert outcome.status == "completed"
    assert outcome.query == "query"
    assert outcome.requested_count == 2
    assert outcome.yielded_count == 3


@pytest.mark.asyncio
async def test_search_early_aclose_reports_aborted_and_runs_stream_finally():
    client = _make_client()
    recorder = OutcomeRecorder()
    closed: list[bool] = []

    with (
        patch.object(
            api, "_post", AsyncMock(return_value={"recomms": [{"id": "x"}]})
        ),
        patch.object(
            api,
            "scrape_stream",
            side_effect=lambda **kwargs: _streaming_source(
                [SimpleNamespace(succeeded=True), SimpleNamespace(succeeded=True)], closed
            )(),
        ),
    ):
        stream = client.search("query", video_count=1, on_outcome=recorder)
        first = await anext(stream)
        assert first.succeeded is True
        await stream.aclose()
        # Closing an already-closed generator must be a no-op, not a second
        # callback.
        await stream.aclose()

    # The aclosing cleanup path drove the underlying stream's finally block.
    assert closed == [True]
    assert recorder.calls == 1
    outcome = recorder.outcomes[0]
    assert outcome.status == "aborted"
    assert outcome.query == "query"
    assert outcome.requested_count == 1
    assert outcome.yielded_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [0, -1])
async def test_search_invalid_count_raises_before_any_request_or_callback(count):
    client = _make_client()
    recorder = OutcomeRecorder()

    with (
        patch.object(api, "_post", new_callable=AsyncMock) as post,
        patch.object(api, "scrape_stream") as stream_factory,
    ):
        with pytest.raises(ValueError):
            async for _ in client.search("query", video_count=count, on_outcome=recorder):
                pass

    post.assert_not_awaited()
    stream_factory.assert_not_called()
    assert recorder.calls == 0


@pytest.mark.asyncio
async def test_search_break_from_async_for_reports_aborted_on_finalization():
    # ``break`` does not close the generator synchronously: the running event
    # loop keeps it in its async-gen registry and finalizes it at shutdown. That
    # lazy finalization must take the same aclosing -> GeneratorExit path as an
    # explicit aclose().
    client = _make_client()
    recorder = OutcomeRecorder()
    closed: list[bool] = []

    with (
        patch.object(
            api, "_post", AsyncMock(return_value={"recomms": [{"id": "x"}]})
        ),
        patch.object(
            api,
            "scrape_stream",
            side_effect=lambda **kwargs: _streaming_source(
                [SimpleNamespace(succeeded=True), SimpleNamespace(succeeded=True)], closed
            )(),
        ),
    ):
        async for _ in client.search("query", video_count=1, on_outcome=recorder):
            break
        # Drive the loop's own lazy async-generator finalization explicitly.
        loop = asyncio.get_running_loop()
        await loop.shutdown_asyncgens()

    assert closed == [True]
    assert recorder.calls == 1
    outcome = recorder.outcomes[0]
    assert outcome.status == "aborted"
    assert outcome.yielded_count == 1


@pytest.mark.asyncio
async def test_search_callback_exception_on_abort_propagates_after_cleanup():
    client = _make_client()
    closed: list[bool] = []

    def boom(outcome: api.SearchOutcome) -> None:
        raise _Boom(outcome.status)

    with (
        patch.object(
            api, "_post", AsyncMock(return_value={"recomms": [{"id": "x"}]})
        ),
        patch.object(
            api,
            "scrape_stream",
            side_effect=lambda **kwargs: _streaming_source(
                [SimpleNamespace(succeeded=True)], closed
            )(),
        ),
    ):
        stream = client.search("query", video_count=1, on_outcome=boom)
        await anext(stream)
        # The callback's exception must surface instead of being swallowed.
        with pytest.raises(_Boom):
            await stream.aclose()

    # Cleanup still happened before the callback error escaped.
    assert closed == [True]


@pytest.mark.asyncio
async def test_search_callback_exception_on_completion_propagates():
    client = _make_client()

    def boom(outcome: api.SearchOutcome) -> None:
        raise _Boom(outcome.status)

    with (
        patch.object(
            api, "_post", AsyncMock(return_value={"recomms": [{"id": "x"}]})
        ),
        patch.object(
            api,
            "scrape_stream",
            side_effect=lambda **kwargs: _streaming_source(
                [SimpleNamespace(succeeded=True)]
            )(),
        ),
    ):
        with pytest.raises(_Boom):
            async for _ in client.search("query", video_count=1, on_outcome=boom):
                pass


@pytest.mark.asyncio
async def test_search_without_callback_keeps_original_streaming_behavior():
    client = _make_client()
    closed: list[bool] = []

    with (
        patch.object(
            api, "_post", AsyncMock(return_value={"recomms": [{"id": "x"}]})
        ),
        patch.object(
            api,
            "scrape_stream",
            side_effect=lambda **kwargs: _streaming_source(
                [SimpleNamespace(succeeded=True)], closed
            )(),
        ),
    ):
        results = [result async for result in client.search("query", video_count=1)]

    assert len(results) == 1
    assert closed == [True]
