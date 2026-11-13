"""05_intercept_network.py — block ads/tracking and mock /api/me over CDP.

Connects to a running Owl Light (or any Chrome with remote debugging) and
drives the first page of the first existing context. A single catch-all
route gives every request exactly one of three outcomes:

  Job 1 - blocker:
      ABORT    URLs containing "ads" or "tracking" never leave the browser.

  Job 2 - rewriter:
      FULFILL  URLs whose path ends with "/api/me" get a fixed
               HTTP 200 JSON body: {"id":42,"name":"Owlbert"}.

  Fallback for everything else (all other /api/ calls included):
      CONTINUE the request reaches the network untouched.

A summary line with the abort/rewrite counters is always printed before
exit, even when no request matched (both counters then stay at 0).

Usage:
    python 05_intercept_network.py [TARGET_URL]

The default target is the local fixture page served by
examples/fixtures/serve.mjs — see examples/fixtures/README.md.
"""
import asyncio
import sys

from playwright.async_api import async_playwright

CDP_URL = "http://localhost:9222"
DEFAULT_TARGET = "http://localhost:8080/intercept-demo.html"
MOCK_ME_BODY = '{"id":42,"name":"Owlbert"}'


# --- Job 1: ad / tracking blocker ---------------------------------------
def is_blocked(url: str) -> bool:
    """True for anything that looks like an ad or a tracking request."""
    return "ads" in url or "tracking" in url


# --- Job 2: API response rewriter ---------------------------------------
def is_mocked_me(url: str) -> bool:
    """True only for the /api/me endpoint (query string ignored)."""
    return url.split("?", 1)[0].endswith("/api/me")


async def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET

    async with async_playwright() as p:
        try:
            browser = await p.chromium.connect_over_cdp(CDP_URL)
        except Exception as exc:
            print(
                f"error: cannot connect to CDP endpoint {CDP_URL}: {exc}",
                file=sys.stderr,
            )
            return 1

        if not browser.contexts or not browser.contexts[0].pages:
            print(
                "error: no open page found in the existing browser context",
                file=sys.stderr,
            )
            await browser.close()
            return 1

        page = browser.contexts[0].pages[0]
        stats = {"aborted": 0, "fulfilled": 0, "continued": 0}

        async def handle_route(route) -> None:
            """One dispatcher keeps the block vs. rewrite decisions adjacent."""
            url = route.request.url
            try:
                if is_blocked(url):  # Job 1
                    await route.abort()
                    stats["aborted"] += 1
                    print(f"  ABORT    {url}")
                elif is_mocked_me(url):  # Job 2
                    await route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=MOCK_ME_BODY,
                    )
                    stats["fulfilled"] += 1
                    print(f"  FULFILL  {url} -> {MOCK_ME_BODY}")
                else:  # fallback: other /api/ calls and all normal traffic
                    await route.continue_()
                    stats["continued"] += 1
                    print(f"  CONTINUE {url}")
            except Exception as exc:
                # Never leave the request hanging if the browser already
                # settled it (redirect/frame-detach races, page close, ...).
                print(f"  WARNING  handler error for {url}: {exc}",
                      file=sys.stderr)

        # Catch-all glob: routing every request through one handler makes
        # the hit/pass-through rules easy to audit in a single place.
        await page.route("**/*", handle_route)

        try:
            await page.goto(target, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            print(f"error: failed to open {target}: {exc}", file=sys.stderr)
            await browser.close()
            return 1

        # The fixture flips this flag once its four requests have settled.
        # Pages without the flag are fine: we simply skip the wait.
        try:
            await page.wait_for_function(
                "window.__interceptDemoDone === true", timeout=5000
            )
        except Exception:
            pass

        try:
            results = await page.evaluate("window.__interceptResults || null")
        except Exception:
            results = None
        if results:
            print("page-observed results:")
            for name, detail in results.items():
                print(f"  {name}: {detail}")

        # Over CDP, close() only disconnects; the browser itself stays up.
        await browser.close()
        print(
            f"summary: aborted={stats['aborted']} "
            f"fulfilled={stats['fulfilled']} continued={stats['continued']}"
        )
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(130)
