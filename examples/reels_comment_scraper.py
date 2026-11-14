#!/usr/bin/env python3
"""
Example: Scrape comments and engaged leads from viral Reels or posts.

The collector walks every comment page by passing the previous page's
``next_min_id`` back to ``comment.list`` as ``min_id``. Each page produces an
outcome record, so a failed or interrupted run can be resumed from
``CommentCollection.last_cursor`` without re-scraping the pages already
collected.

Typical resumable usage::

    result = scrape_leads_from_post("CGgDsi7JQdS")
    if result.last_cursor:
        more = scrape_leads_from_post(
            "CGgDsi7JQdS",
            start_cursor=result.last_cursor,
            seen_pks=result.seen_pks,
        )
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Any

from instagramflow import InstagramAPI

API_KEY = os.getenv("INSTAGRAM_API_KEY", "your_api_key_here")
SESSION_TOKEN = os.getenv("INSTAGRAM_SESSION_TOKEN", "your_session_token")

# Per-page outcomes. A page is always recorded as exactly one of these.
PAGE_SUCCESS = "success"
PAGE_EMPTY = "empty"
PAGE_FAILED = "failed"
PAGE_CURSOR_STALLED = "cursor_stalled"

MISSING_USER_PLACEHOLDER = "<unknown_user>"
MISSING_TEXT_PLACEHOLDER = "<no_text>"


@dataclass
class PageOutcome:
    """What happened while fetching one comments page."""

    page: int
    request_min_id: str | None
    status: str
    items_received: int = 0
    new_items: int = 0
    duplicate_items: int = 0
    missing_user: int = 0
    missing_text: int = 0
    malformed_items: int = 0
    next_min_id: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CommentCollection:
    """Collected leads plus the state required to resume the crawl."""

    media_pk: int
    leads: list[dict[str, Any]] = field(default_factory=list)
    last_cursor: str | None = None
    pages: list[PageOutcome] = field(default_factory=list)
    stop_reason: str = "complete"
    seen_pks: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "media_pk": self.media_pk,
            "leads": self.leads,
            "last_cursor": self.last_cursor,
            "pages": [page.to_dict() for page in self.pages],
            "stop_reason": self.stop_reason,
            "seen_pks": self.seen_pks,
        }


def _normalize_cursor(value: Any) -> str | None:
    """Return a non-empty cursor as a string, otherwise ``None``."""
    if value is None:
        return None
    text = str(value)
    return text or None


def _lead_from_comment(comment: dict[str, Any]) -> tuple[dict[str, Any], bool, bool]:
    """Convert one raw comment into a lead, tolerating missing user/text."""
    user = comment.get("user")
    user_missing = not isinstance(user, dict) or not user.get("username")

    if user_missing:
        username = MISSING_USER_PLACEHOLDER
        full_name = MISSING_USER_PLACEHOLDER
    else:
        username = user.get("username")
        full_name = user.get("full_name", "") or ""

    text = comment.get("text")
    text_missing = text is None
    if text_missing:
        text = MISSING_TEXT_PLACEHOLDER
    else:
        text = str(text)

    try:
        like_count = int(comment.get("comment_like_count", 0) or 0)
    except (TypeError, ValueError):
        like_count = 0

    pk = comment.get("pk")
    lead = {
        "pk": str(pk) if pk is not None and str(pk) != "" else None,
        "username": username,
        "full_name": full_name,
        "comment": text,
        "like_count": like_count,
        "user_missing": user_missing,
        "text_missing": text_missing,
    }
    return lead, user_missing, text_missing


def collect_comment_leads(
    ig: InstagramAPI,
    media_pk: str | int,
    *,
    start_cursor: str | None = None,
    max_pages: int | None = None,
    seen_pks: list[str] | None = None,
) -> CommentCollection:
    """Collect comment leads page by page, recording an outcome per page.

    ``start_cursor`` and ``seen_pks`` are the resume inputs: pass the previous
    run's ``last_cursor`` and ``seen_pks`` to continue without re-scraping.

    ``last_cursor`` is the ``min_id`` to send on the next call:

    * a successful page advances it to that page's ``next_min_id``;
    * an empty page keeps the ``next_min_id`` the server supplied (usually
      ``None``, meaning the thread is exhausted);
    * a failed or cursor-stalled page keeps the cursor that page requested, so
      the caller can retry exactly that page.

    ``stop_reason`` is one of ``complete``, ``empty``, ``failed``,
    ``cursor_stalled`` or ``max_pages``.
    """
    cursor = _normalize_cursor(start_cursor)
    seen = {str(pk) for pk in (seen_pks or [])}
    leads: list[dict[str, Any]] = []
    pages: list[PageOutcome] = []
    stop_reason = "complete"

    while True:
        if max_pages is not None and len(pages) >= max_pages:
            stop_reason = "max_pages"
            break

        request_cursor = cursor
        page_number = len(pages) + 1

        try:
            response = ig.comment.list(media_pk, min_id=request_cursor)
        except Exception as exc:  # noqa: BLE001 - outcome must be recorded, not raised
            pages.append(
                PageOutcome(
                    page=page_number,
                    request_min_id=request_cursor,
                    status=PAGE_FAILED,
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
            stop_reason = "failed"
            break

        if not isinstance(response, dict):
            pages.append(
                PageOutcome(
                    page=page_number,
                    request_min_id=request_cursor,
                    status=PAGE_FAILED,
                    error=(
                        "malformed response: expected dict, got "
                        f"{type(response).__name__}"
                    ),
                )
            )
            stop_reason = "failed"
            break

        raw_comments = response.get("comments")
        if raw_comments is not None and not isinstance(raw_comments, list):
            pages.append(
                PageOutcome(
                    page=page_number,
                    request_min_id=request_cursor,
                    status=PAGE_FAILED,
                    error=(
                        "malformed response: 'comments' was "
                        f"{type(raw_comments).__name__}, expected list"
                    ),
                )
            )
            stop_reason = "failed"
            break
        comments = raw_comments or []
        next_min_id = _normalize_cursor(response.get("next_min_id"))

        if not comments:
            pages.append(
                PageOutcome(
                    page=page_number,
                    request_min_id=request_cursor,
                    status=PAGE_EMPTY,
                    next_min_id=next_min_id,
                )
            )
            # An empty page ends this run. If the server still handed out a
            # cursor, keep it so the caller can explicitly continue from here.
            cursor = next_min_id
            stop_reason = PAGE_EMPTY
            break

        new_items = 0
        duplicate_items = 0
        missing_user = 0
        missing_text = 0
        malformed_items = 0

        for comment in comments:
            if not isinstance(comment, dict):
                malformed_items += 1
                continue

            lead, user_missing, text_missing = _lead_from_comment(comment)
            comment_pk = lead["pk"]

            if comment_pk is not None and comment_pk in seen:
                duplicate_items += 1
                continue

            if comment_pk is not None:
                seen.add(comment_pk)
            if user_missing:
                missing_user += 1
            if text_missing:
                missing_text += 1

            leads.append(lead)
            new_items += 1

        # A cursor that does not advance would make the next request return
        # this same page forever. Keep the page's items, but stop here.
        cursor_stalled = (
            request_cursor is not None and next_min_id == request_cursor
        )
        pages.append(
            PageOutcome(
                page=page_number,
                request_min_id=request_cursor,
                status=PAGE_CURSOR_STALLED if cursor_stalled else PAGE_SUCCESS,
                items_received=len(comments),
                new_items=new_items,
                duplicate_items=duplicate_items,
                missing_user=missing_user,
                missing_text=missing_text,
                malformed_items=malformed_items,
                next_min_id=next_min_id,
                error=(
                    "next_min_id did not advance; stopped to avoid an infinite loop"
                    if cursor_stalled
                    else None
                ),
            )
        )

        if cursor_stalled:
            cursor = request_cursor
            stop_reason = "cursor_stalled"
            break

        if next_min_id is None:
            cursor = None
            stop_reason = "complete"
            break

        cursor = next_min_id

    return CommentCollection(
        media_pk=int(media_pk),
        leads=leads,
        last_cursor=cursor,
        pages=pages,
        stop_reason=stop_reason,
        seen_pks=sorted(seen),
    )


def resolve_media_pk(ig: InstagramAPI, media_url_or_code: str) -> tuple[int, str]:
    """Convert a Reel URL or shortcode to a numeric media PK.

    This keeps the original shortcode/URL handling: take the last path segment
    and let ``media.pk_from_code`` do the base-64 conversion. Query strings and
    fragments (e.g. ``?utm_source=...``) are dropped first so share links work.
    """
    path = media_url_or_code.split("?", 1)[0].split("#", 1)[0]
    if "/" in path:
        code = path.rstrip("/").split("/")[-1]
    else:
        code = path
    if not code:
        raise ValueError(f"Could not extract a shortcode from {media_url_or_code!r}")
    return ig.media.pk_from_code(code), code


def scrape_leads_from_post(
    media_url_or_code: str,
    *,
    ig: InstagramAPI | None = None,
    start_cursor: str | None = None,
    max_pages: int | None = None,
    seen_pks: list[str] | None = None,
    verbose: bool = True,
) -> CommentCollection:
    """Scrape comment leads from a Reel/post shortcode or URL.

    ``ig`` is injectable so the flow can run offline against a fake client.
    When omitted, a real ``InstagramAPI`` is created and closed here.
    """
    owns_client = ig is None
    if ig is None:
        ig = InstagramAPI(
            api_key=API_KEY,
            session_token=SESSION_TOKEN,
            device_preset="pixel_8_pro",
        )

    try:
        media_pk, code = resolve_media_pk(ig, media_url_or_code)
        if verbose:
            print(f"Fetching metadata for media PK: {media_pk} (code: {code})...")

        # Fetch post info (kept from the original example).
        info = ig.media.info(media_pk)
        caption = info.get("items", [{}])[0].get("caption", {}).get("text", "")
        if verbose:
            print(f"Caption: {caption[:60]}...")

        result = collect_comment_leads(
            ig,
            media_pk,
            start_cursor=start_cursor,
            max_pages=max_pages,
            seen_pks=seen_pks,
        )

        if verbose:
            print(
                f"Collected {len(result.leads)} leads across "
                f"{len(result.pages)} page(s); stop_reason={result.stop_reason}; "
                f"last_cursor={result.last_cursor!r}"
            )
            for page in result.pages:
                print(
                    f"  page {page.page}: {page.status}, "
                    f"received={page.items_received}, new={page.new_items}, "
                    f"duplicates={page.duplicate_items}, "
                    f"missing_user={page.missing_user}, "
                    f"missing_text={page.missing_text}, "
                    f"next_min_id={page.next_min_id!r}"
                    + (f", error={page.error}" if page.error else "")
                )
            print("First leads:")
            print(json.dumps(result.leads[:5], indent=2))

        return result
    finally:
        if owns_client:
            ig.close()


def main() -> None:
    scrape_leads_from_post("CGgDsi7JQdS")


if __name__ == "__main__":
    main()
