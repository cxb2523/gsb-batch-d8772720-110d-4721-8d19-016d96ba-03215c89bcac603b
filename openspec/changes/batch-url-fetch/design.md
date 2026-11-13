## Context

Batch mode reuses the extraction of a single page unchanged. The one URL path and the batch path share the same function, so the per-page behaviour cannot drift.

## Goals / Non-Goals

- Goals: one URL per line, page failures isolated, retries only where they can help, a machine-readable per-page report, a summary that names the failed pages.
- Non-goals: parallel requests, a configurable delay between attempts, streaming, a different extraction per URL.

## Decisions

- **Sequential requests.** Simple, and the order of the output matches the file. Parallelism would need its own ordering and rate-limit rules.
- **An empty URL list is a successful run.** It prints `0/0 pages ok` and exits 0: nothing failed.
- **Fetched bytes are read inside the retry loop**, so a truncated download is a network error and gets the same retries as a connection error.
- **`error` is a short string**, such as `HTTP 404`, `timeout` or `connection error`; the destination is the summary line and the JSONL field, not a stack trace.
- **Not an http or https URL counts as a page failure, attempted once.** Other schemes are not fetched.
- **The exit code keeps the usual meaning**: 0 when every page worked, 1 when at least one failed, with the successful output kept, so a pipeline can decide to rerun only the failed URLs.
- **`--base-url` is refused in batch mode**, because each page has its own final URL after redirects, which is the base the single URL path already uses.
- **An invalid XPath is reported before the first request**, so a typo does not fetch the whole list.
