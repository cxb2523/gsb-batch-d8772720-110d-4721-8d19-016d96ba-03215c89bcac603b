#!/usr/bin/env python3
"""
compliance.py — Compliance layer: data anonymization + rate limiting

Design rationale (reviewed through multiple write/judge cycles):
  - Open-source scrapers must anonymize personal data (PIPL compliance); salted
    hashes prevent rainbow-table reversal.
  - RateLimiter resets across midnight and is thread-safe.
  - Distinction between "user object anonymization" and "note content retention":
    desc/title/tags are the core analysis signal and must NOT be scrubbed.

All scraped user objects must pass through scrub_user() before being stored.
Note content (title / desc / tags) is exempt from anonymization.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import random
import secrets
import threading
import time
import warnings
from datetime import date

from framework.exceptions import RateLimitError

# Salt: prefer the environment variable (consistent across runs → stable dedup).
# Without a stable salt, rainbow-table reversal is possible for weak IDs.
_salt_env = os.environ.get("XHS_ANON_SALT")
if _salt_env:
    _SALT = _salt_env.encode()
else:
    _SALT = secrets.token_bytes(32)
    warnings.warn(
        "XHS_ANON_SALT is not set. A random salt is being used for this run. "
        "Anonymization is still irreversible, but anon_id values will differ across runs, "
        "breaking deduplication. Set a fixed XHS_ANON_SALT in production.",
        stacklevel=2,
    )

# Sensitive fields for user objects only.
# ⚠️ Note content fields (title / desc / tags / content) are the analysis core — never include them here.
USER_SENSITIVE_FIELDS = {
    "phone", "email", "ip", "ip_location", "ipLocation", "location_detail",
    "red_id", "redId", "avatar", "nickname", "name", "user_name",
    "gender", "birthday", "bio", "real_name", "id_card", "device_id",
    "guest_id", "session",
}
_ID_KEYS = ("user_id", "userId", "id", "red_id", "redId")


def anonymize_user_id(raw_id: str) -> str:
    """Anonymize a user ID with a salted HMAC-SHA256 (rainbow-table resistant; full-length output for stable deduplication)."""
    if not raw_id:
        return ""
    return "xhs_" + hmac.new(_SALT, str(raw_id).encode("utf-8"), hashlib.sha256).hexdigest()


def scrub_user(user: dict) -> dict:
    """Anonymize a user object: drop sensitive fields and replace the raw ID with an anon_id hash. Not for note content."""
    out = {k: v for k, v in user.items() if k not in USER_SENSITIVE_FIELDS}
    for idk in _ID_KEYS:
        if user.get(idk):
            out["anon_id"] = anonymize_user_id(user[idk])
            break
    for idk in _ID_KEYS:        # drop raw IDs — keeping them alongside anon_id defeats the purpose
        out.pop(idk, None)
    return out


class RateLimiter:
    """Polite rate limiting: random delay + daily cap with midnight reset + thread safety."""

    def __init__(self, lo: float = 3.0, hi: float = 6.0, daily_limit: int = 100):
        self.lo, self.hi, self.daily_limit = lo, hi, daily_limit
        self.count, self.day = 0, date.today()
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            if date.today() != self.day:          # midnight reset
                self.count, self.day = 0, date.today()
            if self.count >= self.daily_limit:
                raise RateLimitError(f"Daily cap of {self.daily_limit} requests reached; stopping to avoid a ban")
            self.count += 1
        time.sleep(random.uniform(self.lo, self.hi))   # sleep outside the lock so other threads can update their count
