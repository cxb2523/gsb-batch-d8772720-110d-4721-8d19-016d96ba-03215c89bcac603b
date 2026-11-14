"""Tests for the fetch-outcome record (sources) and the /api/fetch-outcome endpoint.

All network access is stubbed — no real Reddit requests.
"""

import json
import os
import tempfile
from unittest.mock import patch

import pytest

from reddit_scraper import config, sources


@pytest.fixture(autouse=True)
def reset_source_state():
    """Source state is module-global; reset it (and disable caching) per test."""
    sources._state.reset()
    sources.RSS_MIN_INTERVAL = 0
    sources.FETCH_CACHE_TTL = 0
    sources._PROXIES = []
    sources.SYLVIA_API_KEY = None
    config.set_source_order(None)
    yield


def _post():
    return [
        {
            'id': '1',
            'title': 't',
            'url': '',
            'score': 0,
            'permalink': '/p',
            'domain': '',
            'link_flair_text': '',
            'author': 'a',
        }
    ]


def _raises(*a, **k):
    raise RuntimeError("blocked")


class TestPostsOutcome:
    def test_error_then_success_records_both_and_final_source(self, monkeypatch):
        """First source errors, second succeeds: both statuses and the final source
        must appear in the recorded outcome."""
        config.set_source_order(['json', 'rss'])
        monkeypatch.setattr(sources, 'fetch_posts_json', _raises)
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: _post())

        posts, source = sources.fetch_posts('gamedeals', 10, reddit=None)
        assert source == 'rss'

        outcome = sources.get_last_fetch_outcome()
        assert outcome is not None
        assert outcome['kind'] == 'posts'
        assert outcome['subreddit'] == 'gamedeals'
        assert outcome['thread_id'] is None
        assert outcome['ok'] is True
        assert outcome['final_source'] == 'rss'
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('json', 'error'),
            ('rss', 'success'),
        ]
        # error detail is a plain type name, never a traceback
        assert outcome['attempts'][0]['error'] == 'RuntimeError'
        assert 'Traceback' not in json.dumps(outcome)

    def test_empty_result_distinguished_from_error(self, monkeypatch):
        """A source returning None is recorded as 'empty', not 'error'."""
        config.set_source_order(['json', 'rss'])
        monkeypatch.setattr(sources, 'fetch_posts_json', lambda sub, lim: None)
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: _post())

        sources.fetch_posts('gamedeals', 10, reddit=None)
        outcome = sources.get_last_fetch_outcome()
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('json', 'empty'),
            ('rss', 'success'),
        ]

    def test_all_sources_fail_records_failure_outcome(self, monkeypatch):
        config.set_source_order(['json', 'rss'])
        monkeypatch.setattr(sources, 'fetch_posts_json', _raises)
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: None)

        posts, source = sources.fetch_posts('gamedeals', 10, reddit=None)
        assert (posts, source) == (None, None)

        outcome = sources.get_last_fetch_outcome()
        assert outcome['ok'] is False
        assert outcome['final_source'] is None
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('json', 'error'),
            ('rss', 'empty'),
        ]

    def test_cooldown_source_marked_skipped_not_failed(self, monkeypatch):
        """A source in cooldown must be recorded as skipped, not as a failure."""
        config.set_source_order(['json', 'rss'])
        sources._mark_source_down('json', 300)
        monkeypatch.setattr(sources, 'fetch_posts_json', lambda *a, **k: pytest.fail("must not be called"))
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: _post())

        posts, source = sources.fetch_posts('gamedeals', 10, reddit=None)
        assert source == 'rss'

        outcome = sources.get_last_fetch_outcome()
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('json', 'skipped_cooldown'),
            ('rss', 'success'),
        ]

    def test_unconfigured_source_marked_skipped_unconfigured(self, monkeypatch):
        """sylvia without an API key is skipped as unconfigured, not failed."""
        sources.SYLVIA_API_KEY = None
        config.set_source_order(['sylvia', 'rss'])
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: _post())

        sources.fetch_posts('gamedeals', 10, reddit=None)
        outcome = sources.get_last_fetch_outcome()
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('sylvia', 'skipped_unconfigured'),
            ('rss', 'success'),
        ]


class TestCommentsOutcome:
    def test_comment_chain_records_outcome(self, monkeypatch):
        """The thread-comments chain records its outcome too, with the thread id."""
        config.set_source_order(['json', 'rss'])
        monkeypatch.setattr(sources, 'fetch_thread_comments_json', _raises)
        monkeypatch.setattr(
            sources,
            'fetch_thread_comments_rss',
            lambda sub, tid: [{'id': 'c1', 'body': 'b', 'author': 'a', 'score': 0, 'permalink': '/p'}],
        )

        comments = sources.fetch_thread_comments('gamedeals', 'abc123', reddit=None)
        assert comments is not None

        outcome = sources.get_last_fetch_outcome()
        assert outcome['kind'] == 'comments'
        assert outcome['subreddit'] == 'gamedeals'
        assert outcome['thread_id'] == 'abc123'
        assert outcome['final_source'] == 'rss'
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('json', 'error'),
            ('rss', 'success'),
        ]

    def test_comment_chain_all_fail(self, monkeypatch):
        config.set_source_order(['json'])
        monkeypatch.setattr(sources, 'fetch_thread_comments_json', _raises)

        assert sources.fetch_thread_comments('gamedeals', 'abc123', reddit=None) is None
        outcome = sources.get_last_fetch_outcome()
        assert outcome['ok'] is False
        assert outcome['final_source'] is None


@pytest.fixture
def client():
    """Flask test client with an isolated DATA_DIR."""
    with tempfile.TemporaryDirectory() as tmpdir:
        with patch.dict(os.environ, {'DATA_DIR': tmpdir}):
            with open(os.path.join(tmpdir, 'search.json'), 'w') as f:
                json.dump({'subreddits_to_search': []}, f)
            with open(os.path.join(tmpdir, 'credentials.json'), 'w') as f:
                json.dump({}, f)

            import importlib

            import api

            importlib.reload(api)

            api.app.config['TESTING'] = True
            with api.app.test_client() as client:
                yield client


class TestFetchOutcomeAPI:
    def test_empty_structure_when_no_record(self, client):
        """No fetch has run yet: the endpoint returns an empty structure, not an error."""
        response = client.get('/api/fetch-outcome')
        assert response.status_code == 200
        data = response.get_json()
        assert data['outcome'] is None
        assert data['all_failed'] is False
        assert data['degraded'] is False

    def test_returns_recorded_outcome(self, client, monkeypatch):
        config.set_source_order(['json', 'rss'])
        monkeypatch.setattr(sources, 'fetch_posts_json', _raises)
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: _post())
        sources.fetch_posts('gamedeals', 10, reddit=None)

        data = client.get('/api/fetch-outcome').get_json()
        assert data['all_failed'] is False
        assert data['degraded'] is True  # rss is not a rich source
        outcome = data['outcome']
        assert outcome['final_source'] == 'rss'
        assert [(a['source'], a['status']) for a in outcome['attempts']] == [
            ('json', 'error'),
            ('rss', 'success'),
        ]
        assert outcome['timestamp'] > 0

    def test_all_failed_outcome_exposed(self, client, monkeypatch):
        config.set_source_order(['json', 'rss'])
        monkeypatch.setattr(sources, 'fetch_posts_json', _raises)
        monkeypatch.setattr(sources, 'fetch_posts_rss', lambda sub, lim: None)
        sources.fetch_posts('gamedeals', 10, reddit=None)

        data = client.get('/api/fetch-outcome').get_json()
        assert data['all_failed'] is True
        assert data['degraded'] is False
        assert data['outcome']['final_source'] is None
        assert data['outcome']['ok'] is False

    def test_rich_source_not_degraded(self, client, monkeypatch):
        monkeypatch.setattr(sources, '_fetch_posts_oauth', lambda r, sub, lim: _post())
        sources.fetch_posts('gamedeals', 10, reddit=object())

        data = client.get('/api/fetch-outcome').get_json()
        assert data['outcome']['final_source'] == 'oauth'
        assert data['degraded'] is False
        assert data['all_failed'] is False
