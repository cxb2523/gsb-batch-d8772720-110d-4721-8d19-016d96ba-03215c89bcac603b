"""Why a location is risky: git, sync clients, other people on this machine.

Git is run safely: ``-c core.fsmonitor=false`` (a cloned repository's .git/config could
point core.fsmonitor at any program), no optional locks (nothing refreshes or writes the
index), no prompts, and one ``ls-files`` call per repository, which lists both tracked
files and untracked files that are not ignored (what ``check-ignore`` would tell).
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from mecha.scan.places import Env


class GitState(StrEnum):
    tracked = "tracked"
    not_ignored = "not_ignored"
    ignored = "ignored"
    no_repo = "no_repo"
    unknown = "unknown"  # git missing or refused (e.g. a repository owned by someone else)


GIT_TIMEOUT = 30


@dataclass
class GitIndex:
    """Per repository, the files git tracks and the untracked ones it does not ignore."""

    git: str | None = field(default_factory=lambda: shutil.which("git"))
    _repos: dict[Path, tuple[set[str], set[str]] | None] = field(default_factory=dict)

    def state(self, path: Path) -> GitState:
        root = _repo_root(path)
        if root is None:
            return GitState.no_repo
        if root not in self._repos:
            self._repos[root] = self._list(root)
        listing = self._repos[root]
        if listing is None:
            return GitState.unknown
        tracked, others = listing
        rel = path.relative_to(root).as_posix()
        if rel in tracked:
            return GitState.tracked
        return GitState.not_ignored if rel in others else GitState.ignored

    def _list(self, root: Path) -> tuple[set[str], set[str]] | None:
        if self.git is None:
            return None
        env = {
            **os.environ,
            "GIT_OPTIONAL_LOCKS": "0",  # never refresh or write the index
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
        try:
            out = subprocess.run(  # noqa: S603 - fixed arguments, no shell
                [
                    self.git, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
                    "-C", str(root), "ls-files", "-z", "-t",
                    "--cached", "--others", "--exclude-standard",
                ],
                env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=GIT_TIMEOUT,
                check=True,
            ).stdout  # fmt: skip
        except (OSError, subprocess.SubprocessError):
            return None
        tracked: set[str] = set()
        others: set[str] = set()
        for entry in out.decode("utf-8", errors="replace").split("\0"):
            if len(entry) < 3:
                continue
            tag, rel = entry[0], entry[2:]
            (others if tag == "?" else tracked).add(rel)
        return tracked, others


def _repo_root(path: Path) -> Path | None:
    for parent in path.parents:
        if (parent / ".git").exists():
            return parent
    return None


# --- other people on this machine -------------------------------------------------------

NO_LOGIN = ("nologin", "false", "/sync", "/shutdown", "/halt")


def other_people(env: Env) -> bool | None:
    """Are there other human accounts here? None when it cannot be told (Windows)."""
    if env.platform == "win32" or sys.platform == "win32":  # no pwd/getuid there (ACLs)
        return None
    import pwd

    minimum = 501 if env.platform == "darwin" else 1000
    me = os.getuid()
    for user in pwd.getpwall():
        if user.pw_uid < minimum or user.pw_uid == me or user.pw_name == "nobody":
            continue
        shell = user.pw_shell or ""
        if shell and not shell.endswith(NO_LOGIN):
            return True
    return False


@dataclass
class Readability:
    """A file other accounts can read: o+r on the file and o+x on every folder above it.
    Group permissions do not count (on Linux the group is usually the user's own)."""

    _traversable: dict[Path, bool] = field(default_factory=dict)

    def readable_by_others(self, path: Path, st: os.stat_result) -> bool:
        if not st.st_mode & stat.S_IROTH:
            return False
        return all(self._others_can_enter(parent) for parent in path.parents)

    def _others_can_enter(self, folder: Path) -> bool:
        if folder not in self._traversable:
            try:
                self._traversable[folder] = bool(os.stat(folder).st_mode & stat.S_IXOTH)
            except OSError:
                self._traversable[folder] = False
        return self._traversable[folder]


def inside(path: Path, folders: list[Path]) -> bool:
    return any(path == f or f in path.parents for f in folders)
