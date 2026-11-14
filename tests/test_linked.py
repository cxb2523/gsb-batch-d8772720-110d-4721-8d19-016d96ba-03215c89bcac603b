"""Linked session files: read-only, re-read on every check, tokens never copied."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from mecha.core.errors import DuplicateCredentialError
from mecha.core.models import CredentialKind, Overall
from mecha.core.paths import db_path
from mecha.core.serialize import status_json
from mecha.core.service import MechaService
from mecha.linked import LinkedFileError, read_linked
from mecha.store.db import open_store
from tests.fakes import body, fake_jwt
from tests.test_check import Clock

pytestmark = pytest.mark.anyio
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def svc(clock: Clock):  # type: ignore[no-untyped-def]
    service = MechaService(lambda: open_store(db_path(), None), now=clock)
    yield service
    service.close()


def codex_file(
    path: Path, *, until: str = "2026-12-01T00:00:00Z", refresh: bool = True
) -> dict[str, str]:
    tokens = {
        "id_token": fake_jwt(
            {
                "iss": "https://auth.openai.com",
                "email": "dev@example.com",
                "exp": int((NOW + timedelta(hours=1)).timestamp()),
                "https://api.openai.com/auth": {
                    "chatgpt_plan_type": "pro",
                    "chatgpt_subscription_active_until": until,
                },
            }
        ),
        "access_token": fake_jwt(
            {"iss": "https://auth.openai.com", "exp": int((NOW + timedelta(hours=1)).timestamp())}
        ),
        "refresh_token": "rt_CANARY" + body(40) if refresh else "",
    }
    path.write_text(
        json.dumps(
            {"OPENAI_API_KEY": None, "tokens": tokens, "last_refresh": "2026-11-04T08:00:00Z"}
        )
    )
    return tokens


async def test_codex_shows_plan_and_subscription_end_without_copying_tokens(
    svc: MechaService, tmp_path: Path
) -> None:
    file = tmp_path / "auth.json"
    tokens = codex_file(file)
    item = svc.link("codex", str(file), label="My Codex")
    c = item.credential
    assert c.kind is CredentialKind.oauth_file
    assert c.linked_path == str(file.resolve())
    r = item.result
    assert r.overall is Overall.local
    assert r.account["plan"].value == "pro"
    assert r.account["plan"].source == "file"
    assert r.account["email"].value == "dev@example.com"
    assert r.expiry.value.expires_at == datetime(2026, 12, 1, tzinfo=UTC)  # subscription end
    assert r.expiry.source == "file"
    # The access token expires in an hour, but there is a refresh token: informational only.
    assert r.account["access_token_expires_at"].value
    dump = "\n".join(svc.store.conn.iterdump()) + json.dumps(status_json(item))
    for token in tokens.values():
        assert token not in dump
        assert token[10:40] not in dump


async def test_linked_file_is_reread_on_every_check(
    svc: MechaService, tmp_path: Path, clock: Clock
) -> None:
    file = tmp_path / "auth.json"
    codex_file(file, until="2026-12-01T00:00:00Z")
    cid = svc.link("codex", str(file)).credential.id
    codex_file(file, until="2026-11-10T00:00:00Z")  # renewed / changed by the CLI
    [r] = await svc.check([cid])
    assert r.result.expiry.value.expires_at == datetime(2026, 11, 10, tzinfo=UTC)
    assert r.result.overall is Overall.amber  # subscription ends in < 14 days
    file.unlink()
    clock.advance(minutes=1)
    [r] = await svc.check([cid])
    assert r.result.overall is Overall.amber
    assert "linked_file_unreadable" in [x.code for x in r.result.reasons]


async def test_without_refresh_token_the_access_token_expiry_counts(
    svc: MechaService, tmp_path: Path
) -> None:
    file = tmp_path / "auth.json"
    codex_file(file, refresh=False)
    r = svc.link("codex", str(file)).result
    assert r.expiry.value.expires_at == NOW + timedelta(hours=1)
    assert r.overall is Overall.amber


async def test_claude_code_and_gemini_cli(svc: MechaService, tmp_path: Path) -> None:
    claude = tmp_path / ".credentials.json"
    claude.write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": "sk-ant-oat01-" + body(80),
                    "refreshToken": "sk-ant-ort01-" + body(80),
                    "expiresAt": int((NOW + timedelta(hours=8)).timestamp() * 1000),
                    "scopes": ["user:inference", "user:profile"],
                    "subscriptionType": "max",
                    "rateLimitTier": "default_claude_max_20x",
                }
            }
        )
    )
    r = svc.link("claude-code", str(claude)).result
    assert r.account["plan"].value == "max"
    assert r.account["rate_limit_tier"].value == "default_claude_max_20x"
    assert r.overall is Overall.local
    gemini = tmp_path / "oauth_creds.json"
    gemini.write_text(
        json.dumps(
            {
                "access_token": "ya29." + body(60),
                "refresh_token": "1//" + body(40),
                "scope": "openid email",
                "token_type": "Bearer",
                "id_token": fake_jwt(
                    {"iss": "https://accounts.google.com", "email": "me@example.com"}
                ),
                "expiry_date": int((NOW + timedelta(minutes=50)).timestamp() * 1000),
            }
        )
    )
    r = svc.link("gemini-cli", str(gemini)).result
    assert r.account["email"].value == "me@example.com"
    dump = "\n".join(svc.store.conn.iterdump())
    assert "ya29." not in dump
    assert "sk-ant-oat01-" not in dump


def test_claude_code_on_macos_reads_the_file_if_present(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sys.platform", "darwin")
    with pytest.raises(LinkedFileError, match="Keychain"):
        read_linked("claude-code", tmp_path / "missing.json")
    present = tmp_path / ".credentials.json"
    present.write_text(json.dumps({"claudeAiOauth": {"subscriptionType": "pro"}}))
    assert read_linked("claude-code", present).plan == "pro"


async def test_duplicate_and_invalid_files(svc: MechaService, tmp_path: Path) -> None:
    file = tmp_path / "auth.json"
    codex_file(file)
    svc.link("codex", str(file))
    with pytest.raises(DuplicateCredentialError):
        svc.link("codex", str(file))
    bad = tmp_path / "bad.json"
    bad.write_text("not json")
    with pytest.raises(LinkedFileError, match="not valid JSON"):
        svc.link("codex", str(bad))
    with pytest.raises(LinkedFileError, match="No gemini-cli"):
        svc.link("gemini-cli", str(tmp_path / "nope.json"))
