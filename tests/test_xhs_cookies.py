#!/usr/bin/env python3
"""
test_xhs_cookies.py — cookie decryption edge cases + fetch_feed exception propagation (regression tests)

Fully offline: does not touch Keychain, network, or a real Chrome profile.
"""
import pytest

from framework import chrome_cookies
from framework.adapters.xhs import XHSAdapter


def test_decrypt_empty_ciphertext_no_indexerror():
    """Empty ciphertext / bare 'v10' prefix → returns '' instead of raising IndexError.

    Before fix: enc=b'v10' stripped to empty, AES decrypt yields b'', dec[-1] raises IndexError.
    """
    key = b"0" * 16                     # any 16-byte AES-128 key
    assert chrome_cookies._decrypt(b"", key) == ""
    assert chrome_cookies._decrypt(b"v10", key) == ""


def test_fetch_feed_reraises_fatal_runtimeerror():
    """RuntimeError from detail fetch (daily rate limit / cookie expired) must propagate — not be silently swallowed.

    Before fix: fetch_feed's `except Exception: continue` swallowed RateLimiter's fatal
    RuntimeError, silently returning incomplete data after hitting the limit.
    """
    ad = XHSAdapter.__new__(XHSAdapter)     # skip __init__ so we never touch real cookies

    feed_html = ('window.__INITIAL_STATE__ = '
                 '{"feed":{"feeds":[{"id":"abc","xsecToken":"t","noteCard":{"type":"normal"}}]}}'
                 '</script>')

    def fake_fetch(url, **kw):
        if url.endswith("explore"):         # feed list page returns normally
            return feed_html
        raise RuntimeError("daily scraping limit reached, stopping to avoid ban")   # simulate hitting limit on detail page

    ad._fetch_html = fake_fetch
    with pytest.raises(RuntimeError):
        ad.fetch_feed(limit=3)


def test_fetch_feed_skips_single_network_error():
    """A plain network error on one detail page (non-RuntimeError) → skip that item, continue the batch, return successful results."""
    ad = XHSAdapter.__new__(XHSAdapter)
    feed_html = ('window.__INITIAL_STATE__ = '
                 '{"feed":{"feeds":['
                 '{"id":"a","xsecToken":"t","noteCard":{"type":"normal"}},'
                 '{"id":"b","xsecToken":"t","noteCard":{"type":"normal"}}]}}'
                 '</script>')

    def fake_fetch(url, **kw):
        if url.endswith("explore"):
            return feed_html
        raise ConnectionError("network blip")   # plain exception — should be skipped

    ad._fetch_html = fake_fetch
    assert ad.fetch_feed(limit=3) == []     # both items fail but no exception; empty list returned
