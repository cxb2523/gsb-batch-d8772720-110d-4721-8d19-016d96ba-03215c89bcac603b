#!/usr/bin/env python3
"""
exceptions.py — Prism exception hierarchy.

Every error raised by Prism inherits from PrismError so callers can catch the
whole family with `except PrismError`, or handle specific subclasses individually.

⭐ PrismError inherits RuntimeError for backward compatibility: existing code and
   tests that catch RuntimeError continue to work; new code can use the semantic subclasses.
"""
from __future__ import annotations


class PrismError(RuntimeError):
    """Base class for all Prism errors."""


class AdapterFetchError(PrismError):
    """Fetch failed: network error, expired cookie, or platform anti-scraping block."""


class ConfigError(PrismError):
    """Configuration error: missing or malformed field-mapping file."""


class RateLimitError(PrismError):
    """Rate limit or daily cap reached; stopped proactively to avoid a ban."""
