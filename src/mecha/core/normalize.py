"""Clean pasted secrets before detection.

Handles what people actually paste: surrounding whitespace and line breaks, quotes,
``NAME=value`` / ``export NAME=value`` lines, ``Bearer …`` and ``Authorization: Bearer …``.
JSON documents (session files) are returned stripped but otherwise untouched.
"""

from __future__ import annotations

import re

_ASSIGNMENT = re.compile(r"^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*")
_AUTH_HEADER = re.compile(r"^(?:authorization\s*:\s*)?(?:bearer|token)\s+", re.IGNORECASE)
_X_HEADER = re.compile(r"^(?:x-api-key|x-goog-api-key)\s*:\s*", re.IGNORECASE)
_QUOTES = "\"'`"


def _unquote(value: str) -> str:
    while len(value) >= 2 and value[0] == value[-1] and value[0] in _QUOTES:
        value = value[1:-1].strip()
    return value.strip(_QUOTES).strip()


def normalize_secret(raw: str) -> str:
    text = raw.strip().lstrip("﻿")
    if text.startswith("{"):
        return text  # JSON session file: keep structure

    text = _AUTH_HEADER.sub("", text)
    text = _X_HEADER.sub("", text)
    if not text.startswith(("sk-", "xai-", "AIza", "AQ.", "eyJ")):
        text = _ASSIGNMENT.sub("", text, count=1)
    text = _unquote(text)
    text = _AUTH_HEADER.sub("", text)  # NAME="Bearer …"
    # Keys never contain whitespace: drop wrapped line breaks and stray spaces.
    text = re.sub(r"\s+", "", text)
    return _unquote(text)
