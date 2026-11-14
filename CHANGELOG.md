# Changelog

## Unreleased

- `Client.search_videos` now returns a `SearchStream` that yields exactly one
  `SearchPageResult` per requested page, in target order. Each page outcome
  carries its full URL, index, success state (including zero entries) and the
  page's videos, or a typed error with the page URL and message.
- A failed page no longer stops later pages; the failure is reported instead of
  being buried in logs.
- `SearchStream` supports `async with` and `aclose()` so a caller can stop after
  enough results without leaking page or item tasks. Results already produced
  remain readable.
- Added offline tests using synthetic search/video HTML and a stubbed fetch layer.

## 2.4.4 — 2026-10-27

- Encode search terms as one path segment, including literal slashes and hashes.
- Read video metadata from JSON-LD arrays and graph objects.
- Handle empty profiles without dividing by zero and close profile scrapers when iteration stops early.
- Close CLI sessions and report unsuccessful downloads as errors.
- Use the published `eaf-base-api>=4.2.5` dependency.

