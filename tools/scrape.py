#!/usr/bin/env python3
"""Decodo Scraper OpenClaw Skill: search Google, Amazon search/product, scrape URL, YouTube subtitles, Reddit post or subreddit.

Supports a single-task CLI (backward compatible) and a batch entry point. All
failures are classified with a stable ``error_category`` so automation can
react programmatically instead of parsing free-text tracebacks:

* ``missing_credentials``   -- DECODO_AUTH_TOKEN is not set
* ``invalid_parameters``    -- unknown target, missing/mismatched query/url, ...
* ``request_failed``        -- transport error or HTTP status outside 2xx
* ``invalid_response``      -- response body is not valid JSON
* ``response_structure_error`` -- JSON parsed but required fields are missing

All parameter/credential validation happens before any network request.
"""

import argparse
import json
import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

SCRAPE_URL = "https://scraper-api.decodo.com/v2/scrape"
REQUEST_TIMEOUT = 120

TARGETS_NEED_QUERY = ("google_search", "amazon_search", "youtube_subtitles")
TARGETS_NEED_URL = ("universal", "amazon", "reddit_post", "reddit_subreddit")
ALL_TARGETS = TARGETS_NEED_QUERY + TARGETS_NEED_URL

# Stable, machine-readable error categories. Treat these names as a public API.
ERR_MISSING_CREDENTIALS = "missing_credentials"
ERR_INVALID_PARAMETERS = "invalid_parameters"
ERR_REQUEST_FAILED = "request_failed"
ERR_INVALID_RESPONSE = "invalid_response"
ERR_RESPONSE_STRUCTURE = "response_structure_error"


class ScrapeError(Exception):
    """A classified scrape failure.

    ``category`` is one of the ``ERR_*`` constants and stays stable across
    releases; ``message`` is a human-readable explanation; ``details`` carries
    optional structured context (e.g. HTTP status code).
    """

    def __init__(self, category, message, details=None):
        super().__init__(message)
        self.category = category
        self.message = message
        self.details = details or {}

    def to_dict(self):
        obj = {"error": self.message, "error_category": self.category}
        if self.details:
            obj["details"] = self.details
        return obj


def _is_nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""


def validate_task(task):
    """Validate one task description *before* any network call.

    Raises :class:`ScrapeError` with ``invalid_parameters`` on the first
    problem. A task is a dict with ``target`` plus the ``query``/``url`` the
    target requires; ``geo``/``locale`` are only accepted for
    ``google_search``.
    """
    if not isinstance(task, dict):
        raise ScrapeError(ERR_INVALID_PARAMETERS, "Task must be a JSON object")

    target = task.get("target")
    if not _is_nonempty_string(target):
        raise ScrapeError(ERR_INVALID_PARAMETERS, "Task is missing a 'target'")
    if target not in ALL_TARGETS:
        raise ScrapeError(
            ERR_INVALID_PARAMETERS,
            f"Unknown target '{target}'. Supported targets: {', '.join(ALL_TARGETS)}",
        )

    query = task.get("query")
    url = task.get("url")
    has_query = _is_nonempty_string(query)
    has_url = _is_nonempty_string(url)

    if target in TARGETS_NEED_QUERY:
        if not has_query:
            raise ScrapeError(
                ERR_INVALID_PARAMETERS, f"Target '{target}' requires a non-empty 'query'"
            )
        if has_url:
            raise ScrapeError(
                ERR_INVALID_PARAMETERS,
                f"Target '{target}' takes 'query', not 'url'",
            )
    else:  # TARGETS_NEED_URL
        if not has_url:
            raise ScrapeError(
                ERR_INVALID_PARAMETERS, f"Target '{target}' requires a non-empty 'url'"
            )
        if has_query:
            raise ScrapeError(
                ERR_INVALID_PARAMETERS,
                f"Target '{target}' takes 'url', not 'query'",
            )

    if target != "google_search":
        for option in ("geo", "locale"):
            if task.get(option) is not None:
                raise ScrapeError(
                    ERR_INVALID_PARAMETERS,
                    f"'{option}' is only supported by target 'google_search', not '{target}'",
                )

    return True


def build_payload(task):
    """Build the Decodo API request body for a validated task.

    The seven payload shapes mirror the original single-task CLI exactly.
    """
    validate_task(task)
    target = task["target"]

    if target == "google_search":
        payload = {"target": "google_search", "query": task["query"], "headless": "html", "parse": True}
        if task.get("geo"):
            payload["geo"] = task["geo"]
        if task.get("locale"):
            payload["locale"] = task["locale"]
        return payload
    if target == "youtube_subtitles":
        return {"target": "youtube_subtitles", "query": task["query"]}
    if target == "reddit_post":
        return {"target": "reddit_post", "url": task["url"]}
    if target == "reddit_subreddit":
        return {"target": "reddit_subreddit", "url": task["url"]}
    if target == "amazon":
        return {"target": "amazon", "url": task["url"], "parse": True}
    if target == "amazon_search":
        return {"target": "amazon_search", "query": task["query"], "parse": True}
    # universal
    return {"target": "universal", "url": task["url"], "markdown": True}


def _default_transport(payload, headers):
    """Default HTTP transport; isolated so tests can inject a fake one."""
    return requests.post(SCRAPE_URL, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)


def _extract_result(target, data, raw_text):
    """Pull the actual scrape result out of the API response.

    Raises ``response_structure_error`` when the documented structure is
    missing or incomplete.
    """
    results = data.get("results") if isinstance(data, dict) else None
    if not results or not isinstance(results, list) or not isinstance(results[0], dict):
        raise ScrapeError(
            ERR_RESPONSE_STRUCTURE,
            "Response JSON is missing results[0].content",
        )
    content = results[0].get("content")
    if content is None:
        raise ScrapeError(
            ERR_RESPONSE_STRUCTURE,
            "Response JSON is missing results[0].content",
        )

    if target == "google_search":
        inner = content.get("results", {}).get("results") if isinstance(content, dict) else None
        if inner is None:
            raise ScrapeError(
                ERR_RESPONSE_STRUCTURE,
                "Could not extract google_search results; API structure may have changed",
                {"raw_response": raw_text},
            )
        return inner
    if target in ("amazon", "amazon_search"):
        inner = content.get("results") if isinstance(content, dict) else None
        if inner is None:
            raise ScrapeError(
                ERR_RESPONSE_STRUCTURE,
                f"Could not extract {target} results; API structure may have changed",
                {"raw_response": raw_text},
            )
        return inner
    # universal / youtube_subtitles / reddit_post / reddit_subreddit:
    # content itself (markdown string, transcript, or parsed JSON object).
    return content


def run_task(task, token=None, transport=None):
    """Validate and execute one task, returning the extracted result.

    Validation (and the credential check) always run before ``transport`` is
    invoked, so invalid input can never trigger a network request. Raises
    :class:`ScrapeError` with a stable category on any failure.
    """
    validate_task(task)

    if token is None:
        token = os.environ.get("DECODO_AUTH_TOKEN")
    if not _is_nonempty_string(token):
        raise ScrapeError(ERR_MISSING_CREDENTIALS, "Set DECODO_AUTH_TOKEN.")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Basic {token}",
        "x-integration": "openclaw",
    }
    payload = build_payload(task)
    transport = transport or _default_transport

    try:
        resp = transport(payload, headers)
    except ScrapeError:
        raise
    except requests.RequestException as exc:
        status_code = exc.response.status_code if getattr(exc, "response", None) is not None else None
        raise ScrapeError(
            ERR_REQUEST_FAILED,
            f"Request to scraper API failed: {exc}",
            {"status_code": status_code},
        ) from exc

    status_code = getattr(resp, "status_code", None)
    if status_code is None or not 200 <= int(status_code) < 300:
        raise ScrapeError(
            ERR_REQUEST_FAILED,
            f"Scraper API returned HTTP {status_code}",
            {"status_code": status_code},
        )

    try:
        data = resp.json()
    except ValueError as exc:  # requests raises requests.JSONDecodeError, a ValueError
        raise ScrapeError(
            ERR_INVALID_RESPONSE,
            "Response body is not valid JSON",
            {"status_code": status_code},
        ) from exc

    return _extract_result(task["target"], data, getattr(resp, "text", None))


def run_batch(tasks, token=None, transport=None):
    """Execute an ordered list of task descriptions.

    One task's failure never aborts the others. Every task is validated up
    front; invalid tasks and a missing token are reported without any network
    request. Returns ``(summary, has_failure)`` where ``summary`` is::

        {"results": [{"index": 0, "target": ..., "status": "success"|"failed",
                      "result": ... | "error": ..., "error_category": ...}, ...],
         "total": N, "succeeded": x, "failed": y}
    """
    if not isinstance(tasks, list):
        raise ScrapeError(ERR_INVALID_PARAMETERS, "Batch input must be a JSON array of task objects")

    if token is None:
        token = os.environ.get("DECODO_AUTH_TOKEN")
    token_missing = not _is_nonempty_string(token)

    summary_results = []
    has_failure = False

    for index, task in enumerate(tasks):
        target = task.get("target") if isinstance(task, dict) else None
        entry = {"index": index, "target": target}

        try:
            validate_task(task)
            if token_missing:
                raise ScrapeError(ERR_MISSING_CREDENTIALS, "Set DECODO_AUTH_TOKEN.")
            result = run_task(task, token=token, transport=transport)
        except ScrapeError as exc:
            entry["status"] = "failed"
            entry.update(exc.to_dict())
            has_failure = True
        else:
            entry["status"] = "success"
            entry["result"] = result

        summary_results.append(entry)

    summary = {
        "results": summary_results,
        "total": len(summary_results),
        "succeeded": sum(1 for item in summary_results if item["status"] == "success"),
        "failed": sum(1 for item in summary_results if item["status"] == "failed"),
    }
    return summary, has_failure


def _load_batch_tasks(batch_file):
    """Read batch tasks from a file path, or stdin when ``batch_file == '-'``."""
    if batch_file == "-":
        raw = sys.stdin.read()
        source = "stdin"
    else:
        try:
            with open(batch_file, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError as exc:
            raise ScrapeError(ERR_INVALID_PARAMETERS, f"Cannot read batch file '{batch_file}': {exc}") from exc
        source = batch_file

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ScrapeError(
            ERR_INVALID_PARAMETERS,
            f"Batch input from {source} is not valid JSON: {exc}",
        ) from exc

    if isinstance(parsed, dict) and isinstance(parsed.get("tasks"), list):
        return parsed["tasks"]
    if isinstance(parsed, list):
        return parsed
    raise ScrapeError(
        ERR_INVALID_PARAMETERS,
        "Batch input must be a JSON array of tasks or an object with a 'tasks' array",
    )


def _run_single_cli(args):
    """Backward-compatible single-task CLI; returns a process exit code."""
    task = {"target": args.target}
    if args.query is not None:
        task["query"] = args.query
    if args.url is not None:
        task["url"] = args.url
    if args.geo is not None:
        task["geo"] = args.geo
    if args.locale is not None:
        task["locale"] = args.locale

    try:
        result = run_task(task)
    except ScrapeError as exc:
        print(json.dumps(exc.to_dict()), file=sys.stderr)
        return 1

    if isinstance(result, str):
        print(result)
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


def _run_batch_cli(batch_file):
    try:
        tasks = _load_batch_tasks(batch_file)
        summary, has_failure = run_batch(tasks)
    except ScrapeError as exc:
        print(json.dumps(exc.to_dict()), file=sys.stderr)
        return 1

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if has_failure else 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Decodo Scraper OpenClaw Skill: search Google, scrape URL, Amazon, YouTube subtitles, Reddit. "
        "Use --batch-file for automated multi-task collection."
    )
    parser.add_argument(
        "--target",
        choices=list(ALL_TARGETS),
        help="Single-task target. Required unless --batch-file is used.",
    )
    parser.add_argument("--query", help="Required for google_search, amazon_search, or youtube_subtitles (video ID for YouTube).")
    parser.add_argument("--url", help="Required for universal, amazon, reddit_post, or reddit_subreddit.")
    parser.add_argument("--geo", help="Google search geo (e.g. US, GB). Only valid with google_search.")
    parser.add_argument("--locale", help="Google search locale (e.g. en, de). Only valid with google_search.")
    parser.add_argument(
        "--batch-file",
        help="Path to a JSON file of ordered task objects (or '-' for stdin). "
        "Each task: {\"target\": ..., \"query\"|\"url\": ..., optional \"geo\"/\"locale\" for google_search}. "
        "Prints one summary JSON; exit 0 if all tasks succeed, 1 if any fail.",
    )
    args = parser.parse_args(argv)

    if args.batch_file:
        if args.target or args.query or args.url or args.geo or args.locale:
            parser.error("--batch-file cannot be combined with --target/--query/--url/--geo/--locale")
        return _run_batch_cli(args.batch_file)

    if not args.target:
        parser.error("either --target or --batch-file is required")

    # Pre-network validation with classified errors (argparse still enforces choices).
    task = {"target": args.target}
    if args.query is not None:
        task["query"] = args.query
    if args.url is not None:
        task["url"] = args.url
    if args.geo is not None:
        task["geo"] = args.geo
    if args.locale is not None:
        task["locale"] = args.locale
    try:
        validate_task(task)
    except ScrapeError as exc:
        print(json.dumps(exc.to_dict()), file=sys.stderr)
        return 1

    return _run_single_cli(args)


if __name__ == "__main__":
    sys.exit(main())
