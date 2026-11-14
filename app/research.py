"""🔬 Deep-research discovery for Fleece Radar — free, keyless, multi-source.

Mimics a deep-research pass:
  1. diversified CN/EN queries over free search backends
     (Bing HTML · DuckDuckGo HTML/Lite · SearXNG public instances · Mojeek,
      plus Brave Search API if BRAVE_SEARCH_API_KEY is set — free tier 2k/mo)
  2. stable community feeds
     (linux.do forum via Discourse JSON · GitHub awesome-list raw READMEs ·
      dynamic GitHub repo search for new key/list repos)
  3. directory crawls (apiindex.me · apisou.com · baipiao.org · getcheapai ·
     freellm · freeaiapi · kelen.cc · apiranking)
  4. one-hop expansion: fetch promising non-gateway pages (blog posts, forum
     threads, gists, docs) and pull gateway links out of them
Every new candidate is then run through the standard passive provider scanner.
"""
from __future__ import annotations
import asyncio
import os
import re
from urllib.parse import unquote, urlparse

import httpx

from . import core

UA = os.getenv("USER_AGENT", "FleeceRadar/1.0 (passive research)")
H = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}

QUERIES = [
    "免费 GPT-6 Astra 中转 API",
    "Claude Fable 5 白嫖 API 中转",
    "免费 DeepSeek V4 Flash API 中转",
    "免费 GLM 5.3 Flash API 注册送",
    "中转站 福利 注册送 token",
    "免费 AI API 公益站 签到",
    "AI API 中转站 导航 排行榜",
    "free Claude API gateway signup credit",
    "free DeepSeek API relay no credit card",
]

DIRECTORIES = [
    "https://apiindex.me/zh/self-publish",
    "https://apisou.com/?type=公益",
    "https://baipiao.org/free/api/",
    "https://www.getcheapai.com/provider",
    "https://freellm.net/",
    "https://freeaiapi.org/",
    "https://kelen.cc/share/free-llm-api-stations",
    "https://apiranking.com/",
]

GITHUB_RAW = [
    "https://raw.githubusercontent.com/mn-api/awesome-ai-proxy/main/README.md",
    "https://raw.githubusercontent.com/guihuashaoxiang/FreeLLM-API-KeyHub/main/README.md",
    "https://raw.githubusercontent.com/AIPMAndy/FreeToken/main/README.md",
    "https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/README.md",
    "https://raw.githubusercontent.com/cuihuan/awesome-ai-gateway/main/README.md",
    "https://raw.githubusercontent.com/12britz/awesome-free-models/main/README.md",
]

SEARXNG_INSTANCES = [
    "https://searx.be",
    "https://search.bus-hit.me",
    "https://searx.tiekoetter.com",
    "https://paulgo.io",
    "https://search.ononoki.org",
    "https://priv.au",
    "https://searxng.site",
    "https://search.inetol.net",
]

URL_RE = r"https?://[^\s\)\]\"'<>]+"
SIGNUP_RE = re.compile(r"(register|sign-up|signup|aff=|ref=|注册|福利)", re.I)


# ---------------- per-source outcome tracking ----------------

STATUS_OK = "ok"            # 有结果
STATUS_EMPTY = "empty"      # 无结果
STATUS_ERROR = "error"      # 请求失败
STATUS_SKIPPED = "skipped"  # 已知来源但本轮未配置（例如缺少 API key）


class SourceSkipped(Exception):
    """The source exists but was not configured for this run (e.g. no API key)."""


def _short_error(exc) -> str:
    return f"{type(exc).__name__}: {exc}".strip()[:200]


def _gateway_candidates(urls) -> list[str]:
    """Normalized, gateway-looking URLs from one source — same filter the
    research pass applies to the combined hit list, so per-source candidate
    counts line up with ``gateway_candidates``."""
    out, seen = [], set()
    for u in urls:
        try:
            n = core.normalize_url(u)
        except Exception:
            continue
        if not n or n in seen:
            continue
        d = core.canonical_domain(n)
        if not d or not looks_like_gateway(n, d):
            continue
        seen.add(n); out.append(n)
    return out


class SourceRegistry:
    """Collects one readable outcome per attempted source.

    ``kind`` is ``search_backend`` / ``community_feed`` / ``directory``.
    Each :meth:`record` call is one attempt (e.g. one query against one
    backend); attempts are aggregated per source, so a backend that failed on
    three queries but answered on six still reports a single row — with
    ``attempts`` / ``failed_attempts`` showing the degradation.
    """

    def __init__(self):
        self._entries: dict[tuple[str, str], dict] = {}
        self._order: list[tuple[str, str]] = []

    def _entry(self, kind: str, name: str, url: str = "") -> dict:
        key = (kind, name)
        if key not in self._entries:
            e = {"kind": kind, "name": name, "status": STATUS_EMPTY,
                 "candidates": 0, "raw_results": 0,
                 "attempts": 0, "failed_attempts": 0, "error": "",
                 "_seen_urls": set(), "_seen_cands": set(), "_skipped": False}
            if url:
                e["url"] = url
            self._entries[key] = e
            self._order.append(key)
        return self._entries[key]

    def record(self, kind: str, name: str, urls=(), error=None,
               skipped: bool = False, url: str = ""):
        e = self._entry(kind, name, url)
        e["attempts"] += 1
        if skipped:
            e["_skipped"] = True
            e["error"] = _short_error(error) if error is not None else "skipped"
            return
        if error is not None:
            e["failed_attempts"] += 1
            e["error"] = _short_error(error)
            return
        e["_skipped"] = False  # a real answer supersedes an earlier "not configured"
        if e["failed_attempts"] == 0:
            e["error"] = ""
        urls = list(urls or [])
        for u in urls:
            try:
                n = core.normalize_url(u)
            except Exception:
                continue
            if n and n not in e["_seen_urls"]:
                e["_seen_urls"].add(n); e["raw_results"] += 1
        for n in _gateway_candidates(urls):
            if n not in e["_seen_cands"]:
                e["_seen_cands"].add(n); e["candidates"] += 1
        return e

    def results(self, existing: set[str] | None = None) -> list[dict]:
        """Flatten attempts into one row per source.

        ``existing`` (domains already in the DB) adds ``new_candidates`` per
        source, so the per-source gap between "grabbed" and "genuinely new"
        is visible without re-reading the whole hit list."""
        out = []
        for key in self._order:
            e = dict(self._entries[key])
            cands = e.pop("_seen_cands")
            e.pop("_seen_urls", None)
            skipped = e.pop("_skipped", False)
            if skipped:
                e["status"] = STATUS_SKIPPED
            elif e["failed_attempts"] == e["attempts"]:
                e["status"] = STATUS_ERROR
            elif e["raw_results"] > 0:
                e["status"] = STATUS_OK
            elif e["failed_attempts"] > 0:
                e["status"] = STATUS_ERROR
            else:
                e["status"] = STATUS_EMPTY
            if existing is not None:
                e["new_candidates"] = sum(
                    1 for c in cands if core.canonical_domain(c) not in existing)
            out.append(e)
        return out

    @staticmethod
    def summary(rows: list[dict]) -> dict:
        counts = {STATUS_OK: 0, STATUS_EMPTY: 0, STATUS_ERROR: 0, STATUS_SKIPPED: 0}
        for r in rows:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        return {"attempted": len(rows), "ok": counts[STATUS_OK], "empty": counts[STATUS_EMPTY],
                "error": counts[STATUS_ERROR], "skipped": counts[STATUS_SKIPPED]}


# ---------------- search backends (all free) ----------------

async def bing_search(client, q):
    await client.get("https://www.bing.com/", follow_redirects=True)  # cookie warm-up
    r = await client.get("https://www.bing.com/search", params={"q": q, "count": 20},
                         follow_redirects=True)
    r.raise_for_status()
    urls = re.findall(r'<h2[^>]*><a[^>]*href="(https?://[^"]+)"', r.text)
    return [u for u in urls if "bing.com" not in u and "microsoft.com" not in u and "go.micro" not in u]


async def ddg_search(client, q):
    out, errors, ok = [], [], 0
    endpoints = (
        ("https://html.duckduckgo.com/html/", {"q": q},
         lambda t: [unquote(u) for u in re.findall(r"uddg=([^\"&]+)", t)]),
        ("https://lite.duckduckgo.com/lite/", {"q": q},
         lambda t: re.findall(r'href="(https?://(?!duckduckgo)[^"]+)"', t)),
    )
    for url, params, parse in endpoints:
        try:
            r = await client.get(url, params=params, follow_redirects=True)
            r.raise_for_status()
            ok += 1
            out += parse(r.text)
        except Exception as e:
            errors.append(e)
    if ok == 0 and errors:
        raise errors[-1]
    return out


async def searxng_search(client, q):
    errors, ok = [], 0
    for base in SEARXNG_INSTANCES:
        try:
            r = await client.get(base + "/search",
                                 params={"q": q, "format": "json", "language": "zh"},
                                 follow_redirects=True, timeout=10)
            r.raise_for_status()
            ok += 1
            data = r.json()
            urls = [x["url"] for x in data.get("results", []) if x.get("url")]
            if urls:
                return urls
        except Exception as e:
            errors.append(e)
            continue
    if ok == 0 and errors:
        raise errors[-1]
    return []


async def mojeek_search(client, q):
    r = await client.get("https://www.mojeek.com/search", params={"q": q}, follow_redirects=True)
    r.raise_for_status()
    return re.findall(r'<a class="ob" href="(https?://[^"]+)"', r.text)


async def brave_search(client, q):
    key = os.getenv("BRAVE_SEARCH_API_KEY")
    if not key:
        raise SourceSkipped("BRAVE_SEARCH_API_KEY not set")
    r = await client.get("https://api.search.brave.com/res/v1/web/search",
                         params={"q": q, "count": 20},
                         headers={"X-Subscription-Token": key, "Accept": "application/json"})
    r.raise_for_status()
    return [x["url"] for x in r.json().get("web", {}).get("results", []) if x.get("url")]


# ---------------- community feeds ----------------

async def github_feed(client):
    """Static awesome-lists + dynamic repo search → raw READMEs → URLs."""
    urls, errors, ok = [], [], 0
    for u in GITHUB_RAW:
        try:
            r = await client.get(u, timeout=10)
            r.raise_for_status()
            ok += 1
            urls += re.findall(URL_RE, r.text)
        except Exception as e:
            errors.append(e)
    try:
        r = await client.get("https://api.github.com/search/repositories",
                             params={"q": "free llm api", "sort": "stars", "per_page": 5},
                             headers={**H, "Accept": "application/vnd.github+json"}, timeout=10)
        r.raise_for_status()
        ok += 1
        for repo in r.json().get("items", []):
            slug = f"{repo['owner']['login']}/{repo['name']}"
            for branch in ("main", "master"):
                try:
                    rr = await client.get(f"https://raw.githubusercontent.com/{slug}/{branch}/README.md",
                                          timeout=10)
                    if rr.status_code == 200:
                        ok += 1
                        urls += re.findall(URL_RE, rr.text)
                        break
                except Exception as e:
                    errors.append(e)
                    continue
    except Exception as e:
        errors.append(e)
    if ok == 0 and errors:
        raise errors[-1]
    return urls


async def linuxdo_feed(client):
    """linux.do (Discourse) — the hub where Chinese relay freebies are posted.
    Public JSON endpoints, no key: /search.json → /t/{id}.json → /raw/{tid}/{pid}."""
    r = await client.get("https://linux.do/search.json",
                         params={"q": "免费 API 中转 福利"},
                         headers={**H, "Accept": "application/json"}, timeout=15)
    r.raise_for_status()
    topics = r.json().get("topics", [])[:8]
    urls = []
    for t in topics:
        tid = t.get("id")
        if not tid:
            continue
        try:
            tr = await client.get(f"https://linux.do/t/{tid}.json",
                                  headers={**H, "Accept": "application/json"}, timeout=15)
            tr.raise_for_status()
            post_ids = tr.json().get("post_stream", {}).get("post_ids", [])[:2]
            for pid in post_ids:
                raw = await client.get(f"https://linux.do/raw/{tid}/{pid}", timeout=15)
                raw.raise_for_status()
                urls += re.findall(URL_RE, raw.text)
        except Exception:
            continue  # one unreadable topic must not sink the feed
    return urls


# (display name, module attribute) — resolved through globals() at call time so
# the backends stay monkey-patchable (tests, future backend swaps).
SEARCH_BACKENDS = [
    ("bing", "bing_search"),
    ("duckduckgo", "ddg_search"),
    ("searxng", "searxng_search"),
    ("mojeek", "mojeek_search"),
    ("brave", "brave_search"),
]


# ---------------- candidate filtering ----------------

def looks_like_gateway(url, domain):
    if any(s in domain for s in core.SKIP_NETLOCS):
        return False
    if core.DOMAIN_KW.search(domain.lstrip("www.")):
        return True
    if SIGNUP_RE.search(url):
        return True
    return False


async def deep_research(max_context_pages=15, max_scan=120):
    """Run one discovery pass.

    Every source attempted in this pass gets an entry in ``sources`` — name,
    outcome status (``ok`` / ``empty`` / ``error`` / ``skipped``), the candidate
    count it produced and, on failure, a short error string. A failing source is
    recorded and skipped; it never aborts the pass.
    """
    rows = core.list_findings(limit=100000)
    existing = {core.canonical_domain(r["url"]) for r in rows}
    raw_hits: list[str] = []
    backends_used = 0
    registry = SourceRegistry()

    async def run_source(kind, name, fn, args=(), *, url=""):
        """Await one source call and record its outcome; never raises for
        ordinary failures, so one bad source cannot sink the whole pass."""
        nonlocal backends_used
        try:
            found = await fn(client, *args)
        except SourceSkipped as e:
            registry.record(kind, name, skipped=True, error=e, url=url)
            return []
        except Exception as e:  # noqa: BLE001 — per-source outcome, not a crash
            registry.record(kind, name, error=e, url=url)
            return []
        found = list(found or [])
        registry.record(kind, name, urls=found, url=url)
        if found and kind == "search_backend":
            backends_used += 1
        return found

    async def directory_source(client, durl):
        return await core.discover_directory(durl, raise_errors=True)

    async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=H) as client:
        # phase 1 — queries × free search backends
        for q in QUERIES:
            for name, attr in SEARCH_BACKENDS:
                raw_hits += await run_source("search_backend", name, globals()[attr], (q,))
            await asyncio.sleep(0.4)
        # phase 2 — community feeds
        raw_hits += await run_source("community_feed", "github", github_feed)
        raw_hits += await run_source("community_feed", "linux.do", linuxdo_feed)
        # directories
        for durl in DIRECTORIES:
            label = urlparse(durl).netloc + urlparse(durl).path.rstrip("/")
            raw_hits += await run_source("directory", label or durl,
                                         directory_source, (durl,), url=durl)

    cands: list[str] = []
    seen: set[str] = set()
    duplicate_in_round = 0
    invalid_or_non_gateway = 0
    for u in raw_hits:
        u = u.strip().rstrip('.,;:)')
        try:
            n = core.normalize_url(u)
        except Exception:
            invalid_or_non_gateway += 1
            continue
        if not n:
            invalid_or_non_gateway += 1
            continue
        d = core.canonical_domain(n)
        if not d or not looks_like_gateway(n, d):
            invalid_or_non_gateway += 1
            continue
        if n in seen:
            duplicate_in_round += 1
            continue
        seen.add(n)
        cands.append(n)

    known_domain_skipped = sum(1 for c in cands if core.canonical_domain(c) in existing)
    new_cands = [c for c in cands if core.canonical_domain(c) not in existing]
    new_before_expansion = len(new_cands)
    provider_domains = {core.canonical_domain(c) for c in new_cands}

    # phase 3 — one-hop expansion: pull gateway links out of non-gateway pages
    # (blog posts, forum threads, gists, docs, comparison sites)
    expanded: list[str] = []
    pages = 0
    async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=H) as client2:
        for u in cands:
            if pages >= max_context_pages:
                break
            d = core.canonical_domain(u)
            if d in provider_domains:
                continue  # the gateway itself is already a candidate
            try:
                r = await client2.get(u)
                pages += 1
                for x in core.extract_urls(r.text):
                    xd = core.canonical_domain(x)
                    if xd in existing or xd in provider_domains:
                        continue
                    if looks_like_gateway(x, xd):
                        expanded.append(x)
            except Exception:
                continue
    expansion_added = 0
    cset = set(cands)
    for e in dict.fromkeys(expanded):
        if e not in cset:
            cset.add(e)
            cands.append(e)
            new_cands.append(e)
            expansion_added += 1

    to_scan = list(dict.fromkeys(new_cands))[:max_scan]
    scanned = await core.scan_many(to_scan, "discovery") if to_scan else []

    sources = registry.results(existing=existing)
    return {
        "queries": QUERIES,
        "directories": DIRECTORIES,
        "search_backends_with_results": backends_used,
        "raw_hits": len(raw_hits),
        "gateway_candidates": len(cands),
        "new_candidates": len(new_cands),
        "context_pages_expanded": pages,
        "scanned": len(to_scan),
        "alive": sum(1 for f in scanned if f.alive),
        "new_domains": sorted({core.canonical_domain(u) for u in to_scan}),
        "sources": sources,
        "source_summary": SourceRegistry.summary(sources),
        "dedup": {
            "raw_hits": len(raw_hits),
            "invalid_or_non_gateway": invalid_or_non_gateway,
            "duplicate_in_round": duplicate_in_round,
            "unique_gateway_candidates": len(cands) - expansion_added,
            "already_known_domain_skipped": known_domain_skipped,
            "new_before_expansion": new_before_expansion,
            "expansion_added": expansion_added,
            "new_candidates_total": len(new_cands),
            "not_scanned_due_to_max_scan": max(0, len(dict.fromkeys(new_cands)) - len(to_scan)),
        },
        "generated_at": core.utcnow(),
    }


# ---------------- synthesis: the "deep research" digest ----------------

def research_report_md() -> str:
    rows = core.list_findings(limit=100000)
    alive = [r for r in rows if r["alive"]]
    L = []
    L.append("# 🐑 Fleece Radar — research digest  (薅羊毛雷达)")
    L.append(f"\nGenerated: {core.utcnow()}")
    L.append("")
    L.append(f"- Providers tracked: **{len(rows)}**")
    L.append(f"- Alive: **{len(alive)}**")
    L.append(f"- Free-tier evidence (免费/注册送/签到/free…): **{sum(1 for r in alive if r['free_evidence'])}**")
    L.append(f"- Live model lists confirmed via /models: **{sum(1 for r in alive if r['api_models'])}**")
    L.append(f"- Discovered by the radar itself: **{sum(1 for r in rows if r['source'] == 'discovery')}**")

    L.append("\n## Target model coverage")
    L.append("\n*verified* = present in the provider's own /models response; *claim* = marketing copy only.")
    for m in core.TARGET_MODELS:
        pat = core.MODEL_PATTERNS[m]
        verified = [r["domain"] for r in alive
                    if r["api_models"] and any(re.search(pat, mid, re.I) for mid in r["api_models"])]
        claimed = [r["domain"] for r in alive
                   if m in r["models_claimed"] and r["domain"] not in verified]
        L.append(f"\n### {m}")
        L.append(f"- **verified live** ({len(verified)}): {', '.join(verified) or '—'}")
        L.append(f"- claim only ({len(claimed)}): {', '.join(claimed[:15]) or '—'}")

    L.append("\n## Top 20 providers by score")
    L.append("\n| score | provider | live models | free evidence | base_url |")
    L.append("|---|---|---|---|---|")
    for r in sorted(alive, key=lambda x: -x["score"])[:20]:
        base = core.api_base_url(r).replace("|", "/")
        L.append(f"| {r['score']} | {r['domain']} | {len(r['api_models'])} | "
                 f"{', '.join(r['free_evidence'][:3]) or '—'} | {base} |")

    mirrors = core.alias_groups()
    if mirrors:
        L.append("\n## Mirror groups (one gateway, many domains)")
        for t, ds in mirrors.items():
            L.append(f"- **{t}** → {', '.join(ds)}")

    new = sorted((r for r in rows if r["source"] == "discovery"), key=lambda x: -x["score"])[:20]
    if new:
        L.append("\n## Newest radar discoveries")
        for r in new:
            L.append(f"- {r['domain']} (score {r['score']}, alive={int(r['alive'])})")

    L.append("\n## ⚠️ Risk notes")
    L.append("- Model **names** on relays are not proof of model **identity** — official GPT-6 Astra /")
    L.append("  Fable 5 / Opus 5 are metered and expensive; 'free unlimited' relays use promos,")
    L.append("  shared accounts or relabels.")
    L.append("- Unofficial relays log your prompts. Never route credentials, private repos or")
    L.append("  confidential data through them. Register with unique passwords; skip OAuth where possible.")
    L.append("- Free relay endpoints die weekly — re-run **Deep research** regularly; this digest is a")
    L.append("  snapshot at generation time.")
    return "\n".join(L)
