"""Sticky sessions that survive a restart, one per worker, on disk.

``Proxy.sessions(n)`` hands back a batch of identities and remembers nothing:
a process that dies mid-run takes the batch with it, and the next run draws
again with no record of which worker held which exit. This module is the
missing ledger. A :class:`SessionAllocator` is given a :class:`Proxy` to use
as a template, a list of worker names and a state file; the first run draws
one session id per worker and writes the file, and every later run reuses the
recorded ids and draws only for workers it has never seen.

Two rules from ``proxy.py`` are inherited rather than reimplemented, and both
are the point of reusing the existing code paths:

* session ids are **generated** by :meth:`Proxy.sessions`, whose alphabet can
  never contain the gateway's separators and whose draws come from
  :mod:`secrets`, not from a clock-seeded ``random``;
* session ids read back from the state file are **validated** by
  :meth:`Proxy.session`, so a hand-edited id carrying a separator is refused
  by the same check that refuses one passed directly.

Nothing here opens a socket, and the state file never holds the password -
only worker names, session ids and the template's gateway parameters.
"""

from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional

from .errors import ParamError
from .proxy import Proxy

__all__ = [
    "Assignment",
    "SessionAllocator",
    "CREATED",
    "REUSED",
    "FAILED",
    "CONFLICT",
]

#: The worker had no recorded session, so one was drawn for it this run.
CREATED = "created"
#: The worker's recorded session was taken from the state file unchanged.
REUSED = "reused"
#: No session could be assigned; ``Assignment.reason`` says why.
FAILED = "failed"
#: The state on disk disagrees with what this run would have recorded - the
#: template's parameters changed under a recorded worker, or another writer
#: registered the worker first - and the file was kept as it was.
CONFLICT = "conflict"

_STATE_VERSION = 1


@dataclass(frozen=True)
class Assignment:
    """The outcome for one worker.

    ``proxy`` is the template pinned to the worker's session id, ready to
    hand to a client, and is ``None`` when ``status`` is :data:`FAILED`.
    ``reason`` is set for :data:`FAILED` and :data:`CONFLICT` and is ``None``
    otherwise.
    """

    worker: str
    status: str
    session_id: Optional[str] = None
    proxy: Optional[Proxy] = None
    reason: Optional[str] = None

    @property
    def ok(self) -> bool:
        """Whether this worker holds a session it can use right now."""
        return self.status in (CREATED, REUSED)


class SessionAllocator:
    """Hands each worker one sticky session and writes the mapping to disk.

    ::

        allocator = SessionAllocator(template, "sessions.json")
        for assignment in allocator.assign(["worker-1", "worker-2"]):
            if assignment.ok:
                proxies = assignment.proxy.requests()

    ``template`` is a :class:`Proxy` carrying the parameters every worker
    shares - the country to rotate through, a ``ttl``, a ``filter``. The
    allocator adds only the session id, and it adds it through the template's
    own methods, so the gateway's dialect is enforced by the same code that
    enforces it everywhere else.

    The state file records, per worker, the session id and the template
    parameters the id was drawn under. It never records the password or the
    login: a state file is read by eye and pasted into bug reports, and a
    credential in it would travel with both. A recorded worker whose
    parameters no longer match the template's is reported as
    :data:`CONFLICT`, not silently reused - on a gateway whose session key is
    the whole parameter set, the same id under different parameters is a
    different session, and calling it a reuse would be a lie about which
    exit the worker holds.
    """

    def __init__(self, template: Proxy, state_path) -> None:
        if not isinstance(template, Proxy):
            raise ParamError(
                f"the template has to be a Proxy, got {type(template).__name__}. "
                f"The allocator builds sessions through the template's own "
                f"methods, and nothing else has them."
            )
        self._template = template
        self._path = Path(state_path)

    @property
    def state_path(self) -> Path:
        """Where the worker-to-session mapping is kept."""
        return self._path

    def assign(self, workers: Iterable[str]) -> List[Assignment]:
        """One :class:`Assignment` per worker, in the order given.

        Workers already in the state file keep their recorded session; only
        workers the file does not know have a new id drawn. A worker whose
        session cannot be produced - because the template's provider declares
        no session parameter, or because a recorded id no longer passes the
        gateway's own validation - is reported as :data:`FAILED` with the
        reason, and the other workers are unaffected.
        """
        names = _worker_names(workers)
        state = _read_state(self._path)
        recorded = state["workers"]
        template_params = self._template.params

        assignments: Dict[str, Assignment] = {}
        # The entries this run wants the file to hold, for the workers it
        # was asked about. The commit step merges this with whatever the
        # file says by then.
        plan: Dict[str, Dict[str, object]] = {}
        new_workers: List[str] = []

        for name in names:
            entry = recorded.get(name)
            if entry is None:
                new_workers.append(name)
                continue
            sid = entry["sid"]
            if entry["params"] != template_params:
                assignments[name] = Assignment(
                    name,
                    CONFLICT,
                    session_id=sid,
                    reason=(
                        f"the state file recorded {sid!r} under parameters "
                        f"{entry['params']}, and this template's are "
                        f"{template_params}. The sticky session key is the "
                        f"whole parameter set, so reusing the id now would "
                        f"not be the session that was recorded. The file was "
                        f"left unchanged; delete the entry or the file to "
                        f"draw a fresh session under the new parameters."
                    ),
                )
                continue
            try:
                proxy = self._template.session(sid)
            except ParamError as exc:
                # A hand-edited id, or one written before a rule existed.
                # Refused by the template's own validation, not by a check
                # invented here.
                assignments[name] = Assignment(
                    name, FAILED, session_id=sid, reason=str(exc)
                )
                continue
            assignments[name] = Assignment(name, REUSED, session_id=sid, proxy=proxy)
            plan[name] = {"sid": sid, "params": template_params}

        if new_workers:
            try:
                drawn = self._template.sessions(len(new_workers))
            except ParamError as exc:
                # One cause covers them all - a provider with no session
                # parameter, or a count the id space cannot hold - and it is
                # reported per worker, because the result is per worker.
                for name in new_workers:
                    assignments[name] = Assignment(name, FAILED, reason=str(exc))
            else:
                session_param = self._template.provider.session_param
                for name, proxy in zip(new_workers, drawn):
                    sid = proxy.params[session_param]
                    assignments[name] = Assignment(
                        name, CREATED, session_id=sid, proxy=proxy
                    )
                    plan[name] = {"sid": sid, "params": template_params}

        self._commit(plan, assignments)
        return [assignments[name] for name in names]

    def _commit(
        self,
        plan: Dict[str, Dict[str, object]],
        assignments: Dict[str, Assignment],
    ) -> None:
        """Merge the plan into the state file under a lock.

        The file is re-read after the lock is taken, not before: between the
        first read and this moment another process may have registered
        workers of its own, and a writer that saved the state it read at the
        start would erase them. Entries already in the file win - a worker
        this run planned for, that the file now holds under a different
        session id, is reported as :data:`CONFLICT` and the recorded id is
        kept, because two workers holding one id is the failure this whole
        module exists to prevent.
        """
        with _locked(self._path):
            current = _read_state(self._path)
            merged: Dict[str, Dict[str, object]] = dict(current["workers"])
            for name, entry in plan.items():
                existing = merged.get(name)
                if existing is not None and existing != entry:
                    sid = existing["sid"]
                    proxy: Optional[Proxy] = None
                    if existing["params"] == self._template.params:
                        try:
                            proxy = self._template.session(sid)
                        except ParamError:
                            proxy = None
                    assignments[name] = Assignment(
                        name,
                        CONFLICT,
                        session_id=sid,
                        proxy=proxy,
                        reason=(
                            f"another writer registered worker {name!r} as "
                            f"session {sid!r} while this run was assigning. "
                            f"The file keeps that registration; this run's "
                            f"planned id was discarded, because two workers "
                            f"must never be handed one session."
                        ),
                    )
                    continue
                merged[name] = entry
            state = {
                "version": _STATE_VERSION,
                "template": {
                    "provider": self._template.provider.id,
                    "params": self._template.params,
                },
                "workers": merged,
            }
            _write_state(self._path, state)


def _worker_names(workers: Iterable[str]) -> List[str]:
    """The worker list, checked before anything is planned.

    A duplicate name would be planned twice and reported once, and an empty
    name would be a file entry nobody can address; both are caller mistakes
    and are refused as such.
    """
    names = list(workers)
    for name in names:
        if not isinstance(name, str) or not name:
            raise ParamError(
                f"worker names have to be non-empty strings, got {name!r}. "
                f"The name is the key the session is recorded under, so "
                f"there is no sensible default."
            )
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise ParamError(
            f"worker names {duplicates} appear more than once. Each worker "
            f"is assigned exactly one session, so a repeated name cannot be "
            f"answered."
        )
    return names


def _read_state(path: Path):
    """The state file as a dict, or an empty state if there is no file.

    A file that exists but is not the structure this module writes is a
    :class:`ParamError` naming the path - never a silent rebuild. Rebuilding
    would draw new sessions for every worker, and the workers still running
    would keep the old ones, so two generations of ids would be live at once
    with nothing recording it.
    """
    path = Path(path)
    empty = {"version": _STATE_VERSION, "template": None, "workers": {}}
    if not path.exists():
        return empty
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise ParamError(
            f"the session state file {path} cannot be read: {exc}. Nothing "
            f"was rebuilt, because rebuilding would abandon every session "
            f"the file recorded. Fix the file by hand or delete it to start "
            f"over."
        ) from exc
    problem = _structure_problem(raw)
    if problem is not None:
        raise ParamError(
            f"the session state file {path} is not a state file this module "
            f"wrote: {problem}. Nothing was rebuilt, because rebuilding "
            f"would abandon every session the file recorded. Fix the file "
            f"by hand or delete it to start over."
        )
    return raw


def _structure_problem(raw) -> Optional[str]:
    """Why ``raw`` is not a state file, or None if it is one."""
    if not isinstance(raw, dict):
        return f"the top level is {type(raw).__name__}, not an object"
    if raw.get("version") != _STATE_VERSION:
        return f"version is {raw.get('version')!r}, not {_STATE_VERSION}"
    template = raw.get("template")
    if template is not None:
        if not isinstance(template, dict) or not isinstance(
            template.get("params"), dict
        ):
            return "template has to be an object holding a params object"
        if not all(
            isinstance(k, str) and isinstance(v, str)
            for k, v in template["params"].items()
        ):
            return "template params have to be strings keyed by strings"
    workers = raw.get("workers")
    if not isinstance(workers, dict):
        return "workers has to be an object keyed by worker name"
    for name, entry in workers.items():
        if not isinstance(name, str) or not name:
            return f"a worker name is {name!r}, not a non-empty string"
        if not isinstance(entry, dict):
            return f"the entry for worker {name!r} is not an object"
        if not isinstance(entry.get("sid"), str) or not entry["sid"]:
            return f"the entry for worker {name!r} has no session id string"
        params = entry.get("params")
        if not isinstance(params, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in params.items()
        ):
            return (
                f"the entry for worker {name!r} has no params object of "
                f"strings"
            )
    return None


def _write_state(path: Path, state) -> None:
    """Write the state atomically: a temp file, then a rename.

    A crash between the two leaves the old file or the temp file, never a
    truncated state file that the next run would refuse as corrupt.
    """
    path = Path(path)
    text = json.dumps(state, indent=2, sort_keys=True) + "\n"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


@contextlib.contextmanager
def _locked(path: Path) -> Iterator[None]:
    """Hold an advisory lock on a sibling of ``path`` for the commit.

    The lock is on a separate ``.lock`` file rather than on the state file
    itself, because the state file is replaced by rename on every commit and
    a lock held on the replaced inode would not exclude anyone. Whichever of
    :mod:`fcntl` or :mod:`msvcrt` the platform has is used; on a platform
    with neither, the re-read-and-merge inside the lock is still done, which
    is the half of the guarantee that does not need the OS.
    """
    lock_path = Path(path).with_name(Path(path).name + ".lock")
    handle = open(lock_path, "a+b")
    locker = None
    try:
        try:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            locker = "fcntl"
        except ImportError:
            try:
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                locker = "msvcrt"
            except ImportError:  # pragma: no cover - no platform here has neither
                locker = None
        yield
    finally:
        try:
            if locker == "fcntl":
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif locker == "msvcrt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            handle.close()
