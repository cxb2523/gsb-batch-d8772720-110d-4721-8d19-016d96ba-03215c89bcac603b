## 1. Tests

- [x] 1.1 Local HTTP server: a page answering 500 twice then 200, a page answering 404; test that `--retries 2` gives ok with `attempts` 3, and that the 404 gives `attempts` 1 with one request
- [x] 1.2 Test the order of the pages, the `--jsonl` shape, the plain output with failed pages, the summary line and the exit codes
- [x] 1.3 Test a network error (`--retries 2` gives `attempts` 3) and the default `--retries` 0
- [x] 1.4 Test conflicts (HTML argument, `-r`, `-x`, `--row`/`--field`, `--base-url`), `--retries` without `--urls`, negative and missing values, missing file, invalid XPath
- [x] 1.5 Test that single URL and stdin keep their behaviour

## 2. Code

- [x] 2.1 Read the URL list, skipping blank lines and `#` comments
- [x] 2.2 Extract one page through a function shared with the single URL path, so the per-page rules are the same
- [x] 2.3 Add `--urls` and `--retries`, with retries only on network errors and 5xx
- [x] 2.4 Report each page and the summary, with exit code 1 when a page failed
- [x] 2.5 Reject invalid use with one `Error:` line, stdout empty, exit code 1
- [x] 2.6 Confirm that the existing tests are unchanged (the 10 encoding tests fail before and after on Windows, same failures)

## 3. Documentation

- [x] 3.1 Update `--help`: batch output, exit codes, notes, two examples
- [x] 3.2 Update `README.md` and `docs/future-ideas.md`
- [x] 3.3 Update `LOG.md`

## 4. Release

- [x] 4.1 Bump the version to 1.3.8 and update `CHANGELOG.md`
