"""Cryptography for the store.

* A random 32-byte **data key** protects everything. Two subkeys are derived with HKDF:
  one for AES-256-GCM, one for the HMAC fingerprint (never the same key for both).
* Secrets are encrypted with AES-256-GCM, a random 96-bit nonce and the credential id as
  associated data, so ciphertexts cannot be swapped between rows.
* A **verifier** (a fixed plaintext encrypted with the data key) detects a wrong key before
  any row is touched.
* Optionally the data key is **wrapped** with a key derived from a passphrase (Argon2id, or
  scrypt where Argon2id is unavailable at creation time). The KDF, its parameters and the
  salt are stored; opening never silently switches KDF.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidTag, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from mecha.core.errors import StoreCorruptError, UnsupportedKdfError, WrongKeyError

KEY_BYTES = 32
NONCE_BYTES = 12
CT_VERSION = b"\x01"
VERIFIER_PLAINTEXT = b"mecha-store-verifier-v1"
FINGERPRINT_CHARS = 12

# Argon2id defaults: 64 MiB, 3 passes, 4 lanes (above OWASP minimums).
ARGON2_PARAMS: dict[str, int] = {"iterations": 3, "lanes": 4, "memory_cost": 65536}
SCRYPT_PARAMS: dict[str, int] = {"n": 2**15, "r": 8, "p": 3}


def b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def new_data_key() -> bytes:
    return os.urandom(KEY_BYTES)


def _hkdf(key: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=KEY_BYTES, salt=None, info=info).derive(key)


def _seal(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(NONCE_BYTES)
    return CT_VERSION + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def _open(key: bytes, blob: bytes, aad: bytes) -> bytes:
    if len(blob) < 1 + NONCE_BYTES + 16 or blob[:1] != CT_VERSION:
        raise StoreCorruptError("Unrecognised ciphertext format.")
    nonce, ct = blob[1 : 1 + NONCE_BYTES], blob[1 + NONCE_BYTES :]
    return AESGCM(key).decrypt(nonce, ct, aad)


@dataclass(frozen=True)
class Cipher:
    """Operations bound to an unlocked data key."""

    enc_key: bytes
    fp_key: bytes

    @classmethod
    def from_data_key(cls, data_key: bytes) -> Cipher:
        if len(data_key) != KEY_BYTES:
            raise WrongKeyError("Store key has the wrong length.")
        return cls(_hkdf(data_key, b"mecha/v1/encrypt"), _hkdf(data_key, b"mecha/v1/fingerprint"))

    def encrypt_secret(self, secret: str, credential_id: str) -> bytes:
        return _seal(self.enc_key, secret.encode("utf-8"), b"cred:" + credential_id.encode())

    def decrypt_secret(self, blob: bytes, credential_id: str) -> str:
        try:
            return _open(self.enc_key, blob, b"cred:" + credential_id.encode()).decode("utf-8")
        except InvalidTag as exc:
            raise StoreCorruptError("A stored secret failed authentication.") from exc

    def encrypt_record(self, data: bytes, aad: bytes) -> bytes:
        """Encrypt non-secret but sensitive data (e.g. where plaintext keys were found)."""
        return _seal(self.enc_key, data, aad)

    def decrypt_record(self, blob: bytes, aad: bytes) -> bytes:
        try:
            return _open(self.enc_key, blob, aad)
        except InvalidTag as exc:
            raise StoreCorruptError("A stored record failed authentication.") from exc

    def fingerprint(self, secret: str) -> str:
        digest = hmac.new(self.fp_key, secret.encode("utf-8"), hashlib.sha256).hexdigest()
        return digest[:FINGERPRINT_CHARS]

    def make_verifier(self, store_id: str) -> bytes:
        return _seal(self.enc_key, VERIFIER_PLAINTEXT, b"verifier:" + store_id.encode())

    def check_verifier(self, blob: bytes, store_id: str) -> bool:
        try:
            plain = _open(self.enc_key, blob, b"verifier:" + store_id.encode())
        except InvalidTag:
            return False
        return hmac.compare_digest(plain, VERIFIER_PLAINTEXT)


# --- Passphrase wrapping -------------------------------------------------------------


def argon2_available() -> bool:
    try:
        _derive({"kdf": "argon2id", "salt": b64e(b"\0" * 16), **_tiny_argon2()}, b"probe")
    except UnsupportedKdfError:
        return False
    return True


def _tiny_argon2() -> dict[str, int]:
    return {"iterations": 1, "lanes": 1, "memory_cost": 8}


def _derive(params: dict[str, Any], passphrase: bytes) -> bytes:
    kdf = params.get("kdf")
    salt = b64d(str(params["salt"]))
    try:
        if kdf == "argon2id":
            from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

            return Argon2id(
                salt=salt,
                length=KEY_BYTES,
                iterations=int(params["iterations"]),
                lanes=int(params["lanes"]),
                memory_cost=int(params["memory_cost"]),
            ).derive(passphrase)
        if kdf == "scrypt":
            from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

            return Scrypt(
                salt=salt,
                length=KEY_BYTES,
                n=int(params["n"]),
                r=int(params["r"]),
                p=int(params["p"]),
            ).derive(passphrase)
    except (UnsupportedAlgorithm, ImportError) as exc:
        raise UnsupportedKdfError(
            f"This store's passphrase uses {kdf}, which this cryptography/OpenSSL build does "
            "not support. Open it on a system that supports it, or unlock with the keyring."
        ) from exc
    raise UnsupportedKdfError(f"Unknown key derivation function {kdf!r} in store metadata.")


def new_kdf_params() -> dict[str, Any]:
    """Parameters for a new passphrase wrap. Argon2id when available, else scrypt."""
    salt = b64e(os.urandom(16))
    if argon2_available():
        return {"kdf": "argon2id", "salt": salt, **ARGON2_PARAMS}
    return {"kdf": "scrypt", "salt": salt, **SCRYPT_PARAMS}


def wrap_data_key(data_key: bytes, passphrase: str, params: dict[str, Any], store_id: str) -> bytes:
    wrap_key = _derive(params, passphrase.encode("utf-8"))
    return _seal(wrap_key, data_key, b"wrap:" + store_id.encode())


def unwrap_data_key(blob: bytes, passphrase: str, params: dict[str, Any], store_id: str) -> bytes:
    wrap_key = _derive(params, passphrase.encode("utf-8"))
    try:
        return _open(wrap_key, blob, b"wrap:" + store_id.encode())
    except InvalidTag as exc:
        raise WrongKeyError("Wrong passphrase for this store.") from exc
