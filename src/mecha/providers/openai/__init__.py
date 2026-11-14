"""OpenAI plugin. Passive check: ``GET /v1/models`` (admin keys: list admin keys, limit 1).

``/v1/models`` does not check quota, so a passive check never detects missing funds.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx

from mecha.core.hints import ambiguous_hints, match_unique, matches_hint
from mecha.core.http import Route
from mecha.core.models import (
    Credential,
    CredentialKind,
    FundsInfo,
    ProviderError,
    ProviderId,
    Validity,
)
from mecha.core.status import R_OWNER_NO_ACCESS, Observation
from mecha.providers.base import (
    ChildRef,
    Enrichment,
    Finding,
    KeyUpdate,
    ProviderContext,
    json_body,
    observation,
    parse_rate_limits,
    probe_misconfigured,
    probe_observation,
    read_json,
    request,
    trace,
)
from mecha.providers.openai.errors import map_error

BASE = "https://api.openai.com"
MAX_PAGES = 50  # safety cap on pagination
PROBE_DEFAULT = "text-embedding-3-small"


HOST = "api.openai.com"
ID = r"[A-Za-z0-9_.\-]+"
ROUTES: dict[CredentialKind, tuple[Route, ...]] = {
    CredentialKind.api_key: (
        Route("GET", HOST, "/v1/models"),
        Route("POST", HOST, "/v1/embeddings"),  # active probe, one word
    ),
    # An admin key could create or delete keys and projects: verified reads only.
    CredentialKind.admin_key: (
        Route("GET", HOST, "/v1/organization/admin_api_keys"),
        Route("GET", HOST, "/v1/organization/projects"),
        Route("GET", HOST, f"/v1/organization/projects/{ID}/api_keys"),
        Route("GET", HOST, "/v1/organization/costs"),
    ),
}


def _unix(value: object) -> datetime | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, tz=UTC)
    return None


def _key_update(item: dict[str, Any], project: str | None = None) -> KeyUpdate:
    update = KeyUpdate()
    if "expires_at" in item:
        expires = _unix(item["expires_at"])
        update.expires_at = expires
        update.never_expires = item["expires_at"] is None
    update.last_used_at = _unix(item.get("last_used_at"))
    if item.get("owner_project_access") == "inactive":
        # Not proof that the key fails (a direct check would show that): a warning.
        update.warnings.append(R_OWNER_NO_ACCESS)
    if project:
        update.account["project_id"] = project
    return update


class OpenAIProvider:
    id = ProviderId.openai
    allowed_hosts = frozenset({HOST})

    def routes(self, kind: CredentialKind) -> tuple[Route, ...]:
        return ROUTES.get(kind, ())

    def endpoint(self, kind: CredentialKind) -> tuple[str, str, dict[str, str | int]]:
        if kind is CredentialKind.admin_key:
            return BASE, "/v1/organization/admin_api_keys", {"limit": 1}
        return BASE, "/v1/models", {}

    async def check_passive(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        base, path, params = self.endpoint(cred.kind)
        headers = {"authorization": f"Bearer {secret}"}
        result = await request(http, ctx, "GET", base + path, headers=headers, params=params)
        if isinstance(result, Observation):
            return result
        response = result.response
        body = json_body(response)
        limits = parse_rate_limits(
            response.headers, ctx.now, prefix="x-ratelimit-", tokens="tokens"
        )
        if response.is_success and body is not None:
            finding = Finding(validity=Validity.valid)
            if cred.kind is not CredentialKind.admin_key:
                finding.account["models"] = str(len(body.get("data") or []))
            for header, key in (
                ("openai-organization", "org_id"),
                ("openai-project", "project_id"),
            ):
                if response.headers.get(header):
                    finding.account[key] = response.headers[header]
                    finding.account_source[key] = "header"
        else:
            finding = map_error(response.status_code, body)
        return observation(finding, now=ctx.now, http=trace(f"GET {path}", result), limits=limits)

    async def _probe_model(
        self, http: httpx.AsyncClient, ctx: ProviderContext, headers: dict[str, str]
    ) -> str | Observation:
        if ctx.probe_model != "auto":
            return ctx.probe_model
        if ctx.cached_probe_model:
            return ctx.cached_probe_model
        listed = await request(http, ctx, "GET", BASE + "/v1/models", headers=headers)
        if isinstance(listed, Observation):
            return listed
        ids = [
            str(m.get("id"))
            for m in (json_body(listed.response) or {}).get("data") or []
            if isinstance(m, dict)
        ]
        if PROBE_DEFAULT in ids:
            return PROBE_DEFAULT
        embeddings = sorted(i for i in ids if "embedding" in i)
        return embeddings[0] if embeddings else PROBE_DEFAULT

    async def check_active(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        """POST /v1/embeddings with one word on the cheapest embedding model."""
        headers = {"authorization": f"Bearer {secret}"}
        model = await self._probe_model(http, ctx, headers)
        if isinstance(model, Observation):
            return model
        path = "/v1/embeddings"
        result = await request(
            http, ctx, "POST", BASE + path, headers=headers, json={"model": model, "input": "ping"}
        )
        if isinstance(result, Observation):
            return result.model_copy(update={"mode": "active", "probe_model": model})
        response, body = result.response, json_body(result.response)
        http_trace = trace(f"POST {path}", result)
        err = (body or {}).get("error") if body else None
        if response.status_code == 404 or (
            isinstance(err, dict) and err.get("code") == "model_not_found"
        ):
            return probe_misconfigured(ctx.now, http_trace, model)
        limits = parse_rate_limits(
            response.headers, ctx.now, prefix="x-ratelimit-", tokens="tokens"
        )
        finding = (
            Finding(validity=Validity.valid)
            if response.is_success
            else map_error(response.status_code, body)
        )
        return probe_observation(
            finding, now=ctx.now, http=http_trace, limits=limits, model=model, paid=True
        )

    async def _paged(
        self, http: httpx.AsyncClient, ctx: ProviderContext, path: str, headers: dict[str, str]
    ) -> tuple[list[dict[str, Any]], ProviderError | None]:
        items: list[dict[str, Any]] = []
        after: str | None = None
        for _ in range(MAX_PAGES):
            params: dict[str, str | int] = {"limit": 100}
            if after:
                params["after"] = after
            page = await read_json(http, ctx, BASE + path, headers, params)
            if isinstance(page, ProviderError):
                return items, page
            items += [i for i in page.get("data") or [] if isinstance(i, dict)]
            if not page.get("has_more") or not page.get("last_id"):
                break
            after = str(page["last_id"])
        return items, None

    async def _estimated_balance(
        self,
        admin: Credential,
        http: httpx.AsyncClient,
        ctx: ProviderContext,
        headers: dict[str, str],
    ) -> tuple[FundsInfo | None, ProviderError | None]:
        """Manual budget minus GET /v1/organization/costs since the purchase date (daily
        buckets). An estimate: auto-recharge makes it meaningless (the UI says so)."""
        budget = admin.manual_budget
        if budget is None:
            return None, None
        total, last_day, cursor = Decimal("0"), None, None
        for _ in range(MAX_PAGES):
            params: dict[str, str | int] = {
                "start_time": int(budget.purchased_at.timestamp()),
                "bucket_width": "1d",
                "limit": 180,
            }
            if cursor:
                params["page"] = cursor
            page = await read_json(http, ctx, BASE + "/v1/organization/costs", headers, params)
            if isinstance(page, ProviderError):
                return None, page
            for bucket in page.get("data") or []:
                if not isinstance(bucket, dict):
                    continue
                for res in bucket.get("results") or []:
                    amount = (res or {}).get("amount") or {}
                    if str(amount.get("currency", "usd")).lower() == budget.currency.lower():
                        total += Decimal(str(amount.get("value", 0)))
                start = bucket.get("start_time")
                if isinstance(start, int | float):
                    day = datetime.fromtimestamp(start, tz=UTC)
                    last_day = day if last_day is None or day > last_day else last_day
            if not page.get("has_more") or not page.get("next_page"):
                break
            cursor = str(page["next_page"])
        until = last_day or budget.purchased_at
        return FundsInfo(amount=budget.amount - total, currency=budget.currency, until=until), None

    async def enrich(
        self,
        admin: Credential,
        secret: str,
        children: list[ChildRef],
        http: httpx.AsyncClient,
        ctx: ProviderContext,
    ) -> Enrichment:
        """Projects and their keys (expires_at, last_used_at), the admin key itself, and the
        estimated organization balance when a manual budget is set."""
        headers = {"authorization": f"Bearer {secret}"}
        secrets = {c.credential.id: c.secret for c in children if c.secret}
        out = Enrichment()
        projects, error = await self._paged(http, ctx, "/v1/organization/projects", headers)
        out.error = error
        matched: set[str] = set()
        for project in projects:
            pid = str(project.get("id", ""))
            if not pid:
                continue
            keys, error = await self._paged(
                http, ctx, f"/v1/organization/projects/{pid}/api_keys", headers
            )
            out.error = out.error or error
            for item in keys:
                hint = str(item.get("redacted_value") or "")
                if ambiguous_hints([hint], secrets):
                    out.ambiguous += 1
                    continue
                cid = match_unique(hint, secrets)
                if cid is None:
                    continue
                matched.add(cid)
                out.children[cid] = _key_update(item, project=pid)
        admins, error = await self._paged(http, ctx, "/v1/organization/admin_api_keys", headers)
        out.error = out.error or error
        for item in admins:
            if matches_hint(secret, str(item.get("redacted_value") or "")):
                out.own = _key_update(item)
                break
        estimate, error = await self._estimated_balance(admin, http, ctx, headers)
        out.error = out.error or error
        if estimate is not None:
            out.own.funds_info = estimate
            for cid in matched:  # shown on the children, never colouring them
                out.children[cid].funds_info = estimate
        return out


PROVIDER = OpenAIProvider()
