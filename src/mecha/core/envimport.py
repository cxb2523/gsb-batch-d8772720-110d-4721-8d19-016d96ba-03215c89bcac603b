"""Import credentials from a .env file: a preview (redacted) and a selective import.

Stateless: the preview never returns a secret and the server keeps nothing between the
preview and the import; the import receives the content again with the chosen entries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from mecha.core.detect import Detection, detect
from mecha.core.normalize import normalize_secret

KNOWN_NAMES = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "XAI_API_KEY",
        "OPENROUTER_API_KEY",
    }
)
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$")


@dataclass(frozen=True)
class EnvEntry:
    index: int  # stable position among candidate entries (used to select them)
    line: int
    name: str
    secret: str  # never leaves the server
    detection: Detection


def _value(raw: str) -> str:
    raw = raw.strip()
    if raw[:1] in ("'", '"') and raw[-1:] == raw[:1] and len(raw) >= 2:
        return raw[1:-1]
    # unquoted: an inline comment starts at " #"
    return re.split(r"\s+#", raw, maxsplit=1)[0].strip()


def parse_env(content: str) -> list[EnvEntry]:
    """Candidate entries: known variable names, or any value with a recognised format."""
    out: list[EnvEntry] = []
    for number, line in enumerate(content.splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _LINE.match(line)
        if not m:
            continue
        name, value = m.group(1), normalize_secret(_value(m.group(2)))
        if not value:
            continue
        det = detect(value)
        if name not in KNOWN_NAMES and det.format == "unknown":
            continue
        out.append(EnvEntry(len(out), number, name, value, det))
    return out
