# Puppeteer · Owl Light examples

```bash
# IMPORTANT: skip Puppeteer's bundled Chromium download — Owl Light *is*
# the browser you want to use.
PUPPETEER_SKIP_DOWNLOAD=true npm install

# in another terminal: start Owl Light
owl-light --remote-debugging-port=9222 --owl-os=macos --owl-chrome-version=147

# then run any example:
npm run basic
npm run screenshot
npm run login
npm run intercept
```

| File | What it shows |
|---|---|
| [`01_basic.mjs`](01_basic.mjs) | `puppeteer.connect({ browserURL })`, navigate, log title |
| [`02_screenshot.mjs`](02_screenshot.mjs) | `fullPage: true` PNG of any URL |
| [`03_form_login.mjs`](03_form_login.mjs) | Type, click, assert post-login flash |
| [`04_intercept_network.mjs`](04_intercept_network.mjs) | Abort ads/tracking, mock `/api/me`, log every request decision |

## Network interception (04)

[`04_intercept_network.mjs`](04_intercept_network.mjs) enables Puppeteer's
native `page.setRequestInterception(true)` and gives every paused request
exactly one outcome:

1. **Blocker** — any URL containing `ads` or `tracking` gets
   `request.abort()`.
2. **Rewriter** — requests ending in `/api/me` get `request.respond()`
   with HTTP 200 and the fixed JSON `{"id":42,"name":"Owlbert"}`.

Everything else, including every other `/api/` request, gets
`request.continue()` and reaches the network. Each decision is logged and
the script always ends with a
`summary: aborted=… fulfilled=… continued=…` line (zeroes included).

Fully offline run with the bundled fixture — start the fixture server and a
Chrome with `--remote-debugging-port=9222`, then:

```bash
node 04_intercept_network.mjs
# or against any other page:
node 04_intercept_network.mjs https://example.com
```

See [`../fixtures/README.md`](../fixtures/README.md) for the full
three-language walkthrough.
