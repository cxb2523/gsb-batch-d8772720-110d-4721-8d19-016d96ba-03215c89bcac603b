"""Per-page outcome JSON files written next to the Markdown results."""

import json
from types import SimpleNamespace

import anyio
import pytest

from crawl4ai_mcp_llm import server
from crawl4ai_mcp_llm.crawler import (
    INTERRUPTION_CLIENT_CANCELLED,
    INTERRUPTION_TIMEOUT,
    OUTCOME_FORBIDDEN,
    OUTCOME_INTERRUPTED,
    OUTCOME_NO_CONTENT,
    OUTCOME_NOT_FOUND,
    OUTCOME_SUCCESS,
    crawl_and_output_to_markdown,
    results_to_markdown,
)
from crawl4ai_mcp_llm.results import read_result
from crawl4ai_mcp_llm.security import resolve_output_path


def make_result(i, error_type=None, url=None):
    if error_type == "missing":
        markdown, title, status = None, "No content", None
    elif error_type == "404":
        markdown, title, status = "404 Not Found nginx", "404 Not Found", 404
    elif error_type == "403":
        markdown, title, status = "403 Forbidden nginx", "403 Forbidden", 403
    else:
        markdown, title, status = f"# Page {i}\nTest content.", f"Test Page {i}", 200
    return SimpleNamespace(
        url=url or f"https://example.com/page{i}",
        markdown=markdown,
        metadata={"title": title, "depth": 1},
        status_code=status,
        success=True,
        links={"internal": [], "external": []},
    )


async def slow_stream(results, delay):
    for result in results:
        await anyio.sleep(delay)
        yield result


def load_outcome(results_dir, name="notes.json"):
    return json.loads((results_dir / name).read_text(encoding="utf-8"))


# --- full per-page outcome document ---------------------------------------------


@pytest.mark.anyio
async def test_outcome_json_covers_success_and_every_failure_category(fake_crawler, results_dir):
    fake_crawler.results = [
        make_result(1),
        make_result(2, "404"),
        make_result(3, "403"),
        make_result(4, "missing"),
        make_result(5),
    ]

    result = await crawl_and_output_to_markdown("https://example.com", output_file="notes")

    assert result["error"] is None
    md_path = results_dir / "notes.md"
    json_path = results_dir / "notes.json"
    assert md_path.is_file() and json_path.is_file()
    assert result["outcome_file_path"] == str(json_path)

    document = load_outcome(results_dir)
    assert document["url"] == "https://example.com"
    assert document["interrupted"] is False
    assert document["interruption_reason"] is None
    assert document["stats"]["successful_pages"] == 2
    assert document["stats"]["not_found_pages"] == 1
    assert document["stats"]["forbidden_pages"] == 1
    assert document["stats"]["failed_pages"] == 1

    pages = {page["url"]: page for page in document["pages"]}
    assert [page["url"] for page in document["pages"]] == [f"https://example.com/page{i}" for i in range(1, 6)]
    assert pages["https://example.com/page1"]["outcome"] == OUTCOME_SUCCESS
    assert pages["https://example.com/page1"]["reason"] is None
    page404 = pages["https://example.com/page2"]
    assert page404["outcome"] == OUTCOME_NOT_FOUND
    assert "404" in page404["reason"]
    page403 = pages["https://example.com/page3"]
    assert page403["outcome"] == OUTCOME_FORBIDDEN
    assert "403" in page403["reason"]
    missing = pages["https://example.com/page4"]
    assert missing["outcome"] == OUTCOME_NO_CONTENT
    assert missing["reason"]
    assert pages["https://example.com/page5"]["outcome"] == OUTCOME_SUCCESS
    # Every processed page, successes included, is present.
    assert len(document["pages"]) == 5


@pytest.mark.anyio
async def test_outcome_json_is_not_capped_at_20_failures(fake_crawler, results_dir):
    fake_crawler.results = [make_result(1)] + [
        make_result(i, "missing", url=f"https://example.com/missing{i}") for i in range(2, 30)
    ]

    result = await crawl_and_output_to_markdown("https://example.com", output_file="many")

    assert result["error"] is None
    document = load_outcome(results_dir, "many.json")
    assert len(document["pages"]) == 29
    assert sum(page["outcome"] == OUTCOME_NO_CONTENT for page in document["pages"]) == 28
    assert [page["url"] for page in document["pages"]][-1] == "https://example.com/missing29"


# --- overwrite / pre-existing outcome file --------------------------------------


@pytest.mark.anyio
async def test_existing_outcome_file_rejects_request_before_browser_starts(fake_crawler, results_dir):
    results_dir.mkdir(parents=True, exist_ok=True)
    (results_dir / "notes.json").write_text('{"stale": true}', encoding="utf-8")

    result = await crawl_and_output_to_markdown("https://example.com", output_file="notes", overwrite=False)

    assert result["error"]
    assert "already exists" in result["error"]
    assert fake_crawler.calls == []  # browser never started
    # The pre-existing file is untouched and no partial pair was written.
    assert (results_dir / "notes.json").read_text(encoding="utf-8") == '{"stale": true}'
    assert not (results_dir / "notes.md").exists()


def test_resolve_output_path_rejects_existing_outcome_file(tmp_path):
    (tmp_path / "report.json").write_text("{}", encoding="utf-8")

    with pytest.raises(Exception, match="already exists"):
        resolve_output_path("report", tmp_path)

    # overwrite=true still allows replacing the pair.
    assert resolve_output_path("report", tmp_path, overwrite=True) == tmp_path / "report.md"


@pytest.mark.anyio
async def test_overwrite_replaces_markdown_and_outcome_pair(fake_crawler, results_dir):
    fake_crawler.results = [make_result(1)]
    first = await crawl_and_output_to_markdown("https://example.com", output_file="notes")
    assert first["error"] is None

    fake_crawler.results = [make_result(1), make_result(2)]
    second = await crawl_and_output_to_markdown("https://example.com", output_file="notes", overwrite=True)

    assert second["error"] is None
    document = load_outcome(results_dir)
    assert len(document["pages"]) == 2


@pytest.mark.anyio
async def test_generated_name_with_existing_outcome_file_fails_before_browser(fake_crawler, results_dir, monkeypatch):
    results_dir.mkdir(parents=True, exist_ok=True)

    # Pin the generated Markdown name so its paired outcome file can be pre-created.
    generated = "crawl_example_com_20260101_120000_abc123.md"
    monkeypatch.setattr(
        "crawl4ai_mcp_llm.crawler.generate_filename_from_url", lambda url: generated
    )
    (results_dir / "crawl_example_com_20260101_120000_abc123.json").write_text("{}", encoding="utf-8")

    result = await crawl_and_output_to_markdown("https://example.com")

    assert result["error"]
    assert "already exists" in result["error"]
    assert fake_crawler.calls == []


@pytest.mark.anyio
async def test_outcome_write_failure_does_not_lose_the_markdown_result(tmp_path, monkeypatch):
    async def failing_write(outcome_path, document):
        raise OSError("disk full")

    monkeypatch.setattr("crawl4ai_mcp_llm.crawler._write_outcome_file", failing_write)

    outcome = await results_to_markdown(
        [make_result(1)],
        str(tmp_path / "out.md"),
        start_url="https://example.com",
        outcome_path=str(tmp_path / "out.json"),
    )

    # Best-effort persistence: the crawl still succeeds and keeps outcomes in memory.
    assert outcome["error"] is None
    assert (tmp_path / "out.md").is_file()
    assert not (tmp_path / "out.json").exists()
    assert [page["outcome"] for page in outcome["pages"]] == [OUTCOME_SUCCESS]


# --- timeout and client cancellation --------------------------------------------


@pytest.mark.anyio
async def test_timeout_keeps_outcomes_of_processed_pages(tmp_path):
    output_path = tmp_path / "out.md"
    deadline = anyio.current_time() + 0.15

    outcome = await results_to_markdown(
        slow_stream([make_result(i) for i in range(50)], delay=0.05),
        str(output_path),
        deadline=deadline,
        start_url="https://example.com",
        outcome_path=str(tmp_path / "out.json"),
    )

    assert outcome["error"] is None
    assert outcome["timed_out"] is True
    assert outcome["interrupted"] is True
    assert outcome["interruption_reason"] == INTERRUPTION_TIMEOUT
    document = json.loads((tmp_path / "out.json").read_text(encoding="utf-8"))
    assert document["interrupted"] is True
    assert document["interruption_reason"] == INTERRUPTION_TIMEOUT
    processed_urls = {page["url"] for page in document["pages"]}
    assert 0 < len(processed_urls) < 50
    # Pages the crawler never reached must not appear.
    assert "https://example.com/page49" not in processed_urls
    assert all(page["outcome"] == OUTCOME_SUCCESS for page in document["pages"])


@pytest.mark.anyio
async def test_client_cancellation_flushes_processed_outcomes_and_marks_interrupted(tmp_path, monkeypatch):
    output_path = tmp_path / "out.md"
    outcome_path = tmp_path / "out.json"
    format_started = anyio.Event()
    release_format = anyio.Event()

    async def blocking_run_sync(func, *args, **kwargs):
        # Only block the (CPU-bound) Markdown formatting; file flushing must stay usable.
        if getattr(func, "__name__", "") == "_format_markdown_page":
            format_started.set()
            await release_format.wait()
        return func(*args)

    monkeypatch.setattr("crawl4ai_mcp_llm.crawler.anyio.to_thread.run_sync", blocking_run_sync)

    async def run_crawl():
        await results_to_markdown(
            slow_stream([make_result(i) for i in range(20)], delay=0.02),
            str(output_path),
            start_url="https://example.com",
            outcome_path=str(outcome_path),
        )

    # Cancel while the first page is still being formatted, then release the
    # worker thread so the shielded cleanup can finish.
    with anyio.move_on_after(0.2) as scope:
        async with anyio.create_task_group() as task_group:

            async def cancel_soon():
                await format_started.wait()
                scope.cancel()
                release_format.set()

            task_group.start_soon(cancel_soon)
            task_group.start_soon(run_crawl)

    assert scope.cancel_called
    document = json.loads(outcome_path.read_text(encoding="utf-8"))
    assert document["interrupted"] is True
    assert document["interruption_reason"] == INTERRUPTION_CLIENT_CANCELLED
    assert document["pages"], "the page in flight must still be recorded"
    assert document["pages"][-1]["outcome"] == OUTCOME_INTERRUPTED
    assert document["pages"][-1]["reason"] == INTERRUPTION_CLIENT_CANCELLED
    assert len(document["pages"]) < 20  # unprocessed pages are absent
    assert "https://example.com/page19" not in {page["url"] for page in document["pages"]}


@pytest.mark.anyio
async def test_cancellation_between_pages_flushes_all_processed_outcomes(tmp_path):
    output_path = tmp_path / "out.md"
    outcome_path = tmp_path / "out.json"

    with anyio.move_on_after(0.15):
        await results_to_markdown(
            slow_stream([make_result(i) for i in range(20)], 0.05),
            str(output_path),
            start_url="https://example.com",
            outcome_path=str(outcome_path),
        )

    document = json.loads(outcome_path.read_text(encoding="utf-8"))
    assert document["interrupted"] is True
    assert document["interruption_reason"] == INTERRUPTION_CLIENT_CANCELLED
    assert 0 < len(document["pages"]) < 20
    assert all(set(page) == {"url", "outcome", "reason"} for page in document["pages"])


# --- crawl_page writes nothing ---------------------------------------------------


@pytest.mark.anyio
async def test_crawl_page_produces_no_outcome_file(monkeypatch, fake_crawler, results_dir):
    from crawl4ai_mcp_llm.crawler import CrawlerManager

    monkeypatch.setattr(server, "crawler_manager", CrawlerManager())
    fake_crawler.results = [make_result(1)]

    result = await server.app.call_tool("crawl_page", {"url": "https://example.com/page1"})

    assert result.is_error is False
    assert not results_dir.exists() or not any(results_dir.iterdir())


@pytest.mark.anyio
async def test_write_file_false_keeps_outcomes_in_memory_only(fake_crawler, results_dir):
    fake_crawler.results = [make_result(1), make_result(2, "missing")]

    result = await crawl_and_output_to_markdown("https://example.com", write_file=False)

    assert result["error"] is None
    assert result["file_path"] is None
    assert result["outcome_file_path"] is None
    assert [page["outcome"] for page in result["pages"]] == [OUTCOME_SUCCESS, OUTCOME_NO_CONTENT]
    assert not results_dir.exists() or not any(results_dir.iterdir())


# --- concurrency and resource access ---------------------------------------------


class _ManagerBackedBy:
    """CrawlerManager stand-in serving one deterministic fake crawler."""

    def __init__(self, crawler):
        self._crawler = crawler

    async def expire_idle_sessions(self):
        return []

    @property
    def limiter(self):
        return _NullLimiter()

    async def get(self):
        return self._crawler

    def touch_session(self, session_id):
        pass


class _NullLimiter:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.mark.anyio
async def test_concurrent_crawls_write_complete_independent_outcome_files(fake_crawler, results_dir):
    async def crawl(name, count):
        crawler = type(fake_crawler)(
            results=[make_result(i, url=f"https://{name}.example/page{i}") for i in range(count)]
        )
        return await crawl_and_output_to_markdown(
            f"https://{name}.example", output_file=name, crawler_manager=_ManagerBackedBy(crawler)
        )

    result_a, result_b = await anyio.gather(crawl("alpha", 12), crawl("beta", 7))

    assert result_a["error"] is None and result_b["error"] is None
    alpha = load_outcome(results_dir, "alpha.json")
    beta = load_outcome(results_dir, "beta.json")
    assert len(alpha["pages"]) == 12
    assert len(beta["pages"]) == 7
    assert {page["url"].split("/")[2] for page in alpha["pages"]} == {"alpha.example"}
    assert {page["url"].split("/")[2] for page in beta["pages"]} == {"beta.example"}
    assert not list(results_dir.rglob("*.tmp"))


@pytest.mark.anyio
async def test_outcome_file_is_readable_through_crawl_results_resource(fake_crawler, results_dir):
    fake_crawler.results = [make_result(1), make_result(2, "404")]
    await crawl_and_output_to_markdown("https://example.com", output_file="notes")

    raw = await read_result("notes.json", results_dir)
    document = json.loads(raw)
    assert {page["outcome"] for page in document["pages"]} == {OUTCOME_SUCCESS, OUTCOME_NOT_FOUND}

    resource = list(await server.app.read_resource("crawl://results/notes.json"))
    assert json.loads(resource[0].content)["pages"] == document["pages"]


@pytest.mark.anyio
async def test_summary_points_to_outcome_file_when_more_than_20_skipped(fake_crawler, results_dir):
    fake_crawler.results = [make_result(i, "missing", url=f"https://example.com/missing{i}") for i in range(25)]
    outcome = await crawl_and_output_to_markdown("https://example.com", output_file="notes")

    text = server.format_crawl_summary("https://example.com", outcome, False, results_dir)

    assert "and 5 more" in text
    assert "crawl://results/notes.json" in text
    assert "Full list of all 25 skipped pages" in text


@pytest.mark.anyio
async def test_summary_includes_outcome_resource_for_normal_crawl(fake_crawler, results_dir):
    fake_crawler.results = [make_result(1)]
    outcome = await crawl_and_output_to_markdown("https://example.com", output_file="notes")

    text = server.format_crawl_summary("https://example.com", outcome, False, results_dir)

    assert "- Resource: crawl://results/notes.md" in text
    assert "- Outcome file: crawl://results/notes.json" in text
