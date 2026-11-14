from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

log = logging.getLogger(__name__)

# Checking stored links is network-bound; a small pool hides most of the
# latency without hammering driveseed (which tarpits/blocks aggressive
# clients). Kept deliberately low per host.
DEFAULT_MAX_WORKERS = 4

# Dead driveseed pages return HTTP 200 with this marker in the body, e.g.:
#   <h3>404! Page Not Found</h3>
#   "The file you are trying to download is no longer available!"
# NOTE: HEAD status is meaningless here (the server 404s HEAD even for
# live links) and GET status is always 200, so only the body decides.
_DEAD_MARKERS = ("404! page not found", "no longer available")

# Plain requests get tarpitted/blocked; look like the scraper's browser.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
    ),
    "Referer": "https://driveseed.org/",
    "Accept": "text/html,application/xhtml+xml",
}


def _fetch(url: str, timeout: int):
    """GET with one retry; returns response or raises the last error."""
    try:
        return requests.get(url, timeout=timeout, allow_redirects=True, headers=_HEADERS)
    except requests.RequestException:
        return requests.get(url, timeout=timeout, allow_redirects=True, headers=_HEADERS)


def check_link(url: str, timeout: int = 15) -> str:
    """Validate a final download link: 'alive', 'dead', or 'unknown'.

    Anything ambiguous (timeouts, blocks, 5xx) is 'unknown' — never
    destroy stored data on a guess.
    """
    try:
        page = _fetch(url, timeout)
    except requests.RequestException as e:
        log.info("UNKNOWN %s (%s)", url[:80], type(e).__name__)
        return "unknown"
    if page.status_code == 404:
        return "dead"
    if page.status_code != 200:
        log.info("UNKNOWN %s (HTTP %s)", url[:80], page.status_code)
        return "unknown"
    body = page.text.lower()
    if any(marker in body for marker in _DEAD_MARKERS):
        return "dead"
    return "alive"


def _check_one(url: str, timeout: int) -> tuple[str, str | None]:
    """Return (verdict, reason) for one url; never raises.

    Unexpected errors degrade to 'unknown' so one bad link cannot abort
    the whole batch.
    """
    try:
        return check_link(url, timeout=timeout), None
    except Exception as e:  # noqa: BLE001 - batch must survive any single failure
        return "unknown", f"{type(e).__name__}: {e}"


def partition_alive(
    urls: list[str],
    timeout: int = 15,
    max_workers: int = DEFAULT_MAX_WORKERS,
) -> tuple[list[str], list[str], list[str]]:
    """Split urls into (alive, dead, unknown), logging each verdict.

    Links are checked concurrently with at most ``max_workers`` requests in
    flight; each verdict is logged as soon as it lands. Grouping happens
    afterwards in input order, so the lists never reflect completion order.
    """
    alive, dead, unknown = [], [], []
    if not urls:
        log.info("Link check: 0 alive, 0 dead, 0 unknown of 0")
        return alive, dead, unknown

    workers = max(1, min(max_workers, len(urls)))
    verdicts: list[str] = ["unknown"] * len(urls)
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="linkcheck") as pool:
        futures = {
            pool.submit(_check_one, url, timeout): index
            for index, url in enumerate(urls)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                verdict, reason = future.result()
            except Exception as e:  # noqa: BLE001 - e.g. cancelled future
                verdict, reason = "unknown", f"{type(e).__name__}: {e}"
            if verdict not in ("alive", "dead", "unknown"):
                reason = f"unexpected verdict {verdict!r}"
                verdict = "unknown"
            verdicts[index] = verdict
            if verdict == "unknown":
                # check_link already logs its own ambiguous verdicts; only
                # exceptions/unexpected values need a line from here.
                if reason:
                    log.info("UNKNOWN %s (%s)", urls[index][:80], reason)
            else:
                log.info("%s %s", verdict.upper(), urls[index][:80])

    for url, verdict in zip(urls, verdicts, strict=True):
        {"alive": alive, "dead": dead, "unknown": unknown}[verdict].append(url)
    log.info(
        "Link check: %d alive, %d dead, %d unknown of %d",
        len(alive), len(dead), len(unknown), len(urls),
    )
    return alive, dead, unknown
