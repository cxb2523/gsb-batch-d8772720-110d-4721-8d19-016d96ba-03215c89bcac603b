import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots, noChangeText } from "../src/core/diff.js";

const snap = (entries, url = "https://x/", title = "t") => ({
  stateId: 1, entries, url, title, truncated: false,
});

test("diff: removed / added / changed are classified per ref", () => {
  const prev = snap([
    { ref: "e1", line: '- link "Home" [ref=e1]' },
    { ref: "e2", line: '- button "Add item" [ref=e2]' },
    { ref: "e3", line: '- textbox "Name" (value="") [ref=e3]' },
  ]);
  const next = {
    stateId: 2,
    entries: [
      { ref: "e2", line: '- button "Add item" [ref=e2]' },
      { ref: "e3", line: '- textbox "Name" (value="hello") [ref=e3]' },
      { ref: "e5", line: '- button "Remove item" [ref=e5]' },
    ],
    url: "https://x/", title: "t", truncated: false,
  };
  const d = diffSnapshots(prev, next);
  assert.equal(d.mode, "diff");
  assert.deepEqual(d.removed.map((e) => e.ref), ["e1"]);
  assert.deepEqual(d.added.map((e) => e.ref), ["e5"]);
  assert.deepEqual(d.changed.map((c) => c.ref), ["e3"]);
  assert.match(d.text, /removed:/);
  assert.match(d.text, /added:/);
  assert.match(d.text, /changed:/);
});

test("diff: unchanged refs stay valid and produce no noise", () => {
  const prev = snap([{ ref: "e1", line: "- button \"Go\" [ref=e1]" }]);
  const next = {
    stateId: 2, entries: [{ ref: "e1", line: "- button \"Go\" [ref=e1]" }],
    url: "https://x/", title: "t", truncated: false,
  };
  const d = diffSnapshots(prev, next);
  assert.equal(d.removed.length + d.added.length + d.changed.length, 0);
  assert.match(noChangeText(prev, next), /no changes detected/);
});

test("diff: text lines participate (multiset)", () => {
  const prev = {
    stateId: 1, entries: [],
    textLines: ['- text "hello"', '- text "world"'],
    url: "https://x/", title: "t", truncated: false,
  };
  const next = {
    stateId: 2, entries: [],
    textLines: ['- text "world"', '- text "done"', '- text "done"'],
    url: "https://x/", title: "t", truncated: false,
  };
  const d = diffSnapshots(prev, next);
  assert.equal(d.mode, "diff");
  assert.deepEqual(d.textAdded, ['- text "done"', '- text "done"']);
  assert.deepEqual(d.textRemoved, ['- text "hello"']);
  assert.match(d.text, /text added:/);
  assert.match(d.text, /text removed:/);
});

test("diff: navigation-scale churn on a big tree falls back to full", () => {
  const mk = (prefix, n) => ({
    stateId: 1,
    entries: Array.from({ length: n }, (_, i) => ({ ref: `${prefix}${i}`, line: `- item ${i} [ref=${prefix}${i}]` })),
    url: "https://x/", title: "t", truncated: false,
    text: Array.from({ length: n }, (_, i) => `- item ${i} [ref=${prefix}${i}]`).join("\n"),
  });
  const prev = mk("a", 25);
  const next = { ...mk("z", 25), stateId: 2, url: "https://new/" };
  const d = diffSnapshots(prev, next);
  // 25 removed + 25 added ≈ twice the full tree → a full snapshot is cheaper.
  assert.equal(d.mode, "full");
});

test("diff: churn on a small tree stays diff (ref addressing preserved)", () => {
  const prev = {
    stateId: 1,
    entries: [{ ref: "a0", line: "- x [ref=a0]" }, { ref: "a1", line: "- y [ref=a1]" }],
    url: "https://x/", title: "t", truncated: false,
  };
  const next = {
    stateId: 2,
    entries: [{ ref: "a1", line: "- y [ref=a1]" }, { ref: "z1", line: "- new [ref=z1]" }],
    url: "https://x/", title: "t", truncated: false,
  };
  const d = diffSnapshots(prev, next);
  assert.equal(d.mode, "diff");
  assert.match(d.text, /removed:/);
  assert.match(d.text, /added:/);
});
