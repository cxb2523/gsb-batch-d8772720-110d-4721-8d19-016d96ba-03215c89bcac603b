"""Tests for the app.py parallel source-scraping chain.

The real Olostep network call (``app.olostep_scrape``) is replaced by a local
fake scraper so the tests are fully offline and deterministic. Each test gets
an isolated cache directory, so no repository cache data is read or mutated.
"""

from __future__ import annotations

import os

# script.ensure_env() runs at import time and requires these variables.
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("OLOSTEP_API_KEY", "test-olostep-key")

import requests  # noqa: E402
import gradio as gr  # noqa: E402
import pytest  # noqa: E402

import app  # noqa: E402


URL_CACHED = "https://example.com/cached-page"
URL_SUCCESS = "https://example.com/live-success"
URL_FAILED = "https://example.com/live-failure"
ALL_URLS = [URL_CACHED, URL_SUCCESS, URL_FAILED]


def _seed_cached_page(cache_dir, url: str, *, title: str = "Cached Title") -> dict:
    payload = {"url": url, "title": title, "content": f"cached body for {url}"}
    app._cache_save(cache_dir, app._stable_hash(url), payload)
    return payload


def _make_fake_scraper(calls: list[str]):
    """Return a scraper that succeeds for URL_SUCCESS and raises otherwise."""

    def fake_scraper(url: str) -> dict:
        calls.append(url)
        if url == URL_SUCCESS:
            return {
                "result": {
                    "metadata": {"title": "Live Title"},
                    "markdown_content": f"# fresh content for {url}",
                }
            }
        if url == URL_FAILED:
            raise RuntimeError("simulated upstream outage")
        raise RuntimeError(f"unexpected scrape call for {url}")

    return fake_scraper


def _patch_cache_dirs(monkeypatch, tmp_path):
    scrape_dir = tmp_path / "scrape_pages"
    quick_dir = tmp_path / "quick_snapshot"
    monkeypatch.setattr(app, "SCRAPE_CACHE_DIR", scrape_dir)
    monkeypatch.setattr(app, "QUICK_CACHE_DIR", quick_dir)
    return scrape_dir, quick_dir


def test_scrape_outcomes_order_status_counts_and_cache_writes(monkeypatch, tmp_path):
    """One cache hit, one success, one failure: order, counts, reasons, cache."""
    scrape_dir, _ = _patch_cache_dirs(monkeypatch, tmp_path)
    cached_payload = _seed_cached_page(scrape_dir, URL_CACHED)

    calls: list[str] = []
    outcomes = app._scrape_sources_parallel(ALL_URLS, scraper=_make_fake_scraper(calls))

    # One outcome per candidate URL, in the original candidate order.
    assert [item["url"] for item in outcomes] == ALL_URLS
    assert [item["status"] for item in outcomes] == [
        app.SCRAPE_STATUS_CACHED,
        app.SCRAPE_STATUS_SUCCESS,
        app.SCRAPE_STATUS_FAILED,
    ]

    # The cache hit must not trigger any network request; only missing URLs do.
    assert sorted(calls) == [URL_FAILED, URL_SUCCESS]
    assert URL_CACHED not in calls

    # Cache-hit outcome carries the cached page and no error.
    assert outcomes[0]["page"] == cached_payload
    assert outcomes[0]["error"] == ""

    # Success outcome carries a normalized page payload.
    success_page = outcomes[1]["page"]
    assert success_page == {
        "url": URL_SUCCESS,
        "title": "Live Title",
        "content": f"# fresh content for {URL_SUCCESS}",
    }
    assert outcomes[1]["error"] == ""

    # Failure outcome carries a readable reason and no page.
    assert outcomes[2]["page"] is None
    assert "simulated upstream outage" in outcomes[2]["error"]
    assert "RuntimeError" in outcomes[2]["error"]

    summary = app._summarize_scrape_outcomes(outcomes)
    assert summary["total"] == 3
    assert summary["cached"] == 1
    assert summary["succeeded"] == 1
    assert summary["failed"] == 1
    assert summary["failures"] == [
        {"url": URL_FAILED, "error": outcomes[2]["error"]}
    ]
    # Only the two usable pages are exposed to downstream analysis.
    assert [page["url"] for page in summary["pages"]] == [URL_CACHED, URL_SUCCESS]


def test_success_is_cached_but_failure_is_not(monkeypatch, tmp_path):
    scrape_dir, _ = _patch_cache_dirs(monkeypatch, tmp_path)
    _seed_cached_page(scrape_dir, URL_CACHED)

    calls: list[str] = []
    app._scrape_sources_parallel(ALL_URLS, scraper=_make_fake_scraper(calls))

    cached_files = {path.name for path in scrape_dir.glob("*.json")}
    assert app._stable_hash(URL_CACHED) + ".json" in cached_files
    assert app._stable_hash(URL_SUCCESS) + ".json" in cached_files
    # The failed URL must not leave any cache artifact behind.
    assert app._stable_hash(URL_FAILED) + ".json" not in cached_files

    saved_success = app._cache_load(scrape_dir, app._stable_hash(URL_SUCCESS))
    assert saved_success["url"] == URL_SUCCESS
    assert "fresh content" in saved_success["content"]


def test_failed_url_is_retried_and_succeeds_on_a_later_run(monkeypatch, tmp_path):
    """Because failures are never cached, a later run retries the same URL."""
    scrape_dir, _ = _patch_cache_dirs(monkeypatch, tmp_path)

    def always_fail(url: str) -> dict:
        raise requests.ConnectionError("dns lookup failed")

    first = app._scrape_sources_parallel([URL_FAILED], scraper=always_fail)
    assert first[0]["status"] == app.SCRAPE_STATUS_FAILED
    assert "ConnectionError" in first[0]["error"]
    assert "dns lookup failed" in first[0]["error"]
    assert not (scrape_dir / f"{app._stable_hash(URL_FAILED)}.json").exists()

    def now_succeeds(url: str) -> dict:
        return {"result": {"metadata": {"title": "Recovered"}, "text_content": "recovered body"}}

    second = app._scrape_sources_parallel([URL_FAILED], scraper=now_succeeds)
    assert second[0]["status"] == app.SCRAPE_STATUS_SUCCESS
    assert second[0]["page"]["title"] == "Recovered"
    assert (scrape_dir / f"{app._stable_hash(URL_FAILED)}.json").exists()


def test_http_error_reason_is_readable(monkeypatch, tmp_path):
    scrape_dir, _ = _patch_cache_dirs(monkeypatch, tmp_path)

    response = requests.models.Response()
    response.status_code = 503

    def http_fail(url: str) -> dict:
        raise requests.HTTPError("503 Server Error", response=response)

    outcomes = app._scrape_sources_parallel([URL_FAILED], scraper=http_fail)
    assert outcomes[0]["status"] == app.SCRAPE_STATUS_FAILED
    assert outcomes[0]["error"] == "HTTP 503 while scraping page"
    assert not (scrape_dir / f"{app._stable_hash(URL_FAILED)}.json").exists()


def test_cached_url_never_hits_the_network(monkeypatch, tmp_path):
    scrape_dir, _ = _patch_cache_dirs(monkeypatch, tmp_path)
    cached_payload = _seed_cached_page(scrape_dir, URL_CACHED)

    def boom(url: str) -> dict:
        raise AssertionError("network must not be called for a cached URL")

    outcomes = app._scrape_sources_parallel([URL_CACHED], scraper=boom)
    assert len(outcomes) == 1
    assert outcomes[0]["status"] == app.SCRAPE_STATUS_CACHED
    assert outcomes[0]["page"] == cached_payload


def test_duplicate_urls_produce_a_single_outcome_each(monkeypatch, tmp_path):
    scrape_dir, _ = _patch_cache_dirs(monkeypatch, tmp_path)
    _seed_cached_page(scrape_dir, URL_CACHED)

    calls: list[str] = []
    outcomes = app._scrape_sources_parallel(
        [URL_CACHED, URL_SUCCESS, URL_CACHED, URL_SUCCESS],
        scraper=_make_fake_scraper(calls),
    )
    assert [item["url"] for item in outcomes] == [URL_CACHED, URL_SUCCESS]
    assert calls == [URL_SUCCESS]


def test_status_html_lists_counts_failures_and_analysis_warning():
    summary = {
        "total": 3,
        "cached": 1,
        "succeeded": 1,
        "failed": 1,
        "failures": [{"url": URL_FAILED, "error": "RuntimeError: simulated upstream outage"}],
        "pages": [{"url": URL_CACHED}, {"url": URL_SUCCESS}],
    }
    markup = app._scrape_status_html(summary)

    # The four required counters are visible in the status area.
    assert "候选网址" in markup and ">3<" in markup
    assert "抓取成功" in markup and ">1<" in markup
    assert "抓取失败" in markup and ">1<" in markup
    assert "命中缓存" in markup and ">1<" in markup

    # Failed URL and its readable reason are listed.
    assert URL_FAILED in markup
    assert "simulated upstream outage" in markup
    # User is warned that downstream analysis only uses successful pages.
    assert "仅基于抓取成功的页面" in markup
    assert "only the successfully" in markup


def test_status_html_all_success_message(monkeypatch, tmp_path):
    summary = {
        "total": 2,
        "cached": 1,
        "succeeded": 1,
        "failed": 0,
        "failures": [],
        "pages": [{"url": URL_CACHED}, {"url": URL_SUCCESS}],
    }
    markup = app._scrape_status_html(summary)
    assert "失败网址" not in markup
    assert ">0<" in markup
    assert "全部候选页面可用" in markup


def test_ensure_deep_research_blocks_signal_extraction_when_all_fail(monkeypatch, tmp_path):
    _patch_cache_dirs(monkeypatch, tmp_path)

    state = {
        "quick_answer": {
            "quick_text": "summary",
            "sources": [URL_FAILED, URL_SUCCESS],
            "json_content": {},
        }
    }

    def all_fail(url: str) -> dict:
        raise RuntimeError("simulated upstream outage")

    monkeypatch.setattr(app, "olostep_scrape", all_fail)

    with pytest.raises(gr.Error) as exc_info:
        app._ensure_deep_research("some topic", state)

    message = str(exc_info.value)
    # The error is explicit and readable, and names the failing URLs/reasons.
    assert "All candidate source pages failed" in message
    assert URL_FAILED in message
    assert URL_SUCCESS in message
    assert "simulated upstream outage" in message
    # No deep research / empty material must be cached in state.
    assert "deep_research" not in state


def test_ensure_deep_research_partial_failure_keeps_successful_pages(monkeypatch, tmp_path):
    _patch_cache_dirs(monkeypatch, tmp_path)

    state = {
        "quick_answer": {
            "quick_text": "summary",
            "sources": [URL_SUCCESS, URL_FAILED],
            "json_content": {},
        }
    }

    calls: list[str] = []
    monkeypatch.setattr(app, "olostep_scrape", _make_fake_scraper(calls))

    deep = app._ensure_deep_research("some topic", state)
    # Analysis proceeds on the single successful page only.
    assert [page["url"] for page in deep["scraped_pages"]] == [URL_SUCCESS]
    assert deep["scrape_summary"]["failed"] == 1
    assert deep["scrape_summary"]["succeeded"] == 1
    assert deep["scrape_summary"]["failures"][0]["url"] == URL_FAILED
    # Per-URL outcomes remain available for the UI/state.
    assert [item["url"] for item in deep["scrape_outcomes"]] == [URL_SUCCESS, URL_FAILED]


def test_run_quick_answer_renders_scrape_status(monkeypatch, tmp_path):
    scrape_dir, quick_dir = _patch_cache_dirs(monkeypatch, tmp_path)
    _seed_cached_page(scrape_dir, URL_CACHED)

    raw_quick = {
        "result": {
            "summary": "quick summary text",
            "sources": [URL_CACHED, URL_SUCCESS, URL_FAILED],
        }
    }
    monkeypatch.setattr(app, "olostep_answer", lambda topic: raw_quick)

    calls: list[str] = []
    monkeypatch.setattr(app, "olostep_scrape", _make_fake_scraper(calls))

    outputs = app.run_quick_answer("a research topic", {})
    new_state = outputs[0]
    status_html = outputs[1]

    # Status area shows the counters even though one source failed.
    assert "候选网址" in status_html
    assert ">3<" in status_html
    assert "抓取失败" in status_html
    assert URL_FAILED in status_html
    assert "simulated upstream outage" in status_html

    # Session state records the per-URL outcomes and counts.
    assert new_state["scrape_summary"] == {
        "total": 3,
        "cached": 1,
        "succeeded": 1,
        "failed": 1,
        "failures": [{"url": URL_FAILED, "error": new_state["scrape_outcomes"][2]["error"]}],
    }
    assert [item["url"] for item in new_state["scrape_outcomes"]] == ALL_URLS
    # Stale downstream state is cleared by a fresh snapshot.
    assert "deep_research" not in new_state
    assert "signals" not in new_state


def test_run_signals_is_blocked_with_readable_error_when_all_scrapes_fail(monkeypatch, tmp_path):
    _patch_cache_dirs(monkeypatch, tmp_path)

    raw_quick = {"result": {"summary": "quick summary text", "sources": [URL_FAILED]}}
    monkeypatch.setattr(app, "olostep_answer", lambda topic: raw_quick)

    def all_fail(url: str) -> dict:
        raise RuntimeError("simulated upstream outage")

    monkeypatch.setattr(app, "olostep_scrape", all_fail)

    # Build a session exactly like the one run_quick_answer would produce.
    quick_outputs = app.run_quick_answer("a research topic", {})
    session = quick_outputs[0]
    # The failure list is still surfaced in the status area, not hidden.
    assert URL_FAILED in quick_outputs[1]
    assert "抓取失败" in quick_outputs[1]

    with pytest.raises(gr.Error) as exc_info:
        app.run_signals_option("a research topic", session)

    message = str(exc_info.value)
    assert "All candidate source pages failed" in message
    assert URL_FAILED in message
    assert "simulated upstream outage" in message
