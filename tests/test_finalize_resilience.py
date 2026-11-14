"""Finalize resilience: a crawl that cannot finish cleanly must still salvage
the usable pages into a downloadable report, and only fail when there is
literally nothing usable left.

All upstream interaction is faked — page dicts are built locally and
libreclient.export_pages is monkeypatched to return them.
"""

import pytest

import server


def _p(url, title="Real page", status=200, **kw):
    return {"url": url, "title": title, "status_code": status, "depth": 1, **kw}


def _challenge(url, status=403):
    return _p(url, title="Just a moment...", status=status)


@pytest.fixture
def finalize_env(monkeypatch):
    import runner
    import state
    import libreclient
    import external_links, content_audit, extended_checks, pdf_report, sitemap_fill

    def boom(*a, **k):
        raise RuntimeError("network disabled in tests")

    # Heavy/optional side analyses are never allowed to touch the network.
    for mod, fn in ((external_links, "audit_external_links"), (content_audit, "audit_content"),
                    (extended_checks, "run_extended_checks"), (pdf_report, "render_pdf")):
        monkeypatch.setattr(mod, fn, boom)
    fill_calls = []
    monkeypatch.setattr(sitemap_fill, "fill_sitemap_orphans",
                        lambda urls, **k: fill_calls.append(urls) or {"pages_added": []})
    monkeypatch.setattr(server, "_site_check", lambda url: {})

    def make(pages, sitemap_urls=(), max_pages=0):
        # Fake upstream export: the locally-built page dicts ARE the export.
        monkeypatch.setattr(libreclient, "export_pages", lambda cid=None: (pages, []))
        monkeypatch.setattr(server, "_compute_sitemap_reconciliation",
                            lambda pgs, sm: _recon(pgs, sitemap_urls))
        sid = state.create_session("https://a.test/", max_pages, 50, "normal", {})
        runner._finalize_session(sid, 1, 500, 0)
        return state.get_session(sid), fill_calls

    return make


def _recon(pages, sitemap_urls):
    crawled = {p["url"] for p in pages}
    only = [u for u in sitemap_urls if u not in crawled]
    return {"sitemap_total": len(sitemap_urls), "sitemap_only_count": len(only),
            "sitemap_only": only, "crawl_only": [], "both": []}


def _events(sid, kind):
    import state
    return [e for e in state.recent_events(sid, 100) if e["kind"] == kind]


def _artifact_kinds(sid):
    import state
    return {a["kind"] for a in state.list_artifacts(sid)}


# ── Path 1: partial success — challenges + cap overshoot, report salvaged ─────

def test_partial_success_salvages_report_with_challenges_and_cap(finalize_env):
    pages = [
        dict(_p("https://a.test/", depth=0)),
        _p("https://a.test/good-1"),
        _p("https://a.test/good-2"),
        _p("https://a.test/good-3"),
        _challenge("https://a.test/blocked-1"),
        _challenge("https://a.test/blocked-2"),
        _p("https://a.test/asset.png", title=""),
    ]
    # Cap of 2 real pages; two sitemap URLs are never reached.
    sess, fill_calls = finalize_env(
        pages,
        sitemap_urls=["https://a.test/", "https://a.test/missing-1",
                      "https://a.test/missing-2"],
        max_pages=2,
    )

    # Session completes with artifacts, but is explicitly marked incomplete.
    assert sess["status"] == "done"
    assert sess["audit_complete"] == 0
    assert sess["pages_done"] == 2  # cap holds after filtering

    reasons = sess["incomplete_reasons"]
    assert "sitemap_coverage_partial" in reasons
    assert "1/3 sitemap URLs crawled" in reasons and "2 missed" in reasons
    assert "bot_challenge: 2 URLs" in reasons
    assert "allowlist the crawler and re-run" in reasons
    assert "max_pages_hit: crawler stopped at configured cap of 2" in reasons

    # >20% challenge ratio (2 of 6) → no sitemap backfill requests.
    assert fill_calls == []
    skip = _events(sess["id"], "sitemap_fill_skipped")
    assert skip and "bot_challenge" in skip[0]["detail"]

    # The cap trim and the dropped challenge/asset rows are both in the event log.
    trim = _events(sess["id"], "cap_overshoot_trimmed")
    assert trim and '"trimmed": 2' in trim[0]["detail"]
    dropped = _events(sess["id"], "non_audit_rows_dropped")
    assert dropped and '"challenge_pages": 2' in dropped[0]["detail"]

    # Existing artifacts were still produced and are downloadable.
    kinds = _artifact_kinds(sess["id"])
    assert {"md", "per_page_csv", "sitemap_recon_csv"} <= kinds

    # Challenge pages and assets never reach the per-page CSV.
    import csv
    import state
    csv_path = next(a["path"] for a in state.list_artifacts(sess["id"])
                    if a["kind"] == "per_page_csv")
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    row_urls = {r["url"] for r in rows}
    assert row_urls == {"https://a.test/", "https://a.test/good-1"}
    assert not any("blocked" in u or u.endswith(".png") for u in row_urls)
    # A 403 challenge must not be scored as a broken-link 4xx row.
    assert all(r["status_4xx"] == "0" for r in rows)


def test_partial_success_when_only_some_pages_have_http_status(finalize_env):
    # One answered page plus a status-0 fetch error: still a salvageable audit.
    pages = [
        dict(_p("https://a.test/", depth=0)),
        _p("https://a.test/timeout", title="", status=0, error_type="timeout"),
    ]
    sess, _ = finalize_env(pages)
    assert sess["status"] == "done"
    assert "md" in _artifact_kinds(sess["id"])


# ── Path 2: every page was a challenge — hard failure, no report ──────────────

def test_all_challenge_pages_fail_and_produce_no_artifacts(finalize_env):
    pages = [
        dict(_challenge("https://a.test/"), depth=0),
        _challenge("https://a.test/a"),
        _challenge("https://a.test/b"),
    ]
    sess, fill_calls = finalize_env(pages)

    assert sess["status"] == "failed"
    assert sess["audit_complete"] == 0
    assert "bot_challenge" in sess["incomplete_reasons"]
    assert "3" in sess["incomplete_reasons"]
    assert "allowlist the crawler and re-run" in sess["incomplete_reasons"]
    assert fill_calls == []
    # Nothing downloadable is registered or written.
    assert _artifact_kinds(sess["id"]) == set()
    fail_events = _events(sess["id"], "finalize_failed_no_report")
    assert fail_events and "bot_challenge" in fail_events[0]["detail"]


def test_only_non_page_files_fail_without_report(finalize_env):
    pages = [
        _p("https://a.test/hero.JPG", title=""),
        _p("https://a.test/doc.pdf?v=2", title=""),
    ]
    sess, _ = finalize_env(pages)
    assert sess["status"] == "failed"
    assert "no_html_pages" in sess["incomplete_reasons"]
    assert _artifact_kinds(sess["id"]) == set()


def test_seed_without_any_http_status_fails_without_report(finalize_env):
    pages = [
        dict(_p("https://a.test/", depth=0, status=0, error_type="dns_not_found")),
        _p("https://a.test/x", status=0),
    ]
    sess, _ = finalize_env(pages)
    assert sess["status"] == "failed"
    assert "seed_unreachable" in sess["incomplete_reasons"]
    assert _artifact_kinds(sess["id"]) == set()


def test_empty_export_fails_without_report(finalize_env):
    sess, _ = finalize_env([])
    assert sess["status"] == "failed"
    assert "no_pages_exported" in sess["incomplete_reasons"]
    assert _artifact_kinds(sess["id"]) == set()


def test_only_offsite_hosts_fail_without_report(finalize_env):
    # Followed links that escaped onto another host — the seed host itself
    # yielded nothing usable.
    pages = [
        _p("https://other.example/a"),
        _p("https://other.example/b"),
    ]
    sess, _ = finalize_env(pages)
    assert sess["status"] == "failed"
    assert "no_usable_pages" in sess["incomplete_reasons"]
    assert _artifact_kinds(sess["id"]) == set()


# ── Path 3: clean complete crawl — audit_complete=1, no reasons ───────────────

def test_complete_crawl_is_audit_complete_without_reasons(finalize_env):
    pages = [
        dict(_p("https://a.test/", depth=0)),
        _p("https://a.test/a"),
        _p("https://a.test/b"),
    ]
    # Every sitemap URL was crawled → full coverage, no challenges, no cap.
    sess, fill_calls = finalize_env(
        pages,
        sitemap_urls=["https://a.test/", "https://a.test/a", "https://a.test/b"],
    )

    assert sess["status"] == "done"
    assert sess["audit_complete"] == 1
    assert not sess["incomplete_reasons"]
    assert sess["pages_done"] == 3
    assert fill_calls == []  # nothing orphaned → nothing to backfill
    kinds = _artifact_kinds(sess["id"])
    assert {"md", "per_page_csv", "sitemap_recon_csv"} <= kinds

    finalized = _events(sess["id"], "finalized")
    assert finalized and '"audit_complete": true' in finalized[0]["detail"]
    skipped = _events(sess["id"], "sitemap_fill_skipped")
    assert skipped and "no_orphans" in skipped[0]["detail"]
