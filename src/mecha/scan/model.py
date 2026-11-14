"""What a scan reports. Nothing here ever holds a secret or the content of a line."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path


class Confidence(StrEnum):
    high = "high"  # unambiguous prefix, or a variable name that confirms the provider
    low = "low"  # bare AIza (any Google Cloud key) or bare sk- (several providers)


class Risk(StrEnum):
    """Why a location is risky (amber). Anything else is listed as information."""

    shell_history = "shell_history"
    notebook = "notebook"
    git_tracked = "git_tracked"
    git_not_ignored = "git_not_ignored"
    synced_folder = "synced_folder"
    readable_by_others = "readable_by_others"


class PlaceKind(StrEnum):
    text = "text"
    notebook = "notebook"
    history_plain = "history_plain"  # bash, PowerShell, Terminal sessions
    history_zsh = "history_zsh"  # ": <time>:<elapsed>;<command>" (EXTENDED_HISTORY)
    history_fish = "history_fish"  # "- cmd: <command>"

    @property
    def is_history(self) -> bool:
        return self.value.startswith("history")


@dataclass(frozen=True)
class Location:
    path: Path
    line: int  # 1-based line; for notebooks, the 1-based cell
    column: int  # 1-based position of the key in that line (or cell source line)
    cell_line: int | None = None  # notebooks: line inside the cell
    kind: PlaceKind = PlaceKind.text  # how the file is read (not part of the id)

    @property
    def id(self) -> str:
        """Stable id from where the key is, never from the key itself."""
        raw = f"{self.path}\0{self.line}\0{self.cell_line or 0}\0{self.column}"
        return hashlib.sha256(raw.encode()).hexdigest()[:10]

    def label(self) -> str:
        if self.cell_line is not None:
            return f"{self.path} (cell {self.line}, line {self.cell_line})"
        return f"{self.path}:{self.line}"


@dataclass(frozen=True)
class Finding:
    location: Location
    provider: str | None
    kind: str | None
    pattern_id: str | None
    redacted: str
    confidence: Confidence
    name: str | None  # the variable name next to the key, if any
    storable: bool  # False for refresh tokens: never imported
    session_file: str | None = None  # a CLI's session file (use `mecha link`)
    risks: tuple[Risk, ...] = ()
    notes: tuple[str, ...] = ()  # e.g. "git not available"
    stored_id: str | None = None  # already in Mecha (matched by fingerprint)
    fingerprint: str | None = None  # HMAC under the store key; None if the store is locked
    check: str | None = None  # --check result: "valid", "invalid", "revoked"…

    @property
    def amber(self) -> bool:
        return bool(self.risks) and self.check not in {"invalid", "revoked", "expired"}


@dataclass
class Skipped:
    excluded_dir: int = 0
    protected_dir: int = 0
    too_large: int = 0
    binary: int = 0
    cloud_only: int = 0
    symlink_outside: int = 0
    unreadable: int = 0
    session_file: int = 0

    def total(self) -> int:
        return sum(vars(self).values())


@dataclass
class ScanReport:
    roots: list[Path]
    findings: list[Finding] = field(default_factory=list)
    files_scanned: int = 0
    skipped: Skipped = field(default_factory=Skipped)
    warnings: list[str] = field(default_factory=list)
    store_checked: bool = False  # False when the store was locked: no cross-reference
    scanned_at: datetime | None = None  # set by the cross-reference (seen_at of locations)
    # What this scan read and what it skipped (resolved paths), so it only replaces the
    # stored locations of files it actually read. Emptied after the cross-reference: a
    # listing of the home folder has no reason to stay in memory.
    read: set[Path] = field(default_factory=set)
    not_read: set[Path] = field(default_factory=set)  # files and folders skipped
    protected_skipped: set[Path] = field(default_factory=set)  # macOS: not even stat()ed
    max_size: int = 1024 * 1024  # the limits it read with (an import checks them again)
    max_notebook: int = 20 * 1024 * 1024

    def keeps(self, path: Path) -> bool:
        """Whether a stored location at ``path`` survives this scan: replaced if the file
        was read, kept if it was skipped or never looked at, dropped if it is gone."""
        if path in self.read:
            return False
        roots = [r.resolve() for r in self.roots]
        if not any(path == r or r in path.parents for r in roots):
            return True  # outside this scan
        if any(q in self.protected_skipped for q in path.parents):
            return True  # a protected folder this scan was not allowed into: not even stat()
        try:
            path.stat()
        except (FileNotFoundError, NotADirectoryError):
            return False  # deleted since: gone wherever it was
        except OSError:
            return True  # cannot tell: keep it
        # Still there but not read: skipped (excluded folder, cloud-only, too large,
        # unreadable, see `not_read`) or not reached. Either way this scan cannot say.
        return True

    def forget_paths(self) -> None:
        self.read = set()
        self.not_read = set()
        self.protected_skipped = set()

    @property
    def amber(self) -> bool:
        """Exit code 1: something risky with high confidence (low confidence never counts)."""
        return any(f.amber and f.confidence is Confidence.high for f in self.findings)
