/**
 * axuse micro-benchmark — real numbers for the comparison:
 *   - observation cost: full snapshot chars/tokens, latency
 *   - diff cost after an action: chars/tokens, latency
 *   - action round trip latency (observe→act→diff)
 *   - screenshot budget reality (bytes for a viewport on a real page)
 * Tokens estimated at ~4 chars/token for text; images at ~1.3k-1.6k tokens
 * for a 1280x720-class JPEG plus vision-encoder prefill latency (not
 * measurable here, so reported as bytes + the standard estimate range).
 */
import http from "node:http";
import { once } from "node:events";
import { Controller } from "../src/core/controller.js";
import { locateBrowser } from "../src/core/cdp.js";

const hasBrowser = !!locateBrowser();

// A page with a realistic amount of UI structure (50-ish interactive elements).
const n = 12;
let html = `<!doctype html><html><head><title>bench</title></head><body>
<h1>Bench page</h1>`;
for (let i = 0; i < n; i++) {
  html += `
<nav><a href="#s${i}">link ${i}</a></nav>
<section>
  <form>
    <label for="f${i}">Field ${i}</label>
    <input id="f${i}" placeholder="type here" />
    <select id="s${i}"><option value="a">Alpha</option><option value="b">Beta</option></select>
    <button type="button" id="b${i}" onclick="document.getElementById('o${i}').textContent='done ${i}'">Go ${i}</button>
    <div id="o${i}" style="min-height:1em"></div>
  </form>
</section>`;
}
html += `</body></html>`;

const srv = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(html); });
srv.listen(0, "127.0.0.1");
await once(srv, "listening");
const url = `http://127.0.0.1:${srv.address().port}/`;

const c = new Controller();

// Cold start: browser launch + first observation.
let t0 = Date.now();
const opened = await c.execute("open", { url, headless: true, settle_ms: 100 });
const openMs = Date.now() - t0;
const full = opened.observation.text;
const fullChars = full.length;
const estTokens = Math.ceil(fullChars / 4);

// Warm observation (diff mode with no changes).
t0 = Date.now();
const obs1 = await c.execute("observe", { mode: "diff" });
const warmDiffMs = Date.now() - t0;

// Warm full observation.
t0 = Date.now();
const obs2 = await c.execute("observe", { mode: "full" });
const warmFullMs = Date.now() - t0;
const warmFullChars = obs2.observation.text.length;

// Action round trip: click → auto-diff returns.
const ref = full.match(/button "Go 3"[^\[]*\[ref=(e\d+)\]/)[1];
t0 = Date.now();
const clicked = await c.execute("click", { target: { ref }, settle_ms: 120 });
const actMs = Date.now() - t0;
const diffChars = (clicked.observation?.text ?? "").length;
const diffTokens = Math.ceil(diffChars / 4);
const diffSawChange = /done 3/.test(clicked.observation?.text ?? "");

// Screenshot reality check (what a vision-loop step would cost instead).
t0 = Date.now();
const shot = await c.execute("screenshot", {});
const shotMs = Date.now() - t0;
const shotBytes = shot.image.bytes;

// Typing round trip.
const fieldRef = full.match(/textbox "Field 3"[^\[]*\[ref=(e\d+)\]/)[1];
t0 = Date.now();
const typed = await c.execute("type", { target: { ref: fieldRef }, text: "hello world", settle_ms: 120 });
const typeMs = Date.now() - t0;

await c.execute("close", { browser: true });
srv.close();

const fmt = (ms) => `${ms}ms`;
console.log(JSON.stringify({
  page: { interactive_elements: n * 3 + n, sections: n },
  cold_open_launch_plus_first_full_observation: fmt(openMs),
  first_full_snapshot: { chars: fullChars, est_tokens: estTokens },
  warm_full_observation: { latency: fmt(warmFullMs), chars: warmFullChars },
  warm_diff_observation_no_change: { latency: fmt(warmDiffMs), text: obs1.observation.text.slice(0, 60) },
  click_to_diff_round_trip: { latency: fmt(actMs), diff_chars: diffChars, diff_est_tokens: diffTokens, diff_saw_change: diffSawChange },
  type_to_diff_round_trip: { latency: fmt(typeMs), diff_chars: (typed.observation?.text ?? "").length },
  screenshot_for_comparison: { latency: fmt(shotMs), jpeg_bytes: shotBytes, est_image_tokens: "≈1.1k-1.6k + vision-encoder prefill per step (a vision loop pays this EVERY step)" },
}, null, 2));
process.exit(0);
