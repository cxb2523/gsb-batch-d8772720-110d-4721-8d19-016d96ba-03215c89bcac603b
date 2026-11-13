# Fixtures · offline pages for the collection examples

Static pages plus a zero-dependency Node server so the network
interception examples can be verified without any external network.

## Files

| File | Purpose |
|---|---|
| [`intercept-demo.html`](intercept-demo.html) | Fires four requests covering every interception rule |
| [`serve.mjs`](serve.mjs) | Serves this directory over HTTP (Node built-ins only) |

The demo page fires exactly four requests:

| Request | Expected handling |
|---|---|
| `/ads/banner.js` | **aborted** — URL contains `ads` |
| `/tracking/pixel.gif` | **aborted** — URL contains `tracking` |
| `/api/me` | **rewritten** — HTTP 200 with `{"id":42,"name":"Owlbert"}` |
| `/api/orders` | **allowed through** — another `/api/` call; the static server answers 404, which itself proves the request reached the network |

## Running the three interception scripts

Open three terminals.

**1. Start the fixture server** (no dependencies, plain Node):

```bash
node examples/fixtures/serve.mjs          # default port 8080
```

**2. Start a Chromium-based browser with remote debugging** — Owl Light in
real use, or stock Chrome/Edge for a local check:

```bash
# Windows (stock Chrome)
"C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/owl-cdp-profile

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/owl-cdp-profile
```

The scripts attach to the **first page of the first existing context**, so
keep the initial tab open.

**3. Run any of the three scripts** — each defaults to the fixture URL:

```bash
# Playwright + Python
python examples/playwright-python/05_intercept_network.py

# Playwright + Node.js
node examples/playwright-node/05_intercept_network.mjs

# Puppeteer
node examples/puppeteer/04_intercept_network.mjs
```

A custom target can be passed as the first argument, e.g.:

```bash
python examples/playwright-python/05_intercept_network.py https://example.com
```

## Expected output

Every script logs one line per decision (`ABORT` / `FULFILL` / `CONTINUE`)
and ends with a summary such as:

```
summary: aborted=2 fulfilled=1 continued=...
```

With the fixture page the two counters are exactly **aborted=2** and
**fulfilled=1**. On a page that fires no matching request both counters
stay at zero and the summary is still printed. If the CDP endpoint is
unreachable or no page is open, the script prints a readable error to
stderr and exits with a non-zero status.
