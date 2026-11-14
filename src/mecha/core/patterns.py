"""Load ``data/detect_patterns.toml``."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from functools import cache
from importlib.resources import files

from mecha.core.models import CredentialKind, ProviderId

BODY_CHARS = r"[A-Za-z0-9_\-]"
DEFAULT_MIN_BODY = 16


@dataclass(frozen=True)
class Pattern:
    id: str
    provider: ProviderId
    kind: CredentialKind
    label: str
    prefix: str | None = None
    regex: re.Pattern[str] | None = None
    min_body: int = DEFAULT_MIN_BODY
    storable: bool = True
    retiring: bool = False
    ambiguous: bool = False
    verified: bool = False
    reference: str = ""
    exclude: tuple[str, ...] = field(default_factory=tuple)

    def matches(self, secret: str) -> bool:
        if any(secret.startswith(e) for e in self.exclude):
            return False
        if self.regex is not None:
            return self.regex.fullmatch(secret) is not None
        assert self.prefix is not None  # noqa: S101 - enforced by the loader
        if not secret.startswith(self.prefix):
            return False
        body = secret[len(self.prefix) :]
        return len(body) >= self.min_body and re.fullmatch(f"{BODY_CHARS}+", body) is not None

    @property
    def search_regex(self) -> str:
        """Regex to find this credential inside free text (log redaction)."""
        if self.regex is not None:
            return self.regex.pattern.removeprefix("^").removesuffix("$")
        assert self.prefix is not None  # noqa: S101
        return re.escape(self.prefix) + BODY_CHARS + "{" + str(min(self.min_body, 8)) + ",}"


def parse_patterns(text: str) -> tuple[Pattern, ...]:
    data = tomllib.loads(text)
    out: list[Pattern] = []
    seen: set[str] = set()
    for raw in data.get("pattern", []):
        pid = raw["id"]
        if pid in seen:
            raise ValueError(f"duplicate pattern id {pid!r}")
        seen.add(pid)
        prefix = raw.get("prefix")
        regex = raw.get("regex")
        if (prefix is None) == (regex is None):
            raise ValueError(f"pattern {pid!r} needs exactly one of prefix/regex")
        out.append(
            Pattern(
                id=pid,
                provider=ProviderId(raw["provider"]),
                kind=CredentialKind(raw["kind"]),
                label=raw["label"],
                prefix=prefix,
                regex=re.compile(regex) if regex is not None else None,
                min_body=int(raw.get("min_body", DEFAULT_MIN_BODY)),
                storable=bool(raw.get("storable", True)),
                retiring=bool(raw.get("retiring", False)),
                ambiguous=bool(raw.get("ambiguous", False)),
                verified=bool(raw.get("verified", False)),
                reference=str(raw.get("reference", "")),
                exclude=tuple(raw.get("exclude", ())),
            )
        )
    # Regex patterns first, then prefixes from longest to shortest.
    out.sort(key=lambda p: (p.regex is None, -len(p.prefix or "")))
    return tuple(out)


@cache
def load_patterns() -> tuple[Pattern, ...]:
    text = files("mecha.data").joinpath("detect_patterns.toml").read_text(encoding="utf-8")
    return parse_patterns(text)


def get_pattern(pattern_id: str) -> Pattern | None:
    return next((p for p in load_patterns() if p.id == pattern_id), None)
