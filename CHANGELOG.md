# Changelog

## Unreleased

- Add resumable, per-page outcome tracking to `PornstarHelper.videos` and `Client.search`.
  Both accept `resume_from` (1-based, inclusive; defaults to 1) and an optional
  `on_page_result` callback receiving a `PageResult` (page, URL, outcome, video count and
  a short failure reason). Page outcomes distinguish empty pages, bot/anti-scraping blocks,
  parse failures and network errors; empty and unparseable pages no longer abort the
  iteration, and callback exceptions are isolated so they cannot stop collection.

## 2.4.4 — 2026-10-27

- Build independent search page URLs and preserve special characters in search terms.
- Use conservative default listing concurrency and standard navigation headers.
- Keep each RAW download URL paired with its resolution and support numeric and named quality choices.
- Select RAW mode when only a RAW configuration is supplied, and add the --raw CLI flag.
- Normalize bare, embed and play links and handle regional profile paths and statistics.
- Improve thumbnail, duration and stream-data parsing across the supported page layouts.
- Use the published `eaf-base-api>=4.2.5` dependency.

