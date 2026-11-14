from __future__ import annotations

import json
import os
import stat
import sys
from datetime import UTC, datetime
from pathlib import Path

import keyring
import pytest

from mecha.core.errors import (
    PassphraseFileError,
    StoreCorruptError,
    StoreLockedError,
    UnsupportedKdfError,
    WrongKeyError,
)
from mecha.core.models import Credential, CredentialKind, ProviderId
from mecha.core.paths import db_path
from mecha.store import crypto, keys
from mecha.store.db import open_store
from tests.fakes import fake
from tests.memkeyring import MemoryKeyring, NoKeyring

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX permissions")


def _cred(store_cipher: crypto.Cipher, secret: str, cid: str = "01CRED") -> Credential:
    return Credential(
        id=cid,
        label="test",
        provider=ProviderId.anthropic,
        kind=CredentialKind.api_key,
        redacted="sk-ant-api03-…",
        fingerprint=store_cipher.fingerprint(secret),
        created_at=datetime.now(UTC),
    )


def no_prompt(message: str, confirm: bool) -> str:
    raise AssertionError("must not prompt")


def test_guard_real_keyring_is_never_used() -> None:
    assert isinstance(keyring.get_keyring(), MemoryKeyring)


def test_create_and_reopen_with_keyring(memory_keyring: MemoryKeyring) -> None:
    store = open_store(db_path(), no_prompt)
    secret = fake("sk-ant-api03-")
    store.insert(_cred(store.cipher, secret), secret)
    store_id = store.store_id
    store.close()

    assert (keys.KEYRING_SERVICE, f"store:{store_id}") in memory_keyring.data
    again = open_store(db_path(), no_prompt)
    assert again.store_id == store_id
    assert again.secret("01CRED") == secret
    assert not again.has_passphrase
    again.close()


def test_two_homes_use_distinct_keyring_entries(
    tmp_path: Path, memory_keyring: MemoryKeyring
) -> None:
    a = open_store(tmp_path / "a" / "mecha.db", no_prompt)
    b = open_store(tmp_path / "b" / "mecha.db", no_prompt)
    assert a.store_id != b.store_id
    assert len(memory_keyring.data) == 2
    a.close()
    b.close()


def test_passphrase_only_when_no_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    keyring.set_keyring(NoKeyring())
    monkeypatch.setenv("MECHA_PASSPHRASE", "correct horse battery staple")
    store = open_store(db_path(), no_prompt)
    assert store.has_passphrase
    kdf = json.loads(store.meta("kdf") or "{}")
    assert kdf["kdf"] == "argon2id"
    assert {"salt", "iterations", "lanes", "memory_cost"} <= set(kdf)
    secret = fake("xai-")
    store.insert(_cred(store.cipher, secret), secret)
    store.close()

    again = open_store(db_path(), no_prompt)
    assert again.secret("01CRED") == secret
    again.close()


def test_no_keyring_no_passphrase_no_tty_is_locked_and_creates_nothing() -> None:
    keyring.set_keyring(NoKeyring())
    with pytest.raises(StoreLockedError, match="MECHA_PASSPHRASE_FILE"):
        open_store(db_path(), None)
    assert not db_path().exists()


def test_no_keyring_prompts_with_confirmation_when_tty() -> None:
    keyring.set_keyring(NoKeyring())
    calls: list[bool] = []

    def prompt(message: str, confirm: bool) -> str:
        calls.append(confirm)
        return "typed passphrase"

    open_store(db_path(), prompt).close()
    assert calls == [True]
    open_store(db_path(), prompt).close()
    assert calls == [True, False]


def test_wrong_passphrase(monkeypatch: pytest.MonkeyPatch) -> None:
    keyring.set_keyring(NoKeyring())
    monkeypatch.setenv("MECHA_PASSPHRASE", "right")
    open_store(db_path(), None).close()
    monkeypatch.setenv("MECHA_PASSPHRASE", "wrong")
    with pytest.raises(WrongKeyError):
        open_store(db_path(), None)


def test_lost_keyring_with_passphrase_recovers_and_restores_keyring(
    monkeypatch: pytest.MonkeyPatch, memory_keyring: MemoryKeyring
) -> None:
    monkeypatch.setenv("MECHA_PASSPHRASE", "recovery")
    store = open_store(db_path(), None)
    secret = fake("sk-proj-")
    store.insert(_cred(store.cipher, secret), secret)
    store.close()

    memory_keyring.data.clear()  # keyring lost
    again = open_store(db_path(), None)
    assert again.secret("01CRED") == secret
    again.close()
    assert memory_keyring.data, "key restored into the keyring"


def test_lost_keyring_without_passphrase_never_generates_a_new_key(
    memory_keyring: MemoryKeyring,
) -> None:
    open_store(db_path(), None).close()
    before = db_path().read_bytes()
    memory_keyring.data.clear()
    with pytest.raises(StoreLockedError, match="will not be generated"):
        open_store(db_path(), no_prompt)
    assert not memory_keyring.data
    assert db_path().read_bytes() == before


def test_wrong_keyring_key_falls_back_to_passphrase(
    monkeypatch: pytest.MonkeyPatch, memory_keyring: MemoryKeyring
) -> None:
    monkeypatch.setenv("MECHA_PASSPHRASE", "recovery")
    store = open_store(db_path(), None)
    entry = (keys.KEYRING_SERVICE, keys.keyring_user(store.store_id))
    store.close()
    memory_keyring.data[entry] = crypto.b64e(os.urandom(32))
    open_store(db_path(), None).close()

    memory_keyring.data[entry] = crypto.b64e(os.urandom(32))
    monkeypatch.delenv("MECHA_PASSPHRASE")
    with pytest.raises(WrongKeyError):
        open_store(db_path(), None)


def test_unsupported_kdf_is_a_clear_error(monkeypatch: pytest.MonkeyPatch) -> None:
    keyring.set_keyring(NoKeyring())
    monkeypatch.setenv("MECHA_PASSPHRASE", "p")
    open_store(db_path(), None).close()

    def unsupported(params: dict[str, object], passphrase: bytes) -> bytes:
        raise UnsupportedKdfError("This store's passphrase uses argon2id, which … not support")

    monkeypatch.setattr(crypto, "_derive", unsupported)
    with pytest.raises(UnsupportedKdfError, match="argon2id"):
        open_store(db_path(), None)


def test_unknown_kdf_in_metadata_is_never_switched(monkeypatch: pytest.MonkeyPatch) -> None:
    keyring.set_keyring(NoKeyring())
    monkeypatch.setenv("MECHA_PASSPHRASE", "p")
    store = open_store(db_path(), None)
    params = json.loads(store.meta("kdf") or "{}")
    store.set_meta("kdf", json.dumps({**params, "kdf": "argon3"}))
    store.close()
    with pytest.raises(UnsupportedKdfError, match="argon3"):
        open_store(db_path(), None)


def test_scrypt_fallback_when_argon2_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    keyring.set_keyring(NoKeyring())
    monkeypatch.setenv("MECHA_PASSPHRASE", "p")
    monkeypatch.setattr(crypto, "argon2_available", lambda: False)
    store = open_store(db_path(), None)
    assert json.loads(store.meta("kdf") or "{}")["kdf"] == "scrypt"
    store.close()
    open_store(db_path(), None).close()


def test_verifier_detects_wrong_key() -> None:
    store = open_store(db_path(), None)
    other = crypto.Cipher.from_data_key(os.urandom(32))
    blob = crypto.b64d(store.meta("verifier") or "")
    assert store.cipher.check_verifier(blob, store.store_id)
    assert not other.check_verifier(blob, store.store_id)
    store.close()


def test_ciphertexts_are_bound_to_their_row() -> None:
    store = open_store(db_path(), None)
    blob = store.cipher.encrypt_secret("s3cret-value", "01A")
    assert store.cipher.decrypt_secret(blob, "01A") == "s3cret-value"
    with pytest.raises(StoreCorruptError):
        store.cipher.decrypt_secret(blob, "01B")
    store.close()


def test_fingerprint_is_keyed_per_store(tmp_path: Path) -> None:
    a = open_store(tmp_path / "a.db", None)
    b = open_store(tmp_path / "b.db", None)
    secret = fake("sk-ant-api03-")
    assert len(a.cipher.fingerprint(secret)) == 12
    assert a.cipher.fingerprint(secret) == a.cipher.fingerprint(secret)
    assert a.cipher.fingerprint(secret) != b.cipher.fingerprint(secret)
    a.close()
    b.close()


def test_not_a_mecha_store(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "other.db"
    sqlite3.connect(path).execute("CREATE TABLE t (x)").connection.close()
    with pytest.raises(StoreCorruptError, match="not a Mecha store"):
        open_store(path, None)
    garbage = tmp_path / "garbage.db"
    garbage.write_bytes(b"definitely not sqlite" * 100)
    with pytest.raises(StoreCorruptError, match="not a readable"):
        open_store(garbage, None)


def test_remove_passphrase_requires_keyring(
    monkeypatch: pytest.MonkeyPatch, memory_keyring: MemoryKeyring
) -> None:
    monkeypatch.setenv("MECHA_PASSPHRASE", "p")
    store = open_store(db_path(), None)
    store.remove_passphrase()
    assert not store.has_passphrase
    store.set_passphrase("again")
    memory_keyring.data.clear()
    with pytest.raises(StoreLockedError, match="unrecoverable"):
        store.remove_passphrase()
    store.close()


# --- passphrase file ------------------------------------------------------------------


def test_passphrase_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    keyring.set_keyring(NoKeyring())
    file = tmp_path / "pass"
    file.write_text("from-file\n")
    file.chmod(0o600)
    monkeypatch.setenv("MECHA_PASSPHRASE_FILE", str(file))
    open_store(db_path(), None).close()
    open_store(db_path(), None).close()


@posix_only
def test_passphrase_file_must_be_private(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    file = tmp_path / "pass"
    file.write_text("x")
    file.chmod(0o644)
    monkeypatch.setenv("MECHA_PASSPHRASE_FILE", str(file))
    with pytest.raises(PassphraseFileError, match="chmod 600"):
        keys.passphrase_from_env()


def test_passphrase_env_and_file_are_exclusive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MECHA_PASSPHRASE", "a")
    monkeypatch.setenv("MECHA_PASSPHRASE_FILE", str(tmp_path / "x"))
    with pytest.raises(PassphraseFileError, match="only one"):
        keys.passphrase_from_env()


# --- permissions ----------------------------------------------------------------------


@posix_only
def test_files_are_owner_only() -> None:
    store = open_store(db_path(), None)
    secret = fake("sk-ant-api03-")
    store.insert(_cred(store.cipher, secret), secret)
    siblings = [p for p in db_path().parent.iterdir() if p.name.startswith("mecha.db")]
    assert {p.name for p in siblings} >= {"mecha.db", "mecha.db-wal", "mecha.db-shm"}
    for p in siblings:
        assert stat.S_IMODE(p.stat().st_mode) == 0o600, p.name
    assert stat.S_IMODE(db_path().parent.stat().st_mode) == 0o700
    store.close()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions")
def test_failed_creation_cleans_up(
    memory_keyring: MemoryKeyring, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mecha.store import db

    def boom(conn: object) -> None:
        raise RuntimeError("migration failed")

    monkeypatch.setattr(db, "_migrate", boom)
    with pytest.raises(RuntimeError):
        open_store(db_path(), None)
    assert not db_path().exists()
    assert not memory_keyring.data
