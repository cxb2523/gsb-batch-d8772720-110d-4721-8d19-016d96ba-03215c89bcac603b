"""mecha scan: offline, redacted, severity by location; never the real home folder.

Every test runs on a temporary tree with made-up keys. A fixture makes any read outside
that tree fail, and network access fails too (only --check tests mock their provider).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import stat
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
import respx
from typer.testing import CliRunner

from mecha.cli import app
from mecha.core.errors import StoreLockedError
from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.scan import fsio, places
from mecha.scan.model import Confidence, Risk
from mecha.scan.places import Env
from mecha.scan.risk import Readability
from mecha.scan.walk import Options
from mecha.store.db import open_store
from tests.fakes import body

SK_ANT = "sk-ant-api03-" + "S" * 20 + body(73) + "AA"
CANARY = "sk-proj-CANARYSCAN" + body(140)


def ant() -> str:
    return "sk-ant-api03-" + body(93) + "AA"


def aiza() -> str:
    return "AIza" + body(35)


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
    """Any connection off this machine fails. Loopback stays allowed: on Windows, asyncio
    builds its event loop's internal socket pair by connecting to 127.0.0.1."""
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
        return real_create(address, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "create_connection", create)


def env(tree: Path, platform: str = "linux", **environ: str) -> Env:
    return Env(home=tree / "home", platform=platform, environ=environ)


@pytest.fixture
def svc():  # type: ignore[no-untyped-def]
    service = MechaService(lambda: open_store(db_path(), None))
    yield service
    service.close()


def scan(svc: MechaService, tree: Path, *roots: Path, platform: str = "linux", **kw: object):  # type: ignore[no-untyped-def]
    options = Options(roots=list(roots) or [tree], **kw)  # type: ignore[arg-type]
    return svc.scan(options, env=env(tree, platform))


GIT = shutil.which("git") or "git"


def git(repo: Path, *args: str) -> None:
    subprocess.run([GIT, "-C", str(repo), *args], check=True, capture_output=True)  # noqa: S603


def by_name(report, name: str):  # type: ignore[no-untyped-def]
    return [f for f in report.findings if f.location.path.name == name]


# --- redaction and secrets ---------------------------------------------------------------


def test_output_is_redacted_everywhere(
    svc: MechaService, tree: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.DEBUG)
    (tree / "proj").mkdir()
    (tree / "proj" / ".env").write_text(f"OPENAI_API_KEY={CANARY}  # prod, do not share\n")
    stored = ant()
    svc.add(stored)
    (tree / "notes.txt").write_text(f"old key: {stored}\n")
    report = scan(svc, tree)
    assert {f.location.path.name for f in report.findings} == {".env", "notes.txt"}
    svc.close()
    monkeypatch.setattr(Env, "current", classmethod(lambda cls: env(tree)))
    runner = CliRunner()
    for args in (["scan", str(tree)], ["scan", str(tree), "--json"]):
        out = runner.invoke(app, args).output
        assert CANARY not in out
        assert CANARY[12:40] not in out
        assert stored not in out
        assert "prod, do not share" not in out  # never the line itself
    assert CANARY not in caplog.text
    assert stored not in caplog.text
    dump = "\n".join(open_store(db_path(), None).conn.iterdump())
    assert CANARY not in dump
    assert stored not in dump
    assert "notes.txt" not in dump  # locations are encrypted


def test_ids_come_from_the_location_never_the_key(svc: MechaService, tree: Path) -> None:
    (tree / "a.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    first = scan(svc, tree).findings[0].location.id
    (tree / "a.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")  # another key, same place
    assert scan(svc, tree).findings[0].location.id == first


# --- severity by location ------------------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="git and POSIX paths")
def test_git_tracked_and_not_ignored_are_amber_ignored_is_info(
    svc: MechaService, tree: Path
) -> None:
    repo = tree / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / ".gitignore").write_text(".env\n")
    (repo / ".env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    (repo / "tracked.py").write_text(f"KEY = '{ant()}'\n")
    (repo / "loose.txt").write_text(f"{ant()}\n")
    git(repo, "add", ".gitignore", "tracked.py")
    report = scan(svc, tree)
    assert by_name(report, ".env")[0].risks == ()
    assert by_name(report, "tracked.py")[0].risks == (Risk.git_tracked,)
    assert by_name(report, "loose.txt")[0].risks == (Risk.git_not_ignored,)
    assert report.amber


@pytest.mark.skipif(sys.platform == "win32", reason="git")
def test_git_never_runs_a_repository_fsmonitor(svc: MechaService, tree: Path) -> None:
    repo = tree / "cloned"
    repo.mkdir()
    git(repo, "init", "-q")
    marker = tree / "pwned"
    hook = tree / "fsmonitor.sh"
    hook.write_text(f"#!/bin/sh\ntouch {marker}\n")
    hook.chmod(0o755)
    git(repo, "config", "core.fsmonitor", str(hook))
    (repo / "x.txt").write_text(f"{ant()}\n")
    scan(svc, tree)
    assert not marker.exists()


def test_histories_and_notebooks_are_risky(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    key = ant()
    (home / ".zsh_history").write_text(f": 1700000000:0;export ANTHROPIC_API_KEY={key}\n")
    fish = home / ".local" / "share" / "fish"
    fish.mkdir(parents=True)
    (fish / "fish_history").write_text(f"- cmd: set -x XAI_API_KEY xai-{body(80)}\n  when: 1\n")
    nb = {"cells": [{"cell_type": "code", "source": [f"key = '{ant()}'\n"], "outputs": []}]}
    (tree / "work.ipynb").write_text(json.dumps(nb))
    report = scan(svc, tree)
    zsh = by_name(report, ".zsh_history")[0]
    assert zsh.risks == (Risk.shell_history,)
    assert zsh.location.column == len(": 1700000000:0;export ANTHROPIC_API_KEY=") + 1
    assert by_name(report, "fish_history")[0].provider == "xai"
    cell = by_name(report, "work.ipynb")[0]
    assert cell.risks == (Risk.notebook,)
    assert (cell.location.line, cell.location.cell_line) == (1, 1)


def test_powershell_histfile_and_terminal_sessions(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    ps = home / "AppData" / "Roaming" / "Microsoft" / "Windows" / "PowerShell" / "PSReadLine"
    ps.mkdir(parents=True)
    (ps / "ConsoleHost_history.txt").write_text(f"$env:XAI_API_KEY='xai-{body(80)}'\n")
    report = svc.scan(
        Options(roots=[home]),
        env=Env(
            home=home, platform="win32", environ={"APPDATA": str(home / "AppData" / "Roaming")}
        ),
    )
    assert by_name(report, "ConsoleHost_history.txt")[0].risks == (Risk.shell_history,)
    custom = tree / "home" / "hist" / "my_history"
    custom.parent.mkdir()
    custom.write_text(f"curl -H 'x-api-key: {ant()}'\n")
    sessions = home / ".zsh_sessions"
    sessions.mkdir()
    (sessions / "ABC.history").write_text(f": 1:0;export K={ant()}\n")
    report = svc.scan(
        Options(roots=[home]),
        env=Env(home=home, platform="darwin", environ={"HISTFILE": str(custom)}),
    )
    assert by_name(report, "my_history")[0].risks == (Risk.shell_history,)
    assert by_name(report, "ABC.history")[0].risks == (Risk.shell_history,)


def test_synced_folder_is_risky(svc: MechaService, tree: Path) -> None:
    (tree / "home" / "Dropbox").mkdir()
    (tree / "home" / "Dropbox" / "keys.txt").write_text(f"{ant()}\n")
    (tree / "home" / "OneDrive - Acme").mkdir()
    (tree / "home" / "OneDrive - Acme" / "a.env").write_text(f"K={ant()}\n")
    report = scan(svc, tree, tree / "home")
    assert all(f.risks == (Risk.synced_folder,) for f in report.findings)
    assert len(report.findings) == 2


@pytest.mark.skipif(os.name != "posix", reason="POSIX permissions")
def test_readable_by_others_counts_only_with_other_people(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = Readability._others_can_enter
    inside_tree = tree.resolve()

    def enter(self: Readability, folder: Path) -> bool:  # outside the tree: assume open
        return real(self, folder) if inside_tree in [folder, *folder.parents] else True

    monkeypatch.setattr(Readability, "_others_can_enter", enter)
    tree.chmod(0o755)
    world = tree / "world.env"
    world.write_text(f"K={ant()}\n")
    world.chmod(0o644)
    group = tree / "group.env"
    group.write_text(f"K={ant()}\n")
    group.chmod(0o640)  # group read only: does not count
    monkeypatch.setattr("mecha.scan.walk.other_people", lambda _env: True)
    report = scan(svc, tree)
    assert by_name(report, "world.env")[0].risks == (Risk.readable_by_others,)
    assert by_name(report, "group.env")[0].risks == ()
    monkeypatch.setattr("mecha.scan.walk.other_people", lambda _env: False)
    assert by_name(scan(svc, tree), "world.env")[0].risks == ()  # nobody else here: info


def test_other_people_reads_human_accounts(monkeypatch: pytest.MonkeyPatch, tree: Path) -> None:
    pwd = pytest.importorskip("pwd")
    from mecha.scan.risk import other_people

    me = os.getuid()

    class U:
        def __init__(self, name: str, uid: int, shell: str) -> None:
            self.pw_name, self.pw_uid, self.pw_shell = name, uid, shell

    accounts = [
        U("me", me, "/bin/zsh"),
        U("svc", 999, "/bin/bash"),
        U("daemon", 1001, "/usr/sbin/nologin"),
    ]
    monkeypatch.setattr(pwd, "getpwall", lambda: accounts)
    assert other_people(env(tree, "linux")) is False
    accounts.append(U("ana", 1002, "/bin/bash"))
    assert other_people(env(tree, "linux")) is True
    assert other_people(env(tree, "win32")) is None


# --- confidence ------------------------------------------------------------------------


def test_confidence_from_the_variable_name(svc: MechaService, tree: Path) -> None:
    lines = [
        f"FIREBASE_API_KEY={aiza()}",
        f"GEMINI_API_KEY={aiza()}",
        f'os.environ["GOOGLE_API_KEY"] = "{aiza()}"',
        f"OPENAI_API_KEY=sk-{body(48)}",
        f"DEEPSEEK_API_KEY=sk-{body(48)}",
        f"value sk-{body(48)}",
        f"XAI_API_KEY=xai-{body(80)}",
    ]
    (tree / "mixed.txt").write_text("\n".join(lines) + "\n")
    got = {f.location.line: f.confidence for f in scan(svc, tree).findings}
    assert got == {
        1: Confidence.low,
        2: Confidence.high,
        3: Confidence.low,  # any Google Cloud key
        4: Confidence.high,
        5: Confidence.low,
        6: Confidence.low,
        7: Confidence.high,
    }


# --- known places --------------------------------------------------------------------------


@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_ai_tool_configs_are_scanned_by_default(
    svc: MechaService, tree: Path, platform: str
) -> None:
    home = tree / "home"
    appdata = home / "AppData" / "Roaming"
    claude = {
        "darwin": home / "Library" / "Application Support" / "Claude",
        "win32": appdata / "Claude",
        "linux": home / ".config" / "Claude",
    }[platform]
    files = [
        claude / "claude_desktop_config.json",
        home / ".cursor" / "mcp.json",
        home / ".config" / "devin" / "mcp_config.json",
        home / ".codeium" / "windsurf" / "mcp_config.json",
        home / ".continue" / "config.yaml",
    ]
    for f in files:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"mcpServers": {"x": {"env": {"XAI_API_KEY": f"xai-{body(80)}"}}}}))
    report = svc.scan(
        Options(roots=[home]),
        env=Env(home=home, platform=platform, environ={"APPDATA": str(appdata)}),
    )
    assert {f.location.path for f in report.findings} == {f.resolve() for f in files}


# --- limits --------------------------------------------------------------------------------


def test_exclusions_size_binaries_and_symlinks(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    for folder in (
        home / "proj" / "node_modules",
        home / ".venv",
        home / ".ollama",
        home / ".cache" / "huggingface",
    ):
        folder.mkdir(parents=True)
        (folder / "k.txt").write_text(f"{ant()}\n")
    (home / "big.txt").write_text("x" * 2048 + ant())
    (home / "blob.bin").write_bytes(b"\0" * 10 + ant().encode())
    outside = tree / "outside"
    outside.mkdir()
    (outside / "secret.env").write_text(f"K={ant()}\n")
    (home / "link.env").symlink_to(outside / "secret.env")
    report = svc.scan(Options(roots=[home], max_size=1024), env=env(tree))
    assert report.findings == []
    s = report.skipped
    assert (s.excluded_dir, s.too_large, s.binary, s.symlink_outside) == (4, 1, 1, 1)


def test_a_key_split_across_prefilter_chunks_is_found(svc: MechaService, tree: Path) -> None:
    key = ant()
    padding = "x" * (fsio.CHUNK - 5) + "\n"
    (tree / "long.txt").write_text(padding + f"K={key}\n")
    assert [f.location.line for f in scan(svc, tree, max_size=10**6).findings] == [2]


def test_cloud_only_files_are_never_opened(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tree / "placeholder.env").write_text(f"K={ant()}\n")
    opened: list[str] = []
    real_open = fsio.open_binary
    monkeypatch.setattr(fsio, "cloud_only", lambda st: True)
    monkeypatch.setattr(fsio, "open_binary", lambda p: opened.append(str(p)) or real_open(p))
    report = scan(svc, tree)
    assert report.findings == []
    assert report.skipped.cloud_only == 1
    assert opened == []


def test_macos_protected_folders_only_when_asked(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    for name in ("Desktop", "Documents", "Downloads"):
        (home / name).mkdir()
        (home / name / "k.env").write_text(f"K={ant()}\n")
    assert scan(svc, tree, home, platform="darwin").skipped.protected_dir == 3
    assert scan(svc, tree, home, platform="darwin").findings == []
    assert len(scan(svc, tree, home, platform="darwin", include_protected=True).findings) == 3
    assert len(scan(svc, tree, home / "Desktop", platform="darwin").findings) == 1  # asked
    assert len(scan(svc, tree, home, platform="linux").findings) == 3


def test_session_files_are_info_unless_in_a_risky_place(svc: MechaService, tree: Path) -> None:
    creds = tree / "home" / ".claude" / ".credentials.json"
    creds.parent.mkdir()
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "sk-ant-oat01-" + body(80)}}))
    [f] = scan(svc, tree, tree / "home").findings
    assert f.session_file == "claude-code"
    assert not f.amber
    assert not f.storable


@pytest.mark.skipif(sys.platform == "win32", reason="git")
def test_a_session_file_in_a_dotfiles_repo_is_amber(svc: MechaService, tree: Path) -> None:
    home = tree / "home"
    creds = home / ".claude" / ".credentials.json"
    creds.parent.mkdir()
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": "sk-ant-oat01-" + body(80)}}))
    git(home, "init", "-q")
    git(home, "add", ".claude/.credentials.json")
    [f] = scan(svc, tree, home).findings
    assert f.session_file == "claude-code"
    assert f.risks == (Risk.git_tracked,)
    assert f.amber


def test_scanning_never_creates_a_store(cli_env: Path) -> None:
    (cli_env / "a.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    out = CliRunner().invoke(app, ["scan", str(cli_env), "--json"])
    assert "no_store" in json.loads(out.output)["warnings"]  # (+ a Windows permissions note)
    assert not db_path().exists()


# --- stored keys, import, locked store ----------------------------------------------------


def test_stored_key_exposure_is_encrypted_amber_and_deleted_with_it(
    svc: MechaService, tree: Path
) -> None:
    key = ant()
    cid = svc.add(key).credential.id
    (tree / "home" / ".bash_history").write_text(f"export ANTHROPIC_API_KEY={key}\n")
    report = scan(svc, tree, tree / "home")
    assert report.findings[0].stored_id == cid
    item = svc.get(cid)
    assert item.credential.facts.exposure is not None
    assert item.credential.facts.exposure.risky == 1
    assert "exposed_in_plaintext" in [r.code for r in item.result.reasons]
    assert svc.exposures(cid)[0]["risks"] == ["shell_history"]
    assert ".bash_history" not in "\n".join(svc.store.conn.iterdump())
    # Cleaned up: the next scan of the same place clears it.
    (tree / "home" / ".bash_history").write_text("ls\n")
    scan(svc, tree, tree / "home")
    assert svc.get(cid).credential.facts.exposure is None
    assert svc.exposures(cid) == []
    # Deleting the credential deletes its locations.
    (tree / "home" / ".bash_history").write_text(f"export ANTHROPIC_API_KEY={key}\n")
    scan(svc, tree, tree / "home")
    svc.remove(cid)
    assert svc.store.exposure_ids() == []


def test_keys_mecha_does_not_manage_are_never_stored(svc: MechaService, tree: Path) -> None:
    (tree / "home" / ".bash_history").write_text(f"export ANTHROPIC_API_KEY={ant()}\n")
    scan(svc, tree, tree / "home")
    assert svc.store.exposure_ids() == []


def test_import_rereads_the_file(svc: MechaService, tree: Path) -> None:
    key = ant()
    f = tree / "a.env"
    f.write_text(f"ANTHROPIC_API_KEY={key}\nFIREBASE_API_KEY={aiza()}\n")
    report = scan(svc, tree)
    high = next(x for x in report.findings if x.confidence is Confidence.high)
    low = next(x for x in report.findings if x.confidence is Confidence.low)
    f.write_text(f"ANTHROPIC_API_KEY={ant()}\nFIREBASE_API_KEY={aiza()}\n")  # rotated
    assert svc.import_found(report, [high.location.id])[0]["code"] == "changed"
    report = scan(svc, tree)
    high = next(x for x in report.findings if x.confidence is Confidence.high)
    [ok] = svc.import_found(report, [high.location.id])
    assert ok["ok"]
    assert svc.store.secret(str(ok["credential_id"])) is not None
    assert svc.import_found(report, [low.location.id])[0]["code"] == "low_confidence"
    again = scan(svc, tree)
    assert svc.import_found(again, [high.location.id])[0]["code"] == "duplicate"


def test_locked_store_still_scans_and_says_so(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tree / "a.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    locked = MechaService(lambda: (_ for _ in ()).throw(StoreLockedError("locked")))
    report = locked.scan(Options(roots=[tree]), env=env(tree))
    assert len(report.findings) == 1
    assert report.findings[0].stored_id is None
    assert report.findings[0].fingerprint is None
    assert "store_locked" in report.warnings
    assert not report.store_checked


# --- CLI: exit codes, --check ------------------------------------------------------------


@pytest.fixture
def cli_env(tree: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(Env, "current", classmethod(lambda cls: env(tree)))
    return tree


def test_exit_codes(cli_env: Path) -> None:
    runner = CliRunner()
    (cli_env / "proj").mkdir()
    (cli_env / "proj" / "app.env").write_text(f"FIREBASE_API_KEY={aiza()}\n")
    assert runner.invoke(app, ["scan", str(cli_env / "proj")]).exit_code == 0
    (cli_env / "nb.ipynb").write_text(
        json.dumps({"cells": [{"source": [f"x = '{aiza()}'"], "outputs": []}]})
    )
    # Low confidence in a risky place: amber, but does not change the exit code.
    assert runner.invoke(app, ["scan", str(cli_env)]).exit_code == 0
    (cli_env / "nb2.ipynb").write_text(
        json.dumps({"cells": [{"source": [f"k = '{ant()}'"], "outputs": []}]})
    )
    assert runner.invoke(app, ["scan", str(cli_env)]).exit_code == 1
    assert runner.invoke(app, ["scan", "--nope"]).exit_code == 3


def test_check_validates_only_high_confidence_unmanaged_keys(cli_env: Path) -> None:
    key = "sk-proj-" + body(156)
    (cli_env / "nb.ipynb").write_text(
        json.dumps(
            {"cells": [{"source": [f"OPENAI_API_KEY = '{key}'\nG = '{aiza()}'"], "outputs": []}]}
        )
    )
    runner = CliRunner()
    no_tty = runner.invoke(app, ["scan", str(cli_env), "--check"])
    assert no_tty.exit_code == 3
    assert "--yes" in no_tty.output
    with respx.mock(assert_all_called=False) as router:
        models = router.get("https://api.openai.com/v1/models").mock(
            return_value=httpx.Response(401, json={"error": {"code": "invalid_api_key"}})
        )
        anything_else = router.route().mock(return_value=httpx.Response(500))
        out = runner.invoke(app, ["scan", str(cli_env), "--check", "--yes", "--json"])
    assert models.call_count == 1
    assert anything_else.call_count == 0
    data = json.loads(out.output)
    openai = next(f for f in data["findings"] if f["provider"] == "openai")
    assert openai["check"] == "invalid"
    assert openai["severity"] == "info"
    assert out.exit_code == 0  # a revoked/invalid key in a notebook is no longer amber
    assert key not in out.output


@pytest.mark.skipif(os.name != "posix", reason="POSIX permissions")
def test_permissions_helper_needs_every_folder_open(tmp_path: Path) -> None:
    folder = tmp_path / "closed"
    folder.mkdir()
    f = folder / "a"
    f.write_text("x")
    f.chmod(0o644)
    folder.chmod(0o700)
    try:
        assert not Readability().readable_by_others(f, os.stat(f))
    finally:
        folder.chmod(0o755)
    assert stat.S_IMODE(os.stat(f).st_mode) & stat.S_IROTH


# --- scanning single files again (the dashboard's "scan these files again") ---------------


def test_a_single_file_inside_a_known_folder_is_read_as_what_it_is(
    svc: MechaService, tree: Path
) -> None:
    home = tree / "home"
    fish = home / ".local" / "share" / "fish"
    fish.mkdir(parents=True)
    (fish / "fish_history").write_text(f"- cmd: export K={ant()}\n  when: 1\n")
    (home / "other.txt").write_text(f"{ant()}\n")
    report = svc.scan(Options(roots=[fish / "fish_history"]), env=env(tree))
    assert [f.location.path.name for f in report.findings] == ["fish_history"]
    assert report.findings[0].risks == (Risk.shell_history,)


def test_stop_cancels_between_files(svc: MechaService, tree: Path) -> None:
    from mecha.scan.walk import ScanCancelled

    for i in range(3):
        (tree / "home" / f"{i}.txt").write_text("x\n")
    seen: list[int] = []

    def progress(n: int, _p: Path) -> None:
        seen.append(n)

    with pytest.raises(ScanCancelled):
        svc.scan(Options(roots=[tree]), env=env(tree), progress=progress, stop=lambda: bool(seen))
    assert seen == [1]


# --- a scan only replaces the locations of files it read -----------------------------------


def stored_in(svc: MechaService, cid: str) -> list[str]:
    return sorted(Path(str(e["path"])).name for e in svc.exposures(cid))


def test_protected_folder_not_scanned_this_time_keeps_its_location(
    svc: MechaService, tree: Path
) -> None:
    home = tree / "home"
    key = ant()
    cid = svc.add(key).credential.id
    proj = home / "Documents" / "proj"
    proj.mkdir(parents=True)
    (proj / ".env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    darwin = env(tree, "darwin")
    svc.scan(Options(roots=[home], include_protected=True), env=darwin)
    assert stored_in(svc, cid) == [".env"]
    report = svc.scan(Options(roots=[home]), env=darwin)  # the dashboard's default
    assert stored_in(svc, cid) == [".env"]
    assert report.read == set(), "the lists of what was read are emptied after the cross-ref"
    assert report.not_read == set()


def test_cloud_only_and_unreadable_files_keep_their_location(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tree / "home"
    key = ant()
    cid = svc.add(key).credential.id
    (home / "a.env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    (home / "b.env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    svc.scan(Options(roots=[home]), env=env(tree))
    assert stored_in(svc, cid) == ["a.env", "b.env"]

    a = (home / "a.env").resolve()
    b = (home / "b.env").resolve()
    real_cloud, real_prefilter = fsio.cloud_only, fsio.prefilter
    monkeypatch.setattr(fsio, "cloud_only", lambda st: st.st_ino == a.stat().st_ino)

    def denied(path: Path) -> tuple[bool, bool]:
        if Path(path).resolve() == b:
            raise PermissionError("macOS said no")
        return real_prefilter(path)

    monkeypatch.setattr(fsio, "prefilter", denied)
    svc.scan(Options(roots=[home]), env=env(tree))
    assert stored_in(svc, cid) == ["a.env", "b.env"]
    svc.rescan_exposures(cid, env=env(tree))  # "scan these files again", same files
    assert stored_in(svc, cid) == ["a.env", "b.env"]

    monkeypatch.setattr(fsio, "cloud_only", real_cloud)
    monkeypatch.setattr(fsio, "prefilter", real_prefilter)
    (home / "a.env").write_text("ANTHROPIC_API_KEY=\n")  # read, and the key is gone
    svc.rescan_exposures(cid, env=env(tree))
    assert stored_in(svc, cid) == ["b.env"]


@pytest.mark.parametrize("how", ["full scan", "rescan"])
def test_a_deleted_file_loses_its_location(svc: MechaService, tree: Path, how: str) -> None:
    home = tree / "home"
    key = ant()
    cid = svc.add(key).credential.id
    (home / "proj").mkdir()
    (home / "proj" / ".env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={key}\n")
    svc.scan(Options(roots=[home]), env=env(tree))
    assert stored_in(svc, cid) == [".env", ".zsh_history"]
    (home / "proj" / ".env").unlink()
    if how == "rescan":
        svc.rescan_exposures(cid, env=env(tree))
    else:
        svc.scan(Options(roots=[home]), env=env(tree))
    assert stored_in(svc, cid) == [".zsh_history"]
    assert svc.get(cid).credential.facts.exposure is not None


def test_a_key_removed_from_a_config_inside_library_loses_its_location(
    svc: MechaService, tree: Path
) -> None:
    """~/Library is excluded from the walk, but known configs inside it are read."""
    home = tree / "home"
    key = ant()
    cid = svc.add(key).credential.id
    config = home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"mcpServers": {"x": {"env": {"ANTHROPIC_API_KEY": key}}}}))
    darwin = env(tree, "darwin")
    svc.scan(Options(roots=[home]), env=darwin)
    assert stored_in(svc, cid) == ["claude_desktop_config.json"]
    config.write_text(json.dumps({"mcpServers": {}}))
    svc.scan(Options(roots=[home]), env=darwin)
    assert stored_in(svc, cid) == []
    assert svc.get(cid).credential.facts.exposure is None


def cloud_folders(home: Path) -> tuple[Path, Path]:
    icloud = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    dropbox = home / "Library" / "CloudStorage" / "Dropbox"
    for folder in (icloud, dropbox):
        folder.mkdir(parents=True)
    return icloud, dropbox


def test_include_protected_scans_icloud_drive_and_cloud_storage(
    svc: MechaService, tree: Path
) -> None:
    """Both sit inside ~/Library, which the walk skips: the flag walks them anyway."""
    home = tree / "home"
    icloud, dropbox = cloud_folders(home)
    (icloud / "notes.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    (dropbox / "keys.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n")
    darwin = env(tree, "darwin")

    report = svc.scan(Options(roots=[home], include_protected=True), env=darwin)
    assert sorted(f.location.path.name for f in report.findings) == ["keys.env", "notes.env"]
    assert all(f.risks == (Risk.synced_folder,) and f.amber for f in report.findings)
    assert report.roots == [home]

    report = svc.scan(Options(roots=[home]), env=darwin)
    assert report.findings == []
    assert report.skipped.protected_dir == 2  # counted although the walk never got there


def test_without_the_flag_protected_folders_keep_locations_without_a_stat_inside(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tree / "home"
    key = ant()
    cid = svc.add(key).credential.id
    icloud, dropbox = cloud_folders(home)
    (home / "Documents").mkdir()
    for folder in (icloud, dropbox, home / "Documents"):
        (folder / "k.env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    darwin = env(tree, "darwin")
    svc.scan(Options(roots=[home], include_protected=True), env=darwin)
    assert len(svc.exposures(cid)) == 3

    protected = [p.resolve() for p in places.protected_dirs(darwin)]
    touched: list[str] = []

    def guard(real: Callable[..., object]) -> Callable[..., object]:
        def call(path: object, *args: object, **kwargs: object) -> object:
            resolved = Path(os.path.abspath(os.fspath(path)))  # type: ignore[call-overload]
            if any(p in resolved.parents for p in protected):
                touched.append(str(resolved))
                raise PermissionError("macOS would ask for permission here")
            return real(path, *args, **kwargs)

        return call

    real = {name: getattr(os, name) for name in ("stat", "lstat", "scandir")}
    for name, fn in real.items():
        monkeypatch.setattr(os, name, guard(fn))
    report = svc.scan(Options(roots=[home]), env=darwin)  # the dashboard's default
    for name, fn in real.items():
        monkeypatch.setattr(os, name, fn)
    assert touched == [], "looked inside a protected folder without the flag"
    assert report.skipped.protected_dir == 3
    assert len(svc.exposures(cid)) == 3, "locations in protected folders are kept"


# --- importing ---------------------------------------------------------------------------


def test_import_rereads_with_the_scan_checks_and_stops_past_the_line(
    svc: MechaService, tree: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tree / "home"
    (home / "a.env").write_text(f"ANTHROPIC_API_KEY={ant()}\n" + "x=1\n" * 50)
    report = svc.scan(Options(roots=[home]), env=env(tree))
    fid = report.findings[0].location.id
    monkeypatch.setattr(fsio, "cloud_only", lambda st: True)  # went to iCloud meanwhile
    opened: list[Path] = []
    real_open = fsio.open_binary

    def spy(path: Path):  # type: ignore[no-untyped-def]
        opened.append(Path(path))
        return real_open(path)

    monkeypatch.setattr(fsio, "open_binary", spy)
    assert svc.import_found(report, [fid]) == [{"id": fid, "ok": False, "code": "not_readable"}]
    assert opened == [], "a cloud-only file is never opened (it would be downloaded)"

    monkeypatch.undo()
    from mecha.scan import walk

    consumed: list[int] = []
    real_lines = walk.fsio.lines

    def counting(path: Path, kind: object):  # type: ignore[no-untyped-def]
        for item in real_lines(path, kind):  # type: ignore[arg-type]
            consumed.append(item[0])
            yield item

    monkeypatch.setattr(walk.fsio, "lines", counting)
    assert walk.read_token(report.findings[0].location) is not None
    assert consumed == [1]
