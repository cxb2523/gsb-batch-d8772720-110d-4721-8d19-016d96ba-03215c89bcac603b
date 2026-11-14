#!/usr/bin/env python3
"""Batch absolute-rank collector for HasData's DuckDuckGo SERP tool.

The hosted tool returns one page at a time, and ``position`` restarts at 1 on every
page, so a rank table has to be assembled here: the number of organic results already
collected plus the position inside the current page. Paging uses the previous page's
``pagination.nextPageToken``, and the token must be sent alone, because a ``q`` beside
it is silently ignored and would make the log describe a different query from the one
actually fetched.

The input is a local JSON task list. Each task is ``{"query", "kl", "maxPages"}``.
The key comes from ``HASDATA_API_KEY``. The report is written after every task, so an
interrupted run can be resumed without paying for the pages already collected.

Run:
    HASDATA_API_KEY=... python scripts/collect_rankings.py tasks.json
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

ENDPOINT = "https://mcp.hasdata.com/mcp?apis=duckduckgo"
TOOL = "hasdata_duckduckgo_serp_getSearchResults"
API_KEY_ENV = "HASDATA_API_KEY"

REQUEST_TIMEOUT_SECONDS = 30.0
RETRY_ATTEMPTS = 4
RETRY_BASE_DELAY_SECONDS = 2.0
RETRY_MAX_DELAY_SECONDS = 30.0

AUTH_FAILED = "auth_failed"
INVALID_ARGUMENT = "invalid_argument"
RATE_LIMITED = "rate_limited"
NETWORK_TIMEOUT = "network_timeout"
OTHER = "other"

ERROR_LABELS = {
    AUTH_FAILED: "authentication failed",
    INVALID_ARGUMENT: "request rejected as invalid",
    RATE_LIMITED: "rate limited",
    NETWORK_TIMEOUT: "network timeout",
    OTHER: "other error",
}

STATUS_SUCCESS = "success"
STATUS_PARTIAL = "partial"
STATUS_FAILED = "failed"

CREDITS_PER_CALL = 10


# --------------------------------------------------------------------------- transport


@dataclass
class HttpResponse:
    """A transport-independent HTTP response."""

    status: int
    body: str


class TransportError(Exception):
    """Raised when no HTTP response could be read at all."""

    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category
        self.message = message


class ToolCallError(Exception):
    """A failed tool call, already classified for the report."""

    def __init__(self, category: str, message: str, retries: int = 0) -> None:
        super().__init__(message)
        self.category = category
        self.message = message
        self.retries = retries


class BatchInterrupted(Exception):
    """Raised when the user stops the run, carrying the partial report."""

    def __init__(self, report: Dict[str, Any]) -> None:
        super().__init__("batch interrupted")
        self.report = report


# A transport takes (url, headers, body, timeout) and returns an HttpResponse.
Transport = Callable[[str, Dict[str, str], bytes, float], HttpResponse]
Sleeper = Callable[[float], None]


def urllib_transport(url: str, headers: Dict[str, str], body: bytes, timeout: float) -> HttpResponse:
    """POST over urllib, turning HTTP error statuses into ordinary responses.

    A 401 for a missing key is a connection-level error in the MCP server, but it is
    still an HTTP response and belongs to the same classifier as a tool-level error.
    Only a failure that yields no response at all becomes a TransportError.
    """
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResponse(response.status, response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", "replace")
        except OSError:
            raw = ""
        return HttpResponse(exc.code, raw)
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
            raise TransportError(NETWORK_TIMEOUT, f"request timed out: {reason}") from exc
        raise TransportError(OTHER, f"network error: {reason}") from exc
    except (socket.timeout, TimeoutError) as exc:
        raise TransportError(NETWORK_TIMEOUT, f"request timed out: {exc}") from exc
    except OSError as exc:
        raise TransportError(OTHER, f"network error: {exc}") from exc


# --------------------------------------------------------------------- error handling


def classify_failure(*, status: Optional[int] = None, text: str = "") -> str:
    """Map an HTTP status or tool error text to one of the report categories."""
    blob = (text or "").lower()
    if status == 429 or "concurrency_limit" in blob or "too many requests" in blob or "rate limit" in blob:
        return RATE_LIMITED
    if status in (401, 403) or "401 unauthorized" in blob or "unauthorized" in blob or "invalid api key" in blob:
        return AUTH_FAILED
    if (
        status in (400, 422)
        or "-32602" in blob
        or "input validation error" in blob
        or "validation error" in blob
        or "invalid params" in blob
    ):
        return INVALID_ARGUMENT
    if "timed out" in blob or "timeout" in blob:
        return NETWORK_TIMEOUT
    return OTHER


def _content_text(result: Dict[str, Any]) -> str:
    """Return ``result.content[0].text``.

    The server puts the payload in the first text block, so that block is what gets
    read. A non-text first block falls back to the first text block that follows,
    which keeps a protocol-level oddity from discarding a usable answer.
    """
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            return block["text"]
    return ""


def parse_rpc_response(raw: str, request_id: int) -> Dict[str, Any]:
    """Pull the JSON-RPC message for ``request_id`` out of a JSON or SSE body.

    A streamable HTTP response is either one JSON document or SSE, where several
    events can precede the answer and one event can span several ``data:`` lines.
    """
    text = raw.strip()
    if not text:
        raise ValueError("empty response body")
    messages: List[Any] = []
    if text.startswith("{") or text.startswith("["):
        parsed = json.loads(text)
        messages = parsed if isinstance(parsed, list) else [parsed]
    else:
        for block in re.split(r"\r?\n\r?\n+", text):
            data = "\n".join(
                line[5:].lstrip(" ") for line in block.splitlines() if line.startswith("data:")
            )
            if not data or data == "[DONE]":
                continue
            try:
                messages.append(json.loads(data))
            except json.JSONDecodeError:
                # A keep-alive or a partial event is not the answer.
                continue
    for message in messages:
        if isinstance(message, dict) and message.get("id") == request_id:
            return message
    raise ValueError(f"no JSON-RPC message with id {request_id}")


def payload_from_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """Unwrap result.content[0].text, then the ``json`` field inside that text."""
    error = message.get("error")
    if error:
        detail = json.dumps(error) if not isinstance(error, str) else error
        raise ToolCallError(classify_failure(text=detail), f"JSON-RPC error: {detail}")
    result = message.get("result")
    if not isinstance(result, dict):
        raise ToolCallError(OTHER, "response carried no result object")
    if result.get("isError"):
        detail = _content_text(result) or "tool reported isError without a message"
        raise ToolCallError(classify_failure(text=detail), detail.strip())
    text = _content_text(result)
    if not text.strip():
        raise ToolCallError(OTHER, "tool result carried no text content")
    try:
        envelope = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ToolCallError(OTHER, f"tool result text is not JSON: {exc}") from exc
    if not isinstance(envelope, dict):
        return {}
    payload = envelope.get("json")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return {}
    return payload if isinstance(payload, dict) else {}


def call_tool(
    transport: Transport,
    api_key: str,
    arguments: Dict[str, Any],
    request_id: int,
    timeout: float,
) -> Dict[str, Any]:
    """One ``tools/call``, unwrapped down to the scraped ``json`` payload."""
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": TOOL, "arguments": arguments},
        }
    ).encode("utf-8")
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    try:
        response = transport(ENDPOINT, headers, body, timeout)
    except TransportError as exc:
        raise ToolCallError(exc.category, exc.message) from exc
    except Exception as exc:  # noqa: BLE001 - one bad task must not abort the batch
        raise ToolCallError(OTHER, f"transport failed: {exc}") from exc
    if response.status >= 400:
        detail = response.body.strip()[:500] or "(no response body)"
        category = classify_failure(status=response.status, text=response.body)
        raise ToolCallError(category, f"HTTP {response.status}: {detail}")
    try:
        message = parse_rpc_response(response.body, request_id)
    except (ValueError, json.JSONDecodeError) as exc:
        raise ToolCallError(OTHER, f"unreadable response: {exc}") from exc
    return payload_from_message(message)


def fetch_page(
    transport: Transport,
    api_key: str,
    arguments: Dict[str, Any],
    *,
    request_ids: "itertools.count[int]",
    timeout: float,
    sleep: Sleeper,
    retry_attempts: int,
    retry_base_delay: float,
    retry_max_delay: float,
) -> Tuple[Dict[str, Any], int]:
    """Fetch one page, retrying ``concurrency_limit`` with a growing wait.

    Returns ``(payload, retries_used)``. Authentication failures and every other
    category fail on the first attempt; only rate limiting is retried.
    """
    retries = 0
    while True:
        try:
            return (
                call_tool(transport, api_key, arguments, next(request_ids), timeout),
                retries,
            )
        except ToolCallError as exc:
            if exc.category != RATE_LIMITED or retries >= retry_attempts:
                exc.retries = retries
                raise
            delay = min(retry_base_delay * (2 ** retries), retry_max_delay)
            sleep(delay)
            retries += 1


# ------------------------------------------------------------------------- collection


def _organic_entries(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries = payload.get("organicResults")
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def _next_token(payload: Dict[str, Any]) -> Optional[str]:
    pagination = payload.get("pagination")
    if not isinstance(pagination, dict):
        return None
    token = pagination.get("nextPageToken")
    return token if isinstance(token, str) and token else None


def collect_task(
    task: Dict[str, Any],
    *,
    transport: Transport,
    api_key: str,
    sleep: Sleeper = time.sleep,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
    retry_attempts: int = RETRY_ATTEMPTS,
    retry_base_delay: float = RETRY_BASE_DELAY_SECONDS,
    retry_max_delay: float = RETRY_MAX_DELAY_SECONDS,
) -> Dict[str, Any]:
    """Collect up to ``maxPages`` pages for one task and return its outcome record.

    A failed page never discards earlier pages: the results collected so far, the
    pages that succeeded and the failing page number all stay in the record.
    """
    query = task["query"]
    kl = task["kl"]
    max_pages = task["maxPages"]

    results: List[Dict[str, Any]] = []
    pages_succeeded: List[int] = []
    notes: List[str] = []
    seen_tokens: set[str] = set()
    request_ids = itertools.count(1)
    token: Optional[str] = None
    has_next_page = False
    truncated = False
    failure: Optional[Dict[str, Any]] = None
    total_retries = 0

    pages_collected = 0
    while pages_collected < max_pages:
        page_number = pages_collected + 1
        # First page carries q and kl. Every later page carries the token alone:
        # the token wins over q silently, so sending both would mislabel the run.
        arguments: Dict[str, Any] = (
            {"q": query, "kl": kl} if page_number == 1 else {"nextPageToken": token}
        )
        try:
            payload, retries = fetch_page(
                transport,
                api_key,
                arguments,
                request_ids=request_ids,
                timeout=timeout,
                sleep=sleep,
                retry_attempts=retry_attempts,
                retry_base_delay=retry_base_delay,
                retry_max_delay=retry_max_delay,
            )
        except ToolCallError as exc:
            total_retries += exc.retries
            failure = {
                "page": page_number,
                "category": exc.category,
                "message": exc.message,
                "retries": exc.retries,
            }
            break
        total_retries += retries
        pages_collected += 1
        pages_succeeded.append(page_number)

        offset = len(results)
        for index, entry in enumerate(_organic_entries(payload)):
            position = entry.get("position")
            if isinstance(position, bool) or not isinstance(position, int) or position < 1:
                # Missing or malformed position: fall back to the entry's place on
                # the page so the row still gets a stable rank.
                position = index + 1
            results.append(
                {
                    "absoluteRank": offset + position,
                    "page": page_number,
                    "position": position,
                    "title": entry.get("title"),
                    "link": entry.get("link"),
                    "displayedLink": entry.get("displayedLink"),
                    "snippet": entry.get("snippet"),
                }
            )

        next_token = _next_token(payload)
        if next_token is None:
            has_next_page = False
            break
        if next_token in seen_tokens:
            has_next_page = False
            notes.append(
                f"page {page_number} repeated a nextPageToken; stopped to avoid a loop"
            )
            break
        seen_tokens.add(next_token)
        token = next_token
        has_next_page = True

    if has_next_page and pages_collected >= max_pages:
        truncated = True
        notes.append(f"stopped at maxPages={max_pages} while a next page existed")

    if failure is None:
        status = STATUS_SUCCESS
    elif pages_succeeded:
        status = STATUS_PARTIAL
    else:
        status = STATUS_FAILED

    outcome: Dict[str, Any] = {
        "id": task.get("id"),
        "query": query,
        "kl": kl,
        "maxPages": max_pages,
        "status": status,
        "pagesCollected": pages_collected,
        "resultsCollected": len(results),
        "truncatedByMaxPages": truncated,
        # After a failed page the presence of a next page is unknown, so it is not
        # reported as either true or false.
        "hasNextPage": None if failure else has_next_page,
        "pagesSucceeded": list(pages_succeeded),
        "failedPage": failure["page"] if failure else None,
        "errorCategory": failure["category"] if failure else None,
        "errorLabel": ERROR_LABELS[failure["category"]] if failure else None,
        "errorMessage": failure["message"] if failure else None,
        "failedPageRetries": failure["retries"] if failure else None,
        "rateLimitRetries": total_retries,
        "creditsEstimate": pages_collected * CREDITS_PER_CALL,
        "results": results,
        "notes": notes,
    }
    return outcome


# ----------------------------------------------------------------------- task loading


def load_tasks(path: Path) -> List[Dict[str, Any]]:
    """Read and validate the task list. Accepts a bare list or ``{"tasks": [...]}``."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read task list {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"task list {path} is not valid JSON: {exc}") from exc

    if isinstance(raw, dict):
        raw = raw.get("tasks")
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"task list {path} must be a non-empty JSON array")

    tasks: List[Dict[str, Any]] = []
    seen_keys: Dict[Tuple[str, str, int], int] = {}
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"task #{index} is not an object")
        query = item.get("query")
        kl = item.get("kl")
        max_pages = item.get("maxPages")
        if not isinstance(query, str) or not query.strip():
            raise ValueError(f"task #{index} needs a non-empty string query")
        if not isinstance(kl, str) or not kl.strip():
            raise ValueError(f"task #{index} needs a non-empty string kl")
        if isinstance(max_pages, bool) or not isinstance(max_pages, int) or max_pages < 1:
            raise ValueError(f"task #{index} needs an integer maxPages >= 1")
        key = (query, kl, max_pages)
        if key in seen_keys:
            # Resume keys off (query, kl, maxPages), so two identical tasks would
            # overwrite each other's record.
            raise ValueError(
                f"task #{index} repeats task #{seen_keys[key]} "
                f"(query={query!r}, kl={kl!r}, maxPages={max_pages})"
            )
        seen_keys[key] = index
        tasks.append(
            {
                "id": item.get("id", index),
                "query": query,
                "kl": kl,
                "maxPages": max_pages,
            }
        )
    return tasks


def task_key(task: Dict[str, Any]) -> Tuple[str, str, int]:
    return (task["query"], task["kl"], task["maxPages"])


# ------------------------------------------------------------------------- reporting


def _write_report(path: Optional[Path], report: Dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replace, so an interrupted run never leaves a half-written report that
    # the next run then refuses to resume from.
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def describe_outcome(record: Dict[str, Any]) -> str:
    pages = f"{record['pagesCollected']}/{record['maxPages']} page(s)"
    results = f"{record['resultsCollected']} result(s)"
    status = record["status"].upper()
    if record["status"] == STATUS_SUCCESS:
        if record["truncatedByMaxPages"]:
            tail = "truncated at maxPages; a next page was available"
        else:
            tail = "reached the last page"
        return f"{status} - {pages}, {results}; {tail}"
    if record["status"] == STATUS_PARTIAL:
        tail = (
            f"failed at page {record['failedPage']} "
            f"({record['errorLabel']}); succeeded pages: {record['pagesSucceeded']}"
        )
        return f"{status} - {pages}, {results}; {tail}"
    return (
        f"{status} - failed at page {record['failedPage']} "
        f"({record['errorLabel']}): {record['errorMessage']}"
    )


def print_summary(report: Dict[str, Any], stream: Any = None) -> None:
    stream = stream or sys.stdout
    records = report.get("tasks", [])
    stream.write("\nCollection summary\n")
    stream.write("------------------\n")
    for index, record in enumerate(records, start=1):
        stream.write(
            f"{index}. id={record['id']} query={record['query']!r} kl={record['kl']}: "
            f"{describe_outcome(record)}\n"
        )
        for note in record.get("notes") or []:
            stream.write(f"   note: {note}\n")
    counts = {STATUS_SUCCESS: 0, STATUS_PARTIAL: 0, STATUS_FAILED: 0}
    for record in records:
        counts[record["status"]] = counts.get(record["status"], 0) + 1
    pages = sum(record["pagesCollected"] for record in records)
    results = sum(record["resultsCollected"] for record in records)
    credits = sum(record["creditsEstimate"] for record in records)
    stream.write(
        f"\nTotals: {counts[STATUS_SUCCESS]} success, {counts[STATUS_PARTIAL]} partial, "
        f"{counts[STATUS_FAILED]} failed; {pages} page(s), {results} result(s), "
        f"~{credits} credits.\n"
    )
    if report.get("interrupted"):
        stream.write("Run was interrupted; re-run the same command to resume.\n")


def run_batch(
    tasks: Sequence[Dict[str, Any]],
    *,
    transport: Transport,
    api_key: str,
    out_path: Optional[Path],
    prior_records: Optional[Sequence[Dict[str, Any]]] = None,
    retry_failed: bool = False,
    sleep: Sleeper = time.sleep,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
    retry_attempts: int = RETRY_ATTEMPTS,
    retry_base_delay: float = RETRY_BASE_DELAY_SECONDS,
    retry_max_delay: float = RETRY_MAX_DELAY_SECONDS,
    log: Callable[[str], None] = print,
    now: Optional[Callable[[], str]] = None,
) -> Dict[str, Any]:
    """Collect every task, checkpointing after each one.

    ``prior_records`` makes the run resumable: a task whose ``(query, kl, maxPages)``
    already has a record is skipped, so an interrupted batch does not pay twice.
    Failed records are skipped too unless ``retry_failed`` is set.
    """
    now = now or (lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    prior_by_key: Dict[Tuple[str, str, int], Dict[str, Any]] = {}
    for record in prior_records or []:
        if isinstance(record, dict) and {"query", "kl", "maxPages"} <= record.keys():
            prior_by_key[task_key(record)] = record

    report: Dict[str, Any] = {
        "endpoint": ENDPOINT,
        "tool": TOOL,
        "startedAt": now(),
        "finishedAt": None,
        "interrupted": False,
        "tasks": [],
    }
    records_by_key: Dict[Tuple[str, str, int], Dict[str, Any]] = {}
    total = len(tasks)

    for index, task in enumerate(tasks, start=1):
        key = task_key(task)
        prior = prior_by_key.get(key)
        if prior is not None and (prior.get("status") == STATUS_SUCCESS or not retry_failed):
            # Carry the prior record forward, but retag it to the current task id so a
            # renamed id in an updated task list still shows up correctly.
            carried = dict(prior)
            carried["id"] = task["id"]
            carried["fromPreviousRun"] = True
            records_by_key[key] = carried
            log(
                f"[{index}/{total}] id={task['id']} query={task['query']!r} "
                f"kl={task['kl']}: skipped (already recorded)"
            )
            _checkpoint(out_path, report, tasks, records_by_key, now)
            continue
        log(
            f"[{index}/{total}] id={task['id']} query={task['query']!r} "
            f"kl={task['kl']} maxPages={task['maxPages']}"
        )
        try:
            outcome = collect_task(
                task,
                transport=transport,
                api_key=api_key,
                sleep=sleep,
                timeout=timeout,
                retry_attempts=retry_attempts,
                retry_base_delay=retry_base_delay,
                retry_max_delay=retry_max_delay,
            )
        except KeyboardInterrupt:
            # Keep every finished task on disk and say the run was cut short.
            report["interrupted"] = True
            report["finishedAt"] = now()
            _checkpoint(out_path, report, tasks, records_by_key, now)
            raise BatchInterrupted(report)
        records_by_key[key] = outcome
        log(f"    {describe_outcome(outcome)}")
        _checkpoint(out_path, report, tasks, records_by_key, now)

    report["finishedAt"] = now()
    _checkpoint(out_path, report, tasks, records_by_key, now)
    return report


def _checkpoint(
    out_path: Optional[Path],
    report: Dict[str, Any],
    tasks: Sequence[Dict[str, Any]],
    records_by_key: Dict[Tuple[str, str, int], Dict[str, Any]],
    now: Callable[[], str],
) -> None:
    report["tasks"] = [records_by_key[task_key(task)] for task in tasks if task_key(task) in records_by_key]
    report["updatedAt"] = now()
    _write_report(out_path, report)


def load_prior_report(path: Path) -> List[Dict[str, Any]]:
    """Return task records from an earlier report; an unreadable report is an error."""
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(
            f"existing report {path} is unreadable ({exc}); move it away or pass --fresh"
        ) from exc
    tasks = raw.get("tasks") if isinstance(raw, dict) else None
    if not isinstance(tasks, list):
        raise ValueError(f"existing report {path} has no tasks array; pass --fresh to overwrite")
    return tasks


# ------------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Collect keyword x region rankings page by page and record absolute rank "
            "across pages."
        )
    )
    parser.add_argument("tasks", type=Path, help="JSON task list: [{query, kl, maxPages}, ...]")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="report path (default: <tasks>.results.json)",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="ignore an existing report and collect every task again",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="re-run tasks whose earlier record is partial or failed",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=REQUEST_TIMEOUT_SECONDS,
        help=f"per-request timeout in seconds (default: {REQUEST_TIMEOUT_SECONDS:g})",
    )
    parser.add_argument(
        "--retry-attempts",
        type=int,
        default=RETRY_ATTEMPTS,
        help=f"extra attempts after a rate limit (default: {RETRY_ATTEMPTS})",
    )
    parser.add_argument(
        "--retry-base-delay",
        type=float,
        default=RETRY_BASE_DELAY_SECONDS,
        help=f"first rate-limit wait, doubled per attempt (default: {RETRY_BASE_DELAY_SECONDS:g}s)",
    )
    parser.add_argument(
        "--retry-max-delay",
        type=float,
        default=RETRY_MAX_DELAY_SECONDS,
        help=f"cap on a single rate-limit wait (default: {RETRY_MAX_DELAY_SECONDS:g}s)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    args = build_parser().parse_args(argv)

    api_key = os.environ.get(API_KEY_ENV)
    if not api_key:
        sys.stderr.write(
            f"{API_KEY_ENV} is not set. Create a free key at https://app.hasdata.com and set it.\n"
        )
        return 2

    try:
        tasks = load_tasks(args.tasks)
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2

    out_path: Path = args.out if args.out is not None else args.tasks.with_suffix(".results.json")
    prior_records: List[Dict[str, Any]] = []
    if not args.fresh:
        try:
            prior_records = load_prior_report(out_path)
        except ValueError as exc:
            sys.stderr.write(f"{exc}\n")
            return 2

    try:
        report = run_batch(
            tasks,
            transport=urllib_transport,
            api_key=api_key,
            out_path=out_path,
            prior_records=prior_records,
            retry_failed=args.retry_failed,
            timeout=args.timeout,
            retry_attempts=max(0, args.retry_attempts),
            retry_base_delay=args.retry_base_delay,
            retry_max_delay=args.retry_max_delay,
        )
    except KeyboardInterrupt:
        sys.stderr.write("\nInterrupted. The report holds every finished task; re-run to resume.\n")
        return 130
    except BatchInterrupted as exc:
        print_summary(exc.report)
        sys.stderr.write("\nInterrupted. The report holds every finished task; re-run to resume.\n")
        return 130

    print_summary(report)
    sys.stdout.write(f"\nReport written to {out_path}\n")
    return 0 if all(record["status"] == STATUS_SUCCESS for record in report["tasks"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
