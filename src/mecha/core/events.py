"""In-process event bus for progress events (served as a stream by ``GET /api/events``).

Events only tell the UI *what changed* so it can refetch over REST; they never carry
credential data. Closing the bus ends every open stream, so shutdown never hangs on them.

Every event gets a sequence number, and the bus an id for this server start (``boot``), so
a restart can never match by chance. The listing says which (boot, seq) it was computed
at, and a new stream first says ``hello`` with the current ones: the UI reloads only if
they differ, i.e. only if it missed something.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
from collections.abc import AsyncIterator
from typing import Any

_CLOSE = object()


class EventBus:
    def __init__(self, max_queue: int = 256) -> None:
        self._subscribers: set[asyncio.Queue[Any]] = set()
        self._max_queue = max_queue
        self.closed = False
        self.boot = secrets.token_hex(8)  # this server start
        self.seq = 0  # last event published

    def position(self) -> dict[str, Any]:
        """Where the bus is now. Read it *before* computing a listing: an event during the
        computation then makes the UI reload once more, never miss a change."""
        return {"boot": self.boot, "seq": self.seq}

    def publish(self, event: dict[str, Any]) -> None:
        self.seq += 1
        event = {**event, "seq": self.seq}
        for queue in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):  # a stalled client just misses events
                queue.put_nowait(event)

    def close(self) -> None:
        self.closed = True
        for queue in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(_CLOSE)

    @property
    def subscribers(self) -> int:
        return len(self._subscribers)

    async def subscribe(self, keepalive: float = 15.0) -> AsyncIterator[dict[str, Any] | None]:
        """Yield events; ``None`` means "send a keepalive". Ends when the bus closes."""
        queue: asyncio.Queue[Any] = asyncio.Queue(self._max_queue)
        # Subscribe and take the position in one step (no await in between): every event
        # after this hello reaches the queue, every one before it is <= its seq.
        self._subscribers.add(queue)
        try:
            yield {"type": "hello", **self.position()}
            while not self.closed:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=keepalive)
                except TimeoutError:
                    yield None
                    continue
                if item is _CLOSE:
                    return
                yield item
        finally:
            self._subscribers.discard(queue)
