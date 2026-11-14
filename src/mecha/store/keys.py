"""Where the store's data key comes from.

Order when opening an existing store:
  1. system keyring (entry indexed by the store id, so two MECHA_HOME never share it);
  2. ``MECHA_PASSPHRASE`` or ``MECHA_PASSPHRASE_FILE`` (unwraps the stored wrapped key);
  3. interactive prompt, only with a TTY;
  4. otherwise ``StoreLockedError`` (CLI exit code 3).
"""

from __future__ import annotations

import contextlib
import logging
import os
import stat
from collections.abc import Callable
from pathlib import Path

import keyring
import keyring.errors

from mecha.core.errors import PassphraseFileError
from mecha.store.crypto import b64d, b64e

log = logging.getLogger(__name__)

KEYRING_SERVICE = "mecha-keys"
ENV_PASSPHRASE = "MECHA_PASSPHRASE"  # noqa: S105 - env var name
ENV_PASSPHRASE_FILE = "MECHA_PASSPHRASE_FILE"  # noqa: S105

# prompt(message, confirm) -> passphrase. None means "no TTY: never prompt".
PassphrasePrompt = Callable[[str, bool], str]


def keyring_user(store_id: str) -> str:
    return f"store:{store_id}"


def keyring_get(store_id: str) -> bytes | None:
    try:
        value = keyring.get_password(KEYRING_SERVICE, keyring_user(store_id))
    except keyring.errors.KeyringError as exc:
        log.debug("keyring unavailable: %s", type(exc).__name__)
        return None
    if not value:
        return None
    try:
        return b64d(value)
    except ValueError:
        log.warning("keyring entry for this store is malformed; ignoring it")
        return None


def keyring_set(store_id: str, data_key: bytes) -> bool:
    try:
        keyring.set_password(KEYRING_SERVICE, keyring_user(store_id), b64e(data_key))
    except keyring.errors.KeyringError as exc:
        log.debug("cannot write keyring: %s", type(exc).__name__)
        return False
    return True


def keyring_delete(store_id: str) -> None:
    with contextlib.suppress(keyring.errors.KeyringError):
        keyring.delete_password(KEYRING_SERVICE, keyring_user(store_id))


def _read_passphrase_file(path: Path, var: str = ENV_PASSPHRASE_FILE) -> str:
    try:
        st = path.stat()
    except OSError as exc:
        raise PassphraseFileError(f"{var}: cannot read {path}.") from exc
    if os.name == "posix" and stat.S_IMODE(st.st_mode) & 0o077:
        raise PassphraseFileError(
            f"{var}: {path} is accessible by other users; run chmod 600 on it."
        )
    text = path.read_text(encoding="utf-8").rstrip("\r\n")
    if not text:
        raise PassphraseFileError(f"{var}: {path} is empty.")
    return text


ENV_BACKUP_PASSPHRASE_FILE = "MECHA_BACKUP_PASSPHRASE_FILE"  # noqa: S105


def backup_passphrase_from_env() -> str | None:
    """Non-interactive backups read their passphrase from a 0600 file, never an argument."""
    file = os.environ.get(ENV_BACKUP_PASSPHRASE_FILE)
    if not file:
        return None
    return _read_passphrase_file(Path(file).expanduser(), ENV_BACKUP_PASSPHRASE_FILE)


def passphrase_from_env() -> str | None:
    value = os.environ.get(ENV_PASSPHRASE)
    file = os.environ.get(ENV_PASSPHRASE_FILE)
    if value and file:
        raise PassphraseFileError(f"Set only one of {ENV_PASSPHRASE} and {ENV_PASSPHRASE_FILE}.")
    if file:
        return _read_passphrase_file(Path(file).expanduser())
    return value or None
