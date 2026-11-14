/**
 * A persona timezone must reach the page, its web workers and its popups.
 *
 * Linux/macOS Chrome honor the TZ env the launch sets; Windows Chrome ignores
 * it, so a Tokyo persona silently kept the machine's clock (the persona tests
 * failed on Windows only). Windows now applies CDP's timezone override to every
 * tab, adopted popup and cross-origin frame. This test pins the behavior on
 * every platform.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();
const PAGE = `<a id="a" target="_blank" href="/pop">open</a><script>
window.workerTz = new Promise((ok) => { const w = new Worker(URL.createObjectURL(new Blob(["postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)"]))); w.onmessage = (e) => ok(e.data); });</script>`;

test("persona timezone reaches the page, its workers and its popups", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const srv = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(req.url.startsWith("/pop") ? "<title>pop</title><p>popup</p>" : PAGE); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const c = new Controller();
  t.after(() => { c.dispose(); srv.close(); });

  // Pick a zone that cannot be the machine's own.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
  const tz = (tab) => c.execute("evaluate", { tab_id: tab, expression: "Intl.DateTimeFormat().resolvedOptions().timeZone" }).then((r) => JSON.parse(r.value));
  const opened = await c.execute("open", { url: `http://127.0.0.1:${srv.address().port}/`, headless: true, timezone: zone, lang: "en-GB", settle_ms: 200 });
  const tab = opened.tab_id;

  assert.equal(await tz(tab), zone, "page clock follows the persona");
  const worker = await c.execute("evaluate", { tab_id: tab, expression: "window.workerTz" });
  assert.equal(JSON.parse(worker.value), zone, "web worker clock follows the persona");

  const ref = opened.observation.text.match(/link "open"[^\[]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(ref, "popup link has a ref");
  await c.execute("click", { tab_id: tab, target: { ref }, settle_ms: 400 });
  let pop;
  for (let i = 0; i < 20 && !pop; i++) {
    pop = ((await c.execute("tabs", {})).tabs ?? []).find((x) => x.tab_id !== tab);
    if (!pop) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(pop, "the popup was adopted as a controlled tab");
  assert.equal(await tz(pop.tab_id), zone, "popup clock follows the persona");
});
