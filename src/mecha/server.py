"""FastAPI application: local API, compiled frontend and the local security surface.

Security model (see SPEC.md, "Seguridad"):

* Only ``Host: 127.0.0.1:<port>`` or ``Host: localhost:<port>`` is accepted (anti DNS rebinding).
* Every ``/api/*`` request needs ``Authorization: Bearer <session token>``. The token is
  random per process start and reaches the browser through the URL fragment.
* No CORS middleware is installed, so cross-origin pages cannot read responses.
* A strict CSP is sent with every response; the frontend loads nothing from third parties.

The static shell (``index.html`` and its assets) is deliberately *not* token protected:
the browser must load it before it can read the token from the fragment. It contains no data.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    MutableMapping,
    Sequence,
)
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from mecha.api import health, routes
from mecha.api.routes import ApiContext, error_response
from mecha.core.errors import MechaError
from mecha.core.redact import redact_text

STATIC_DIR = Path(__file__).parent / "static"

# Placeholder that `vite build` writes into index.html (html.cspNonce); replaced per response.
NONCE_PLACEHOLDER = "__MECHA_CSP_NONCE__"
MAX_BODY = 64 * 1024  # largest request body accepted (a secret is at most 8 KiB)


def csp(nonce: str | None = None) -> str:
    """Strict CSP. With a nonce, scripts/styles carrying it are allowed too (Radix scroll
    lock and Motion inject <style> elements); never 'unsafe-inline'. frame-ancestors,
    base-uri and form-action do not inherit from default-src, so they are explicit."""
    extra = f" 'nonce-{nonce}'" if nonce else ""
    return "; ".join(
        [
            "default-src 'none'",
            f"script-src 'self'{extra}",
            f"style-src 'self'{extra}",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "manifest-src 'self'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


CSP = csp()

SECURITY_HEADERS: list[tuple[bytes, bytes]] = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
]

FALLBACK_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mecha</title></head>
<body><h1>Mecha</h1>
<p>The frontend has not been built. Run <code>just build</code> (or <code>just dev</code>).</p>
</body></html>
"""

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def generate_token() -> str:
    """Return a fresh random session token (256 bits, URL safe)."""
    return secrets.token_urlsafe(32)


def allowed_hosts(port: int) -> frozenset[str]:
    return frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})


async def _send_error(send: Send, status: int, code: str, message: str) -> None:
    body = json.dumps({"code": code, "message": message}).encode()
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode()),
        (b"cache-control", b"no-store"),
    ]
    if status == 401:
        headers.append((b"www-authenticate", b"Bearer"))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class LocalGuard:
    """ASGI middleware enforcing Host allow-list, session token and security headers."""

    def __init__(self, app: ASGIApp, *, token: str, port: int) -> None:
        self.app = app
        self.token = token.encode()
        self.hosts = allowed_hosts(port)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers: dict[bytes, bytes] = {}
        for key, value in scope["headers"]:
            # Duplicate Host or Authorization headers are suspicious: keep a marker.
            headers[key] = b"\x00dup" if key in headers else value

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = message.get("headers", [])
                extra = list(SECURITY_HEADERS)
                if not any(k.lower() == b"content-security-policy" for k, _ in existing):
                    extra.append((b"content-security-policy", CSP.encode()))  # index sets its own
                message["headers"] = [*existing, *extra]
            await send(message)

        host = headers.get(b"host", b"").decode("latin-1")
        if host not in self.hosts:
            await _send_error(send_with_headers, 400, "invalid_host", "Host header not allowed.")
            return

        length = headers.get(b"content-length", b"0")
        if length.isdigit() and int(length) > MAX_BODY:
            await _send_error(send_with_headers, 413, "too_large", "Request body too large.")
            return

        path: str = scope["path"]
        if path == "/api" or path.startswith("/api/"):
            auth = headers.get(b"authorization", b"")
            scheme, _, presented = auth.partition(b" ")
            if scheme.lower() != b"bearer" or not secrets.compare_digest(
                presented.strip(), self.token
            ):
                await _send_error(
                    send_with_headers, 401, "unauthorized", "Missing or invalid session token."
                )
                return

        await self.app(scope, receive, send_with_headers)


def _error_body(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


BackgroundJob = Callable[[], Coroutine[Any, Any, None]]


def _lifespan(
    jobs: Sequence[BackgroundJob],
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        tasks: list[asyncio.Task[None]] = [asyncio.create_task(job()) for job in jobs]
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    return lifespan


def create_app(
    *,
    token: str,
    port: int,
    static_dir: Path | None = STATIC_DIR,
    background: Sequence[BackgroundJob] = (),
    api: ApiContext | None = None,
) -> FastAPI:
    """Build the application. ``static_dir`` is the compiled frontend (may be missing);
    ``background`` jobs (e.g. the scheduler) run for the lifetime of the server; ``api``
    holds the unlocked service (without it, data endpoints answer 503)."""
    app = FastAPI(
        title="Mecha",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan(background),
    )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return JSONResponse(_error_body(code, str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Never echo the input back: it may contain a secret. Not even field names, which
        # come from the client (a JSON key can be the secret itself): redact and truncate.
        names = sorted({".".join(str(p)[:40] for p in e["loc"]) for e in exc.errors()})
        fields = redact_text(", ".join(names[:10]))
        return JSONResponse(_error_body("invalid_request", f"Invalid fields: {fields}"), 422)

    @app.exception_handler(MechaError)
    async def mecha_error(_: Request, exc: MechaError) -> JSONResponse:
        return error_response(exc)

    app.state.api = api
    app.include_router(health.router, prefix="/api")
    app.include_router(routes.router, prefix="/api")

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
    async def api_not_found(rest: str) -> JSONResponse:
        return JSONResponse(_error_body("not_found", "Unknown API route."), status_code=404)

    if static_dir is not None and (index := static_dir / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=static_dir / "assets", check_dir=False))

        root = static_dir.resolve()
        shell = index.read_text(encoding="utf-8")

        def page() -> HTMLResponse:
            nonce = secrets.token_urlsafe(18)
            return HTMLResponse(
                shell.replace(NONCE_PLACEHOLDER, nonce),
                headers={"cache-control": "no-store", "content-security-policy": csp(nonce)},
            )

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> Response:
            candidate = (root / path).resolve()
            if (
                path
                and path != "index.html"
                and candidate.is_file()
                and candidate.is_relative_to(root)
            ):
                return FileResponse(candidate)
            return page()
    else:

        @app.get("/{path:path}", include_in_schema=False)
        async def fallback(path: str) -> HTMLResponse:
            return HTMLResponse(FALLBACK_HTML)

    app.add_middleware(LocalGuard, token=token, port=port)
    return app
