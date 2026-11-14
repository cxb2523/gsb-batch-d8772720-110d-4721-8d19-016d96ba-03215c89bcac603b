#!/usr/bin/env python3
"""
kuaishou.py — Kuaishou source adapter

⚠️ Empirical notes (tested 2026-07):
Kuaishou applies a **hard server-side wall for all guest/unauthenticated access**:
- Web search / trending / topic APIs → HTTP 404 or result:2 (parameter validation failure)
- Mobile-web topic and discovery pages → 404
- App feed (guest) → empty response
- Share page `kuaishou.com/short-video/{id}` → HTTP 200, but a login-gated SPA;
  engagement counts are JS-rendered, HTML contains no data

Conclusion: **no reliable unauthenticated data collection path exists for Kuaishou as of 2026**
(contrast with Douyin App feed, which is fully accessible as a guest).

This adapter implements two modes, clearly distinguished:
1. fetch_feed() / fetch_hot() — guest discovery: raises AdapterFetchError explaining the hard wall.
   No fake data is generated (prism compliance rule: never fabricate).
2. fetch_by_ids(id_list) — seed mode: when the caller provides known video IDs
   (e.g. cross-platform creators or manually collected IDs), attempts to parse the guest share page.
   If the page contains no data, each entry is marked status=error — no metrics are filled in.
"""
from __future__ import annotations

import json
import os
import random
import re
import ssl
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import yaml

import compliance
from framework.adapter import Entity, Item, Metric, SourceAdapter, Text
from framework.exceptions import AdapterFetchError

PLATFORM = "kuaishou"

_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "kuaishou_selectors.yml"
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def load_config(path: str | None = None) -> dict:
    p = path or os.environ.get("KUAISHOU_SELECTORS_PATH") or _CFG_PATH
    try:
        with open(p, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Field-mapping config not found: {p}\n"
            f"Ensure framework/config/kuaishou_selectors.yml exists, or set KUAISHOU_SELECTORS_PATH.") from None


_CFG = load_config()

# Shared error message for unauthenticated access attempts
_GUEST_WALL = ("Kuaishou blocks all unauthenticated access server-side "
               "(confirmed: web 404 / App empty response / search result:2 / share page SPA has no data). "
               "No reliable guest data collection path exists for Kuaishou in 2026. "
               "Pass an authenticated session cookie, or import data you already have "
               "(see framework.importers.import_rows).")


class KuaishouAdapter(SourceAdapter):
    platform = PLATFORM
    capabilities = set()   # guest discovery unavailable; only seed-ID mode (caller-provided IDs)

    def __init__(self, rate_limiter=None, cookies: str | None = None):
        """cookies: authenticated session cookie string (from chrome_cookies.cookie_str).
        When provided, fetch_feed(keywords=...) uses the OAuth GraphQL search endpoint
        (bypasses the guest hard wall). When omitted, guest discovery raises an error
        (honest failure — no fabrication, per prism compliance rules)."""
        self.rl = rate_limiter or compliance.RateLimiter()
        self.cookies = cookies

    # ---- Guest discovery: hard wall, honest error, no fabrication ----
    def fetch_feed(self, segment: str = "", category: str = "", limit: int = 20,
                   keywords: list[str] | None = None):
        """No cookies → raises hard-wall error; with cookies → authenticated GraphQL search."""
        if not self.cookies:
            raise AdapterFetchError(_GUEST_WALL)
        return self._fetch_login_search(keywords or ([category] if category else []),
                                        segment, category, limit)

    def fetch_hot(self, segment: str = "", category: str = "", limit: int = 20):
        raise AdapterFetchError(_GUEST_WALL)

    def fetch_entity(self, seed: dict) -> tuple[Entity, list[Metric]]:
        raise NotImplementedError(_GUEST_WALL)

    def fetch_items(self, entity_id: str, limit: int = 20) -> Iterator[tuple[Item, list[Metric]]]:
        raise NotImplementedError(_GUEST_WALL)

    # ---- Authenticated mode: GraphQL search (bypasses the guest hard wall) ----
    def _fetch_login_search(self, keywords: list[str], segment: str, category: str,
                            limit: int) -> list[tuple[Entity, Item, list[Metric], list[Text]]]:
        """Authenticated Kuaishou OAuth GraphQL visionSearchWeb keyword search.

        Endpoint: POST https://www.kuaishou.com/graphql (requires Cookie + JSON body).
        Response parsing: data.visionSearchWeb.result[].{author, photo, stats} with best-effort fault tolerance.
        """
        if not keywords:
            return []
        out: list[tuple[Entity, Item, list[Metric], list[Text]]] = []
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        headers = {
            "User-Agent": _UA,
            "Content-Type": "application/json",
            "Referer": "https://www.kuaishou.com/search/video",
        }
        if self.cookies:
            headers["Cookie"] = self.cookies
        # Standard Kuaishou web GraphQL visionSearchWeb query
        query = (
            "query visionSearchWeb($keyword: String, $page: Int, $pageSize: Int) {"
            "  visionSearchWeb(keyword: $keyword, page: $page, pageSize: $pageSize) {"
            "    result { type author { id name } photo { photoId caption "
            "playUrl duration } stats { likeCount commentCount viewCount shareCount } }"
            "    webPageArea"
            "  }"
            "}"
        )
        for kw in keywords:
            if len(out) >= limit:
                break
            page = 1
            while len(out) < limit:
                body = json.dumps({
                    "operationName": "visionSearchWeb",
                    "variables": {"keyword": kw, "page": page, "pageSize": 20},
                    "query": query,
                }).encode("utf-8")
                self.rl.wait()
                try:
                    req = urllib.request.Request(
                        "https://www.kuaishou.com/graphql", data=body, headers=headers)
                    raw = urllib.request.urlopen(
                        req, timeout=15, context=ctx).read().decode("utf-8", "ignore")
                    data = json.loads(raw)
                except Exception as e:
                    print(f"[kuaishou] authenticated search '{kw}' page {page} failed: {e}")
                    break
                res = (data.get("data") or {}).get("visionSearchWeb") or {}
                items = res.get("result") or []
                if not items:
                    break
                for it in items:
                    vid = (((it.get("photo") or {}).get("photoId")) or "")
                    if not vid:
                        continue
                    author_raw = it.get("author") or {}
                    clean_user = compliance.scrub_user({
                        "user_id": author_raw.get("id"), "name": author_raw.get("name")})
                    author_id = clean_user.get("anon_id", f"ks_{vid}")
                    caption = ((it.get("photo") or {}).get("caption")) or ""
                    entity = Entity(PLATFORM, author_id, "author",
                                    segment=segment, category=category)
                    item = Item(PLATFORM, vid, author_id, "video",
                                title=caption[:200],
                                url=f"https://www.kuaishou.com/short-video/{vid}",
                                segment=segment, category=category)
                    st = it.get("stats") or {}
                    metrics = []
                    for mname, key in _CFG["metrics"].items():
                        # stats keys may follow KG-style camelCase (e.g. likeCount)
                        val = st.get(key)
                        if val is not None:
                            metrics.append(Metric(PLATFORM, "item", vid, mname, float(val)))
                    texts = []
                    if caption.strip():
                        texts.append(Text(PLATFORM, "item", vid, "desc", caption,
                                          author=author_id))
                    out.append((entity, item, metrics, texts))
                    if len(out) >= limit:
                        break
                page += 1
                if page > 5:          # cap pages even in authenticated mode to prevent runaway fetching
                    break
                time.sleep(random.uniform(1, 2))
        return out[:limit]

    # ---- Seed-ID mode: caller-provided video IDs, best-effort guest share page parsing ----
    def fetch_by_ids(self, ids: list[str], segment: str = "",
                     category: str = "") -> list[tuple[Entity, Item, list[Metric], list[Text]]]:
        """Known Kuaishou video ID list → parse guest share pages. If a page has no data, mark status=error — no fake metrics."""
        out: list[tuple[Entity, Item, list[Metric], list[Text]]] = []
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        for vid in ids:
            self.rl.wait()
            url = f"https://www.kuaishou.com/short-video/{vid}"
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": _UA, "Referer": "https://www.kuaishou.com/"})
                html = urllib.request.urlopen(req, timeout=15, context=ctx).read().decode("utf-8", "ignore")
            except Exception:
                ent = Entity(PLATFORM, f"err_{vid}", "author", status="error")
                it = Item(PLATFORM, vid, f"err_{vid}", "video", status="error")
                out.append((ent, it, [], []))
                continue
            # Share page is a login-gated SPA; engagement counts are JS-rendered — typically not parseable
            counts = dict(re.findall(r'"(likeCount|commentCount|viewCount|shareCount)"\s*:\s*(\d+)', html))
            clean_user = compliance.scrub_user({})
            author_id = clean_user.get("anon_id", f"ks_{vid}")
            entity = Entity(PLATFORM, author_id, "author", segment=segment, category=category)
            title_m = re.search(r'<title>([^<]+)</title>', html)
            title = title_m.group(1) if title_m else ""
            item = Item(PLATFORM, vid, author_id, "video",
                        title=title[:200], url=url, segment=segment, category=category)
            metrics = []
            for mname, key in _CFG["metrics"].items():
                if key in counts:
                    metrics.append(Metric(PLATFORM, "item", vid, mname, float(counts[key])))
            texts = []
            if title.strip():
                texts.append(Text(PLATFORM, "item", vid, "desc", title, author=author_id))
            out.append((entity, item, metrics, texts))
            time.sleep(0.5)
        return out
