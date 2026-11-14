"""
SPIDER CRAWL — Deep Recursive Site Intelligence & Secrets Harvester VX.1 (Zero-Mock Native)
Performs depth-controlled recursive crawling (depth 2-3) within domain boundaries,
harvests high-value API keys and credentials (AWS, GitHub, Stripe, OpenAI, Anthropic, RSA, JWT),
probes sensitive endpoints (/.env, /.git/HEAD, etc.), and aggregates internal/external forensic assets.
"""
from __future__ import annotations

import asyncio
import re
import urllib.request
import urllib.error
from urllib.parse import urlparse, urljoin, urlunparse
from typing import Dict, Any, List, Set, Optional, Tuple

# Maximum number of unvisited entries surfaced in crawl_status["unvisited"].
MAX_UNVISITED_REPORTED = 50

# Verified Secret Regex Signatures
SECRET_PATTERNS = {
    "AWS_ACCESS_KEY": re.compile(r'AKIA[0-9A-Z]{16}'),
    "AWS_SECRET_KEY": re.compile(r'(?i)aws(.{0,20})?(?:key|secret|token)\s*[:=]\s*["\']([A-Za-z0-9/+=]{40})["\']'),
    "GITHUB_PAT": re.compile(r'(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}'),
    "GITHUB_FINE_GRAINED": re.compile(r'github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}'),
    "STRIPE_LIVE_KEY": re.compile(r'sk_live_[0-9a-zA-Z]{24,}'),
    "OPENAI_API_KEY": re.compile(r'sk-(?:proj-)?[a-zA-Z0-9_\-]{32,70}'),
    "ANTHROPIC_API_KEY": re.compile(r'sk-ant-[a-zA-Z0-9_\-]{32,95}'),
    "GOOGLE_API_KEY": re.compile(r'AIza[0-9A-Za-z\-_]{35}'),
    "PRIVATE_KEY_BLOCK": re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    "JWT_TOKEN": re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
    "SLACK_TOKEN": re.compile(r'xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}'),
}

SENSITIVE_PATHS = [
    "/.env",
    "/.git/HEAD",
    "/.git/config",
    "/wp-config.php.bak",
    "/robots.txt",
    "/sitemap.xml",
    "/.well-known/security.txt",
    "/config.json",
    "/server-status"
]

EMAIL_RE = re.compile(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+')
PHONE_RE = re.compile(r'(?:\+?[0-9]{1,3}[-.\s]?)?\(?[0-9]{2,4}\)?[-.\s]?[0-9]{3,4}[-.\s]?[0-9]{3,4}')
LINK_RE = re.compile(r'href=["\'](https?://[^"\']+|/[^"\']*)["\']', re.IGNORECASE)
ENDPOINT_RE = re.compile(r'["\'](/api/v[0-9]/[^"\']+|/api/[^"\']+|/v[0-9]/[^"\']+)["\']')


def _canon_url(url: str) -> str:
    """Canonicalize a URL for dedup: lowercase scheme/host, empty path -> '/',
    drop fragment. Prevents 'http://host' and 'http://host/' (or '#'-variants)
    from being crawled as distinct pages."""
    p = urlparse(url)
    path = p.path or "/"
    return urlunparse((p.scheme.lower(), p.netloc.lower(), path, "", p.query, ""))


def _fetch_sync(url: str, timeout: int = 5) -> Tuple[int, str, dict]:
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "TheBigBrother-Forensics/7.0 (Spider Crawl Harvester; +https://thebigbrother.cloud)",
                "Accept": "text/html,application/json,text/plain,*/*"
            }
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            headers = dict(resp.headers)
            return resp.status, text, headers
    except urllib.error.HTTPError as e:
        return e.code, "", {}
    except Exception:
        return 0, "", {}


def _normalize_pending_entry(entry: Any, default_depth: int = 0) -> Optional[Tuple[str, int]]:
    """Accept a pending entry as a plain URL string or a crawl_status unvisited
    record ({"url": ..., "depth": ...}) and normalize to (url, depth)."""
    if isinstance(entry, str):
        url, depth = entry, default_depth
    elif isinstance(entry, dict):
        url = entry.get("url")
        if not url:
            return None
        try:
            depth = int(entry.get("depth", default_depth))
        except (TypeError, ValueError):
            depth = default_depth
    else:
        return None
    url = _canon_url(url.strip())
    if not url.startswith(("http://", "https://")):
        return None
    return url, max(0, depth)


async def spider_crawl(
    target_url: str,
    max_depth: int = 2,
    max_pages: int = 20,
    pending_urls: Optional[List[Any]] = None,
    skip_urls: Optional[List[str]] = None,
) -> Dict[str, Any]:
    target_url = target_url.strip()
    if not target_url.startswith(("http://", "https://")):
        target_url = "https://" + target_url

    parsed = urlparse(target_url)
    target_domain = parsed.netloc.lower()

    visited_urls: Set[str] = set()
    failed_urls: Set[str] = set()
    previously_fetched: Set[str] = {_canon_url(u.strip()) for u in (skip_urls or [])
                                    if isinstance(u, str) and u.strip()}

    if pending_urls is not None:
        # Resume mode: seed the queue exclusively with the unvisited entries
        # reported by a previous run; never re-fetch previously visited pages.
        crawl_queue: List[Tuple[str, int]] = []
        seen_seed: Set[str] = set()
        for entry in pending_urls:
            norm = _normalize_pending_entry(entry)
            if not norm:
                continue
            url, depth = norm
            if url in previously_fetched or url in seen_seed:
                continue
            seen_seed.add(url)
            crawl_queue.append((url, depth))
    else:
        crawl_queue = [(_canon_url(target_url), 0)]

    enqueued: Set[str] = {u for u, _ in crawl_queue}
    fetch_failures: List[Dict[str, Any]] = []

    discovered_secrets: List[Dict[str, Any]] = []
    discovered_emails: Set[str] = set()
    discovered_phones: Set[str] = set()
    discovered_endpoints: Set[str] = set()
    external_links: Set[str] = set()
    crawl_log: List[str] = []

    loop = asyncio.get_event_loop()

    crawl_log.append(f"[START] Initializing recursive harvest on {target_url} (Domain: {target_domain})")
    if pending_urls is not None:
        crawl_log.append(f"[RESUME] Seeded queue with {len(crawl_queue)} pending URL(s); "
                         f"{len(previously_fetched)} previously fetched URL(s) will be skipped")

    # 1. Recursive Link Walker & Secrets Extractor
    while crawl_queue and len(visited_urls) < max_pages:
        curr_url, depth = crawl_queue.pop(0)
        if curr_url in visited_urls or curr_url in failed_urls or curr_url in previously_fetched:
            continue

        crawl_log.append(f"[CRAWL:D{depth}] Requesting {curr_url}")
        status, content, headers = await loop.run_in_executor(None, _fetch_sync, curr_url, 5)
        if status != 200 or not content:
            # Failed pages are NOT counted as visited; record them for the report.
            failed_urls.add(curr_url)
            fetch_failures.append({
                "url": curr_url,
                "depth": depth,
                "reason": "fetch_failed",
                "http_status": status
            })
            crawl_log.append(f"[FETCH_FAILED] {curr_url} -> HTTP {status}")
            continue
        visited_urls.add(curr_url)

        # Extract Secrets
        for sec_name, pattern in SECRET_PATTERNS.items():
            for m in pattern.finditer(content):
                val = m.group(0)
                # Mask sensitive middle characters
                masked = val[:6] + "..." + val[-4:] if len(val) > 12 else val[:3] + "..."
                discovered_secrets.append({
                    "type": sec_name,
                    "masked_value": masked,
                    "source_url": curr_url,
                    "severity": "CRITICAL" if "KEY" in sec_name or "TOKEN" in sec_name else "HIGH"
                })
                crawl_log.append(f"[SECRET_ALERT] Found {sec_name} on {curr_url}")

        # Extract Emails & Phones
        for em in EMAIL_RE.findall(content):
            if not any(em.endswith(ext) for ext in [".png", ".jpg", ".svg", ".css", ".js"]):
                discovered_emails.add(em)
        for ph in PHONE_RE.findall(content):
            if len(re.sub(r'\D', '', ph)) >= 8:
                discovered_phones.add(ph.strip())

        # Extract Internal Endpoints
        for ep in ENDPOINT_RE.findall(content):
            discovered_endpoints.add(ep)

        # Extract Links for Next Depth
        if depth < max_depth:
            for m in LINK_RE.finditer(content):
                href = m.group(1)
                full = _canon_url(urljoin(curr_url, href))
                u_parsed = urlparse(full)
                if u_parsed.netloc.lower() == target_domain:
                    # Ignore binary media assets
                    if not any(full.lower().endswith(ext) for ext in [".png", ".jpg", ".gif", ".pdf", ".zip", ".mp4", ".mp3"]):
                        if (full not in visited_urls and full not in failed_urls
                                and full not in previously_fetched and full not in enqueued):
                            enqueued.add(full)
                            crawl_queue.append((full, depth + 1))
                elif u_parsed.scheme in ("http", "https"):
                    external_links.add(full)

    # 1b. Collection accounting — what was not crawled, and why.
    # Remaining queue entries (only present when the page budget cut the crawl
    # short) are reported in queue order; failed fetches are reported in the
    # order they occurred. A URL appears at most once across the whole list.
    budget_remaining: List[Dict[str, Any]] = []
    if crawl_queue:
        crawl_log.append(f"[BUDGET_EXHAUSTED] Page budget {max_pages} reached with "
                         f"{len(crawl_queue)} link(s) still queued")
        seen_remaining: Set[str] = set()
        for q_url, q_depth in crawl_queue:
            if (q_url in visited_urls or q_url in failed_urls
                    or q_url in previously_fetched or q_url in seen_remaining):
                continue
            seen_remaining.add(q_url)
            budget_remaining.append({
                "url": q_url,
                "depth": q_depth,
                "reason": "budget_exhausted",
                "http_status": None
            })

    unvisited_all: List[Dict[str, Any]] = fetch_failures + budget_remaining
    unvisited_total = len(unvisited_all)
    crawl_status = {
        "completed": not fetch_failures and not budget_remaining,
        "visited_count": len(visited_urls),
        "queued_remaining": len(budget_remaining),
        "visited_urls": sorted(visited_urls),
        "unvisited": unvisited_all[:MAX_UNVISITED_REPORTED],
        "unvisited_total": unvisited_total,
        "truncated": unvisited_total > MAX_UNVISITED_REPORTED
    }
    crawl_log.append(
        f"[CRAWL_STATUS] completed={crawl_status['completed']} "
        f"visited={crawl_status['visited_count']} "
        f"queued_remaining={crawl_status['queued_remaining']} "
        f"fetch_failed={len(fetch_failures)}"
    )

    # 2. Sensitive Path Probing
    crawl_log.append(f"[PATH_AUDIT] Concurrently auditing {len(SENSITIVE_PATHS)} critical paths...")
    path_tasks = []
    for sp in SENSITIVE_PATHS:
        probe_url = urljoin(f"{parsed.scheme}://{target_domain}", sp)
        path_tasks.append((sp, probe_url))

    async def _audit_path(sp, url):
        st, body, _ = await loop.run_in_executor(None, _fetch_sync, url, 4)
        is_exposed = False
        notes = f"HTTP {st}"
        if st == 200:
            if sp == "/.env" and ("DB_" in body or "API_" in body or "=" in body):
                is_exposed = True
                notes = "CONFIRMED_ENV_VARIABLES_EXPOSED"
            elif sp == "/.git/HEAD" and "ref: refs/" in body:
                is_exposed = True
                notes = "CONFIRMED_GIT_REPOSITORY_EXPOSED"
            elif sp == "/robots.txt" and "Disallow:" in body:
                is_exposed = True
                notes = "DISCLOSED_CRAWL_RESTRICTIONS"
            elif sp == "/.well-known/security.txt":
                is_exposed = True
                notes = "SECURITY_TXT_PRESENT"
            else:
                is_exposed = True
                notes = "ENDPOINT_ACCESSIBLE"

        return {
            "path": sp,
            "url": url,
            "status_code": st,
            "exposed": is_exposed,
            "audit_note": notes
        }

    path_results = await asyncio.gather(*[_audit_path(sp, u) for sp, u in path_tasks])

    exposed_secrets_cnt = len(discovered_secrets)
    exposed_paths_cnt = len([p for p in path_results if p["exposed"] and p["path"] in ("/.env", "/.git/HEAD", "/wp-config.php.bak")])

    threat_score = min(100, (exposed_secrets_cnt * 30) + (exposed_paths_cnt * 35) + 10)
    risk_level = "CRITICAL_COMPROMISE" if threat_score >= 70 else ("ELEVATED_SURFACE" if threat_score >= 35 else "NOMINAL")

    return {
        "status": "success",
        "target": target_url,
        "domain": target_domain,
        "pages_crawled": len(visited_urls),
        "threat_score": threat_score,
        "risk_level": risk_level,
        "exposed_secrets": discovered_secrets,
        "security_path_audit": path_results,
        "internal_assets": {
            "emails": list(discovered_emails)[:30],
            "phone_numbers": list(discovered_phones)[:15],
            "api_endpoints": list(discovered_endpoints)[:40],
            "external_links_count": len(external_links)
        },
        "crawl_status": crawl_status,
        "crawl_log": crawl_log
    }


async def spider_crawl_resume(
    target_url: str,
    pending_urls: List[Any],
    max_depth: int = 2,
    max_pages: int = 20,
    skip_urls: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Resume an incomplete crawl: fetch only the unvisited URLs reported by a
    previous run's crawl_status["unvisited"] (plain URL strings are accepted
    too). URLs listed in skip_urls (previously fetched pages) are never
    requested again. Returns a fresh result including a new crawl_status."""
    return await spider_crawl(
        target_url,
        max_depth=max_depth,
        max_pages=max_pages,
        pending_urls=pending_urls,
        skip_urls=skip_urls,
    )
