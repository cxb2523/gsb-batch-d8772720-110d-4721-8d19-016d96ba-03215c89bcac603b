"""Outbound HTTP: a closed list of method + host + path per credential kind, HTTPS only,
no redirects, no header logging.

Each check gets a client that can only make the requests its credential kind needs: an
admin or management key (which could create or delete keys) is limited to the verified
reads, an xAI management key only reaches management-api.x.ai and a normal key never does.
Anything else (another route, method, host, plain HTTP, a redirect) raises before a byte
leaves the machine.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

import httpx

from mecha import __version__

log = logging.getLogger(__name__)

USER_AGENT = f"mecha-keys/{__version__} (+https://github.com/JoaquinRuiz/mecha)"
RETRY_STATUS = frozenset({500, 502, 503, 504, 529})

# httpx logs request lines at INFO and httpcore logs connection internals at DEBUG. Neither
# should ever be able to print headers (they carry the credentials), so keep them quiet.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)


class DisallowedRequestError(RuntimeError):
    """The request targeted a host or scheme outside the provider's allow-list."""


class NetworkError(RuntimeError):
    """The request could not complete (network, timeout or repeated 5xx).

    ``uncertain``: a non-idempotent request (a paid probe) may have reached the provider
    anyway, e.g. a POST whose response timed out, so it might have been billed.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        latency_ms: float | None = None,
        uncertain: bool = False,
    ):
        super().__init__(message)
        self.status = status
        self.latency_ms = latency_ms
        self.uncertain = uncertain


@dataclass(frozen=True)
class HttpSettings:
    timeout_seconds: float = 10.0
    retries: int = 3
    backoff_seconds: float = 0.5


@dataclass(frozen=True)
class Route:
    """One allowed request: exact method and host, and a full-match regex for the path."""

    method: str
    host: str
    path: str

    def matches(self, method: str, host: str, path: str) -> bool:
        return (
            self.method == method.upper()
            and self.host == host.lower()
            and re.fullmatch(self.path, path) is not None
        )


def _guard(routes: tuple[Route, ...]) -> Callable[[httpx.Request], Awaitable[None]]:
    hosts = {r.host for r in routes}

    async def check(request: httpx.Request) -> None:
        url = request.url
        if url.scheme != "https":
            raise DisallowedRequestError(f"Only HTTPS is allowed (got {url.scheme}://{url.host}).")
        if url.port not in (None, 443):
            raise DisallowedRequestError(f"Port {url.port} is not allowed.")
        if url.host not in hosts:
            raise DisallowedRequestError(f"Host {url.host} is not allowed for this credential.")
        if not any(r.matches(request.method, url.host, url.path) for r in routes):
            raise DisallowedRequestError(
                f"{request.method} {url.host}{url.path} is not allowed for this credential."
            )

    return check


def make_client(
    routes: Iterable[Route],
    settings: HttpSettings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> httpx.AsyncClient:
    settings = settings or HttpSettings()
    allowed = tuple(routes)
    if not allowed:
        raise ValueError("a credential kind must declare at least one allowed route")
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.timeout_seconds),
        follow_redirects=False,
        # trust_env honours HTTPS_PROXY/NO_PROXY and SSL_CERT_FILE/SSL_CERT_DIR (corporate
        # proxies, custom CAs). httpx 0.28 never reads .netrc unless given NetRCAuth. The
        # request hook still validates the *destination* host, proxy or not.
        trust_env=True,
        headers={"user-agent": USER_AGENT, "accept": "application/json"},
        event_hooks={"request": [_guard(allowed)]},
        transport=transport,
    )


@dataclass(frozen=True)
class Exchange:
    response: httpx.Response
    latency_ms: float
    attempts: int


async def send(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, str | int] | None = None,
    json: object | None = None,
    settings: HttpSettings | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> Exchange:
    """Send with retries on network errors and 5xx/529 (exponential backoff).

    Redirects are returned as-is (never followed). Raises :class:`NetworkError` when every
    attempt failed, :class:`DisallowedRequestError` for a forbidden destination.
    """
    settings = settings or HttpSettings()
    last_error = "unknown error"
    last_status: int | None = None
    # Only idempotent reads are retried: a POST (an active probe) that timed out may already
    # have been billed, so it is never sent twice automatically.
    idempotent = method.upper() in ("GET", "HEAD")
    attempts = settings.retries + 1 if idempotent else 1
    sent = False
    for attempt in range(attempts):
        if attempt:
            await sleep(settings.backoff_seconds * 2 ** (attempt - 1))
        started = time.perf_counter()
        try:
            response = await client.request(method, url, headers=headers, params=params, json=json)
        except DisallowedRequestError:
            raise
        except httpx.ConnectError as exc:  # never reached the provider
            last_error, last_status = f"network error ({type(exc).__name__})", None
            continue
        except httpx.TimeoutException as exc:
            # A connect timeout never reached the provider; a read timeout might have.
            sent = sent or not isinstance(exc, httpx.ConnectTimeout)
            last_error, last_status = "timeout", None
            continue
        except httpx.TransportError as exc:
            sent = True
            last_error, last_status = f"network error ({type(exc).__name__})", None
            continue
        latency = (time.perf_counter() - started) * 1000
        if response.status_code in RETRY_STATUS and idempotent:
            last_error, last_status = f"HTTP {response.status_code}", response.status_code
            continue
        return Exchange(response, latency, attempt + 1)
    raise NetworkError(
        f"{last_error} after {attempts} attempt{'s' if attempts > 1 else ''}",
        status=last_status,
        uncertain=sent and not idempotent,
    )
