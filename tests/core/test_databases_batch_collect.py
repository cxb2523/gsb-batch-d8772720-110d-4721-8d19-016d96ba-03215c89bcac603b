"""Batch collection via collect_all(): per-source outcomes and failure reruns.

search_all() already returned one DBResult per source, but a caller could not
tell "the service said nothing exists" from "the service rate-limited us and
then answered", and a partial failure meant re-asking every source by hand.
collect_all() keeps the per-source outcome (success / no_records / retried /
failed) and its timing, and BatchSearchResult.rerun_failed() re-asks only the
sources that failed.  All HTTP is stubbed; no test here opens a socket.
"""
import json
import urllib.error
import urllib.request
from email.message import Message

import pytest

from biosuite.core import databases as db


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    db.invalidate_cache()
    monkeypatch.setattr(db, 'get_api_key', lambda name: 'k@example.com')
    monkeypatch.setattr(db, 'prompt_api_key', lambda *a, **k: 'k@example.com')
    yield
    db.invalidate_cache()


# ── Stub payloads ─────────────────────────────────────────────────────────────

_NCBI_ESEARCH = json.dumps({'esearchresult': {'idlist': ['111']}}).encode()
_NCBI_ESUMMARY = json.dumps({'result': {
    '111': {'title': 'Rec A', 'organism': 'Homo sapiens', 'accessionversion': 'NM_1'},
}}).encode()
_UNIPROT = json.dumps({'results': [{
    'primaryAccession': 'P04637',
    'proteinDescription': {'recommendedName': {'fullName': {'value': 'p53'}}},
    'organism': {'scientificName': 'Homo sapiens'},
    'sequence': {'length': 393},
    'genes': [{'geneName': {'value': 'TP53'}}],
}]}).encode()
_PDB = json.dumps({'result_set': [{'identifier': '1TUP', 'score': 1.0}]}).encode()
_KEGG = "hsa04610\tComplement and coagulation cascades\n".encode()
_ENSEMBL = json.dumps({'id': 'ENSG00000141510', 'description': 'tumor protein p53',
                       'species': 'homo_sapiens', 'biotype': 'protein_coding'}).encode()


def _payload_for(url):
    if 'esearch' in url:
        return _NCBI_ESEARCH
    if 'esummary' in url:
        return _NCBI_ESUMMARY
    if 'uniprot' in url:
        return _UNIPROT
    if 'rcsb' in url:
        return _PDB
    if 'kegg' in url:
        return _KEGG
    if 'ensembl' in url:
        return _ENSEMBL
    raise AssertionError(f"unexpected URL: {url}")


def _stub_http(monkeypatch, func):
    """Replace _http_get with *func(url, **kw) -> bytes* and record its calls."""
    calls = []
    def fake(url, **kw):
        calls.append(url)
        return func(url)
    monkeypatch.setattr(db, '_http_get', fake)
    return calls


# ── All sources succeed ───────────────────────────────────────────────────────

def test_collect_all_success_reports_each_source(monkeypatch):
    _stub_http(monkeypatch, _payload_for)

    batch = db.collect_all('tp53')

    assert set(batch.reports) == set(db.DEFAULT_SEARCH_DATABASES)
    assert 'ensembl' not in batch.reports  # opt-in only, like search_all()
    for name, report in batch.reports.items():
        assert report.status == db.OUTCOME_SUCCESS, name
        assert not report.result.error
        assert report.result.records, name
        assert report.elapsed >= 0.0
        assert report.retries == 0
    assert batch.failed_sources == []
    assert sorted(batch.succeeded_sources) == sorted(db.DEFAULT_SEARCH_DATABASES)
    assert batch.elapsed >= 0.0
    # the plain mapping view stays compatible with search_all() consumers
    assert set(batch.results) == set(db.DEFAULT_SEARCH_DATABASES)


def test_collect_all_includes_ensembl_only_when_named(monkeypatch):
    _stub_http(monkeypatch, _payload_for)

    batch = db.collect_all('TP53', databases=['uniprot', 'ensembl'])

    assert batch.reports['ensembl'].status == db.OUTCOME_SUCCESS
    assert batch.reports['ensembl'].result.records[0]['id'] == 'ENSG00000141510'
    assert batch.reports['uniprot'].status == db.OUTCOME_SUCCESS


def test_collect_all_marks_cache_hits(monkeypatch):
    _stub_http(monkeypatch, _payload_for)

    db.collect_all('tp53', databases=['uniprot'])
    second = db.collect_all('tp53', databases=['uniprot'])

    assert second.reports['uniprot'].result.cached is True
    assert second.reports['uniprot'].status == db.OUTCOME_SUCCESS


def test_collect_all_empty_answer_is_no_records(monkeypatch):
    def empty(url):
        if 'uniprot' in url:
            return json.dumps({'results': []}).encode()
        return _payload_for(url)
    _stub_http(monkeypatch, empty)

    batch = db.collect_all('nothingmatches', databases=['uniprot'])

    report = batch.reports['uniprot']
    assert report.status == db.OUTCOME_NO_RECORDS
    assert not report.result.error
    assert report.result.records == []


# ── Unknown source ────────────────────────────────────────────────────────────

def test_collect_all_unknown_source_is_a_failed_outcome(monkeypatch):
    calls = _stub_http(monkeypatch, _payload_for)

    batch = db.collect_all('tp53', databases=['uniprot', 'bogusdb'])

    report = batch.reports['bogusdb']
    assert report.status == db.OUTCOME_FAILED
    assert 'Unknown database' in report.result.error
    assert batch.failed_sources == ['bogusdb']
    # the unknown name did not interrupt the real source
    assert batch.reports['uniprot'].status == db.OUTCOME_SUCCESS
    assert any('uniprot' in url for url in calls)


# ── Partial failure, then rerun only the failures ─────────────────────────────

def test_collect_all_partial_failure_then_rerun_failed(monkeypatch):
    state = {'kegg_down': True}

    def flaky(url):
        if 'kegg' in url and state['kegg_down']:
            raise urllib.error.URLError('connection refused')
        return _payload_for(url)
    calls = _stub_http(monkeypatch, flaky)

    first = db.collect_all('complement', databases=['uniprot', 'kegg'])
    assert first.reports['kegg'].status == db.OUTCOME_FAILED
    assert first.reports['uniprot'].status == db.OUTCOME_SUCCESS
    assert first.failed_sources == ['kegg']

    state['kegg_down'] = False
    calls.clear()
    merged = first.rerun_failed()

    # only the failed source was asked again
    assert calls and all('kegg' in url for url in calls)
    assert merged.reports['kegg'].status == db.OUTCOME_SUCCESS
    assert merged.reports['kegg'].result.records
    # the successful source carried over untouched
    assert merged.reports['uniprot'] is first.reports['uniprot']
    assert merged.failed_sources == []
    # the original batch object is unchanged
    assert first.reports['kegg'].status == db.OUTCOME_FAILED


def test_rerun_failed_with_nothing_to_do_requests_nothing(monkeypatch):
    calls = _stub_http(monkeypatch, _payload_for)

    batch = db.collect_all('tp53', databases=['uniprot'])
    calls.clear()
    again = batch.rerun_failed()

    assert calls == []
    assert again.reports['uniprot'].status == db.OUTCOME_SUCCESS


# ── Rate-limited, retried, then succeeded ─────────────────────────────────────

class _Resp:
    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Clock:
    """time module stand-in: records sleeps instead of performing them."""

    def __init__(self):
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)

    @staticmethod
    def time():
        import time as _t
        return _t.time()

    @staticmethod
    def monotonic():
        import time as _t
        return _t.monotonic()


def _http_429():
    headers = Message()
    headers['Retry-After'] = '0'
    return urllib.error.HTTPError('https://rest.uniprot.org/x', 429,
                                  'Too Many Requests', headers, None)


def test_collect_all_reports_rate_limit_retry_success(monkeypatch):
    # The real _http_get drives this one: urlopen answers 429 once, then the
    # payload — the retry, the wait and the classification must all line up.
    monkeypatch.setattr(db, '_rate_limiter',
                        type('R', (), {'wait': lambda self, s: None})())
    clock = _Clock()
    monkeypatch.setattr(db, 'time', clock)

    attempts = []
    def urlopen(req, timeout=None):
        attempts.append(req)
        if len(attempts) == 1:
            raise _http_429()
        return _Resp(_UNIPROT)
    monkeypatch.setattr(urllib.request, 'urlopen', urlopen)

    batch = db.collect_all('tp53', databases=['uniprot'])

    report = batch.reports['uniprot']
    assert len(attempts) == 2
    assert clock.sleeps, "the 429 must have caused a wait before the retry"
    assert report.status == db.OUTCOME_RETRIED
    assert report.retries == 1
    assert not report.result.error
    assert report.result.records[0]['accession'] == 'P04637'
    assert batch.failed_sources == []
