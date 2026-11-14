from __future__ import annotations

import contextlib
import os

# Must happen before keyring picks a backend: tests never touch the real system keyring.
os.environ["PYTHON_KEYRING_BACKEND"] = "tests.memkeyring.MemoryKeyring"

from collections.abc import Iterator
from pathlib import Path

import keyring
import pytest

from mecha.core.logging import install_log_redaction
from tests.memkeyring import MemoryKeyring

keyring.set_keyring(MemoryKeyring())
install_log_redaction()


@pytest.fixture(autouse=True)
def memory_keyring() -> Iterator[MemoryKeyring]:
    """A fresh in-memory keyring per test."""
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    yield backend
    keyring.set_keyring(MemoryKeyring())


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "mecha-home"
    monkeypatch.setenv("MECHA_HOME", str(home))
    for var in ("MECHA_PASSPHRASE", "MECHA_PASSPHRASE_FILE", "MECHA_LOG_LEVEL"):
        monkeypatch.delenv(var, raising=False)
    return home


@pytest.fixture(autouse=True)
def close_stores(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Close every store a test opened (Python 3.13+ warns on unclosed SQLite connections,
    and the warning would surface in whichever later test triggers garbage collection)."""
    import sqlite3

    from mecha.store.db import Store

    opened: list[Store] = []
    original = Store.__init__

    def tracking(self: Store, *args: object, **kwargs: object) -> None:
        original(self, *args, **kwargs)  # type: ignore[arg-type]
        opened.append(self)

    monkeypatch.setattr(Store, "__init__", tracking)
    yield
    for store in opened:
        with contextlib.suppress(sqlite3.Error):
            store.conn.close()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
