"""Encrypted backups: export/restore round trip, wrong passphrase, tampering, 0600, no store key."""

from __future__ import annotations

import base64
import json
import os
import stat
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mecha.cli import app
from mecha.core.backup import (
    MAGIC,
    BackupError,
    decrypt_backup,
    encrypt_backup,
    read_header,
    write_private,
)
from mecha.core.models import CredentialFacts
from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.store.db import open_store
from tests.fakes import body, fake

PASS = "correct horse battery staple"


def service_at(path: Path) -> MechaService:
    return MechaService(lambda: open_store(path, None))


def populated(path: Path) -> tuple[MechaService, list[str]]:
    svc = service_at(path)
    secrets = [fake("sk-proj-", 120), "sk-ant-api03-R2D" + body(80) + "igAA"]
    for i, s in enumerate(secrets):
        svc.add(s, label=f"key {i}", tags=["team"], notes="kept")
    return svc, secrets


def test_round_trip_into_a_store_with_a_different_key(tmp_path: Path) -> None:
    src, secrets = populated(tmp_path / "a" / "mecha.db")
    data = encrypt_backup(src.export_payload(), PASS)
    for s in secrets:
        assert s.encode() not in data
        assert s[10:40].encode() not in data
    dst = service_at(tmp_path / "b" / "mecha.db")
    assert dst.store.cipher.fingerprint(secrets[0]) != src.store.cipher.fingerprint(secrets[0])
    results = dst.restore_payload(decrypt_backup(data, PASS))
    assert [a for _, a, _ in results] == ["restored", "restored"]
    restored = {dst.store.secret(c.id) for c in dst.store.all()}
    assert restored == set(secrets)
    for c in dst.store.all():
        assert c.tags == ["team"]
        assert c.notes == "kept"
        # Fingerprints recomputed with the destination key, so duplicates are detected.
        assert c.fingerprint == dst.store.cipher.fingerprint(dst.store.secret(c.id) or "")
    again = dst.restore_payload(decrypt_backup(data, PASS))
    assert [a for _, a, _ in again] == ["skipped: already stored"] * 2
    assert len(dst.store.all()) == 2
    src.close()
    dst.close()


def test_restore_never_overwrites_and_remaps_parents_and_reporters(tmp_path: Path) -> None:
    src = service_at(tmp_path / "a" / "mecha.db")
    admin_id = src.add(fake("sk-admin-", 80)).credential.id
    child_id = src.add(fake("sk-proj-", 120)).credential.id
    src.store.set_parent(child_id, admin_id)
    child = src.store.get(child_id)
    assert child is not None
    src.store.set_facts(
        child_id,
        CredentialFacts.model_validate(
            {
                "expires_at": {
                    "value": "2027-01-01T00:00:00Z",
                    "source": "api",
                    "observed_at": "2026-11-05T00:00:00Z",
                    "by": admin_id,
                }
            }
        ),
    )
    payload = src.export_payload()
    dst = service_at(tmp_path / "b" / "mecha.db")
    # An unrelated credential in the destination happens to use the admin key's id.
    other_secret = fake("xai-", 80)
    admin = src.store.get(admin_id)
    assert admin is not None
    clash = admin.model_copy(
        update={"label": "unrelated", "fingerprint": dst.store.cipher.fingerprint(other_secret)}
    )
    dst.store.insert(clash, other_secret)
    results = dict((label, (a, cid)) for label, a, cid in dst.restore_payload(payload))
    assert all(a == "restored" for a, _ in results.values())
    new_admin = next(cid for label, (a, cid) in results.items() if cid != child_id)
    assert new_admin != admin_id  # the clashing id was replaced, nothing overwritten
    assert dst.store.secret(admin_id) == other_secret  # the destination's own key is intact
    restored_child = dst.store.get(child_id)
    assert restored_child is not None
    assert restored_child.parent_id == new_admin
    assert restored_child.facts.expires_at is not None
    assert restored_child.facts.expires_at.by == new_admin
    src.close()
    dst.close()


def test_wrong_passphrase_and_tampering_fail(tmp_path: Path) -> None:
    data = encrypt_backup({"kind": "mecha-backup", "items": []}, PASS)
    with pytest.raises(BackupError, match="Wrong passphrase"):
        decrypt_backup(data, "nope")
    flipped = bytearray(data)
    flipped[-1] ^= 1
    with pytest.raises(BackupError, match="modified"):
        decrypt_backup(bytes(flipped), PASS)
    # The header is authenticated too: any change to it is detected.
    header, _header_bytes, rest = read_header(data)
    header["created_at"] = "1999-01-01T00:00:00+00:00"
    forged = MAGIC + json.dumps(header, sort_keys=True).encode() + b"\n" + rest
    with pytest.raises(BackupError, match="modified"):
        decrypt_backup(forged, PASS)
    with pytest.raises(BackupError, match="Not a Mecha backup"):
        decrypt_backup(b"hello", PASS)
    with pytest.raises(BackupError, match="needs a passphrase"):
        encrypt_backup({}, "")
    with pytest.raises(BackupError, match="at least 12 characters"):
        encrypt_backup({}, "short-pass1")  # 11 characters
    assert encrypt_backup({}, "twelve-chars")  # 12 is enough


def test_kdf_parameters_are_bounded_before_deriving(monkeypatch: pytest.MonkeyPatch) -> None:
    data = encrypt_backup({"kind": "mecha-backup", "items": []}, PASS)

    def must_not_derive(*_: object) -> bytes:
        raise AssertionError("the KDF ran on rejected parameters")

    monkeypatch.setattr("mecha.core.backup._derive", must_not_derive)
    argon = {
        "kdf": "argon2id",
        "salt": base64.b64encode(b"s" * 16).decode(),
        "iterations": 3,
        "lanes": 4,
        "memory_cost": 65536,
    }
    scrypt = {"kdf": "scrypt", "salt": argon["salt"], "n": 2**15, "r": 8, "p": 3}
    bad = [
        {**argon, "memory_cost": 2**40},  # terabytes of memory
        {**argon, "memory_cost": 1024**2 + 1},  # just over 1 GiB
        {**argon, "iterations": 10**9},
        {**argon, "lanes": 0},
        {**argon, "iterations": True},  # bool is not an int here
        {**argon, "iterations": "3"},
        {**argon, "extra": 1},
        {**scrypt, "n": 2**21},
        {**scrypt, "n": 3 * 2**10},  # not a power of two
        {**scrypt, "r": 33},
        {**scrypt, "n": 2**20, "r": 16},  # 2 GiB
        {**scrypt, "p": 10**6},
        {**argon, "salt": "c2hvcnQ="},  # 5-byte salt
        {**argon, "salt": "%%%"},
        {"kdf": "pbkdf2", "salt": argon["salt"]},
    ]
    for params in bad:
        header, _, rest = read_header(data)
        header["kdf"] = params
        forged = MAGIC + json.dumps(header, sort_keys=True).encode() + b"\n" + rest
        with pytest.raises(BackupError):
            decrypt_backup(forged, PASS)
    # The largest accepted values still pass validation (and would derive normally).
    from mecha.core.backup import validate_kdf

    validate_kdf({**argon, "memory_cost": 1024**2, "iterations": 10, "lanes": 16})
    validate_kdf({**scrypt, "n": 2**20, "r": 8, "p": 16})


def test_header_names_the_kdf_and_never_carries_the_store_key(tmp_path: Path) -> None:
    src, _ = populated(tmp_path / "a" / "mecha.db")
    data = encrypt_backup(src.export_payload(), PASS)
    header, _, _ = read_header(data)
    assert header["format"] == 1
    assert header["cipher"] == "AES-256-GCM"
    assert header["kdf"]["kdf"] in {"argon2id", "scrypt"}
    assert "salt" in header["kdf"]
    for key in (src.store.cipher.enc_key, src.store.cipher.fp_key):
        assert key not in data
    payload = decrypt_backup(data, PASS)
    assert "fingerprint" not in json.dumps(payload)
    src.close()


@pytest.mark.skipif(os.name != "posix", reason="POSIX permissions")
def test_backup_file_is_created_0600_and_not_overwritten(tmp_path: Path) -> None:
    out = tmp_path / "backup.mecha"
    write_private(out, b"x")
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    with pytest.raises(BackupError, match="already exists"):
        write_private(out, b"y")
    write_private(out, b"z", overwrite=True)
    assert out.read_bytes() == b"z"


def test_cli_export_and_restore(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    svc, secrets = populated(db_path())
    svc.close()
    pfile = tmp_path / "pass.txt"
    pfile.write_text(PASS + "\n")
    pfile.chmod(0o600)
    monkeypatch.setenv("MECHA_BACKUP_PASSPHRASE_FILE", str(pfile))
    out = tmp_path / "backup.mecha"
    runner = CliRunner()
    short = tmp_path / "short.txt"
    short.write_text("too-short\n")
    short.chmod(0o600)
    monkeypatch.setenv("MECHA_BACKUP_PASSPHRASE_FILE", str(short))
    r = runner.invoke(app, ["export", str(out)])
    assert r.exit_code != 0
    assert "at least 12 characters" in r.output
    assert not out.exists()
    monkeypatch.setenv("MECHA_BACKUP_PASSPHRASE_FILE", str(pfile))
    r = runner.invoke(app, ["export", str(out)])
    assert r.exit_code == 0, r.output
    assert "Exported 2 credential(s)" in r.output
    for s in secrets:
        assert s not in r.output
    r = runner.invoke(app, ["export", str(out)])
    assert r.exit_code != 0
    monkeypatch.setenv("MECHA_HOME", str(tmp_path / "other-home"))
    r = runner.invoke(app, ["restore", str(out)])
    assert r.exit_code == 0, r.output
    assert "2 restored, 0 skipped." in r.output
    r = runner.invoke(app, ["restore", str(out)])
    assert "0 restored, 2 skipped." in r.output
    monkeypatch.delenv("MECHA_BACKUP_PASSPHRASE_FILE")
    r = runner.invoke(app, ["restore", str(out)])
    assert r.exit_code != 0
    assert "no backup passphrase" in r.output
