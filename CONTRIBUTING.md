# Contributing

Thank you for helping improve Douyin Image Publisher.

## Before opening a change

1. Use only accounts and content you are authorized to operate.
2. Do not submit cookies, QR codes, browser profiles, real user media, `.env`, `config.json`, screenshots, or local batch state.
3. Keep real publishing disabled while developing.
4. Open an issue first for changes that alter authorization, deletion behavior, platform interaction, or network exposure.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

Run the local control panel on Windows with:

```powershell
npm.cmd run panel
```

Use synthetic fixtures for tests. Do not run a real publish as part of an automated test.

## Pull requests

- Keep changes focused and explain safety impact.
- Add or update tests for behavior changes.
- Update both `README.md` and `README.zh-CN.md` when user-facing instructions change.
- Ensure `npm audit --omit=dev --audit-level=high` and `npm run check` succeed.
- Sanitize screenshots and remove image metadata before committing them.
