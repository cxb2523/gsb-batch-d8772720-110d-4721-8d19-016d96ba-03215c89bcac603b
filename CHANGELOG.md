# Changelog

All notable changes are documented in this file.

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
