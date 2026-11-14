"""Scan outcomes, item by item: every skip leaves a record, and a cancelled scan
resumes from its checkpoint into the report one uninterrupted run would have given.

Every test runs on a temporary tree with made-up keys. A fixture makes any read outside
that tree fail, and network access fails too.
"""

from __future__ import annotations

import json
import os
import socket
from collections import Counter
from pathlib import Path

import pytest

from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.scan import fsio, places
from mecha.scan.places import Env
from mecha.scan.walk import Checkpoint, Options, ScanCancelled
from mecha.store.db import open_store
from tests.fakes import body


def ant() -> str:
    return "sk-ant-api03-" + body(93) + "AA"


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    root = tmp_path / "tree"
    (root / "home").mkdir(parents=True)
    return root


@pytest.fixture(autouse=True)
def only_inside_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail on any file the scanner opens, or home listing, outside this test's tree."""
    real_open = fsio.open_binary

    def guarded(path: Path):  # type: ignore[no-untyped-def]
        resolved = Path(path).resolve()
        assert tmp_path.resolve() in resolved.parents, f"scan read outside the test tree: {path}"
        return real_open(path)

    monkeypatch.setattr(fsio, "open_binary", guarded)
    real_names = places._home_names

    def names(home: Path) -> list[str]:
        assert tmp_path.resolve() in home.resolve().parents, f"listed a real home: {home}"
        return real_names(home)

    monkeypatch.setattr(places, "_home_names", names)


LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any connection off this machine fails (loopback stays, for asyncio's socket pair)."""
    real_connect = socket.socket.connect
    real_create = socket.create_connection

    def host(address: object) -> object:
        return address[0] if isinstance(address, tuple) else address

    def connect(self: socket.socket, address: object) -> None:
        if host(address) not in LOOPBACK:
            raise AssertionError(f"mecha scan must not touch the network: {address}")
        real_connect(self, address)  # type: ignore[arg-type]

    def create(address: object, *args: object, **kwargs: object) -> socket.socket:
        if host(address) not in LOOPBACK:
            raise AssertionError(f"mecha scan must not touch the network: {address}")
        return real_create(address, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "create_connection", create)


def env(tree: Path, platform: str = "linux", **environ: str) -> Env:
    return Env(home=tree / "home", platform=platform, environ=environ)


@pytest.fixture
def svc():  # type: ignore[no-untyped-def]
    service = MechaService(lambda: open_store(db_path(), None))
    yield service
    service.close()


def mixed_tree(tree: Path) -> Path:
    """A home with findings and one skip of every kind (but cloud-only, faked per test)."""
    home = tree / "home"
    node = home / "proj" / "node_modules"
    node.mkdir(parents=True)
    (node / "k.txt").write_text(f"{ant()}\n")  # excluded dir
    (home / "proj" / ".env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    (home / "proj" / "z.txt").write_text("nothing here either\n")  # after node_modules
    (home / "a.txt").write_text(f"key: {ant()}\n")
    (home / "b.txt").write_text("nothing here\n")
    (home / "big.txt").write_text("x" * 2048 + ant())  # too large (max_size=1024)
    (home / "blob.bin").write_bytes(b"\0" * 10 + ant().encode())  # binary
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={ant()}\n")
    nb = {"cells": [{"cell_type": "code", "source": [f"k = '{ant()}'\n"], "outputs": []}]}
    (home / "n.ipynb").write_text(json.dumps(nb))
    outside = tree / "outside"
    outside.mkdir()
    (outside / "s.env").write_text(f"K={ant()}\n")
    (home / "link.env").symlink_to(outside / "s.env")  # symlink outside the roots
    return home


# --- every skip leaves a record ------------------------------------------------------------


def test_every_skip_leaves_a_record_with_its_path_and_reason(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = mixed_tree(tree)
    (home / "Desktop").mkdir()  # protected on macOS
    (home / "Desktop" / "k.env").write_text(f"K={ant()}\n")
    cloud = home / "cloud.env"
    cloud.write_text(f"K={ant()}\n")
    ino = cloud.stat().st_ino
    opened: list[str] = []
    real_open = fsio.open_binary
    monkeypatch.setattr(fsio, "cloud_only", lambda st: st.st_ino == ino)
    monkeypatch.setattr(fsio, "open_binary", lambda p: opened.append(str(p)) or real_open(p))
    denied = home / "denied.txt"
    denied.write_text(f"K={ant()}\n")
    real_prefilter = fsio.prefilter

    def nope(path: Path):  # type: ignore[no-untyped-def]
        if Path(path).resolve() == denied.resolve():
            raise PermissionError("macOS said no")
        return real_prefilter(path)

    monkeypatch.setattr(fsio, "prefilter", nope)

    report = svc.scan(Options(roots=[home], max_size=1024), env=env(tree, "darwin"))

    skipped_paths = {r.path for r in report.skip_records}
    assert cloud.resolve() not in {Path(p).resolve() for p in opened}, "never opened"
    assert not {f.location.path for f in report.findings} & skipped_paths
    records = [(r.path, r.reason) for r in report.skip_records]
    assert len(set(records)) == len(records), "a path is recorded once"
    expected = {
        ((home / "proj" / "node_modules").resolve(), "excluded_dir"),
        ((home / "Desktop").resolve(), "protected_dir"),
        (cloud.resolve(), "cloud_only"),
        ((home / "big.txt").resolve(), "too_large"),
        ((home / "blob.bin").resolve(), "binary"),
        (Path(os.path.abspath(home / "link.env")), "symlink_outside"),
        (denied.resolve(), "unreadable"),
    }
    assert expected <= set(records)
    counts = Counter(reason for _, reason in records)
    for reason, n in counts.items():
        assert getattr(report.skipped, reason) == n, "counters are the records, summed"
    assert report.skipped.total() == len(records)


def test_the_same_path_is_recorded_once_even_across_roots(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    node = home / "proj" / "node_modules"
    node.mkdir(parents=True)
    (node / "k.txt").write_text(f"{ant()}\n")
    report = svc.scan(
        Options(roots=[home, home / "proj"]),  # overlapping roots: met twice on the walk
        env=env(tree),
    )
    excluded = [r for r in report.skip_records if r.reason == "excluded_dir"]
    assert [r.path for r in excluded] == [node.resolve()]
    assert report.skipped.excluded_dir == 1


# --- cancel, checkpoint, resume ------------------------------------------------------------


def same_outcome(resumed, full) -> None:  # type: ignore[no-untyped-def]
    assert resumed.findings == full.findings
    assert resumed.skip_records == full.skip_records
    assert vars(resumed.skipped) == vars(full.skipped)
    assert resumed.files_scanned == full.files_scanned
    assert sorted(resumed.warnings) == sorted(full.warnings)


def test_a_resumed_scan_matches_one_uninterrupted_run(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = mixed_tree(tree)
    options = lambda: Options(roots=[home], max_size=1024)  # noqa: E731
    full = svc.scan(options(), env=env(tree))

    read_so_far: list[int] = []
    with pytest.raises(ScanCancelled) as raised:
        svc.scan(
            options(),
            env=env(tree),
            progress=lambda n, _p: read_so_far.append(n),
            stop=lambda: len(read_so_far) >= 2,
        )
    checkpoint = raised.value.checkpoint
    assert isinstance(checkpoint, Checkpoint)
    assert checkpoint.files_done >= 2
    already_read = set(checkpoint.report.read)
    assert already_read

    opened: list[Path] = []
    real_open = fsio.open_binary

    def spy(path: Path):  # type: ignore[no-untyped-def]
        opened.append(Path(path).resolve())
        return real_open(path)

    monkeypatch.setattr(fsio, "open_binary", spy)
    resumed = svc.scan(options(), env=env(tree), resume=checkpoint)

    assert not (set(opened) & already_read), "a finished file was read again"
    assert opened, "the unfinished files are read"
    same_outcome(resumed, full)


def test_stopping_before_any_file_resumes_into_a_full_run(svc: MechaService, tree: Path) -> None:
    home = mixed_tree(tree)
    full = svc.scan(Options(roots=[home], max_size=1024), env=env(tree))
    with pytest.raises(ScanCancelled) as raised:
        svc.scan(Options(roots=[home], max_size=1024), env=env(tree), stop=lambda: True)
    checkpoint = raised.value.checkpoint
    assert checkpoint.files_done == 0
    resumed = svc.scan(Options(roots=[home], max_size=1024), env=env(tree), resume=checkpoint)
    same_outcome(resumed, full)


def test_resume_does_not_double_count_walk_skips(svc: MechaService, tree: Path) -> None:
    """Excluded folders and outside symlinks are met again on the resumed walk: the
    checkpoint's records keep them from being counted or listed twice."""
    home = mixed_tree(tree)
    full = svc.scan(Options(roots=[home], max_size=1024), env=env(tree))
    read_paths: list[Path] = []
    with pytest.raises(ScanCancelled) as raised:
        svc.scan(
            Options(roots=[home], max_size=1024),
            env=env(tree),
            progress=lambda _n, p: read_paths.append(p),
            # proj/.env is read just before the walk meets proj/node_modules; proj/z.txt
            # (next) is where the stop fires — after the excluded folder was recorded.
            stop=lambda: bool(read_paths) and read_paths[-1].name == ".env",
        )
    checkpoint = raised.value.checkpoint
    assert checkpoint.report.skipped.excluded_dir == 1
    resumed = svc.scan(Options(roots=[home], max_size=1024), env=env(tree), resume=checkpoint)
    same_outcome(resumed, full)


def test_checkpoint_and_report_carry_neither_key_nor_line(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    key = ant()
    (home / "a.env").write_text(f"ANTHROPIC_API_KEY={key}  # prod, do not share\n")
    (home / "b.env").write_text(f"XAI_API_KEY=xai-{body(80)}\n")
    seen: list[int] = []
    with pytest.raises(ScanCancelled) as raised:
        svc.scan(
            Options(roots=[home]),
            env=env(tree),
            progress=lambda n, _p: seen.append(n),
            stop=lambda: bool(seen),
        )
    checkpoint = raised.value.checkpoint
    dumped = repr(checkpoint) + json.dumps(
        [{"path": str(r.path), "reason": r.reason} for r in checkpoint.report.skip_records]
    )
    assert key not in dumped
    assert "prod, do not share" not in dumped
    resumed = svc.scan(Options(roots=[home]), env=env(tree), resume=checkpoint)
    dumped = repr(resumed) + json.dumps(
        [{"path": str(r.path), "reason": r.reason} for r in resumed.skip_records]
    )
    assert key not in dumped
    assert "prod, do not share" not in dumped
