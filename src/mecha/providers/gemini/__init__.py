"""Gemini plugin. Passive check: ``GET /v1beta/models``. The key always travels in the
``x-goog-api-key`` header, never in the URL (it would end up in logs)."""

from __future__ import annotations

import httpx

from mecha.core.http import Route
from mecha.core.models import Credential, CredentialKind, ProviderId, Validity
from mecha.core.status import Observation
from mecha.providers.base import (
    ChildRef,
    Enrichment,
    Finding,
    ProviderContext,
    json_body,
    observation,
    probe_misconfigured,
    probe_observation,
    request,
    trace,
)
from mecha.providers.gemini.errors import map_error

BASE = "https://generativelanguage.googleapis.com"
PROBE_DEFAULT = "gemini-3.5-flash-lite"


HOST = "generativelanguage.googleapis.com"
MODEL = r"[A-Za-z0-9_.\-]+"
ROUTES: dict[CredentialKind, tuple[Route, ...]] = {
    CredentialKind.api_key: (
        Route("GET", HOST, "/v1beta/models"),
        Route("POST", HOST, f"/v1beta/models/{MODEL}:generateContent"),  # active probe
        Route("POST", HOST, f"/v1beta/models/{MODEL}:countTokens"),  # free probe (opt-in)
    ),
}


class GeminiProvider:
    id = ProviderId.gemini
    allowed_hosts = frozenset({HOST})

    def routes(self, kind: CredentialKind) -> tuple[Route, ...]:
        return ROUTES.get(kind, ())

    def endpoint(self, kind: CredentialKind) -> tuple[str, str, dict[str, str | int]]:
        return BASE, "/v1beta/models", {"pageSize": 1000}  # docs: at most 1000 per page

    async def check_passive(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        base, path, params = self.endpoint(cred.kind)
        result = await request(
            http, ctx, "GET", base + path, headers={"x-goog-api-key": secret}, params=params
        )
        if isinstance(result, Observation):
            return result
        response = result.response
        body = json_body(response)
        if response.is_success and body is not None:
            finding = Finding(validity=Validity.valid)
            finding.account["models"] = str(len(body.get("models") or []))
        else:
            finding = map_error(response.status_code, body)
        return observation(finding, now=ctx.now, http=trace(f"GET {path}", result))

    async def _probe_model(
        self, http: httpx.AsyncClient, ctx: ProviderContext, headers: dict[str, str]
    ) -> str | Observation:
        if ctx.probe_model != "auto":
            return ctx.probe_model
        if ctx.cached_probe_model:
            return ctx.cached_probe_model
        listed = await request(
            http, ctx, "GET", BASE + "/v1beta/models", headers=headers, params={"pageSize": 1000}
        )
        if isinstance(listed, Observation):
            return listed
        names = [
            str(m.get("name", "")).removeprefix("models/")
            for m in (json_body(listed.response) or {}).get("models") or []
            if isinstance(m, dict)
            and "generateContent" in (m.get("supportedGenerationMethods") or [])
        ]
        for family in ("flash-lite", "flash"):
            found = sorted((n for n in names if family in n and "preview" not in n), reverse=True)
            if found:
                return found[0]
        return PROBE_DEFAULT

    async def check_active(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        """generateContent with maxOutputTokens 1 (or the free countTokens, opt-in)."""
        headers = {"x-goog-api-key": secret}
        model = await self._probe_model(http, ctx, headers)
        if isinstance(model, Observation):
            return model
        contents: list[dict[str, object]] = [{"role": "user", "parts": [{"text": "."}]}]
        payload: dict[str, object]
        if ctx.probe_free:
            path, payload = f"/v1beta/models/{model}:countTokens", {"contents": contents}
        else:
            path = f"/v1beta/models/{model}:generateContent"
            payload = {"contents": contents, "generationConfig": {"maxOutputTokens": 1}}
        result = await request(http, ctx, "POST", BASE + path, headers=headers, json=payload)
        if isinstance(result, Observation):
            return result.model_copy(update={"mode": "active", "probe_model": model})
        response, body = result.response, json_body(result.response)
        http_trace = trace(f"POST {path}", result)
        if response.status_code == 404:
            return probe_misconfigured(ctx.now, http_trace, model)
        finding = (
            Finding(validity=Validity.valid)
            if response.is_success
            else map_error(response.status_code, body)
        )
        return probe_observation(
            finding, now=ctx.now, http=http_trace, limits=None, model=model, paid=not ctx.probe_free
        )

    async def enrich(
        self,
        admin: Credential,
        secret: str,
        children: list[ChildRef],
        http: httpx.AsyncClient,
        ctx: ProviderContext,
    ) -> Enrichment:
        return Enrichment()  # Gemini has no admin/management keys


PROVIDER = GeminiProvider()
