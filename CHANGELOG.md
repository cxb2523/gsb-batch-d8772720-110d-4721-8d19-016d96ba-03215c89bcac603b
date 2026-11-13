# Changelog

## Unreleased

- Add per-page observable outcomes for library listing pagination.
  `Client.search_videos_page_results`, `Something.videos_page_results`
  (channels, creators, pornstars) and `Something.shorts_page_results` yield a
  `PageOutcome` for every requested page with its page number, URL, status and
  parsed media objects. Reachable pages without results are reported as
  `PageStatus.EMPTY`; fetch failures (network errors, 404, bot detection) are
  reported as `PageStatus.FAILED` with a readable reason and no longer abort
  the remaining pages. Existing item-stream methods and the `xhamster_api`
  download command are unchanged.

## 2.6.5 — 2026-10-27

- Restore shorts and moments extraction from current page data and DOM layouts.
- Keep profile shorts on the correct listing route and preserve regional URL hosts.
- Read listing metadata from hydrated page data so later cards retain thumbnails and durations.
- Avoid incompatible quality filters for VR search and recognize Full HD and UHD videos correctly.
- Handle missing short metadata safely and add compatible user, video and shorts aliases.
- Route shorts and moments through the CLI.
- Use the published `eaf-base-api>=4.2.5` dependency.

