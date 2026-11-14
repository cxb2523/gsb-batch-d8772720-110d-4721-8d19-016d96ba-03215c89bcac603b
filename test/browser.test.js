/**
 * Live CDP flow test — gated on a findable browser. Exercises the whole
 * core: launch, navigate, full observation, ref-click → auto-diff, type,
 * select, element_info, events, screenshot budget, close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();
const pageUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "page.html")).href;

test("browser flow", { skip: !hasBrowser }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());

  const opened = await c.execute("open", { url: pageUrl, headless: true, settle_ms: 100 });
  assert.match(opened.observation.text, /axuse fixture/);
  assert.match(opened.observation.text, /button "Add item"/);
  assert.equal(opened.observation.mode, "full");
  const stateId = opened.observation.state_id;

  // Ref resolution: the "Add item" button — first snapshot's button.
  const snap = opened.observation.text;
  const refMatch = snap.match(/button "Add item"[^\[]*\[ref=(e\d+)\]/);
  assert.ok(refMatch, "Add item has a ref");
  const ref = refMatch[1];

  const clicked = await c.execute("click", { target: { ref }, settle_ms: 120 });
  assert.equal(clicked.action_sent, "sent");
  assert.match(clicked.observation.text, /listitem "item 1"/, "diff shows the added item");

  // Stale state guard: acting with the pre-click state_id must fail typed.
  await assert.rejects(
    () => c.execute("click", { target: { ref }, state_id: stateId, settle_ms: 50 }),
    (e) => e.code === "STALE_STATE" && e.retry === "reobserve",
  );

  // Type into the field by ref (label-associated) and submit via form.
  const fieldRef = snap.match(/textbox "Name"[^\[]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(fieldRef, "field has a ref");
  const typed = await c.execute("type", { target: { ref: fieldRef }, text: "hello axuse", settle_ms: 120 });
  assert.match(typed.observation.text, /value="hello axuse"/);

  // Replacement is a real macOS regression guard: Command+A needs the
  // platform editing command in addition to the DOM key metadata.
  const replaced = await c.execute("type", { target: { ref: fieldRef }, text: "replaced axuse", settle_ms: 120 });
  assert.match(replaced.observation.text, /value="replaced axuse"/);

  const submitRef = snap.match(/button "Echo"[^\[]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(submitRef, "submit has a ref");
  const submitted = await c.execute("click", { target: { ref: submitRef }, settle_ms: 150 });
  assert.match(submitted.observation.text, /replaced axuse/);

  // Select an option by value.
  const comboRef = snap.match(/combobox "Name"[^\[]*\[ref=(e\d+)\]/)?.[1]
    ?? snap.match(/combobox[^\[]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(comboRef, "select has a ref");
  const selected = await c.execute("select", { ref: comboRef, value: "b", settle_ms: 120 });
  assert.equal(selected.value, "b");

  // Coordinates → structure bridge.
  const info = await c.execute("element_info", { x: 20, y: 20 });
  assert.ok(info.hit === null || typeof info.hit.tag === "string");

  // Bounded wait (selector mode).
  const waited = await c.execute("wait_for", { selector: "#echo", timeout_ms: 2000 });
  assert.equal(waited.ok, true);

  // Event ring buffer: navigations should have been recorded.
  const ev = await c.execute("events", {});
  assert.ok(Array.isArray(ev.events));

  // Screenshot budget with a small crop.
  const shot = await c.execute("screenshot", { crop: { x: 0, y: 0, w: 200, h: 200 } });
  assert.ok(shot.image.bytes > 0 && shot.image.bytes <= 200000);
  assert.match(shot.note, /image 200x200/);

  // Refs die with the document on navigation.
  const nav = await c.execute("navigate", { url: "about:blank", settle_ms: 100 });
  assert.equal(nav.observation.mode, "full");
  await assert.rejects(
    () => c.execute("click", { target: { ref }, settle_ms: 50 }),
    (e) => e.code === "REF_NOT_FOUND" && e.retry === "reobserve",
  );

  // Batch inspection opens sequentially, returns compact excerpts, and does
  // not leave temporary tabs behind by default.
  const batch = await c.execute("open_many", {
    urls: [
      "data:text/html,<title>batch one</title><h1>one</h1>",
      "data:text/html,<title>batch two</title><h1>two</h1>",
    ],
    headless: true,
    settle_ms: 80,
    excerpt_chars: 200,
  });
  assert.equal(batch.opened, 2);
  assert.equal(batch.failed, 0);
  assert.equal(batch.results[0].title, "batch one");
  assert.match(batch.results[1].excerpt, /heading "two"/);
  assert.equal((await c.execute("tabs", {})).tabs.length, 1, "batch closed its temporary tabs");

  // Typed rejection: bad params fail with COMMAND_REJECTED, never silently.
  await assert.rejects(
    () => c.execute("click", { target: { ref: 123 } }),
    (e) => e.code === "COMMAND_REJECTED",
  );

  await c.execute("close", { browser: true });
});

test("fill: ARIA and native sliders via trusted Arrow keys", { skip: !hasBrowser }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  const opened = await c.execute("open", { url: pageUrl, headless: true, settle_ms: 150 });
  const snap = opened.observation.text;

  // Native range input (step 5, 0..50): target reachable exactly.
  const rngRef = snap.match(/slider "Volume"[^\[]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(rngRef, "native range has a ref");
  const rng = await c.execute("fill", { fields: [{ ref: rngRef, value: 30 }], settle_ms: 120 });
  assert.match(rng.filled[0], /set to 30/, rng.filled.join(";"));
  assert.equal(JSON.parse((await c.execute("evaluate", { expression: "document.getElementById('rng').value" })).value), "30");

  // ARIA slider widget (custom keydown handler, step 2, 0..20, starts at 4).
  const ariaRef = snap.match(/slider "aria slider"[^\[]*\[ref=(e\d+)\]/)?.[1];
  assert.ok(ariaRef, "aria slider has a ref");
  const aria = await c.execute("fill", { fields: [{ ref: ariaRef, value: 10 }], settle_ms: 120 });
  assert.match(aria.filled[0], /set to 10/, aria.filled.join(";"));
  assert.equal(JSON.parse((await c.execute("evaluate", { expression: "document.getElementById('aslider').getAttribute('aria-valuenow')" })).value), "10");

  // Out-of-range target (25 on a 0..20 slider) fails typed and honestly
  // reports where it stopped (clamped at the max).
  await assert.rejects(
    () => c.execute("fill", { fields: [{ ref: ariaRef, value: 25 }], settle_ms: 100 }),
    (e) => e.code === "COMMAND_REJECTED" && /stopped at 20/.test(e.message),
  );

  await c.execute("close", { browser: true });
});

test("fill: foreign-tab refs fail with a hint naming the owning tab", { skip: !hasBrowser }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  // Tab A: e1 is a textbox. Tab B (opened last, becomes active): e1 is a button div.
  const a = await c.execute("open", {
    url: "data:text/html," + encodeURIComponent('<input aria-label="one" value="">'),
    headless: true, settle_ms: 120,
  });
  const b = await c.execute("open", {
    url: "data:text/html," + encodeURIComponent('<div role="button">two</div>'),
    headless: true, settle_ms: 120,
  });
  assert.match(b.observation.text, /button "two"/);
  const err = await c.execute("fill", { tab_id: b.tab_id, fields: [{ ref: "e1", value: "hello" }], settle_ms: 80 }).then(
    () => { throw new Error("expected rejection"); },
    (e) => e,
  );
  assert.equal(err.code, "COMMAND_REJECTED");
  assert.match(err.message, /is not a form field on tab/);
  assert.match(err.hint, new RegExp(`Ref "e1" is a fillable field on ${a.tab_id} \\(text,`), err.hint ?? "");
  await c.execute("close", { browser: true });
});
