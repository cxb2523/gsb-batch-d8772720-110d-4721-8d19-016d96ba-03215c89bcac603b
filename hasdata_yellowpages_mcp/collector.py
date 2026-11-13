"""Page-by-page collector for Yellow Pages search results.

This module is offline-safe: it never performs network I/O itself. The caller
injects a ``call`` invoker with the signature::

    call(keyword, location, page, sort, domain) -> dict

which must return the JSON result of the ``hasdata_yellowpages_search_getSearchResults``
tool for a single page. In production the invoker wraps the real MCP call; in
tests a local fake is injected.

Pagination is driven purely by incrementing the ``page`` number passed to the
invoker. ``pagination.nextPageUrl`` / ``pagination.otherPageUrls`` in the
payload are informational only and are never sent back as request parameters.

Every fetched page leaves a record (page number, outcome, result count, and
the failure reason when it failed). Successful pages keep their data, so a
caller can rerun only the failed page numbers and merge them into the
existing summary::

    summary = collect("plumber", "Austin, TX", call=invoker)
    retry = failed_pages(summary)
    if retry:
        summary = collect("plumber", "Austin, TX", call=invoker,
                          pages=retry, summary=summary)
"""
from __future__ import annotations

from typing import Any, Callable, Iterable, Optional

# Invoker signature: call(keyword, location, page, sort, domain) -> dict
SearchCaller = Callable[[str, str, int, Optional[str], Optional[str]], dict]

# Fields copied verbatim from each organic result when present, else None.
_PASSTHROUGH_FIELDS = ("name", "rating", "address", "phone", "website", "workingHours")


def _normalize_result(item: Any, page: int) -> dict:
    """Defensively normalize one organic result.

    Missing fields become None instead of raising. ``reviews`` is kept only
    when it is an integer count (never substituted with ``rating``);
    ``categories`` is always a list.
    """
    if not isinstance(item, dict):
        item = {}
    out = {field: item.get(field) for field in _PASSTHROUGH_FIELDS}

    reviews = item.get("reviews")
    if isinstance(reviews, bool):
        reviews = None
    elif isinstance(reviews, str) and reviews.strip().isdigit():
        reviews = int(reviews.strip())
    elif not isinstance(reviews, int):
        reviews = None
    out["reviews"] = reviews

    categories = item.get("categories")
    out["categories"] = list(categories) if isinstance(categories, list) else []

    out["page"] = page
    return out


def _record(page: int, status: str, result_count: int = 0, error: Optional[str] = None) -> dict:
    return {"page": page, "status": status, "result_count": result_count, "error": error}


def _new_summary(keyword: str, location: str, sort: Optional[str], domain: Optional[str]) -> dict:
    return {
        "keyword": keyword,
        "location": location,
        "sort": sort,
        "domain": domain,
        "pages": [],
        "results": [],
    }


def _merge(summary: dict, records: list, results: list) -> dict:
    """Merge freshly fetched pages into an existing summary, replacing any
    prior records/results for the same page numbers."""
    replaced = {r["page"] for r in records}
    pages = [r for r in summary["pages"] if r["page"] not in replaced] + records
    pages.sort(key=lambda r: r["page"])
    merged_results = [r for r in summary["results"] if r["page"] not in replaced] + results
    merged_results.sort(key=lambda r: r["page"])
    return {**summary, "pages": pages, "results": merged_results}


def _fetch_one(call: SearchCaller, keyword: str, location: str, page: int,
               sort: Optional[str], domain: Optional[str]):
    """Fetch a single page. Returns (record, normalized_results, payload)."""
    try:
        payload = call(keyword, location, page, sort, domain)
    except Exception as exc:  # noqa: BLE001 - any invoker failure is recorded, not raised
        return _record(page, "failed", 0, f"{type(exc).__name__}: {exc}"), [], None
    if not isinstance(payload, dict):
        return _record(page, "failed", 0, f"unexpected payload type: {type(payload).__name__}"), [], None
    organic = payload.get("organicResults")
    if not isinstance(organic, list):
        organic = []
    results = [_normalize_result(item, page) for item in organic]
    return _record(page, "success", len(results)), results, payload


def collect(
    keyword: str,
    location: str,
    *,
    sort: Optional[str] = None,
    domain: Optional[str] = None,
    start_page: int = 1,
    max_pages: int = 10,
    call: SearchCaller,
    pages: Optional[Iterable[int]] = None,
    summary: Optional[dict] = None,
) -> dict:
    """Collect search results page by page and return a summary.

    Parameters:
        keyword, location: search terms forwarded to the invoker.
        sort, domain: optional filters forwarded to the invoker.
        start_page: first page to request in sequential mode.
        max_pages: stop after this many pages in sequential mode.
        call: injected invoker, ``call(keyword, location, page, sort, domain)``.
        pages: explicit page numbers to fetch (e.g. failed pages from a prior
            run). When given, exactly these pages are requested once each and
            ``start_page``/``max_pages`` do not apply.
        summary: an existing summary to merge into; a new one is created when
            omitted.

    Sequential mode stops when ``max_pages`` pages have been fetched, when the
    current page's ``pagination.totalPages`` has been reached, or when the
    current page returns no organic results. A failed page is recorded and
    stops the sequential run; rerun it later via ``pages=failed_pages(summary)``.
    """
    if max_pages < 1:
        raise ValueError("max_pages must be >= 1")
    if start_page < 1:
        raise ValueError("start_page must be >= 1")

    base = summary if summary is not None else _new_summary(keyword, location, sort, domain)
    records: list = []
    results: list = []

    if pages is not None:
        for page in sorted({int(p) for p in pages}):
            record, page_results, _ = _fetch_one(call, keyword, location, page, sort, domain)
            records.append(record)
            results.extend(page_results)
        return _merge(base, records, results)

    page = start_page
    fetched = 0
    while fetched < max_pages:
        record, page_results, payload = _fetch_one(call, keyword, location, page, sort, domain)
        records.append(record)
        results.extend(page_results)
        fetched += 1
        if record["status"] != "success":
            break  # failed page: stop the run; the page can be rerun via pages=[...]
        if not page_results:
            break  # empty page: nothing more to collect
        pagination = payload.get("pagination") if isinstance(payload, dict) else None
        total_pages = pagination.get("totalPages") if isinstance(pagination, dict) else None
        if isinstance(total_pages, int) and page >= total_pages:
            break
        page += 1

    return _merge(base, records, results)


def failed_pages(summary: dict) -> list:
    """Return the page numbers recorded as failed, for a targeted rerun."""
    return [r["page"] for r in summary.get("pages", []) if r.get("status") == "failed"]
