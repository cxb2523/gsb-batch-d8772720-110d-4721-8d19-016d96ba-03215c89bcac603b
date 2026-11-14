#!/usr/bin/env python3
"""
xhs.py — Xiaohongshu (RED) source adapter

Translates Xiaohongshu notes into the canonical Entity/Item/Metric/Text contracts.
Fetch layer reuses the existing xhs skill core: cookies + note page request
→ window.__INITIAL_STATE__ parsing.

Design notes:
- Parse layer (parse_initial_state / extract_note / note_to_records) = pure functions,
  no network I/O — testable with mock data. Fetch layer (fetch_*) requires cookies
  → validated in Phase 0.3.
- Xiaohongshu specifics: collect count is the primary signal (not likes) /
  note type (image|video) / topic tags / cover image.
- All user objects are anonymized via compliance.scrub_user before storage.

⚠️ interactInfo field names (likedCount/collectedCount...) are inferred from the
   existing xhs skill; verify against real keys in Phase 0.3 (Xiaohongshu may rename them).
"""
from __future__ import annotations

import json
import os
import re
import ssl
import time
import urllib.parse
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import yaml

import compliance
from framework.adapter import Entity, Item, Metric, SourceAdapter, Text
from framework.exceptions import AdapterFetchError

PLATFORM = "xhs"

_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "xhs_selectors.yml"


def load_config(path=None) -> dict:
    """Load field-mapping config. On Xiaohongshu schema changes, only config/xhs_selectors.yml
    needs updating — this file stays untouched.
    Path priority: explicit path > env var XHS_SELECTORS_PATH > default _CFG_PATH."""
    p = path or os.environ.get("XHS_SELECTORS_PATH") or _CFG_PATH
    try:
        with open(p, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Field-mapping config not found: {p}\n"
            f"Ensure framework/config/xhs_selectors.yml exists, or set XHS_SELECTORS_PATH.") from None


_CFG = load_config()
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


# ============================================================
# Parse layer — pure functions, no network I/O (mockable)
# ============================================================

def parse_initial_state(html: str, cfg: dict | None = None) -> dict | None:
    """Extract window.__INITIAL_STATE__ JSON from a note page HTML. Regex comes from config."""
    cfg = cfg or _CFG
    m = re.search(cfg["initial_state"]["regex"], html, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1).replace('undefined', 'null'))
    except Exception:
        return None


def _dig(d, path):
    for k in path:
        d = d[k]
    return d


def extract_note(state: dict | None, note_id: str = "", cfg: dict | None = None) -> dict | None:
    """Extract the current note from __INITIAL_STATE__. Paths come from config.
    Prefers note_id / currentNoteId to avoid picking up recommended notes."""
    cfg = cfg or _CFG
    ist = cfg["initial_state"]
    try:
        nm = _dig(state, ist["note_map_path"])
        try:
            cur = _dig(state, ist["current_id_path"])
        except (KeyError, TypeError):
            cur = ""
        key = note_id or cur or next(iter(nm))
        if key not in nm:
            key = next(iter(nm))
        return nm[key]['note']
    except (KeyError, StopIteration, TypeError):
        return None


def _num(v):
    """Normalize Xiaohongshu engagement counts to float.
    Values may arrive as Chinese-unit strings: '1.2万' (×10k), '1.2亿' (×100M), or '999+'."""
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        v = v.strip().lstrip('+').rstrip('+').replace(',', '')
        for unit, mult in (('亿', 1e8), ('万', 1e4)):
            if v.endswith(unit):
                try:
                    return float(v[:-1]) * mult
                except ValueError:
                    return None
        try:
            return float(v)
        except ValueError:
            return None
    return None


def note_to_records(note: dict, segment: str = "", category: str = "", cfg: dict | None = None):
    """Xiaohongshu note → (Entity author, Item note, [Metric] likes/saves/comments/shares, [Text] desc). Anonymized."""
    cfg = cfg or _CFG
    clean_user = compliance.scrub_user(note.get('user', {}) or {})
    author_id = clean_user.get('anon_id', '')
    inter = note.get('interactInfo', {}) or {}
    note_id = note.get('noteId') or note.get('id') or ''

    entity = Entity(
        platform=PLATFORM, entity_id=author_id, entity_type="author",
        segment=segment, category=category,
        profile={k: clean_user[k] for k in ('fans', 'follows', 'notes') if k in clean_user})

    img_list = note.get('imageList') or []
    cover = img_list[0].get('urlDefault') if img_list and isinstance(img_list[0], dict) else None
    tags = [t.get('name') for t in (note.get('tagList') or [])
            if isinstance(t, dict) and t.get('name')]
    item = Item(
        platform=PLATFORM, item_id=note_id, entity_id=author_id, item_type="note",
        title=(note.get('title') or '')[:200],
        url=f"https://www.xiaohongshu.com/explore/{note_id}",
        published_at=str(note.get('time') or ''),
        segment=segment, category=category,
        meta={"note_type": note.get('type'), "cover": cover, "tags": tags})    # image | video

    # Xiaohongshu core: collect (saves) and like are both first-class metrics
    metrics = []
    for mname, key in cfg["metrics"].items():     # field mapping from config (update yml on schema change)
        val = _num(inter.get(key))
        if val is not None:
            metrics.append(Metric(PLATFORM, "item", note_id, mname, val))

    texts = []
    desc = note.get('desc') or ''
    if desc.strip():
        clean = re.sub(r'#([^#\[]+)\[话题\]#', r'#\1', desc)        # strip #xxx[话题]# topic markers
        texts.append(Text(PLATFORM, "item", note_id, "desc", clean, author=author_id))

    return entity, item, metrics, texts


# ============================================================
# Fetch layer — requires cookies (interface form confirmed in Phase 0.3)
# ============================================================

class XHSAdapter(SourceAdapter):
    platform = PLATFORM
    capabilities = {"entities", "items"}   # comments: planned for a later phase

    def __init__(self, cookies_path: str = "~/cookies.json",
                 chrome_profile: str | None = None, rate_limiter=None):
        """Two cookie sources, pick one:
        - chrome_profile: auto-read and decrypt from a local Chrome profile (macOS, e.g. 'Default')
        - cookies_path:   manually exported cookies.json (portable, platform-agnostic)
        chrome_profile takes priority when set."""
        self.cookies_path = os.path.expanduser(cookies_path)
        self.chrome_profile = chrome_profile
        self.rl = rate_limiter or compliance.RateLimiter()

    def _cookie_str(self) -> str:
        if self.chrome_profile:                          # auto-read + decrypt from local Chrome profile
            from framework.chrome_cookies import cookie_str
            return cookie_str(self.chrome_profile, "xiaohongshu", ("web_session", "a1"))
        with open(self.cookies_path) as f:               # fallback: manual cookies.json
            return '; '.join(f"{c['name']}={c['value']}" for c in json.load(f))

    def _fetch_html(self, url: str, retries: int = 3) -> str:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        last_err = None
        for attempt in range(retries):
            self.rl.wait()                                          # rate limiting + daily cap
            try:
                req = urllib.request.Request(
                    url, headers={"Cookie": self._cookie_str(), "User-Agent": _UA})
                html = urllib.request.urlopen(req, timeout=15, context=ctx).read().decode('utf-8', 'ignore')
                if '__INITIAL_STATE__' not in html and ('登录' in html or 'login' in html.lower()):
                    raise AdapterFetchError("Cookie appears expired (redirected to login). Re-export ~/cookies.json.")
                return html
            except RuntimeError:
                raise                                               # cookie expiry is fatal — don't retry
            except Exception as e:                                  # noqa: BLE001 transient network error, retry
                last_err = e
                time.sleep(2 ** attempt)                            # exponential backoff: 1/2/4s
        raise AdapterFetchError(f"Fetch failed after {retries} retries: {last_err}")

    def fetch_note_by_url(self, url: str, segment: str = "", category: str = ""):
        """Fetch a single note (reuses existing xhs single-post logic) → records. Requires cookies."""
        state = parse_initial_state(self._fetch_html(url))
        note = extract_note(state) if state else None
        return note_to_records(note, segment, category) if note else None

    @staticmethod
    def _detail_url(note_id: str, xsec_token: str = "") -> str:
        """Build a note detail URL. Notes from the feed require xsec_token — without it the detail page returns no data."""
        u = f"https://www.xiaohongshu.com/explore/{note_id}"
        return f"{u}?xsec_token={xsec_token}&xsec_source=pc_feed" if xsec_token else u

    def fetch_feed(self, segment: str = "", category: str = "", limit: int = 20):
        """Fetch the homepage recommendation feed → visit each note's detail page for full metrics (including saves).

        ⚠️ The feed list only exposes like counts. **Save counts require a detail-page request.**
        Each detail page is fetched individually, throttled by RateLimiter.
        Returns [(Entity, Item, [Metric], [Text]), ...].
        """
        state = parse_initial_state(self._fetch_html("https://www.xiaohongshu.com/explore"))
        feeds = (state or {}).get("feed", {}).get("feeds", [])[:limit]
        out = []
        for f in feeds:
            nc = f.get("noteCard", {})
            if not nc.get("type"):                       # skip placeholders / ads
                continue
            nid, token = f.get("id"), f.get("xsecToken", "")
            try:
                note = extract_note(parse_initial_state(self._fetch_html(self._detail_url(nid, token))), nid)
                if note:
                    out.append(note_to_records(note, segment, category))
            except RuntimeError:                         # daily cap / cookie expiry is fatal — don't swallow (would silently return incomplete data)
                raise
            except Exception:                            # noqa: BLE001 transient per-note error — skip, don't abort the batch
                continue
        return out

    def fetch_search(self, keywords: list[str], segment: str = "", category: str = "",
                     limit: int = 20) -> list[tuple[Entity, Item, list[Metric], list[Text]]]:
        """Keyword search on Xiaohongshu (not limited to the homepage feed) → visit each note's detail page
        for full metrics (including saves).

        Endpoint: GET https://www.xiaohongshu.com/search_result?keyword={kw}&source=web_search
        Parses the search-page __INITIAL_STATE__ feeds (same structure as homepage feed:
        noteCard + id + xsecToken). Keywords are searched one at a time, throttled by RateLimiter.
        Returns a list of records.
        """
        out: list[tuple[Entity, Item, list[Metric], list[Text]]] = []
        for kw in keywords:
            if len(out) >= limit:
                break
            try:
                url = (f"https://www.xiaohongshu.com/search_result"
                       f"?keyword={urllib.parse.quote(kw)}&source=web_search")
                state = parse_initial_state(self._fetch_html(url))
            except RuntimeError:
                raise                                            # cookie expiry is fatal
            except Exception as e:                               # noqa: BLE001 search page fetch failed — skip this keyword
                print(f"[xhs] Search '{kw}' page fetch failed: {e}")
                continue
            feeds = ((state or {}).get("feeds") or (state or {}).get("note", {}).get("feeds")
                     or (state or {}).get("search", {}).get("feeds") or [])[:limit]
            for f in feeds:
                if len(out) >= limit:
                    break
                nc = f.get("noteCard") or f.get("note") or {}
                if not nc.get("type"):                           # skip placeholders / ads
                    continue
                nid = f.get("id") or (nc.get("id"))
                token = f.get("xsecToken") or (nc.get("xsecToken") or "")
                if not nid:
                    continue
                try:
                    note = extract_note(parse_initial_state(self._fetch_html(self._detail_url(nid, token))), nid)
                    if note:
                        out.append(note_to_records(note, segment, category))
                except RuntimeError:
                    raise
                except Exception:                                # noqa: BLE001 transient per-note error — skip
                    continue
        return out[:limit]

    # Author profile batch fetch — implement after Phase 0.3 confirms whether it's __INITIAL_STATE__ or a signed API
    def fetch_entity(self, seed: dict) -> tuple[Entity, list[Metric]]:
        raise NotImplementedError("Author profile batch fetch pending Phase 0.3 validation (R1: may require a signed API)")

    def fetch_items(self, entity_id: str, limit: int = 20) -> Iterator[tuple[Item, list[Metric]]]:
        raise NotImplementedError("Pending Phase 0.3 validation")
