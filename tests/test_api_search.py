"""The JSON endpoint must expose enrichment outcomes without failing the page."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app as app_module
from conftest import FakeResponse
from test_search_with_sources import build_upstream, video_url


@pytest.fixture
def client(scraper, monkeypatch):
    monkeypatch.setattr(app_module, "scraper", scraper)
    return TestClient(app_module.app)


def test_api_partial_failure_returns_200_with_mixed_statuses(client, scraper):
    upstream = build_upstream(
        ok=("v1", "v3"),
        failures={"v2": FakeResponse("gone", video_url("v2"), status_code=404)},
    )
    scraper._get = upstream.get  # type: ignore[method-assign]

    response = client.get("/api/search", params={"q": "test query", "with_sources": "1"})

    assert response.status_code == 200
    body = response.json()
    assert [video["id"] for video in body["videos"]] == ["v1", "v2", "v3"]
    assert [video["sources_status"] for video in body["videos"]] == ["ok", "failed", "ok"]
    assert body["videos"][1]["sources_error"] == "video page could not be loaded"
    assert body["videos"][1]["title"] == "Second video"


def test_api_without_sources_does_not_enrich(client, scraper):
    upstream = build_upstream(ok=("v1", "v2", "v3"))
    scraper._get = upstream.get  # type: ignore[method-assign]

    response = client.get("/api/search", params={"q": "test query"})

    assert response.status_code == 200
    body = response.json()
    for video in body["videos"]:
        assert "sources" not in video
        assert "sources_status" not in video
    assert len(upstream.requested_urls()) == 1
