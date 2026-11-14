"""Fake credentials generated at test time. Never real keys; nothing secret in the repo."""

from __future__ import annotations

import base64
import json
import secrets
import string
from typing import Any

_BODY = string.ascii_letters + string.digits + "_-"


def body(n: int = 48) -> str:
    return "".join(secrets.choice(_BODY) for _ in range(n))


def fake(prefix: str, n: int = 48) -> str:
    return prefix + body(n)


def fake_aiza() -> str:
    return "AIza" + body(35)


def fake_aq() -> str:
    return "AQ." + body(20) + "." + body(30)


def _seg(obj: Any) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def fake_jwt(claims: dict[str, Any], header: dict[str, Any] | None = None) -> str:
    head = header if header is not None else {"alg": "RS256", "typ": "JWT"}
    return f"{_seg(head)}.{_seg(claims)}.{body(43)}"
