"""Tests for the WebProvider (target → DownloadItem)."""

from __future__ import annotations

import pytest

from da_downloader.api import ActionType
from da_downloader.errors import MediaUnavailableError
from da_downloader.errors import NetworkError
from da_downloader.models import Deviation, DownloadItem
from da_downloader.provider import CompositeProvider, WebProvider
from da_downloader.targets import TargetParser


def make_deviation(identifier="123", title="Art", author="alice", mature=False) -> Deviation:
    return Deviation(
        deviation_id=identifier,
        title=title,
        url=f"https://www.deviantart.com/{author}/art/{title}-{identifier}",
        author=author,
        media={
            "baseUri": f"https://images.test/{identifier}.jpg",
            "prettyName": title.lower(),
            "token": ["token"],
            "types": [{"t": "fullview", "c": "/f/<prettyName>.jpg"}],
        },
        is_downloadable=False,
        is_mature=mature,
        deviation_type="image",
    )


class FakeAPI:
    def __init__(self, pages=None) -> None:
        self.pages = list(pages or [])
        self.fetch_calls: list[tuple] = []
        self.build_calls: list[tuple] = []
        self.media_urls: dict[str, str] = {}

    def get_csrf_token(self, username=""):
        return "csrf"

    def build_api_url(self, action, username, query=None, folder_id=None):
        self.build_calls.append((action, username, query, folder_id))
        return "URL?offset=<OFFSET>&limit=<LIMIT>"

    def fetch_deviations(self, url, offset=0, cursor=""):
        self.fetch_calls.append((offset, cursor))
        entry = self.pages.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        return entry

    def get_download_url(self, deviation, quality):
        return self.media_urls.get(deviation.deviation_id)


def make_provider(pages, media_urls=None, quality="f") -> WebProvider:
    api = FakeAPI(pages=pages)
    api.media_urls = media_urls or {}
    return WebProvider(api, quality=quality)


def test_gallery_yields_items_with_media_url_and_extension() -> None:
    dev = make_deviation()
    provider = make_provider(
        pages=[([dev], False, 1, "")],
        media_urls={"123": "https://images.test/123.png"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert len(items) == 1
    assert items[0].artwork_id == "123"
    assert items[0].author == "alice"
    assert items[0].media_url == "https://images.test/123.png"
    assert items[0].extension == "png"


def test_blurred_non_mature_item_is_skipped() -> None:
    dev = make_deviation()
    provider = make_provider(
        pages=[([dev], False, 1, "")],
        media_urls={"123": "https://images.test/blur_40/123.jpg"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert items == []


def test_premium_locked_item_is_skipped() -> None:
    dev = make_deviation()
    dev.premium = True
    provider = make_provider(
        pages=[([dev], False, 1, "")],
        media_urls={"123": "https://images.test/123.jpg"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert items == []


def test_pagination_across_two_pages() -> None:
    first = make_deviation("1")
    second = make_deviation("2")
    provider = make_provider(
        pages=[([first], True, 24, ""), ([second], False, 48, "")],
        media_urls={"1": "https://images.test/1.jpg", "2": "https://images.test/2.jpg"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert [i.artwork_id for i in items] == ["1", "2"]
    assert len(provider.api.fetch_calls) == 2


def test_artwork_target_requires_official_api() -> None:
    provider = make_provider(pages=[])
    with pytest.raises(MediaUnavailableError):
        list(provider.resolve(TargetParser.parse("https://www.deviantart.com/a/art/x-123")))


def test_tag_target_requires_official_api() -> None:
    provider = make_provider(pages=[])
    with pytest.raises(MediaUnavailableError):
        list(provider.resolve(TargetParser.parse("https://www.deviantart.com/tag/landscape")))


def test_original_quality_falls_back_to_full() -> None:
    dev = make_deviation()

    class FallbackAPI(FakeAPI):
        def get_download_url(self, deviation, quality):
            return "https://images.test/123.jpg" if quality == "f" else None

    provider = WebProvider(FallbackAPI(pages=[([dev], False, 1, "")]), quality="o")

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert items[0].media_url == "https://images.test/123.jpg"


def test_search_target_builds_search_action() -> None:
    dev = make_deviation()
    provider = make_provider(
        pages=[([dev], False, 1, "")], media_urls={"123": "https://images.test/123.jpg"}
    )

    list(provider.resolve(TargetParser.parse("https://www.deviantart.com/search?q=digital+art")))

    action, username, query, folder = provider.api.build_calls[0]
    assert action == ActionType.SEARCH
    assert query == "digital art"


class RecordingProvider:
    def __init__(self, items=None, error=None):
        self.items = list(items or [])
        self.error = error
        self.calls = []

    def resolve(self, target):
        self.calls.append(target)
        if self.error:
            raise self.error
        yield from self.items


def test_composite_search_routes_to_web_even_with_official() -> None:
    web = make_provider(
        pages=[([make_deviation()], False, 1, "")],
        media_urls={"123": "https://images.test/123.jpg"},
    )
    official = RecordingProvider(items=[])
    router = CompositeProvider(official=official, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/search?q=cat")))

    assert len(items) == 1
    assert items[0].artwork_id == "123"
    assert official.calls == []
    assert len(web.api.build_calls) == 1


def test_composite_artwork_routes_to_official() -> None:
    official = RecordingProvider(items=[DownloadItem("u1", "https://da.test/x-1", "A", "alice", "https://img.test/1.jpg")])
    web = RecordingProvider(items=[])
    router = CompositeProvider(official=official, web=web)

    list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/art/x-123456")))

    assert len(official.calls) == 1
    assert web.calls == []


def test_composite_gallery_prefers_official() -> None:
    official = RecordingProvider(items=[DownloadItem("u1", "https://da.test/1", "A", "alice", "https://img.test/1.jpg")])
    web = RecordingProvider(items=[])
    router = CompositeProvider(official=official, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert len(items) == 1
    assert len(official.calls) == 1
    assert web.calls == []


def test_composite_gallery_falls_back_to_web_when_official_unavailable() -> None:
    web = make_provider(
        pages=[([make_deviation()], False, 1, "")],
        media_urls={"123": "https://images.test/123.jpg"},
    )
    official = RecordingProvider(error=MediaUnavailableError("nope"))
    router = CompositeProvider(official=official, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert items[0].artwork_id == "123"
    assert len(official.calls) == 1
    assert len(web.api.build_calls) == 1


def test_composite_gallery_falls_back_to_web_when_official_network_fails() -> None:
    web = make_provider(
        pages=[([make_deviation()], False, 1, "")],
        media_urls={"123": "https://images.test/123.jpg"},
    )
    official = RecordingProvider(error=NetworkError("API down"))
    router = CompositeProvider(official=official, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert items[0].artwork_id == "123"


def test_composite_gallery_with_only_web_uses_web() -> None:
    web = make_provider(
        pages=[([make_deviation()], False, 1, "")],
        media_urls={"123": "https://images.test/123.jpg"},
    )
    router = CompositeProvider(official=None, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert items[0].artwork_id == "123"


def test_composite_tag_without_official_requires_official() -> None:
    web = RecordingProvider(items=[])
    router = CompositeProvider(official=None, web=web)
    with pytest.raises(MediaUnavailableError):
        list(router.resolve(TargetParser.parse("https://www.deviantart.com/tag/landscape")))


def test_literature_item_is_delivered_as_inline_text() -> None:
    dev = make_deviation("123", title="Story")
    dev.deviation_type = "literature"
    dev.media = {}
    dev.text_content = {
        "html": {"markup": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Chapter one\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Chapter two\"}]}]}"}
    }
    provider = make_provider(pages=[([dev], False, 1, "")])

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert len(items) == 1
    assert items[0].content == "Chapter one\nChapter two"
    assert items[0].media_url == ""
    assert items[0].extension == "txt"
    assert items[0].metadata == {"kind": "literature"}


# --- per-page outcomes -------------------------------------------------------


def test_web_pages_record_success_outcomes_that_sum_to_items() -> None:
    devs = [make_deviation("1"), make_deviation("2"), make_deviation("3")]
    provider = make_provider(
        pages=[([devs[0], devs[1]], True, 24, ""), ([devs[2]], False, 48, "")],
        media_urls={d.deviation_id: f"https://images.test/{d.deviation_id}.jpg" for d in devs},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert [i.artwork_id for i in items] == ["1", "2", "3"]
    assert [(o.page, o.item_count, o.status) for o in provider.page_outcomes] == [
        (1, 2, "success"),
        (2, 1, "success"),
    ]
    assert len(provider.page_outcomes) == len(provider.api.fetch_calls)
    assert sum(o.item_count for o in provider.page_outcomes) == len(items)


def test_web_failed_page_keeps_earlier_items_and_ends_collection() -> None:
    provider = make_provider(
        pages=[([make_deviation("1"), make_deviation("2")], True, 24, ""),
               NetworkError("API down at page 2")],
        media_urls={"1": "https://images.test/1.jpg", "2": "https://images.test/2.jpg"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    # 已产出的作品照常交付，失败页不静默跳过、也不再翻第 3 页。
    assert [i.artwork_id for i in items] == ["1", "2"]
    assert len(provider.api.fetch_calls) == 2
    assert [(o.page, o.item_count, o.status) for o in provider.page_outcomes] == [
        (1, 2, "success"),
        (2, 0, "failed"),
    ]
    assert provider.page_outcomes[1].reason == "API down at page 2"
    assert sum(o.item_count for o in provider.page_outcomes) == len(items)


def test_web_non_advancing_pagination_is_its_own_status() -> None:
    # 第 2 页返回与第 1 页相同的 offset/cursor（has_more=True）：必须终止，
    # 且最后一页结局是 not_advanced，而不是成功页。
    provider = make_provider(
        pages=[([make_deviation("1")], True, 0, ""), ([make_deviation("2")], True, 0, "")],
        media_urls={"1": "https://images.test/1.jpg", "2": "https://images.test/2.jpg"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    # 第 1 页已提示还有内容，但下一次 offset/cursor 与第 1 页重复：第 2 页
    # 不再请求，结局记录为 not_advanced 并终止采集。
    assert [i.artwork_id for i in items] == ["1"]
    assert len(provider.api.fetch_calls) == 1
    assert [(o.page, o.item_count, o.status) for o in provider.page_outcomes] == [
        (1, 1, "success"),
        (2, 0, "not_advanced"),
    ]
    assert provider.page_outcomes[-1].reason is not None
    assert "did not advance" in provider.page_outcomes[-1].reason


def test_downloader_exposes_web_page_outcomes_after_download(tmp_path) -> None:
    from da_downloader.download import Downloader
    from da_downloader.manager import DownloadManager
    from da_downloader.path import PathFormatter

    class FakeDownloader:
        def download(self, url, destination, *, overwrite=False, headers=None, timeout=None):
            from da_downloader.http import TransferResult
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"data")
            return TransferResult(destination, 4)

    provider = make_provider(
        pages=[([make_deviation("1")], True, 24, ""), NetworkError("boom")],
        media_urls={"1": "https://images.test/1.jpg"},
    )
    downloader = Downloader(
        provider,
        DownloadManager(downloader=FakeDownloader(), formatter=PathFormatter(tmp_path)),
    )

    outcomes = downloader.download("https://www.deviantart.com/alice/gallery")

    assert len(outcomes) == 1  # 已取作品仍被下载
    assert outcomes[0].status == "downloaded"
    assert [(o.page, o.item_count, o.status) for o in downloader.page_outcomes] == [
        (1, 1, "success"),
        (2, 0, "failed"),
    ]
    assert downloader.page_outcomes[1].reason == "boom"


def test_downloader_exposes_page_outcomes_after_resolve() -> None:
    from da_downloader.download import Downloader

    provider = make_provider(
        pages=[([make_deviation("1"), make_deviation("2")], False, 24, "")],
        media_urls={"1": "https://images.test/1.jpg", "2": "https://images.test/2.jpg"},
    )
    downloader = Downloader(provider, manager=None)

    works = downloader.resolve("https://www.deviantart.com/alice/gallery")

    assert len(works) == 2
    assert [(o.page, o.item_count, o.status) for o in downloader.page_outcomes] == [
        (1, 2, "success")
    ]


def test_downloader_flushes_page_outcomes_even_if_provider_raises(tmp_path) -> None:
    from da_downloader.download import Downloader
    from da_downloader.manager import DownloadManager
    from da_downloader.path import PathFormatter

    class PartlyFailingProvider:
        page_outcomes = []

        def resolve(self, target):
            from da_downloader.models import PageOutcome

            yield make_item()
            # The provider records the failure, then still surfaces it: the
            # facade must publish the trail and keep the already-produced item.
            self.page_outcomes.append(PageOutcome(1, 0, "failed", "stream died"))
            raise NetworkError("stream died mid-run")

    def make_item():
        from da_downloader.models import DownloadItem

        return DownloadItem("1", "https://da.test/1", "A", "alice", "https://img.test/1.jpg", "jpg")

    class OkDownloader:
        def download(self, url, destination, *, overwrite=False, headers=None, timeout=None):
            from da_downloader.http import TransferResult

            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"data")
            return TransferResult(destination, 4)

    downloader = Downloader(
        PartlyFailingProvider(),
        DownloadManager(downloader=OkDownloader(), formatter=PathFormatter(tmp_path)),
    )

    with pytest.raises(NetworkError):
        downloader.download("https://www.deviantart.com/alice/gallery")

    assert [(o.page, o.status) for o in downloader.page_outcomes] == [(1, "failed")]


def test_composite_forwards_web_page_outcomes_when_it_falls_back() -> None:
    web = make_provider(
        pages=[([make_deviation("1")], True, 24, ""), NetworkError("web page 2 down")],
        media_urls={"1": "https://images.test/1.jpg"},
    )
    official = RecordingProvider(error=MediaUnavailableError("no oauth"))
    router = CompositeProvider(official=official, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert [i.artwork_id for i in items] == ["1"]
    assert [(o.page, o.item_count, o.status) for o in router.page_outcomes] == [
        (1, 1, "success"),
        (2, 0, "failed"),
    ]
    assert router.page_outcomes[1].reason == "web page 2 down"


def test_composite_retries_web_when_official_first_page_fails() -> None:
    class FailingOfficial:
        page_outcomes: list = []

        def resolve(self, target):
            from da_downloader.models import PageOutcome

            self.page_outcomes.append(PageOutcome(1, 0, "failed", "official 500"))
            return iter(())

    web = make_provider(
        pages=[([make_deviation("1")], False, 1, "")],
        media_urls={"1": "https://images.test/1.jpg"},
    )
    official = FailingOfficial()
    router = CompositeProvider(official=official, web=web)

    items = list(router.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert [i.artwork_id for i in items] == ["1"]
    assert [(o.page, o.status) for o in router.page_outcomes] == [(1, "success")]


def test_web_page_item_count_excludes_skipped_works() -> None:
    keep = make_deviation("1")
    skipped = make_deviation("2")
    provider = make_provider(
        pages=[([keep, skipped], False, 24, "")],
        media_urls={"1": "https://images.test/1.jpg", "2": "https://images.test/blur_40/2.jpg"},
    )

    items = list(provider.resolve(TargetParser.parse("https://www.deviantart.com/alice/gallery")))

    assert [i.artwork_id for i in items] == ["1"]
    assert provider.page_outcomes[0].item_count == 1
    assert sum(o.item_count for o in provider.page_outcomes) == len(items)


def test_page_outcome_normalizes_status_aliases() -> None:
    from da_downloader.models import PageOutcome, PageStatus

    ok = PageOutcome(1, 3, PageStatus.SUCCESS)
    failed = PageOutcome(2, 0, "error", "boom")
    stalled = PageOutcome(3, 0, "stalled", "no advance")

    assert ok.status == "success" and ok.succeeded
    assert failed.status == "failed" and failed.failed and failed.reason == "boom"
    assert stalled.status == "not_advanced" and stalled.not_advanced
    assert stalled.status == PageStatus.NOT_ADVANCED
    assert ok.to_dict() == {"page": 1, "items": 3, "status": "success"}
    assert failed.to_dict() == {"page": 2, "items": 0, "status": "failed", "reason": "boom"}

