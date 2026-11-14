"""Linked OAuth session files (Codex CLI, Claude Code, Gemini CLI).

Linked by path and opened read-only on every check; **no token is ever copied** to the
database, logged or returned. None of these formats is officially documented, so every
parser tolerates missing fields and its data is labelled as coming from a file, unverified.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from mecha.core.errors import MechaError
from mecha.core.jwt import JwtError, decode_claims, inspect_jwt
from mecha.core.models import ProviderId

Tool = Literal["codex", "claude-code", "gemini-cli"]
TOOLS: tuple[Tool, ...] = ("codex", "claude-code", "gemini-cli")
MAX_BYTES = 1_000_000


class LinkedFileError(MechaError):
    code = "linked_file"
    exit_code = 2


@dataclass
class LinkedInfo:
    """What a session file says. Never contains a token."""

    provider: ProviderId
    email: str | None = None
    plan: str | None = None
    subscription_until: datetime | None = None
    access_expires_at: datetime | None = None
    has_refresh_token: bool = False
    extra: dict[str, str] = field(default_factory=dict)


def default_path(tool: Tool, home: Path | None = None) -> Path:
    home = home or Path.home()
    if tool == "codex":
        codex_home = os.environ.get("CODEX_HOME")
        return (
            Path(codex_home).expanduser() / "auth.json"
            if codex_home
            else home / ".codex" / "auth.json"
        )
    if tool == "claude-code":
        return home / ".claude" / ".credentials.json"
    return home / ".gemini" / "oauth_creds.json"


def _ms_or_iso(value: object) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        seconds = value / 1000 if value > 10**11 else value
        try:
            return datetime.fromtimestamp(seconds, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _jwt_exp(token: object) -> datetime | None:
    if not isinstance(token, str):
        return None
    try:
        return _ms_or_iso(decode_claims(token).get("exp"))
    except JwtError:
        return None


def parse_codex(data: dict[str, Any]) -> LinkedInfo:
    raw = data.get("tokens")
    tokens: dict[str, Any] = raw if isinstance(raw, dict) else {}
    info = LinkedInfo(
        provider=ProviderId.openai, has_refresh_token=bool(tokens.get("refresh_token"))
    )
    id_token = tokens.get("id_token")
    if isinstance(id_token, str):
        try:
            claims = inspect_jwt(id_token)
            info.email, info.plan = claims.email, claims.plan
            info.subscription_until = claims.subscription_until
        except JwtError:
            pass
    info.access_expires_at = _jwt_exp(tokens.get("access_token"))
    last = _ms_or_iso(data.get("last_refresh"))
    if last:
        info.extra["last_refresh"] = last.isoformat()
    return info


def parse_claude_code(data: dict[str, Any]) -> LinkedInfo:
    raw = data.get("claudeAiOauth")
    oauth: dict[str, Any] = raw if isinstance(raw, dict) else {}
    info = LinkedInfo(
        provider=ProviderId.anthropic, has_refresh_token=bool(oauth.get("refreshToken"))
    )
    info.access_expires_at = _ms_or_iso(oauth.get("expiresAt"))
    for src, key in (("subscriptionType", "plan"), ("rateLimitTier", "rate_limit_tier")):
        if isinstance(oauth.get(src), str) and oauth[src]:
            if key == "plan":
                info.plan = oauth[src]
            else:
                info.extra[key] = oauth[src]
    scopes = oauth.get("scopes")
    if isinstance(scopes, list):
        info.extra["scopes"] = " ".join(str(s) for s in scopes)
    return info


def parse_gemini_cli(data: dict[str, Any]) -> LinkedInfo:
    info = LinkedInfo(provider=ProviderId.gemini, has_refresh_token=bool(data.get("refresh_token")))
    info.access_expires_at = _ms_or_iso(data.get("expiry_date"))
    if isinstance(data.get("scope"), str):
        info.extra["scopes"] = data["scope"]
    id_token = data.get("id_token")
    if isinstance(id_token, str):
        with contextlib.suppress(JwtError):
            info.email = inspect_jwt(id_token).email
    return info


PARSERS: dict[Tool, Callable[[dict[str, Any]], LinkedInfo]] = {
    "codex": parse_codex,
    "claude-code": parse_claude_code,
    "gemini-cli": parse_gemini_cli,
}
PROVIDER: dict[Tool, ProviderId] = {
    "codex": ProviderId.openai,
    "claude-code": ProviderId.anthropic,
    "gemini-cli": ProviderId.gemini,
}


def read_linked(tool: Tool, path: Path) -> LinkedInfo:
    """Open ``path`` read-only and parse it. Raises LinkedFileError with no file content."""
    path = path.expanduser()
    if not path.exists():
        if tool == "claude-code" and sys.platform == "darwin":
            raise LinkedFileError(
                f"No Claude Code credentials file at {path}. On macOS Claude Code keeps them "
                "in the Keychain, which Mecha does not read in v1; pass --path if you have a file."
            )
        raise LinkedFileError(f"No {tool} session file at {path}.")
    if not path.is_file():
        raise LinkedFileError(f"{path} is not a regular file.")
    if path.stat().st_size > MAX_BYTES:
        raise LinkedFileError(f"{path} is too large to be a session file.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as exc:
        raise LinkedFileError(f"Cannot read {path}.") from exc
    except ValueError as exc:
        raise LinkedFileError(f"{path} is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise LinkedFileError(f"{path} does not look like a {tool} session file.")
    return PARSERS[tool](data)
