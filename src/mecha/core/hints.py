"""Match an admin API's partial key hint against stored secrets (decrypted in memory).

Hints come in provider formats (Anthropic ``sk-ant-api03-R2D...igAA``, OpenAI
``sk-proj-abc...wxyz``, xAI ``xai-a**b``). Instead of comparing with Mecha's own redacted form,
the hint is split at its mask and the secret must start with the visible head and end with
the visible tail. A hint that matches more than one stored key enriches none of them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

MASK = re.compile(r"\.{3}|…|\*{2,}")
MIN_VISIBLE = 4  # head + tail characters required to trust a match


def split_hint(hint: str) -> tuple[str, str] | None:
    parts = MASK.split(hint.strip())
    if len(parts) != 2:
        return None
    head, tail = parts
    if not tail or len(head) + len(tail) < MIN_VISIBLE:
        return None
    return head, tail


def matches_hint(secret: str, hint: str) -> bool:
    split = split_hint(hint)
    if split is None:
        return False
    head, tail = split
    return (
        len(secret) >= len(head) + len(tail) and secret.startswith(head) and secret.endswith(tail)
    )


def match_unique(hint: str, secrets: Mapping[str, str]) -> str | None:
    """The single credential id whose secret matches ``hint``; None if zero or several."""
    found = [cid for cid, secret in secrets.items() if matches_hint(secret, hint)]
    return found[0] if len(found) == 1 else None


def ambiguous_hints(hints: Iterable[str], secrets: Mapping[str, str]) -> int:
    return sum(1 for h in hints if sum(1 for s in secrets.values() if matches_hint(s, h)) > 1)
