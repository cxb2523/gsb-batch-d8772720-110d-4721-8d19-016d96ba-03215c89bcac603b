"""Local security surface: Host allow-list, session token, CSP and error shape."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mecha.server import CSP, NONCE_PLACEHOLDER, create_app, csp

PORT = 7878
TOKEN = "test-session-token"  # not a credential: a fixed per-test session token
GOOD_HOST = f"127.0.0.1:{PORT}"


def client(static_dir: Path | None = None) -> TestClient:
    app = create_app(token=TOKEN, port=PORT, static_dir=static_dir)
    return TestClient(app, base_url=f"http://{GOOD_HOST}")


def auth(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div>")
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    return tmp_path


def test_health_with_token() -> None:
    r = client().get("/api/health", headers=auth())
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


@pytest.mark.parametrize("host", [GOOD_HOST, f"localhost:{PORT}"])
def test_allowed_hosts(host: str) -> None:
    r = client().get("/api/health", headers={**auth(), "Host": host})
    assert r.status_code == 200


@pytest.mark.parametrize(
    "host",
    ["evil.example:7878", "127.0.0.1", "localhost", "127.0.0.1:5173", "127.0.0.1.nip.io:7878", ""],
)
def test_foreign_host_rejected(host: str) -> None:
    r = client().get("/api/health", headers={**auth(), "Host": host})
    assert r.status_code == 400
    assert r.json()["code"] == "invalid_host"


def test_foreign_host_rejected_for_static(static_dir: Path) -> None:
    r = client(static_dir).get("/", headers={"Host": "rebind.example:7878"})
    assert r.status_code == 400


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"Authorization": TOKEN},
        {"Authorization": f"Basic {TOKEN}"},
        {"Authorization": "Bearer "},
    ],
)
def test_api_requires_token(headers: dict[str, str]) -> None:
    r = client().get("/api/health", headers=headers)
    assert r.status_code == 401
    assert r.json() == {"code": "unauthorized", "message": "Missing or invalid session token."}
    assert r.headers["www-authenticate"] == "Bearer"


def test_unknown_api_route_also_requires_token() -> None:
    c = client()
    assert c.get("/api/nope").status_code == 401
    r = c.get("/api/nope", headers=auth())
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"


def test_no_cors() -> None:
    r = client().options(
        "/api/health",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in r.headers


def test_security_headers_on_every_response(static_dir: Path) -> None:
    c = client(static_dir)
    for r in (c.get("/"), c.get("/api/health", headers=auth()), c.get("/api/health")):
        assert r.headers["content-security-policy"].startswith("default-src 'none'")
        assert len(r.headers.get_list("content-security-policy")) == 1
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer"
    assert c.get("/api/health", headers=auth()).headers["content-security-policy"] == CSP


def test_csp_directives_that_do_not_inherit_are_explicit() -> None:
    for directive in ("frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"):
        assert directive in CSP
    assert "unsafe-inline" not in CSP
    assert "unsafe-inline" not in csp("abc")


def test_index_gets_a_fresh_nonce_per_response(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text(
        f'<meta property="csp-nonce" nonce="{NONCE_PLACEHOLDER}">'
        f'<script type="module" nonce="{NONCE_PLACEHOLDER}" src="/assets/a.js"></script>'
    )
    c = client(tmp_path)
    first, second = c.get("/"), c.get("/some/route")
    nonces = []
    for r in (first, second):
        assert NONCE_PLACEHOLDER not in r.text
        nonce = re.search(r'nonce="([^"]+)"', r.text).group(1)  # type: ignore[union-attr]
        assert f"'nonce-{nonce}'" in r.headers["content-security-policy"]
        assert r.headers["cache-control"] == "no-store"
        nonces.append(nonce)
    assert nonces[0] != nonces[1]
    assert len(nonces[0]) >= 22
    # the raw template is never served
    assert NONCE_PLACEHOLDER not in c.get("/index.html").text


def test_oversized_bodies_are_rejected_unread() -> None:
    r = client().post("/api/detect", headers={**auth(), "content-length": str(10**6)}, content=b"x")
    assert r.status_code == 413
    assert r.json()["code"] == "too_large"


def test_data_endpoints_without_a_store_are_503() -> None:
    r = client().get("/api/credentials", headers=auth())
    assert r.status_code == 503
    assert r.json()["code"] == "store_locked"


def test_static_shell_is_public_and_spa_fallback(static_dir: Path) -> None:
    c = client(static_dir)
    assert "id=root" in c.get("/").text
    assert "id=root" in c.get("/some/client/route").text
    assert c.get("/assets/app.js").text == "console.log(1)"
    assert c.get("/favicon.svg").text == "<svg/>"


def test_static_path_traversal(static_dir: Path) -> None:
    secret = static_dir.parent / "outside.txt"
    secret.write_text("nope")
    r = client(static_dir).get("/..%2foutside.txt")
    assert "nope" not in r.text


def test_fallback_page_when_frontend_not_built(tmp_path: Path) -> None:
    r = client(tmp_path / "missing").get("/")
    assert r.status_code == 200
    assert "just build" in r.text
