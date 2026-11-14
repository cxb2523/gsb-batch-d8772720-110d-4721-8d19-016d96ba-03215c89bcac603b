"""Redacted forms of secrets, and redaction of free text (logs, error messages).

Format: ``<known prefix><3 chars>…<last 4>``, e.g. ``sk-ant-api03-R2D…igAA``.
Short secrets reveal less; nothing is revealed for secrets under 12 characters.
"""

from __future__ import annotations

import re
from functools import cache

from mecha.core.patterns import load_patterns

ELLIPSIS = "…"
_JWT = r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*"


def redact(secret: str, prefix: str | None = None) -> str:
    if prefix is None:
        prefix = next(
            (p.prefix for p in load_patterns() if p.prefix and secret.startswith(p.prefix)), ""
        )
        if not prefix and secret.startswith("eyJ"):
            prefix = "eyJ"
        elif not prefix and secret.startswith(("AIza", "AQ.")):
            prefix = secret[:4] if secret.startswith("AIza") else "AQ."
    body = secret[len(prefix) :]
    if len(body) >= 16:
        return f"{prefix}{body[:3]}{ELLIPSIS}{body[-4:]}"
    if len(body) >= 12:
        return f"{prefix}{ELLIPSIS}{body[-4:]}"
    return f"{prefix}{ELLIPSIS}"


@cache
def _finder() -> re.Pattern[str]:
    parts = [p.search_regex for p in load_patterns()]
    parts.append(_JWT)
    # Longest alternatives first so "sk-ant-api03-…" is not cut at "sk-".
    parts.sort(key=len, reverse=True)
    return re.compile(r"(?<![A-Za-z0-9_\-])(?:" + "|".join(parts) + r")")


def redact_text(text: str, extra: tuple[str, ...] = ()) -> str:
    """Replace anything that looks like a credential (plus ``extra`` literals)."""
    for literal in extra:
        if literal:
            text = text.replace(literal, redact(literal))
    return _finder().sub(lambda m: redact(m.group(0)), text)
