"""Shared fixtures for the Abrasio test suite.

The batch-fetch tests run against a local threaded HTTP server instead of the
internet. It exposes:

* ``/ok/<n>``          – a normal page with a title and body text
* ``/slow/<seconds>``  – sleeps before responding (drives timeout tests)
* ``/empty``           – a 200 page with no visible body text
* ``/blocked``         – a 403 page (site refuses the request)
* ``/flaky/<n>``       – 503 for the first ``n`` hits, then a normal page
* ``/challenge``       – a 200 Cloudflare-style challenge page

A ``page_factory``-style fixture is provided by the batch tests themselves; the
real-browser end-to-end test lives in ``test_fetch_pages.py``.
"""

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence test output
        pass

    def _send(self, status, body, content_type="text/html; charset=utf-8"):
        raw = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split("?")[0]
        server = self.server
        server.hits[path] = server.hits.get(path, 0) + 1
        server.request_log.append((path, time.monotonic()))

        if path.startswith("/ok/"):
            n = path.rsplit("/", 1)[-1]
            self._send(
                200,
                f"<html><head><title>Page {n}</title></head>"
                f"<body><h1>Heading {n}</h1><p>Body text for page {n}.</p></body></html>",
            )
            return

        if path.startswith("/slow/"):
            seconds = float(path.rsplit("/", 1)[-1])
            time.sleep(seconds)
            self._send(200, "<html><head><title>Slow</title></head><body>late</body></html>")
            return

        if path == "/empty":
            self._send(200, "<html><head><title>Nothing here</title></head><body>  </body></html>")
            return

        if path == "/blocked":
            self._send(403, "<html><head><title>Forbidden</title></head><body>no</body></html>")
            return

        if path.startswith("/flaky/"):
            failures = int(path.rsplit("/", 1)[-1])
            if server.hits[path] <= failures:
                self._send(503, "<html><body>temporarily unavailable</body></html>")
            else:
                self._send(
                    200,
                    "<html><head><title>Flaky recovered</title></head>"
                    "<body><p>Finally made it.</p></body></html>",
                )
            return

        if path == "/challenge":
            self._send(
                200,
                "<html><head><title>Just a moment...</title></head><body>"
                "<script src='https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'>"
                "</script></body></html>",
            )
            return

        self._send(404, "<html><body>not found</body></html>")


@pytest.fixture(scope="session")
def http_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    server.hits = {}
    server.request_log = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def base_url(http_server):
    host, port = http_server.server_address[:2]
    return f"http://{host}:{port}"


@pytest.fixture
def reset_server(http_server):
    """Reset hit counters between tests."""
    http_server.hits.clear()
    http_server.request_log.clear()
    return http_server
