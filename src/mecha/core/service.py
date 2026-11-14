"""Service layer shared by the CLI (phase 1) and the REST API (phase 3).

Takes raw input, returns models. Never returns, logs or raises with a plaintext secret.
"""

from __future__ import annotations

import asyncio
import builtins
import logging
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from mecha.core.backup import BackupError
from mecha.core.config import Config
from mecha.core.detect import Detection, detect
from mecha.core.envimport import parse_env
from mecha.core.errors import (
    AmbiguousProviderError,
    DetectionError,
    DuplicateCredentialError,
    MechaError,
    NotFoundError,
)
from mecha.core.http import HttpSettings, make_client
from mecha.core.models import (
    Budget,
    CheckResult,
    CheckStatus,
    Credential,
    CredentialFacts,
    CredentialKind,
    ExposureSummary,
    Fact,
    Funds,
    FundsInfo,
    Limits,
    Overall,
    ProviderError,
    ProviderId,
    ReasonFact,
    Validity,
)
from mecha.core.normalize import normalize_secret
from mecha.core.status import Observation, Thresholds, evaluate
from mecha.core.ulid import new_ulid
from mecha.linked import (
    PROVIDER as LINKED_PROVIDER,
)
from mecha.linked import (
    TOOLS,
    LinkedFileError,
    LinkedInfo,
    Tool,
    default_path,
    read_linked,
)
from mecha.providers import get_provider
from mecha.providers.base import ChildRef, KeyUpdate, Provider, ProviderContext, remote_kinds
from mecha.scan.model import Confidence as ScanConfidence
from mecha.scan.model import Finding, ScanReport
from mecha.scan.places import Env as ScanEnv
from mecha.scan.walk import NotReadable, Scanner, read_token
from mecha.scan.walk import Options as ScanOptions
from mecha.store.db import Store

log = logging.getLogger(__name__)


MIN_UNKNOWN_LENGTH = 16
MIN_ID_PREFIX = 4
BACKOFF_FLOOR = timedelta(minutes=1)

_GROUP_ORDER = {
    Overall.red: 0,
    Overall.amber: 1,
    Overall.grey: 2,
    Overall.local: 3,
    Overall.green: 4,
}


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class LastKnown:
    overall: Overall
    checked_at: datetime


@dataclass(frozen=True)
class CredentialStatus:
    credential: Credential
    result: CheckResult
    last_known: LastKnown | None = None  # last non-grey result (shown on grey cards)
    cached: bool = False  # result reused because of the minimum interval
    # An active probe was asked for but the one-per-hour limit applies until this time.
    probe_next_at: datetime | None = None


ENRICHING_KINDS = frozenset({CredentialKind.admin_key, CredentialKind.management_key})
PROVIDER_OF = LINKED_PROVIDER


def linked_facts(facts: CredentialFacts, info: LinkedInfo, now: datetime) -> CredentialFacts:
    """Facts from a session file (source "file", unverified). With a refresh token the CLI
    renews the access token by itself, so its expiry is informational only."""
    out = facts.model_copy(deep=True)
    out.account.pop("file_error", None)

    def put(key: str, value: str | None) -> None:
        if value:
            out.account[key] = Fact[str](value=value, source="file", observed_at=now)
        else:
            out.account.pop(key, None)

    put("email", info.email)
    put("plan", info.plan)
    for key, value in info.extra.items():
        put(key, value)
    expiry = info.subscription_until
    if info.has_refresh_token:
        put(
            "access_token_expires_at",
            info.access_expires_at.isoformat() if info.access_expires_at else None,
        )
    elif info.access_expires_at and (expiry is None or info.access_expires_at < expiry):
        expiry = info.access_expires_at
    put("refresh_token", "present" if info.has_refresh_token else "absent")
    out.expires_at = (
        Fact[datetime | None](value=expiry, source="file", observed_at=now) if expiry else None
    )
    return out


def apply_update(
    facts: CredentialFacts, update: KeyUpdate, now: datetime, *, by: str | None
) -> CredentialFacts:
    """Merge what an API reported into the stored facts (each with source and date)."""
    out = facts.model_copy(deep=True)
    if update.status is not None:
        out.status = Fact[Validity](value=update.status, source="api", observed_at=now, by=by)
    elif out.status is not None and out.status.by == by:
        out.status = None  # the same reporter no longer flags it
    if update.expires_at is not None or update.never_expires:
        out.expires_at = Fact[datetime | None](
            value=update.expires_at, source="api", observed_at=now, by=by
        )
    if update.last_used_at is not None:
        out.last_used_at = Fact[datetime](
            value=update.last_used_at, source="api", observed_at=now, by=by
        )
    if update.funds is not None:
        out.funds = Fact[Funds](
            value=update.funds,
            source=update.funds_source,
            observed_at=now,
            by=by,
            scope=update.funds_scope,
        )
    if update.funds_info is not None:
        out.funds_info = Fact[FundsInfo](
            value=update.funds_info, source="inferred", observed_at=now, by=by, scope="organization"
        )
    for key, value in update.account.items():
        out.account[key] = Fact[str](value=value, source="api", observed_at=now, by=by)
    # Warnings from this reporter are replaced as a whole on every enrichment.
    out.reasons = [r for r in out.reasons if r.by != by] + [
        ReasonFact(code=code, overall=Overall.amber, observed_at=now, by=by)
        for code in update.warnings
    ]
    return out


def _remap_reporters(facts: CredentialFacts, id_map: dict[str, str]) -> CredentialFacts:
    """Point facts reported by an admin key at that key's id in the destination store."""
    out = facts.model_copy(deep=True)
    for name in ("status", "expires_at", "last_used_at", "funds", "funds_info"):
        fact = getattr(out, name)
        if fact is not None and fact.by is not None:
            fact.by = id_map.get(fact.by, fact.by)
    for fact in out.account.values():
        if fact.by is not None:
            fact.by = id_map.get(fact.by, fact.by)
    for reason in out.reasons:
        if reason.by is not None:
            reason.by = id_map.get(reason.by, reason.by)
    return out


def _not_importable(f: Finding) -> str | None:
    """Why a finding cannot be imported (None: it can)."""
    if f.stored_id is not None:
        return "duplicate"
    if f.session_file is not None:
        return "session_file"  # link the file instead: `mecha link`
    if not f.storable:
        return "not_storable"  # e.g. an OAuth refresh token
    if f.confidence is not ScanConfidence.high:
        return "low_confidence"  # unknown provider: add it by hand if it is an AI key
    return None


def _exposure(f: Finding, seen_at: datetime) -> dict[str, object]:
    return {
        "path": str(f.location.path),
        "line": f.location.line,
        "cell_line": f.location.cell_line,
        "column": f.location.column,
        "risks": [r.value for r in f.risks],
        "seen_at": seen_at.isoformat(),
    }


def finding_json(f: Finding) -> dict[str, Any]:
    """A finding for the CLI's --json and the API: where and what, never the key or line."""
    reason = _not_importable(f)
    return {
        "id": f.location.id,
        "path": str(f.location.path),
        "line": f.location.line,
        "cell_line": f.location.cell_line,
        "column": f.location.column,
        "provider": f.provider,
        "kind": f.kind,
        "redacted": f.redacted,
        "name": f.name,
        "confidence": f.confidence.value,
        "severity": "amber" if f.amber else "info",
        "risks": [r.value for r in f.risks],
        "notes": list(f.notes),
        "stored_id": f.stored_id,
        "session_file": f.session_file,
        "importable": reason is None,
        "not_importable": reason,
        "check": f.check,
    }


def forget_reporter(facts: CredentialFacts, reporter: str) -> CredentialFacts:
    """Drop every fact a deleted admin/management key had reported about this credential."""
    out = facts.model_copy(deep=True)
    for name in ("status", "expires_at", "last_used_at", "funds", "funds_info"):
        fact = getattr(out, name)
        if fact is not None and fact.by == reporter:
            setattr(out, name, None)
    out.account = {k: f for k, f in out.account.items() if f.by != reporter}
    out.reasons = [r for r in out.reasons if r.by != reporter]
    return out


def _clean_tags(tags: Iterable[str]) -> list[str]:
    out: list[str] = []
    for tag in tags:
        t = tag.strip()
        if t and t not in out:
            out.append(t)
    return out


class MechaService:
    def __init__(
        self,
        open_store: Callable[[], Store],
        *,
        now: Callable[[], datetime] = _utcnow,
        config: Config | None = None,
        thresholds: Thresholds | None = None,
    ) -> None:
        self._open_store = open_store
        self._store: Store | None = None
        self._now = now
        self.config = config or Config()
        cfg_th = self.config.thresholds
        self.thresholds = thresholds or Thresholds(
            soon_days=cfg_th.soon_days, low_funds_usd=cfg_th.low_funds_usd
        )
        self._global = asyncio.Semaphore(self.config.scheduler.concurrency)
        self._per_provider: dict[ProviderId, asyncio.Semaphore] = {}

    # Demo mode keeps only the redacted form: the secret is never stored, even in memory.
    keep_secrets = True

    def now(self) -> datetime:
        return self._now()

    @property
    def store(self) -> Store:
        if self._store is None:
            self._store = self._open_store()
        return self._store

    def close(self) -> None:
        if self._store is not None:
            self._store.close()
            self._store = None

    # --- detect -------------------------------------------------------------------
    @staticmethod
    def detect(raw: str) -> Detection:
        """Offline classification; does not open the store."""
        return detect(raw)

    # --- add ----------------------------------------------------------------------
    def add(
        self,
        raw: str,
        *,
        label: str | None = None,
        tags: Iterable[str] = (),
        notes: str | None = None,
        provider: ProviderId | None = None,
        kind: CredentialKind | None = None,
        manual_expires_at: datetime | None = None,
    ) -> CredentialStatus:
        secret = normalize_secret(raw)
        det = detect(secret)
        resolved_provider, resolved_kind = self._resolve(det, secret, provider, kind)

        fingerprint = self.store.cipher.fingerprint(secret)
        existing = self.store.by_fingerprint(fingerprint)
        if existing is not None:
            raise DuplicateCredentialError(
                f"This credential is already stored as {existing}.", existing
            )

        jwt = det.jwt
        if manual_expires_at is not None and manual_expires_at.tzinfo is None:
            manual_expires_at = manual_expires_at.replace(tzinfo=UTC)
        cred = Credential(
            id=new_ulid(),
            label=(label or "").strip() or det.label or f"{resolved_provider.value} key",
            provider=resolved_provider,
            kind=resolved_kind,
            pattern_id=det.pattern_id,
            redacted=det.redacted,
            fingerprint=fingerprint,
            tags=_clean_tags(tags),
            notes=notes.strip() if notes and notes.strip() else None,
            manual_expires_at=manual_expires_at,
            created_at=self._now(),
            token_expires_at=jwt.expires_at if jwt else None,
            subscription_until=jwt.subscription_until if jwt else None,
            retiring=det.retiring,
        )
        self.store.insert(cred, secret if self.keep_secrets else None)
        return self._status(cred)

    @staticmethod
    def _resolve(
        det: Detection,
        secret: str,
        provider: ProviderId | None,
        kind: CredentialKind | None,
    ) -> tuple[ProviderId, CredentialKind]:
        if det.format == "session_file":
            raise DetectionError(
                f"This looks like a {det.session_tool} session file. Session files are linked "
                f"by path (`mecha link {det.session_tool}`); their tokens are never copied."
            )
        if det.format != "unknown" and not det.storable:
            raise DetectionError(
                "This looks like an OAuth refresh token. Mecha never stores refresh tokens."
            )
        if kind is CredentialKind.oauth_file:
            raise DetectionError("Session files are linked by path, not added as secrets.")

        if det.format == "unknown":
            if len(secret) < MIN_UNKNOWN_LENGTH or any(c.isspace() for c in secret):
                raise DetectionError("This does not look like a credential.")
            if provider is None:
                raise DetectionError(
                    "Unknown credential format. Pass --provider (and --kind if it is not a "
                    "plain API key, e.g. --kind management_key for xAI management keys)."
                )
            return provider, kind or CredentialKind.api_key

        if det.ambiguous:
            if provider is None:
                raise AmbiguousProviderError(
                    "The provider of this key is ambiguous; confirm it with --provider.",
                    [c.value for c in det.candidates],
                )
            resolved_provider = provider
        elif det.provider is None:  # JWT with unknown issuer
            if provider is None:
                raise DetectionError("Unknown token issuer; pass --provider.")
            resolved_provider = provider
        else:
            if provider is not None and provider != det.provider:
                raise DetectionError(
                    f"This credential looks like {det.provider.value}, not {provider.value}."
                )
            resolved_provider = det.provider

        detected_kind = det.kind or CredentialKind.api_key
        if kind is None or kind == detected_kind:
            return resolved_provider, detected_kind
        if (
            resolved_provider is ProviderId.xai
            and detected_kind is CredentialKind.api_key
            and kind is CredentialKind.management_key
        ):
            return resolved_provider, kind
        raise DetectionError(f"This credential is a {detected_kind.value}, not a {kind.value}.")

    # --- list / get / remove --------------------------------------------------------
    def _status(self, cred: Credential, *, cached: bool = False) -> CredentialStatus:
        obs = self.store.last_observation(cred.id)
        result = evaluate(cred, obs, self._now(), self.thresholds)
        known = self.store.last_known(cred.id)
        last_known = LastKnown(*known) if known else None
        return CredentialStatus(cred, result, last_known, cached)

    @staticmethod
    def _sorted(items: list[CredentialStatus]) -> list[CredentialStatus]:
        far = datetime.max.replace(tzinfo=UTC)

        def key(item: CredentialStatus) -> tuple[int, datetime, str]:
            expires = item.result.expiry.value.expires_at or far
            return (_GROUP_ORDER[item.result.overall], expires, item.credential.label.lower())

        return sorted(items, key=key)

    def list(self) -> list[CredentialStatus]:
        return self._sorted([self._status(c) for c in self.store.all()])

    # --- check ----------------------------------------------------------------------
    def _settings(self) -> HttpSettings:
        h = self.config.http
        return HttpSettings(h.timeout_seconds, h.retries, h.backoff_seconds)

    def _semaphore(self, provider: ProviderId) -> asyncio.Semaphore:
        if provider not in self._per_provider:
            self._per_provider[provider] = asyncio.Semaphore(self.config.scheduler.per_provider)
        return self._per_provider[provider]

    def is_remote(self, cred: Credential) -> bool:
        return cred.kind in remote_kinds() and get_provider(cred.provider) is not None

    def is_fresh(self, cred: Credential, now: datetime) -> bool:
        """A successful observation younger than the minimum interval (failures never count)."""
        obs = self.store.last_observation(cred.id)
        window = timedelta(minutes=self.config.scheduler.min_interval_minutes)
        return (
            obs is not None
            and obs.check_status is CheckStatus.ok
            and now - obs.observed_at < window
        )

    def retry_delay(self, failures: int) -> timedelta:
        """Backoff after ``failures`` failed checks in a row: min_interval, 2x, 4x… capped
        at interval_hours. Without failures, the regular interval."""
        sched = self.config.scheduler
        interval = timedelta(hours=sched.interval_hours)
        if failures <= 0:
            return interval
        # Floor of 1 minute: min_interval_minutes may be 0 (no caching), which must not
        # turn a failure into a retry on every scheduler tick.
        base = max(timedelta(minutes=sched.min_interval_minutes), BACKOFF_FLOOR)
        delay: timedelta = base * (2 ** min(failures - 1, 30))
        return min(delay, interval)

    def next_due(self, cred: Credential) -> datetime | None:
        """When the scheduler should check ``cred`` next (None: now)."""
        if cred.kind is CredentialKind.oauth_file:
            read = cred.facts.account.get("refresh_token") or cred.facts.account.get("file_error")
            return read.observed_at + self.retry_delay(0) if read else None
        obs = self.store.last_observation(cred.id)
        if obs is None:
            return None
        failures = (
            self.store.failure_streak(cred.id) if obs.check_status is not CheckStatus.ok else 0
        )
        return obs.observed_at + self.retry_delay(failures)

    def probe_next_at(self, cred: Credential) -> datetime | None:
        """When the next active probe is allowed (None: now)."""
        last = cred.facts.last_probe_at
        if last is None:
            return None
        nxt = last + timedelta(minutes=self.config.probes.min_interval_minutes)
        return nxt if nxt > self._now() else None

    def can_probe(self, cred: Credential) -> bool:
        return cred.kind is CredentialKind.api_key and self.is_remote(cred)

    async def _observe(
        self,
        cred: Credential,
        provider: Provider,
        *,
        active: bool = False,
        secret: str | None = None,
    ) -> Observation:
        now = self._now()
        probes = self.config.probes
        ctx = ProviderContext(
            now=now,
            http=self._settings(),
            anthropic_version=self.config.providers.anthropic.version,
            probe_model=getattr(probes, f"{cred.provider.value}_model", "auto"),
            cached_probe_model=cred.facts.probe_model,
            probe_free=probes.free,
        )
        if secret is None:
            secret = self.store.secret(cred.id)
        if secret is None:  # pragma: no cover - only linked files have no secret (phase 4)
            return Observation(check_status=CheckStatus.failed, observed_at=now)
        try:
            async with (
                self._global,
                self._semaphore(cred.provider),
                make_client(provider.routes(cred.kind), self._settings()) as http,
            ):
                if active:
                    return await provider.check_active(cred, secret, http, ctx)
                return await provider.check_passive(cred, secret, http, ctx)
        except Exception as exc:  # a plugin bug must not take the whole batch down
            log.warning("provider %s failed: %s", cred.provider.value, type(exc).__name__)
            log.debug("provider failure", exc_info=True)
            return Observation(
                check_status=CheckStatus.failed,
                observed_at=now,
                error=ProviderError(code="internal", message=type(exc).__name__),
            )
        finally:
            del secret

    def _save_probe_facts(self, cred: Credential, obs: Observation) -> Credential:
        """What a probe learned outlives later passive checks (which know nothing of funds)."""
        facts = cred.facts.model_copy(deep=True)
        facts.last_probe_at = obs.observed_at  # attempted: counts towards the hourly limit
        # A missing model is forgotten so "auto" picks a new one next time.
        facts.probe_model = None if obs.failure == "probe_misconfigured" else obs.probe_model
        if obs.check_status is CheckStatus.ok:
            if obs.funds is not None:
                facts.funds = Fact[Funds](
                    value=obs.funds, source="api", observed_at=obs.observed_at
                )
            if obs.limits is not None:
                facts.limits = Fact[Limits](
                    value=obs.limits, source="header", observed_at=obs.observed_at
                )
        self.store.set_facts(cred.id, facts)
        return cred.model_copy(update={"facts": facts})

    def _save_reported_facts(self, cred: Credential, obs: Observation) -> Credential:
        """Expiry or funds that a key's own check reported (e.g. OpenRouter) are kept as
        facts, so a later failed check does not lose them."""
        facts = cred.facts.model_copy(deep=True)
        if obs.expiry is not None:
            never = obs.expiry.state.value == "none"
            if obs.expiry.expires_at is not None or never:
                facts.expires_at = Fact[datetime | None](
                    value=obs.expiry.expires_at, source="api", observed_at=obs.observed_at
                )
        if obs.funds is not None:
            facts.funds = Fact[Funds](value=obs.funds, source="api", observed_at=obs.observed_at)
        self.store.set_facts(cred.id, facts)
        return cred.model_copy(update={"facts": facts})

    async def _check_one(
        self,
        cred: Credential,
        force: bool,
        *,
        active: bool = False,
        force_probe: bool = False,
        scheduled: bool = False,
    ) -> CredentialStatus:
        if cred.kind is CredentialKind.oauth_file:
            return self._status(self._refresh_linked(cred))  # re-read, never a remote call
        provider = get_provider(cred.provider)
        if provider is None or not self.is_remote(cred):
            return self._status(cred)  # OAuth: offline only, never a remote call
        wants_probe = self.can_probe(cred) and (active or (scheduled and cred.active_probe))
        next_probe = self.probe_next_at(cred)
        # The scheduler never skips the hourly limit; a person may, explicitly (--force).
        probe = wants_probe and (next_probe is None or (force_probe and not scheduled))
        if wants_probe and not probe and not scheduled:
            status = self._status(cred)
            return CredentialStatus(
                status.credential, status.result, status.last_known, False, next_probe
            )
        if not probe and not force and self.is_fresh(cred, self._now()):
            return self._status(cred, cached=True)
        obs = await self._observe(cred, provider, active=probe)
        if probe:
            cred = self._save_probe_facts(cred, obs)
        elif obs.check_status is CheckStatus.ok and (
            obs.expiry is not None or obs.funds is not None
        ):
            cred = self._save_reported_facts(cred, obs)
        if cred.kind in ENRICHING_KINDS and obs.check_status is CheckStatus.ok:
            cred = await self._enrich(cred, provider) or cred
        result = evaluate(cred, obs, self._now(), self.thresholds)
        self.store.add_result(result, obs)
        return self._status(cred)

    # --- enrichment -----------------------------------------------------------------
    async def _enrich(self, admin: Credential, provider: Provider) -> Credential | None:
        """Let an admin/management key describe the stored keys of its provider. Child
        secrets are decrypted in memory only to match hints; nothing else leaves."""
        secret = self.store.secret(admin.id)
        if secret is None:
            return None
        children = []
        for cred in self.store.all():
            if cred.provider is not admin.provider or cred.kind is not CredentialKind.api_key:
                continue
            obs = self.store.last_observation(cred.id)
            account = dict(obs.account) if obs and obs.check_status is CheckStatus.ok else {}
            account.update({k: f.value for k, f in cred.facts.account.items()})
            children.append(ChildRef(cred, self.store.secret(cred.id), account))
        ctx = ProviderContext(
            now=self._now(),
            http=self._settings(),
            anthropic_version=self.config.providers.anthropic.version,
            low_funds_usd=self.config.thresholds.low_funds_usd,
        )
        try:
            async with (
                self._global,
                self._semaphore(admin.provider),
                make_client(provider.routes(admin.kind), self._settings()) as http,
            ):
                enrichment = await provider.enrich(admin, secret, children, http, ctx)
        except Exception as exc:  # a plugin bug must not break the admin key's own check
            log.warning("enrichment by %s failed: %s", admin.provider.value, type(exc).__name__)
            log.debug("enrichment failure", exc_info=True)
            return None
        finally:
            del secret, children
        if enrichment.error is not None:
            log.info("enrichment partial: %s", enrichment.error.code)
        if enrichment.ambiguous:
            log.info("%d hint(s) matched several stored keys: not enriched", enrichment.ambiguous)
        now = self._now()
        for cid, update in enrichment.children.items():
            child = self.store.get(cid)
            if child is not None:
                self.store.set_facts(cid, apply_update(child.facts, update, now, by=admin.id))
                self.store.set_parent(cid, admin.id)
        facts = apply_update(admin.facts, enrichment.own, now, by=None)
        self.store.set_facts(admin.id, facts)
        return admin.model_copy(update={"facts": facts})

    async def check(
        self,
        ids: Sequence[str] = (),
        *,
        force: bool = False,
        active: bool = False,
        force_probe: bool = False,
        scheduled: bool = False,
        on_result: Callable[[CredentialStatus, int, int], None] | None = None,
    ) -> builtins.list[CredentialStatus]:
        """Passive check of ``ids`` (all credentials if empty), respecting concurrency.

        ``on_result(item, done, total)`` is called as each credential finishes.
        """
        creds = [self.get(i).credential for i in ids] if ids else self.store.all()
        total, done = len(creds), 0

        async def one(cred: Credential) -> CredentialStatus:
            nonlocal done
            item = await self._check_one(
                cred, force, active=active, force_probe=force_probe, scheduled=scheduled
            )
            done += 1
            if on_result is not None:
                on_result(item, done, total)
            return item

        items = await asyncio.gather(*(one(c) for c in creds))
        return self._sorted(list(items))

    def check_sync(
        self,
        ids: Sequence[str] = (),
        *,
        force: bool = False,
        active: bool = False,
        force_probe: bool = False,
    ) -> builtins.list[CredentialStatus]:
        return asyncio.run(self.check(ids, force=force, active=active, force_probe=force_probe))

    def resolve_id(self, id_or_prefix: str) -> str:
        value = id_or_prefix.strip().upper()
        if self.store.get(value) is not None:
            return value
        if len(value) < MIN_ID_PREFIX:
            raise NotFoundError(f"No credential {id_or_prefix!r} (use at least 4 characters).")
        matches = self.store.find_ids(value)
        if not matches:
            raise NotFoundError(f"No credential matches {id_or_prefix!r}.")
        if len(matches) > 1:
            raise NotFoundError(
                f"{id_or_prefix!r} matches {len(matches)} credentials; be more specific."
            )
        return matches[0]

    def get(self, id_or_prefix: str) -> CredentialStatus:
        cred = self.store.get(self.resolve_id(id_or_prefix))
        if cred is None:  # pragma: no cover - resolve_id guarantees existence
            raise NotFoundError(f"No credential {id_or_prefix!r}.")
        return self._status(cred)

    def update(
        self,
        id_or_prefix: str,
        *,
        label: str | None = None,
        tags: Iterable[str] | None = None,
        notes: str | None = None,
        manual_expires_at: datetime | None = None,
        active_probe: bool | None = None,
        manual_budget: Budget | None = None,
        clear: Iterable[str] = (),
    ) -> CredentialStatus:
        """Edit non-secret fields. ``clear`` names fields to reset (notes, manual_expires_at,
        manual_budget)."""
        cred_id = self.resolve_id(id_or_prefix)
        changes: dict[str, object] = {}
        if active_probe is not None:
            cred = self.store.get(cred_id)
            if active_probe and (cred is None or not self.can_probe(cred)):
                raise DetectionError("Active probes are only available for API keys.")
            changes["active_probe"] = active_probe
        if manual_budget is not None:
            changes["manual_budget"] = manual_budget
        if label is not None:
            if not label.strip():
                raise DetectionError("The label cannot be empty.")
            changes["label"] = label.strip()
        if tags is not None:
            changes["tags"] = _clean_tags(tags)
        if notes is not None:
            changes["notes"] = notes.strip() or None
        if manual_expires_at is not None:
            if manual_expires_at.tzinfo is None:
                manual_expires_at = manual_expires_at.replace(tzinfo=UTC)
            changes["manual_expires_at"] = manual_expires_at
        for field_name in clear:
            if field_name not in ("notes", "manual_expires_at", "manual_budget"):
                raise DetectionError(f"{field_name} cannot be cleared.")
            changes[field_name] = None
        self.store.update(cred_id, changes)
        return self.get(cred_id)

    # --- .env import ------------------------------------------------------------------
    def preview_env(self, content: str) -> builtins.list[dict[str, object]]:
        """What a .env would import, redacted. Nothing is stored."""
        out: builtins.list[dict[str, object]] = []
        for e in parse_env(content):
            det = e.detection
            existing = self.store.by_fingerprint(self.store.cipher.fingerprint(e.secret))
            importable = existing is None and (det.format == "unknown" or det.storable)
            out.append(
                {
                    "index": e.index,
                    "line": e.line,
                    "name": e.name,
                    "redacted": det.redacted,
                    "provider": det.provider.value if det.provider else None,
                    "kind": det.kind.value if det.kind else None,
                    "label": det.label,
                    "verified": det.verified,
                    "ambiguous": det.ambiguous or det.provider is None,
                    "warnings": det.warnings,
                    "duplicate_of": existing,
                    "importable": importable,
                }
            )
        return out

    def import_env(
        self,
        content: str,
        select: Iterable[int],
        providers: dict[int, ProviderId] | None = None,
    ) -> builtins.list[dict[str, object]]:
        """Import the chosen entries; each result says what happened, never the secret."""
        entries = {e.index: e for e in parse_env(content)}
        providers = providers or {}
        results: builtins.list[dict[str, object]] = []
        for index in select:
            entry = entries.get(index)
            if entry is None:
                results.append({"index": index, "ok": False, "code": "not_found"})
                continue
            try:
                item = self.add(entry.secret, label=entry.name, provider=providers.get(index))
            except MechaError as exc:
                results.append(
                    {"index": index, "ok": False, "code": exc.code, "message": exc.message}
                )
            else:
                results.append({"index": index, "ok": True, "id": item.credential.id})
        return results

    # --- mecha scan ---------------------------------------------------------------------
    def scan(
        self,
        options: ScanOptions,
        env: ScanEnv | None = None,
        progress: Callable[[int, Path], None] | None = None,
        *,
        use_store: bool = True,
        stop: Callable[[], bool] | None = None,
    ) -> ScanReport:
        """Find plaintext keys (offline). Locations of keys Mecha manages are kept encrypted;
        the rest only appear in the returned report. With a locked store the scan still
        runs, without the cross-reference, and says so."""
        store = self.scan_store(use_store)
        report = self.read_files(options, store, env, progress, stop)
        return self.cross_reference(report, store, use_store=use_store)

    # The scan in three steps, so the server can read files in a worker thread while every
    # SQLite access stays on the event loop's thread (the connection is never shared).
    scan_env: ScanEnv | None = None  # the machine scanned (tests inject a temporary home)

    def scan_home(self) -> Path:
        """The home folder a scan covers by default (the UI shows paths under it as ~)."""
        return (self.scan_env or ScanEnv.current()).home

    def scan_has_protected(self) -> bool:
        """Whether this system has folders that need --include-protected (macOS)."""
        return (self.scan_env or ScanEnv.current()).platform == "darwin"

    def scan_store(self, use_store: bool = True) -> Store | None:
        """The store to compare with, if it can be opened (never created just to scan)."""
        if not use_store:
            return None
        try:
            return self.store
        except MechaError:
            return None

    def read_files(
        self,
        options: ScanOptions,
        store: Store | None,
        env: ScanEnv | None = None,
        progress: Callable[[int, Path], None] | None = None,
        stop: Callable[[], bool] | None = None,
    ) -> ScanReport:
        """Read the files and report what is found. Safe in another thread: from the store
        it only uses the fingerprint key (an HMAC in memory), never the database."""
        fingerprint = store.cipher.fingerprint if store is not None else (lambda _s: None)
        env = env or self.scan_env or ScanEnv.current()
        return Scanner(env, options, fingerprint, progress, stop).run()

    def cross_reference(
        self, report: ScanReport, store: Store | None, *, use_store: bool = True
    ) -> ScanReport:
        """Match findings with stored keys (by fingerprint) and save their locations."""
        report.scanned_at = self._now()
        if store is None:
            report.warnings.append("store_locked" if use_store else "no_store")
            report.forget_paths()
            return report
        report.store_checked = True
        stored: dict[str, str | None] = {}
        out = []
        for f in report.findings:
            if f.fingerprint is not None and f.fingerprint not in stored:
                stored[f.fingerprint] = store.by_fingerprint(f.fingerprint)
            out.append(replace(f, stored_id=stored.get(f.fingerprint or "")))
        report.findings = out
        self._save_exposures(store, report)
        report.forget_paths()
        return report

    def exposure_paths(self, id_or_prefix: str) -> builtins.list[Path]:
        """The files a stored key was found in: what "scan these files again" reads."""
        paths = {Path(str(item["path"])) for item in self.exposures(id_or_prefix)}
        return sorted(paths)

    def rescan_exposures(
        self, id_or_prefix: str, env: ScanEnv | None = None
    ) -> builtins.list[dict[str, object]]:
        """Scan again only the files where this key was found (all in this thread)."""
        cred = self.get(id_or_prefix).credential
        paths = self.exposure_paths(cred.id)
        if paths:
            store = self.store
            report = self.read_files(ScanOptions(roots=paths), store, env)
            self.cross_reference(report, store)
        return self.exposures(cred.id)

    def _save_exposures(self, store: Store, report: ScanReport) -> None:
        """Per stored key: replace its locations in the files this scan read; keep those it
        skipped or never reached; drop those whose file is gone (`ScanReport.keeps`)."""
        now = report.scanned_at or self._now()
        found: dict[str, list[dict[str, object]]] = {}
        for f in report.findings:
            if f.stored_id is not None:
                found.setdefault(f.stored_id, []).append(_exposure(f, now))
        for cred_id in set(found) | set(store.exposure_ids()):
            kept = [
                item for item in store.exposures(cred_id) if report.keeps(Path(str(item["path"])))
            ]
            self._set_exposures(store, cred_id, kept + found.get(cred_id, []), now)

    def _set_exposures(
        self, store: Store, cred_id: str, items: builtins.list[dict[str, object]], now: datetime
    ) -> None:
        cred = store.get(cred_id)
        if cred is None:
            return
        store.set_exposures(cred_id, items, now)
        facts = cred.facts.model_copy(deep=True)
        risky = sum(1 for item in items if item["risks"])
        facts.exposure = (
            ExposureSummary(risky=risky, info=len(items) - risky, scanned_at=now) if items else None
        )
        store.set_facts(cred_id, facts)

    def exposures(self, id_or_prefix: str) -> builtins.list[dict[str, object]]:
        """Where a stored key was found in plaintext (decrypted on demand)."""
        cred = self.get(id_or_prefix).credential
        return self.store.exposures(cred.id)

    def import_found(
        self, report: ScanReport, ids: Iterable[str]
    ) -> builtins.list[dict[str, object]]:
        """Import chosen findings (the CLI: all in this thread)."""
        wanted = builtins.list(ids)
        return self.add_found(report, wanted, self.read_found(report, wanted, self.store))

    def read_found(self, report: ScanReport, ids: Iterable[str], store: Store) -> dict[str, str]:
        """Read the chosen keys again from their files, with the scan's checks (regular,
        not cloud-only, size). Safe in a worker thread: only files and the HMAC key. Each
        id maps to its secret, or to "!<code>" if it cannot be imported."""
        by_id = {f.location.id: f for f in report.findings}
        out: dict[str, str] = {}
        for fid in ids:
            f = by_id.get(fid)
            reason = "not_found" if f is None else _not_importable(f)
            if f is None or reason is not None:
                out[fid] = f"!{reason}"
                continue
            try:
                secret = read_token(f.location, report.max_size, report.max_notebook)
            except NotReadable:
                out[fid] = "!not_readable"
                continue
            except OSError:
                out[fid] = "!not_readable"
                continue
            if secret is None or (
                f.fingerprint is not None and store.cipher.fingerprint(secret) != f.fingerprint
            ):
                out[fid] = "!changed"
                continue
            out[fid] = secret
        return out

    def add_found(
        self, report: ScanReport, ids: Iterable[str], secrets: dict[str, str]
    ) -> builtins.list[dict[str, object]]:
        """Add what `read_found` read (on the event loop: SQLite). Rows of one batch with
        the same key are one credential: all ok, same id. Every row of the report with that
        key turns "already in Mecha", and all of them become its stored locations."""
        by_id = {f.location.id: f for f in report.findings}
        results: builtins.list[dict[str, object]] = []
        added: dict[str, str] = {}  # fingerprint -> credential id, in this batch
        rows: dict[str, set[str]] = {}  # credential id -> chosen finding ids
        try:
            for fid in ids:
                value = secrets.get(fid, "!not_found")
                f = by_id.get(fid)
                if value.startswith("!") or f is None:
                    results.append({"id": fid, "ok": False, "code": value[1:] or "not_found"})
                    continue
                fingerprint = self._found_fingerprint(f, value)
                cid = added.get(fingerprint)
                if cid is None:
                    try:
                        cid = self._import_one(f, value, fingerprint)
                    except MechaError as exc:
                        results.append(
                            {"id": fid, "ok": False, "code": exc.code, "message": exc.message}
                        )
                        continue
                    added[fingerprint] = cid
                rows.setdefault(cid, set()).add(fid)
                results.append({"id": fid, "ok": True, "credential_id": cid})
        finally:
            secrets.clear()
        if added:
            self._link_found(report, added, rows)
        return results

    def _found_fingerprint(self, f: Finding, secret: str) -> str:
        return f.fingerprint or self.store.cipher.fingerprint(secret)

    def _import_one(self, f: Finding, secret: str, fingerprint: str) -> str:
        label = f.name or f"{f.location.path.name}:{f.location.line}"
        return self.add(secret, label=label).credential.id

    def _link_found(
        self, report: ScanReport, added: dict[str, str], rows: dict[str, set[str]]
    ) -> None:
        """New credentials: mark their rows in the report and store where they were found."""
        now = report.scanned_at or self._now()
        by_fp = {fp: cid for fp, cid in added.items()}
        out = []
        locations: dict[str, builtins.list[dict[str, object]]] = {}
        for f in report.findings:
            cid = by_fp.get(f.fingerprint or "")
            if cid is None:
                cid = next((c for c, ids in rows.items() if f.location.id in ids), None)
            if cid is not None:
                f = replace(f, stored_id=cid)
                locations.setdefault(cid, []).append(_exposure(f, now))
            out.append(f)
        report.findings = out
        for cid, items in locations.items():
            self._set_exposures(self.store, cid, items, now)

    @staticmethod
    def check_candidates(report: ScanReport) -> builtins.list[Finding]:
        """What --check would send: high confidence, not in Mecha, one per distinct key."""
        seen: set[str] = set()
        out = []
        for f in report.findings:
            if f.confidence is not ScanConfidence.high or f.stored_id or not f.provider:
                continue
            if f.session_file or f.kind not in {"api_key", "admin_key", "management_key"}:
                continue
            key = f.fingerprint or f.location.id
            if key in seen:
                continue
            seen.add(key)
            out.append(f)
        return out

    async def check_found(self, report: ScanReport) -> ScanReport:
        """Validate found keys against their own provider's free endpoint (never a paid
        probe), without storing anything. Invalid or revoked keys stop being amber."""
        results: dict[str, str] = {}
        for f in self.check_candidates(report):
            try:
                secret = read_token(f.location, report.max_size, report.max_notebook)
            except (NotReadable, OSError):
                continue
            if secret is None:
                continue
            provider = get_provider(ProviderId(f.provider or ""))
            if provider is None:
                continue
            try:
                cred = Credential(
                    id="scan-check",
                    label="scan",
                    provider=ProviderId(f.provider or ""),
                    kind=CredentialKind(f.kind or "api_key"),
                    redacted=f.redacted,
                    fingerprint="",
                    created_at=self._now(),
                )
                obs = await self._observe(cred, provider, secret=secret)
                result = evaluate(cred, obs, self._now(), self.thresholds)
                results[f.fingerprint or f.location.id] = result.validity.value.value
            finally:
                del secret
        report.findings = [
            replace(f, check=results.get(f.fingerprint or f.location.id)) for f in report.findings
        ]
        return report

    # --- encrypted backups -------------------------------------------------------------
    def export_payload(self) -> dict[str, Any]:
        """Credentials with their secrets and settings (no check history, no store key).

        The caller encrypts the result with a backup passphrase (``mecha.core.backup``).
        Fingerprints are left out: they are an HMAC under *this* store's key and mean
        nothing in another store, so ``restore`` recomputes them.
        """
        items = []
        for cred in self.store.all():
            data = cred.model_dump(mode="json", exclude={"fingerprint"})
            items.append({"credential": data, "secret": self.store.secret(cred.id)})
        return {"kind": "mecha-backup", "exported_at": self._now().isoformat(), "items": items}

    def restore_payload(self, payload: dict[str, Any]) -> builtins.list[tuple[str, str, str]]:
        """Merge a backup into this store; never overwrites. Returns (label, action, id).

        Duplicates are found by recomputing each fingerprint with the destination store's
        key. A clashing id gets a new one, and parent links and fact reporters follow it.
        """
        if payload.get("kind") != "mecha-backup":
            raise BackupError("This file is not a Mecha backup.")
        entries = payload.get("items") or []
        id_map: dict[str, str] = {}
        plan: builtins.list[tuple[dict[str, Any], str | None, str]] = []
        out: builtins.list[tuple[str, str, str]] = []
        for entry in entries:
            data = dict(entry["credential"])
            secret = entry.get("secret")
            label = str(data.get("label") or "")
            if data.get("kind") == CredentialKind.oauth_file.value:
                fingerprint = self.store.cipher.fingerprint(f"linked:{data.get('linked_path')}")
            elif secret:
                fingerprint = self.store.cipher.fingerprint(secret)
            else:
                out.append((label, "skipped: no secret in the backup", str(data.get("id"))))
                continue
            existing = self.store.by_fingerprint(fingerprint)
            if existing is not None:
                id_map[str(data["id"])] = existing
                out.append((label, "skipped: already stored", existing))
                continue
            old_id = str(data["id"])
            new_id = old_id if self.store.get(old_id) is None else new_ulid()
            id_map[old_id] = new_id
            data["id"], data["fingerprint"] = new_id, fingerprint
            plan.append((data, secret, old_id))
        for data, secret, _old in plan:
            if data.get("parent_id"):
                data["parent_id"] = id_map.get(str(data["parent_id"]))
            cred = Credential.model_validate(data)
            cred = cred.model_copy(update={"facts": _remap_reporters(cred.facts, id_map)})
            self.store.insert(cred, secret if cred.kind is not CredentialKind.oauth_file else None)
            if cred.facts != CredentialFacts():
                self.store.set_facts(cred.id, cred.facts)
            out.append((cred.label, "restored", cred.id))
        return out

    # --- linked session files ---------------------------------------------------------
    def link(
        self, tool: Tool, path: str | None = None, *, label: str | None = None
    ) -> CredentialStatus:
        """Link a CLI's OAuth session file by path (read-only; tokens are never copied)."""
        file = Path(path).expanduser() if path else default_path(tool)
        info = read_linked(tool, file)  # validates before storing anything
        resolved = str(file.resolve())
        fingerprint = self.store.cipher.fingerprint(f"linked:{resolved}")
        existing = self.store.by_fingerprint(fingerprint)
        if existing is not None:
            raise DuplicateCredentialError(f"This file is already linked as {existing}.", existing)
        home = str(Path.home())
        shown = resolved.replace(home, "~", 1) if resolved.startswith(home) else resolved
        cred = Credential(
            id=new_ulid(),
            label=(label or "").strip() or f"{tool} session",
            provider=PROVIDER_OF[tool],
            kind=CredentialKind.oauth_file,
            pattern_id=f"linked:{tool}",
            redacted=shown,
            fingerprint=fingerprint,
            linked_path=resolved,
            created_at=self._now(),
            facts=linked_facts(CredentialFacts(), info, self._now()),
        )
        self.store.insert(cred, None)
        return self._status(cred)

    def _refresh_linked(self, cred: Credential) -> Credential:
        """Re-read a linked file on every check; on failure keep the last facts and flag it."""
        tool = (cred.pattern_id or "").removeprefix("linked:")
        if tool not in TOOLS or not cred.linked_path:
            return cred
        now = self._now()
        try:
            facts = linked_facts(cred.facts, read_linked(tool, Path(cred.linked_path)), now)
        except LinkedFileError as exc:
            facts = cred.facts.model_copy(deep=True)
            facts.account["file_error"] = Fact[str](
                value=exc.message, source="file", observed_at=now
            )
        self.store.set_facts(cred.id, facts)
        return cred.model_copy(update={"facts": facts})

    def history(self, id_or_prefix: str, limit: int = 50) -> builtins.list[CheckResult]:
        return self.store.history(self.resolve_id(id_or_prefix), limit)

    def remove(self, id_or_prefix: str) -> Credential:
        cred = self.get(id_or_prefix).credential
        # What this key reported about others goes with it (otherwise a stale "revoked"
        # from a deleted admin key would stay red forever).
        if cred.kind in ENRICHING_KINDS:
            for other in self.store.all():
                cleaned = forget_reporter(other.facts, cred.id)
                if other.id != cred.id and cleaned != other.facts:
                    self.store.set_facts(other.id, cleaned)
        self.store.delete(cred.id)
        return cred
