## Why

Scraping a list of pages today means one `scrape` call per URL, and a single network hiccup fails the whole command. The caller cannot tell which page failed, and cannot rerun only that page without scraping everything again.

## What Changes

- New `--urls FILE` option: a text file with one URL per line; blank lines and lines starting with `#` are skipped. Each page gets the usual extraction, one page after the other, in file order.
- New `--retries N` option (default 0): extra attempts for a page that fails with a network error or a 5xx. A 4xx is never retried.
- A page that fails does not stop the batch: the following pages are still processed, and the successful pages keep their output.
- With `--jsonl`, each page gives one JSON object with `url`, `ok`, `attempts`, and `data` (the page result) or `error` (a short reason).
- Without `--jsonl`, a failed page prints one line on stderr; at the end one summary line such as `3/5 pages ok (failed: url1, url2)` goes to stderr.
- Exit code 1 when at least one page failed, 0 when every page worked.
- Batch mode accepts only the per-page output options: `-e`, `-t`, `-a`, `-b`, `-j`, `--json-array`, `--jsonl`, `--absolute-urls`, plus `-u` and `--retries`. The HTML argument, `-r`, `-x`, `--row`/`--field` and `--base-url` are refused as usage errors. `--retries` without `--urls`, or a negative one, is also a usage error.
- Single URL and stdin input do not change.

```bash
scrape --urls urls.txt --retries 2 -e "//h1/text()"
```

## Capabilities

### New Capabilities

- `batch-fetch`: reading the URL list, per-page extraction and retries, reporting and exit codes, invalid use.

### Modified Capabilities

None. The single page behaviour is the existing one, reused for each URL.

## Impact

- `scrape_cli/scrape.py`: option parsing, a batch runner, per-page extraction shared with the single URL path.
- `tests/test_scrape.py`: new tests with a local HTTP server.
- `--help`, `README.md`, `manual.html`, `LOG.md`, `CHANGELOG.md`.
- No new dependencies.
