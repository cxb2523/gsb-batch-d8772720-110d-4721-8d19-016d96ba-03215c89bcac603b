"""Pluggable page fetchers for the Bédéthèque plugin.

A *fetcher* is any callable ``url -> bytes``. ``Bedetheque(library, fetch=...)``
uses it for every page it needs, always through the library cache.

Provided here:

- :func:`build_fetcher`: the fetcher selected by the config,
- :func:`load_fetcher`: resolve a ``"package.module:function"`` string (for a config option),
- :func:`flaresolverr_fetch`: fetches through one or more FlareSolverr servers,
- :class:`DirectoryFetcher`: serves pages saved from a browser into a folder.

The FlareSolverr endpoints share the load round-robin and fall back on failure; the :class:`FlareSolverrPool`
keeps per-endpoint counters (real requests only) and the isolation state, exposed by :func:`endpoint_status`.
"""

from __future__ import annotations

import importlib
import itertools
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional
import requests

from bdnex.importer.bedetheque.sitemap import source_id_from_url

from bdnex.config import load_config


logger = logging.getLogger(__name__)

Fetcher = Callable[[str], bytes]


class FetcherError(ValueError):
    """The ``bedetheque.fetcher`` setting does not lead to a usable function."""


def load_fetcher(spec: str) -> Fetcher:
    """Import ``"package.module:function"`` and return the callable.

    Raises :class:`FetcherError` with a hint when the module or function can not be found.
    """
    module_name, sep, attr = spec.partition(":")
    if not sep or not module_name or not attr:
        raise FetcherError(f"fetcher must look like 'package.module:function', got {spec!r}")
    try:
        module = importlib.import_module(module_name)
    except ImportError as err:
        raise FetcherError(f"can not import the module {module_name!r} of fetcher {spec!r} ({err}).{_hint(module_name, attr)}") from err
    try:
        func = getattr(module, attr)
    except AttributeError:
        raise FetcherError(f"module {module_name!r} has no function {attr!r} (fetcher {spec!r})") from None
    if not callable(func):
        raise TypeError(f"{spec} is not callable")
    return func


def _hint(module_name: str, attr: str) -> str:
    """Suggest 'parent.module:function' when the function name was written into the module path."""
    parent = module_name.rpartition(".")[0]
    if parent:
        try:
            if callable(getattr(importlib.import_module(parent), attr, None)):
                return f" Did you mean '{parent}:{attr}'? The part before ':' is the module, the part after is the function."
        except ImportError:
            pass
    return " The part before ':' must be a module (a .py file), the part after it a function inside that module."


def build_fetcher(settings) -> Fetcher:
    """Build the page fetcher selected by the ``bedetheque`` config section.

    ``fetcher: "package.module:function"`` is imported and used as the
    ``url -> bytes`` callable (it can read ``bedetheque.fetcher_endpoint`` itself
    through ``load_config``). Without it, pages saved from a browser into
    ``pages_dir`` are used.
    """
    section = settings.bedetheque
    if uses_saved_pages(settings):
        return DirectoryFetcher(settings.pages_dir)
    return load_fetcher(section.fetcher)


DEFAULT_FETCHER = "bdnex.importer.bedetheque:flaresolverr_fetch"


def uses_saved_pages(settings) -> bool:
    """Are album pages read from ``pages_dir``? Yes without a fetcher, and when the default fetcher (FlareSolverr)
    has no address to talk to."""
    section = settings.bedetheque
    return not section.fetcher or (section.fetcher == DEFAULT_FETCHER and not section.fetcher_endpoint)


DOWN_FOR = 60.0  # seconds an endpoint that failed is left alone while the others work


@dataclass
class EndpointState:
    """What happened to one configured FlareSolverr address.

    The counters only move when a request is *actually sent* to the endpoint: being skipped while isolated
    adds nothing, and a page served from the library cache never reaches the fetcher at all.
    """

    endpoint: str
    successes: int = 0
    failures: int = 0
    last_error: Optional[str] = None
    isolated_until: Optional[float] = None  # monotonic timestamp; the endpoint is deprioritised before it

    def is_isolated(self, now: float) -> bool:
        return self.isolated_until is not None and now < self.isolated_until

    def snapshot(self, now: float) -> dict:
        """A plain-data view for the query interface (no network, no live object leaked)."""
        isolated = self.is_isolated(now)
        return {
            "endpoint": self.endpoint,
            "successes": self.successes,
            "failures": self.failures,
            "last_error": self.last_error,
            "isolated": isolated,
            # when the current isolation ends; 0 means "not isolated" / "back in the ordinary rotation"
            "retry_after": max(0.0, self.isolated_until - now) if isolated else 0.0,
        }


class FlareSolverrPool:
    """The configured FlareSolverr endpoints, with round-robin rotation, fallback and observable state.

    Requests start on the endpoints in turn. An endpoint that fails is isolated for :data:`DOWN_FOR`
    seconds: as long as a healthy endpoint exists it starts no request, though it is still tried last when
    nothing healthy is left. Everything is measured with a monotonic clock, so the isolation simply expires.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock          # injectable in tests; the monotonic clock in production
        self._lock = threading.RLock()
        self._turn = itertools.count()  # which endpoint starts the next request: the load is spread round-robin
        self._states: dict[str, EndpointState] = {}

    def reset(self) -> None:
        """Forget every endpoint and its counters (tests start from a clean pool)."""
        with self._lock:
            self._turn = itertools.count()
            self._states = {}

    @staticmethod
    def normalise(endpoints) -> list[str]:
        """One address or a list, with duplicates merged into a single endpoint (the first position is kept)."""
        addresses = [endpoints] if isinstance(endpoints, str) else list(endpoints or [])
        return list(dict.fromkeys(addresses))

    def _register(self, endpoints: list[str]) -> None:
        for endpoint in endpoints:
            self._states.setdefault(endpoint, EndpointState(endpoint))

    def _order(self, endpoints: list[str]) -> list[str]:
        """The endpoints in the order to try for one request: round-robin start, isolated ones last."""
        with self._lock:
            start = next(self._turn) % len(endpoints)
            rotated = endpoints[start:] + endpoints[:start]
            now = self._clock()
            healthy = [e for e in rotated if not self._states[e].is_isolated(now)]
            return healthy + [e for e in rotated if e not in healthy]

    def fetch(self, endpoints, url: str, timeout: int, post: Optional[Callable] = None) -> bytes:
        """Fetch ``url`` through the endpoints, trying them in rotation until one answers.

        ``post`` is the ``requests.post``-style call to use (replaced by a fake in tests); it is looked up on
        the ``requests`` module at call time, so monkeypatching ``requests.post`` works. Only endpoints that
        actually receive a request get their counters changed.
        """
        post = post or requests.post
        addresses = self.normalise(endpoints)
        if not addresses:
            raise FetcherError(
                "bedetheque.fetcher is flaresolverr_fetch but bedetheque.fetcher_endpoint is not set in your config "
                "(the address of your FlareSolverr, e.g. http://localhost:8191/v1): `bdnex config --edit`")
        with self._lock:
            self._register(addresses)
            order = self._order(addresses)
        problems = []
        for endpoint in order:
            started = self._clock()
            try:
                content = self._request(endpoint, url, timeout, post)
            except (requests.RequestException, RuntimeError, ValueError, KeyError) as err:
                self._record_failure(endpoint, err)
                problems.append(f"{endpoint}: {err}")
                logger.warning(f"{endpoint} failed ({err}): trying the next endpoint")  # a fallback is never silent
                continue
            self._record_success(endpoint)
            logger.info(f"{url.rsplit('/', 1)[-1]} fetched through {endpoint} in {self._clock() - started:.1f}s")  # -v
            return content
        raise RuntimeError(f"no FlareSolverr endpoint could fetch {url}: " + "; ".join(problems))

    @staticmethod
    def _request(endpoint: str, url: str, timeout: int, post: Callable) -> bytes:
        payload = {
            "cmd": "request.get",
            "url": url,
            "maxTimeout": timeout * 1000  # FlareSolverr expects milliseconds
        }
        response = post(endpoint, json=payload, timeout=timeout + 10)
        response.raise_for_status()
        data = response.json()
        if data.get("status") == "ok":
            # FlareSolverr returns the page HTML inside solution.response
            return data["solution"]["response"].encode("utf-8")
        raise RuntimeError(f"FlareSolverr failed to fetch {url}: {data.get('message')}")

    def _record_failure(self, endpoint: str, err: Exception) -> None:
        with self._lock:
            state = self._states[endpoint]
            state.failures += 1
            state.last_error = str(err)
            state.isolated_until = self._clock() + DOWN_FOR  # a monotonic deadline: it expires on its own

    def _record_success(self, endpoint: str) -> None:
        with self._lock:
            state = self._states[endpoint]
            state.successes += 1
            state.isolated_until = None  # a working endpoint leaves isolation at once

    def status(self, endpoints=None) -> list[dict]:
        """A snapshot of every configured endpoint: counters, last error and isolation state.

        With no argument the current config's endpoints are used. It only reads in-memory state, so it never
        opens a connection; endpoints seen before but absent from the current config are reported too.
        """
        addresses = self.normalise(endpoints) if endpoints is not None else self._configured_endpoints()
        with self._lock:
            self._register(addresses)
            now = self._clock()
            return [self._states[e].snapshot(now) for e in self.normalise(list(self._states))]

    @staticmethod
    def _configured_endpoints() -> list[str]:
        settings = load_config().settings  # creates the file on first run, validates, merges defaults
        return FlareSolverrPool.normalise(settings.bedetheque.fetcher_endpoint)


# The process-wide pool: the import pipeline fetches pages from worker threads, so the state is shared and locked.
_pool = FlareSolverrPool()


def get_pool() -> FlareSolverrPool:
    """The process-wide :class:`FlareSolverrPool` (the fetchers and the query interface share it)."""
    return _pool


def reset_pool() -> None:
    """Clear the process-wide pool's endpoints and counters (for tests)."""
    _pool.reset()


def flaresolverr_fetch(url: str, timeout: int = 60) -> bytes:
    """Fetch a webpage using FlareSolverr.

    ``bedetheque.fetcher_endpoint`` may list several FlareSolverr servers: requests are spread over them round-robin,
    and when one fails the next is tried (a server that failed is left for a minute, as long as another works).
    """
    return _pool.fetch(_pool._configured_endpoints(), url, timeout)


def endpoint_status() -> list[dict]:
    """The state of every configured FlareSolverr endpoint (successes, failures, last error, isolation).

    Purely in-memory: it performs no network request and does not change any counter.
    """
    return _pool.status()


class DirectoryFetcher:
    """Serve album pages that were saved from a browser into ``directory``.

    A page is found by its album id: ``<id>.html`` or any ``*-<id>.html`` file.
    """

    def __init__(self, directory):
        self.directory = os.path.expanduser(str(directory))

    def __call__(self, url: str) -> bytes:
        source_id = source_id_from_url(url)
        if source_id is not None and os.path.isdir(self.directory):
            for name in sorted(os.listdir(self.directory)):
                if name == f"{source_id}.html" or name.endswith(f"-{source_id}.html"):
                    with open(os.path.join(self.directory, name), "rb") as fh:
                        return fh.read()
        raise FileNotFoundError(
            f"No saved page for {url}: save it in {self.directory} as '{source_id}.html'")
