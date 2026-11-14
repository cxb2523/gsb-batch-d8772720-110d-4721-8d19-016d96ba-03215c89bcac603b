"""Provider plugins. A plugin is ``mecha.providers.<id>`` exposing ``PROVIDER``."""

from __future__ import annotations

import importlib
from functools import cache

from mecha.core.models import ProviderId
from mecha.providers.base import Provider

ENABLED = (
    ProviderId.anthropic,
    ProviderId.openai,
    ProviderId.gemini,
    ProviderId.xai,
    ProviderId.openrouter,
)


@cache
def get_provider(provider_id: ProviderId) -> Provider | None:
    if provider_id not in ENABLED:
        return None
    module = importlib.import_module(f"mecha.providers.{provider_id.value}")
    provider: Provider = module.PROVIDER
    return provider
