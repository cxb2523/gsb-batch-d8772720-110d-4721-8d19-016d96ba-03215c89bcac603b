#!/usr/bin/env python3
"""
test_xhs_search.py — offline tests for XHSAdapter.fetch_search and its per-keyword outcomes.

No cookies, no network: a fake ``_fetch_html`` serves canned __INITIAL_STATE__ pages,
so keyword-level and note-level failures can be injected deterministically.
"""

import json
from urllib.parse import unquote

import pytest

from framework.adapters.xhs import XHSAdapter


def _html(payload) -> str:
    """Wrap a payload in the __INITIAL_STATE__ script tag the parser expects."""
    return f"<script>window.__INITIAL_STATE__ = {json.dumps(payload)}</script>"


def _search_page(*note_ids) -> str:
    """Search page HTML: one normal note per id (plus an ad without a type, which must be ignored)."""
    feeds = [{"id": nid, "xsecToken": "tok", "noteCard": {"type": "normal"}} for nid in note_ids]
    feeds.append({"id": "ad", "noteCard": {"type": ""}})  # placeholder / ad — not a real note
    return _html({"feeds": feeds})


def _detail_page(note_id: str) -> str:
    """Detail page HTML for one note (noteDetailMap keyed by id, currentNoteId pinned)."""
    return _html(
        {
            "note": {
                "currentNoteId": note_id,
                "noteDetailMap": {
                    note_id: {
                        "note": {
                            "noteId": note_id,
                            "user": {"userId": "u-" + note_id},
                            "interactInfo": {"likedCount": "10", "collectedCount": "5"},
                            "desc": "body " + note_id,
                        }
                    }
                },
            }
        }
    )


class FakeFetcher:
    """Stands in for XHSAdapter._fetch_html: routes by URL and records every request."""

    def __init__(self):
        self.calls = []
        self.search_pages = {}  # keyword -> html | Exception
        self.detail_pages = {}  # note id  -> html | Exception
        self.default_search = {}  # fallback html per keyword
        self.default_detail = {}  # fallback html per note id

    def __call__(self, url, retries=3):
        self.calls.append(url)
        if "search_result" in url:
            kw = unquote(url.split("keyword=", 1)[1].split("&", 1)[0])
            if kw in self.search_pages:
                val = self.search_pages[kw]
            else:
                val = self.default_search.get(kw)
            if isinstance(val, Exception):
                raise val
            return val
        # detail page: https://www.xiaohongshu.com/explore/<id>?...
        nid = url.rsplit("/explore/", 1)[1].split("?", 1)[0]
        val = self.detail_pages.get(nid, self.default_detail.get(nid))
        if isinstance(val, Exception):
            raise val
        return val

    def searched(self, kw: str) -> bool:
        return any(
            "search_result" in u and unquote(u.split("keyword=", 1)[1].split("&", 1)[0]) == kw
            for u in self.calls
            if "keyword=" in u
        )


def _adapter(fetcher) -> XHSAdapter:
    ad = XHSAdapter.__new__(XHSAdapter)  # skip __init__: never touch real cookies
    ad._fetch_html = fetcher
    return ad


# ---------------------------------------------------------------- all success


def test_all_success():
    kw_ids = {"口红": ("n1", "n2"), "面霜": ("n3",)}
    f = FakeFetcher()
    f.default_search = {kw: _search_page(*ids) for kw, ids in kw_ids.items()}
    f.default_detail = {nid: _detail_page(nid) for ids in kw_ids.values() for nid in ids}
    ad = _adapter(f)

    result = ad.fetch_search(list(kw_ids), segment="s", category="c", limit=10)

    assert isinstance(result, list)  # original list contract preserved
    assert len(result) == 3
    assert [r[1].item_id for r in result] == ["n1", "n2", "n3"]
    outcomes = result.outcomes
    assert [o.keyword for o in outcomes] == list(kw_ids)  # order matches input keywords
    assert [o.fetched for o in outcomes] == [2, 1]
    assert all(o.search_ok and o.skipped == 0 and o.error == "" for o in outcomes)
    assert all(o.status == "ok" for o in outcomes)


# ------------------------------------------------- search page ordinary error


def test_search_page_ordinary_error_skips_keyword_only():
    f = FakeFetcher()
    f.search_pages = {"坏词": ConnectionError("network blip")}
    f.default_search = {"好词": _search_page("n1"), "后面": _search_page("n2")}
    f.default_detail = {"n1": _detail_page("n1"), "n2": _detail_page("n2")}
    ad = _adapter(f)

    result = ad.fetch_search(["好词", "坏词", "后面"], limit=5)

    assert [r[1].item_id for r in result] == ["n1", "n2"]  # later keywords still collected
    out = result.outcomes
    assert [o.keyword for o in out] == ["好词", "坏词", "后面"]
    good, bad, later = out
    assert good.search_ok and good.fetched == 1 and good.skipped == 0 and good.error == ""
    assert not bad.search_ok and bad.fetched == 0 and bad.error and "network blip" in bad.error
    assert later.search_ok and later.fetched == 1  # keywords after the failure still run
    assert "not executed" not in bad.error  # ordinary failure, not a limit skip


# ------------------------------------------------ detail page ordinary error


def test_detail_page_ordinary_error_skips_single_note():
    f = FakeFetcher()
    f.default_search = {"k1": _search_page("n1", "bad", "n3"), "k2": _search_page("n4")}
    f.default_detail = {
        "n1": _detail_page("n1"),
        "n3": _detail_page("n3"),
        "n4": _detail_page("n4"),
    }
    f.detail_pages = {"bad": ConnectionError("timeout")}
    ad = _adapter(f)

    result = ad.fetch_search(["k1", "k2"], limit=10)

    assert [r[1].item_id for r in result] == ["n1", "n3", "n4"]
    k1, k2 = result.outcomes
    assert k1.search_ok and k1.fetched == 2 and k1.skipped == 1
    assert "bad" in k1.error and "bad" in "; ".join(k1.note_errors)  # partial keyword carries a reason
    assert k1.status == "partial"
    assert k2.search_ok and k2.fetched == 1 and k2.skipped == 0 and k2.error == ""


def test_missing_note_id_counted_as_skipped():
    page = _html(
        {
            "feeds": [
                {"noteCard": {"type": "normal"}},
                {"id": "n1", "xsecToken": "t", "noteCard": {"type": "normal"}},
            ]
        }
    )
    f = FakeFetcher()
    f.default_search = {"k": page}
    f.default_detail = {"n1": _detail_page("n1")}
    ad = _adapter(f)

    result = ad.fetch_search(["k"], limit=5)
    o = result.outcomes[0]
    assert o.fetched == 1 and o.skipped == 1 and "missing note id" in o.note_errors


def test_unparseable_search_page_is_keyword_failure():
    """A search page with no __INITIAL_STATE__ (e.g. a soft block) is an ordinary keyword failure,
    not a silent zero-note success, and later keywords still run."""
    f = FakeFetcher()
    f.search_pages = {"k1": "<html>blocked</html>"}
    f.default_search = {"k2": _search_page("n1")}
    f.default_detail = {"n1": _detail_page("n1")}
    ad = _adapter(f)

    result = ad.fetch_search(["k1", "k2"], limit=5)
    k1, k2 = result.outcomes
    assert not k1.search_ok and k1.fetched == 0 and "parseable" in k1.error
    assert k2.search_ok and k2.fetched == 1
    assert result.failed_keywords == ["k1"]
    assert not result.complete


# ------------------------------------------------------- fatal RuntimeError


def test_detail_runtimeerror_propagates_and_stops():
    """Rate-limit / cookie-expiry RuntimeError on a detail page: raised, not downgraded, no further keywords."""
    f = FakeFetcher()
    f.default_search = {"k1": _search_page("n1", "n2"), "k2": _search_page("n3")}
    f.default_detail = {"n1": _detail_page("n1"), "n3": _detail_page("n3")}
    f.detail_pages = {"n2": RuntimeError("daily scraping limit reached, stopping to avoid ban")}
    ad = _adapter(f)

    with pytest.raises(RuntimeError, match="daily scraping limit"):
        ad.fetch_search(["k1", "k2"], limit=10)
    assert not f.searched("k2")  # fatal error aborts immediately


def test_search_runtimeerror_propagates():
    """RuntimeError on the search page itself (cookie expired) is fatal too, not a per-keyword failure."""
    f = FakeFetcher()
    f.search_pages = {"k1": RuntimeError("Cookie appears expired")}
    f.default_search = {"k2": _search_page("n1")}
    f.default_detail = {"n1": _detail_page("n1")}
    ad = _adapter(f)

    with pytest.raises(RuntimeError, match="Cookie appears expired"):
        ad.fetch_search(["k1", "k2"], limit=5)
    assert not f.searched("k2")


# ---------------------------------------------------------------- limit


def test_limit_marks_unprocessed_keywords_not_executed():
    """Overall limit reached: no new search request, and untouched keywords are 'not executed', not success."""
    f = FakeFetcher()
    f.default_search = {
        "a": _search_page("n1", "n2", "n3"),
        "b": _search_page("n4"),
        "c": _search_page("n5"),
    }
    f.default_detail = {nid: _detail_page(nid) for nid in ("n1", "n2", "n3", "n4", "n5")}
    ad = _adapter(f)

    result = ad.fetch_search(["a", "b", "c"], limit=2)

    assert len(result) == 2
    a, b, c = result.outcomes
    assert a.executed and a.search_ok and a.fetched == 2
    assert a.truncated and a.status == "truncated"  # page not exhausted before the cap
    assert "limit" in a.error
    assert not b.executed and not b.search_ok and b.error.startswith("not executed")
    assert b.status == "not_executed" and not b.ok and not b.success
    assert not c.executed and not c.search_ok
    assert not f.searched("b") and not f.searched("c")
    assert result.unprocessed_keywords == ["b", "c"]
    assert not result.complete


def test_returned_records_keep_list_contract():
    """Backward compatibility: result behaves like the old list return value."""
    f = FakeFetcher()
    f.default_search = {"k": _search_page("n1")}
    f.default_detail = {"n1": _detail_page("n1")}
    ad = _adapter(f)

    result = ad.fetch_search(["k"], limit=5)
    assert result == list(result) and len(result) == 1
    assert result[:0] == [] and isinstance(result + [], list)
    assert result.complete and result.failed_keywords == [] and result.unprocessed_keywords == []
    records, outcomes = result.as_pair()
    assert records == list(result) and len(outcomes) == 1


def test_fetch_search_with_outcomes_returns_plain_tuple():
    """Explicit two-value API: records and outcomes as an ordinary tuple."""
    f = FakeFetcher()
    f.default_search = {"k": _search_page("n1")}
    f.default_detail = {"n1": _detail_page("n1")}
    ad = _adapter(f)

    records, outcomes = ad.fetch_search_with_outcomes(["k"], limit=5)
    assert isinstance(records, list)
    assert [r[1].item_id for r in records] == ["n1"]
    assert [o.keyword for o in outcomes] == ["k"]
    assert outcomes[0].search_ok


def test_no_keywords_returns_empty_result():
    """Zero keywords (or every keyword failing) still yields a usable result object."""
    f = FakeFetcher()
    ad = _adapter(f)

    result = ad.fetch_search([], limit=5)
    assert result == [] and result.outcomes == [] and result.complete


# ------------------------------------------------------ outcome shape

def test_outcome_exposes_required_fields():
    """Each outcome states: keyword, search-page success, fetched count, skipped count, reason."""
    f = FakeFetcher()
    f.default_search = {"k1": _search_page("n1", "bad"), "k2": _search_page("n2")}
    f.default_detail = {"n1": _detail_page("n1"), "n2": _detail_page("n2")}
    f.detail_pages = {"bad": ConnectionError("timeout")}
    ad = _adapter(f)

    result = ad.fetch_search(["k1", "k2"], limit=10)
    required = ("keyword", "search_ok", "fetched", "skipped", "error")
    for o in result.outcomes:
        assert set(required) <= set(o.keys())
        assert set(required) <= set(o.as_dict())
        for field_name in required:                     # dict-style read access
            assert o[field_name] == getattr(o, field_name)

    k1, k2 = result.outcomes
    assert (k1.keyword, k1.search_ok, k1.fetched, k1.skipped) == ("k1", True, 1, 1)
    assert k1.error and k1.note_errors                # skipped notes ⇒ non-empty reason
    assert (k2.keyword, k2.search_ok, k2.fetched, k2.skipped, k2.error) == ("k2", True, 1, 0, "")
