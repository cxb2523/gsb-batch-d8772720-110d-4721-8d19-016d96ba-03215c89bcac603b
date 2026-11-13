# batch-fetch Specification

## Purpose
Define batch mode: reading a list of URLs, extracting each page with the usual rules, retrying the failures worth retrying, and reporting the outcome of every page so that failed pages can be rerun on their own.

## Requirements
### Requirement: URL list

The CLI SHALL, with `--urls FILE`, read one URL per line from FILE, ignoring blank lines and lines whose first non-space character is `#`, and SHALL process the pages in the order of the file.

#### Scenario: Comments and blank lines

- **WHEN** the file has a `# comment` line, an empty line and a line of spaces between two URLs
- **THEN** only the two URLs are fetched, in that order

#### Scenario: Missing file

- **WHEN** `--urls` names a file that does not exist
- **THEN** the exit code is 1, stdout is empty and stderr has one `Error:` line naming the file

### Requirement: Per-page extraction and failures

The CLI SHALL fetch each page with the same rules as a single URL: a 30 s timeout, the `-u` User-Agent, and the per-page output options. An HTTP 4xx or 5xx SHALL be a failure of that page, and a failure SHALL NOT stop the processing of the following pages.

#### Scenario: A page fails and the batch continues

- **WHEN** the second of three URLs answers 404
- **THEN** the first and third pages are extracted and printed, the exit code is 1, and stdout keeps the results of the pages that worked

#### Scenario: Page that cannot be parsed

- **WHEN** a page returns HTML with no elements
- **THEN** that page is a failure and the following pages are still processed

### Requirement: Retries

The CLI SHALL, with `--retries N`, make up to N extra attempts when a page fails with a network error or a 5xx response, and SHALL NOT retry a 4xx response. The default is 0. The `attempts` reported for a page SHALL be the number of requests actually made, including the first.

#### Scenario: Two 500s then success

- **WHEN** a page answers 500 twice and then 200, with `--retries 2`
- **THEN** the page is ok, `attempts` is 3 and the request is made three times

#### Scenario: 4xx is not retried

- **WHEN** a page answers 404 with `--retries 2`
- **THEN** the page fails, `attempts` is 1 and only one request is made

#### Scenario: Network error

- **WHEN** the connection fails and `--retries 2` is used
- **THEN** the page fails after `attempts` 3

#### Scenario: Default

- **WHEN** `--retries` is omitted
- **THEN** a failing page is requested once

### Requirement: Per-page report

The CLI SHALL, with `--jsonl`, print one JSON object per page in file order, with the keys `url`, `ok` and `attempts`; a successful page SHALL have `data` with the result the per-page output options give, and a failed page SHALL have `error` with a short reason. Without `--jsonl`, a successful page SHALL print its result as usual, and a failed page SHALL print one line on stderr with the URL and the number of attempts. After the last page the CLI SHALL print one summary line on stderr, such as `3/5 pages ok`, listing the failed URLs.

#### Scenario: JSON Lines

- **WHEN** `--jsonl` is used with `-e "//h1/text()"` on two pages, one of them missing
- **THEN** there are two lines in file order, `ok` is a boolean, `attempts` an integer, and the failed page has `error` instead of `data`

#### Scenario: Plain output and summary

- **WHEN** `--jsonl` is not used and two of three pages fail
- **THEN** the successful page prints its result, each failed page prints one stderr line with its URL and attempts, and a line `1/3 pages ok` lists both failed URLs

### Requirement: Exit code

The CLI SHALL exit 0 when every page is ok and 1 when at least one page failed, without discarding the output of the pages that worked.

#### Scenario: All pages ok

- **WHEN** every URL answers 200
- **THEN** the exit code is 0

#### Scenario: One page fails

- **WHEN** one of the URLs fails
- **THEN** the exit code is 1 and stdout keeps the successful results

### Requirement: Invalid use

The CLI SHALL treat batch-mode conflicts and bad `--retries` values as usage errors: exit code 1, stdout empty, and one line on stderr starting with `Error:`.

#### Scenario: Conflicting options

- **WHEN** `--urls` is combined with the HTML argument, `-r`, `-x`, `--row`, `--field` or `--base-url`
- **THEN** the exit code is 1, stdout is empty and the `Error:` line names the conflict

#### Scenario: Retries without URLs

- **WHEN** `--retries` is used without `--urls`
- **THEN** the exit code is 1, stdout is empty and the `Error:` line mentions `--urls`

#### Scenario: Negative retries

- **WHEN** `--retries` is negative
- **THEN** the exit code is 1, stdout is empty and the `Error:` line mentions `--retries`

#### Scenario: Missing value

- **WHEN** `--urls` or `--retries` has no value
- **THEN** the exit code is 1 and stdout is empty

### Requirement: Single input unchanged

The CLI SHALL keep the behaviour of a single URL and of stdin unchanged when `--urls` is not used.

#### Scenario: Stdin

- **WHEN** HTML comes from stdin with `-e`, with no `--urls`
- **THEN** the output and the exit code are as before, with no summary line on stderr
