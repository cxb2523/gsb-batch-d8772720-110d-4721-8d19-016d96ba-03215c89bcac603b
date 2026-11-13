#!/usr/bin/env python3
"""Automated tests for tools/scrape.py.

All HTTP is replaced with in-memory fakes and ``socket.socket`` is blocked at
import time, so these tests can never reach the real network or consume real
Decodo credentials. Run with:

    python -I -m unittest discover -s tests -v
"""

import contextlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest

# --- Hard guarantee: no real network I/O from any test -----------------------
# requests/urllib3 ultimately instantiate socket.socket; replacing it with a
# subclass that refuses instantiation means any real connection attempt fails
# loudly instead of silently hitting the internet. It stays subclass-able
# (ssl.SSLSocket subclasses socket.socket at import time) but can never connect.
class _BlockedSocket(socket.socket):
    def __init__(self, *args, **kwargs):  # pragma: no cover - only fires on bug
        raise AssertionError("tests must not perform real network I/O")


socket.socket = _BlockedSocket

TOOLS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "tools"))
if TOOLS_DIR not in sys.path:
    sys.path.insert(0, TOOLS_DIR)

import requests  # noqa: E402
import scrape  # noqa: E402


# --- Fakes -------------------------------------------------------------------
class FakeResponse:
    """Minimal stand-in for requests.Response."""

    def __init__(self, status_code=200, json_data=None, json_error=None, text=""):
        self.status_code = status_code
        self.text = text
        self._json_data = json_data
        self._json_error = json_error

    def json(self):
        if self._json_error is not None:
            raise self._json_error
        return self._json_data


class FakeTransport:
    """Records calls and returns a canned response (or raises a canned error)."""

    def __init__(self, response=None, exc=None):
        self.response = response
        self.exc = exc
        self.calls = []

    def __call__(self, payload, headers):
        self.calls.append({"payload": payload, "headers": headers})
        if self.exc is not None:
            raise self.exc
        return self.response


class GuardTransport:
    """Transport that fails the test if it is ever invoked."""

    def __init__(self):
        self.calls = []

    def __call__(self, payload, headers):
        self.calls.append({"payload": payload, "headers": headers})
        raise AssertionError("validation must happen before any network request")


def content_response(target, content, status_code=200):
    """Build a well-formed API response carrying ``content`` in results[0]."""
    return FakeResponse(
        status_code=status_code,
        json_data={"results": [{"content": content}]},
        text=json.dumps({"results": [{"content": content}]}),
    )


class EnvGuard(unittest.TestCase):
    """Ensure DECODO_AUTH_TOKEN from the outer environment never leaks in."""

    def setUp(self):
        self._saved_token = os.environ.pop("DECODO_AUTH_TOKEN", None)

    def tearDown(self):
        if self._saved_token is not None:
            os.environ["DECODO_AUTH_TOKEN"] = self._saved_token
        else:
            os.environ.pop("DECODO_AUTH_TOKEN", None)


# --- Pre-request validation (no network, no token needed) --------------------
class TestValidation(EnvGuard):
    def test_unknown_target(self):
        guard = GuardTransport()
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "not_a_target", "query": "x"}, token="tok", transport=guard)
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_query_target_requires_query(self):
        guard = GuardTransport()
        for target in scrape.TARGETS_NEED_QUERY:
            with self.subTest(target=target):
                with self.assertRaises(scrape.ScrapeError) as ctx:
                    scrape.run_task({"target": target}, token="tok", transport=guard)
                self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_query_target_rejects_url(self):
        guard = GuardTransport()
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task(
                {"target": "google_search", "url": "https://example.com"},
                token="tok",
                transport=guard,
            )
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_url_target_requires_url(self):
        guard = GuardTransport()
        for target in scrape.TARGETS_NEED_URL:
            with self.subTest(target=target):
                with self.assertRaises(scrape.ScrapeError) as ctx:
                    scrape.run_task({"target": target}, token="tok", transport=guard)
                self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_url_target_rejects_query(self):
        guard = GuardTransport()
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task(
                {"target": "universal", "query": "hello"},
                token="tok",
                transport=guard,
            )
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_blank_string_counts_as_missing(self):
        guard = GuardTransport()
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "amazon_search", "query": "   "}, token="tok", transport=guard)
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_geo_locale_only_valid_for_google_search(self):
        guard = GuardTransport()
        for option in ("geo", "locale"):
            with self.subTest(option=option):
                task = {"target": "universal", "url": "https://example.com", option: "US"}
                with self.assertRaises(scrape.ScrapeError) as ctx:
                    scrape.run_task(task, token="tok", transport=guard)
                self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_non_dict_task(self):
        guard = GuardTransport()
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task("google_search", token="tok", transport=guard)
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(guard.calls, [])

    def test_missing_token_does_not_request(self):
        guard = GuardTransport()
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, transport=guard)
        self.assertEqual(ctx.exception.category, scrape.ERR_MISSING_CREDENTIALS)
        self.assertEqual(guard.calls, [])


# --- Payload construction (the seven preserved request bodies) ---------------
class TestBuildPayload(unittest.TestCase):
    def test_all_seven_payload_shapes(self):
        cases = {
            "google_search": (
                {"target": "google_search", "query": "q"},
                {"target": "google_search", "query": "q", "headless": "html", "parse": True},
            ),
            "youtube_subtitles": (
                {"target": "youtube_subtitles", "query": "vid"},
                {"target": "youtube_subtitles", "query": "vid"},
            ),
            "reddit_post": (
                {"target": "reddit_post", "url": "https://reddit.com/r/x/a"},
                {"target": "reddit_post", "url": "https://reddit.com/r/x/a"},
            ),
            "reddit_subreddit": (
                {"target": "reddit_subreddit", "url": "https://reddit.com/r/x/"},
                {"target": "reddit_subreddit", "url": "https://reddit.com/r/x/"},
            ),
            "amazon": (
                {"target": "amazon", "url": "https://amazon.com/dp/X"},
                {"target": "amazon", "url": "https://amazon.com/dp/X", "parse": True},
            ),
            "amazon_search": (
                {"target": "amazon_search", "query": "laptop"},
                {"target": "amazon_search", "query": "laptop", "parse": True},
            ),
            "universal": (
                {"target": "universal", "url": "https://example.com"},
                {"target": "universal", "url": "https://example.com", "markdown": True},
            ),
        }
        for target, (task, expected) in cases.items():
            with self.subTest(target=target):
                self.assertEqual(scrape.build_payload(task), expected)

    def test_google_geo_locale_passed_through(self):
        payload = scrape.build_payload(
            {"target": "google_search", "query": "q", "geo": "US", "locale": "en"}
        )
        self.assertEqual(payload["geo"], "US")
        self.assertEqual(payload["locale"], "en")

    def test_headers_carry_basic_auth_and_integration(self):
        transport = FakeTransport(response=content_response("universal", "# hi"))
        scrape.run_task({"target": "universal", "url": "https://example.com"}, token="abc", transport=transport)
        headers = transport.calls[0]["headers"]
        self.assertEqual(headers["Authorization"], "Basic abc")
        self.assertEqual(headers["x-integration"], "openclaw")
        self.assertEqual(headers["Content-Type"], "application/json")


# --- Response handling paths -------------------------------------------------
class TestRunTaskResponses(EnvGuard):
    def test_success_every_target(self):
        expected = {
            "google_search": (
                {"results": {"results": [{"title": "hit"}]}},
                [{"title": "hit"}],
            ),
            "amazon_search": ({"results": [{"asin": "B1"}]}, [{"asin": "B1"}]),
            "amazon": ({"results": [{"asin": "B2"}]}, [{"asin": "B2"}]),
            "reddit_post": ({"post": {"title": "t"}, "comments": []}, {"post": {"title": "t"}, "comments": []}),
            "reddit_subreddit": ({"posts": [1, 2]}, {"posts": [1, 2]}),
            "universal": ("# markdown body", "# markdown body"),
            "youtube_subtitles": ("subtitle text", "subtitle text"),
        }
        for target, (content, want) in expected.items():
            with self.subTest(target=target):
                transport = FakeTransport(response=content_response(target, content))
                task = (
                    {"target": target, "query": "q"}
                    if target in scrape.TARGETS_NEED_QUERY
                    else {"target": target, "url": "https://example.com"}
                )
                got = scrape.run_task(task, token="tok", transport=transport)
                self.assertEqual(got, want)
                self.assertEqual(len(transport.calls), 1)

    def test_missing_results_key_is_structure_error(self):
        transport = FakeTransport(
            response=FakeResponse(status_code=200, json_data={}, text="{}")
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_RESPONSE_STRUCTURE)

    def test_empty_results_list_is_structure_error(self):
        transport = FakeTransport(
            response=FakeResponse(status_code=200, json_data={"results": []}, text='{"results":[]}')
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_RESPONSE_STRUCTURE)

    def test_missing_content_field_is_structure_error(self):
        transport = FakeTransport(
            response=FakeResponse(
                status_code=200, json_data={"results": [{"other": 1}]}, text='{"results":[{"other":1}]}'
            )
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_RESPONSE_STRUCTURE)

    def test_explicit_null_content_is_structure_error(self):
        transport = FakeTransport(
            response=FakeResponse(
                status_code=200, json_data={"results": [{"content": None}]}, text='{"results":[{"content":null}]}'
            )
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_RESPONSE_STRUCTURE)

    def test_google_inner_results_missing_is_structure_error(self):
        transport = FakeTransport(
            response=content_response("google_search", {"unexpected": {}})
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "google_search", "query": "q"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_RESPONSE_STRUCTURE)

    def test_amazon_inner_results_missing_is_structure_error(self):
        for target in ("amazon", "amazon_search"):
            with self.subTest(target=target):
                transport = FakeTransport(response=content_response(target, {"unexpected": {}}))
                task = (
                    {"target": target, "url": "https://example.com"}
                    if target == "amazon"
                    else {"target": target, "query": "q"}
                )
                with self.assertRaises(scrape.ScrapeError) as ctx:
                    scrape.run_task(task, token="tok", transport=transport)
                self.assertEqual(ctx.exception.category, scrape.ERR_RESPONSE_STRUCTURE)

    def test_non_json_body_is_invalid_response(self):
        transport = FakeTransport(
            response=FakeResponse(
                status_code=200,
                json_error=requests.JSONDecodeError("Expecting value", "<html>", 0),
                text="<html>oops</html>",
            )
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_RESPONSE)

    def test_http_403_is_request_failed(self):
        transport = FakeTransport(
            response=FakeResponse(
                status_code=403,
                json_data={"message": "forbidden"},
                text='{"message":"forbidden"}',
            )
        )
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_REQUEST_FAILED)
        self.assertEqual(ctx.exception.details.get("status_code"), 403)

    def test_http_500_is_request_failed(self):
        transport = FakeTransport(response=FakeResponse(status_code=500, json_data={}, text="{}"))
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_REQUEST_FAILED)
        self.assertEqual(ctx.exception.details.get("status_code"), 500)

    def test_connection_error_is_request_failed(self):
        transport = FakeTransport(exc=requests.ConnectionError("boom"))
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_task({"target": "universal", "url": "https://example.com"}, token="tok", transport=transport)
        self.assertEqual(ctx.exception.category, scrape.ERR_REQUEST_FAILED)
        self.assertEqual(ctx.exception.details.get("status_code"), None)


# --- Batch execution ---------------------------------------------------------
class TestBatch(EnvGuard):
    def test_mixed_outcomes_isolated_and_ordered(self):
        ok_universal = content_response("universal", "# page")
        bad_json = FakeResponse(
            status_code=200,
            json_error=requests.JSONDecodeError("Expecting value", "x", 0),
            text="x",
        )
        ok_reddit = content_response("reddit_post", {"post": {"id": "1"}})
        transport = FakeTransport()
        transport.response = None

        # Sequence responses per call.
        responses = [ok_universal, bad_json, ok_reddit]

        def seq(payload, headers):
            transport.calls.append({"payload": payload, "headers": headers})
            return responses[len(transport.calls) - 1]

        tasks = [
            {"target": "universal", "url": "https://example.com"},
            {"target": "reddit_subreddit", "url": "https://reddit.com/r/x/"},
            {"target": "reddit_post", "url": "https://reddit.com/r/x/c/1"},
        ]
        summary, has_failure = scrape.run_batch(tasks, token="tok", transport=seq)

        self.assertTrue(has_failure)
        self.assertEqual(summary["total"], 3)
        self.assertEqual(summary["succeeded"], 2)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual([item["index"] for item in summary["results"]], [0, 1, 2])
        self.assertEqual([item["target"] for item in summary["results"]], [t["target"] for t in tasks])

        self.assertEqual(summary["results"][0]["status"], "success")
        self.assertEqual(summary["results"][0]["result"], "# page")

        self.assertEqual(summary["results"][1]["status"], "failed")
        self.assertEqual(summary["results"][1]["error_category"], scrape.ERR_INVALID_RESPONSE)
        self.assertTrue(summary["results"][1]["error"])

        # Task 2 still runs despite task 1's failure.
        self.assertEqual(summary["results"][2]["status"], "success")
        self.assertEqual(summary["results"][2]["result"], {"post": {"id": "1"}})

    def test_all_success_exit_flag_false(self):
        transport = FakeTransport(response=content_response("youtube_subtitles", "transcript"))
        tasks = [
            {"target": "youtube_subtitles", "query": "v1"},
            {"target": "youtube_subtitles", "query": "v2"},
        ]
        summary, has_failure = scrape.run_batch(tasks, token="tok", transport=transport)
        self.assertFalse(has_failure)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(summary["succeeded"], 2)
        self.assertEqual(len(transport.calls), 2)

    def test_invalid_tasks_never_hit_network(self):
        transport = GuardTransport()
        tasks = [
            {"target": "mystery", "query": "q"},          # unknown target
            {"target": "google_search"},                  # missing query
            {"target": "universal", "query": "x"},        # mismatch
            {"target": "amazon", "url": "https://a.com", "geo": "US"},  # geo misuse
        ]
        summary, has_failure = scrape.run_batch(tasks, token="tok", transport=transport)
        self.assertTrue(has_failure)
        self.assertEqual(summary["total"], 4)
        self.assertEqual(summary["succeeded"], 0)
        self.assertEqual(transport.calls, [])
        for item in summary["results"]:
            self.assertEqual(item["status"], "failed")
            self.assertEqual(item["error_category"], scrape.ERR_INVALID_PARAMETERS)

    def test_missing_token_reports_credentials_without_requests(self):
        transport = GuardTransport()
        tasks = [
            {"target": "universal", "url": "https://example.com"},  # valid, no token
            {"target": "google_search"},                             # invalid anyway
        ]
        summary, has_failure = scrape.run_batch(tasks, token=None, transport=transport)
        self.assertTrue(has_failure)
        self.assertEqual(transport.calls, [])
        self.assertEqual(summary["results"][0]["error_category"], scrape.ERR_MISSING_CREDENTIALS)
        # Per-item validation takes precedence over the credential check.
        self.assertEqual(summary["results"][1]["error_category"], scrape.ERR_INVALID_PARAMETERS)

    def test_empty_batch(self):
        summary, has_failure = scrape.run_batch([], token="tok", transport=GuardTransport())
        self.assertFalse(has_failure)
        self.assertEqual(summary["total"], 0)
        self.assertEqual(summary["results"], [])

    def test_non_list_batch_input(self):
        with self.assertRaises(scrape.ScrapeError) as ctx:
            scrape.run_batch({"target": "universal"}, token="tok")
        self.assertEqual(ctx.exception.category, scrape.ERR_INVALID_PARAMETERS)


# --- CLI wiring (main, batch files, stdin) -----------------------------------
class TestCLI(EnvGuard):
    def setUp(self):
        super().setUp()
        os.environ["DECODO_AUTH_TOKEN"] = "test-token"
        self._orig_transport = scrape._default_transport
        self.fake = FakeTransport(response=content_response("universal", "# ok"))
        scrape._default_transport = lambda payload, headers: self.fake(payload, headers)

    def tearDown(self):
        scrape._default_transport = self._orig_transport
        super().tearDown()

    def test_single_cli_success_exit_zero(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = scrape.main(["--target", "universal", "--url", "https://example.com"])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().strip(), "# ok")

    def test_single_cli_validation_error_exit_one_and_json_on_stderr(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = scrape.main(["--target", "google_search", "--url", "https://example.com"])
        self.assertEqual(code, 1)
        payload = json.loads(err.getvalue())
        self.assertEqual(payload["error_category"], scrape.ERR_INVALID_PARAMETERS)
        self.assertEqual(self.fake.calls, [])

    def test_single_cli_missing_token_exit_one(self):
        os.environ.pop("DECODO_AUTH_TOKEN", None)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = scrape.main(["--target", "universal", "--url", "https://example.com"])
        self.assertEqual(code, 1)
        payload = json.loads(err.getvalue())
        self.assertEqual(payload["error_category"], scrape.ERR_MISSING_CREDENTIALS)
        self.assertEqual(self.fake.calls, [])

    def test_batch_file_all_success_exit_zero(self):
        tasks = [
            {"target": "universal", "url": "https://example.com"},
            {"target": "universal", "url": "https://example.org"},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            json.dump(tasks, fh)
            path = fh.name
        try:
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = scrape.main(["--batch-file", path])
            self.assertEqual(code, 0)
            summary = json.loads(out.getvalue())
            self.assertEqual(summary["total"], 2)
            self.assertTrue(all(item["status"] == "success" for item in summary["results"]))
        finally:
            os.unlink(path)

    def test_batch_file_with_failure_exit_one(self):
        self.fake.response = FakeResponse(
            status_code=502, json_data={}, text="{}"
        )
        tasks = [{"target": "universal", "url": "https://example.com"}]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            json.dump(tasks, fh)
            path = fh.name
        try:
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = scrape.main(["--batch-file", path])
            self.assertEqual(code, 1)
            summary = json.loads(out.getvalue())
            self.assertEqual(summary["results"][0]["error_category"], scrape.ERR_REQUEST_FAILED)
        finally:
            os.unlink(path)

    def test_batch_file_wrapped_object_form(self):
        tasks = {"tasks": [{"target": "universal", "url": "https://example.com"}]}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            json.dump(tasks, fh)
            path = fh.name
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = scrape.main(["--batch-file", path])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["total"], 1)
        finally:
            os.unlink(path)

    def test_batch_stdin(self):
        from unittest.mock import patch

        tasks = [{"target": "universal", "url": "https://example.com"}]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                patch.object(sys, "stdin", io.StringIO(json.dumps(tasks))):
            code = scrape.main(["--batch-file", "-"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["results"][0]["status"], "success")

    def test_batch_malformed_json(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            fh.write("{not json")
            path = fh.name
        try:
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = scrape.main(["--batch-file", path])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(err.getvalue())["error_category"], scrape.ERR_INVALID_PARAMETERS)
        finally:
            os.unlink(path)

    def test_batch_flag_rejects_single_task_flags(self):
        with self.assertRaises(SystemExit) as ctx:
            scrape.main(["--batch-file", "x.json", "--target", "universal"])
        self.assertEqual(ctx.exception.code, 2)


# --- End-to-end CLI in a subprocess (validation paths only; still no network) -
class TestSubprocessCLI(EnvGuard):
    REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    SCRIPT = os.path.join(REPO_ROOT, "tools", "scrape.py")

    def _clean_env(self):
        # Minimal environment: explicitly no DECODO_AUTH_TOKEN.
        keep = {}
        for key in ("PATH", "SystemRoot", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP"):
            if key in os.environ:
                keep[key] = os.environ[key]
        return keep

    def _run(self, args, stdin_text=None):
        return subprocess.run(
            [sys.executable, "-I", self.SCRIPT, *args],
            input=stdin_text,
            capture_output=True,
            text=True,
            cwd=self.REPO_ROOT,
            env=self._clean_env(),
            timeout=60,
        )

    def test_batch_missing_token_subprocess(self):
        tasks = [{"target": "universal", "url": "https://example.com"}]
        proc = self._run(["--batch-file", "-"], stdin_text=json.dumps(tasks))
        self.assertEqual(proc.returncode, 1)
        summary = json.loads(proc.stdout)
        self.assertEqual(summary["results"][0]["error_category"], scrape.ERR_MISSING_CREDENTIALS)

    def test_batch_invalid_task_subprocess(self):
        tasks = [{"target": "unknown_target", "query": "q"}]
        proc = self._run(["--batch-file", "-"], stdin_text=json.dumps(tasks))
        self.assertEqual(proc.returncode, 1)
        summary = json.loads(proc.stdout)
        self.assertEqual(summary["results"][0]["error_category"], scrape.ERR_INVALID_PARAMETERS)

    def test_single_missing_token_subprocess(self):
        proc = self._run(["--target", "universal", "--url", "https://example.com"])
        self.assertEqual(proc.returncode, 1)
        payload = json.loads(proc.stderr)
        self.assertEqual(payload["error_category"], scrape.ERR_MISSING_CREDENTIALS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
