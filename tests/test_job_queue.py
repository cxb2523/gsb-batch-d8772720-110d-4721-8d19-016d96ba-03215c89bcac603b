"""Job queue runnable-query and cancel-during-run traceability tests."""

from __future__ import annotations

import json
import sys
import unittest
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

MCP_ROOT = Path(__file__).resolve().parents[1] / "bundle" / "source-first-clone" / "mcp"
sys.path.insert(0, str(MCP_ROOT))

from source_first_clone.job_queue import JobQueue, parse_timestamp, utc_now


def fake_runner(status: str, codes: list[str] | None = None) -> Any:
    """Deterministic runner writing the same manifest shape as clone_reference_url."""

    def run(**kwargs: Any) -> dict[str, Any]:
        output_dir = Path(str(kwargs["output_dir"])).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        manifest = {
            "schema_version": 1,
            "run_id": output_dir.name,
            "input": {"url": kwargs["url"]},
            "failure_classification": {
                "status": status,
                "codes": list(codes or []),
                "issues": [
                    {"code": code, "severity": status, "action": "test", "evidence": "test"}
                    for code in (codes or [])
                ],
            },
            "artifacts": {"capture": {}, "reproduction": {}},
        }
        manifest_path = output_dir / "pipeline-run-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        manifest["path"] = str(manifest_path)
        return {
            "url": kwargs["url"],
            "next_action": "test",
            "pipeline_run_manifest": manifest,
        }

    return run


class RunnableQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_queued_jobs_are_runnable_with_attempts(self) -> None:
        queue = JobQueue(self.root / "queued")
        job = queue.enqueue("https://fixture.example/queued")
        runnable = queue.runnable()
        self.assertEqual([entry["id"] for entry in runnable], [job["id"]])
        entry = runnable[0]
        self.assertEqual(entry["state"], "queued")
        self.assertEqual(entry["attempts"], 0)
        self.assertIsNone(entry["next_run_at"])

    def test_due_retry_wait_job_is_runnable(self) -> None:
        queue = JobQueue(self.root / "due", retry_delay_seconds=0)
        job = queue.enqueue("https://fixture.example/due", max_attempts=2)
        result = queue.run_job(
            job["id"],
            runner=fake_runner("manual-review", ["network-replay-limited"]),
            worker_id="test-due",
        )
        self.assertEqual(result["state"], "retry_wait")
        runnable = queue.runnable()
        self.assertEqual([entry["id"] for entry in runnable], [job["id"]])
        entry = runnable[0]
        self.assertEqual(entry["attempts"], 1)
        self.assertEqual(entry["next_run_at"], entry["next_retry_at"])
        self.assertIsNotNone(parse_timestamp(entry["next_run_at"]))

    def test_future_retry_wait_job_is_not_runnable(self) -> None:
        queue = JobQueue(self.root / "future", retry_delay_seconds=3600)
        job = queue.enqueue("https://fixture.example/future", max_attempts=2)
        result = queue.run_job(
            job["id"],
            runner=fake_runner("manual-review", ["network-replay-limited"]),
            worker_id="test-future",
        )
        self.assertEqual(result["state"], "retry_wait")
        self.assertEqual(queue.runnable(), [])
        # But it becomes runnable once next_retry_at has passed.
        future = utc_now() + timedelta(seconds=3601)
        runnable = queue.runnable(now=future)
        self.assertEqual([entry["id"] for entry in runnable], [job["id"]])

    def test_terminal_jobs_are_never_runnable(self) -> None:
        queue = JobQueue(self.root / "terminal", retry_delay_seconds=0)
        succeeded = queue.enqueue("https://fixture.example/succeeded")
        queue.run_job(succeeded["id"], runner=fake_runner("ready"), worker_id="test-terminal")
        cancelled = queue.enqueue("https://fixture.example/cancelled")
        queue.cancel(cancelled["id"], reason="test")
        failed = queue.enqueue("https://fixture.example/failed", max_attempts=1)

        def boom(**kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("no retries left")

        queue.run_job(failed["id"], runner=boom, worker_id="test-terminal")
        self.assertEqual(queue.load(failed["id"])["state"], "failed")
        self.assertEqual(queue.runnable(), [])


class CancelDuringRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def _cancelling_queue(self, name: str) -> tuple[JobQueue, dict[str, Any]]:
        queue = JobQueue(self.root / name, retry_delay_seconds=0)
        job = queue.enqueue(f"https://fixture.example/{name}")
        return queue, job

    def test_result_after_cancel_is_discarded_and_traced(self) -> None:
        queue, job = self._cancelling_queue("cancel-result")
        inner = fake_runner("ready")

        def runner(**kwargs: Any) -> dict[str, Any]:
            queue.cancel(job["id"], reason="operator abort")
            return inner(**kwargs)

        result = queue.run_job(job["id"], runner=runner, worker_id="worker-cancel-result")
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(result["attempts"], 1)
        self.assertIsNone(result["result"])
        events = [entry["event"] for entry in result["history"]]
        self.assertIn("cancelled", events)
        self.assertIn("worker_result_after_cancel", events)
        trace = next(entry for entry in result["history"] if entry["event"] == "worker_result_after_cancel")
        self.assertEqual(trace["worker_id"], "worker-cancel-result")
        self.assertEqual(trace["attempt"], 1)
        # Persisted record matches the returned one.
        persisted = queue.load(job["id"])
        self.assertEqual(persisted["state"], "cancelled")
        self.assertIn("worker_result_after_cancel", [entry["event"] for entry in persisted["history"]])

    def test_exception_after_cancel_is_not_rewritten(self) -> None:
        queue, job = self._cancelling_queue("cancel-exception")

        def runner(**kwargs: Any) -> dict[str, Any]:
            queue.cancel(job["id"], reason="operator abort")
            raise RuntimeError("boom after cancel")

        result = queue.run_job(job["id"], runner=runner, worker_id="worker-cancel-exc")
        self.assertEqual(result["state"], "cancelled")
        self.assertIsNone(result["next_retry_at"])
        self.assertIsNone(result["last_error"])
        events = [entry["event"] for entry in result["history"]]
        self.assertIn("worker_exception_after_cancel", events)
        self.assertNotIn("exception", events)
        trace = next(entry for entry in result["history"] if entry["event"] == "worker_exception_after_cancel")
        self.assertEqual(trace["worker_id"], "worker-cancel-exc")
        self.assertEqual(trace["attempt"], 1)
        self.assertIn("boom after cancel", trace["error"])

    def test_terminal_job_rerun_returns_record_without_new_attempt(self) -> None:
        queue, job = self._cancelling_queue("cancel-rerun")
        queue.cancel(job["id"], reason="operator abort")
        before = queue.load(job["id"])
        rerun = queue.run_job(job["id"], runner=fake_runner("ready"), worker_id="worker-rerun")
        self.assertEqual(rerun["state"], "cancelled")
        self.assertEqual(rerun["attempts"], before["attempts"])
        self.assertEqual(len(rerun["history"]), len(before["history"]))

    def test_uncancelled_exception_still_retries(self) -> None:
        queue = JobQueue(self.root / "retry-path", retry_delay_seconds=0)
        job = queue.enqueue("https://fixture.example/retry-path", max_attempts=2)

        def runner(**kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("transient boom")

        result = queue.run_job(job["id"], runner=runner, worker_id="worker-retry")
        self.assertEqual(result["state"], "retry_wait")
        self.assertIsNotNone(result["next_retry_at"])
        again = queue.run_job(job["id"], runner=runner, worker_id="worker-retry")
        self.assertEqual(again["state"], "failed")
        self.assertIsNone(again["next_retry_at"])


if __name__ == "__main__":
    unittest.main()
