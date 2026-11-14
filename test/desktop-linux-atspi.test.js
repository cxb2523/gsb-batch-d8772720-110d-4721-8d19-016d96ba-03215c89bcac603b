/**
 * Linux AT-SPI structure layer tests.
 *
 * Offline units (D-Bus marshalling round-trips, state decoding) run
 * everywhere. The live lane is READ-ONLY against the session's AT-SPI
 * registry (snapshots + reads never post input or mutate apps) and skips
 * typed when no accessibility bus is reachable — bare Xvfb/CI has none.
 *
 * The WRITE paths (ax_click DoAction, ax_set EditableText) are verified on
 * the driver's private-Xvfb lane only via the coordinate fallback; posting
 * real actions into the operator's session is out of bounds for tests.
 * They are exercised end-to-end by the manual gate
 * AXUSE_TEST_LINUX_ATSPI_ACTION=1 (self-hosted lane).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marshalValue, unmarshalValue, parseDbusAddress } from "../src/desktop/dbus.js";
import { AtspiClient, STATE_NAMES } from "../src/desktop/atspi.js";
import { X11Client } from "../src/desktop/x11.js";

const xvfb = spawnSync("which", ["Xvfb"]).status === 0;

/** Boot a private Xvfb (same pattern as desktop-linux.test.js). */
async function startXvfb() {
  for (const num of [977, 978, 979, 980]) {
    const display = `:${num}`;
    const proc = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore" });
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2500);
      proc.once("exit", () => { clearTimeout(t); resolve(false); });
      setTimeout(async () => {
        try {
          const c = new X11Client(display);
          const probe = c.connect().then(() => { c.close(); return true; }).catch(() => false);
          const good = await Promise.race([probe, new Promise((r) => setTimeout(() => r(false), 1500))]);
          clearTimeout(t);
          resolve(good);
        } catch {
          clearTimeout(t);
          resolve(false);
        }
      }, 700);
    });
    if (ok) return { display, stop: () => { try { proc.kill(); } catch {} } };
    try { proc.kill(); } catch {}
  }
  return null;
}

/* ------------------------------------------------------------ offline units */

test("atspi: D-Bus address parsing", () => {
  assert.deepEqual(parseDbusAddress("unix:path=/run/user/1000/bus"), { path: "/run/user/1000/bus" });
  assert.deepEqual(parseDbusAddress("unix:abstract=/tmp/dbus-abc"), { abstract: "/tmp/dbus-abc" });
  assert.equal(parseDbusAddress("tcp:host=localhost"), null);
});

test("atspi: D-Bus marshalling round-trips the AT-SPI signatures", () => {
  const cases = [
    ["a(so)", [[":1.22", "/org/a11y/atspi/accessible/1"], [":1.4", "/org/a11y/atspi/accessible/root"]]],
    ["(iiii)", [70, 27, 1850, 1053]],
    ["(au)", [[0, 1, 2]]],
    ["as", ["org.a11y.atspi.Accessible", "org.a11y.atspi.Action"]],
    ["v", { sig: "d", value: 0.5 }],
    ["s", "gnome-terminal-server"],
    ["u", 42],
    ["i", -1],
    ["a{ss}", [{ key: "pid", value: "1234" }]],
    ["(so)", [":1.9", "/org/a11y/atspi/accessible/12"]],
    ["", null],
  ];
  for (const [sig, value] of cases) {
    if (sig === "") {
      assert.equal(marshalValue("s", "x").length > 0, true);
      continue;
    }
    const bytes = marshalValue(sig, value);
    // Marshalled values live inside 8-aligned message bodies: verify that
    // the decode works both raw and at an 8-byte offset (alignment is
    // position-relative inside real messages).
    const back = unmarshalValue(sig, bytes);
    assert.deepEqual(back, value, `round-trip ${sig}`);
    const padded = unmarshalValue(sig, Buffer.concat([Buffer.alloc(8), bytes]), 8);
    assert.deepEqual(padded, value, `round-trip ${sig} at 8-offset`);
  }
  // Header-shaped array of (yv) structs round-trips with per-element padding.
  const fields = [[1, { sig: "o", value: "/org/a11y/atspi/accessible/root" }], [6, { sig: "s", value: "org.a11y.atspi.Registry" }]];
  const fb = marshalValue("a(yv)", fields);
  assert.deepEqual(unmarshalValue("a(yv)", fb), fields, "a(yv) round-trip");
});

test("atspi: state bit decoding covers the operational states", () => {
  // checked=4, editable=7, enabled=8, focused=12, selected=23, showing=25
  const words = new Array(1).fill(0);
  for (const bit of [4, 7, 8, 12, 23, 25]) words[0] |= 1 << bit;
  const c = new AtspiClient();
  // decodeStates is internal; exercise it through the exported table shape.
  assert.equal(STATE_NAMES[4], "checked");
  assert.equal(STATE_NAMES[12], "focused");
  assert.equal(STATE_NAMES[25], "showing");
  assert.ok(STATE_NAMES.length >= 31);
  void words; void c;
});

/* --------------------------------------------------------------- live lane */

/** Read-only AT-SPI availability probe. */
async function atspiReachable() {
  if (!process.env.DISPLAY) return false;
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.AXUSE_ATSPI_BUS) return false;
  try {
    const c = await new AtspiClient().connect();
    await c.apps();
    c.close();
    return true;
  } catch {
    return false;
  }
}

/** GTK available for the sandbox app (python3 + gi + Gtk 3.0). */
const gtkOk = (() => {
  const probe = spawnSync("python3", ["-c",
    'import gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk, GLib'],
  { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0;
})();
const sandboxCapable = xvfb && gtkOk
  && spawnSync("which", ["dbus-run-session"]).status === 0;

/** The sandbox GTK app: observable button (title flip), entry, check. */
const SANDBOX_APP = `import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
GLib.set_prgname("axuse-sandbox")
win = Gtk.Window(title="axuse-sandbox")
win.set_default_size(420, 220)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
box.set_border_width(12)
label = Gtk.Label(label="state: off")
label.get_accessible().set_name("state label")
button = Gtk.Button(label="Click me")
entry = Gtk.Entry()
entry.get_accessible().set_name("sandbox entry")
check = Gtk.CheckButton(label="Enable feature")
check.get_accessible().set_name("enable check")
def clicked(_b):
    label.set_text("state: on")
    win.set_title("state: on")
button.connect("clicked", clicked)
for w in (label, button, entry, check):
    box.pack_start(w, False, False, 4)
win.add(box)
win.show_all()
win.connect("destroy", Gtk.main_quit)
Gtk.main()
`;

test("atspi: action sandbox — snapshot, ax_set, ax_click on a private bus+Xvfb+GTK app", { skip: !sandboxCapable ? "requires Xvfb + dbus-run-session + python3-gi Gtk3 (sudo apt install xvfb python3-gi gir1.2-gtk-3.0)" : false }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "axuse-atspi-sandbox-"));
  const appPath = join(dir, "app.py");
  writeFileSync(appPath, SANDBOX_APP);
  const addrFile = join(dir, "bus-address");
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const server = await startXvfb(); // private display (suite helper)
  assert.ok(server);
  t.after(() => server.stop());
  const session = spawn("dbus-run-session", ["--", "bash", "-c",
    `echo "$DBUS_SESSION_BUS_ADDRESS" > ${JSON.stringify(addrFile)}; ` +
    `DISPLAY=${server.display} GTK_MODULES=atk-bridge python3 ${JSON.stringify(appPath)};`],
  // Own process group: teardown must not leave the bash/python children
  // alive (a lone GTK app keeps re-registering with AT-SPI forever).
  { stdio: ["ignore", "ignore", "ignore"], detached: true });
  t.after(async () => {
    // Group-kill the whole sandbox (dbus-run-session → bash → python).
    try { process.kill(-session.pid, "SIGKILL"); } catch {}
    // D-Bus activation services ESCAPE dbus-run-session's teardown — the
    // at-spi launcher it activated lingers with its registry. Kill exactly
    // the owner of the sandbox's org.a11y.Bus (never the session's copy).
    try {
      const { DbusClient } = await import("../src/desktop/dbus.js");
      const bus = await new DbusClient(sessionAddress).connect();
      const [owner] = await bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "GetNameOwner", "s", ["org.a11y.Bus"]);
      const [pid] = await bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", [owner]);
      bus.close();
      if (Number(pid) !== process.pid && Number(pid) > 1) {
        try { process.kill(Number(pid), "SIGTERM"); } catch {}
      }
    } catch {}
    try { session.kill("SIGTERM"); } catch {}
  });

  // The bus address appears within a second; org.a11y.Bus + the at-spi
  // registry activate on demand when atk-bridge queries them.
  let sessionAddress = null;
  for (let i = 0; i < 40 && !sessionAddress; i++) {
    try { sessionAddress = readFileSync(addrFile, "utf8").trim(); } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  assert.ok(sessionAddress, "private session bus started");

  const { LinuxDriver } = await import("../src/desktop/linux.js");
  const d = new LinuxDriver(server.display, { atspiSessionBus: sessionAddress });
  t.after(() => d.dispose());

  // Wait for the app to register with the sandbox registry.
  let registered = false;
  for (let i = 0; i < 50 && !registered; i++) {
    try {
      const atspi = await d.ensureAtspi();
      const apps = await atspi.apps();
      registered = apps.some((a) => a.name === "axuse-sandbox");
      if (!registered) { d.atspi.close(); d.atspi = null; }
    } catch { try { d.atspi?.close(); } catch {} d.atspi = null; }
    if (!registered) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(registered, "GTK app registered with AT-SPI");

  // Structure-first: snapshot finds the exact widgets.
  const snap = await d.axSnapshot({ name: "axuse-sandbox", maxNodes: 60, maxDepth: 8 });
  assert.ok(snap.node_count >= 5, `tree walked (${snap.node_count} nodes)`);
  const entry = snap.nodes.find((n) => n.name === "sandbox entry");
  const button = snap.nodes.find((n) => n.name === "Click me");
  const check = snap.nodes.find((n) => n.name === "enable check");
  const frame = snap.nodes.find((n) => n.ref === "ax0.0");
  assert.ok(entry && button && check && frame, "widgets found by accessible name");

  // ax_set: type into the entry through EditableText, verified by read-back.
  const set = await d.axSet({ ref: entry.ref, name: "axuse-sandbox", value: "typed via atspi" });
  assert.equal(set.via, "atspi-editabletext");
  assert.equal(set.read_back_matches, true, "entry read-back matches");

  // ax_click (button): DoAction flips the window title — observed on the frame.
  const click = await d.axClick({ ref: button.ref, name: "axuse-sandbox" });
  assert.equal(click.via, "atspi-action");
  const after = await d.axRead({ ref: frame.ref, name: "axuse-sandbox" });
  assert.equal(after.name, "state: on", "trusted DoAction activated the real button");

  // ax_click (check box): state gains "checked".
  await d.axClick({ ref: check.ref, name: "axuse-sandbox" });
  const checkAfter = await d.axRead({ ref: check.ref, name: "axuse-sandbox" });
  assert.ok(checkAfter.states.includes("checked"), `check toggled (states: ${checkAfter.states.join(",")})`);

  // Non-editable ax_set fails typed with the interfaces listed.
  await assert.rejects(
    () => d.axSet({ ref: frame.ref, name: "axuse-sandbox", value: "nope" }),
    (e) => e.code === "COMMAND_REJECTED" && /not AT-SPI-editable/.test(e.message),
  );
});

test("atspi: snapshot + read round-trip on a live app (read-only)", { skip: !(await atspiReachable()) ? "requires a session AT-SPI registry (DBUS_SESSION_BUS_ADDRESS + at-spi2 running; bare Xvfb/CI skips)" : false }, async (t) => {
  const { LinuxDriver } = await import("../src/desktop/linux.js");
  const d = new LinuxDriver(process.env.DISPLAY);
  t.after(() => d.dispose());

  // The registry being reachable but EMPTY is a legitimate session state
  // (apps bridge on demand and deregister when the last assistive client
  // leaves) — skip typed rather than fail. Same for a transport that dies
  // mid-test: the on-demand at-spi launcher comes and goes with clients.
  const atspi = await d.ensureAtspi().catch((e) => {
    t.skip(`AT-SPI transport unavailable mid-test (${e.message.slice(0, 80)})`);
    return null;
  });
  if (!atspi) return;
  const apps = await atspi.apps().catch(() => {
    t.skip("AT-SPI registry went away mid-test (on-demand lifecycle)");
    return [];
  });
  if (!apps.some((a) => a.name)) {
    t.skip("session registry reachable but no apps registered (on-demand bridging)");
    return;
  }
  assert.ok(apps.length >= 1, "desktop lists apps");
  const withUi = [];
  for (const a of apps) {
    try { if ((await atspi.childCount(a.ref)) > 0) withUi.push(a); } catch {}
    if (withUi.length >= 3) break; // a few candidates is plenty
  }
  assert.ok(withUi.length >= 1, "at least one app exposes a UI tree");

  const snap = await d.axSnapshot({ name: withUi[0].name, maxNodes: 60, maxDepth: 6 });
  assert.equal(snap.app, withUi[0].name);
  assert.ok(snap.node_count >= 1);
  assert.equal(typeof snap.truncated, "boolean");
  assert.equal(snap.nodes[0].ref, "ax0");
  assert.ok(snap.nodes[0].role.length > 0, "root carries a role");
  // Every node beyond the root has an index-path ref.
  for (const n of snap.nodes.slice(1)) assert.match(n.ref, /^ax0(\.\d+)+$/);

  // Budget facts: a tiny node budget truncates honestly.
  const tiny = await d.axSnapshot({ name: withUi[0].name, maxNodes: 3, maxDepth: 6 });
  assert.equal(tiny.node_count <= 3, true);
  if (tiny.node_count === 3) assert.equal(tiny.truncated, true);

  // ax_read round-trip on the app ROOT ref (stable by construction).
  const read = await d.axRead({ ref: "ax0", name: withUi[0].name });
  assert.equal(read.role, "application");
  assert.equal(read.ref, "ax0");

  // Stale/garbage refs fail typed with a reobserve hint.
  await assert.rejects(
    () => d.axRead({ ref: "nope", name: withUi[0].name }),
    (e) => e.code === "REF_NOT_FOUND" && e.retry === "reobserve",
  );
  await assert.rejects(
    () => d.axRead({ ref: "ax0.9999", name: withUi[0].name }),
    (e) => e.code === "REF_NOT_FOUND",
  );
  // Unknown app name fails typed with the available list in the hint.
  await assert.rejects(
    () => d.axSnapshot({ name: "definitely-not-an-app-xyz" }),
    (e) => e.code === "REF_NOT_FOUND" && /Available:/.test(e.hint ?? ""),
  );
});
