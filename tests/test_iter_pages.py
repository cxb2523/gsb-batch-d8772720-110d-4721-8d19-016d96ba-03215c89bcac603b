"""Offline tests for page-wise collection, failure isolation and resume runs.

Every network interaction is replaced by locally fabricated listing-page HTML,
so these tests never touch hqporner.com.
"""
from urllib.parse import parse_qs, quote_plus, urlsplit

import pytest
from unittest.mock import AsyncMock, patch

from hqporner_api import api
from hqporner_api.api import Client, PageStatus, Pagination
from hqporner_api.modules.consts import (
    root_brazzers,
    root_url,
    root_url_actress,
    root_url_category,
    root_url_top,
)


def _listing_html(page: int) -> str:
    """Two extractor-compatible video rows per page."""
    return "".join(
        '<div class="6u">'
        '<img data-src="/thumbs/{page}-{idx}.jpg">'
        '<h3 class="meta-data-title">'
        '<a href="/hdporn/{page}-{idx}.html">Video {page}-{idx}</a>'
        "</h3>"
        '<span class="fa-clock-o">10:0{idx}</span>'
        "</div>".format(page=page, idx=idx)
        for idx in (1, 2)
    )


@pytest.fixture
def client() -> Client:
    # Avoid creating a real curl session: iter_pages only needs a core object.
    bare = object.__new__(Client)
    bare.core = object()
    return bare


def _page_html_router(pages: dict[str, str], failing_urls: set[str] | None = None):
    """Return an AsyncMock serving fabricated HTML or raising on chosen URLs."""
    failing_urls = failing_urls or set()

    async def fake_get_html_content(core, url, is_second_attempt=False,
                                    is_mobile_fix=False, *, owner=None):
        if url in failing_urls:
            raise api.NetworkError(f"simulated failure for {url}")
        return False, pages[url]

    return AsyncMock(side_effect=fake_get_html_content)


def _capture_requested_urls(mock_: AsyncMock) -> list[str]:
    captured = []
    for call in mock_.await_args_list:
        captured.append(call.kwargs.get("url", call.args[1] if len(call.args) > 1 else None))
    return captured


# ---------------------------------------------------------------------------
# 1. Normal multi-page collection
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_iter_pages_normal_multi_page(client):
    urls = api.build_page_urls(
        f"{root_url_actress}anissa-kate", pagination=Pagination.PATH, pages=3
    )
    pages = {url: _listing_html(page) for page, url in enumerate(urls, start=1)}

    with patch.object(api, "get_html_content", _page_html_router(pages)) as fetch:
        results = [result async for result in client.iter_pages(urls)]

    assert [result.page for result in results] == [1, 2, 3]
    assert all(result.status is PageStatus.SUCCESS for result in results)
    assert all(result.error is None for result in results)
    assert all(result.ok for result in results)
    assert [len(result.videos) for result in results] == [2, 2, 2]

    first_video = results[0].videos[0]
    assert isinstance(first_video, api.Video)
    assert first_video.url == "https://hqporner.com/hdporn/1-1.html"
    assert first_video.title == "Video 1-1"
    assert first_video.thumbnail == "https://hqporner.com/thumbs/1-1.jpg"
    assert first_video.length == "10:01"
    assert _capture_requested_urls(fetch) == urls


@pytest.mark.asyncio
async def test_empty_successful_page_is_not_disguised_failure(client):
    url = f"{root_url_category}milf/2"
    pages = {url: "<h1>Some heading</h1>"}

    with patch.object(api, "get_html_content", _page_html_router(pages)):
        result = await anext(client.iter_pages([url]))

    assert result.status is PageStatus.SUCCESS
    assert result.videos == ()
    assert result.error is None


# ---------------------------------------------------------------------------
# 2. A failing page must not stop later pages and must not look like an empty page
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_iter_pages_failure_does_not_abort_following_pages(client):
    urls = api.build_page_urls(root_url_top.rstrip("/"), pagination=Pagination.PATH, pages=4)
    pages = {url: _listing_html(page) for page, url in enumerate(urls, start=1)}
    failing = {urls[1], urls[2]}

    fetch = _page_html_router(pages, failing_urls=failing)
    with patch.object(api, "get_html_content", fetch):
        results = [result async for result in client.iter_pages(urls)]

    assert [result.page for result in results] == [1, 2, 3, 4]
    statuses = {result.page: result.status for result in results}
    assert statuses == {
        1: PageStatus.SUCCESS,
        2: PageStatus.FAILED,
        3: PageStatus.FAILED,
        4: PageStatus.SUCCESS,
    }

    for page_number in (2, 3):
        failed = results[page_number - 1]
        assert isinstance(failed.error, api.NetworkError)
        assert failed.videos == ()  # failure is explicit, never faked as an empty page
        assert failed.url == urls[page_number - 1]

    assert results[3].ok and len(results[3].videos) == 2
    # Every page was attempted exactly once despite the mid-run failures.
    assert _capture_requested_urls(fetch) == urls

    report = api.PageReport(pages=tuple(results))
    assert report.failed_pages == {2, 3}
    assert report.succeeded_pages == {1, 4}
    assert report.next_resume_page == 2
    assert len(report.videos) == 4


# ---------------------------------------------------------------------------
# 3. Invalid start_page / pages are rejected before any network request
# ---------------------------------------------------------------------------
INVALID_PAGINATION = [0, -1]


@pytest.mark.parametrize("bad_value", INVALID_PAGINATION)
@pytest.mark.parametrize(
    "method,kwargs",
    [
        ("get_videos_by_actress", {"name": "anissa kate"}),
        ("get_videos_by_category", {"category": "milf"}),
        ("search_videos", {"query": "test"}),
        ("get_top_porn", {"sort_by": "week"}),
        ("get_brazzers_videos", {}),
    ],
)
def test_listing_methods_reject_invalid_pages_before_network(client, method, kwargs, bad_value):
    with patch.object(api, "get_html_content") as fetch:
        with pytest.raises(ValueError):
            getattr(client, method)(**kwargs, pages=bad_value)
        with pytest.raises(ValueError):
            getattr(client, method)(**kwargs, start_page=bad_value)
    fetch.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_value", INVALID_PAGINATION)
async def test_iter_pages_rejects_invalid_start_page_before_network(client, bad_value):
    with patch.object(api, "get_html_content") as fetch:
        with pytest.raises(ValueError):
            client.iter_pages(["https://hqporner.com/top"], start_page=bad_value)
    fetch.assert_not_called()


def test_iter_pages_rejects_invalid_url_entries_before_network(client):
    with patch.object(api, "get_html_content") as fetch:
        with pytest.raises(ValueError):
            client.iter_pages(["", "https://hqporner.com/top/2"])
    fetch.assert_not_called()


# ---------------------------------------------------------------------------
# 4. Resuming from the smallest failed page requests exactly the retry URL set
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_resume_from_failed_page_requests_only_remaining_urls(client):
    urls = api.build_page_urls(root_brazzers, pagination=Pagination.PATH, pages=4)
    pages = {url: _listing_html(page) for page, url in enumerate(urls, start=1)}

    # First run: pages 2 and 3 fail.
    first_fetch = _page_html_router(pages, failing_urls={urls[1], urls[2]})
    with patch.object(api, "get_html_content", first_fetch):
        first_report = await client.collect_pages(urls)

    assert first_report.failed_pages == {2, 3}
    resume_page = first_report.next_resume_page
    assert resume_page == 2

    # Resume run: start at the smallest failed page; pages 1 and 4 stay untouched.
    retry_urls = api.build_page_urls(
        root_brazzers, pagination=Pagination.PATH, pages=3, start_page=resume_page
    )
    assert retry_urls == urls[1:]
    retry_fetch = _page_html_router(
        {url: pages[url] for url in retry_urls}, failing_urls={retry_urls[1]}
    )
    with patch.object(api, "get_html_content", retry_fetch):
        retry_results = [result async for result in client.iter_pages(
            retry_urls, start_page=resume_page
        )]

    assert [result.page for result in retry_results] == [2, 3, 4]
    assert retry_results[0].ok and retry_results[2].ok
    assert retry_results[1].status is PageStatus.FAILED
    assert _capture_requested_urls(retry_fetch) == retry_urls

    # The resume run never requested the already successful first page.
    assert urls[0] not in _capture_requested_urls(retry_fetch)
    assert {result.page for result in retry_results if not result.ok} == {3}


# ---------------------------------------------------------------------------
# 5. URL construction: start_page mapping, path pagination and query escaping
# ---------------------------------------------------------------------------
def test_start_page_urls_use_path_and_query_pagination():
    # Path pagination: first requested URL carries the actual page number.
    path_urls = api.build_page_urls(
        f"{root_url_actress}anissa-kate", pagination=Pagination.PATH, pages=3, start_page=3
    )
    assert path_urls == [
        "https://hqporner.com/actress/anissa-kate/3",
        "https://hqporner.com/actress/anissa-kate/4",
        "https://hqporner.com/actress/anissa-kate/5",
    ]

    # Query pagination: the search term is percent-escaped and the page number
    # travels in the ``p`` query parameter.
    query = "a b&/# 日本"
    search_urls = api.build_page_urls(
        f"{root_url.rstrip('/')}?q={quote_plus(query)}",
        pagination=Pagination.QUERY,
        pages=2,
        start_page=2,
    )
    first = urlsplit(search_urls[0])
    params = parse_qs(first.query)
    assert params["q"] == [query]  # parse_qs reverses the percent escaping
    assert params["p"] == ["2"]
    assert quote_plus(query) in first.query
    assert parse_qs(urlsplit(search_urls[1]).query)["p"] == ["3"]


def test_listing_methods_forward_start_page_into_urls(client):
    with patch.object(Client, "_video_stream") as stream:
        client.get_videos_by_actress("anissa kate", pages=2, start_page=4)
        client.get_videos_by_category("milf", pages=2, start_page=4)
        client.search_videos("a b", pages=2, start_page=4)
        client.get_top_porn("week", pages=2, start_page=4)
        client.get_brazzers_videos(pages=2, start_page=4)

    actress_urls, category_urls, search_urls, top_urls, brazzers_urls = (
        call.args[0] for call in stream.call_args_list
    )
    assert actress_urls[0].endswith("/actress/anissa-kate/4")
    assert category_urls[0].endswith("/category/milf/4")
    assert top_urls[0].endswith("/top/week/4")
    assert brazzers_urls[0].endswith("/free-brazzers-videos/4")
    search_params = parse_qs(urlsplit(search_urls[0]).query)
    assert search_params["p"] == ["4"]
    assert search_params["q"] == ["a b"]
    assert "q=a+b" in urlsplit(search_urls[0]).query


@pytest.mark.parametrize("raw_query", ["a&b/# 日本", "nancy a"])
def test_search_videos_escapes_query_before_building_urls(client, raw_query):
    with patch.object(Client, "_video_stream") as stream:
        client.search_videos(raw_query, pages=1)
    search_url = stream.call_args.args[0][0]
    assert parse_qs(urlsplit(search_url).query)["q"] == [raw_query]
    # Reserved characters must be percent-encoded, never injected raw into the URL.
    assert quote_plus(raw_query) in urlsplit(search_url).query


@pytest.mark.asyncio
async def test_collect_pages_aggregates_report(client):
    urls = api.build_page_urls(root_url_top.rstrip("/"), pagination=Pagination.PATH, pages=2)
    pages = {url: _listing_html(page) for page, url in enumerate(urls, start=1)}
    with patch.object(api, "get_html_content", _page_html_router(pages)):
        report = await client.collect_pages(urls)

    assert report.succeeded_pages == {1, 2}
    assert report.failed_pages == set()
    assert report.next_resume_page is None
    assert len(report.videos) == 4
