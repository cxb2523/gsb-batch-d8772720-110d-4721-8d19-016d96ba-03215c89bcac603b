# Changelog

All notable changes are documented in this file.

## [Unreleased]

### Fixed

- The Feishu scheduler no longer aborts a whole scan round when a row cannot be published. Each due row is gated before browser automation; blocked rows are marked `发布状态=跳过` with a `发布失败原因` that distinguishes a persistent dry run from a batch-ID mismatch (including both the record and authorized batch IDs), and the round continues with the remaining rows.
- Every scan round now reports, per row, the table, record ID, outcome (`已发布`/`干跑完成`/`跳过`/`失败`) and reason.

### Security

- A row that cannot persist its `发布中` marker is not published, preventing accidental re-publishing of a possibly submitted row in a later round.
- As before, `DOUYIN_DRY_RUN=true` never writes Feishu state, and real publishing still requires an exact record batch-ID match.

## [0.1.0] - 2026-08-26

### Added

- Local visual control panel with separate full-preparation and direct-publish workflows.
- Strict seven-field image-post batch validation and content-plan validation.
- Long-running login window, upload/preflight checks, dry-run screenshots, and Content Management reconciliation.
- Ephemeral per-task production authorization and verified publish ledger.
- Permanent clearing for two fixed workspace folders with explicit confirmation and task mutual exclusion.
- Bilingual documentation, tests, CI, and open-source governance files.

### Security

- HTTP bridge now defaults to loopback and requires a strong bridge secret before binding to a non-loopback host.
- Local profiles, runtime state, screenshots, downloaded media, workspace files, and secrets remain excluded from version control.
