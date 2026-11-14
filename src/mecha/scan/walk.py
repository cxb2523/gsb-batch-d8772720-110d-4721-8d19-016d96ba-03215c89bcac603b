"""The scan itself: walk the roots and the known places, read candidate files, report.

Secrets only exist while a line is processed: each hit goes to ``fingerprint`` (the
store's HMAC, or nothing when the store is locked) and is then dropped. Findings carry
where the key is and its redacted form, never the key or the line.

Every skipped file or folder leaves a `SkipRecord` (resolved path and reason) in the
report, once per path. A scan stops between two files when ``stop()`` says so, raising
`ScanCancelled` with a `Checkpoint`; passing it back as ``resume`` continues where it
stopped, and the final report matches one uninterrupted run.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

from mecha.scan import fsio
from mecha.scan.find import hits
from mecha.scan.model import Finding, Location, PlaceKind, Risk, ScanReport, SkipRecord
from mecha.scan.places import (
    EXCLUDED_NAMES,
    Env,
    Place,
    excluded_dirs,
    known_places,
    protected_dirs,
    session_files,
    synced_dirs,
)
from mecha.scan.risk import GitIndex, GitState, Readability, inside, other_people

MAX_FILE = 1024 * 1024  # 1 MiB
MAX_NOTEBOOK = 20 * 1024 * 1024  # notebooks carry outputs

Fingerprint = Callable[[str], str | None]
Progress = Callable[[int, Path], None]
Stop = Callable[[], bool]


@dataclass
class Checkpoint:
    """Where a scan stopped, by processed-file count. Holds the partial report and the
    files already seen, so a resumed scan never reads them twice and the final report
    matches one uninterrupted run. Paths and redacted findings only: never a secret."""

    files_done: int
    report: ScanReport
    seen: frozenset[Path]


class ScanCancelled(Exception):
    """Raised between two files when ``stop()`` says so. Carries the checkpoint at that
    moment: pass it back as ``resume`` to continue where the scan stopped."""

    def __init__(self, checkpoint: Checkpoint | None = None) -> None:
        super().__init__(checkpoint.files_done if checkpoint else 0)
        self.checkpoint = checkpoint


@dataclass
class Options:
    roots: list[Path] = field(default_factory=list)  # empty: the home folder
    include_protected: bool = False
    max_size: int = MAX_FILE
    max_notebook: int = MAX_NOTEBOOK


class Scanner:
    def __init__(
        self,
        env: Env,
        options: Options,
        fingerprint: Fingerprint,
        progress: Progress | None = None,
        stop: Stop | None = None,
        resume: Checkpoint | None = None,
    ) -> None:
        self.env = env
        self.options = options
        self.fingerprint = fingerprint
        self.progress = progress
        self.stop = stop
        explicit = [Path(r).expanduser().absolute() for r in options.roots]
        self.roots = explicit or [env.home]
        self.excluded = excluded_dirs(env)
        self.protected = [] if options.include_protected else protected_dirs(env)
        self.synced = synced_dirs(env)
        self.sessions = session_files(env)
        self.git = GitIndex()
        self.readability = Readability()
        self.others = other_people(env)
        if resume is not None:
            # Continue the cancelled scan's own report: what was done stays done.
            self.report = resume.report
            self._seen = set(resume.seen)
            self._files_done = resume.files_done
        else:
            self.report = ScanReport(
                roots=self.roots, max_size=options.max_size, max_notebook=options.max_notebook
            )
            self._seen = set()
            self._files_done = 0
        self._skip_recorded = {r.path for r in self.report.skip_records}
        self.checkpoint = Checkpoint(self._files_done, self.report, frozenset(self._seen))
        # Protected folders the walk never reaches because they sit inside an excluded one
        # (iCloud Drive and ~/Library/CloudStorage, inside ~/Library): with the flag they are
        # walked as extra starting points. report.roots stays what was asked.
        self.extra_roots = (
            [p for p in protected_dirs(env) if self._behind_excluded(p)]
            if options.include_protected
            else []
        )

    # --- what to read ---------------------------------------------------------------------
    def _places(self) -> Iterator[tuple[Path, PlaceKind]]:
        """Known places under the roots. A root may also be a single file inside a known
        folder (rescanning one location): it is still read as what it is (a history…)."""
        for place in known_places(self.env):
            if not any(inside(place.path, [r]) or inside(r, [place.path]) for r in self.roots):
                continue
            for path, kind in self._expand(place):
                if any(inside(path, [r]) for r in self.roots):
                    yield path, kind

    def _expand(self, place: Place) -> Iterator[tuple[Path, PlaceKind]]:
        if place.pattern is None:
            if place.path.is_file():
                yield place.path, place.kind
            return
        try:
            for match in sorted(place.path.glob(place.pattern)):
                if match.is_file():
                    yield match, place.kind
        except OSError:
            self._record_skip(self._resolve(place.path), "unreadable")

    def _under_roots(self, folder: Path) -> bool:
        """Strictly below a root, and no root inside it (a root inside it is asked for)."""
        return any(r in folder.parents for r in self.roots) and not any(
            inside(r, [folder]) for r in self.roots
        )

    def _behind_excluded(self, folder: Path) -> bool:
        if not self._under_roots(folder):
            return False
        return any(
            inside(folder, [e]) and any(r in e.parents for r in self.roots) for e in self.excluded
        )

    def _skip_protected(self, folder: Path) -> None:
        """Count a protected folder as skipped, once. Never looks inside it."""
        real = self._resolve(folder)
        self.report.protected_skipped.add(real)
        self._record_skip(real, "protected_dir")

    def _resolve(self, path: Path) -> Path:
        try:
            return path.resolve()
        except OSError:
            return path.absolute()

    def _record_skip(self, real: Path, reason: str, *, was_read: bool = False) -> None:
        """The per-item account of a skip: the counter, a record (once per path, also
        across a resume) and — unless the file was opened — the not-read set."""
        if real in self._skip_recorded:
            return
        self._skip_recorded.add(real)
        setattr(self.report.skipped, reason, getattr(self.report.skipped, reason) + 1)
        self.report.skip_records.append(SkipRecord(real, reason))
        if not was_read:
            self.report.not_read.add(real)

    def _walk(self, root: Path) -> Iterator[Path]:
        try:
            st = os.stat(root)
        except (FileNotFoundError, NotADirectoryError):
            return  # gone: its stored locations go too
        except OSError:
            self._record_skip(self._resolve(root), "unreadable")
            return
        if not stat.S_ISDIR(st.st_mode):
            yield root
            return
        stack = [root]
        while stack:
            folder = stack.pop()
            self._check_stop()
            try:
                entries = sorted(os.scandir(folder), key=lambda e: e.name)
            except OSError:
                self._record_skip(self._resolve(folder), "unreadable")
                continue
            for entry in entries:
                path = Path(entry.path)
                try:
                    if entry.is_symlink():
                        target = path.resolve()
                        if not any(inside(target, [r]) for r in self.roots):
                            # The link's own path: resolving it would leave the roots.
                            self._record_skip(Path(os.path.abspath(path)), "symlink_outside")
                        continue  # inside a root it is scanned at its real place
                    if entry.is_dir(follow_symlinks=False):
                        if self._skip_dir(path, root):
                            continue
                        stack.append(path)
                    elif entry.is_file(follow_symlinks=False):
                        yield path
                except OSError:
                    self._record_skip(self._resolve(path), "unreadable")

    def _skip_dir(self, path: Path, root: Path) -> bool:
        if path.name in EXCLUDED_NAMES or path in self.excluded:
            # Known places inside are read anyway (and count as read).
            self._record_skip(self._resolve(path), "excluded_dir")
            return True
        # Asked for explicitly (the root is inside it): scanned. Otherwise only with the flag.
        if path in self.protected and not inside(root, [path]):
            self._skip_protected(path)
            return True
        return False

    # --- reading ----------------------------------------------------------------------
    def run(self) -> ScanReport:
        # Warnings once, also when resuming the cancelled scan's own report.
        if self.others is None and "readable_by_others_not_checked" not in self.report.warnings:
            self.report.warnings.append("readable_by_others_not_checked")
        if self.git.git is None and "git_not_available" not in self.report.warnings:
            self.report.warnings.append("git_not_available")
        # Without the flag every protected folder under the roots counts as skipped, also
        # those the walk would never reach (inside ~/Library): a stored location there must
        # be kept without a stat() inside. lexists() only looks at the folder's own entry.
        for folder in self.protected:
            if self._under_roots(folder) and os.path.lexists(folder):
                self._skip_protected(folder)
        for path, kind in self._places():
            self._file(path, kind)
        for root in [*self.roots, *self.extra_roots]:
            for path in self._walk(root):
                kind = PlaceKind.notebook if path.suffix == ".ipynb" else PlaceKind.text
                self._file(path, kind)
        return self.report

    def _check_stop(self) -> None:
        if self.stop is not None and self.stop():
            raise ScanCancelled(self.checkpoint)

    def _file(self, path: Path, kind: PlaceKind) -> None:
        """One file, once: after it the checkpoint moves past it. Files seen in the
        cancelled run (the checkpoint's `seen`) are not even stat()ed again."""
        self._check_stop()
        real = path.resolve()
        if real in self._seen:
            return
        self._seen.add(real)
        self._process(real, path, kind)
        self._files_done += 1
        self.checkpoint = Checkpoint(self._files_done, self.report, frozenset(self._seen))

    def _process(self, real: Path, path: Path, kind: PlaceKind) -> None:
        st, reason = check_file(real, kind, self.options.max_size, self.options.max_notebook)
        if reason == "gone" or reason == "not_regular":
            return
        if reason is not None:
            self._record_skip(real, reason)
            return
        if st is None:
            return
        try:
            candidate, binary = fsio.prefilter(real)
        except OSError:
            self._record_skip(real, "unreadable")
            return
        self.report.read.add(real)
        self.report.files_scanned += 1
        if self.progress is not None:
            self.progress(self.report.files_scanned, real)
        if binary:
            self._record_skip(real, "binary", was_read=True)
            return
        if not candidate:
            return
        session = self.sessions.get(real) or self.sessions.get(path)
        risks, notes = self._risks(real, st, kind)
        try:
            for line, cell_line, offset, text in fsio.lines(real, kind):
                for hit in hits(text, offset):
                    det = hit.detection
                    self.report.findings.append(
                        Finding(
                            location=Location(real, line, hit.column, cell_line, kind),
                            provider=det.provider.value if det.provider else None,
                            kind=det.kind.value if det.kind else None,
                            pattern_id=det.pattern_id,
                            redacted=det.redacted,
                            confidence=hit.confidence,
                            name=hit.name,
                            storable=det.storable and session is None,
                            session_file=session,
                            risks=risks,
                            notes=notes,
                            fingerprint=self.fingerprint(hit.secret),
                        )
                    )
        except OSError:
            self.report.read.discard(real)  # half read: what was there is not known
            self._record_skip(real, "unreadable")
            self.report.findings = [f for f in self.report.findings if f.location.path != real]

    def _risks(
        self, path: Path, st: os.stat_result, kind: PlaceKind
    ) -> tuple[tuple[Risk, ...], tuple[str, ...]]:
        risks: list[Risk] = []
        notes: list[str] = []
        if kind.is_history:
            risks.append(Risk.shell_history)
        if kind is PlaceKind.notebook:
            risks.append(Risk.notebook)
        state = self.git.state(path)
        if state is GitState.tracked:
            risks.append(Risk.git_tracked)
        elif state is GitState.not_ignored:
            risks.append(Risk.git_not_ignored)
        elif state is GitState.unknown:
            notes.append("git_unknown")
        if inside(path, self.synced):
            risks.append(Risk.synced_folder)
        if self.others and self.readability.readable_by_others(path, st):
            risks.append(Risk.readable_by_others)
        return tuple(risks), tuple(notes)


def check_file(
    path: Path, kind: PlaceKind, max_size: int = MAX_FILE, max_notebook: int = MAX_NOTEBOOK
) -> tuple[os.stat_result | None, str | None]:
    """Whether a file may be opened, from its attributes only (never opening it): the
    reason is a `Skipped` counter, or "gone" / "not_regular"."""
    try:
        st = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None, "gone"
    except OSError:
        return None, "unreadable"
    if not fsio.is_regular(st):
        return st, "not_regular"
    if fsio.cloud_only(st):  # opening it would download it
        return st, "cloud_only"
    if st.st_size > (max_notebook if kind is PlaceKind.notebook else max_size):
        return st, "too_large"
    return st, None


def read_token(
    location: Location, max_size: int = MAX_FILE, max_notebook: int = MAX_NOTEBOOK
) -> str | None:
    """Re-read the key at a location (import): None if it is no longer there. Raises
    `NotReadable` if the file may not be opened now (e.g. it became cloud-only)."""
    _, reason = check_file(location.path, location.kind, max_size, max_notebook)
    if reason == "gone":
        return None
    if reason is not None:
        raise NotReadable(reason)
    for line, cell_line, offset, text in fsio.lines(location.path, location.kind):
        if line > location.line:
            break  # past it: the key is no longer on that line
        if line != location.line or cell_line != location.cell_line:
            continue
        for hit in hits(text, offset):
            if hit.column == location.column:
                return hit.secret
    return None


class NotReadable(Exception):
    """The file is there but must not be opened now (cloud-only, too large, unreadable)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason
