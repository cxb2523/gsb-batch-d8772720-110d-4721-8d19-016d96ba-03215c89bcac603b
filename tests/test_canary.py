"""Phase 1 criterion: a canary key never appears in plaintext in SQLite, logs or CLI output."""

from __future__ import annotations

import logging
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mecha.cli import app
from mecha.core.paths import db_path
from mecha.store.db import Store
from tests.fakes import body

runner = CliRunner()
ROOT = Path(__file__).resolve().parent.parent


def canaries() -> list[str]:
    """Known-format canaries plus one unknown-format secret."""
    return [
        "sk-ant-api03-CANARY" + body(80),
        "sk-proj-CANARY" + body(120),
        "xai-CANARY" + body(70),
        "AIza" + "CANARY" + body(29),
    ]


def leaks(secret: str, blob: bytes | str) -> list[str]:
    """Which revealing fragments of ``secret`` appear in ``blob``."""
    data = blob.encode() if isinstance(blob, str) else blob
    # The redacted form shows prefix + 3 + last 4; anything longer from the body is a leak.
    middle = secret[len(secret) // 2 - 8 : len(secret) // 2 + 8]
    fragments = [secret, middle, secret[-24:]]
    return [f for f in fragments if f.encode() in data]


def sqlite_bytes() -> bytes:
    parent = db_path().parent
    return b"".join(
        p.read_bytes() for p in sorted(parent.iterdir()) if p.name.startswith("mecha.db")
    )


def test_canary_not_in_sqlite_logs_or_output(caplog: pytest.LogCaptureFixture) -> None:
    secrets = canaries()
    unknown = "CANARYunknown" + body(40)
    caplog.set_level(logging.DEBUG)
    outputs: list[str] = []
    for s in secrets:
        r = runner.invoke(app, ["add", "--tag", "canary"], input=s)
        assert r.exit_code == 0, r.output
        outputs.append(r.output)
    r = runner.invoke(app, ["add", "--provider", "xai", "--kind", "management_key"], input=unknown)
    assert r.exit_code == 0, r.output
    outputs.append(r.output)
    for cmd in (["ls"], ["ls", "--json"]):
        outputs.append(runner.invoke(app, cmd, env={"COLUMNS": "250"}).output)
    for s in secrets:
        outputs.append(runner.invoke(app, ["detect", "--json"], input=s).output)
    # duplicate add: error path must not echo the secret either
    outputs.append(runner.invoke(app, ["add"], input=secrets[0]).output)

    # While the store is still "warm" (WAL present) and after a checkpoint.
    raw = sqlite_bytes()
    assert raw, "store files exist"
    for s in [*secrets, unknown]:
        assert not leaks(s, raw), "secret found in SQLite files"
        assert not leaks(s, caplog.text), "secret found in logs"
        assert not leaks(s, "\n".join(outputs)), "secret found in CLI output"


def test_canary_not_leaked_by_exception_during_add(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    secret = canaries()[0]
    caplog.set_level(logging.DEBUG)

    def explode(self: Store, cred: object, plaintext: str | None) -> None:
        local_copy = plaintext  # a local holding the secret, as in a real bug
        raise RuntimeError(f"insert failed for {local_copy}")

    monkeypatch.setattr(Store, "insert", explode)
    r = runner.invoke(app, ["add"], input=secret)
    assert r.exit_code == 3
    assert "unexpected error" in r.output
    assert not leaks(secret, r.output)
    assert not leaks(secret, caplog.text)
    assert r.exception is None or not leaks(secret, repr(r.exception))


def test_canary_not_leaked_with_unknown_format_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "CANARYunknown" + body(40)  # no known prefix: scrubbed via the seen-secrets list

    def explode(self: Store, cred: object, plaintext: str | None) -> None:
        raise ValueError(f"bad value {plaintext}")

    monkeypatch.setattr(Store, "insert", explode)
    r = runner.invoke(app, ["add", "--provider", "xai"], input=secret)
    assert r.exit_code == 3
    assert not leaks(secret, r.output)


def test_canary_real_process_with_failing_insert(tmp_path: Path) -> None:
    """End to end in a subprocess: a genuine SQLite error mid-add, with DEBUG logging."""
    home = tmp_path / "home"
    env = {
        **os.environ,
        "MECHA_HOME": str(home),
        "MECHA_PASSPHRASE": "subprocess passphrase",
        "PYTHON_KEYRING_BACKEND": "tests.memkeyring.NoKeyring",
        "PYTHONPATH": str(ROOT),
        "MECHA_LOG_LEVEL": "DEBUG",
        "COLUMNS": "250",
    }
    cmd = [sys.executable, "-m", "mecha", "add"]
    first = subprocess.run(  # noqa: S603
        cmd, input=canaries()[1], env=env, capture_output=True, text=True, check=False
    )
    assert first.returncode == 0, first.stderr

    # Make the next INSERT fail inside SQLite, after the secret has been read and encrypted.
    conn = sqlite3.connect(home / "mecha.db")
    conn.execute(
        "CREATE TRIGGER no_insert BEFORE INSERT ON credentials "
        "BEGIN SELECT RAISE(ABORT, 'insert rejected by test trigger'); END"
    )
    conn.commit()
    conn.close()

    secret = canaries()[0]
    r = subprocess.run(cmd, input=secret, env=env, capture_output=True, text=True, check=False)  # noqa: S603
    assert r.returncode == 3, r.stdout + r.stderr
    assert "insert rejected by test trigger" in r.stderr
    assert "Traceback" in r.stderr  # DEBUG logging rendered the (redacted) traceback
    assert not leaks(secret, r.stdout + r.stderr)
    assert not leaks(secret, sqlite_bytes_in(home))


def sqlite_bytes_in(home: Path) -> bytes:
    return b"".join(p.read_bytes() for p in sorted(home.iterdir()) if p.name.startswith("mecha.db"))
