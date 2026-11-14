"""Periodic passive checks inside ``mecha serve`` (a plain asyncio task, no extra deps).

Every ``tick`` seconds it checks the credentials that are due: ``interval_hours`` after
a successful check, or with backoff after failures (min_interval, then double, capped at
``interval_hours``), so a laptop waking up without network recovers in minutes.
Concurrency and the per-credential minimum interval are enforced by
:meth:`MechaService.check`. Only free passive endpoints are used.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

from mecha.core.models import CredentialKind
from mecha.core.service import CredentialStatus, MechaService

log = logging.getLogger(__name__)


class Scheduler:
    def __init__(
        self,
        service: MechaService,
        *,
        tick_seconds: float = 60.0,
        on_result: Callable[[CredentialStatus, int, int], None] | None = None,
    ) -> None:
        self.service = service
        self.tick_seconds = tick_seconds
        self.on_result = on_result

    def due(self, now: datetime) -> list[str]:
        out = []
        for cred in self.service.store.all():
            if not self.service.is_remote(cred) and cred.kind is not CredentialKind.oauth_file:
                continue
            due_at = self.service.next_due(cred)
            if due_at is None or now >= due_at:
                out.append(cred.id)
        return out

    async def run_once(self) -> list[CredentialStatus]:
        ids = self.due(self.service.now())
        if not ids:
            return []
        log.info("scheduled passive check of %d credential(s)", len(ids))
        return await self.service.check(ids, scheduled=True, on_result=self.on_result)

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # keep the scheduler alive; the next tick retries
                log.exception("scheduled check failed")
            await asyncio.sleep(self.tick_seconds)
