#!/usr/bin/env python3
"""
chrome_cookies.py — Read and decrypt cookies from a local Chrome profile (macOS convenience layer)

Platform-agnostic: any adapter can call cookie_str(profile, domain, login_keys=...)
to obtain a valid session cookie string.
- macOS only (requires Keychain + Chrome encryption format); when Keychain is
  unavailable the adapter falls back to cookies.json automatically.
- Decryption: Keychain "Chrome Safe Storage" password → PBKDF2(salt=b'saltysalt',
  iterations=1003) → AES-128-CBC(iv=16 space bytes); cookie prefix 'v10'; in newer
  Chrome builds the first 32 plaintext bytes are the domain SHA-256 and must be skipped.

⚠️ Security: read-only; cookie plaintext is never written to disk; the temporary DB
   copy is deleted immediately after use.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import tempfile

try:
    from Crypto.Cipher import AES
    from Crypto.Protocol.KDF import PBKDF2
    _HAS_CRYPTO = True
except ImportError:                       # pycryptodome not installed → this layer is unavailable; fall back to cookies.json
    _HAS_CRYPTO = False

# Common Chrome profile names (for reference)
PROFILE_HINTS = {"Default": "default profile", "Profile 1": "secondary profile", "Profile 2": "another profile"}
_CHROME_DIR = "~/Library/Application Support/Google/Chrome"


def _chrome_key() -> bytes:
    """Retrieve the Chrome Safe Storage password from Keychain and derive an AES-128 key. Triggers a Keychain auth prompt on first use."""
    pw = subprocess.check_output(
        ["security", "find-generic-password", "-s", "Chrome Safe Storage", "-w"]
    ).strip()
    return PBKDF2(pw, b"saltysalt", 16, count=1003)  # type: ignore[arg-type]  # pycryptodome accepts bytes; the stub is wrong


def _decrypt(enc: bytes, key: bytes) -> str:
    """Decrypt a single cookie's encrypted_value."""
    if not enc:
        return ""
    if enc[:3] == b"v10":
        enc = enc[3:]
    dec = AES.new(key, AES.MODE_CBC, b" " * 16).decrypt(enc)
    if not dec:                            # empty ciphertext (e.g. only the 'v10' prefix remained) — guard against dec[-1] IndexError
        return ""
    dec = dec[:-dec[-1]]                   # strip PKCS7 padding
    try:
        return dec.decode("utf-8")        # legacy format: value starts at byte 0
    except UnicodeDecodeError:
        return dec[32:].decode("utf-8", "ignore")   # newer Chrome: first 32 bytes are the domain SHA-256


def read_cookies(profile: str = "Default", domain: str = "",
                 login_keys: tuple[str, ...] = ()) -> dict[str, str]:
    """Read cookies for a domain from the given Chrome profile → {name: value}.

    domain    : substring matched against host_key (e.g. 'xiaohongshu' / 'douyin').
    login_keys: when non-empty, at least one of these cookie names must be present;
                raises RuntimeError otherwise (guards against using an unauthenticated profile).
                XHS = ('web_session', 'a1');  Douyin = ('sessionid', 'sid_tt').
    """
    if not _HAS_CRYPTO:
        raise RuntimeError("pycryptodome is not installed; cannot decrypt Chrome cookies. "
                           "Run `pip install pycryptodome` or supply cookies.json instead.")
    key = _chrome_key()
    src = os.path.expanduser(f"{_CHROME_DIR}/{profile}/Cookies")
    if not os.path.exists(src):
        avail = [p for p in PROFILE_HINTS if os.path.exists(os.path.expanduser(f"{_CHROME_DIR}/{p}/Cookies"))]
        raise FileNotFoundError(f"Chrome profile cookies not found: {src}\nAvailable profiles: {avail}")
    fd, tmp = tempfile.mkstemp(suffix=".db")   # mkstemp avoids the mktemp TOCTOU race
    os.close(fd)
    con = None
    try:
        shutil.copy(src, tmp)                  # Chrome locks the Cookies file at runtime; copy first
        con = sqlite3.connect(tmp)
        rows = con.execute(
            "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE ?",
            (f"%{domain}%",),
        ).fetchall()
        out = {n: _decrypt(v, key) for n, v in rows}
        if login_keys and not any(out.get(k) for k in login_keys):
            raise RuntimeError(
                f"profile '{profile}' has no active session for {domain or 'this domain'} "
                f"(missing {'/'.join(login_keys)}); use a different profile or log in first")
        return out
    finally:
        if con is not None:                    # explicit close: `with sqlite3.connect(...)` only manages transactions, not the connection itself
            con.close()
        if os.path.exists(tmp):
            os.remove(tmp)


def cookie_str(profile: str = "Default", domain: str = "",
               login_keys: tuple[str, ...] = ()) -> str:
    """Return a formatted Cookie header string ready to pass directly in a request."""
    return "; ".join(f"{k}={v}" for k, v in read_cookies(profile, domain, login_keys).items() if v)


if __name__ == "__main__":
    # Self-check: session status for common platforms across all known profiles (counts only, no plaintext)
    checks = [("xiaohongshu", ("web_session", "a1")), ("douyin", ("sessionid", "sid_tt"))]
    print("=== Chrome profile session check ===")
    for prof in PROFILE_HINTS:
        for dom, lk in checks:
            try:
                ck = read_cookies(prof, dom)
                flag = "✓ logged in" if any(ck.get(k) for k in lk) else "△ none"
                print(f"  {prof:10} {dom:12} {len(ck):>3} cookies  {flag}")
            except Exception as e:
                print(f"  {prof:10} {dom:12} {str(e)[:40]}")
