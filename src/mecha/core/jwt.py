"""Decode JWTs locally *without* verifying the signature.

Everything extracted here is shown as «sin verificar» (source ``jwt``). The ChatGPT claims
under ``https://api.openai.com/auth`` are undocumented, so every field is optional.
"""

from __future__ import annotations

import base64
import binascii
import json
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from mecha.core.models import ProviderId

OPENAI_AUTH_CLAIM = "https://api.openai.com/auth"
OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile"

ISSUERS: dict[str, ProviderId] = {
    "https://auth.openai.com": ProviderId.openai,
    "https://accounts.google.com": ProviderId.gemini,
    "accounts.google.com": ProviderId.gemini,
}


class JwtError(ValueError):
    pass


class JwtInfo(BaseModel):
    issuer: str | None = None
    provider: ProviderId | None = None
    expires_at: datetime | None = None
    issued_at: datetime | None = None
    email: str | None = None
    plan: str | None = None
    subscription_until: datetime | None = None
    organizations: list[str] = []


def looks_like_jwt(text: str) -> bool:
    parts = text.split(".")
    return len(parts) == 3 and text.startswith("eyJ") and all(parts[:2])


def _b64json(segment: str) -> dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
        value = json.loads(raw)
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise JwtError("segment is not base64url JSON") from exc
    if not isinstance(value, dict):
        raise JwtError("segment is not a JSON object")
    return value


def _timestamp(value: object) -> datetime | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        seconds = value / 1000 if value > 10**11 else value  # tolerate milliseconds
        try:
            return datetime.fromtimestamp(seconds, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def _str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def decode_claims(token: str) -> dict[str, Any]:
    if not looks_like_jwt(token):
        raise JwtError("not a JWT (expected three dot-separated segments)")
    header_seg, payload_seg, _ = token.split(".")
    header = _b64json(header_seg)
    if "alg" not in header:
        raise JwtError("JWT header has no 'alg'")
    return _b64json(payload_seg)


def inspect_jwt(token: str) -> JwtInfo:
    claims = decode_claims(token)
    issuer = _str(claims.get("iss"))
    auth = claims.get(OPENAI_AUTH_CLAIM)
    auth = auth if isinstance(auth, dict) else {}
    profile = claims.get(OPENAI_PROFILE_CLAIM)
    profile = profile if isinstance(profile, dict) else {}

    orgs_raw = auth.get("organizations")
    organizations: list[str] = []
    if isinstance(orgs_raw, list):
        for org in orgs_raw:
            name = org.get("title") or org.get("id") if isinstance(org, dict) else org
            if isinstance(name, str):
                organizations.append(name)

    return JwtInfo(
        issuer=issuer,
        provider=ISSUERS.get(issuer.rstrip("/")) if issuer else None,
        expires_at=_timestamp(claims.get("exp")),
        issued_at=_timestamp(claims.get("iat")),
        email=_str(claims.get("email")) or _str(profile.get("email")),
        plan=_str(auth.get("chatgpt_plan_type")),
        subscription_until=_timestamp(auth.get("chatgpt_subscription_active_until")),
        organizations=organizations,
    )
