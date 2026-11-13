"""
Pytest configuration and shared, fully local test doubles.

Nothing in this test suite performs real network I/O: the third-party
``spotapi`` package (an import-time dependency of SpotipyFree) is replaced
with an in-memory stub, and ``requests.Session`` is replaced with a fake
transport driven by per-track route tables.
"""

import sys
import types
import importlib
from pathlib import Path

import pytest
import requests

# Make ``src/`` importable without installing the package.
SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


class _Stub:
    """Generic stand-in for any spotapi class/object."""

    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        raise AttributeError(name)

    def __call__(self, *args, **kwargs):
        return _Stub()


def _install_fake_spotapi():
    """Register a minimal fake ``spotapi`` package in sys.modules."""
    if "spotapi" in sys.modules:
        return

    spotapi = types.ModuleType("spotapi")

    client = types.ModuleType("spotapi.client")
    # Spotify.py assigns this at import time; give it a valid initial value.
    client._FALLBACK_SECRET = (61, bytearray([0]))

    saver = types.ModuleType("spotapi.saver")
    saver.JSONSaver = _Stub

    player = types.ModuleType("spotapi.player")
    player.Player = _Stub
    player.PlayerStatus = _Stub

    status = types.ModuleType("spotapi.status")
    status.PlayerStatus = _Stub  # imported by LastPlayed.py

    playlist = types.ModuleType("spotapi.playlist")
    playlist.PrivatePlaylist = _Stub

    user = types.ModuleType("spotapi.user")
    user.User = _Stub

    for attr in (
        "Config",
        "Logger",
        "Login",
        "PublicAlbum",
        "Artist",
        "PublicPlaylist",
        "Song",
        "Public",
    ):
        setattr(spotapi, attr, _Stub)

    spotapi.client = client
    spotapi.saver = saver
    spotapi.player = player
    spotapi.status = status
    spotapi.playlist = playlist
    spotapi.user = user

    for module in (spotapi, client, saver, player, status, playlist, user):
        sys.modules[module.__name__] = module


_install_fake_spotapi()

# The package's __init__ rebinds the name "Spotify" (submodule) to the
# Spotify class, so fetch the real submodule object from sys.modules rather
# than `import SpotipyFree.Spotify`, which resolves to the class.
spotify_mod = importlib.import_module("SpotipyFree.Spotify")
Spotify = spotify_mod.Spotify


class FakeCookies:
    def __init__(self):
        self.jar = {}

    def set(self, name, value, **kwargs):
        self.jar[name] = value


class FakeResponse:
    def __init__(self, status_code, payload=None, text=None, json_error=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else ""
        self._json_error = json_error

    def json(self):
        if self._json_error is not None:
            raise self._json_error
        return self._payload


class FakeSession:
    """Mimics the small slice of requests.Session used by audio_features."""

    def __init__(self, transport):
        self._transport = transport
        self.cookies = FakeCookies()
        self.headers = {}
        self.last_headers = None

    def get(self, url, headers=None, **kwargs):
        self.last_headers = headers
        return self._transport.handle(url, headers)


class FakeTransport:
    """
    Local route table keyed by track id.

    Route specs:
      {"type": "ok", "payload": {...}}
      {"type": "network", "error": Exception(...)}
      {"type": "status", "status": 429}
      {"type": "bad_json"}
    """

    def __init__(self, routes):
        self.routes = routes
        self.requested = []       # ordered track ids that hit the "network"
        self.urls = []            # ordered full URLs
        self.sessions = []        # every FakeSession created

    def new_session(self):
        session = FakeSession(self)
        self.sessions.append(session)
        return session

    def handle(self, url, headers):
        track_id = url.rsplit("/", 1)[-1]
        self.requested.append(track_id)
        self.urls.append(url)

        spec = self.routes.get(
            track_id,
            {"type": "network",
             "error": requests.exceptions.ConnectionError("unrouted id")},
        )
        kind = spec["type"]

        if kind == "ok":
            return FakeResponse(
                200, payload=spec.get(
                    "payload", {"id": track_id, "tempo": 120.0, "key": 5}
                )
            )
        if kind == "network":
            raise spec.get(
                "error", requests.exceptions.ConnectionError("connection refused")
            )
        if kind == "status":
            return FakeResponse(
                spec["status"], payload=None, text=spec.get("body", "blocked")
            )
        if kind == "bad_json":
            error = spec.get(
                "error",
                requests.exceptions.JSONDecodeError("Expecting value", "<html>", 0),
            )
            return FakeResponse(200, payload=None, text="<html>oops</html>",
                                json_error=error)

        raise AssertionError(f"unknown fake route type: {kind}")


@pytest.fixture
def sp(monkeypatch):
    """A logged-out Spotify instance with time.sleep recorded, not executed."""
    instance = Spotify()
    sleep_calls = []
    monkeypatch.setattr(
        spotify_mod.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )
    instance.sleep_calls = sleep_calls
    return instance


@pytest.fixture
def transport_factory(monkeypatch):
    """Returns a helper that installs a FakeTransport for requests.Session."""

    def make(routes):
        transport = FakeTransport(routes)
        monkeypatch.setattr(
            spotify_mod.requests, "Session", transport.new_session
        )
        return transport

    return make
