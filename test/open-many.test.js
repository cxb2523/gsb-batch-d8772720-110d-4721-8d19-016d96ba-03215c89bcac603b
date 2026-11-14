/**
 * ax_open_many outcome-contract tests — every input URL must end with a
 * stable, per-row verdict: opened / error (with phase) / skipped (with
 * reason), and a failed cleanup must never rewrite the real outcome.
 *
 * All pages are local and controllable: data: URLs and a connection to a
 * closed loopback port. No external network is involved. Browser-driving
 * scenarios are gated on a findable Chromium-family browser, like the other
 * live CDP tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();

const page = (title, heading) =>
  `data:text/html,<title>${title}</title><h1>${heading}</h1>`;

test("open_many: all URLs succeed and carry stable input indexes", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());

  const batch = await c.execute("open_many", {
    urls: [page("alpha", "first"), page("beta", "second"), page("gamma", "third")],
    headless: true,
    settle_ms: 80,
    excerpt_chars: 200,
  });

  assert.equal(batch.count, 3);
  assert.equal(batch.opened, 3);
  assert.equal(batch.failed, 0);
  assert.equal(batch.skipped, 0);
  assert.equal(batch.closed_after, true);
  assert.deepEqual(batch.results.map((r) => r.index), [0, 1, 2]);
  assert.ok(batch.results.every((r) => r.status === "opened"));
  assert.equal(batch.results[0].title, "alpha");
  assert.match(batch.results[1].excerpt, /heading "second"/);
  // close_after defaults to true: no tab_id is handed out and nothing leaks.
  assert.ok(batch.results.every((r) => r.tab_id === undefined));
  assert.equal(c.tabs.size, 0, "batch closed its temporary tabs");

  await c.execute("close", { browser: true });
});

test("open_many: a mid-list open failure is typed and the rest still open", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());

  // Port 1 on loopback refuses instantly — a local, deterministic open failure.
  const batch = await c.execute("open_many", {
    urls: [page("before", "ok one"), "http://127.0.0.1:1/", page("after", "ok two")],
    headless: true,
    settle_ms: 80,
  });

  assert.equal(batch.count, 3);
  assert.equal(batch.opened, 2);
  assert.equal(batch.failed, 1);
  assert.equal(batch.skipped, 0);
  assert.deepEqual(batch.results.map((r) => r.index), [0, 1, 2]);
  assert.deepEqual(batch.results.map((r) => r.status), ["opened", "error", "opened"]);

  const failure = batch.results[1];
  assert.equal(failure.url, "http://127.0.0.1:1/");
  assert.equal(failure.phase, "open", "navigation never succeeded, so the open phase failed");
  assert.ok(failure.error?.code, "typed error code is present");
  assert.equal(failure.tab_id, undefined, "closed tabs must not leave a stale tab_id behind");

  // The failure did not abort the batch and left no tabs behind.
  assert.equal(batch.results[2].title, "after");
  assert.equal(c.tabs.size, 0, "failed and succeeded tabs were both cleaned up");

  await c.execute("close", { browser: true });
});

test("open_many: empty and unsupported-scheme URLs are skipped, never opened", async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());

  const batch = await c.execute("open_many", {
    urls: ["", "   ", "ftp://example.com/file", "javascript:alert(1)", "mailto:a@b.c"],
    headless: true,
  });

  assert.equal(batch.count, 5);
  assert.equal(batch.opened, 0);
  assert.equal(batch.failed, 0);
  assert.equal(batch.skipped, 5);
  assert.deepEqual(batch.results.map((r) => r.index), [0, 1, 2, 3, 4]);
  assert.ok(batch.results.every((r) => r.status === "skipped"));
  assert.equal(batch.results[0].reason, "empty URL");
  assert.equal(batch.results[1].reason, "empty URL");
  assert.match(batch.results[2].reason, /unsupported scheme/);
  assert.match(batch.results[3].reason, /unsupported scheme/);
  assert.match(batch.results[4].reason, /unsupported scheme/);

  // Skipped addresses never enter the open flow: no browser, no tabs.
  assert.equal(c.browsers.size, 0, "no browser was launched for skipped URLs");
  assert.equal(c.tabs.size, 0);
});

test("open_many: a failing tab close is an addendum, not the row's outcome", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());

  const realClose = c.$close.bind(c);
  c.$close = async () => { throw new Error("simulated close failure"); };
  t.after(() => { c.$close = realClose; });

  const batch = await c.execute("open_many", {
    urls: [page("close-fails", "still opened")],
    headless: true,
    settle_ms: 80,
  });

  assert.equal(batch.opened, 1);
  assert.equal(batch.failed, 0);
  const row = batch.results[0];
  assert.equal(row.index, 0);
  assert.equal(row.status, "opened", "the real outcome survives the cleanup failure");
  assert.equal(row.title, "close-fails");
  assert.ok(row.close_error, "close failure is reported as an addendum");
  assert.match(row.close_error.message, /simulated close failure/);
  assert.ok(row.close_error.tab_id, "the un-closable tab id stays available for retry");

  // Cleanup: restore close and tear down the leaked tab + browser.
  c.$close = realClose;
  await c.execute("close", { browser: true });
  assert.equal(c.tabs.size, 0);
});
