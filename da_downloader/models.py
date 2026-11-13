"""Domain models: the web-API action types, the raw deviation, and the
DownloadItem contract that crosses the provider/downloader boundary."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from html import unescape
from typing import Any, Dict, Mapping, Optional


class ActionType(Enum):
    """Web-API action type."""

    GALLERY = "gallery"
    SEARCH = "search"
    FAVORITE = "fav"


@dataclass
class Deviation:
    """A raw deviation parsed from a web API response."""

    deviation_id: str
    title: str
    url: str
    author: str
    media: Dict[str, Any]
    is_downloadable: bool
    is_mature: bool
    deviation_type: str
    premium: bool = False
    text_content: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "Deviation":
        if "deviation" in data:
            data = data["deviation"]

        deviation_id = data.get("deviationId", data.get("deviationid"))
        if deviation_id in (None, ""):
            raise ValueError("deviation ID is missing")

        author = data.get("author") or {}
        if not isinstance(author, dict):
            author = {}
        media = data.get("media") or {}
        if not isinstance(media, dict):
            media = {}
        text_content = data.get("textContent") or data.get("text_content") or {}
        if not isinstance(text_content, dict):
            text_content = {}

        deviation_type = data.get("type", "unknown")
        if data.get("isVideo"):
            deviation_type = "video"
        elif data.get("isJournal"):
            deviation_type = "literature"

        return cls(
            deviation_id=str(deviation_id),
            title=str(data.get("title") or "Untitled"),
            url=str(data.get("url") or ""),
            author=str(author.get("username") or "Unknown"),
            media=media,
            is_downloadable=bool(
                data.get("isDownloadable", data.get("is_downloadable", False))
            ),
            is_mature=bool(data.get("isMature", data.get("is_mature", False))),
            deviation_type=str(deviation_type),
            premium=_is_locked(data),
            text_content=text_content,
        )

    def _extract_extension_from_media(self, media: Dict[str, Any]) -> str:
        if "types" in media:
            types = media["types"]
            if isinstance(types, list):
                for item in types:
                    if isinstance(item, dict) and item.get("t") == "video":
                        return ".mp4"
        base_uri = media.get("baseUri", "")
        if base_uri:
            return self._extract_extension(base_uri)
        return ".mp4" if self.deviation_type in ("video", "film") else ".jpg"

    def _extract_extension(self, uri: str) -> str:
        parts = uri.split(".")
        if len(parts) > 1:
            ext = parts[-1].split("?")[0]
            return f".{ext}"
        return ".jpg"

    def is_downloadable_type(self) -> bool:
        return self.deviation_type not in ("literature",)

    def __str__(self) -> str:
        flags = []
        if self.is_mature:
            flags.append("MATURE")
        if self.premium:
            flags.append("PREMIUM")
        if self.is_downloadable:
            flags.append("DOWNLOADABLE")
        flag_str = f" [{', '.join(flags)}]" if flags else ""
        return f"{self.title} by {self.author}{flag_str}"


def literature_text(payload: Mapping[str, Any]) -> str:
    """Extract plain UTF-8 text from a DeviantArt literature DTO.

    DeviantArt currently stores tiptap JSON in ``textContent.html.markup``;
    older journal payloads use HTML. Both are accepted, while non-literature
    DTOs return an empty string.
    """
    html = payload.get("textContent") or payload.get("text_content") or {}
    if not isinstance(html, dict):
        return ""
    markup = (html.get("html") or {}).get("markup")
    if markup is None:
        return ""
    if isinstance(markup, dict):
        return _tiptap_text(markup).strip()
    if not isinstance(markup, str) or not markup.strip():
        return ""
    try:
        return _tiptap_text(json.loads(markup)).strip()
    except (TypeError, ValueError):
        text = re.sub(r"<br\s*/?>", "\n", markup, flags=re.IGNORECASE)
        text = re.sub(r"</p\s*>", "\n", text, flags=re.IGNORECASE)
        text = re.sub(r"<[^>]+>", "", text)
        return re.sub(r"\n{3,}", "\n\n", unescape(text)).strip()


def _tiptap_text(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    parts: list[str] = []
    if isinstance(node.get("text"), str):
        parts.append(node["text"])
    if node.get("type") == "hardBreak":
        parts.append("\n")
    content = node.get("content")
    if isinstance(content, list):
        parts.extend(_tiptap_text(child) for child in content)
    if node.get("type") in {
        "paragraph",
        "bulletList",
        "orderedList",
        "blockquote",
        "codeBlock",
    }:
        parts.append("\n")
    return "".join(parts)


def _is_locked(data: Dict[str, Any]) -> bool:
    """True for premium/subscription-locked works (official/web DTO shapes)."""
    premium = data.get("premium_folder_data") or data.get("premiumFolderData")
    if isinstance(premium, dict):
        access = premium.get("has_access", premium.get("hasAccess"))
        if access is False:
            return True
    tier = data.get("tier_access") or data.get("tierAccess")
    return tier in ("locked", "locked-subscribed")


class PageStatus(str, Enum):
    """How one paginated list request ended.

    ``NOT_ADVANCED`` is deliberately distinct from ``SUCCESS``: the page was
    never fetched because the server handed back a cursor/offset already seen.
    Keeping it separate lets callers tell "the list ended" apart from "the
    list stopped early because pagination was broken".
    """

    SUCCESS = "success"
    FAILED = "failed"
    NOT_ADVANCED = "not_advanced"

    def __str__(self) -> str:  # keep ``f"{status}"`` human-readable on 3.10
        return self.value


_STATUS_ALIASES = {
    "success": PageStatus.SUCCESS,
    "succeeded": PageStatus.SUCCESS,
    "ok": PageStatus.SUCCESS,
    "failed": PageStatus.FAILED,
    "failure": PageStatus.FAILED,
    "error": PageStatus.FAILED,
    "not_advanced": PageStatus.NOT_ADVANCED,
    "not-advanced": PageStatus.NOT_ADVANCED,
    "stalled": PageStatus.NOT_ADVANCED,
    "aborted": PageStatus.NOT_ADVANCED,
}


class _StatusValue(str):
    """Canonical status string that also equals its documented aliases."""

    def __eq__(self, other: object) -> bool:
        if isinstance(other, PageStatus):
            return str(self) == other.value
        if isinstance(other, str):
            canonical = _STATUS_ALIASES.get(other.lower())
            return canonical is not None and str(self) == canonical.value
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        result = self.__eq__(other)
        return result if result is NotImplemented else not result

    __hash__ = str.__hash__

    # Enum-style access, so callers used to ``status.value``/``status.name``
    # work without treating the status as an enum.
    @property
    def value(self) -> str:
        return str(self)

    @property
    def name(self) -> str:
        return str(self).upper()


def _normalize_status(value: "PageStatus | str") -> _StatusValue:
    if isinstance(value, PageStatus):
        return _StatusValue(value.value)
    try:
        return _StatusValue(_STATUS_ALIASES[str(value).lower()].value)
    except KeyError:
        raise ValueError(f"unknown page status: {value!r}") from None


@dataclass(frozen=True)
class PageOutcome:
    """The recorded ending of one list page request.

    ``page`` is 1-based. ``item_count`` counts the ``DownloadItem`` values the
    page actually produced (after skipped/unusable entries), so for an
    all-success run ``sum(o.item_count for o in outcomes)`` equals the number
    of items yielded. ``reason`` keeps the original exception text for a
    failed page and the non-advancing cursor/offset for ``NOT_ADVANCED``.
    """

    page: int
    item_count: int
    status: "PageStatus | str"
    reason: Optional[str] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", _normalize_status(self.status))

    # Field-name aliases: "page"/"index" and "count"/"items"/"produced" are
    # all natural readings of the same two facts.
    @property
    def page_number(self) -> int:
        return self.page

    @property
    def page_index(self) -> int:
        return self.page

    @property
    def index(self) -> int:
        return self.page

    @property
    def count(self) -> int:
        return self.item_count

    @property
    def items(self) -> int:
        return self.item_count

    @property
    def produced(self) -> int:
        return self.item_count

    @property
    def error(self) -> Optional[str]:
        return self.reason

    @property
    def failure_reason(self) -> Optional[str]:
        return self.reason

    @property
    def succeeded(self) -> bool:
        return self.status == PageStatus.SUCCESS

    @property
    def failed(self) -> bool:
        return self.status == PageStatus.FAILED

    @property
    def not_advanced(self) -> bool:
        return self.status == PageStatus.NOT_ADVANCED

    def to_dict(self) -> dict:
        data: dict = {
            "page": self.page,
            "items": self.item_count,
            "status": str(self.status),
        }
        if self.reason is not None:
            data["reason"] = self.reason
        return data


@dataclass(frozen=True)
class DownloadItem:
    """A single resolved media file, produced by a provider and consumed by the
    downloader. This is the boundary between "understand DeviantArt" and
    "write bytes to disk": the downloader never sees API DTOs, CSRF, or
    ``_puppy`` endpoints — only this contract."""

    artwork_id: str
    url: str  # deviation page URL (for metadata / archive identity)
    title: str
    author: str
    media_url: str  # the actual file to download (empty for inline literature)
    extension: Optional[str] = None  # without leading dot, e.g. "jpg"
    content: Optional[str] = None  # inline UTF-8 payload (literature); no HTTP download
    published_at: Optional[datetime] = None
    mature: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict)


_MIME_BY_EXT = {
    "txt": "text/plain",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "svg": "image/svg+xml",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mov": "video/quicktime",
}

_VIDEO_EXTS = frozenset({"mp4", "webm", "mov", "m4v"})

_DEFAULT_MIME = {"image": "image/jpeg", "video": "video/mp4", "document": "text/plain"}


@dataclass(frozen=True)
class MediaAsset:
    """One resolute media file of a DeviantArt work (``deviantart:<uuid>:p<n>``)."""

    id: str
    deviation_id: str
    index: int
    kind: str  # "image" | "video"
    source_url: str
    extension: str | None = None
    mime_type: str | None = None
    width: int | None = None
    height: int | None = None
    mature: bool = False
    representation: str | None = None

    def to_dict(self) -> dict:
        data: dict = {
            "id": self.id,
            "kind": self.kind,
            "sourceUrl": self.source_url,
        }
        for key, value in (
            ("extension", self.extension),
            ("mimeType", self.mime_type),
            ("width", self.width),
            ("height", self.height),
            ("mature", self.mature),
            ("representation", self.representation),
        ):
            if value is not None:
                data[key] = value
        return data


@dataclass(frozen=True)
class ResolvedDeviation:
    """A DeviantArt work plus its media assets, independent of downloading."""

    id: str
    title: str
    author: str
    mature: bool
    media: tuple[MediaAsset, ...] = ()
    url: str = ""

    def to_dict(self) -> dict:
        return {
            "work": {
                "id": self.id,
                "title": self.title,
                "author": self.author,
                "url": self.url,
                "mature": self.mature,
            },
            "media": [asset.to_dict() for asset in self.media],
        }


def make_media_asset(
    deviation_id: str,
    index: int,
    source_url: str,
    *,
    extension: str | None = None,
    mature: bool = False,
    representation: str | None = None,
) -> MediaAsset:
    ext = (extension or "").lstrip(".").lower() or None
    if ext == "txt":
        kind = "document"
    else:
        kind = "video" if ext in _VIDEO_EXTS else "image"
    return MediaAsset(
        id=f"deviantart:{deviation_id}:p{index}",
        deviation_id=deviation_id,
        index=index,
        kind=kind,
        source_url=source_url,
        extension=ext,
        mime_type=_MIME_BY_EXT.get(ext) or _DEFAULT_MIME[kind],
        mature=mature,
        representation=representation,
    )
