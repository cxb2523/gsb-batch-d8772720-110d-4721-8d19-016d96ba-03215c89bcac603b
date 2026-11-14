"""OpenRouter plugin. Passive check: ``GET /api/v1/key`` describes the key itself, including
remaining credit (``limit_remaining``) and ``expires_at``: the only provider that reports
funds and expiry without a special key. No active probe is needed."""

from __future__ import annotations

import httpx

from mecha.core.http import Route
from mecha.core.models import Credential, CredentialKind, ProviderId
from mecha.core.status import Observation
from mecha.providers.base import (
    ChildRef,
    Enrichment,
    ProviderContext,
    json_body,
    observation,
    request,
    trace,
)
from mecha.providers.openrouter.errors import map_error, map_key_info

BASE = "https://openrouter.ai"
HOST = "openrouter.ai"
ROUTES: dict[CredentialKind, tuple[Route, ...]] = {
    CredentialKind.api_key: (Route("GET", HOST, "/api/v1/key"),),
}


class OpenRouterProvider:
    id = ProviderId.openrouter
    allowed_hosts = frozenset({HOST})

    def routes(self, kind: CredentialKind) -> tuple[Route, ...]:
        return ROUTES.get(kind, ())

    def endpoint(self, kind: CredentialKind) -> tuple[str, str, dict[str, str | int]]:
        return BASE, "/api/v1/key", {}

    async def check_passive(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        base, path, _ = self.endpoint(cred.kind)
        result = await request(
            http, ctx, "GET", base + path, headers={"authorization": f"Bearer {secret}"}
        )
        if isinstance(result, Observation):
            return result
        response, body = result.response, json_body(result.response)
        if response.is_success and body is not None:
            finding = map_key_info(body, ctx.now, ctx.low_funds_usd)
        else:
            finding = map_error(response.status_code, body)
        obs = observation(finding, now=ctx.now, http=trace(f"GET {path}", result))
        return obs.model_copy(update={"funds_source": "api"})

    async def check_active(
        self, cred: Credential, secret: str, http: httpx.AsyncClient, ctx: ProviderContext
    ) -> Observation:
        return await self.check_passive(cred, secret, http, ctx)  # the passive check suffices

    async def enrich(
        self,
        admin: Credential,
        secret: str,
        children: list[ChildRef],
        http: httpx.AsyncClient,
        ctx: ProviderContext,
    ) -> Enrichment:
        return Enrichment()


PROVIDER = OpenRouterProvider()
