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
usage: reader [-h] [-f {json,html,md,txt}] [-w BODY_WIDTH] [-t FORMAT] source

Get a cleaner version of a web page for reading purposes. Fetches a URL (or reads local HTML) and
extracts the main content and metadata via trafilatura (https://trafilatura.readthedocs.io/),
outputting the document as JSON, Markdown, plain-text, or HTML.

positional arguments:
  source                URL to fetch and parse, or path to a local HTML file (use "-" to read HTML
                        from stdin)

options:
  -h, --help            show this help message and exit
  -f, --format {json,html,md,txt}
                        output format (default: json)
  -w, --body-width BODY_WIDTH
                        character offset at which to hard-wrap lines of markdown and plain-text
                        content (default: None)
  -t, --table-format FORMAT
                        tabulate format for data tables in plain-text content (one of: asciidoc,
                        colon_grid, double_grid, double_outline, fancy_grid, fancy_outline,
                        github, grid, heavy_grid, heavy_outline, html, jira, latex,
                        latex_booktabs, latex_longtable, latex_raw, mediawiki, mixed_grid,
                        mixed_outline, moinmoin, orgtbl, outline, pipe, plain, presto, pretty,
                        psql, rounded_grid, rounded_outline, rst, simple, simple_grid,
                        simple_outline, textile, tsv, unsafehtml, youtrack) (default: simple)
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
