"""Offline tests for scripts/collect_rankings.py.

Every response here is fabricated, so the suite runs with no key and no network. The
fake transport records the arguments it was sent, which is how the "first page carries
q and kl, later pages carry the token alone" rule is asserted rather than assumed.

Run: python -m unittest discover -s test -p "test_collect_rankings.py"
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import collect_rankings as cr  # noqa: E402


def envelope(payload: dict) -> str:
    """The text block the server really returns: a JSON string wrapping ``json``."""
    return json.dumps(
        {"url": "https://html.duckduckgo.com/html", "status": 200, "text": "", "json": payload}
    )


def rpc_response(request_id: int, payload: dict) -> str:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": envelope(payload)}]},
        }
    )


def sse_response(request_id: int, payload: dict) -> str:
    """The same answer over server-sent events, as streamable HTTP may send it."""
    message = {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {"content": [{"type": "text", "text": envelope(payload)}]},
    }
    return "event: message\ndata: " + json.dumps(message) + "\n\n"


def organic(*positions):
    return [{"position": p, "title": f"Result {p}", "link": f"https://example.com/{p}"} for p in positions]


class FakeTransport:
    """Answers each tools/call from a scripted list, recording what it received."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        request = json.loads(body)
        self.calls.append(
            {
                "id": request["id"],
                "method": request["method"],
                "arguments": request["params"].get("arguments", {}),
                "headers": headers,
            }
        )
        step = self.steps.pop(0)
        if callable(step):
            step = step(request)
        if isinstance(step, Exception):
            raise step
        if isinstance(step, cr.HttpResponse):
            return step
        return cr.HttpResponse(200, rpc_response(request["id"], step))


class RecordingSleep:
    def __init__(self):
        self.delays = []

    def __call__(self, seconds):
        self.delays.append(seconds)


def make_task(query="model context protocol", kl="us-en", max_pages=3, task_id=1):
    return {"id": task_id, "query": query, "kl": kl, "maxPages": max_pages}


def collect(task, steps, **kwargs):
    transport = FakeTransport(steps)
    sleep = kwargs.pop("sleep", RecordingSleep())
    kwargs.setdefault("retry_base_delay", 2.0)
    kwargs.setdefault("retry_max_delay", 30.0)
    outcome = cr.collect_task(
        task,
        transport=transport,
        api_key="test-key",
        sleep=sleep,
        **kwargs,
    )
    return outcome, transport, sleep


class PagingTests(unittest.TestCase):
    def test_absolute_rank_accumulates_across_pages(self):
        outcome, transport, _ = collect(
            make_task(max_pages=3),
            [
                {"organicResults": organic(1, 2), "pagination": {"nextPageToken": "tok-1"}},
                {"organicResults": organic(1, 2, 3), "pagination": {"nextPageToken": "tok-2"}},
                {"organicResults": organic(1, 2)},
            ],
        )

        # Page 2's own positions restart at 1; absolute rank continues at 3.
        self.assertEqual(
            [row["absoluteRank"] for row in outcome["results"]], [1, 2, 3, 4, 5, 6, 7]
        )
        self.assertEqual([row["page"] for row in outcome["results"]], [1, 1, 2, 2, 2, 3, 3])
        self.assertEqual(outcome["pagesCollected"], 3)
        self.assertEqual(outcome["pagesSucceeded"], [1, 2, 3])
        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertFalse(outcome["truncatedByMaxPages"])
        self.assertFalse(outcome["hasNextPage"])
        self.assertIsNone(outcome["failedPage"])
        self.assertEqual(outcome["resultsCollected"], 7)

    def test_first_page_sends_q_and_kl_and_later_pages_send_only_the_token(self):
        _, transport, _ = collect(
            make_task(max_pages=2),
            [
                {"organicResults": organic(1), "pagination": {"nextPageToken": "tok-1"}},
                {"organicResults": organic(1)},
            ],
        )

        self.assertEqual(transport.calls[0]["arguments"], {"q": "model context protocol", "kl": "us-en"})
        # A q beside the token is ignored by the server without a warning, so it must
        # never be sent on a later page.
        self.assertEqual(transport.calls[1]["arguments"], {"nextPageToken": "tok-1"})
        self.assertNotIn("q", transport.calls[1]["arguments"])

    def test_max_pages_truncation_is_reported(self):
        outcome, transport, _ = collect(
            make_task(max_pages=2),
            [
                {"organicResults": organic(1), "pagination": {"nextPageToken": "tok-1"}},
                {"organicResults": organic(1), "pagination": {"nextPageToken": "tok-2"}},
            ],
        )

        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertTrue(outcome["truncatedByMaxPages"])
        self.assertTrue(outcome["hasNextPage"])
        self.assertEqual(outcome["resultsCollected"], 2)

    def test_a_repeated_token_stops_instead_of_looping(self):
        outcome, transport, _ = collect(
            make_task(max_pages=5),
            [
                {"organicResults": organic(1), "pagination": {"nextPageToken": "same"}},
                {"organicResults": organic(1), "pagination": {"nextPageToken": "same"}},
            ],
        )

        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertFalse(outcome["truncatedByMaxPages"])

    def test_zero_organics_on_page_still_pages_on(self):
        outcome, transport, _ = collect(
            make_task(max_pages=2),
            [
                {"ads": [{"position": 1}], "pagination": {"nextPageToken": "tok-1"}},
                {"organicResults": organic(1)},
            ],
        )

        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(outcome["resultsCollected"], 1)
        # Page 1 contributed nothing, so the first collected row is rank 1, not 2.
        self.assertEqual(outcome["results"][0]["absoluteRank"], 1)


class MissingKeyTests(unittest.TestCase):
    def test_absent_keys_are_treated_as_empty(self):
        outcome, _, _ = collect(make_task(), [{}])

        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertEqual(outcome["results"], [])
        self.assertEqual(outcome["resultsCollected"], 0)
        self.assertEqual(outcome["pagesCollected"], 1)
        self.assertFalse(outcome["hasNextPage"])
        self.assertFalse(outcome["truncatedByMaxPages"])

    def test_non_list_organic_results_and_null_pagination(self):
        outcome, _, _ = collect(
            make_task(), [{"organicResults": None, "pagination": None, "ads": None, "searchAssist": None}]
        )

        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertEqual(outcome["resultsCollected"], 0)

    def test_entries_without_a_position_get_the_page_place(self):
        outcome, _, _ = collect(
            make_task(),
            [
                {
                    "organicResults": [
                        {"title": "no position"},
                        {"position": None, "title": "null position"},
                        {"position": "2", "title": "string position"},
                    ]
                }
            ],
        )

        self.assertEqual(
            [row["absoluteRank"] for row in outcome["results"]], [1, 2, 3]
        )

    def test_missing_json_field_yields_no_results(self):
        transport = FakeTransport([])
        transport.steps.append(
            cr.HttpResponse(
                200,
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {"content": [{"type": "text", "text": json.dumps({"url": "x"})}]},
                    }
                ),
            )
        )
        transport.steps.append({})
        outcome = cr.collect_task(make_task(), transport=transport, api_key="k", sleep=RecordingSleep())
        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertEqual(outcome["resultsCollected"], 0)


class RateLimitTests(unittest.TestCase):
    def test_concurrency_limit_is_retried_with_growing_waits(self):
        busy = cr.HttpResponse(429, json.dumps({"error": {"code": "concurrency_limit"}}))
        outcome, transport, sleep = collect(
            make_task(max_pages=1),
            [busy, busy, {"organicResults": organic(1)}],
        )

        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(sleep.delays, [2.0, 4.0])
        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertEqual(outcome["rateLimitRetries"], 2)
        self.assertEqual(outcome["pagesCollected"], 1)

    def test_rate_limit_inside_a_tool_error_text_is_also_retried(self):
        limited = cr.HttpResponse(
            200,
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": "429 concurrency_limit"}],
                    },
                }
            ),
        )
        outcome, _, sleep = collect(
            make_task(max_pages=1), [limited, {"organicResults": organic(1)}]
        )

        self.assertEqual(sleep.delays, [2.0])
        self.assertEqual(outcome["status"], cr.STATUS_SUCCESS)
        self.assertEqual(outcome["rateLimitRetries"], 1)

    def test_rate_limit_exhaustion_fails_with_its_category(self):
        busy = cr.HttpResponse(429, "concurrency_limit")
        outcome, transport, sleep = collect(
            make_task(max_pages=2), [busy, busy, busy], retry_attempts=2
        )

        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(sleep.delays, [2.0, 4.0])
        self.assertEqual(outcome["status"], cr.STATUS_FAILED)
        self.assertEqual(outcome["errorCategory"], cr.RATE_LIMITED)
        self.assertEqual(outcome["failedPage"], 1)
        self.assertEqual(outcome["pagesSucceeded"], [])
        self.assertEqual(outcome["rateLimitRetries"], 2)

    def test_waits_are_capped(self):
        busy = cr.HttpResponse(429, "concurrency_limit")
        _, _, sleep = collect(
            make_task(max_pages=1),
            [busy, busy, busy, busy, {"organicResults": organic(1)}],
            retry_attempts=4,
            retry_base_delay=10.0,
            retry_max_delay=25.0,
        )

        self.assertEqual(sleep.delays, [10.0, 20.0, 25.0, 25.0])


class FailureTests(unittest.TestCase):
    def test_authentication_failure_is_not_retried(self):
        denied = cr.HttpResponse(401, "HasData API error: 401 Unauthorized")
        outcome, transport, sleep = collect(make_task(max_pages=3), [denied])

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(sleep.delays, [])
        self.assertEqual(outcome["status"], cr.STATUS_FAILED)
        self.assertEqual(outcome["errorCategory"], cr.AUTH_FAILED)
        self.assertEqual(outcome["failedPage"], 1)
        self.assertEqual(outcome["pagesCollected"], 0)

    def test_auth_error_inside_tool_result_is_classified_and_not_retried(self):
        denied = cr.HttpResponse(
            200,
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": "HasData API error: 401 Unauthorized"}],
                    },
                }
            ),
        )
        outcome, transport, sleep = collect(make_task(max_pages=1), [denied])

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(sleep.delays, [])
        self.assertEqual(outcome["errorCategory"], cr.AUTH_FAILED)

    def test_a_failed_page_keeps_the_pages_already_collected(self):
        outcome, _, _ = collect(
            make_task(max_pages=4),
            [
                {"organicResults": organic(1, 2), "pagination": {"nextPageToken": "tok-1"}},
                {"organicResults": organic(1, 2, 3), "pagination": {"nextPageToken": "tok-2"}},
                cr.HttpResponse(422, "MCP error -32602: Input validation error"),
            ],
        )

        self.assertEqual(outcome["status"], cr.STATUS_PARTIAL)
        self.assertEqual(outcome["failedPage"], 3)
        self.assertEqual(outcome["pagesSucceeded"], [1, 2])
        self.assertEqual(outcome["pagesCollected"], 2)
        self.assertEqual(outcome["resultsCollected"], 5)
        self.assertEqual(outcome["errorCategory"], cr.INVALID_ARGUMENT)
        # After a failed page there is no way to know whether a next page exists.
        self.assertIsNone(outcome["hasNextPage"])
        self.assertEqual([row["absoluteRank"] for row in outcome["results"]], [1, 2, 3, 4, 5])

    def test_network_timeout_is_its_own_category(self):
        timeout = cr.TransportError(cr.NETWORK_TIMEOUT, "request timed out")
        outcome, transport, sleep = collect(make_task(max_pages=2), [timeout])

        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(sleep.delays, [])
        self.assertEqual(outcome["status"], cr.STATUS_FAILED)
        self.assertEqual(outcome["errorCategory"], cr.NETWORK_TIMEOUT)
        self.assertIn("timed out", outcome["errorMessage"])

    def test_unclassified_failure_falls_back_to_other(self):
        outcome, _, _ = collect(make_task(), [cr.HttpResponse(500, "upstream exploded")])

        self.assertEqual(outcome["status"], cr.STATUS_FAILED)
        self.assertEqual(outcome["errorCategory"], cr.OTHER)

    def test_unexpected_transport_exception_becomes_other_not_a_crash(self):
        outcome, _, _ = collect(make_task(), [RuntimeError("socket closed mid-write")])

        self.assertEqual(outcome["status"], cr.STATUS_FAILED)
        self.assertEqual(outcome["errorCategory"], cr.OTHER)
        self.assertIn("socket closed", outcome["errorMessage"])


class WireFormatTests(unittest.TestCase):
    def test_sse_body_is_parsed(self):
        transport = FakeTransport([])
        transport.steps.append(lambda request: cr.HttpResponse(200, sse_response(request["id"], {"organicResults": organic(1)})))
        outcome = cr.collect_task(make_task(), transport=transport, api_key="k", sleep=RecordingSleep())

        self.assertEqual(outcome["resultsCollected"], 1)

    def test_authorization_header_and_tool_name(self):
        _, transport, _ = collect(make_task(max_pages=1), [{}])

        call = transport.calls[0]
        self.assertEqual(call["headers"]["x-api-key"], "test-key")
        self.assertEqual(call["method"], "tools/call")

    def test_response_for_another_request_id_is_not_accepted(self):
        transport = FakeTransport([])
        transport.steps.append(cr.HttpResponse(200, rpc_response(999, {"organicResults": organic(1)})))
        outcome = cr.collect_task(make_task(), transport=transport, api_key="k", sleep=RecordingSleep())

        self.assertEqual(outcome["status"], cr.STATUS_FAILED)
        self.assertEqual(outcome["errorCategory"], cr.OTHER)


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "run.results.json"

    def test_report_is_written_with_every_task_and_summary_counts(self):
        tasks = [
            make_task(task_id="a", query="alpha", max_pages=1),
            make_task(task_id="b", query="beta", kl="de-de"),
        ]
        transport = FakeTransport(
            [
                {"organicResults": organic(1), "pagination": {"nextPageToken": "tok"}},
                cr.HttpResponse(401, "401 Unauthorized"),
            ]
        )
        lines = []
        report = cr.run_batch(
            tasks,
            transport=transport,
            api_key="k",
            out_path=self.out,
            sleep=RecordingSleep(),
            log=lines.append,
            now=lambda: "2026-11-14T00:00:00Z",
        )

        saved = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual([t["id"] for t in saved["tasks"]], ["a", "b"])
        self.assertEqual(saved["tasks"][0]["status"], cr.STATUS_SUCCESS)
        self.assertEqual(saved["tasks"][1]["status"], cr.STATUS_FAILED)
        self.assertEqual(saved["tasks"][0]["hasNextPage"], True)
        # Task a stopped at maxPages=1, so it is flagged as truncated and 0 default.
        self.assertEqual(saved["tasks"][0]["truncatedByMaxPages"], True)
        # maxPages was 3 and only one page was fetched before the failure.
        self.assertEqual(saved["tasks"][1]["pagesCollected"], 0)
        self.assertEqual(report["finishedAt"], "2026-11-14T00:00:00Z")

        buffer = io.StringIO()
        cr.print_summary(report, stream=buffer)
        summary = buffer.getvalue()
        self.assertIn("1 success", summary)
        self.assertIn("1 failed", summary)
        self.assertIn("alpha", summary)
        self.assertIn("authentication failed", summary)

    def test_resume_skips_tasks_with_a_successful_record(self):
        tasks = [make_task(task_id="a", query="alpha"), make_task(task_id="b", query="beta")]
        first = FakeTransport(
            [
                {"organicResults": organic(1), "pagination": {"nextPageToken": "tok"}},
                {"organicResults": organic(1)},
                {"organicResults": organic(1)},
            ]
        )
        cr.run_batch(
            tasks, transport=first, api_key="k", out_path=self.out, sleep=RecordingSleep(), log=lambda _: None
        )
        self.assertEqual(len(first.calls), 3)

        prior = cr.load_prior_report(self.out)
        second = FakeTransport([])
        report = cr.run_batch(
            tasks,
            transport=second,
            api_key="k",
            out_path=self.out,
            prior_records=prior,
            sleep=RecordingSleep(),
            log=lambda _: None,
        )

        self.assertEqual(second.calls, [])
        self.assertEqual([t["status"] for t in report["tasks"]], [cr.STATUS_SUCCESS, cr.STATUS_SUCCESS])

    def test_failed_task_is_skipped_unless_retry_failed(self):
        tasks = [make_task(task_id="a")]
        cr.run_batch(
            tasks,
            transport=FakeTransport([cr.HttpResponse(401, "401")]),
            api_key="k",
            out_path=self.out,
            sleep=RecordingSleep(),
            log=lambda _: None,
        )
        prior = cr.load_prior_report(self.out)

        skipped = FakeTransport([])
        cr.run_batch(
            tasks,
            transport=skipped,
            api_key="k",
            out_path=self.out,
            prior_records=prior,
            sleep=RecordingSleep(),
            log=lambda _: None,
        )
        self.assertEqual(skipped.calls, [])

        retried = FakeTransport([{"organicResults": organic(1)}])
        report = cr.run_batch(
            tasks,
            transport=retried,
            api_key="k",
            out_path=self.out,
            prior_records=prior,
            retry_failed=True,
            sleep=RecordingSleep(),
            log=lambda _: None,
        )
        self.assertEqual(len(retried.calls), 1)
        self.assertEqual(report["tasks"][0]["status"], cr.STATUS_SUCCESS)

    def test_unreadable_existing_report_is_refused(self):
        self.out.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ValueError):
            cr.load_prior_report(self.out)

    def test_interruption_keeps_finished_tasks_and_marks_the_report(self):
        tasks = [make_task(task_id="a", query="alpha"), make_task(task_id="b", query="beta")]

        class InterruptingTransport(FakeTransport):
            def __call__(self, url, headers, body, timeout):
                if self.calls:
                    raise KeyboardInterrupt
                return super().__call__(url, headers, body, timeout)

        transport = InterruptingTransport(
            [{"organicResults": organic(1, 2)}]  # page 1 of task a; only one page
        )
        with self.assertRaises(cr.BatchInterrupted) as ctx:
            cr.run_batch(
                tasks,
                transport=transport,
                api_key="k",
                out_path=self.out,
                sleep=RecordingSleep(),
                log=lambda _: None,
            )

        saved = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertTrue(saved["interrupted"])
        self.assertEqual([t["id"] for t in saved["tasks"]], ["a"])
        self.assertEqual(saved["tasks"][0]["status"], cr.STATUS_SUCCESS)
        self.assertEqual(ctx.exception.report["tasks"][0]["id"], "a")


class TaskListTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, content):
        path = Path(self.tmp.name) / "tasks.json"
        path.write_text(content, encoding="utf-8")
        return path

    def test_bare_array_and_wrapped_object_both_load(self):
        bare = self.write(json.dumps([{"query": "q", "kl": "us-en", "maxPages": 2}]))
        self.assertEqual(cr.load_tasks(bare)[0]["query"], "q")

        wrapped = self.write(
            json.dumps({"tasks": [{"query": "q", "kl": "us-en", "maxPages": 2}]})
        )
        self.assertEqual(cr.load_tasks(wrapped)[0]["maxPages"], 2)

    def test_invalid_entries_are_named(self):
        cases = [
            ([{"kl": "us-en", "maxPages": 1}], "query"),
            ([{"query": "q", "maxPages": 1}], "kl"),
            ([{"query": "q", "kl": "us-en", "maxPages": 0}], "maxPages"),
            ([{"query": "q", "kl": "us-en", "maxPages": "3"}], "maxPages"),
            ([], "non-empty"),
        ]
        for payload, needle in cases:
            with self.subTest(payload=payload):
                path = self.write(json.dumps(payload))
                with self.assertRaises(ValueError) as ctx:
                    cr.load_tasks(path)
                self.assertIn(needle, str(ctx.exception))

    def test_duplicate_tasks_are_rejected_because_resume_keys_collide(self):
        # Two identical tasks would share one (query, kl, maxPages) key, so the second
        # record would overwrite the first on the next resume.
        path = self.write(
            json.dumps(
                [
                    {"query": "q", "kl": "us-en", "maxPages": 2},
                    {"query": "q", "kl": "us-en", "maxPages": 2},
                ]
            )
        )
        with self.assertRaises(ValueError) as ctx:
            cr.load_tasks(path)
        self.assertIn("repeats", str(ctx.exception))

    def test_same_query_in_different_regions_is_not_a_duplicate(self):
        path = self.write(
            json.dumps(
                [
                    {"query": "q", "kl": "us-en", "maxPages": 2},
                    {"query": "q", "kl": "de-de", "maxPages": 2},
                ]
            )
        )
        self.assertEqual([t["kl"] for t in cr.load_tasks(path)], ["us-en", "de-de"])

    def test_missing_key_exits_before_any_request(self):
        path = self.write(json.dumps([{"query": "q", "kl": "us-en", "maxPages": 1}]))
        saved = os.environ.pop(cr.API_KEY_ENV, None)
        if saved is not None:
            self.addCleanup(os.environ.__setitem__, cr.API_KEY_ENV, saved)
        stderr = io.StringIO()
        original = sys.stderr
        sys.stderr = stderr
        try:
            code = cr.main([str(path)])
        finally:
            sys.stderr = original

        self.assertEqual(code, 2)
        self.assertIn(cr.API_KEY_ENV, stderr.getvalue())
        self.assertFalse((Path(self.tmp.name) / "tasks.results.json").exists())

    def test_query_and_kl_travel_into_requests(self):
        outcome, transport, _ = collect(make_task(query="防晒 推荐", kl="jp-jp", max_pages=1), [{}])
        self.assertEqual(transport.calls[0]["arguments"], {"q": "防晒 推荐", "kl": "jp-jp"})
        self.assertEqual(outcome["query"], "防晒 推荐")
        self.assertEqual(outcome["kl"], "jp-jp")


if __name__ == "__main__":
    unittest.main()
