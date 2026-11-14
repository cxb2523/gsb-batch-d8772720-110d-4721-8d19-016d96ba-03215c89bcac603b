"""Find keys in a line of text, with a confidence from the variable name next to them.

Detection is `mecha detect`'s (data/detect_patterns.toml). Two formats are weak on their
own: ``AIza`` starts every Google Cloud API key (Firebase, Maps…) and a bare ``sk-`` is used
by other providers too. Those are high confidence only when the variable name confirms the
provider; otherwise, or when the name points at another service, they are low confidence.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

from mecha.core.detect import Detection, detect
from mecha.scan.model import Confidence

# A token that starts with a key prefix; detect() decides whether it really is a key.
_TOKEN = re.compile(r"(?<![A-Za-z0-9_\-.])(?:sk-|AIza|xai-|AQ\.)[A-Za-z0-9_\-.]{12,}")
# The name right before the token: NAME=, NAME:, "NAME": ", --name , export NAME=",
# env['NAME'] = ', os.environ["NAME"]='
_NAME = re.compile(
    r"""(?:^|[^A-Za-z0-9_.\-])(?:--)?(?P<name>[A-Za-z_][A-Za-z0-9_.\-]*)["'\]]*\s*(?:[:=]|\s)\s*["']?$"""
)

WEAK_PATTERNS = {"gemini_standard_key": "gemini", "openai_legacy_key": "openai"}
# Names that confirm a weak key's provider.
CONFIRMS = {
    "gemini": ("GEMINI", "GOOGLE_GENAI", "GOOGLE_GENERATIVE_AI", "GENAI_API_KEY"),
    "openai": ("OPENAI",),
}


@dataclass(frozen=True)
class Hit:
    column: int  # 1-based, in the original line
    detection: Detection
    name: str | None
    confidence: Confidence
    secret: str  # kept only while the line is being processed; never stored or printed


def _name_before(text: str, start: int) -> str | None:
    m = _NAME.search(text[:start])
    return m.group("name") if m else None


def confidence(det: Detection, name: str | None) -> Confidence:
    provider = WEAK_PATTERNS.get(det.pattern_id or "")
    if provider is None:
        return Confidence.high  # unambiguous prefix
    upper = (name or "").upper().replace("-", "_")
    if any(word in upper for word in CONFIRMS[provider]):
        return Confidence.high
    return Confidence.low


def hits(text: str, offset: int = 0) -> Iterator[Hit]:
    for m in _TOKEN.finditer(text):
        token = m.group(0).rstrip(".")
        det = detect(token)
        if det.format == "unknown" or det.format == "session_file":
            continue
        name = _name_before(text, m.start())
        yield Hit(offset + m.start() + 1, det, name, confidence(det, name), token)
