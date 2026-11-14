"""Detection: one positive and one or more negative cases for every pattern in the TOML."""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest

from mecha.core.detect import detect
from mecha.core.models import CredentialKind, ProviderId
from mecha.core.normalize import normalize_secret
from mecha.core.patterns import load_patterns, parse_patterns
from tests.fakes import body, fake, fake_aiza, fake_aq, fake_jwt

Gen = Callable[[], str]

# pattern id -> (positive generator, [negative generators that must NOT match this pattern])
CASES: dict[str, tuple[Gen, list[Gen]]] = {
    "anthropic_api_key": (
        lambda: fake("sk-ant-api03-", 93),
        [
            lambda: "sk-ant-api03-" + body(8),  # too short
            lambda: "SK-ANT-API03-" + body(40),  # wrong case
            lambda: "sk-ant-api03-" + body(20) + "!" + body(20),  # invalid char
            lambda: "x" + fake("sk-ant-api03-"),  # not at start
        ],
    ),
    "anthropic_admin_key": (
        lambda: fake("sk-ant-admin01-", 93),
        [lambda: "sk-ant-admin01-" + body(5), lambda: fake("sk-ant-admin02-")],
    ),
    "anthropic_oauth_access": (
        lambda: fake("sk-ant-oat01-", 95),
        [lambda: "sk-ant-oat01-" + body(3), lambda: fake("sk-ant-oat02-")],
    ),
    "anthropic_oauth_refresh": (
        lambda: fake("sk-ant-ort01-", 95),
        [lambda: "sk-ant-ort01-", lambda: fake("sk-ant-ort1-")],
    ),
    "openai_project_key": (
        lambda: fake("sk-proj-", 156),
        [lambda: "sk-proj-" + body(4), lambda: fake("sk-prj-")],
    ),
    "openai_service_account_key": (
        lambda: fake("sk-svcacct-", 156),
        [lambda: "sk-svcacct-" + body(4), lambda: fake("sk-svcacc-x")],
    ),
    "openai_admin_key": (
        lambda: fake("sk-admin-", 80),
        [lambda: "sk-admin-" + body(4), lambda: fake("sk_admin-")],
    ),
    "openai_legacy_key": (
        lambda: fake("sk-", 48),
        [
            lambda: "sk-" + body(10),  # too short for the generic pattern
            lambda: fake("sk-ant-api04-"),  # unknown Anthropic variant is not OpenAI
            lambda: fake("sk-or-v2-"),  # unknown OpenRouter variant is not OpenAI
        ],
    ),
    "gemini_auth_key": (
        fake_aq,
        [lambda: "AQ." + body(5), lambda: "AQ" + body(30), lambda: "aq." + body(30)],
    ),
    "gemini_standard_key": (
        fake_aiza,
        [
            lambda: "AIza" + body(34),  # one short
            lambda: "AIza" + body(36),  # one long
            lambda: "aiza" + body(35),
        ],
    ),
    "xai_api_key": (
        lambda: fake("xai-", 80),
        [lambda: "xai-" + body(6), lambda: fake("xai_"), lambda: fake("XAI-")],
    ),
    "openrouter_api_key": (
        lambda: fake("sk-or-v1-", 64),
        [lambda: "sk-or-v1-" + body(4), lambda: fake("sk-or-v2-")],
    ),
}


def test_every_pattern_has_cases() -> None:
    ids = {p.id for p in load_patterns()}
    assert ids == set(CASES), "add positive and negative cases for new patterns"
    assert all(negatives for _, negatives in CASES.values())


@pytest.mark.parametrize("pattern_id", sorted(CASES))
def test_positive(pattern_id: str) -> None:
    pattern = next(p for p in load_patterns() if p.id == pattern_id)
    secret = CASES[pattern_id][0]()
    det = detect(secret)
    assert det.pattern_id == pattern_id
    assert det.provider is pattern.provider
    assert det.kind is pattern.kind
    assert det.verified is pattern.verified
    assert "unverified_pattern" not in det.warnings  # `verified` is a field, not a warning
    assert secret not in det.model_dump_json()


@pytest.mark.parametrize(
    ("pattern_id", "index"),
    [(pid, i) for pid, (_, negs) in sorted(CASES.items()) for i in range(len(negs))],
)
def test_negative(pattern_id: str, index: int) -> None:
    secret = CASES[pattern_id][1][index]()
    assert detect(secret).pattern_id != pattern_id


def test_refresh_token_is_not_storable() -> None:
    det = detect(fake("sk-ant-ort01-", 95))
    assert not det.storable
    assert "refresh_token_not_stored" in det.warnings
    assert det.verified is False


def test_aiza_is_retiring() -> None:
    det = detect(fake_aiza())
    assert det.retiring
    assert "retiring_key_type" in det.warnings


def test_generic_sk_is_ambiguous() -> None:
    det = detect(fake("sk-", 48))
    assert det.ambiguous
    assert det.candidates == [ProviderId.openai]


def test_unknown_format() -> None:
    det = detect(body(40))
    assert det.format == "unknown"
    assert det.provider is None
    assert not det.storable


# --- JWT ------------------------------------------------------------------------------


def test_jwt_chatgpt() -> None:
    token = fake_jwt(
        {
            "iss": "https://auth.openai.com",
            "exp": 1893456000,
            "email": "dev@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": "plus",
                "chatgpt_subscription_active_until": "2026-12-31T00:00:00Z",
                "organizations": [{"id": "org-1", "title": "Personal"}],
            },
        }
    )
    det = detect(token)
    assert det.format == "jwt"
    assert det.provider is ProviderId.openai
    assert det.kind is CredentialKind.oauth_token
    assert det.jwt is not None
    assert det.jwt.plan == "plus"
    assert det.jwt.email == "dev@example.com"
    assert det.jwt.subscription_until is not None
    assert det.jwt.organizations == ["Personal"]
    assert "jwt_unverified" in det.warnings


def test_jwt_google() -> None:
    det = detect(fake_jwt({"iss": "https://accounts.google.com", "exp": 1893456000}))
    assert det.provider is ProviderId.gemini


def test_jwt_unknown_issuer() -> None:
    det = detect(fake_jwt({"iss": "https://example.com"}))
    assert det.format == "jwt"
    assert det.provider is None
    assert "jwt_unknown_issuer" in det.warnings


@pytest.mark.parametrize(
    "token",
    [
        "eyJhbGciOiJIUzI1NiJ9.!!!notbase64!!!." + body(20),
        fake_jwt({"iss": "x"}, header={"typ": "JWT"}),  # header without alg
        "eyJhbGciOiJIUzI1NiJ9." + "W10" + "." + body(10),  # payload is a JSON array
    ],
)
def test_malformed_jwt(token: str) -> None:
    det = detect(token)
    assert det.format == "unknown"
    assert det.jwt is None


def test_two_segment_token_is_not_jwt() -> None:
    assert detect("eyJhbGciOiJIUzI1NiJ9." + body(30)).format == "unknown"


# --- session files ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("doc", "tool"),
    [
        ({"tokens": {"id_token": "x", "access_token": "y"}, "last_refresh": "z"}, "codex"),
        ({"claudeAiOauth": {"expiresAt": 1}}, "claude-code"),
        ({"refresh_token": "x", "expiry_date": 1, "scope": "s"}, "gemini-cli"),
    ],
)
def test_session_files(doc: dict[str, object], tool: str) -> None:
    det = detect(json.dumps(doc, indent=2))
    assert det.format == "session_file"
    assert det.session_tool == tool
    assert not det.storable


def test_unrelated_json() -> None:
    assert detect('{"hello": "world"}').format == "unknown"


# --- normalization ----------------------------------------------------------------------

KEY = "sk-ant-api03-" + "A" * 40


@pytest.mark.parametrize(
    "raw",
    [
        KEY,
        f"  {KEY}  \n",
        f'"{KEY}"',
        f"'{KEY}'",
        f"`{KEY}`",
        f"ANTHROPIC_API_KEY={KEY}",
        f'ANTHROPIC_API_KEY="{KEY}"',
        f"export ANTHROPIC_API_KEY='{KEY}'",
        f"Bearer {KEY}",
        f"Authorization: Bearer {KEY}",
        f"x-api-key: {KEY}",
        f"{KEY[:20]}\n{KEY[20:]}",  # wrapped line
        f'ANTHROPIC_API_KEY="Bearer {KEY}"',
        "﻿" + KEY,
    ],
)
def test_normalize(raw: str) -> None:
    assert normalize_secret(raw) == KEY
    assert detect(raw).pattern_id == "anthropic_api_key"


def test_normalize_keeps_json() -> None:
    doc = '{\n  "a": "b c"\n}'
    assert normalize_secret(f"  {doc}\n") == doc


# --- loader -----------------------------------------------------------------------------


def test_loader_rejects_bad_patterns() -> None:
    with pytest.raises(ValueError, match="exactly one"):
        parse_patterns('[[pattern]]\nid="a"\nprovider="xai"\nkind="api_key"\nlabel="x"\n')
    dup = '[[pattern]]\nid="a"\nprovider="xai"\nkind="api_key"\nlabel="x"\nprefix="a-"\n'
    with pytest.raises(ValueError, match="duplicate"):
        parse_patterns(dup + dup)


def test_longest_prefix_wins() -> None:
    order = [p.prefix for p in load_patterns() if p.prefix]
    assert order.index("sk-ant-api03-") < order.index("sk-")
    assert order.index("sk-or-v1-") < order.index("sk-")
