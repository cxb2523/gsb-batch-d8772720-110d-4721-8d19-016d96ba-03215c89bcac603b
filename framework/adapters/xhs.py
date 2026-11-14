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
from dataclasses import asdict, dataclass, field
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

@dataclass
class KeywordOutcome:
    """Per-keyword collection outcome for :meth:`XHSAdapter.fetch_search`.

    One entry per requested keyword, in the same order the keywords were passed in —
    including keywords that were skipped, so the caller can tell a complete batch from
    one with holes and retry only the keywords that failed.

    Fields:
        keyword     : the keyword exactly as requested.
        search_ok   : whether the search page itself was fetched and parsed.
        fetched     : notes successfully produced for this keyword.
        skipped     : notes dropped for this keyword (detail fetch failed or missing note id).
        error       : keyword-level failure reason — search page fetch/parse failure,
                      "not executed: overall limit reached", or a summary of the skipped
                      notes / overall-limit truncation. Empty only when the keyword was
                      collected completely.
        note_errors : reasons the individual notes in ``skipped`` were dropped.
        candidates  : real notes on the search page that were attempted.
        truncated   : True when the overall ``limit`` was reached before this keyword's
                      search results were exhausted (the rest were not attempted).
        executed    : False when the overall ``limit`` was already reached before this
                      keyword was started — it was not searched at all.
    """
    keyword: str
    search_ok: bool = False
    fetched: int = 0
    skipped: int = 0
    error: str = ""
    note_errors: list[str] = field(default_factory=list)
    candidates: int = 0
    truncated: bool = False
    executed: bool = True

    @property
    def ok(self) -> bool:
        """True when the keyword was fully collected: search page OK, nothing skipped,
        and its search results were not cut short by the overall ``limit``."""
        return (self.executed and self.search_ok and self.skipped == 0
                and not self.truncated)

    # --- convenience aliases (callers may reach for these names) ---
    @property
    def success(self) -> bool:
        return self.ok

    @property
    def search_success(self) -> bool:
        return self.search_ok

    @property
    def search_page_ok(self) -> bool:
        return self.search_ok

    @property
    def success_count(self) -> int:
        return self.fetched

    @property
    def fetched_count(self) -> int:
        return self.fetched

    @property
    def skipped_count(self) -> int:
        return self.skipped

    @property
    def reason(self) -> str:
        return self.error

    @property
    def status(self) -> str:
        if not self.executed:
            return "not_executed"
        if not self.search_ok:
            return "search_failed"
        if self.skipped:
            return "partial"
        if self.truncated:
            return "truncated"
        return "ok"

    def as_dict(self) -> dict:
        """Plain-dict view, for logging / JSON / callers that avoid dataclasses."""
        return asdict(self)

    # read-only dict-style access: outcome["fetched"] as well as outcome.fetched
    def __getitem__(self, key):
        try:
            return getattr(self, key)
        except AttributeError:
            raise KeyError(key) from None

    def get(self, key, default=None):
        return getattr(self, key, default)

    def keys(self):
        return self.as_dict().keys()

    def items(self):
        return self.as_dict().items()

    def __contains__(self, key) -> bool:
        return isinstance(key, str) and hasattr(self, key)


class SearchResult(list):
    """Records returned by :meth:`XHSAdapter.fetch_search`, plus per-keyword outcomes.

    Subclasses ``list`` so every existing caller (iteration, indexing, ``len()``,
    ``result == []``, slicing, unpacking in a for-loop) keeps working unchanged;
    ``.outcomes`` carries one :class:`KeywordOutcome` per requested keyword, in order.
    """
    def __init__(self, records=(), outcomes=()):
        super().__init__(records)
        self.outcomes: list[KeywordOutcome] = list(outcomes)

    @property
    def records(self) -> list:
        return list(self)

    @property
    def keyword_outcomes(self) -> list[KeywordOutcome]:
        """Alias for ``.outcomes``."""
        return self.outcomes

    @property
    def outcomes_by_keyword(self) -> dict[str, KeywordOutcome]:
        """``{keyword: outcome}`` for callers that look up by keyword rather than index."""
        return {o.keyword: o for o in self.outcomes}

    @property
    def failed_keywords(self) -> list[str]:
        """Keywords worth retrying: search page failed or some of their notes were skipped."""
        return [o.keyword for o in self.outcomes
                if o.executed and (not o.search_ok or o.skipped > 0)]

    @property
    def unprocessed_keywords(self) -> list[str]:
        """Keywords never searched because the overall ``limit`` was reached."""
        return [o.keyword for o in self.outcomes if not o.executed]

    @property
    def complete(self) -> bool:
        """True when every keyword was collected cleanly (nothing skipped, nothing truncated,
        nothing left unprocessed)."""
        return all(o.ok for o in self.outcomes)

    def outcome_for(self, keyword: str) -> KeywordOutcome | None:
        for o in self.outcomes:
            if o.keyword == keyword:
                return o
        return None

    def as_pair(self) -> tuple[list, list[KeywordOutcome]]:
        """Unpack style: ``records, outcomes = result.as_pair()``."""
        return list(self), self.outcomes


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

    @staticmethod
    def _search_feeds(state: dict | None) -> list:
        """Pull the feed list out of a search-page __INITIAL_STATE__ (tolerating the three
        shapes Xiaohongshu has used). Empty list when the state carries no feeds."""
        return ((state or {}).get("feeds") or (state or {}).get("note", {}).get("feeds")
                or (state or {}).get("search", {}).get("feeds") or [])

    def fetch_search(self, keywords: list[str], segment: str = "", category: str = "",
                     limit: int = 20) -> SearchResult:
        """Keyword search on Xiaohongshu (not limited to the homepage feed) → visit each note's detail page
        for full metrics (including saves).

        Endpoint: GET https://www.xiaohongshu.com/search_result?keyword={kw}&source=web_search
        Parses the search-page __INITIAL_STATE__ feeds (same structure as homepage feed:
        noteCard + id + xsecToken). Keywords are searched one at a time, throttled by RateLimiter.

        Returns a :class:`SearchResult`: still a plain list of records (existing callers
        unchanged), whose ``.outcomes`` holds one :class:`KeywordOutcome` per requested
        keyword — in the same keyword order, including keywords that were skipped or never
        executed. A caller can therefore tell a complete batch from one with holes and
        retry only the keywords that failed.

        Failure grading (same convention as ``fetch_feed``):
        - ``RuntimeError`` (RateLimiter cap / expired cookie) is fatal → propagated at once,
          never swallowed and never downgraded to an ordinary per-keyword failure.
        - Ordinary fetch errors affect only the current keyword or note; the remaining
          keywords continue.
        """
        out: list[tuple[Entity, Item, list[Metric], list[Text]]] = []
        outcomes: list[KeywordOutcome] = []
        for kw in keywords:
            outcome = KeywordOutcome(keyword=kw)
            outcomes.append(outcome)
            if len(out) >= limit:                            # overall limit reached: don't issue another search request
                outcome.executed = False
                outcome.error = "not executed: overall limit reached"
                continue
            try:
                url = (f"https://www.xiaohongshu.com/search_result"
                       f"?keyword={urllib.parse.quote(kw)}&source=web_search")
                state = parse_initial_state(self._fetch_html(url))
            except RuntimeError:
                raise                                            # cookie expiry / rate cap is fatal
            except Exception as e:                               # noqa: BLE001 search page fetch failed — skip this keyword
                outcome.error = f"search page fetch failed: {e}"
                print(f"[xhs] Search '{kw}' page fetch failed: {e}")
                continue
            if state is None:
                outcome.error = "search page returned no parseable __INITIAL_STATE__"
                print(f"[xhs] Search '{kw}' page returned no parseable __INITIAL_STATE__")
                continue
            outcome.search_ok = True
            # real notes only — placeholders / ads carry no noteCard type
            notes = [f for f in self._search_feeds(state)
                     if (f.get("noteCard") or f.get("note") or {}).get("type")]
            for f in notes:
                if len(out) >= limit:
                    outcome.truncated = True                     # limit hit mid-keyword: the rest of this page not attempted
                    break
                nc = f.get("noteCard") or f.get("note") or {}
                outcome.candidates += 1
                nid = f.get("id") or (nc.get("id"))
                token = f.get("xsecToken") or (nc.get("xsecToken") or "")
                if not nid:
                    outcome.skipped += 1
                    outcome.note_errors.append("missing note id")
                    continue
                try:
                    note = extract_note(parse_initial_state(self._fetch_html(self._detail_url(nid, token))), nid)
                except RuntimeError:
                    raise                                        # fatal — never swallow
                except Exception as e:                           # noqa: BLE001 transient per-note error — skip that note only
                    outcome.skipped += 1
                    outcome.note_errors.append(f"{nid}: detail fetch failed: {e}")
                    continue
                if not note:
                    outcome.skipped += 1
                    outcome.note_errors.append(f"{nid}: no note data in detail page")
                    continue
                out.append(note_to_records(note, segment, category))
                outcome.fetched += 1
            # Failure reason is empty only when the keyword was fully collected; skipped
            # notes are summarised here (per-note detail stays in note_errors).
            reasons = []
            if outcome.skipped:
                reasons.append(f"{outcome.skipped} note(s) skipped: "
                               + "; ".join(outcome.note_errors))
            if outcome.truncated:
                reasons.append("overall limit reached before search results were exhausted")
            outcome.error = "; ".join(reasons)
        return SearchResult(out, outcomes)

    def fetch_search_with_outcomes(self, keywords: list[str], segment: str = "",
                                   category: str = "", limit: int = 20
                                   ) -> tuple[list[tuple[Entity, Item, list[Metric], list[Text]]],
                                              list[KeywordOutcome]]:
        """Same as :meth:`fetch_search`, but returns the records and the per-keyword outcomes
        side by side as a plain tuple — for callers that prefer explicit unpacking:

            records, outcomes = ad.fetch_search_with_outcomes(["k1", "k2"])
        """
        result = self.fetch_search(keywords, segment=segment, category=category, limit=limit)
        return result.records, result.outcomes

    # Author profile batch fetch — implement after Phase 0.3 confirms whether it's __INITIAL_STATE__ or a signed API
    def fetch_entity(self, seed: dict) -> tuple[Entity, list[Metric]]:
        raise NotImplementedError("Author profile batch fetch pending Phase 0.3 validation (R1: may require a signed API)")

    def fetch_items(self, entity_id: str, limit: int = 20) -> Iterator[tuple[Item, list[Metric]]]:
        raise NotImplementedError("Pending Phase 0.3 validation")
