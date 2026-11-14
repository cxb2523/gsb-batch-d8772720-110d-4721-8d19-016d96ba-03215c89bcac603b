"""Anthropic plugin. Passive check: ``GET /v1/models`` (admin keys: list API keys, limit 1)."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx

from mecha.core.hints import ambiguous_hints, match_unique
from mecha.core.http import Route
from mecha.core.models import (
    Credential,
    CredentialKind,
    ExpiryState,
    ProviderError,
    ProviderId,
    Validity,
)
from mecha.core.status import Observation
from mecha.providers.anthropic.errors import map_admin_key_status, map_error
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

BASE = "https://api.anthropic.com"
MAX_PAGES = 50  # safety cap on pagination
PROBE_DEFAULT = "claude-haiku-5-5"  # fallback when the model list has no haiku line


HOST = "api.anthropic.com"
ROUTES: dict[CredentialKind, tuple[Route, ...]] = {
    CredentialKind.api_key: (
        Route("GET", HOST, "/v1/models"),
        Route("POST", HOST, "/v1/messages"),  # active probe, max_tokens 1
        Route("POST", HOST, "/v1/messages/count_tokens"),  # free probe (opt-in)
    ),
    # An admin key could create or archive keys: verified reads only.
    CredentialKind.admin_key: (Route("GET", HOST, "/v1/organizations/api_keys"),),
}


def _iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class AnthropicProvider:
    id = ProviderId.anthropic
    allowed_hosts = frozenset({HOST})

    def routes(self, kind: CredentialKind) -> tuple[Route, ...]:
        return ROUTES.get(kind, ())

    def endpoint(self, kind: CredentialKind) -> tuple[str, str, dict[str, str | int]]:
        if kind is CredentialKind.admin_key:
            return BASE, "/v1/organizations/api_keys", {"limit": 1}
        return BASE, "/v1/models", {"limit": 1000}

    async def check_passive(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        base, path, params = self.endpoint(cred.kind)
        headers = {"x-api-key": secret, "anthropic-version": ctx.anthropic_version}
        result = await request(http, ctx, "GET", base + path, headers=headers, params=params)
        if isinstance(result, Observation):
            return result
        response = result.response
        body = json_body(response)
        limits = parse_rate_limits(
            response.headers, ctx.now, prefix="anthropic-ratelimit-", tokens="tokens"
        )
        if response.is_success and body is not None:
            finding = Finding(validity=Validity.valid)
            if cred.kind is not CredentialKind.admin_key:
                finding.account["models"] = str(len(body.get("data") or []))
            org = response.headers.get("anthropic-organization-id")
            if org:
                finding.account["org_id"] = org
                finding.account_source["org_id"] = "header"
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
        listed = await request(
            http, ctx, "GET", BASE + "/v1/models", headers=headers, params={"limit": 1000}
        )
        if isinstance(listed, Observation):
            return listed
        models = (json_body(listed.response) or {}).get("data") or []
        haiku = [
            m
            for m in models
            if isinstance(m, dict)
            and m.get("line") == "haiku"
            and m.get("lifecycle", "active") == "active"
        ]
        haiku.sort(key=lambda m: str(m.get("created_at", "")), reverse=True)
        return str(haiku[0]["id"]) if haiku else PROBE_DEFAULT

    async def check_active(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        """POST /v1/messages with max_tokens 1 (or the free count_tokens, opt-in)."""
        headers = {"x-api-key": secret, "anthropic-version": ctx.anthropic_version}
        model = await self._probe_model(http, ctx, headers)
        if isinstance(model, Observation):
            return model
        messages = [{"role": "user", "content": "."}]
        payload: dict[str, object]
        if ctx.probe_free:
            path, payload = "/v1/messages/count_tokens", {"model": model, "messages": messages}
        else:
            path, payload = "/v1/messages", {"model": model, "max_tokens": 1, "messages": messages}
        result = await request(http, ctx, "POST", BASE + path, headers=headers, json=payload)
        if isinstance(result, Observation):
            return result.model_copy(update={"mode": "active", "probe_model": model})
        response, body = result.response, json_body(result.response)
        http_trace = trace(f"POST {path}", result)
        if response.status_code == 404:
            return probe_misconfigured(ctx.now, http_trace, model)
        limits = parse_rate_limits(
            response.headers, ctx.now, prefix="anthropic-ratelimit-", tokens="tokens"
        )
        finding = (
            Finding(validity=Validity.valid)
            if response.is_success
            else map_error(response.status_code, body)
        )
        return probe_observation(
            finding,
            now=ctx.now,
            http=http_trace,
            limits=limits,
            model=model,
            paid=not ctx.probe_free,
        )

    async def enrich(
        self,
        admin: Credential,
        secret: str,
        children: list[ChildRef],
        http: httpx.AsyncClient,
        ctx: ProviderContext,
    ) -> Enrichment:
        """GET /v1/organizations/api_keys (paginated): status and expires_at of stored keys,
        matched by partial_key_hint against the decrypted secrets."""
        headers = {"x-api-key": secret, "anthropic-version": ctx.anthropic_version}
        secrets = {c.credential.id: c.secret for c in children if c.secret}
        out = Enrichment()
        after: str | None = None
        for _ in range(MAX_PAGES):
            params: dict[str, str | int] = {"limit": 1000}
            if after:
                params["after_id"] = after
            page = await read_json(http, ctx, BASE + "/v1/organizations/api_keys", headers, params)
            if isinstance(page, ProviderError):
                out.error = page
                break
            for item in page.get("data") or []:
                hint = item.get("partial_key_hint") if isinstance(item, dict) else None
                if not hint:
                    continue
                if ambiguous_hints([hint], secrets):
                    out.ambiguous += 1
                    continue
                cid = match_unique(hint, secrets)
                if cid is None:
                    continue
                update = KeyUpdate()
                status = map_admin_key_status(str(item.get("status", "")))
                if status.validity in (Validity.blocked, Validity.revoked):
                    update.status = status.validity
                elif status.expiry is ExpiryState.expired:
                    update.status = Validity.invalid
                expires = _iso(item.get("expires_at"))
                if expires is not None:
                    update.expires_at = expires
                elif "expires_at" in item and item["expires_at"] is None:
                    update.never_expires = True
                out.children[cid] = update
            if not page.get("has_more") or not page.get("last_id"):
                break
            after = str(page["last_id"])
        return out


PROVIDER = AnthropicProvider()
