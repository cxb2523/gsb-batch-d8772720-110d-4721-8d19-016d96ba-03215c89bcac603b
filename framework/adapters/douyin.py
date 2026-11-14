#!/usr/bin/env python3
"""
douyin.py — Douyin source adapter

Translates Douyin videos into the canonical Entity/Item/Metric/Text contracts.

⚠️ Empirical notes (tested 2026-07):
- Douyin **web keyword search** enforces login server-side (status_code 2483);
  no account-layer workaround exists.
- Douyin **App feed** works unauthenticated: `aweme.snssdk.com/aweme/v1/feed/`
  returns status=0 with real videos. This adapter uses that path — no login, no QR scan.
- Douyin App **keyword search** is soft-blocked for guests (status=0 but empty results).
  Instead, this adapter uses feed pagination + keyword filtering (category filter),
  which is sufficient to infer content patterns within a niche.

Design:
- Parse layer (aweme_to_records) = pure function, no network I/O (mockable).
- Fetch layer (fetch_feed) calls the Douyin App feed unauthenticated endpoint (no signing required).
- All user objects are anonymized via compliance.scrub_user before storage.
"""
from __future__ import annotations

import json
import os
import random
import ssl
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import yaml

import compliance
from framework.adapter import Entity, Item, Metric, SourceAdapter, Text
from framework.exceptions import AdapterFetchError

PLATFORM = "douyin"

_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "douyin_selectors.yml"

# Douyin App guest UA (confirmed working, no login required)
_UA = "com.ss.android.ugc.aweme/220001 (Linux; U; Android 11)"
_BASE = "https://aweme.snssdk.com/aweme/v1/feed/"


def load_config(path: str | None = None) -> dict:
    p = path or os.environ.get("DOUYIN_SELECTORS_PATH") or _CFG_PATH
    try:
        with open(p, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Field-mapping config not found: {p}\n"
            f"Ensure framework/config/douyin_selectors.yml exists, or set DOUYIN_SELECTORS_PATH.") from None


_CFG = load_config()

# Optional category keyword filter (food niche example below); empty list = no filter
_FOOD_KW = ["吃", "美食", "火锅", "菜", "探店", "餐", "菜市", "小吃", "店",
            "烧烤", "串", "麻辣", "川", "辣", "夜市", "大排档", "做饭", "教程"]


def _match_category(desc: str, keywords: list[str]) -> bool:
    if not keywords:
        return True
    return any(k in (desc or "") for k in keywords)


# ============================================================
# Parse layer — pure functions, no network I/O (mockable)
# ============================================================

def aweme_to_records(a: dict, segment: str = "", category: str = "",
                     cfg: dict | None = None) -> tuple[Entity, Item, list[Metric], list[Text]]:
    """Douyin aweme dict → (Entity author, Item video, [Metric] likes/comments/shares/saves, [Text] caption). Anonymized."""
    cfg = cfg or _CFG
    author_raw = a.get("author", {}) or {}
    clean_user = compliance.scrub_user({
        "user_id": author_raw.get("uid") or author_raw.get("unique_id"),
        "name": author_raw.get("nickname"),
    })
    author_id = clean_user.get("anon_id", "")
    aid = a.get("aweme_id") or ""
    st = a.get("statistics", {}) or {}
    desc = a.get("desc", "") or ""

    entity = Entity(
        platform=PLATFORM, entity_id=author_id, entity_type="author",
        segment=segment, category=category,
        profile={k: clean_user[k] for k in ("fans", "follows") if k in clean_user})

    # Video type: 1=regular video, 2=image carousel; determined from the video field
    vid_obj = a.get("video", {}) or {}
    is_image = bool(a.get("images")) or a.get("aweme_type") == 68
    item_type = "image" if is_image else "video"

    item = Item(
        platform=PLATFORM, item_id=aid, entity_id=author_id, item_type=item_type,
        title=desc[:200],
        url=f"https://www.douyin.com/video/{aid}",
        published_at=str(a.get("create_time") or ""),
        segment=segment, category=category,
        meta={"cover": (vid_obj.get("origin_cover") or {}).get("url_list", [None])[0],
              "duration": vid_obj.get("duration"),
              "music": (a.get("music", {}) or {}).get("title")})

    metrics = []
    for mname, key in cfg["metrics"].items():
        val = st.get(key)
        if val is not None:
            metrics.append(Metric(PLATFORM, "item", aid, mname, float(val)))

    texts = []
    if desc.strip():
        texts.append(Text(PLATFORM, "item", aid, "desc", desc, author=author_id))

    return entity, item, metrics, texts


# ============================================================
# Fetch layer — Douyin App feed, unauthenticated endpoint (no login)
# ============================================================

class DouyinAdapter(SourceAdapter):
    platform = PLATFORM
    capabilities = {"items"}   # feed works in guest/unauthenticated mode

    def __init__(self, rate_limiter=None, category_keywords: list[str] | None = None,
                 cookies: str | None = None):
        """category_keywords: when set, only videos matching at least one keyword are kept (niche filter).
        cookies: authenticated session cookie string (from chrome_cookies.cookie_str). When provided,
                 requests use an authenticated session — more stable and higher yield (fixes guest empty returns).
                 When omitted, falls back to unauthenticated guest mode."""
        self.rl = rate_limiter or compliance.RateLimiter()
        self.cat_kw = category_keywords if category_keywords is not None else _FOOD_KW
        self.cookies = cookies

    def _build_url(self, max_cursor: int, count: int = 20) -> str:
        # Append is_login=1 for authenticated sessions (Douyin uses this to return personalized, fuller feed)
        params = (f"device_platform=android&version_name=22.0.0&channel=googleplay"
                  f"&app_name=aweme&max_cursor={max_cursor}&count={count}"
                  f"&feed_style=1&touchscreen=1")
        if self.cookies:
            params += "&is_login=1"
        return f"{_BASE}?{params}"

    def _fetch_json(self, url: str, retries: int = 3) -> dict:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        last_err = None
        headers = {"User-Agent": _UA, "Passport-SDK-Version": "11"}
        if self.cookies:                      # authenticated session: inject Cookie header
            headers["Cookie"] = self.cookies
        for attempt in range(retries):
            self.rl.wait()
            try:
                req = urllib.request.Request(url, headers=headers)
                raw = urllib.request.urlopen(req, timeout=15, context=ctx).read().decode("utf-8", "ignore")
                data = json.loads(raw)
                if data.get("status_code", 0) not in (0, None):
                    raise AdapterFetchError(f"Douyin feed status_code={data.get('status_code')}")
                return data
            except RuntimeError:
                raise
            except Exception as e:                       # noqa: BLE001
                last_err = e
                time.sleep(2 ** attempt)
        raise AdapterFetchError(f"Douyin feed fetch failed after {retries} retries: {last_err}")

    def fetch_feed(self, segment: str = "", category: str = "", limit: int = 40,
                   max_pages: int = 30) -> list[tuple[Entity, Item, list[Metric], list[Text]]]:
        """Fetch Douyin App feed (unauthenticated) → keyword-filter by niche → return records list.

        limit: target record count (post keyword filter). max_pages: page cap to prevent runaway fetching.
        """
        out: list[tuple[Entity, Item, list[Metric], list[Text]]] = []
        seen: set[str] = set()
        cursor = 0
        for _ in range(max_pages):
            if len(out) >= limit:
                break
            try:
                data = self._fetch_json(self._build_url(cursor))
            except AdapterFetchError:
                raise
            except Exception as e:
                print(f"[douyin] page err: {e}")
                time.sleep(2)
                continue
            aw = data.get("aweme_list", []) or []
            for a in aw:
                aid = a.get("aweme_id")
                if not aid or aid in seen:
                    continue
                seen.add(aid)
                desc = a.get("desc", "")
                if not _match_category(desc, self.cat_kw):
                    continue
                out.append(aweme_to_records(a, segment, category))
                if len(out) >= limit:
                    break
            if not data.get("has_more"):
                break
            cursor = data.get("max_cursor", 0)
            time.sleep(random.uniform(0.5, 1.5))
        return out[:limit]

    # Entity batch fetch — no reliable creator-list endpoint in guest mode; marked not implemented
    def fetch_entity(self, seed: dict) -> tuple[Entity, list[Metric]]:
        raise NotImplementedError("Douyin creator batch fetch requires signing + authenticated session; guest mode not implemented (good first issue)")

    def fetch_items(self, entity_id: str, limit: int = 20) -> Iterator[tuple[Item, list[Metric]]]:
        raise NotImplementedError("Douyin creator video list not available in guest mode (good first issue)")

    def fetch_by_ids(self, ids: list[str], segment: str = "", category: str = "") \
            -> list[tuple[Entity, Item, list[Metric], list[Text]]]:
        """Fetch individual video details (full statistics: saves/comments/shares) → records.

        Endpoint: aweme/v1/aweme/detail/ (single aweme_detail).
        ⚠️ This endpoint is typically soft-blocked for guest sessions (empty response);
        requires authenticated cookies for reliable full-metric retrieval.
        Pass cookies via the constructor. Parsing reuses aweme_to_records.
        """
        out: list[tuple[Entity, Item, list[Metric], list[Text]]] = []
        for vid in ids:
            try:
                url = (f"https://aweme.snssdk.com/aweme/v1/aweme/detail/"
                       f"?aweme_id={vid}&device_platform=android&version_name=22.0.0"
                       f"&channel=googleplay&app_name=aweme")
                data = self._fetch_json(url)
                a = data.get("aweme_detail")
                if not a:
                    print(f"[douyin] detail empty response (may require authenticated session): {vid}")
                    continue
                out.append(aweme_to_records(a, segment, category))
            except AdapterFetchError:
                raise
            except Exception as e:                       # noqa: BLE001 per-video failure — skip
                print(f"[douyin] detail failed {vid}: {e}")
                continue
        return out
