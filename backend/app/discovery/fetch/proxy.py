"""Optional outbound proxy selection.

Credentials come from the environment only (``discovery_proxy_url`` /
``discovery_proxy_pool``) and are masked before they can reach a log line.
Everything degrades gracefully: no proxy configured means direct connections, and
a proxy that fails is retried once without it rather than killing the search.

Which proxies have *already* failed is remembered process-wide
(``DeadProxyRegistry``) rather than per search, because a dead proxy is a fact
about the proxy — not about the search that discovered it.
"""

from __future__ import annotations

import itertools
import threading
from collections.abc import Iterator, Sequence
from urllib.parse import urlsplit, urlunsplit

from app.discovery.fetch.ratelimit import registrable_domain


class DeadProxyRegistry:
    """What failed-proxy probes taught us, kept where the next search can see it.

    A proxy that refuses a connection is not a property of the search that
    noticed it; it is a property of that proxy. Held as instance state on a
    ``ProxySelector`` — and selectors are built once per search
    (``build_proxy_selector``) — that knowledge died with the search, so the
    very next search cycled back onto the same dead endpoint and paid the same
    failure before falling back to a direct connection.

    The registry is deliberately *data, not a live object*: it holds only
    strings, so one process-wide instance can be shared without leaking
    anything between searches (the same reasoning as ``CookieVault``).

    A ``threading.Lock`` rather than an ``asyncio`` one: ``for_url`` is called
    from inside async code but is not itself async, and a set operation under
    the GIL would only be safe by accident. An injectable registry also lets
    tests keep their failures to themselves instead of poisoning the process.
    """

    def __init__(self) -> None:
        self._dead: set[str] = set()
        self._lock = threading.Lock()

    def __contains__(self, proxy: str) -> bool:
        if not proxy:
            return False
        with self._lock:
            return proxy in self._dead

    def add(self, proxy: str) -> bool:
        """Record a proxy as dead. Returns True only the first time."""
        if not proxy:
            return False
        with self._lock:
            if proxy in self._dead:
                return False
            self._dead.add(proxy)
            return True

    def snapshot(self) -> frozenset[str]:
        """Read-only view, for diagnostics and tests."""
        with self._lock:
            return frozenset(self._dead)


_PROCESS_DEAD_PROXIES = DeadProxyRegistry()
"""One registry per process, so a proxy judged dead by one search stays dead."""


def process_dead_proxies() -> DeadProxyRegistry:
    """The process-wide registry every default selector consults."""
    return _PROCESS_DEAD_PROXIES


def mask_proxy(url: str | None) -> str:
    """Render a proxy URL safe to log by stripping userinfo.

    ``http://user:secret@host:8080`` -> ``http://***@host:8080``
    """
    if not url:
        return "none"
    try:
        split = urlsplit(url)
    except ValueError:
        return "***"
    if not split.hostname:
        return "***"
    netloc = split.hostname
    if split.port:
        netloc = f"{netloc}:{split.port}"
    if split.username or split.password:
        netloc = f"***@{netloc}"
    return urlunsplit((split.scheme, netloc, "", "", ""))


class ProxySelector:
    """Decides which proxy (if any) a given URL should go through.

    When ``platforms`` is non-empty the proxy is used *only* for those platforms'
    domains — useful for spending a paid proxy budget on Instagram/TikTok/LinkedIn
    while everything else goes out directly.
    """

    def __init__(
        self,
        *,
        primary: str = "",
        pool: Sequence[str] = (),
        platforms: Sequence[str] = (),
        platform_domains: dict[str, str] | None = None,
        dead: DeadProxyRegistry | None = None,
    ) -> None:
        """``dead`` is the memory of failed proxies. Defaults to the process-wide
        registry, which is the whole point: one search's discovery that a proxy
        is dead has to survive into the next search's selector, or every search
        pays for the same broken endpoint before falling back. Injecting a fresh
        registry keeps tests from poisoning each other.
        """
        candidates = [p.strip() for p in ([primary, *pool] if primary else list(pool)) if p and p.strip()]
        # Preserve order while removing duplicates.
        self._proxies: list[str] = list(dict.fromkeys(candidates))
        self._cycle: Iterator[str] | None = itertools.cycle(self._proxies) if self._proxies else None
        self._platforms = {p.strip().lower() for p in platforms if p and p.strip()}
        self._platform_domains = platform_domains or {}
        self._dead = dead if dead is not None else process_dead_proxies()

    @property
    def enabled(self) -> bool:
        return bool(self._proxies)

    def _applies_to(self, url: str) -> bool:
        """Empty platform filter means "proxy everything"."""
        if not self._platforms:
            return True
        domain = registrable_domain(url)
        for platform in self._platforms:
            mapped = self._platform_domains.get(platform)
            if mapped and registrable_domain(mapped) == domain:
                return True
            # Fall back to a name match so ``instagram`` works without a mapping.
            if domain.split(".", 1)[0] == platform:
                return True
        return False

    def for_url(self, url: str) -> str | None:
        """Return the proxy to use for ``url``, or None to connect directly.

        Never raises, including when every configured proxy is known dead: an
        exhausted pool is a signal to go direct, not to fail the search.
        """
        if not self._cycle or not self._applies_to(url):
            return None
        # Skip proxies already known to be dead (possibly by an earlier search);
        # if all are dead, go direct.
        for _ in range(len(self._proxies)):
            candidate = next(self._cycle)
            if candidate not in self._dead:
                return candidate
        return None

    def mark_failed(self, proxy: str) -> None:
        """Take a proxy out of rotation for the rest of the process."""
        self._dead.add(proxy)

    def describe(self) -> str:
        """Log-safe summary. Never leaks credentials."""
        if not self._proxies:
            return "proxy: disabled"
        scope = ",".join(sorted(self._platforms)) if self._platforms else "all"
        alive = sum(1 for proxy in self._proxies if proxy not in self._dead)
        return f"proxy: {alive}/{len(self._proxies)} alive, scope={scope}, primary={mask_proxy(self._proxies[0])}"
