"""Demo mode (``mecha serve --demo``): fake data for screenshots, the README and tests.

Holds **no secrets**: credentials only have redacted forms and fabricated fingerprints, and
checks never touch the network. Deterministic (fixed seed and fixed "now"), covering every
traffic-light state and every credential kind.
"""

from __future__ import annotations

import hashlib
import random
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from mecha.core.config import Config
from mecha.core.errors import DetectionError, DuplicateCredentialError
from mecha.core.models import (
    Budget,
    CheckStatus,
    Credential,
    CredentialFacts,
    CredentialKind,
    Expiry,
    ExpiryState,
    ExposureSummary,
    Funds,
    FundsState,
    HttpTrace,
    Limits,
    LimitsState,
    Overall,
    ProviderError,
    ProviderId,
    RateWindow,
    Reason,
    Validity,
)
from mecha.core.service import CredentialStatus, MechaService
from mecha.core.status import Observation, evaluate
from mecha.core.ulid import new_ulid
from mecha.linked import Tool
from mecha.providers.base import Provider
from mecha.scan.model import Confidence, Finding, Location, PlaceKind, Risk, ScanReport
from mecha.scan.risk import inside
from mecha.scan.walk import Options as ScanOptions
from mecha.scan.walk import ScanCancelled
from mecha.store.db import Store, open_memory_store

DEMO_NOW = datetime(2026, 11, 4, 9, 30, tzinfo=UTC)
SEED = 20261104
HISTORY_POINTS = 12

P = ProviderId
K = CredentialKind


@dataclass(frozen=True)
class Scenario:
    label: str
    provider: ProviderId
    kind: CredentialKind
    redacted: str
    endpoint: str
    validity: Validity | None = Validity.valid
    status: int = 200
    failed: bool = False
    never_checked: bool = False
    funds: Funds | None = None
    limits: Limits | None = None
    notes: tuple[Reason, ...] = ()
    error: tuple[str, str] | None = None
    account: dict[str, str] = field(default_factory=dict)
    tags: tuple[str, ...] = ()
    manual_expires_days: float | None = None
    api_expires_days: float | None = None
    token_expires_days: float | None = None
    subscription_days: float | None = None
    retiring: bool = False
    linked_path: str | None = None
    facts: dict[str, Any] = field(default_factory=dict)  # phase 4 data shown in the demo
    budget: Budget | None = None


def _amber(code: str) -> Reason:
    return Reason(code=code, overall=Overall.amber)


def _red(code: str) -> Reason:
    return Reason(code=code, overall=Overall.red)


def _limits(remaining: int, limit: int = 4000) -> Limits:
    state = LimitsState.throttled if remaining == 0 else LimitsState.ok
    return Limits(
        state=state,
        requests=RateWindow(
            limit=limit, remaining=remaining, reset=DEMO_NOW + timedelta(seconds=40)
        ),
    )


def _fact(value: object, *, source: str = "api", scope: str | None = None) -> dict[str, object]:
    return {"value": value, "source": source, "observed_at": DEMO_NOW.isoformat(), "scope": scope}


# A team's prepaid balance, as an xAI management key reports it (shown on its keys too).
_TEAM_FUNDS: dict[str, Any] = {
    "funds": _fact({"state": "ok", "amount": "42.10", "currency": "USD"}, scope="team"),
    "account": {"prepaid_usd": _fact("42.10"), "postpaid_margin_usd": _fact("0.00")},
}


SCENARIOS: tuple[Scenario, ...] = (
    # --- green ---------------------------------------------------------------------
    Scenario(
        "Prod · chat backend",
        P.anthropic,
        K.api_key,
        "sk-ant-api03-Qm7…x2Pa",
        "GET /v1/models",
        limits=_limits(3987),
        account={"org_id": "org_demo_anthropic", "models": "9"},
        tags=("prod",),
    ),
    Scenario(
        "Embeddings worker",
        P.openai,
        K.api_key,
        "sk-proj-H4c…9LkQ",
        "GET /v1/models",
        limits=_limits(58, 60),
        account={"org_id": "org-demo", "models": "64"},
        tags=("prod",),
        api_expires_days=90,
        facts={"last_used_at": _fact((DEMO_NOW - timedelta(hours=2)).isoformat())},
    ),
    Scenario(
        "Org admin",
        P.openai,
        K.admin_key,
        "sk-admin-p0Z…T7ve",
        "GET /v1/organization/admin_api_keys",
        tags=("admin",),
        budget=Budget(
            amount=Decimal("100"), currency="USD", purchased_at=DEMO_NOW - timedelta(days=20)
        ),
        facts={
            "funds_info": _fact(
                {
                    "amount": "63.40",
                    "currency": "USD",
                    "until": (DEMO_NOW - timedelta(days=1)).isoformat(),
                },
                source="inferred",
                scope="organization",
            )
        },
    ),
    Scenario(
        "Grok team key",
        P.xai,
        K.api_key,
        "xai-Vb8…3nQs",
        "GET /v1/api-key",
        account={"team_id": "team-demo-0001", "key_name": "grok-prod"},
        tags=("prod",),
        facts=_TEAM_FUNDS,
    ),
    Scenario(
        "xAI management",
        P.xai,
        K.management_key,
        "xai-Jt2…k8Wd",
        "GET /auth/management-keys/validation",
        account={"team_id": "team-demo-0001"},
        tags=("admin",),
        facts=_TEAM_FUNDS,
    ),
    # --- amber ---------------------------------------------------------------------
    Scenario(
        "Legacy Gemini key",
        P.gemini,
        K.api_key,
        "AIzaSyD…Q0aM",
        "GET /v1beta/models",
        retiring=True,
        account={"models": "41"},
        tags=("legacy",),
    ),
    Scenario(
        "Demo day key",
        P.anthropic,
        K.api_key,
        "sk-ant-api03-Lr4…d9Hc",
        "GET /v1/models",
        manual_expires_days=5,
        limits=_limits(3999),
        tags=("class",),
    ),
    Scenario(
        "Batch jobs",
        P.openai,
        K.api_key,
        "sk-proj-Wq1…eZ3r",
        "GET /v1/models",
        validity=Validity.valid,
        status=429,
        limits=_limits(0, 60),
        error=("rate_limit_exceeded", "Rate limit reached for requests"),
        tags=("batch",),
    ),
    Scenario(
        "Interns project",
        P.openai,
        K.api_key,
        "sk-proj-Kc0…mN2b",
        "GET /v1/models",
        status=429,
        funds=Funds(state=FundsState.capped),
        error=("project_spend_limit_exceeded", "Your project reached its enforced spend limit."),
        tags=("class",),
    ),
    Scenario(
        "Server-only Gemini",
        P.gemini,
        K.api_key,
        "AQ.Ab8RN…f3Lz",
        "GET /v1beta/models",
        validity=None,
        status=403,
        notes=(_amber("gemini_ip_restricted"),),
        error=("PERMISSION_DENIED", "The provided API key has an IP address restriction."),
        tags=("prod",),
    ),
    # --- red -----------------------------------------------------------------------
    Scenario(
        "Old laptop key",
        P.openai,
        K.api_key,
        "sk-proj-Ds9…7Ygh",
        "GET /v1/models",
        validity=Validity.invalid,
        status=401,
        error=("invalid_api_key", "Incorrect API key provided."),
        tags=("legacy",),
    ),
    Scenario(
        "Side project",
        P.anthropic,
        K.api_key,
        "sk-ant-api03-Ze3…Ww0k",
        "GET /v1/models",
        status=402,
        funds=Funds(state=FundsState.empty),
        notes=(_red("billing_error"),),
        error=("billing_error", "There is an issue with your billing or payment information."),
    ),
    Scenario(
        "Shared hackathon",
        P.xai,
        K.api_key,
        "xai-Rt5…9pLa",
        "GET /v1/api-key",
        validity=Validity.blocked,
        notes=(_red("team_blocked"),),
        account={"team_id": "team-demo-0042"},
        tags=("class",),
    ),
    Scenario(
        "Leaked in a gist",
        P.gemini,
        K.api_key,
        "AQ.Ab8Rt…u1Xe",
        "GET /v1beta/models",
        validity=Validity.blocked,
        status=403,
        error=(
            "PERMISSION_DENIED",
            "Your API key was reported as leaked. Please use another API key.",
        ),
    ),
    Scenario(
        "Q3 contractor",
        P.openai,
        K.api_key,
        "sk-svcacct-Gm6…2Rqd",
        "GET /v1/models",
        validity=Validity.invalid,
        status=401,
        manual_expires_days=-3,
        error=("invalid_api_key", "Incorrect API key provided."),
    ),
    Scenario(
        "Prepaid Gemini",
        P.gemini,
        K.api_key,
        "AQ.Ab8Rx…c5Vn",
        "GET /v1beta/models",
        status=402,
        funds=Funds(state=FundsState.empty),
        error=("PAYMENT_REQUIRED", "Your Prepay credit balance is depleted."),
    ),
    # --- grey ----------------------------------------------------------------------
    Scenario(
        "Just added",
        P.anthropic,
        K.api_key,
        "sk-ant-api03-Nv8…a6Ft",
        "GET /v1/models",
        never_checked=True,
    ),
    Scenario(
        "Staging (offline)",
        P.xai,
        K.api_key,
        "xai-Pe4…h1Mx",
        "GET /v1/api-key",
        failed=True,
        error=("network", "timeout after 4 attempts"),
        tags=("staging",),
    ),
    # --- local only (OAuth: never sent anywhere) -----------------------------------
    Scenario(
        "Claude Max (token)",
        P.anthropic,
        K.oauth_token,
        "sk-ant-oat01-Hd2…Qz8c",
        "",
        token_expires_days=200,
    ),
    Scenario(
        "Codex CLI session",
        P.openai,
        K.oauth_file,
        "~/.codex/auth.json",
        "",
        subscription_days=24,
        linked_path="~/.codex/auth.json",
    ),
)


def _fingerprint(label: str) -> str:
    return hashlib.sha256(f"demo:{label}".encode()).hexdigest()[:12]


def _days(value: float | None) -> datetime | None:
    return DEMO_NOW + timedelta(days=value) if value is not None else None


def _observation(s: Scenario, at: datetime, latency: float, *, final: bool) -> Observation:
    trace = HttpTrace(endpoint=s.endpoint, status=s.status if final else 200, latency_ms=latency)
    if final and s.failed:
        return Observation(
            check_status=CheckStatus.failed,
            observed_at=at,
            http=HttpTrace(endpoint=s.endpoint, status=None, latency_ms=None),
            error=ProviderError(code=s.error[0], message=s.error[1]) if s.error else None,
        )
    if not final:  # earlier history: a healthy check
        return Observation(
            check_status=CheckStatus.ok,
            observed_at=at,
            validity=Validity.valid,
            http=trace,
            account=s.account,
        )
    api_expiry = _days(s.api_expires_days)
    return Observation(
        check_status=CheckStatus.ok,
        observed_at=at,
        validity=s.validity,
        funds=s.funds,
        expiry=Expiry(state=ExpiryState.scheduled, expires_at=api_expiry) if api_expiry else None,
        limits=s.limits,
        account=s.account,
        notes=list(s.notes),
        http=trace,
        error=ProviderError(code=s.error[0], message=s.error[1]) if s.error else None,
    )


def build_demo_store(scenarios: Iterable[Scenario] = SCENARIOS) -> Store:
    store = open_memory_store()
    rng = random.Random(SEED)  # noqa: S311 - fake latencies, not crypto
    for index, s in enumerate(scenarios):
        cred = Credential(
            id=f"01DEMO{index:020d}",
            label=s.label,
            provider=s.provider,
            kind=s.kind,
            pattern_id=None,
            redacted=s.redacted,
            fingerprint=_fingerprint(s.label),
            tags=list(s.tags),
            linked_path=s.linked_path,
            manual_expires_at=_days(s.manual_expires_days),
            created_at=DEMO_NOW - timedelta(days=60 - index),
            token_expires_at=_days(s.token_expires_days),
            subscription_until=_days(s.subscription_days),
            retiring=s.retiring,
            manual_budget=s.budget,
            facts=CredentialFacts.model_validate(s.facts),
        )
        exposures = demo_exposures(s.label)
        if exposures:
            risky = sum(1 for e in exposures if e["risks"])
            cred.facts.exposure = ExposureSummary(
                risky=risky, info=len(exposures) - risky, scanned_at=DEMO_NOW - timedelta(days=2)
            )
        store.insert(cred, None)  # no secret, ever
        if exposures:
            store.set_exposures(cred.id, exposures, DEMO_NOW - timedelta(days=2))
        if s.never_checked or cred.kind.is_oauth:
            continue
        for point in range(HISTORY_POINTS):
            at = DEMO_NOW - timedelta(hours=6 * (HISTORY_POINTS - 1 - point), minutes=index * 3)
            final = point == HISTORY_POINTS - 1
            obs = _observation(s, at, round(rng.uniform(120, 480), 1), final=final)
            store.add_result(evaluate(cred, obs, at), obs)
    return store


# --- the demo's scan: made-up files in a made-up home, never this machine's disk ---------
DEMO_HOME = Path("/home/demo")
DEMO_SCAN_FILES = 1843  # what the progress counts up to


@dataclass(frozen=True)
class DemoFound:
    where: str  # relative to DEMO_HOME
    line: int
    column: int
    provider: ProviderId | None
    kind: CredentialKind | None
    redacted: str
    name: str | None
    confidence: Confidence = Confidence.high
    risks: tuple[Risk, ...] = ()
    cell_line: int | None = None
    place: PlaceKind = PlaceKind.text
    session_file: str | None = None
    stored: str | None = None  # label of the demo credential this key is

    @property
    def path(self) -> Path:
        return DEMO_HOME / self.where

    @property
    def fingerprint(self) -> str:
        return _fingerprint(self.stored or f"found:{self.where}:{self.line}:{self.column}")

    def finding(self) -> Finding:
        return Finding(
            location=Location(self.path, self.line, self.column, self.cell_line, self.place),
            provider=self.provider.value if self.provider else None,
            kind=self.kind.value if self.kind else None,
            pattern_id=None,
            redacted=self.redacted,
            confidence=self.confidence,
            name=self.name,
            storable=self.session_file is None,
            session_file=self.session_file,
            risks=self.risks,
            fingerprint=self.fingerprint,
        )

    def exposure(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "line": self.line,
            "cell_line": self.cell_line,
            "column": self.column,
            "risks": [r.value for r in self.risks],
            "seen_at": (DEMO_NOW - timedelta(days=2)).isoformat(),
        }


DEMO_FOUND: tuple[DemoFound, ...] = (
    DemoFound("projects/chatbot/.env", 3, 16, P.openai, K.api_key, "sk-proj-Tg5…b8Xe",
              "OPENAI_API_KEY"),
    DemoFound(".zsh_history", 1042, 33, P.anthropic, K.api_key, "sk-ant-api03-Lr4…d9Hc",
              "ANTHROPIC_API_KEY", risks=(Risk.shell_history,), place=PlaceKind.history_zsh,
              stored="Demo day key"),
    DemoFound("projects/workshop/.env", 1, 19, P.anthropic, K.api_key, "sk-ant-api03-Lr4…d9Hc",
              "ANTHROPIC_API_KEY", stored="Demo day key"),
    DemoFound("notebooks/experiments.ipynb", 4, 22, P.gemini, K.api_key, "AIzaSyC…7rTk",
              "GEMINI_API_KEY", risks=(Risk.notebook, Risk.git_not_ignored), cell_line=2,
              place=PlaceKind.notebook),
    DemoFound("Dropbox/notes/keys.txt", 7, 1, P.xai, K.api_key, "xai-Hn6…2cVu", None,
              risks=(Risk.synced_folder,)),
    DemoFound("projects/landing/src/firebase.ts", 12, 11, P.gemini, K.api_key, "AIzaSyB…k4Ds",
              "apiKey", confidence=Confidence.low, risks=(Risk.git_tracked,)),
    DemoFound(".codex/auth.json", 5, 22, P.openai, K.oauth_token, "eyJhbGciOi…Qx1w", None,
              session_file="codex"),
)  # fmt: skip


def demo_exposures(label: str) -> list[dict[str, object]]:
    return [f.exposure() for f in DEMO_FOUND if f.stored == label]


def demo_report(
    roots: Iterable[Path],
    progress: Callable[[int, Path], None] | None = None,
    stop: Callable[[], bool] | None = None,
    seconds: float = 0.0,
) -> ScanReport:
    """The demo's scan of ``roots`` (the demo home by default): canned findings only."""
    wanted = list(roots) or [DEMO_HOME]
    found = [f for f in DEMO_FOUND if inside(f.path, wanted)]
    files = DEMO_SCAN_FILES if wanted == [DEMO_HOME] else len({f.path for f in found})
    steps = 20
    for step in range(1, steps + 1):
        if stop is not None and stop():
            raise ScanCancelled
        if seconds:
            time.sleep(seconds / steps)
        if progress is not None:
            progress(files * step // steps, DEMO_HOME)
    report = ScanReport(roots=wanted, findings=[f.finding() for f in found], files_scanned=files)
    report.read = {f.path for f in DEMO_FOUND if inside(f.path, wanted)}  # "read" them all
    report.skipped.excluded_dir = 214 if wanted == [DEMO_HOME] else 0
    report.skipped.binary = 96 if wanted == [DEMO_HOME] else 0
    return report


def _demo_not_importable(f: Finding) -> str | None:
    from mecha.core.service import _not_importable

    return _not_importable(f)


class DemoService(MechaService):
    """MechaService over the demo store: fixed clock, fabricated checks, no network."""

    def __init__(self, config: Config | None = None) -> None:
        store = build_demo_store()
        super().__init__(lambda: store, now=lambda: DEMO_NOW, config=config)
        self._scenarios = {f"01DEMO{i:020d}": s for i, s in enumerate(SCENARIOS)}

    # Adding works (it is what a demo video shows) but only the redacted form is kept: the
    # secret is never stored, not even in the in-memory store, and checks never use it.
    keep_secrets = False

    @staticmethod
    def _added_scenario(cred: Credential, provider: Provider) -> Scenario:
        """A credential added during the demo: a fabricated healthy check, no network."""
        _, path, _ = provider.endpoint(cred.kind)
        return Scenario(cred.label, cred.provider, cred.kind, cred.redacted, f"GET {path}")

    def link(
        self, tool: Tool, path: str | None = None, *, label: str | None = None
    ) -> CredentialStatus:
        # Linking would read real session files from this machine (email, plan) into a demo.
        raise DetectionError("Demo mode does not read session files from this machine.")

    # The scan never reads this machine's disk: someone recording a video of the demo
    # would show their own folders. It finds the same made-up files every time.
    scan_seconds = 1.5  # long enough to show the progress and the Stop button

    def scan_home(self) -> Path:
        return DEMO_HOME

    def scan_has_protected(self) -> bool:
        return True  # the demo's made-up home is a Mac's

    def read_files(
        self,
        options: ScanOptions,
        store: Store | None,
        env: object = None,
        progress: Callable[[int, Path], None] | None = None,
        stop: Callable[[], bool] | None = None,
        resume: object = None,  # the demo's canned scan never resumes
    ) -> ScanReport:
        return demo_report(options.roots, progress, stop, self.scan_seconds)

    # Importing works like the real one (rows with the same key are one credential, and
    # it keeps where it was found) but reads no file: only the redacted form is kept.
    def read_found(self, report: ScanReport, ids: Iterable[str], store: Store) -> dict[str, str]:
        by_id = {f.location.id: f for f in report.findings}
        out: dict[str, str] = {}
        for fid in ids:
            f = by_id.get(fid)
            reason = "not_found" if f is None else _demo_not_importable(f)
            out[fid] = f"!{reason}" if reason is not None else "demo"  # no secret, ever
        return out

    def _found_fingerprint(self, f: Finding, secret: str) -> str:
        return f.fingerprint or _fingerprint(f.location.id)

    def _import_one(self, f: Finding, secret: str, fingerprint: str) -> str:
        existing = self.store.by_fingerprint(fingerprint)
        if existing is not None:
            raise DuplicateCredentialError(f"Already stored as {existing}.", existing)
        cred = Credential(
            id=new_ulid(),
            label=f.name or f"{f.location.path.name}:{f.location.line}",
            provider=ProviderId(f.provider or ""),
            kind=CredentialKind(f.kind or "api_key"),
            pattern_id=None,
            redacted=f.redacted,
            fingerprint=fingerprint,
            created_at=self.now(),
        )
        self.store.insert(cred, None)
        return cred.id

    def is_fresh(self, cred: Credential, now: datetime) -> bool:
        return False  # every demo check "runs"

    async def _observe(
        self,
        cred: Credential,
        provider: Provider,
        *,
        active: bool = False,
        secret: str | None = None,  # unused: demo checks never use a secret
    ) -> Observation:
        scenario = self._scenarios.get(cred.id) or self._added_scenario(cred, provider)
        rng = random.Random(f"{SEED}:{cred.id}")  # noqa: S311
        return _observation(scenario, self.now(), round(rng.uniform(120, 480), 1), final=True)
