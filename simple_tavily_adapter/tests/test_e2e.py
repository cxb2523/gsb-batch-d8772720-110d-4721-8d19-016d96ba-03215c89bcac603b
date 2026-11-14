"""End-to-end: real Docker, real Hermes image, real vLLM. Slow.

Run with: RUN_E2E=1 pytest tests/test_e2e.py -v
"""
from __future__ import annotations

import os
import time

import httpx
import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("RUN_E2E"),
    reason="E2E tests require RUN_E2E=1 (needs real stack)",
)

ADAPTER_URL = os.environ.get("ADAPTER_URL", "http://localhost:8000")


def test_full_research_cycle_produces_markdown_report():
    """POST /research → poll until completed → verify report has cited markdown."""
    r = httpx.post(
        f"{ADAPTER_URL}/research",
        json={"query": "What is trafilatura in one sentence? Cite the GitHub repo."},
        timeout=10,
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    deadline = time.time() + 600
    body = {}
    while time.time() < deadline:
        status_r = httpx.get(f"{ADAPTER_URL}/research/{job_id}", timeout=10)
        assert status_r.status_code == 200
        body = status_r.json()
        if body["status"] in ("completed", "failed", "timeout", "cancelled"):
            break
        time.sleep(5)
    else:
        pytest.fail("Job didn't finish in 10 minutes")

    assert body["status"] == "completed", f"got {body['status']}: {body.get('error')}"
    report = body["report"]
    assert report and len(report) > 200
    assert "trafilatura" in report.lower()
    assert "[1]" in report
