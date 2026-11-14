# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Prism, please report it
**privately**. Do **not** open a public issue.

- Please report it privately via GitHub Security Advisories (the repository's
  "Report a vulnerability" button under the Security tab), with details and
  reproduction steps.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation
as quickly as is practical.

## Scope & Data Handling

Prism deals with login cookies and scraped social content, so a few security
properties are part of the design — please keep them in mind when contributing:

- **Cookies never get committed.** `cookies.json`, `.env`, and any real database
  are blocked by `.gitignore`. The macOS Chrome auto-read path
  (`framework/adapters/xhs_cookies.py`) reads cookies into memory only and
  deletes its temporary copy in a `finally` block — it must never write cookie
  plaintext to disk or logs.
- **User data is anonymized before storage.** `compliance.scrub_user` salted-hashes
  user IDs and drops sensitive fields (phone, email, IP, nickname, …) before
  anything is written. Never bypass it for user objects.
- **Rate limiting is on by default.** `compliance.RateLimiter` enforces a slow
  request rate and a daily cap to avoid account bans. Do not disable it in
  examples or defaults.

## What is *not* a vulnerability

Prism is a research tool. Scraping that violates a platform's Terms of Service,
or any use that breaks local law, is the user's responsibility — see
[DISCLAIMER.md](./DISCLAIMER.md). Such usage is out of scope for this policy.
