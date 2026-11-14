import json

import pytest
import requests

from ccencrypt.batch import resume_batch, run_batch

CARD_JOB = {
    "card": "4242 4242 4242 4242",
    "month": "4",
    "year": "2030",
    "cvv": "123",
    "name": "Jane Doe",
}


def stripe_job(job_id="job-1", **overrides):
    job = {"id": job_id, "processor": "stripe", "key": "pk_test_123", **CARD_JOB}
    job.update(overrides)
    return job


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        return self._body or {}


class FakePoster:
    """Routes fake responses per URL and records every call."""

    def __init__(self):
        self.routes = {}
        self.calls = []

    def add(self, url, responses):
        self.routes[url] = list(responses)
        return self

    def __call__(self, url, **kwargs):
        self.calls.append({"url": url, "kwargs": kwargs})
        queued = self.routes[url]
        return queued.pop(0) if len(queued) > 1 else queued[0]


@pytest.fixture
def poster(monkeypatch):
    fake = FakePoster()
    monkeypatch.setattr(requests, "post", fake)
    return fake


STRIPE_OK = FakeResponse(200, {"id": "pm_1ABC"})
STRIPE_429 = FakeResponse(429, {"error": {"message": "rate limited, slow down"}})


def test_success_returns_token_and_empty_manifest(poster):
    poster.add("https://api.stripe.com/v1/payment_methods", [STRIPE_OK])

    out = run_batch([stripe_job()], proxy="http://127.0.0.1:8080", timeout=7,
                    user_agent="batch-ua/1.0")

    assert out["results"] == [{"id": "job-1", "status": "ok", "token": "pm_1ABC"}]
    assert out["manifest"] == {"failed": []}
    # proxy / timeout / user_agent are passed through to the channel request
    call = poster.calls[0]
    assert call["kwargs"]["proxies"] == {"http": "http://127.0.0.1:8080",
                                         "https": "http://127.0.0.1:8080"}
    assert call["kwargs"]["timeout"] == 7
    assert call["kwargs"]["headers"]["user-agent"] == "batch-ua/1.0"


def test_rate_limit_failure_then_resume_succeeds(poster):
    poster.add("https://api.stripe.com/v1/payment_methods",
               [STRIPE_OK, STRIPE_429, STRIPE_OK])
    jobs = [stripe_job("job-ok"), stripe_job("job-limited")]

    first = run_batch(jobs)
    by_id = {r["id"]: r for r in first["results"]}
    assert by_id["job-ok"]["status"] == "ok"
    assert by_id["job-limited"]["status"] == "failed"
    err = by_id["job-limited"]["error"]
    assert err["type"] == "http_error"
    assert err["status_code"] == 429
    assert "rate limited" in err["response"]
    assert first["manifest"] == {"failed": ["job-limited"]}
    assert len(poster.calls) == 2

    second = resume_batch(first["manifest"], jobs)
    assert second["results"] == [{"id": "job-limited", "status": "ok", "token": "pm_1ABC"}]
    assert second["manifest"] == {"failed": []}
    # only the failed job was re-requested; the successful one was not
    assert len(poster.calls) == 3


def test_missing_credential_field_sends_no_request(poster):
    job = stripe_job()
    del job["key"]

    out = run_batch([job])

    assert out["results"][0]["status"] == "failed"
    assert out["results"][0]["error"] == {"type": "missing_field", "fields": ["key"]}
    assert out["manifest"] == {"failed": ["job-1"]}
    assert poster.calls == []


def test_unknown_processor_fails_without_request(poster):
    out = run_batch([stripe_job(processor="adyen")])

    assert out["results"][0]["status"] == "failed"
    assert out["results"][0]["error"] == {"type": "invalid_processor", "processor": "adyen"}
    assert out["manifest"] == {"failed": ["job-1"]}
    assert poster.calls == []


def test_duplicate_id_is_skipped_after_first(poster):
    poster.add("https://api.stripe.com/v1/payment_methods", [STRIPE_OK])

    out = run_batch([stripe_job(), stripe_job()])

    assert [r["status"] for r in out["results"]] == ["ok", "skipped"]
    assert out["results"][1] == {"id": "job-1", "status": "skipped",
                                 "reason": "duplicate_id"}
    assert len(poster.calls) == 1


def test_resume_rejects_manifest_ids_missing_from_jobs(poster):
    with pytest.raises(ValueError, match="ghost"):
        resume_batch({"failed": ["ghost"]}, [stripe_job()])
    assert poster.calls == []
