"""Per-lookup provenance: source, browser fallback, and the anchor-count trust
signal. Everything is synthetic -- fake sessions and monkeypatched backends, no
network, no Chrome.
"""

import json

import pytest
import requests

import glens
import glens.lens as lens_mod
from glens import cli
from glens.lens import Provenance

RESULTS_URL = "https://www.google.com/search?udm=26&synthetic=1"
JS_GATE_HTML = '<a href="/httpservice/retry/enablejs">enable</a>'


def _items(n_external: int, n_internal: int = 0) -> list[dict]:
    """Synthetic anchors: n_external merchant links + n_internal Google links."""
    items = [
        {"href": f"https://shop{i}.example/p/{i}", "text": f"Acme Widget Model {i} Pro"}
        for i in range(n_external)
    ]
    items += [
        {"href": "https://www.google.com/search?q=related", "text": "Related searches"}
    ] * n_internal
    return items


# At/above the existing "rendered page" threshold (_MIN_RENDERED_ANCHORS = 10)...
RENDERED_ITEMS = _items(12)
# ...and below it: real merchant results, but too few anchors to trust the page.
THIN_ITEMS = _items(4)


def _html_for(items: list[dict]) -> str:
    anchors = "".join(
        f'<a href="{i["href"]}" aria-label="{i["text"]}">t</a>' for i in items
    )
    return f"<html><body>{anchors}</body></html>"


class FakeResponse:
    def __init__(self, url: str, text: str, status: int = 200):
        self.url = url
        self.text = text
        self.status = status

    def raise_for_status(self):
        if self.status >= 400:
            raise requests.HTTPError(f"synthetic {self.status}")


class FakeSession:
    """Answers the req backend's upload (and follow-up GET) with fixed HTML."""

    def __init__(self, html: str, url: str = RESULTS_URL, status: int = 200):
        self.html = html
        self.url = url
        self.status = status

    def post(self, *args, **kwargs):
        return FakeResponse(self.url, self.html, self.status)

    def get(self, *args, **kwargs):
        return FakeResponse(self.url, self.html, self.status)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(lens_mod.time, "sleep", lambda seconds: None)


@pytest.fixture
def jar_file(tmp_path):
    jar = tmp_path / "jar.json"
    jar.write_text(json.dumps({
        "user_agent": "synthetic-agent/1.0",
        "cookies": [{"name": "TEST", "value": "1", "domain": ".google.com", "path": "/"}],
    }), encoding="utf-8")
    return jar


def _fake_browser(items, url=RESULTS_URL, calls=None):
    def fake(frame_bytes, cookie_file, timeout, driver_factory, *locale):
        if calls is not None:
            calls.append("browser")
        return items, url
    return fake


# ---------------------------------------------------------------------------
# Normal paths: each source reports itself
# ---------------------------------------------------------------------------

def test_req_success_reports_req_source(monkeypatch, tmp_path):
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")

    prov = result.provenance
    assert isinstance(prov, Provenance)
    assert prov.source == "req"
    assert prov.browser_fallback is False
    assert prov.fallback_reason is None
    assert prov.external_anchors == 12
    assert prov.rendered is True


def test_req_success_through_the_real_req_path(monkeypatch, jar_file):
    # The genuine _search_via_requests, riding a fake session: the full
    # upload -> parse -> provenance chain with no network involved.
    session = FakeSession(_html_for(RENDERED_ITEMS))
    monkeypatch.setattr(lens_mod, "_req_session", lambda jar, lang=None: session)

    result = glens.search(b"img", backend="req", cookie_file=jar_file)

    assert result is not None
    prov = result.provenance
    assert prov.source == "req"
    assert prov.browser_fallback is False
    assert prov.external_anchors == 12
    assert prov.rendered is True


def test_explicit_browser_run_is_not_a_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: pytest.fail("backend='browser' must not touch req"))
    monkeypatch.setattr(lens_mod, "_search_via_browser", _fake_browser(RENDERED_ITEMS))

    result = glens.search(b"img", backend="browser", cookie_file=tmp_path / "jar.json",
                          driver_factory=lambda: None)

    prov = result.provenance
    assert prov.source == "browser"
    assert prov.browser_fallback is False
    assert prov.fallback_reason is None


# ---------------------------------------------------------------------------
# Cache hits
# ---------------------------------------------------------------------------

@pytest.fixture
def cache_dir(monkeypatch, tmp_path):
    directory = tmp_path / "results-cache"
    monkeypatch.setenv("GLENS_CACHE_DIR", str(directory))
    return directory


def test_cache_hit_reports_cache_source_and_skips_everything(monkeypatch, tmp_path,
                                                             cache_dir):
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))
    first = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json",
                         use_cache=True)
    assert first.provenance.source == "req"          # the seeding run was live

    def explode(*args):
        raise AssertionError("a cache hit must not touch the network or a browser")

    monkeypatch.setattr(lens_mod, "_search_via_requests", explode)
    monkeypatch.setattr(lens_mod, "_search_via_browser", explode)
    monkeypatch.setattr(lens_mod, "_resolve_google_redirects", explode)

    second = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json",
                          use_cache=True)
    prov = second.provenance
    assert prov.source == "cache"
    assert prov.browser_fallback is False
    assert prov.fallback_reason is None
    assert prov.external_anchors == 12
    assert prov.rendered is True


def test_explicit_browser_skips_cache_and_reports_browser(monkeypatch, tmp_path,
                                                          cache_dir):
    # Seed the cache, then an explicit browser run must still go live (it
    # re-mints the cookie jar) and say so.
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))
    glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json",
                 use_cache=True)
    assert list(cache_dir.glob("*.json"))

    calls = []
    monkeypatch.setattr(lens_mod, "_search_via_browser", _fake_browser(THIN_ITEMS,
                                                                       calls=calls))
    result = glens.search(b"img", backend="browser", cookie_file=tmp_path / "jar.json",
                          use_cache=True, driver_factory=lambda: None)

    assert calls == ["browser"]
    assert result.provenance.source == "browser"
    assert result.provenance.browser_fallback is False


# ---------------------------------------------------------------------------
# req degraded -> browser fallback, with the reason attached
# ---------------------------------------------------------------------------

def test_fallback_to_browser_when_cookie_jar_missing(monkeypatch, tmp_path):
    # No jar on disk: the REAL req backend short-circuits, the browser takes over.
    monkeypatch.setattr(lens_mod, "_search_via_browser", _fake_browser(RENDERED_ITEMS))

    result = glens.search(b"img", backend="auto", cookie_file=tmp_path / "missing.json",
                          driver_factory=lambda: None)

    prov = result.provenance
    assert prov.source == "browser"
    assert prov.browser_fallback is True
    assert prov.fallback_reason == "no_cookie_jar"
    assert prov.external_anchors == 12
    assert prov.rendered is True


def test_fallback_reason_js_gate(monkeypatch, jar_file):
    session = FakeSession(JS_GATE_HTML)
    monkeypatch.setattr(lens_mod, "_req_session", lambda jar, lang=None: session)
    monkeypatch.setattr(lens_mod, "_search_via_browser", _fake_browser(RENDERED_ITEMS))

    result = glens.search(b"img", backend="auto", cookie_file=jar_file,
                          driver_factory=lambda: None)

    prov = result.provenance
    assert prov.source == "browser"
    assert prov.browser_fallback is True
    assert prov.fallback_reason == "js_gate"


def test_fallback_reason_degraded_page(monkeypatch, jar_file):
    degraded = _html_for(_items(1))                # one lonely external anchor
    session = FakeSession(degraded)
    monkeypatch.setattr(lens_mod, "_req_session", lambda jar, lang=None: session)
    monkeypatch.setattr(lens_mod, "_search_via_browser", _fake_browser(RENDERED_ITEMS))

    result = glens.search(b"img", backend="auto", cookie_file=jar_file,
                          driver_factory=lambda: None)

    assert result.provenance.fallback_reason == "degraded_page"
    assert result.provenance.browser_fallback is True


def test_fallback_reason_http_error(monkeypatch, jar_file):
    session = FakeSession(_html_for(RENDERED_ITEMS), status=429)
    monkeypatch.setattr(lens_mod, "_req_session", lambda jar, lang=None: session)
    monkeypatch.setattr(lens_mod, "_search_via_browser", _fake_browser(RENDERED_ITEMS))

    result = glens.search(b"img", backend="auto", cookie_file=jar_file,
                          driver_factory=lambda: None)

    assert result.provenance.fallback_reason == "http_error"
    assert result.provenance.browser_fallback is True


def test_req_backend_failure_without_browser_carries_no_result(monkeypatch, tmp_path):
    # backend="req" never falls back; a failed lookup is None, and None carries
    # no provenance at all.
    monkeypatch.setattr(lens_mod, "_search_via_browser",
                        lambda *a: pytest.fail("backend='req' must not reach the browser"))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "missing.json")
    assert result is None


# ---------------------------------------------------------------------------
# The rendered-threshold boundary
# ---------------------------------------------------------------------------

def test_below_threshold_harvest_is_flagged_not_rendered(monkeypatch, tmp_path):
    # 4 external anchors: enough for the req backend to accept the page (>= 3),
    # far below the 10-anchor "rendered" threshold.
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (THIN_ITEMS, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")

    assert result is not None
    prov = result.provenance
    assert prov.source == "req"
    assert prov.external_anchors == 4
    assert prov.rendered is False


def test_internal_anchors_do_not_count_as_external(monkeypatch, tmp_path):
    items = _items(11, n_internal=3)               # 14 anchors, only 11 external
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (items, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")

    prov = result.provenance
    assert prov.external_anchors == 11
    assert prov.rendered is True                   # threshold judges the harvest


def test_exactly_at_threshold_is_rendered(monkeypatch, tmp_path):
    items = _items(lens_mod._MIN_RENDERED_ANCHORS)
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (items, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")
    assert result.provenance.rendered is True
    assert result.provenance.external_anchors == lens_mod._MIN_RENDERED_ANCHORS


def test_one_below_threshold_is_not_rendered(monkeypatch, tmp_path):
    items = _items(lens_mod._MIN_RENDERED_ANCHORS - 1)
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (items, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")
    assert result.provenance.rendered is False


# ---------------------------------------------------------------------------
# Serialization: to_dict() and the CLI's --json
# ---------------------------------------------------------------------------

def test_to_dict_includes_json_safe_provenance(monkeypatch, tmp_path):
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")

    data = result.to_dict()
    assert data["provenance"] == {
        "source": "req",
        "browser_fallback": False,
        "fallback_reason": None,
        "external_anchors": 12,
        "rendered": True,
    }
    # The whole payload must survive a JSON round-trip unchanged.
    assert json.loads(json.dumps(data)) == data


def test_to_dict_raw_anchors_behaviour_unchanged(monkeypatch, tmp_path):
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))
    result = glens.search(b"img", backend="req", cookie_file=tmp_path / "jar.json")

    assert "raw_anchors" not in result.to_dict()
    with_raw = result.to_dict(raw_anchors=True)
    assert with_raw["raw_anchors"] == RENDERED_ITEMS
    assert with_raw["provenance"]["source"] == "req"


def test_result_without_provenance_still_serializes():
    # A LensResult built by hand (no provenance) stays JSON-safe.
    result = glens.LensResult(top_title="Acme Widget Pro", titles=["Acme Widget Pro"],
                              matches=[])
    data = result.to_dict()
    assert data["provenance"] is None
    assert json.loads(json.dumps(data)) == data


def test_cli_json_includes_provenance(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("GLENS_COOKIE_FILE", str(tmp_path / "jar.json"))
    image = tmp_path / "photo.jpg"
    image.write_bytes(b"synthetic-jpeg-bytes")
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))

    rc = cli.main([str(image), "--backend", "req", "--json"])
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["provenance"]["source"] == "req"
    assert payload["provenance"]["rendered"] is True
    assert payload["provenance"]["external_anchors"] == 12
    assert "raw_anchors" not in payload


def test_cli_json_raw_still_adds_anchors(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("GLENS_COOKIE_FILE", str(tmp_path / "jar.json"))
    image = tmp_path / "photo.jpg"
    image.write_bytes(b"synthetic-jpeg-bytes")
    monkeypatch.setattr(lens_mod, "_search_via_requests",
                        lambda *a: (RENDERED_ITEMS, RESULTS_URL))

    rc = cli.main([str(image), "--backend", "req", "--json", "--raw"])
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["raw_anchors"] == RENDERED_ITEMS
    assert payload["provenance"]["source"] == "req"


def test_cli_no_results_json_still_emits_null(monkeypatch, tmp_path, capsys):
    # A failed lookup has no provenance; the --json contract ("null") is unchanged.
    monkeypatch.setenv("GLENS_COOKIE_FILE", str(tmp_path / "jar.json"))
    image = tmp_path / "photo.jpg"
    image.write_bytes(b"synthetic-jpeg-bytes")
    monkeypatch.setattr(lens_mod, "_search_via_requests", lambda *a: (None, None))

    rc = cli.main([str(image), "--backend", "req", "--json"])
    assert rc == 1
    assert json.loads(capsys.readouterr().out) is None
