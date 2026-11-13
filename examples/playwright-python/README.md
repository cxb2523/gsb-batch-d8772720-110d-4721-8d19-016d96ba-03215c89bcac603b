# Playwright + Python · Owl Light examples

Vanilla Playwright code that connects to a running Owl Light over CDP. No
SDK, no monkey-patching — `connect_over_cdp` is all you need.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# in another terminal: start Owl Light
owl-light --remote-debugging-port=9222 --owl-os=macos --owl-chrome-version=147
```

## Examples

| File | What it shows |
|---|---|
| [`01_basic.py`](01_basic.py) | Connect, navigate, read the page title |
| [`02_screenshot.py`](02_screenshot.py) | Full-page PNG of any URL |
| [`03_form_login.py`](03_form_login.py) | Fill + submit a login form, assert success |
| [`04_multiwindow.py`](04_multiwindow.py) | Open `target=_blank`, drive the new tab |
| [`05_intercept_network.py`](05_intercept_network.py) | Abort ads/tracking, mock `/api/me`, log every request decision |
| [`06_stealth_check.py`](06_stealth_check.py) | Visit a fingerprint test page and assert "not detected" |

Each script is self-contained — `python 01_basic.py` and you're off.

## Network interception (05)

[`05_intercept_network.py`](05_intercept_network.py) keeps two jobs clearly
separated on a single catch-all route:

1. **Blocker** — any URL containing `ads` or `tracking` is aborted.
2. **Rewriter** — requests ending in `/api/me` are fulfilled with HTTP 200
   and the fixed JSON `{"id":42,"name":"Owlbert"}`.

Everything else, including every other `/api/` request, is continued to the
network. Each decision is logged and the script always ends with a
`summary: aborted=… fulfilled=… continued=…` line (zeroes included).

Fully offline run with the bundled fixture — start the fixture server and a
Chrome with `--remote-debugging-port=9222`, then:

```bash
python 05_intercept_network.py
# or against any other page:
python 05_intercept_network.py https://example.com
```

See [`../fixtures/README.md`](../fixtures/README.md) for the full
three-language walkthrough.
