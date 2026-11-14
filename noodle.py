import asyncio
import json
import re
from urllib.parse import quote_plus, urlparse

from curl_cffi.requests import AsyncSession
from curl_cffi.requests.errors import RequestsError

try:  # selectolax >= 1.0 removed the old ``parser`` backend
    from selectolax.lexbor import LexborHTMLParser as HTMLParser
except ImportError:  # pragma: no cover - compatibility with older selectolax
    from selectolax.parser import HTMLParser


def _parse_duration(text: str) -> int | None:
    """Seconds from a listing label like ``32:20`` or ``1:30:00``."""
    parts = text.strip().split(":")
    if len(parts) > 3 or not all(part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds


def _format_duration(seconds: int | None) -> str | None:
    """``M:SS``, or ``H:MM:SS`` once the video passes an hour."""
    if not seconds:
        return None
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


class VideoFetchError(Exception):
    """A video's direct links could not be resolved.

    The message is deliberately short and user-readable so it can be exposed
    verbatim as the per-result failure reason of ``with_sources=1`` searches.
    """


#: Maximum number of videos enriched concurrently by ``search_videos``.
#: Each video needs at most two upstream requests, so the request burst stays
#: bounded regardless of the number of results on the page.
MAX_ENRICH_CONCURRENCY = 5

# Readable outcomes for the enrichment stage. Kept as constants so callers
# (and tests) can match on reasons without depending on prose formatting.
ERR_VIDEO_PAGE = "video page could not be loaded"
ERR_PLAYER_MISSING = "player URL is missing from the video page"
ERR_PLAYER_PAGE = "player page could not be loaded"
ERR_PLAYLIST = "playlist could not be parsed"
ERR_UNEXPECTED = "sources could not be fetched"

SOURCE_STATUS_OK = "ok"
SOURCE_STATUS_FAILED = "failed"


class NoodleScraper:
    """Async scraper for noodlemagazine.com built on curl-cffi.

    curl_cffi impersonates a real Chrome TLS fingerprint (the ``"chrome"``
    alias always resolves to the latest Chrome the installed lib supports),
    so there is no need to fetch or hand-craft User-Agent strings.

    The scraper is intentionally lazy: a search costs exactly one request
    (the listing page), and direct video links are fetched on demand --
    two requests -- only when a video is actually opened.
    """

    def __init__(self, impersonate: str = "chrome", timeout: int = 15):
        self.base_url = "https://noodlemagazine.com"
        self.timeout = timeout
        self.session = AsyncSession(
            impersonate=impersonate,
            timeout=timeout,
            cookies={"age_verification": "1"},
        )

    async def close(self):
        """Release the underlying curl handles."""
        await self.session.close()

    # ------------------------------------------------------------------ http

    async def _get(self, url: str, referer: str | None = None):
        """GET a URL, returning the response or None on any failure."""
        try:
            return await self.session.get(
                url,
                timeout=self.timeout,
                headers={"Referer": referer} if referer else None,
            )
        except RequestsError as e:
            print(f"Error loading {url}: {e}")
            return None

    @staticmethod
    def _origin(url: str) -> str:
        """Scheme and host of a URL, used to keep requests on one origin."""
        parts = urlparse(url)
        return f"{parts.scheme}://{parts.netloc}"

    # ---------------------------------------------------------------- search

    async def search_videos(
        self, query: str, page: int = 0, with_sources: bool = False
    ) -> dict:
        """Search for videos. One request, results in source-site order.

        With ``with_sources`` the direct links, tags and durations are merged
        into every result on demand -- at most two extra upstream requests per
        video, fetched with bounded concurrency.

        Every enriched result also carries an outcome:

        * ``sources_status == "ok"`` -- ``sources``, ``tags``, ``duration``,
          ``duration_text`` and ``player_url`` were merged.
        * ``sources_status == "failed"`` -- the listing fields (``id``,
          ``title``, ``image``, ``duration``, ``duration_text``) are left
          untouched and ``sources_error`` explains why enrichment failed.

        A failed entry never removes results or fails the request; ordering is
        always the source-site order of the listing page.
        """
        response = await self._get(
            f"{self.base_url}/video/{quote_plus(query)}?p={page}"
        )
        if response is None or response.status_code != 200:
            return {"error": "Failed to load page"}

        # Follow redirects implicitly: the site serves content from a
        # rotating subdomain, so resolve the origin from the final URL.
        base_url = self._origin(str(response.url))

        tree = HTMLParser(response.text)
        videos = []
        for node in tree.css(".list_videos .item_link"):
            item = self._parse_listing_item(node)
            if item:
                videos.append(item)

        if with_sources and videos:
            semaphore = asyncio.Semaphore(MAX_ENRICH_CONCURRENCY)

            async def enrich(item: dict) -> None:
                """Resolve one video in place; never raise."""
                async with semaphore:
                    try:
                        details = await self._fetch_video_details(item["id"])
                    except VideoFetchError as e:
                        item["sources_status"] = SOURCE_STATUS_FAILED
                        item["sources_error"] = str(e)
                        return
                    except Exception:
                        # One broken entry must not discard the whole page.
                        item["sources_status"] = SOURCE_STATUS_FAILED
                        item["sources_error"] = ERR_UNEXPECTED
                        return

                    # Merge rather than overwrite: the player page is the
                    # precise source, but a missing meta must not erase the
                    # duration the listing already provided.
                    duration = (
                        details["duration"]
                        if details["duration"] is not None
                        else item.get("duration")
                    )
                    item.update(
                        {
                            "sources": details["sources"],
                            "tags": details["tags"],
                            "duration": duration,
                            "duration_text": details["duration_text"]
                            or item.get("duration_text"),
                            "player_url": details["player_url"],
                            "sources_status": SOURCE_STATUS_OK,
                            "sources_error": None,
                        }
                    )

            await asyncio.gather(*(enrich(item) for item in videos))

        return {"base_url": base_url, "query": query, "page": page, "videos": videos}

    @staticmethod
    def _parse_listing_item(node) -> dict | None:
        """Extract one search-result card from the listing markup."""
        href = node.attributes.get("href")
        if not href:
            return None

        parts = urlparse(href)
        video_id = parts.path.rstrip("/").rsplit("/", 1)[-1]
        if not video_id:
            return None

        image = ""
        img = node.css_first("img")
        if img is not None:
            image = img.attributes.get("data-src") or img.attributes.get("src") or ""

        title = "Untitled"
        title_node = node.css_first(".i_info .title")
        if title_node is not None:
            title = title_node.text(strip=True) or title
        elif img is not None:
            title = img.attributes.get("alt") or title

        time_node = node.css_first(".m_time")
        duration_seconds = (
            _parse_duration(time_node.text(strip=True))
            if time_node is not None
            else None
        )

        return {
            "id": video_id,
            "title": title,
            "image": image,
            "duration": duration_seconds,
            "duration_text": _format_duration(duration_seconds),
        }

    # ----------------------------------------------------------------- video

    async def get_video_by_id(self, video_id: str) -> dict | None:
        """Fetch one video page plus its player page to extract direct links.

        The playlist lives on the player page (``og:video`` URL) and that
        page checks the Referer, so the video page URL is sent along.

        Returns ``None`` when the links cannot be resolved. Callers that need
        to tell the failure modes apart should use ``_fetch_video_details``,
        which raises ``VideoFetchError`` with a readable reason instead.
        """
        try:
            return await self._fetch_video_details(video_id)
        except VideoFetchError:
            return None

    async def _fetch_video_details(self, video_id: str) -> dict:
        """Like ``get_video_by_id`` but raises ``VideoFetchError`` on failure."""
        video_id = video_id.strip("/")
        response = await self._get(f"{self.base_url}/watch/{video_id}")
        if response is None or response.status_code != 200:
            raise VideoFetchError(ERR_VIDEO_PAGE)

        video_page_url = str(response.url)
        base_url = self._origin(video_page_url)
        tree = HTMLParser(response.text)

        og_video_tag = tree.css_first('meta[property="og:video"]')
        if og_video_tag is None:
            raise VideoFetchError(ERR_PLAYER_MISSING)

        # og:video points to the player CDN host; the same path is served on
        # the site origin, so rewrite it to keep player and links on one host.
        player_url = urlparse(og_video_tag.attributes.get("content") or "")
        if not player_url.path:
            raise VideoFetchError(ERR_PLAYER_MISSING)
        player_url = player_url._replace(
            scheme=urlparse(base_url).scheme, netloc=urlparse(base_url).netloc
        ).geturl()

        og_title_tag = tree.css_first('meta[property="og:title"]')
        title = og_title_tag.attributes.get("content") if og_title_tag else None
        title = title or "Untitled"

        tags = [
            tag.strip()
            for node in tree.css('meta[property="video:tag"]')
            for tag in (node.attributes.get("content") or "").split(",")
            if tag.strip()
        ]

        duration: int | None = None
        duration_tag = tree.css_first('meta[property="video:duration"]')
        if duration_tag is not None:
            raw_duration = duration_tag.attributes.get("content") or ""
            if raw_duration.isdigit():
                duration = int(raw_duration)

        player_response = await self._get(player_url, referer=video_page_url)
        if player_response is None or player_response.status_code != 200:
            raise VideoFetchError(ERR_PLAYER_PAGE)

        playlist = self.parse_playlist(player_response.text, video_id)
        if playlist is None:
            raise VideoFetchError(ERR_PLAYLIST)

        sources = sorted(
            playlist.get("sources") or [], key=self._quality_key, reverse=True
        )
        playlist.update(
            {
                "title": title,
                "tags": tags,
                "duration": duration,
                "duration_text": _format_duration(duration),
                "player_url": player_url,
                "file_name": self._slug(title),
                "sources": sources,
            }
        )
        return playlist

    # ------------------------------------------------------------- parsing

    @staticmethod
    def parse_playlist(html: str, video_id: str) -> dict | None:
        """Pull the ``window.playlist`` object out of any inline script.

        ``JSONDecoder.raw_decode`` stops at the first complete JSON value,
        so trailing semicolons or following JS statements are ignored.
        """
        tree = HTMLParser(html)
        for script in tree.css("script"):
            text = script.text(deep=True)
            match = re.search(r"window\.playlist\s*=\s*", text)
            if not match:
                continue
            try:
                data, _ = json.JSONDecoder().raw_decode(text[match.end() :])
            except json.JSONDecodeError:
                continue
            return {"id": video_id, **data}
        return None

    @staticmethod
    def _quality_key(source: dict) -> int:
        """Numeric quality of a source label like ``"720"`` or ``"720p"``."""
        match = re.search(r"\d+", str(source.get("label", "")))
        return int(match.group()) if match else 0

    @staticmethod
    def _slug(title: str) -> str:
        """Filesystem-safe slug used for suggested download file names."""
        slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")
        return slug or "video"
