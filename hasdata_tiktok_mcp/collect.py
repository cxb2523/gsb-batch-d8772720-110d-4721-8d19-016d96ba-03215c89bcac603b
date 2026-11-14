"""Two-level comment collection on top of HasData's TikTok comments endpoint.

The hosted MCP tools return one layer at a time: a page of top-level comments,
or a page of replies under one comment. ``collect_comments`` orchestrates both
layers so a caller gets a per-comment outcome instead of re-implementing
paging, thread expansion and retry logic — and keeps whatever was fetched
when a page fails partway through.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Awaitable, Callable

import httpx

COMMENTS_URL = "https://api.hasdata.com/scrape/tiktok/comments"
DATA_KEY = "comments"

# Page outcomes.
OK = "ok"
EMPTY = "empty"
RATE_LIMITED = "rate_limited"
ERROR = "error"

# Collection statuses.
COMPLETE = "complete"
PARTIAL = "partial"
FAILED = "failed"

# Rate-limit retries: sleep 1s, 2s, 4s between attempts, then give up.
BACKOFF_SECONDS = (1, 2, 4)
MAX_RETRIES = 3

# async (params, api_key) -> (status_code, body_text)
FetchFn = Callable[[dict, str], Awaitable[tuple[int, str]]]
SleepFn = Callable[[float], Awaitable[None]]


class MissingApiKeyError(RuntimeError):
    """Raised when HASDATA_API_KEY is not set; no request is ever sent."""


async def _default_fetch(params: dict, api_key: str) -> tuple[int, str]:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            COMMENTS_URL, params=params, headers={"x-api-key": api_key}
        )
    return resp.status_code, resp.text


def _is_rate_limited(status: int, text: str) -> bool:
    return status == 429 or "concurrency_limit" in text


async def _fetch_page(
    fetch: FetchFn, params: dict, api_key: str, sleep: SleepFn
) -> tuple[str, dict | None]:
    """Fetch one page with rate-limit retries.

    Returns (outcome, payload). Payload is the parsed JSON body on ``ok`` and
    ``empty``, else None. Network exceptions and non-JSON 200 bodies are
    ``error``; 429 / ``concurrency_limit`` responses are retried with
    1/2/4s backoff up to MAX_RETRIES times, then reported ``rate_limited``.
    """
    for attempt in range(MAX_RETRIES + 1):
        try:
            status, text = await fetch(params, api_key)
        except Exception:
            return ERROR, None
        if _is_rate_limited(status, text):
            if attempt < MAX_RETRIES:
                await sleep(BACKOFF_SECONDS[attempt])
                continue
            return RATE_LIMITED, None
        if status != 200:
            return ERROR, None
        try:
            payload = json.loads(text)
        except ValueError:
            return ERROR, None
        if not isinstance(payload, dict) or DATA_KEY not in payload:
            return EMPTY, payload if isinstance(payload, dict) else None
        return OK, payload
    return RATE_LIMITED, None  # unreachable; satisfies type checkers


async def _collect_pages(
    fetch: FetchFn,
    api_key: str,
    base_params: dict,
    pages: int,
    sleep: SleepFn,
) -> tuple[list, list[dict], dict | None]:
    """Page through one layer. Returns (items, page_records, first_payload).

    Stops at the first non-ok page or when no nextPageToken comes back;
    items and page records gathered so far are always kept.
    """
    items: list = []
    records: list[dict] = []
    first_payload: dict | None = None
    token: str | None = None
    for page_no in range(1, pages + 1):
        params = dict(base_params)
        if token:
            params["nextPageToken"] = token
        outcome, payload = await _fetch_page(fetch, params, api_key, sleep)
        if page_no == 1:
            first_payload = payload
        if outcome == OK:
            data = payload.get(DATA_KEY) or []
            items.extend(data)
            token = (payload.get("pagination") or {}).get("nextPageToken")
            records.append({"page": page_no, "outcome": OK, "nextPageToken": token})
            if not token:
                break
        else:
            records.append({"page": page_no, "outcome": outcome, "nextPageToken": None})
            break
    return items, records, first_payload


def _status(records: list[dict]) -> str:
    """complete: no failed page; partial: some ok, some failed; failed: page 1 failed.

    ``empty`` is a normal end of data, not a failure, so it never turns a
    collection partial. Failed means ``error`` or ``rate_limited``; paging
    stops at the first such page, so a failure on page 1 means nothing was
    collected.
    """
    bad = [r for r in records if r["outcome"] in (ERROR, RATE_LIMITED)]
    if not bad:
        return COMPLETE
    if records and records[0]["outcome"] in (ERROR, RATE_LIMITED):
        return FAILED
    return PARTIAL


def _count(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


async def collect_comments(
    video_id: str,
    pages: int,
    expand_top: int = 3,
    *,
    fetch: FetchFn | None = None,
    sleep: SleepFn | None = None,
) -> dict:
    """Collect a video's comments and the replies under its most-liked threads.

    Fetches up to ``pages`` pages of top-level comments for ``video_id``, then
    expands the ``expand_top`` most-liked comments that have a non-zero
    ``replyCount``, fetching up to ``pages`` pages of replies for each via
    their ``id`` as ``commentId``. Ids stay strings end to end.

    Returns a dict with ``comments`` (top-level, original order), ``threads``
    (one entry per expanded comment: ``commentId``, ``replies``, per-page
    ``pages`` detail and ``status``), the top-level ``status``, and ``total``
    (``pagination.total`` of the first top-level page, None when absent).
    """
    api_key = os.environ.get("HASDATA_API_KEY")
    if not api_key:
        raise MissingApiKeyError(
            "HASDATA_API_KEY is not set. Create a free key at "
            "https://app.hasdata.com and set HASDATA_API_KEY."
        )
    fetch = fetch or _default_fetch
    sleep = sleep or asyncio.sleep

    comments, top_records, first_payload = await _collect_pages(
        fetch, api_key, {"videoId": video_id}, pages, sleep
    )
    total = None
    if first_payload:
        total = (first_payload.get("pagination") or {}).get("total")

    candidates = [
        c
        for c in comments
        if isinstance(c, dict) and c.get("id") is not None and _count(c.get("replyCount")) > 0
    ]
    # Stable sort: ties keep their original order.
    candidates.sort(key=lambda c: _count(c.get("likes")), reverse=True)

    threads = []
    for comment in candidates[:expand_top]:
        comment_id = str(comment["id"])
        replies, reply_records, _ = await _collect_pages(
            fetch, api_key, {"commentId": comment_id}, pages, sleep
        )
        threads.append(
            {
                "commentId": comment_id,
                "replies": replies,
                "pages": reply_records,
                "status": _status(reply_records),
            }
        )

    return {
        "comments": comments,
        "threads": threads,
        "status": _status(top_records),
        "total": total,
    }
