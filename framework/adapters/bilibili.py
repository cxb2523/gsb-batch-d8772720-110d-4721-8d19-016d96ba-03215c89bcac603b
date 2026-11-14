#!/usr/bin/env python3
"""
bilibili.py — Bilibili source adapter

Translates Bilibili videos into the canonical Entity/Item/Metric/Text contracts,
demonstrating that "adding a platform means writing one adapter":
the 5-table schema, store, four-dimensional analysis, and collect_rate all reuse unchanged;
this file only handles the Bilibili API → contract translation.

Bilibili advantage: most web APIs require no signing and no login (public data, direct access),
with none of the anti-scraping overhead of Xiaohongshu or Douyin.

Bilibili-specific signals:
- collect_count (favorite): saves — same long-tail value signal as Xiaohongshu
- ⭐ coin_count: coins — Bilibili-exclusive; users spend a finite resource, making it a stronger
  endorsement signal than likes
- danmaku_count: danmaku (bullet comments) — Bilibili-exclusive real-time engagement density

⚠️ Parse layer (video_to_records) = pure function, mockable; fetch layer (fetch_*) calls Bilibili's public APIs.
"""
from __future__ import annotations

import json
import os
import ssl
import time
import urllib.request
from pathlib import Path

import yaml

import compliance
from framework.adapter import Entity, Item, Metric, SourceAdapter, Text
from framework.exceptions import AdapterFetchError

PLATFORM = "bilibili"

_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "bilibili_selectors.yml"
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_API = "https://api.bilibili.com"


def load_config(path: str | None = None) -> dict:
    """Load field-mapping config. On Bilibili schema changes, only config/bilibili_selectors.yml needs updating."""
    p = path or os.environ.get("BILI_SELECTORS_PATH") or _CFG_PATH
    try:
        with open(p, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Field-mapping config not found: {p}\nEnsure framework/config/bilibili_selectors.yml exists, or set BILI_SELECTORS_PATH.") from None


_CFG = load_config()


# ============================================================
# Parse layer — pure functions, no network I/O (mockable)
# ============================================================

def video_to_records(v: dict, segment: str = "", category: str = "", cfg: dict | None = None):
    """Bilibili video dict → (Entity creator, Item video, [Metric] views/likes/coins/saves/shares/comments/danmaku, [Text] description). Anonymized."""
    cfg = cfg or _CFG
    owner = v.get("owner", {}) or {}
    clean_user = compliance.scrub_user({"user_id": owner.get("mid"), "name": owner.get("name")})
    author_id = clean_user.get("anon_id", "")
    stat = v.get("stat", {}) or {}
    bvid = v.get("bvid") or ""

    entity = Entity(
        platform=PLATFORM, entity_id=author_id, entity_type="up",
        segment=segment, category=category)

    item = Item(
        platform=PLATFORM, item_id=bvid, entity_id=author_id, item_type="video",
        title=(v.get("title") or "")[:200],
        url=f"https://www.bilibili.com/video/{bvid}",
        published_at=str(v.get("pubdate") or ""),
        segment=segment, category=category,
        meta={"cover": v.get("pic"), "tname": v.get("tname"), "duration": v.get("duration")})

    # Bilibili metrics: saves / coins (exclusive) / danmaku (exclusive) are all first-class signals; mapping from config
    metrics = []
    for mname, key in cfg["metrics"].items():
        val = stat.get(key)
        if val is not None:
            metrics.append(Metric(PLATFORM, "item", bvid, mname, float(val)))

    texts = []
    desc = v.get("desc") or ""
    if desc.strip():
        texts.append(Text(PLATFORM, "item", bvid, "desc", desc, author=author_id))

    return entity, item, metrics, texts


# ============================================================
# Fetch layer — Bilibili public APIs (no signing, no login)
# ============================================================

class BilibiliAdapter(SourceAdapter):
    platform = PLATFORM
    capabilities = {"items"}            # popular feed / single video; creator profile (fetch_items) pending wbi signing

    def __init__(self, rate_limiter=None):
        self.rl = rate_limiter or compliance.RateLimiter()

    def _fetch_json(self, url: str, retries: int = 3) -> dict:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        last_err = None
        for attempt in range(retries):
            self.rl.wait()
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": _UA, "Referer": "https://www.bilibili.com/"})
                raw = urllib.request.urlopen(req, timeout=15, context=ctx).read().decode("utf-8", "ignore")
                data = json.loads(raw)
                if data.get("code") not in (0, None):     # Bilibili: code != 0 means failure (e.g. -412 rate-limit)
                    raise AdapterFetchError(f"Bilibili API code={data.get('code')}: {data.get('message')}")
                return data
            except RuntimeError:
                raise
            except Exception as e:                          # noqa: BLE001 transient network error, retry
                last_err = e
                time.sleep(2 ** attempt)
        raise AdapterFetchError(f"Bilibili fetch failed after {retries} retries: {last_err}")

    def fetch_popular(self, segment: str = "", category: str = "", limit: int = 20):
        """Fetch Bilibili popular videos (no signing, no login) → [(Entity, Item, [Metric], [Text]), ...]."""
        data = self._fetch_json(f"{_API}/x/web-interface/popular?ps={min(limit, 50)}&pn=1")
        vids = (data.get("data") or {}).get("list", [])[:limit]
        return [video_to_records(v, segment, category) for v in vids]

    def fetch_video(self, bvid: str, segment: str = "", category: str = ""):
        """Fetch a single video (view API, no signing required) → records."""
        data = self._fetch_json(f"{_API}/x/web-interface/view?bvid={bvid}")
        v = data.get("data")
        return video_to_records(v, segment, category) if v else None

    # Creator profile batch fetch — pending wbi signing implementation
    def fetch_entity(self, seed: dict) -> tuple[Entity, list[Metric]]:
        raise NotImplementedError("Creator profile fetch pending wbi signing implementation")

    def fetch_items(self, entity_id: str, limit: int = 20):
        raise NotImplementedError("Creator video list pending wbi signing implementation")
