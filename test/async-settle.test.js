/**
 * Post-action settling for pages that answer LATE: a click whose result
 * arrives after a slow fetch, a debounced render, a genuine no-op, and the
 * stale-ref recovery that hands back the current page. Gated on a findable
 * browser, like the other live CDP tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();

const PAGE = `<!doctype html><title>Late</title><body><h1>Wizard</h1><div id="stage">
<button id="next">Next</button> <button id="later">Later</button> <button id="noop">Noop</button>
</div><script>
const stage = document.getElementById("stage");
document.getElementById("next").onclick = async () => {
  await fetch("/slow"); // ~400 ms server round trip, then a full re-render
  stage.innerHTML = '<p>Step 2 of 2</p><button id="finish">Finish</button>';
};
document.getElementById("later").onclick = () => {
  setTimeout(() => { stage.insertAdjacentHTML("beforeend", "<p>debounced result</p>"); }, 300);
};
</script></body>`;

function startServer() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === "/slow") return void setTimeout(() => { res.end("ok"); }, 400);
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const refOf = (text, name) => text.match(new RegExp(`button "${name}"[^\\[]*\\[ref=(e\\d+)\\]`))?.[1];

test("late-answering pages", { skip: !hasBrowser }, async (t) => {
  const srv = await startServer();
  const c = new Controller();
  t.after(() => { c.dispose(); srv.close(); });
  const url = `http://127.0.0.1:${srv.address().port}/`;

  let tab; // tab_id of the first page, reused by the stale-ref check

  await t.test("a click answered by a slow fetch reports the re-render, not 'no change'", async () => {
    const opened = await c.execute("open", { url, headless: true, settle_ms: 100 });
    tab = opened.tab_id;
    const next = refOf(opened.observation.text, "Next");
    assert.ok(next, "Next has a ref");
    const clicked = await c.execute("click", { tab_id: tab, target: { ref: next }, settle_ms: 150 });
    assert.match(clicked.observation.text, /Step 2 of 2/, "the diff already shows the new step");
    assert.doesNotMatch(clicked.observation.text, /no changes detected/);
    assert.equal(clicked.note, undefined, "no misleading no-op note");
  });

  await t.test("a stale ref returns the current page with the error", async () => {
    // The Next button is gone; the page is on step 2.
    const gone = await c.execute("click", { tab_id: tab, target: { ref: "e99" } }).catch((e) => e);
    assert.equal(gone.code, "REF_NOT_FOUND");
    assert.equal(gone.retry, "reobserve");
    assert.match(gone.facts.fresh_observation, /Step 2 of 2/, "error carries the live page");
    assert.match(gone.facts.fresh_observation, /button "Finish"/);
  });

  await t.test("a debounced render is caught by the late-change watch", async () => {
    const opened = await c.execute("open", { url, headless: true, settle_ms: 100 });
    const later = refOf(opened.observation.text, "Later");
    const clicked = await c.execute("click", { tab_id: opened.tab_id, target: { ref: later }, settle_ms: 150 });
    assert.match(clicked.observation.text, /debounced result/);
  });

  await t.test("a genuine no-op still says so, and does not hang", async () => {
    const opened = await c.execute("open", { url, headless: true, settle_ms: 100 });
    const noop = refOf(opened.observation.text, "Noop");
    const t0 = Date.now();
    const clicked = await c.execute("click", { tab_id: opened.tab_id, target: { ref: noop }, settle_ms: 150 });
    const took = Date.now() - t0;
    assert.match(clicked.observation.text, /no changes detected/);
    assert.match(clicked.note, /No observable change/);
    assert.ok(took < 3000, `no-op settled in ${took} ms`);
  });
});
