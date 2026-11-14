from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from mecha.core.errors import (
    AmbiguousProviderError,
    DetectionError,
    DuplicateCredentialError,
    NotFoundError,
)
from mecha.core.models import CredentialKind, Overall, ProviderId
from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.store.db import open_store
from tests.fakes import body, fake, fake_aiza, fake_jwt

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)


@pytest.fixture
def svc() -> MechaService:
    service = MechaService(lambda: open_store(db_path(), None), now=lambda: NOW)
    yield service  # type: ignore[misc]
    service.close()


def test_add_list_remove(svc: MechaService) -> None:
    secret = fake("sk-ant-api03-", 93)
    item = svc.add(f"ANTHROPIC_API_KEY={secret}\n", label=" prod ", tags=["a", "a", " b ", ""])
    c = item.credential
    assert c.label == "prod"
    assert c.tags == ["a", "b"]
    assert c.provider is ProviderId.anthropic
    assert c.redacted.startswith("sk-ant-api03-")
    assert "…" in c.redacted
    assert item.result.overall is Overall.grey
    assert svc.store.secret(c.id) == secret

    assert [i.credential.id for i in svc.list()] == [c.id]
    assert svc.remove(c.id[:8]).id == c.id
    assert svc.list() == []


def test_detect_does_not_open_store() -> None:
    def explode() -> None:
        raise AssertionError("store opened")

    svc = MechaService(explode)  # type: ignore[arg-type]
    assert svc.detect(fake("xai-")).provider is ProviderId.xai
    assert not db_path().exists()


def test_duplicate_detection(svc: MechaService) -> None:
    secret = fake("sk-proj-", 120)
    first = svc.add(secret)
    with pytest.raises(DuplicateCredentialError) as exc:
        svc.add(f'  "{secret}"  ')
    assert exc.value.existing_id == first.credential.id


def test_ambiguous_requires_provider(svc: MechaService) -> None:
    secret = fake("sk-", 48)
    with pytest.raises(AmbiguousProviderError) as exc:
        svc.add(secret)
    assert exc.value.candidates == ["openai"]
    assert svc.add(secret, provider=ProviderId.openai).credential.provider is ProviderId.openai


def test_unknown_format_needs_provider_and_kind(svc: MechaService) -> None:
    secret = body(48)
    with pytest.raises(DetectionError, match="--provider"):
        svc.add(secret)
    item = svc.add(secret, provider=ProviderId.xai, kind=CredentialKind.management_key)
    assert item.credential.kind is CredentialKind.management_key
    with pytest.raises(DetectionError, match="does not look like"):
        svc.add("tooshort", provider=ProviderId.xai)


def test_xai_key_can_be_marked_management(svc: MechaService) -> None:
    item = svc.add(fake("xai-"), kind=CredentialKind.management_key)
    assert item.credential.kind is CredentialKind.management_key


def test_kind_and_provider_mismatches(svc: MechaService) -> None:
    with pytest.raises(DetectionError, match="looks like anthropic"):
        svc.add(fake("sk-ant-api03-"), provider=ProviderId.openai)
    with pytest.raises(DetectionError, match="admin_key"):
        svc.add(fake("sk-ant-api03-"), kind=CredentialKind.admin_key)
    with pytest.raises(DetectionError, match="linked by path"):
        svc.add(fake("xai-"), kind=CredentialKind.oauth_file)


def test_refresh_tokens_and_session_files_are_refused(svc: MechaService) -> None:
    with pytest.raises(DetectionError, match="refresh token"):
        svc.add(fake("sk-ant-ort01-", 95))
    with pytest.raises(DetectionError, match="mecha link codex"):
        svc.add(json.dumps({"tokens": {"id_token": "x"}}))
    assert svc.list() == []


def test_jwt_dates_feed_offline_status(svc: MechaService) -> None:
    exp = int((NOW + timedelta(days=5)).timestamp())
    token = fake_jwt(
        {
            "iss": "https://auth.openai.com",
            "exp": exp,
            "https://api.openai.com/auth": {"chatgpt_subscription_active_until": "2027-01-01"},
        }
    )
    item = svc.add(token)
    assert item.credential.kind is CredentialKind.oauth_token
    assert item.result.overall is Overall.amber  # expires in 5 days
    assert item.result.expiry.source == "jwt"


def test_jwt_unknown_issuer_needs_provider(svc: MechaService) -> None:
    token = fake_jwt({"iss": "https://example.com"})
    with pytest.raises(DetectionError, match="issuer"):
        svc.add(token)
    assert svc.add(token, provider=ProviderId.gemini).result.overall is Overall.local


def test_sorting_red_amber_grey_local_green(svc: MechaService) -> None:
    svc.add(fake("xai-"), label="grey")
    svc.add(fake_aiza(), label="amber")
    svc.add(fake("sk-proj-", 100), label="red", manual_expires_at=NOW - timedelta(days=1))
    svc.add(fake("sk-ant-oat01-", 95), label="local")
    svc.add(fake("sk-admin-", 80), label="amber-sooner", manual_expires_at=NOW + timedelta(days=1))
    labels = [i.credential.label for i in svc.list()]
    assert labels == ["red", "amber-sooner", "amber", "grey", "local"]


def test_manual_expiry_naive_is_utc(svc: MechaService) -> None:
    item = svc.add(fake("xai-"), manual_expires_at=datetime(2027, 1, 1))
    assert item.credential.manual_expires_at == datetime(2027, 1, 1, tzinfo=UTC)


def test_resolve_id(svc: MechaService) -> None:
    item = svc.add(fake("xai-"))
    cid = item.credential.id
    assert svc.resolve_id(cid.lower()) == cid
    with pytest.raises(NotFoundError, match="4 characters"):
        svc.resolve_id("01")
    with pytest.raises(NotFoundError):
        svc.resolve_id("ZZZZZZZZ")
    with pytest.raises(NotFoundError):
        svc.resolve_id("%%%%")
