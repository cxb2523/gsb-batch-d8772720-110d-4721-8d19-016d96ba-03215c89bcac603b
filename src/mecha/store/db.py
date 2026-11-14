"""SQLite store: numbered migrations, encrypted secrets, 0600 files.

The process umask is set to 077 before SQLite opens anything, so the database and its
``-wal``, ``-shm`` and ``-journal`` siblings are created owner-only. On Windows POSIX modes
are best effort.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path

from mecha.core.errors import MechaError, StoreCorruptError, StoreLockedError, WrongKeyError
from mecha.core.models import (
    Budget,
    CheckResult,
    Credential,
    CredentialFacts,
    CredentialKind,
    Overall,
    ProviderId,
)
from mecha.core.status import Observation
from mecha.core.ulid import new_ulid
from mecha.store import keys
from mecha.store.crypto import (
    Cipher,
    b64d,
    b64e,
    new_data_key,
    new_kdf_params,
    unwrap_data_key,
    wrap_data_key,
)

log = logging.getLogger(__name__)

FORMAT_VERSION = "1"
HISTORY_LIMIT = 500


def _migrations() -> list[tuple[int, str]]:
    out = []
    for entry in files("mecha.store.migrations").iterdir():
        name = entry.name
        if name.endswith(".sql") and name[:3].isdigit():
            out.append((int(name[:3]), entry.read_text(encoding="utf-8")))
    return sorted(out)


def _private_files() -> None:
    os.umask(0o077)


def _chmod(path: Path, mode: int) -> None:
    try:
        path.chmod(mode)
    except OSError:  # pragma: no cover - e.g. unsupported filesystem
        log.debug("cannot chmod %s", path.name)


def _connect(path: Path) -> sqlite3.Connection:
    _private_files()
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA secure_delete = ON")
        conn.execute("PRAGMA journal_mode = WAL")
    except BaseException:
        conn.close()  # e.g. "file is not a database": never leak the handle
        raise
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    current = int(conn.execute("PRAGMA user_version").fetchone()[0])
    for number, sql in _migrations():
        if number > current:
            conn.executescript(f"BEGIN;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")


def _ts(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat() if value is not None else None


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class Store:
    """An unlocked store. Create with :func:`open_store`."""

    def __init__(self, conn: sqlite3.Connection, path: Path, store_id: str, data_key: bytes):
        self.conn = conn
        self.path = path
        self.store_id = store_id
        self._data_key = data_key
        self.cipher = Cipher.from_data_key(data_key)

    # --- meta ---------------------------------------------------------------------
    def meta(self, key: str) -> str | None:
        return _meta(self.conn, key)

    def set_meta(self, key: str, value: str | None) -> None:
        if value is None:
            self.conn.execute("DELETE FROM meta WHERE key = ?", (key,))
        else:
            self.conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    @property
    def has_passphrase(self) -> bool:
        return self.meta("wrapped_key") is not None

    def set_passphrase(self, passphrase: str) -> None:
        if not passphrase:
            raise ValueError("empty passphrase")
        params = new_kdf_params()
        wrapped = wrap_data_key(self._data_key, passphrase, params, self.store_id)
        self.conn.execute("BEGIN")
        self.set_meta("kdf", json.dumps(params))
        self.set_meta("wrapped_key", b64e(wrapped))
        self.conn.execute("COMMIT")

    def remove_passphrase(self) -> None:
        """Drop the passphrase wrap. Refused unless the keyring holds this store's key."""
        if keys.keyring_get(self.store_id) != self._data_key:
            raise StoreLockedError(
                "Refusing to remove the passphrase: the system keyring does not hold this "
                "store's key, so the store would become unrecoverable."
            )
        self.conn.execute("BEGIN")
        self.set_meta("kdf", None)
        self.set_meta("wrapped_key", None)
        self.conn.execute("COMMIT")

    # --- credentials --------------------------------------------------------------
    def insert(self, cred: Credential, secret: str | None) -> None:
        ct = self.cipher.encrypt_secret(secret, cred.id) if secret is not None else None
        self.conn.execute(
            """INSERT INTO credentials (id, label, provider, kind, pattern_id, redacted,
                fingerprint, secret_ct, tags, notes, linked_path, parent_id, manual_expires_at,
                manual_budget, active_probe, token_expires_at, subscription_until, retiring,
                created_at, facts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                cred.id,
                cred.label,
                cred.provider.value,
                cred.kind.value,
                cred.pattern_id,
                cred.redacted,
                cred.fingerprint,
                ct,
                json.dumps(cred.tags),
                cred.notes,
                cred.linked_path,
                cred.parent_id,
                _ts(cred.manual_expires_at),
                cred.manual_budget.model_dump_json() if cred.manual_budget else None,
                int(cred.active_probe),
                _ts(cred.token_expires_at),
                _ts(cred.subscription_until),
                int(cred.retiring),
                _ts(cred.created_at),
                cred.facts.model_dump_json(),
            ),
        )

    def _row(self, row: sqlite3.Row) -> Credential:
        return Credential(
            id=row["id"],
            label=row["label"],
            provider=ProviderId(row["provider"]),
            kind=CredentialKind(row["kind"]),
            pattern_id=row["pattern_id"],
            redacted=row["redacted"],
            fingerprint=row["fingerprint"],
            tags=json.loads(row["tags"]),
            notes=row["notes"],
            linked_path=row["linked_path"],
            parent_id=row["parent_id"],
            manual_expires_at=_dt(row["manual_expires_at"]),
            manual_budget=(
                Budget.model_validate_json(row["manual_budget"]) if row["manual_budget"] else None
            ),
            active_probe=bool(row["active_probe"]),
            token_expires_at=_dt(row["token_expires_at"]),
            subscription_until=_dt(row["subscription_until"]),
            retiring=bool(row["retiring"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            facts=CredentialFacts.model_validate_json(row["facts"] or "{}"),
        )

    def all(self) -> list[Credential]:
        rows = self.conn.execute("SELECT * FROM credentials ORDER BY created_at, id").fetchall()
        return [self._row(r) for r in rows]

    def get(self, cred_id: str) -> Credential | None:
        row = self.conn.execute("SELECT * FROM credentials WHERE id = ?", (cred_id,)).fetchone()
        return self._row(row) if row else None

    def find_ids(self, prefix: str) -> list[str]:
        rows = self.conn.execute(
            "SELECT id FROM credentials WHERE id LIKE ? ESCAPE '\\'",
            (prefix.upper().replace("%", r"\%").replace("_", r"\_") + "%",),
        ).fetchall()
        return [r["id"] for r in rows]

    def by_fingerprint(self, fingerprint: str) -> str | None:
        row = self.conn.execute(
            "SELECT id FROM credentials WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        return str(row["id"]) if row else None

    def secret(self, cred_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT secret_ct FROM credentials WHERE id = ?", (cred_id,)
        ).fetchone()
        if row is None or row["secret_ct"] is None:
            return None
        return self.cipher.decrypt_secret(bytes(row["secret_ct"]), cred_id)

    EDITABLE = frozenset(
        {"label", "tags", "notes", "manual_expires_at", "active_probe", "manual_budget"}
    )

    def set_parent(self, cred_id: str, parent_id: str | None) -> None:
        self.conn.execute("UPDATE credentials SET parent_id = ? WHERE id = ?", (parent_id, cred_id))

    def set_facts(self, cred_id: str, facts: CredentialFacts) -> None:
        self.conn.execute(
            "UPDATE credentials SET facts = ? WHERE id = ?", (facts.model_dump_json(), cred_id)
        )

    def update(self, cred_id: str, changes: dict[str, object]) -> None:
        """Update editable, non-secret fields. The secret is never updatable: rotating a key
        means deleting it and adding the new one."""
        unknown = set(changes) - self.EDITABLE
        if unknown:
            raise ValueError(f"not editable: {sorted(unknown)}")
        cols: list[str] = []
        values: list[object] = []
        for key, value in changes.items():
            cols.append(f"{key} = ?")
            if key == "tags":
                values.append(json.dumps(value))
            elif key == "manual_expires_at":
                values.append(_ts(value) if isinstance(value, datetime) else None)
            elif key == "active_probe":
                values.append(int(bool(value)))
            elif key == "manual_budget":
                values.append(value.model_dump_json() if isinstance(value, Budget) else None)
            else:
                values.append(value)
        if cols:
            self.conn.execute(
                f"UPDATE credentials SET {', '.join(cols)} WHERE id = ?",  # noqa: S608 - fixed names
                (*values, cred_id),
            )

    def delete(self, cred_id: str) -> bool:
        cur = self.conn.execute("DELETE FROM credentials WHERE id = ?", (cred_id,))
        return cur.rowcount > 0  # its exposures go with it (ON DELETE CASCADE)

    # --- exposures (mecha scan): encrypted, never in clear ----------------------------
    def exposures(self, cred_id: str) -> list[dict[str, object]]:
        row = self.conn.execute(
            "SELECT blob FROM exposures WHERE credential_id = ?", (cred_id,)
        ).fetchone()
        if row is None:
            return []
        plain = self.cipher.decrypt_record(bytes(row["blob"]), b"exposure:" + cred_id.encode())
        data: list[dict[str, object]] = json.loads(plain)
        return data

    def exposure_ids(self) -> list[str]:
        return [r[0] for r in self.conn.execute("SELECT credential_id FROM exposures")]

    def set_exposures(self, cred_id: str, items: list[dict[str, object]], at: datetime) -> None:
        if not items:
            self.conn.execute("DELETE FROM exposures WHERE credential_id = ?", (cred_id,))
            return
        blob = self.cipher.encrypt_record(
            json.dumps(items, sort_keys=True).encode(), b"exposure:" + cred_id.encode()
        )
        self.conn.execute(
            """INSERT INTO exposures (credential_id, blob, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(credential_id) DO UPDATE SET blob = excluded.blob,
               updated_at = excluded.updated_at""",
            (cred_id, blob, _ts(at)),
        )

    # --- history ------------------------------------------------------------------
    def add_result(self, result: CheckResult, observation: Observation | None) -> None:
        """Store one check (result + the raw observation) and keep the last 500."""
        payload = json.dumps(
            {
                "result": result.model_dump(mode="json"),
                "observation": observation.model_dump(mode="json") if observation else None,
            }
        )
        self.conn.execute("BEGIN")
        self.conn.execute(
            "INSERT INTO check_results (credential_id, checked_at, overall, payload) "
            "VALUES (?, ?, ?, ?)",
            (result.credential_id, _ts(result.checked_at), result.overall.value, payload),
        )
        self.conn.execute(
            """DELETE FROM check_results WHERE credential_id = ? AND id NOT IN (
                   SELECT id FROM check_results WHERE credential_id = ?
                   ORDER BY checked_at DESC, id DESC LIMIT ?)""",
            (result.credential_id, result.credential_id, HISTORY_LIMIT),
        )
        self.conn.execute("COMMIT")

    def last_observation(self, cred_id: str) -> Observation | None:
        row = self.conn.execute(
            "SELECT payload FROM check_results WHERE credential_id = ? "
            "ORDER BY checked_at DESC, id DESC LIMIT 1",
            (cred_id,),
        ).fetchone()
        if row is None:
            return None
        obs = json.loads(row["payload"]).get("observation")
        return Observation.model_validate(obs) if obs else None

    def failure_streak(self, cred_id: str, limit: int = 32) -> int:
        """How many of the latest checks failed in a row (grey, could not check)."""
        rows = self.conn.execute(
            "SELECT payload FROM check_results WHERE credential_id = ? "
            "ORDER BY checked_at DESC, id DESC LIMIT ?",
            (cred_id, limit),
        ).fetchall()
        streak = 0
        for row in rows:
            obs = json.loads(row["payload"]).get("observation") or {}
            if obs.get("check_status") != "failed":
                break
            streak += 1
        return streak

    def last_known(self, cred_id: str) -> tuple[Overall, datetime] | None:
        """The most recent non-grey result: what a grey card shows as last known state."""
        row = self.conn.execute(
            "SELECT overall, checked_at FROM check_results "
            "WHERE credential_id = ? AND overall != 'grey' "
            "ORDER BY checked_at DESC, id DESC LIMIT 1",
            (cred_id,),
        ).fetchone()
        if row is None:
            return None
        return Overall(row["overall"]), datetime.fromisoformat(row["checked_at"])

    def history(self, cred_id: str, limit: int = 50) -> list[CheckResult]:
        rows = self.conn.execute(
            "SELECT payload FROM check_results WHERE credential_id = ? "
            "ORDER BY checked_at DESC, id DESC LIMIT ?",
            (cred_id, limit),
        ).fetchall()
        return [CheckResult.model_validate(json.loads(r["payload"])["result"]) for r in rows]

    def close(self) -> None:
        try:
            if str(self.path) != ":memory:":
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            self.conn.close()


def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else None


def _locked_message(path: Path, has_passphrase: bool) -> str:
    where = f"The store at {path}"
    if has_passphrase:
        return (
            f"{where} is locked: its key is not in the system keyring. Provide the recovery "
            f"passphrase with {keys.ENV_PASSPHRASE_FILE} (a 0600 file) or {keys.ENV_PASSPHRASE}, "
            "or run interactively."
        )
    return (
        f"{where} is locked: its key is not in the system keyring and no recovery passphrase "
        "was ever set. Restore the keyring entry; a new key will not be generated over "
        "existing data."
    )


def open_memory_store() -> Store:
    """An ephemeral in-memory store with a random key that never leaves the process
    (demo mode). Nothing touches the disk or the keyring."""
    conn = sqlite3.connect(":memory:", isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _migrate(conn)
    store_id = new_ulid()
    store = Store(conn, Path(":memory:"), store_id, new_data_key())
    store.set_meta("store_id", store_id)
    store.set_meta("verifier", b64e(store.cipher.make_verifier(store_id)))
    return store


def open_store(path: Path, prompt: keys.PassphrasePrompt | None = None) -> Store:
    """Open (or create) the store at ``path``. Never generates a key for an existing store."""
    if path.exists():
        return _open_existing(path, prompt)
    return _create(path, prompt)


def _open_existing(path: Path, prompt: keys.PassphrasePrompt | None) -> Store:
    conn: sqlite3.Connection | None = None
    try:
        conn = _connect(path)
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    except sqlite3.DatabaseError as exc:
        if conn is not None:
            conn.close()  # never leak the handle on a failed open
        if isinstance(exc, sqlite3.OperationalError):
            raise MechaError(f"Cannot open the store at {path}: {exc}.") from exc
        raise StoreCorruptError(f"{path} is not a readable SQLite database.") from exc
    try:
        if version < 1:
            raise StoreCorruptError(f"{path} is not a Mecha store; refusing to touch it.")
        store_id = _meta(conn, "store_id")
        verifier = _meta(conn, "verifier")
        if not store_id or not verifier:
            raise StoreCorruptError(f"{path} has no store metadata; refusing to touch it.")
        verifier_ct = b64d(verifier)
        wrapped = _meta(conn, "wrapped_key")
        kdf = _meta(conn, "kdf")

        keyring_key = keys.keyring_get(store_id)
        if keyring_key is not None:
            if Cipher.from_data_key(keyring_key).check_verifier(verifier_ct, store_id):
                _migrate(conn)
                return Store(conn, path, store_id, keyring_key)
            log.warning("keyring key does not open this store; trying the passphrase")

        passphrase = keys.passphrase_from_env()
        if passphrase is None and wrapped is not None and prompt is not None:
            passphrase = prompt("Passphrase for the Mecha store", False)
        if passphrase is not None and wrapped is not None and kdf is not None:
            data_key = unwrap_data_key(b64d(wrapped), passphrase, json.loads(kdf), store_id)
            if not Cipher.from_data_key(data_key).check_verifier(verifier_ct, store_id):
                raise WrongKeyError("The passphrase unwrapped a key that does not open this store.")
            if keyring_key is None and keys.keyring_set(store_id, data_key):
                log.info("restored the store key into the system keyring")
            _migrate(conn)
            return Store(conn, path, store_id, data_key)

        if keyring_key is not None:
            raise WrongKeyError("The keyring entry for this store holds a different key.")
        raise StoreLockedError(_locked_message(path, wrapped is not None))
    except BaseException:
        conn.close()
        raise


def _create(path: Path, prompt: keys.PassphrasePrompt | None) -> Store:
    store_id = new_ulid()
    data_key = new_data_key()
    passphrase = keys.passphrase_from_env()
    in_keyring = keys.keyring_set(store_id, data_key)
    if not in_keyring and passphrase is None:
        if prompt is None:
            raise StoreLockedError(
                "No system keyring is available to hold the store key. Set "
                f"{keys.ENV_PASSPHRASE_FILE} (a 0600 file) or {keys.ENV_PASSPHRASE}, or run "
                "interactively to choose a passphrase."
            )
        passphrase = prompt("No system keyring. Choose a passphrase for the Mecha store", True)

    conn: sqlite3.Connection | None = None
    try:
        _private_files()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        _chmod(path.parent, 0o700)
        conn = _connect(path)
        _chmod(path, 0o600)
        _migrate(conn)
        store = Store(conn, path, store_id, data_key)
        conn.execute("BEGIN")
        store.set_meta("store_id", store_id)
        store.set_meta("format_version", FORMAT_VERSION)
        store.set_meta("created_at", _ts(datetime.now(UTC)))
        store.set_meta("verifier", b64e(store.cipher.make_verifier(store_id)))
        conn.execute("COMMIT")
        if passphrase is not None:
            store.set_passphrase(passphrase)
    except BaseException:
        if conn is not None:
            conn.close()
        if in_keyring:
            keys.keyring_delete(store_id)
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(f"{path}{suffix}").unlink(missing_ok=True)
        raise
    if not in_keyring:
        log.info("store key protected by passphrase only (no system keyring)")
    return store
