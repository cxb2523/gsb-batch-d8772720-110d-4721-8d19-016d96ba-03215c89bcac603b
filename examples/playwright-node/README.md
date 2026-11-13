# Playwright + Node.js · Owl Light examples

```bash
npm install
# in another terminal: start Owl Light
owl-light --remote-debugging-port=9222 --owl-os=macos --owl-chrome-version=147
# then:
npm run basic
npm run screenshot
npm run login
npm run windows
npm run intercept
```

| File | What it shows |
|---|---|
| [`01_basic.mjs`](01_basic.mjs) | Connect over CDP, navigate, read title |
| [`02_screenshot.mjs`](02_screenshot.mjs) | Full-page PNG of any URL |
| [`03_form_login.mjs`](03_form_login.mjs) | Fill, submit, assert flash message |
| [`04_multiwindow.mjs`](04_multiwindow.mjs) | Drive a popup opened via `target=_blank` |
| [`05_intercept_network.mjs`](05_intercept_network.mjs) | Abort ads/tracking, mock `/api/me`, log every request decision |

## Network interception (05)

[`05_intercept_network.mjs`](05_intercept_network.mjs) uses Playwright's
`page.route()` with one catch-all handler so the two jobs stay easy to
audit:

1. **Blocker** — any URL containing `ads` or `tracking` is aborted.
2. **Rewriter** — requests ending in `/api/me` are fulfilled with HTTP 200
   and the fixed JSON `{"id":42,"name":"Owlbert"}`.

Everything else, including every other `/api/` request, is continued to the
network. Each decision is logged and the script always ends with a
`summary: aborted=… fulfilled=… continued=…` line (zeroes included).

Fully offline run with the bundled fixture — start the fixture server and a
Chrome with `--remote-debugging-port=9222`, then:

```bash
node 05_intercept_network.mjs
# or against any other page:
node 05_intercept_network.mjs https://example.com
```

See [`../fixtures/README.md`](../fixtures/README.md) for the full
three-language walkthrough.
