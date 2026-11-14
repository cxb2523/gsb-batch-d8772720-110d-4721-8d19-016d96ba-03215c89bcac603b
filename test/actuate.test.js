import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCombo, platformShortcut, pressCombo, selectAllCombo } from "../src/core/actuate.js";

test("platformShortcut translates Windows-convention app shortcuts per OS", () => {
  const cases = [
    ["ctrl+alt+1", process.platform === "darwin" ? "meta+alt+1" : "ctrl+alt+1"],
    ["ctrl+end", process.platform === "darwin" ? "meta+end" : "ctrl+end"],
    ["ctrl+shift+8", process.platform === "darwin" ? "meta+shift+8" : "ctrl+shift+8"],
    ["cmd+shift+3", "cmd+shift+3"],
    ["enter", "enter"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(platformShortcut(input), expected, `${input} → ${expected}`);
    // Every translated combo must remain parseable (no synthetic tokens).
    parseCombo(platformShortcut(input));
  }
  // Round-trip stability: translating twice must not double-translate.
  assert.equal(platformShortcut(platformShortcut("ctrl+b")), platformShortcut("ctrl+b"));
});

test("CDP keyboard events use the renderer-safe native key contract on macOS", async () => {
  const calls = [];
  const ctx = { sessionId: "s1", conn: { send: async (method, params, sessionId) => calls.push({ method, params, sessionId }) } };
  await pressCombo(ctx, "meta+a");
  assert.equal(selectAllCombo(), process.platform === "darwin" ? "meta+a" : "ctrl+a");
  assert.equal(calls.length, 4, "modifier down, key down/up, modifier up");
  assert.ok(calls.every((call) => call.method === "Input.dispatchKeyEvent" && call.sessionId === "s1"));
  assert.ok(calls.every((call) => call.params.nativeVirtualKeyCode === (process.platform === "darwin"
    ? (call.params.code === "MetaLeft" ? 55 : 0)
    : call.params.windowsVirtualKeyCode)));
  assert.equal(calls[1].params.key, "A");
  assert.equal(calls[1].params.modifiers, 4);
  if (process.platform === "darwin") assert.deepEqual(calls[1].params.commands, ["selectAll"]);
});
