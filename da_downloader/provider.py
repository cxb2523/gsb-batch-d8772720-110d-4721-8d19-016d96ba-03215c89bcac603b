"""Provider layer: turn a ``DownloadTarget`` into a stream of ``DownloadItem``.

The provider is the only place that understands DeviantArt endpoints, CSRF,
pagination, and media-URL resolution. Everything downstream (DownloadManager,
HttpDownloader) works only with the ``DownloadItem`` contract.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Optional, Protocol

from .api import ActionType, DeviantArtAPI
from .errors import MediaUnavailableError, ParseError
from .errors import AuthenticationError, NetworkError
from .models import Deviation, DownloadItem, PageOutcome, PageStatus, literature_text
from .wix_media import bounded_fullview_url
from .official_api import (
    OfficialApiClient,
    additional_media_urls,
    deviation_init,
    deviation_uuid,
    is_blurred,
    is_locked,
)
from .targets import DownloadTarget, TargetKind

logger = logging.getLogger(__name__)


class DeviantArtProvider(Protocol):
    """Resolves a DownloadTarget into the DownloadItems to fetch."""

    def resolve(self, target: DownloadTarget) -> Iterator[DownloadItem]:
        ...


class WebProvider:
    """Cookie-based provider for list targets (gallery/search/favorites).

    Uses the website's private ``_puppy`` endpoints via the existing
    ``DeviantArtAPI``. Single-artwork and tag targets are the official API's
    job and are not handled here.
    """

    def __init__(
        self, api: DeviantArtAPI, quality: str = "f", limit: int = 24
    ) -> None:
        self.api = api
        self.quality = quality
        self.limit = limit
        # Ending of each list page from the most recent resolve() call, in
        # request order. Reset per resolve so callers never read stale pages.
        self.page_outcomes: list[PageOutcome] = []

    def resolve(self, target: DownloadTarget) -> Iterator[DownloadItem]:
        self.page_outcomes = []
        kind = target.kind
        if kind == TargetKind.ARTWORK:
            raise MediaUnavailableError(
                "single-artwork download requires the official API; "
                "run `devart-dl login oauth` to enable it"
            )
        if kind == TargetKind.TAG:
            raise MediaUnavailableError(
                "tag browsing requires the official API; "
                "run `devart-dl login oauth` to enable it"
            )

        username = target.username or ""
        if kind in (TargetKind.USER, TargetKind.GALLERY):
            action, query, folder = ActionType.GALLERY, None, None
        elif kind == TargetKind.GALLERY_FOLDER:
            action, query, folder = ActionType.GALLERY, None, target.identifier
        elif kind == TargetKind.FAVORITES:
            action, query, folder = ActionType.FAVORITE, None, None
        elif kind == TargetKind.FAVORITES_FOLDER:
            action, query, folder = ActionType.FAVORITE, None, target.identifier
        elif kind == TargetKind.SEARCH:
            action, query, folder = ActionType.SEARCH, target.query or "", None
            username = username or "all"  # empty → global search
        else:
            raise MediaUnavailableError(f"unsupported target kind: {kind}")

        yield from self._resolve_list(action, username, query, folder)

    def _resolve_list(
        self,
        action: ActionType,
        username: str,
        query: Optional[str],
        folder: Optional[str],
    ) -> Iterator[DownloadItem]:
        csrf_username = "" if (action == ActionType.SEARCH and username == "all") else username
        if not self.api.get_csrf_token(csrf_username):
            raise ParseError(f"could not obtain a CSRF token for '{csrf_username}'")

        url = self.api.build_api_url(action, username, query=query, folder_id=folder)
        url = url.replace("<LIMIT>", str(self.limit))

        offset = 0
        cursor = ""
        seen_pages: set[tuple[int, str]] = set()
        page = 0
        while True:
            page_key = (offset, cursor)
            page += 1
            if page_key in seen_pages:
                reason = f"pagination did not advance (offset={offset}, cursor={cursor!r})"
                # 独立结局：分页未推进必须终止采集，但不伪装成普通成功页。
                self.page_outcomes.append(
                    PageOutcome(page, 0, PageStatus.NOT_ADVANCED, reason)
                )
                logger.warning("stopping list at page %s: %s", page, reason)
                return
            seen_pages.add(page_key)

            try:
                deviations, has_more, offset, cursor = self.api.fetch_deviations(
                    url, offset, cursor
                )
            except Exception as exc:
                # 失败页记录原始异常文本；已经产出的作品由调用方保留，
                # 采集就此结束而不静默跳过该页继续翻页。
                self.page_outcomes.append(
                    PageOutcome(page, 0, PageStatus.FAILED, str(exc))
                )
                logger.warning("list page %s failed: %s", page, exc)
                return

            produced = 0
            try:
                for deviation in deviations:
                    item = self._to_item(deviation)
                    if item is not None:
                        produced += 1
                        yield item
            except Exception as exc:
                # 单件解析/取链失败同样视为本页失败：保留已产出的条目与
                # 计数，记录原始异常文本后结束采集，不再静默继续翻页。
                self.page_outcomes.append(
                    PageOutcome(page, produced, PageStatus.FAILED, str(exc))
                )
                logger.warning("list page %s failed after %s items: %s", page, produced, exc)
                return
            self.page_outcomes.append(
                PageOutcome(page, produced, PageStatus.SUCCESS)
            )
            if not has_more:
                return

    def _to_item(self, deviation: Deviation) -> Optional[DownloadItem]:
        if deviation.deviation_type == "literature":
            text = literature_text({"textContent": deviation.text_content})
            if text:
                return DownloadItem(
                    artwork_id=deviation.deviation_id,
                    url=deviation.url,
                    title=deviation.title,
                    author=deviation.author,
                    media_url="",
                    extension="txt",
                    content=text,
                    mature=deviation.is_mature,
                    metadata={"kind": "literature"},
                )
            logger.warning("empty literature payload for %r; skipping", deviation.title)
            return None

        media_url = self.api.get_download_url(deviation, self.quality)
        if media_url is None and self.quality == "o":
            media_url = self.api.get_download_url(deviation, "f")
        if media_url is None:
            logger.warning("no media URL for %r; skipping", deviation.title)
            return None
        # 付费/订阅锁定：非成熟作品的模糊主图 = 当前账号拿不到原图，跳过而不是把
        # 打码图当成作品保存（成熟打码由 official provider / additional pages 处理）。
        if deviation.premium or (not deviation.is_mature and is_blurred(media_url)):
            logger.warning("premium/subscription-locked %r; skipping", deviation.title)
            return None
        return DownloadItem(
            artwork_id=deviation.deviation_id,
            url=deviation.url,
            title=deviation.title,
            author=deviation.author,
            media_url=media_url,
            extension=_extension(deviation, media_url),
            mature=deviation.is_mature,
            metadata={"quality": self.quality, **(
                {"representation": "fullview", "original_available": False}
                if media_url == bounded_fullview_url(deviation.media or {}) else {}
            )},
        )


def _extension(deviation: Deviation, media_url: str) -> Optional[str]:
    """Best-effort file extension from the download URL or deviation media."""
    path = media_url.split("?")[0]
    leaf = path.rstrip("/").rsplit("/", 1)[-1]
    if "." in leaf:
        ext = leaf.rsplit(".", 1)[-1].lower()
        if ext.isalnum() and 1 < len(ext) <= 10:
            return ext
    media = deviation.media or {}
    if media:
        return deviation._extract_extension_from_media(media).lstrip(".") or None
    return None


class OfficialProvider:
    """Official-API provider (OAuth). Handles every target kind except SEARCH.

    Original quality uses ``deviation/download/{uuid}`` (never preview URLs);
    ``best``/``preview`` fall back to the deviation's ``content``/``preview``
    images already present in the list response.
    """

    def __init__(
        self, client: OfficialApiClient, quality: str = "o", limit: int = 24
    ) -> None:
        self.client = client
        self.quality = quality
        self.limit = limit
        # Ending of each list page from the most recent resolve() call.
        self.page_outcomes: list[PageOutcome] = []

    def resolve(self, target: DownloadTarget) -> Iterator[DownloadItem]:
        self.page_outcomes = []
        kind = target.kind
        if kind == TargetKind.ARTWORK:
            yield from self._artwork_items(target)
            return
        if kind == TargetKind.SEARCH:
            raise MediaUnavailableError(
                "the official API no longer has a search endpoint; use a web/cookie session"
            )

        username = target.username or ""
        if kind in (TargetKind.GALLERY, TargetKind.USER):
            fetch: Callable[[int], dict] = lambda offset: self.client.gallery_all(
                username, offset, self.limit
            )
        elif kind == TargetKind.GALLERY_FOLDER:
            fetch = lambda offset: self.client.gallery(
                username, target.identifier or "", offset, self.limit
            )
        elif kind == TargetKind.FAVORITES:
            fetch = lambda offset: self.client.collections_all(
                username, offset, self.limit
            )
        elif kind == TargetKind.FAVORITES_FOLDER:
            fetch = lambda offset: self.client.collections(
                username, target.identifier or "", offset, self.limit
            )
        elif kind == TargetKind.TAG:
            fetch = lambda offset: self.client.browse_tags(
                target.identifier or "", offset, self.limit
            )
        else:
            raise MediaUnavailableError(f"unsupported target kind: {kind}")
        yield from self._paginate(fetch)

    def _artwork(self, target: DownloadTarget) -> DownloadItem:
        # 兼容旧的单返回值调用（resolve 里已改用 _artwork_items）
        return next(self._artwork_items(target))

    def _artwork_items(self, target: DownloadTarget) -> Iterator[DownloadItem]:
        """单作品下载。多文件作品的附加画面来自网页 init 响应
        （deviation.extended.additionalMedia，官方 API 不再返回），逐个产出下载项；
        没有附加画面时只下主图（行为与以前一致）。"""
        identifier = target.identifier or ""
        init_data = deviation_init(identifier, target.username)
        uuid = deviation_uuid(init_data)
        init_deviation = init_data.get("deviation") if isinstance(init_data, dict) else {}
        if isinstance(init_deviation, dict) and init_deviation.get("type") == "literature":
            text = literature_text(init_deviation)
            if text:
                author = init_deviation.get("author") or {}
                yield DownloadItem(
                    artwork_id=uuid,
                    url=str(init_deviation.get("url") or ""),
                    title=str(init_deviation.get("title") or "Untitled"),
                    author=str(author.get("username") or "unknown"),
                    media_url="",
                    extension="txt",
                    content=text,
                    published_at=_parse_published(init_deviation.get("published_time")),
                    mature=bool(init_deviation.get("is_mature", False)),
                    metadata={"kind": "literature", "quality": self.quality},
                )
                return
        main = self._item(self.client.deviation(uuid))
        yield main
        bounded_urls = {
            bounded_fullview_url(entry.get("media") or {})
            for entry in ((init_data.get("deviation", {}).get("extended") or {}).get("additionalMedia") or [])
            if isinstance(entry, dict) and isinstance(entry.get("media"), dict)
        }
        for index, url in enumerate(additional_media_urls(init_data), start=1):
            item = DownloadItem(
                artwork_id=f"{main.artwork_id}-{index}",
                url=main.url,
                title=main.title,
                author=main.author,
                media_url=url,
                extension=_ext_from_url(url),
                published_at=main.published_at,
                mature=main.mature,
                metadata={**main.metadata, "index": index, **(
                    {"representation": "fullview", "original_available": False}
                    if url in bounded_urls else {}
                )},
            )
            yield item

    def _paginate(self, fetch: Callable[[int], dict]) -> Iterator[DownloadItem]:
        offset = 0
        seen: set[int] = set()
        page = 0
        while True:
            page += 1
            if offset in seen:
                reason = f"pagination did not advance (offset={offset})"
                self.page_outcomes.append(
                    PageOutcome(page, 0, PageStatus.NOT_ADVANCED, reason)
                )
                logger.warning("stopping list at page %s: %s", page, reason)
                return
            seen.add(offset)

            try:
                data = fetch(offset)
            except Exception as exc:
                # 失败页保留原始异常文本；此前已产出的 DownloadItem 照常交付，
                # 采集在此结束而不是静默跳到下一页。
                self.page_outcomes.append(
                    PageOutcome(page, 0, PageStatus.FAILED, str(exc))
                )
                logger.warning("list page %s failed: %s", page, exc)
                return

            results = data.get("results") or []
            produced_items: list[DownloadItem] = []
            try:
                for deviation in results:
                    if isinstance(deviation, dict):
                        produced_items.append(self._item(deviation))
            except Exception as exc:
                # 单件转换失败按本页失败处理：已产出的条目照常交付并计数，
                # 原始异常文本保留，采集结束。
                self.page_outcomes.append(
                    PageOutcome(page, len(produced_items), PageStatus.FAILED, str(exc))
                )
                logger.warning("list page %s failed: %s", page, exc)
                yield from produced_items
                return
            # Record before yielding so an early consumer stop keeps the trail.
            self.page_outcomes.append(
                PageOutcome(page, len(produced_items), PageStatus.SUCCESS)
            )
            yield from produced_items
            if not data.get("has_more"):
                return
            offset = data.get("next_offset") or (offset + len(results))

    def _item(self, deviation: dict) -> DownloadItem:
        uuid = str(deviation.get("deviationid") or deviation.get("deviationId") or "")
        if not uuid:
            raise ParseError("a deviation is missing its id")
        author = deviation.get("author") or {}
        if deviation.get("type") == "literature":
            text = literature_text(deviation)
            if text:
                return DownloadItem(
                    artwork_id=uuid,
                    url=str(deviation.get("url") or ""),
                    title=str(deviation.get("title") or "Untitled"),
                    author=str(author.get("username") or "unknown"),
                    media_url="",
                    extension="txt",
                    content=text,
                    published_at=_parse_published(deviation.get("published_time")),
                    mature=bool(deviation.get("is_mature", False)),
                    metadata={"kind": "literature", "quality": self.quality},
                )
        media_url, ext = self._media(deviation, uuid)
        return DownloadItem(
            artwork_id=uuid,
            url=str(deviation.get("url") or ""),
            title=str(deviation.get("title") or "Untitled"),
            author=str(author.get("username") or "unknown"),
            media_url=media_url,
            extension=ext,
            published_at=_parse_published(deviation.get("published_time")),
            mature=bool(deviation.get("is_mature", False)),
            metadata={"quality": self.quality},
        )

    def _media(self, deviation: dict, uuid: str) -> tuple[str, Optional[str]]:
        if self.quality == "o" and deviation.get("is_downloadable"):
            original = self.client.original_download(uuid)
            ext = _ext_from_url(original.filename)
            return original.url, ext
        url: Optional[str] = None
        ext: Optional[str] = None
        content = deviation.get("content") or {}
        # `content.src` is a poster for video works; only videos[].src is playable.
        videos = deviation.get("videos") or []
        if isinstance(videos, list):
            for video in videos:
                src = video.get("src") if isinstance(video, dict) else None
                if src:
                    url, ext = str(src), _ext_from_url(str(src))
                    break
        if url is None and content.get("src"):
            url, ext = str(content["src"]), _ext_from_url(str(content["src"]))
        if url is None:
            preview = deviation.get("preview") or {}
            if preview.get("src"):
                url, ext = str(preview["src"]), _ext_from_url(str(preview["src"]))
        if url is None:
            thumbs = deviation.get("thumbs") or []
            if thumbs and isinstance(thumbs[0], dict) and thumbs[0].get("src"):
                url, ext = str(thumbs[0]["src"]), _ext_from_url(str(thumbs[0]["src"]))
        if url is None:
            raise MediaUnavailableError(f"no media available for deviation {uuid}")
        # 付费/订阅锁定：非成熟作品的模糊主图（或显式 premium 字段）＝拿不到原图，
        # 明确报错而不是保存一张打码占位图。成熟作品由 mature_content=true 提供未打码源。
        if is_locked(deviation) or (not deviation.get("is_mature") and is_blurred(url)):
            raise MediaUnavailableError(
                f"deviation {uuid} requires a subscription/purchase (premium)"
            )
        return url, ext


def _ext_from_url(url: str) -> Optional[str]:
    path = url.split("?")[0]
    leaf = path.rstrip("/").rsplit("/", 1)[-1]
    if "." in leaf:
        ext = leaf.rsplit(".", 1)[-1].lower()
        if ext.isalnum() and 1 < len(ext) <= 10:
            return ext
    return None


def _parse_published(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return None
    if timestamp <= 0:
        return None
    if timestamp > 100_000_000_000:  # milliseconds
        timestamp //= 1000
    return datetime.fromtimestamp(timestamp, tz=timezone.utc)


class CompositeProvider:
    """Routes each target to the provider that can actually serve it.

    OAuth and cookies are capabilities, not global provider modes: search
    always uses the web session, artwork/tag use the official API, and
    gallery/favorites prefer the official API with the web session as a
    fallback when the official path is unavailable.
    """

    def __init__(
        self,
        official: DeviantArtProvider | None = None,
        web: DeviantArtProvider | None = None,
    ) -> None:
        if official is None and web is None:
            raise ValueError("at least one provider is required")
        self.official = official
        self.web = web
        # Page endings of the provider that actually served the last target.
        self.page_outcomes: list[PageOutcome] = []

    def resolve(self, target: DownloadTarget) -> Iterator[DownloadItem]:
        self.page_outcomes = []
        kind = target.kind
        if kind == TargetKind.SEARCH:
            if self.web is None:
                raise MediaUnavailableError(
                    "search requires a web/cookie session "
                    "(`devart-dl login browser`/`interactive` or --cookies)"
                )
            yield from self._serve(self.web, target)
            return
        if kind in (TargetKind.ARTWORK, TargetKind.TAG):
            if self.official is None:
                raise MediaUnavailableError(
                    "this target requires the official API "
                    "(`devart-dl login oauth`)"
                )
            yield from self._serve(self.official, target)
            return
        if self.official is not None:
            try:
                yield from self._serve(self.official, target)
            except (MediaUnavailableError, NetworkError, AuthenticationError):
                if self.web is not None:
                    yield from self._serve(self.web, target)
                    return
                raise
            # Page failures no longer raise; if the official session produced
            # nothing at all (first page failed), keep the old fallback policy
            # and try the web session instead.
            if self._produced_nothing(self.official) and self.web is not None:
                self.page_outcomes = []
                yield from self._serve(self.web, target)
        elif self.web is not None:
            yield from self._serve(self.web, target)
        else:
            raise MediaUnavailableError("no provider can resolve this target")

    def _serve(
        self, provider: DeviantArtProvider, target: DownloadTarget
    ) -> Iterator[DownloadItem]:
        """Delegate to one provider, collecting its pages even if the
        consumer stops early (the generator is closed at the yield point)."""
        try:
            yield from provider.resolve(target)
        finally:
            self._collect(provider)

    @staticmethod
    def _produced_nothing(provider: DeviantArtProvider) -> bool:
        outcomes = getattr(provider, "page_outcomes", None)
        return bool(outcomes) and outcomes[0].failed and outcomes[0].item_count == 0

    def _collect(self, provider: DeviantArtProvider) -> None:
        outcomes = getattr(provider, "page_outcomes", None)
        if outcomes is not None:
            self.page_outcomes = list(outcomes)


__all__ = [
    "CompositeProvider",
    "DeviantArtProvider",
    "OfficialProvider",
    "PageOutcome",
    "PageStatus",
    "WebProvider",
]
