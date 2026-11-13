# reader
Extract clean(er), readable text from web pages via [trafilatura](https://trafilatura.readthedocs.io/).

## A note on the parser
Earlier versions of this project used the [Postlight Parser](https://github.com/postlight/parser), which required Node.js and shelling out to its command-line driver, plus [html2text](https://github.com/Alir3z4/html2text) for the Markdown/plain-text conversions. Both have been replaced by [trafilatura](https://trafilatura.readthedocs.io/), a well-maintained Python library that consistently tops content-extraction benchmarks and emits HTML, Markdown, and plain-text natively. Everything now runs in a single Python process with a single dependency.

## Install

Requires Python 3.14 or newer.

### As a command-line tool

`reader` ships a console script, so [uv](https://docs.astral.sh/uv/) can install it onto your `PATH` in its own isolated environment ([`uv tool install`](https://docs.astral.sh/uv/guides/tools/)):

```
$ uv tool install git+https://github.com/zyocum/reader
Installed 1 executable: reader
$ reader -h
```

From a local clone, `uv tool install .` does the same, and `uv tool upgrade reader` / `uv tool uninstall reader` manage it afterwards.

### As a library

The module exposes `main()` (returning the parsed document as a dict) and the `ParseResult`/`Content` types, so other CLI or TUI tools can reuse the extractor without shelling out:

```
$ uv add git+https://github.com/zyocum/reader
```

```python
from reader import main as read_article

doc = read_article("https://www.paulgraham.com/greatwork.html", 80)
print(doc["title"], doc["word_count"])
```

### For development

Clone this repository and sync the environment with uv:

```
$ uv sync
```

This installs the project itself in editable mode, so `uv run reader` (or `.venv/bin/reader`) runs your working copy.

Or with a classic virtual environment and pip. `requirements.txt` carries the pinned dependencies; installing the project itself (`--no-deps`, so the pins win) is what provides the `reader` command:

```
$ python3 -m venv .venv
$ source .venv/bin/activate
(reader) $ pip install -r requirements.txt
(reader) $ pip install --no-deps .
```

## Usage

The examples below use the installed `reader` command; from a clone without installing, `uv run reader` is equivalent.

```
$ reader -h
usage: reader [-h] [-b MANIFEST] [-f {json,html,md,txt}] [-w BODY_WIDTH]
              [-t FORMAT]
              [source]

Get a cleaner version of a web page for reading purposes. Fetches a URL (or
reads local HTML) and extracts the main content and metadata via trafilatura
(https://trafilatura.readthedocs.io/), outputting the document as JSON,
Markdown, plain-text, or HTML. A manifest of sources can be processed in one
batch, where each source succeeds or fails on its own.

positional arguments:
  source                URL to fetch and parse, or path to a local HTML file
                        (use "-" to read HTML from stdin)

options:
  -h, --help            show this help message and exit
  -b, --batch MANIFEST  read sources from MANIFEST (one per line; blank lines
                        and '#' comments ignored) and process all of them,
                        reporting each source's outcome; incompatible with a
                        source argument (default: None)
  -f, --format {json,html,md,txt}
                        output format (default: json)
  -w, --body-width BODY_WIDTH
                        character offset at which to hard-wrap lines of
                        markdown and plain-text content (default: None)
  -t, --table-format FORMAT
                        tabulate format for data tables in plain-text content
                        (one of: asciidoc, colon_grid, double_grid,
                        double_outline, fancy_grid, fancy_outline, github,
                        grid, heavy_grid, heavy_outline, html, jira, latex,
                        latex_booktabs, latex_longtable, latex_raw, mediawiki,
                        mixed_grid, mixed_outline, moinmoin, orgtbl, outline,
                        pipe, plain, presto, pretty, psql, rounded_grid,
                        rounded_outline, rst, simple, simple_grid,
                        simple_outline, textile, tsv, unsafehtml, youtrack)
                        (default: simple)
```

When wrapping markdown, lines whose markup would break if split across lines (headings, table rows, horizontal rules, and fenced code blocks) are left intact, and long tokens such as URLs are never split.

Layout tables (common on older, table-based sites) are unwrapped into ordinary paragraphs so their contents read naturally, while genuine data tables are preserved; decorative tables with no text (image/spacer scaffolding) are dropped. In plain-text output, data tables are rendered as aligned text via [tabulate](https://github.com/astanin/python-tabulate), in any format tabulate supports (`-t/--table-format`, default `simple`):

```
City           Population
-----------  ------------
Springfield        30,720
Shelbyville        12,654
```

Rendered tables are never disturbed by `-w` line-wrapping, regardless of the chosen table format.

The source can be a URL (fetched by trafilatura), a local HTML file, or `-` to read HTML from stdin — so you can also feed it pages saved locally or fetched by other tools (`curl`, a headless browser, etc.).

### Batch reading from a manifest

Reading a dozen articles one at a time is slow and fragile: a single unreachable URL or an unextractable page aborts the run and discards the successes before it. `--batch` takes a manifest instead and keeps going:

```
$ reader --batch sources.txt
```

The manifest is plain text with one source per line, in the same forms as the `source` argument (URL, local HTML path, or `-`). Blank lines and lines beginning with `#` are ignored; `-` may appear once and only as the sole source in a batch.

```
# sources.txt
https://www.paulgraham.com/greatwork.html
https://www.gnu.org/philosophy/free-sw.en.html
./saved/notes.html
```

Every entry is attempted, in manifest order, and every entry ends in a checkable outcome: a `success` carries the entire `ParseResult`, while a `failure` carries the same labeled reason a single-source run would print — `[FETCH ERROR - No response]`, `[HTTP ERROR 404 - Not Found]`, `[FETCH ERROR - empty response]`, `[PARSE ERROR - failed to extract content]`, `[FILE ERROR - No such file or directory]` — so it is clear whether to retry or fix the manifest. No failure aborts the batch and nothing is silently skipped.

The default output is one JSON report covering the whole batch:

```json
{
  "results": [
    {
      "source": "https://www.paulgraham.com/greatwork.html",
      "status": "success",
      "error": null,
      "result": { "title": "How to Do Great Work", "content": { ... }, ... }
    },
    {
      "source": "https://www.example.com/missing",
      "status": "failure",
      "error": "HTTP ERROR 404 - Not Found",
      "result": null
    }
  ],
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "conclusion": "partial failure"
}
```

`conclusion` is one of `all succeeded`, `all failed`, or `partial failure`. An unreadable, empty, or malformed manifest is reported as `[MANIFEST ERROR - ...]` and exits 2; a batch that ran exits 1 when anything failed and 0 when everything succeeded, so scripts can tell a clean run from a dirty one without parsing the output.

The other formats render each success with that formatter and show failures as their labeled reason, closing with the same overall conclusion:

```
=== https://www.paulgraham.com/greatwork.html [success] ===

title: How to Do Great Work
...

=== https://www.example.com/missing [failure: HTTP ERROR 404 - Not Found] ===

=== batch: 2 total, 1 succeeded, 1 failed - partial failure ===
```

As a library, `batch(manifest, body_width, table_format)` returns the report as a dict (the `BatchReport` type), and `read_manifest(path)` exposes the parsed source list. `reader.read()` and `reader.load_html()` raise a `ReaderError` instead of exiting, which is what makes per-source recovery possible; `main()` keeps its exit-on-failure behavior.

`batch()` raises `ManifestError` only for problems with the list itself — unreadable file, no sources after comments and blanks, an unsupported URL scheme, or a misplaced `-`. Per-source problems never raise: they become `failure` entries. A source that trips an unexpected exception (a parser crash, say) is recorded as `UNEXPECTED ERROR - <type>: <message>` rather than taking the rest of the batch down with it.

```python
from reader import batch

report = batch("sources.txt", 80)
for item in report["results"]:
    if item["status"] == "success":
        print(item["result"]["title"], item["result"]["word_count"])
    else:
        print(item["source"], "->", item["error"])
print(report["conclusion"])
```

## Examples

### Full JSON

The default output is JSON containing trafilatura's extracted metadata alongside the content in three forms: HTML (`.content.html`), Markdown (`.content.markdown`), and plain-text (`.content.text`):

```
$ reader https://www.paulgraham.com/greatwork.html | jq .
{
  "title": "How to Do Great Work",
  "author": null,
  "url": "https://www.paulgraham.com/greatwork.html",
  "hostname": "paulgraham.com",
  "description": null,
  "sitename": "paulgraham.com",
  "date": "2023-01-01",
  "categories": [],
  "tags": [],
  "fingerprint": null,
  "id": null,
  "license": null,
  "language": null,
  "image": null,
  "pagetype": null,
  "filedate": "2026-08-19",
  "content": {
    "html": "<html>...</html>",
    "markdown": "July 2023 If you collected lists of techniques for doing great work...",
    "text": "July 2023 If you collected lists of techniques for doing great work..."
  },
  "word_count": 11807
}
```

### HTML
The extracted HTML content is accessible from `.content.html`, or directly with `--format=html`:

```
$ reader https://www.paulgraham.com/greatwork.html -f html
```

### Markdown
As a convenience, the `-f/--format` option can output the whole document as Markdown, including some of the human-relevant metadata:

```
$ reader https://www.paulgraham.com/greatwork.html --format=md
---
title: "How to Do Great Work"
url: "https://www.paulgraham.com/greatwork.html"
sitename: "paulgraham.com"
date: "2023-01-01"
words: 11874
---

# [How to Do Great Work](https://www.paulgraham.com/greatwork.html)

July 2023

If you collected lists of techniques for doing great work in a lot of
different fields, what would the intersection look like? I decided to find
out by making it.
...
```

The front matter includes the human-relevant metadata fields that are present (empty fields are omitted), quoted as YAML-safe scalars.

### Plain-text
Similarly, the whole document can be formatted as plain-text:

```
$ reader https://www.paulgraham.com/greatwork.html --format=txt -w 80
title: How to Do Great Work
url: https://www.paulgraham.com/greatwork.html
sitename: paulgraham.com
date: 2023-01-01
words: 11874

July 2023

If you collected lists of techniques for doing great work in a lot of different
fields, what would the intersection look like? I decided to find out by making
it.
...
```

### Read Web Content in Your Terminal
One use case for this script is to convert content from the web to a format that is suitable for reading in your terminal.  Here's a short shell pipeline to extract the content and feed the converted plain-text to your `$PAGER` of choice for easy reading:

```
#!/bin/sh
# Read a web page as clean plain text in $PAGER.
# Usage: newspaper.sh <url>
set -eu

reader "$1" -w 80 -f txt | "${PAGER:-less}"
```
