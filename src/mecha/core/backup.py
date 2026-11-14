"""Encrypted backups: ``mecha export`` / ``mecha restore``.

File format (version 1)::

    MECHA-BACKUP\\n
    {"format": 1, "cipher": "AES-256-GCM", "kdf": {...}, "created_at": ...}\\n   <- header
    <12-byte nonce><AES-256-GCM ciphertext of the JSON payload>

* The key comes from a passphrase (12+ characters) via the KDF named in the header
  (Argon2id, or scrypt where Argon2id is unavailable), with its parameters and salt. Those
  parameters are checked against upper bounds before deriving anything. The store's own key is
  **never** written: a backup opens with its passphrase on any machine.
* The header is the AEAD associated data: changing a byte of it (or of the ciphertext)
  makes the backup fail to open.
* The payload holds credentials with their secrets and settings, not the check history.
* There is no plaintext export.
"""

from __future__ import annotations

import base64
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from mecha.core.errors import MechaError, UnsupportedKdfError
from mecha.store.crypto import _derive, new_kdf_params

MAGIC = b"MECHA-BACKUP\n"
FORMAT = 1
NONCE = 12
MIN_PASSPHRASE = 12  # the file holds every secret and usually ends up in a cloud folder

# Upper bounds for the KDF parameters read from a header. The header is only authenticated
# when decrypting, *after* the key derivation, so a forged file must not be able to ask for
# terabytes of memory or hours of CPU: anything outside these bounds is rejected first.
MAX_MEMORY_BYTES = 1024**3  # 1 GiB
ARGON2_BOUNDS = {
    "iterations": (1, 10),
    "lanes": (1, 16),
    "memory_cost": (8, MAX_MEMORY_BYTES // 1024),
}
SCRYPT_BOUNDS = {"n": (2, 2**20), "r": (1, 32), "p": (1, 16)}
SALT_BYTES = (16, 64)


class BackupError(MechaError):
    code = "backup"
    exit_code = 2


def encrypt_backup(payload: dict[str, Any], passphrase: str) -> bytes:
    if not passphrase:
        raise BackupError("A backup needs a passphrase.")
    if len(passphrase) < MIN_PASSPHRASE:
        raise BackupError(
            f"The backup passphrase must have at least {MIN_PASSPHRASE} characters: the file "
            "holds every secret."
        )
    params = new_kdf_params()
    header = json.dumps(
        {
            "format": FORMAT,
            "cipher": "AES-256-GCM",
            "kdf": params,
            "created_at": datetime.now(UTC).isoformat(),
        },
        sort_keys=True,
    ).encode()
    key = _derive(params, passphrase.encode("utf-8"))
    nonce = os.urandom(NONCE)
    ciphertext = AESGCM(key).encrypt(nonce, json.dumps(payload).encode(), MAGIC + header)
    return MAGIC + header + b"\n" + nonce + ciphertext


def _int_in(params: dict[str, Any], name: str, bounds: tuple[int, int]) -> int:
    value = params.get(name)
    low, high = bounds
    if type(value) is not int or not low <= value <= high:  # bool is not accepted
        raise BackupError(f"Backup KDF parameter {name}={value!r} is outside [{low}, {high}].")
    return value


def validate_kdf(params: Any) -> dict[str, Any]:
    """Reject KDF parameters outside safe bounds *before* deriving anything."""
    if not isinstance(params, dict):
        raise BackupError("Damaged backup header: no KDF parameters.")
    kdf = params.get("kdf")
    if kdf == "argon2id":
        bounds = ARGON2_BOUNDS
    elif kdf == "scrypt":
        bounds = SCRYPT_BOUNDS
    else:
        raise BackupError(f"Unsupported backup KDF {kdf!r}.")
    unknown = set(params) - {"kdf", "salt", *bounds}
    if unknown:
        raise BackupError(f"Unexpected backup KDF parameters: {', '.join(sorted(unknown))}.")
    values = {name: _int_in(params, name, b) for name, b in bounds.items()}
    if kdf == "argon2id" and values["memory_cost"] < 8 * values["lanes"]:
        raise BackupError("Backup KDF parameter memory_cost is below 8 x lanes.")
    if kdf == "scrypt":
        n, r = values["n"], values["r"]
        if n & (n - 1):
            raise BackupError(f"Backup KDF parameter n={n} is not a power of two.")
        if 128 * n * r > MAX_MEMORY_BYTES:
            raise BackupError("Backup KDF parameters need more than 1 GiB of memory.")
    salt = params.get("salt")
    try:
        raw = base64.b64decode(salt, validate=True) if isinstance(salt, str) else b""
    except ValueError as exc:
        raise BackupError("Damaged backup header: invalid salt.") from exc
    if not SALT_BYTES[0] <= len(raw) <= SALT_BYTES[1]:
        raise BackupError("Damaged backup header: invalid salt length.")
    return params


def read_header(data: bytes) -> tuple[dict[str, Any], bytes, bytes]:
    if not data.startswith(MAGIC):
        raise BackupError("Not a Mecha backup file.")
    rest = data[len(MAGIC) :]
    end = rest.find(b"\n")
    if end < 0:
        raise BackupError("Damaged backup header.")
    header_bytes, body = rest[:end], rest[end + 1 :]
    try:
        header = json.loads(header_bytes)
    except ValueError as exc:
        raise BackupError("Damaged backup header.") from exc
    if not isinstance(header, dict) or header.get("format") != FORMAT:
        fmt = header.get("format") if isinstance(header, dict) else None
        raise BackupError(f"Unsupported backup format {fmt!r}.")
    validate_kdf(header.get("kdf"))
    return header, header_bytes, body


def decrypt_backup(data: bytes, passphrase: str) -> dict[str, Any]:
    header, header_bytes, body = read_header(data)
    if len(body) <= NONCE:
        raise BackupError("Damaged backup.")
    try:
        key = _derive(header["kdf"], passphrase.encode("utf-8"))
    except UnsupportedKdfError as exc:
        kdf = header["kdf"].get("kdf")
        raise BackupError(
            f"This backup uses {kdf}, which this cryptography/OpenSSL build does not support."
        ) from exc
    try:
        plain = AESGCM(key).decrypt(body[:NONCE], body[NONCE:], MAGIC + header_bytes)
    except InvalidTag as exc:
        raise BackupError("Wrong passphrase, or the backup was modified.") from exc
    payload: dict[str, Any] = json.loads(plain)
    return payload


def write_private(path: Path, data: bytes, *, overwrite: bool = False) -> None:
    """Create ``path`` with 0600 from the start (never world-readable, even briefly)."""
    flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if overwrite else os.O_EXCL)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError as exc:
        raise BackupError(f"{path} already exists (use --force to overwrite).") from exc
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    if os.name == "posix":
        path.chmod(0o600)
