"""Offline classification of a pasted secret. Never touches the network or the store."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel

from mecha.core.jwt import JwtError, JwtInfo, inspect_jwt, looks_like_jwt
from mecha.core.models import CredentialKind, ProviderId
from mecha.core.normalize import normalize_secret
from mecha.core.patterns import load_patterns
from mecha.core.redact import redact

Format = Literal["prefix", "regex", "jwt", "session_file", "unknown"]
SessionTool = Literal["codex", "claude-code", "gemini-cli"]

# Warning codes, translated by the CLI/UI.
W_AMBIGUOUS = "ambiguous_provider"
W_REFRESH_TOKEN = "refresh_token_not_stored"  # noqa: S105 - a warning code
W_RETIRING = "retiring_key_type"
W_SESSION_FILE = "session_file_use_link"
W_UNKNOWN = "unknown_format"
W_JWT_UNVERIFIED = "jwt_unverified"
W_JWT_UNKNOWN_ISSUER = "jwt_unknown_issuer"
W_MALFORMED_JWT = "malformed_jwt"


class Detection(BaseModel):
    format: Format
    provider: ProviderId | None = None
    kind: CredentialKind | None = None
    pattern_id: str | None = None
    label: str | None = None
    verified: bool = False
    ambiguous: bool = False
    candidates: list[ProviderId] = []
    storable: bool = False
    retiring: bool = False
    session_tool: SessionTool | None = None
    redacted: str = ""
    jwt: JwtInfo | None = None
    warnings: list[str] = []


def _session_tool(text: str) -> SessionTool | None:
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if "claudeAiOauth" in data:
        return "claude-code"
    if isinstance(data.get("tokens"), dict) and "id_token" in data["tokens"]:
        return "codex"
    if "refresh_token" in data and "expiry_date" in data:
        return "gemini-cli"
    return None


def detect(raw: str) -> Detection:
    """Classify ``raw`` (normalized first). The result never contains the secret."""
    secret = normalize_secret(raw)

    if secret.startswith("{"):
        tool = _session_tool(secret)
        if tool is not None:
            return Detection(
                format="session_file",
                kind=CredentialKind.oauth_file,
                session_tool=tool,
                label=f"{tool} session file",
                redacted="{…}",
                warnings=[W_SESSION_FILE],
            )
        return Detection(format="unknown", redacted="{…}", warnings=[W_UNKNOWN])

    for pattern in load_patterns():
        if not pattern.matches(secret):
            continue
        # `verified` is a field, not a warning: unverified formats (e.g. Gemini AQ./AIza) are
        # everyday keys, and a warning on every add would teach users to ignore warnings.
        warnings: list[str] = []
        if pattern.ambiguous:
            warnings.append(W_AMBIGUOUS)
        if not pattern.storable:
            warnings.append(W_REFRESH_TOKEN)
        if pattern.retiring:
            warnings.append(W_RETIRING)
        return Detection(
            format="regex" if pattern.regex is not None else "prefix",
            provider=pattern.provider,
            kind=pattern.kind,
            pattern_id=pattern.id,
            label=pattern.label,
            verified=pattern.verified,
            ambiguous=pattern.ambiguous,
            candidates=[pattern.provider] if pattern.ambiguous else [],
            storable=pattern.storable,
            retiring=pattern.retiring,
            redacted=redact(secret, pattern.prefix),
            warnings=warnings,
        )

    if looks_like_jwt(secret):
        try:
            info = inspect_jwt(secret)
        except JwtError:
            return Detection(format="unknown", redacted=redact(secret), warnings=[W_MALFORMED_JWT])
        warnings = [W_JWT_UNVERIFIED]
        if info.provider is None:
            warnings.append(W_JWT_UNKNOWN_ISSUER)
        return Detection(
            format="jwt",
            provider=info.provider,
            kind=CredentialKind.oauth_token,
            pattern_id="jwt",
            label="OAuth token (JWT)",
            storable=True,
            redacted=redact(secret, "eyJ"),
            jwt=info,
            warnings=warnings,
        )

    return Detection(format="unknown", redacted=redact(secret), warnings=[W_UNKNOWN])
