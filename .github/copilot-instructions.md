# Code Review Instructions

## Purpose

This is **Copilot Billing Forecast** - an unofficial, client-side web app that helps
GitHub Copilot Business and Enterprise customers analyze and forecast their AI usage and
spend from uploaded GitHub usage report CSVs. Review all changes against the
requirements below. Read [CONTRIBUTING.md](../CONTRIBUTING.md) and
[docs/analytics.md](../docs/analytics.md) for the full project context before reviewing.

## Privacy - Hard Constraint (highest priority)

Uploaded usage data MUST NEVER leave the browser. Flag any change that could violate this:

- Sending parsed report data, rows, or any derived usage/cost values to a server, API
  route, Next.js server action, telemetry endpoint, or any third party.
- Persisting report data beyond the current browser session (only in-memory or explicit
  client-side storage is allowed).
- Introducing server-side processing of the uploaded CSV (the app is client-only).
- Reading report data inside non-`"use client"` code paths or server components.

## Analytics - Strict Allowlist

Analytics use PostHog and must remain privacy-preserving. Flag any change that:

- Adds analytics properties containing report contents, usernames, organizations,
  repositories, cost centers, model names, costs, quantities, or the uploaded filename.
- Enables PostHog `autocapture` or session recording (both must stay disabled, because
  the report is rendered in the DOM and could otherwise be captured).
- Sends events when the PostHog env vars are not configured.
- Adds or changes a captured event without updating [docs/analytics.md](../docs/analytics.md)
  to match (event name and properties).

Only non-sensitive aggregate metadata may be captured (e.g. `report_type`, `row_count`).

## Security

- Check for hardcoded secrets, API keys, or credentials.
- Flag XSS risks, especially `dangerouslySetInnerHTML` or injecting parsed CSV values as HTML.
- Validate and sanitize anything derived from the uploaded file before use.
- Flag new runtime dependencies that are unnecessary or unvetted.

## Architecture & Conventions

- Report-data handling belongs in client components (`"use client"`); no API routes touch user data.
- Parsing/forecasting logic belongs in `src/lib/` so it stays testable and reusable.
- Build UI with Primer React (`@primer/react`) and icons from `@primer/octicons-react`;
  flag hand-rolled markup where a Primer component exists.
- Register new tools in the single sidebar config (`src/lib/tools.ts`) plus a matching view component.
- Keep CSV parsing tolerant of all three report variants (summarized, detailed, AI) and legacy column names.

## Documentation

- Any user-facing or behavioral change should be reflected in the docs. Flag PRs that:
  - Add/rename/remove a tool without updating [README.md](../README.md).
  - Change analytics behavior without updating [docs/analytics.md](../docs/analytics.md).
  - Change setup, conventions, or the privacy constraint without updating
    [CONTRIBUTING.md](../CONTRIBUTING.md).
- Keep the "not an official GitHub product" disclaimer and the client-only privacy
  messaging accurate and intact.
