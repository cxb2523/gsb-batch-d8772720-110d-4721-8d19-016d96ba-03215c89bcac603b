"""JSON shapes shared by the CLI (--json) and the REST API. Never contain a secret."""

from __future__ import annotations

from typing import Any

from mecha.core.service import CredentialStatus

SCHEMA_VERSION = 1


def status_json(item: CredentialStatus) -> dict[str, Any]:
    known = item.last_known
    return {
        "credential": item.credential.model_dump(mode="json"),
        "result": item.result.model_dump(mode="json"),
        "cached": item.cached,
        "probe_next_at": item.probe_next_at.isoformat() if item.probe_next_at else None,
        "last_known": (
            {"overall": known.overall.value, "checked_at": known.checked_at.isoformat()}
            if known
            else None
        ),
    }
