"""Tests for crawl.py's per-page outcome manifest (<out>.progress.json) + --resume.

Browser-free: crawl.run_pt is patched with a fake pinchtab bridge serving a
self-made 3-page sample site; everything else in crawl.py (queueing, URL
normalization, outcome recording, manifest writing, resume re-queueing) runs
for real.

Sample site (http://sample.test):
  /         Home    — links to /ok, /broken, /private         (normal page)
  /ok       OK      — normal page, links back to /            (normal page)
  /broken   Broken  — nav fails HTTP 500 until "fixed"        (error page)
  /private  Private — nav "succeeds" but lands on /auth       (login redirect)
  /auth     Login   — the --auth-path page
"""
import json
import sys

import pytest

from pinchtab_webgraph import crawl

BASE = "http://sample.test"


class FakeBridge:
    """A drop-in for crawl.run_pt backed by the sample site above."""

    def __init__(self):
        self.url = BASE + "/"
        self.broken_fixed = False
        self.navs = []          # every URL the crawler tried to navigate to

    def __call__(self, args, server, timeout=90):
        cmd = args[0]
        if cmd == "nav":
            url = args[1]
            self.navs.append(url)
            if url == BASE + "/broken" and not self.broken_fixed:
                return 1, "", "HTTP 500 Internal Server Error"
            if url == BASE + "/private":
                self.url = BASE + "/auth"       # login redirect
                return 0, "ok", ""
            self.url = url
            return 0, "ok", ""
        if cmd == "wait":
            return 0, "ok", ""
        if cmd == "eval":
            expr = args[1]
            if 'querySelectorAll("a[href]").length' in expr:   # settle poll
                return 0, "5", ""
            if expr.strip() == "location.href":
                return 0, json.dumps(self.url), ""
            if "querySelectorAll('a[href]')" in expr:          # EXTRACT_JS
                return 0, json.dumps(json.dumps(self._page())), ""
            return 0, json.dumps(""), ""
        return 0, "ok", ""                                     # click / press

    def _page(self):
        home = {"href": BASE + "/", "text": "Home", "download": False, "dlKind": None}
        if self.url == BASE + "/":
            return {"url": self.url, "title": "Home", "actions": [], "links": [
                {"href": BASE + "/ok", "text": "OK", "download": False, "dlKind": None},
                {"href": BASE + "/broken", "text": "Broken",
                 "download": False, "dlKind": None},
                {"href": BASE + "/private", "text": "Private",
                 "download": False, "dlKind": None}]}
        if self.url == BASE + "/ok":
            return {"url": self.url, "title": "OK Page", "actions": [], "links": [home]}
        if self.url == BASE + "/broken":
            return {"url": self.url, "title": "Fixed Page", "actions": [],
                    "links": [home]}
        return {"url": self.url, "title": "Login", "actions": [], "links": []}


@pytest.fixture
def bridge(monkeypatch):
    b = FakeBridge()
    monkeypatch.setattr(crawl, "run_pt", b)
    return b


def run_crawl(argv):
    old = sys.argv
    sys.argv = ["crawl.py"] + argv
    try:
        crawl.main()
    finally:
        sys.argv = old


def progress(out_base):
    with open(out_base + ".progress.json", encoding="utf-8") as f:
        return json.load(f)


def statuses(manifest):
    return {e["page_id"]: e["status"] for e in manifest["pages"]}


ARGS = [BASE + "/", "--auth-path", "/auth", "--interaction-depth", "0",
        "--delay", "0", "--quiet"]


def test_manifest_classifies_each_page(tmp_path, bridge):
    out = str(tmp_path / "graph")
    run_crawl(ARGS + ["--out", out, "--max-pages", "10"])
    m = progress(out)
    s = statuses(m)
    assert m["start"] == BASE + "/"
    assert s[BASE + "/"] == "success"
    assert s[BASE + "/ok"] == "success"
    assert s[BASE + "/broken"] == "failed"
    assert s[BASE + "/private"] == "auth_skipped"
    broken = next(e for e in m["pages"] if e["page_id"] == BASE + "/broken")
    assert "500" in broken["error"]
    assert m["counts"] == {"success": 2, "failed": 1, "auth_skipped": 1,
                           "unprocessed": 0, "completed": 0}
    # the manifest sits next to the existing outputs
    for ext in (".json", ".html", ".progress.json"):
        assert (tmp_path / ("graph" + ext)).exists()


def test_max_pages_cap_marks_queued_pages_unprocessed(tmp_path, bridge):
    out = str(tmp_path / "graph")
    run_crawl(ARGS + ["--out", out, "--max-pages", "3"])
    m = progress(out)
    s = statuses(m)
    assert s[BASE + "/"] == "success"
    assert m["counts"]["success"] == 1
    assert m["counts"]["unprocessed"] >= 1
    assert "unprocessed" in set(s.values())


def test_resume_retries_only_incomplete_pages(tmp_path, bridge):
    out = str(tmp_path / "graph")
    run_crawl(ARGS + ["--out", out, "--max-pages", "10"])
    bridge.broken_fixed = True
    bridge.navs.clear()
    run_crawl(ARGS + ["--out", out, "--max-pages", "10", "--resume"])
    # previously-successful pages are NOT re-visited; failed + auth-skipped are
    assert BASE + "/" not in bridge.navs
    assert BASE + "/ok" not in bridge.navs
    assert BASE + "/broken" in bridge.navs
    assert BASE + "/private" in bridge.navs
    m = progress(out)
    s = statuses(m)
    assert s[BASE + "/broken"] == "success"           # fixed page now succeeds
    assert s[BASE + "/private"] == "auth_skipped"     # still behind login
    # completed pages are carried over but never counted as THIS run's success
    assert s[BASE + "/"] == "completed"
    assert s[BASE + "/ok"] == "completed"
    assert m["counts"]["success"] == 1
    assert m["counts"]["completed"] == 2


def test_resume_missing_manifest_falls_back_to_fresh_crawl(tmp_path, bridge,
                                                           capsys):
    out = str(tmp_path / "graph")
    run_crawl(ARGS + ["--out", out, "--max-pages", "10", "--resume"])
    assert "not found" in capsys.readouterr().err
    assert statuses(progress(out))[BASE + "/ok"] == "success"  # full crawl ran


def test_resume_corrupt_manifest_falls_back_to_fresh_crawl(tmp_path, bridge,
                                                           capsys):
    out = str(tmp_path / "graph")
    with open(out + ".progress.json", "w", encoding="utf-8") as f:
        f.write("{ not json !!!")
    run_crawl(ARGS + ["--out", out, "--max-pages", "10", "--resume"])
    assert "cannot parse" in capsys.readouterr().err
    assert statuses(progress(out))[BASE + "/ok"] == "success"  # full crawl ran
