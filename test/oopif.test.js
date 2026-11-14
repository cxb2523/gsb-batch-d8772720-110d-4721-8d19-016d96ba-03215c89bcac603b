/**
 * OOPIF test — cross-origin loopback iframe (127.0.0.1 parent, localhost
 * child) must be auto-attached, merged into the snapshot under f-slot refs,
 * and actionable (click inside the frame via the frame's own session).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();

const childHtml = `<!doctype html><html><body>
  <h2>child frame</h2>
  <button id="cb" onclick="document.getElementById('co').textContent='child done'">child button</button>
  <div id="co" style="min-height:1em"></div>
  <script>window.__loaded = true;</script>
</body></html>`;

const parentHtml = (childPort) => `<!doctype html><html><body>
  <h1>parent</h1>
  <button id="pb" onclick="this.textContent='pclicked'">parent button</button>
  <iframe id="ifr" src="http://localhost:${childPort}/child.html" style="width:400px;height:120px;margin:40px 0 0 60px"></iframe>
  <div id="po" style="min-height:1em"></div>
</body></html>`;

test("oopif: auto-attach, merged snapshot, in-frame click", { skip: !hasBrowser }, async (t) => {
  const childSrv = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(childHtml); });
  childSrv.listen(0, "localhost");
  await once(childSrv, "listening");
  const parentSrv = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(parentHtml(childSrv.address().port)); });
  parentSrv.listen(0, "127.0.0.1");
  await once(parentSrv, "listening");
  t.after(() => { childSrv.close(); parentSrv.close(); });

  const c = new Controller();
  t.after(() => c.dispose());

  const opened = await c.execute("open", {
    url: `http://127.0.0.1:${parentSrv.address().port}/`,
    headless: true,
    settle_ms: 500, // give the OOPIF time to attach and load
  });

  // Frame content must be merged under f1: refs and reachable.
  const snapText = opened.observation.text;
  if (!/--- frame f1/.test(snapText)) {
    console.error("SNAPSHOT (no frame merged):\n" + snapText);
  }
  assert.match(snapText, /--- frame f1/, "frame f1 section is merged");
  assert.match(snapText, /iframe.*cross-origin.*\[ref=e\d+\]/, "the OOPIF iframe itself has a ref + cross-origin marker");
  assert.match(snapText, /button "child button" \[ref=f1:e\d+\]/, "frame button has an f-prefixed ref");

  // Click the button inside the cross-origin frame, by frame ref.
  const frameRef = snapText.match(/button "child button" \[ref=(f1:e\d+)\]/)[1];
  const clicked = await c.execute("click", { target: { ref: frameRef }, settle_ms: 300 });
  assert.equal(clicked.action_sent, "sent");
  assert.match(clicked.observation.text, /child done/, "diff shows the in-frame text change");

  // Frame-slot refs stay stable across observations.
  const again = await c.execute("observe", { mode: "diff" });
  assert.ok(again.observation.state_id > opened.observation.state_id);

  // The events ring buffer saw the frame attach.
  const ev = await c.execute("events", {});
  assert.ok(ev.events.some((e) => e.method === "frame.attached" && e.data.frame === "f1"));

  await c.execute("close", { browser: true });
});
