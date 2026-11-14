/**
 * Linux desktop driver (X11) tests.
 *
 * The live lane is SELF-CONTAINED: when Xvfb is installed the suite spawns a
 * private display and drives real windows (xev/xmessage) on it — the
 * operator's session is never touched, and CI gets genuine input-synthesis
 * coverage. Without Xvfb the live tests skip typed (allowlisted).
 *
 * Offline units (Xauthority parsing, the evdev fallback map, JPEG structure)
 * run everywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDisplay, readXauthority, X11Client } from "../src/desktop/x11.js";
import { encodeJPEG } from "../src/desktop/jpeg.js";

/* ------------------------------------------------------------- offline units */

test("linux desktop: DISPLAY strings parse (local, screen, tcp)", () => {
  assert.deepEqual(parseDisplay(":1"), { host: "", display: 1, screen: null });
  assert.deepEqual(parseDisplay(":0.0"), { host: "", display: 0, screen: 0 });
  assert.deepEqual(parseDisplay("unix:3"), { host: "unix", display: 3, screen: null });
  assert.deepEqual(parseDisplay("ho.st:4.1"), { host: "ho.st", display: 4, screen: 1 });
  assert.equal(parseDisplay("bogus"), null);
  assert.equal(parseDisplay(""), null);
});

test("linux desktop: Xauthority records decode (synthetic file)", () => {
  // Two records: a wildcard cookie and one for display :42.
  const rec = (family, num, data) => {
    const addr = Buffer.from("host1");
    const name = Buffer.from("MIT-MAGIC-COOKIE-1");
    const parts = [family, addr.length, addr, num.length, Buffer.from(num), name.length, name, data.length, data];
    const size = parts.reduce((n, p) => n + (typeof p === "number" ? 2 : p.length), 0);
    const buf = Buffer.alloc(size);
    let o = 0;
    const u16 = (v) => { buf.writeUInt16LE(v, o); o += 2; };
    for (const p of parts) {
      if (typeof p === "number") u16(p);
      else { p.copy(buf, o); o += p.length; }
    }
    return buf;
  };
  const file = mkdtempSync(join(tmpdir(), "axuse-xauth-"));
  const path = join(file, ".Xauthority");
  writeFileSync(path, Buffer.concat([
    rec(65535, "", Buffer.alloc(16, 0xaa)),
    rec(256, "42", Buffer.alloc(16, 0xbb)),
  ]));
  const records = readXauthority(path);
  assert.equal(records.length, 2);
  assert.equal(records[0].family, 65535);
  assert.equal(records[1].name, "MIT-MAGIC-COOKIE-1");
  assert.equal(records[1].data.length, 16);
  assert.deepEqual([...records[1].data], Array(16).fill(0xbb));
  rmSync(file, { recursive: true, force: true });
});

test("linux desktop: evdev fallback map is QWERTY-physical, not alphabetical", async () => {
  // Can only load the table through a client (no live server needed for the
  // static map — applyEvdevMap is deterministic).
  const c = new X11Client(":0");
  c.applyEvdevMap();
  const at = (ks) => c.keyForKeysym(ks);
  // a s d f g h j k l — 38..46; z x c v b n m — 52..58.
  assert.equal(at(0x61)?.keycode, 38);
  assert.equal(at(0x68)?.keycode, 43); // h (KEY_H=35) — NOT 45
  assert.equal(at(0x6b)?.keycode, 45); // k
  assert.equal(at(0x7a)?.keycode, 52); // z (KEY_Z=44) — NOT 63
  assert.equal(at(0x6d)?.keycode, 58); // m
  // Shift columns: uppercase needs shift on the same physical key.
  assert.equal(at(0x41)?.keycode, 38);
  assert.equal(at(0x41)?.shift, true);
  assert.equal(at(0x61)?.shift, false);
  // Named keys at canonical evdev positions.
  assert.equal(at(0xff0d)?.keycode, 36); // Return
  assert.equal(at(0xffe3)?.keycode, 37); // Control_L
  assert.equal(at(0xffeb)?.keycode, 133); // Super_L
  assert.equal(at(0xffbe)?.keycode, 67); // F1
  assert.equal(at(0xffc2)?.keycode, 71); // F5 (KEY_F5=63+8)
});

test("linux desktop: baseline JPEG encoder structure and quality scaling", () => {
  // Real content (gradient + noise) so quality affects size.
  const w = 160, h = 120;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      rgb[o] = (x * 255 / w) | 0;
      rgb[o + 1] = (y * 255 / h) | 0;
      rgb[o + 2] = ((x * y) % 256);
    }
  }
  const q90 = encodeJPEG(rgb, w, h, w * 3, 90);
  const q30 = encodeJPEG(rgb, w, h, w * 3, 30);
  // SOI … SOF0 … EOI structure.
  assert.equal(q90[0], 0xff); assert.equal(q90[1], 0xd8);
  const eoi = q90.length - 2;
  assert.equal(q90[eoi], 0xff); assert.equal(q90[eoi + 1], 0xd9);
  assert.ok(q90.includes(0xffc0, 2), "SOF0 present");
  assert.ok(q90.includes(0xffc4, 2), "DHT present");
  assert.ok(q90.includes(0xffdb, 2), "DQT present");
  // Dimensions big-endian in SOF0 (marker(2) length(2) precision(1) h(2) w(2)).
  const sof = q90.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(q90.readUInt16BE(sof + 5), h);
  assert.equal(q90.readUInt16BE(sof + 7), w);
  assert.ok(q90.length > q30.length, `q90 (${q90.length}) must outweigh q30 (${q30.length})`);
  assert.ok(q30.length > 300, "q30 is still a real image");
});

/* ---------------------------------------------------------------- live lane */

const xvfb = spawnSync("which", ["Xvfb"]).status === 0;

/** Boot a private Xvfb; resolves { display, stop } or null when impossible. */
async function startXvfb() {
  for (const num of [977, 978, 979, 980]) {
    const display = `:${num}`;
    const proc = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2500);
      proc.once("exit", () => { clearTimeout(t); resolve(false); });
      // probe: connect a throwaway client
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
    if (ok) {
      return { display, stop: () => { try { proc.kill(); } catch {} } };
    }
    try { proc.kill(); } catch {}
  }
  return null;
}

test("linux desktop: driver drives a private Xvfb (input, capture, windows)", { skip: !xvfb ? "requires Xvfb for a private display (sudo apt install xvfb)" : false }, async (t) => {
  const server = await startXvfb();
  assert.ok(server, "could not start a private Xvfb on :977-:980");
  t.after(() => server.stop());
  const { LinuxDriver } = await import("../src/desktop/linux.js");
  const d = new LinuxDriver(server.display);
  t.after(() => d.dispose());

  // screen_info: the private display's geometry (+ RandR monitor layout).
  const info = await d.screenInfo();
  assert.equal(info.w, 1280);
  assert.equal(info.h, 800);
  assert.match(info.coordinate_space, /X11 root window pixels/);
  assert.ok(info.monitors?.length === 1 && info.monitors[0].x === 0 && info.monitors[0].y === 0
    && info.monitors[0].w === 1280 && info.monitors[0].h === 800, "RandR reports the Xvfb screen (primary unset on bare Xvfb is fine)");

  // screenshot: decodable JPEG within budget (verified structurally; PIL is
  // not a dependency, so assert SOI/SOF0/EOI + dims + budget).
  const shot = await d.screenshot({ x: 0, y: 0, w: 320, h: 240, budgetBytes: 60_000 });
  assert.equal(shot.mime, "image/jpeg");
  const jpg = Buffer.from(shot.base64, "base64");
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);
  assert.ok(shot.bytes <= 60_000);
  assert.ok(shot.bytes > 500);
  await assert.rejects(
    () => d.screenshot({ x: 0, y: 0, w: 1280, h: 800, budgetBytes: 1_500 }),
    (e) => e.code === "SCREENSHOT_BUDGET_EXCEEDED",
  );
  await assert.rejects(
    () => d.screenshot({ x: 5000, y: 5000, w: 10, h: 10 }),
    (e) => e.code === "COMMAND_REJECTED",
  );

  // input: keys/clicks/wheel/drag observed through xev on the private display.
  const xev = spawn("xev", ["-display", server.display, "-geometry", "300x200+400+100"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { xev.kill(); } catch {} });
  let out = "";
  xev.stdout.on("data", (c) => { out += String(c); });
  await new Promise((r) => setTimeout(r, 700));
  const wid = Number(out.match(/Outer window is (0x[0-9a-f]+)/)?.[1]);
  assert.ok(wid > 0, "xev window mapped");

  await d.activate({ windowId: wid }); // WM-less: focuses via SetInputFocus
  await d.press("a");
  await d.type("hello"); // short + typeable → keysym path
  await d.type("line one\nline two\ttabbed"); // \n → Return, \t → Tab
  await d.press("shift+a");
  await d.press("ctrl+z");
  await d.click({ x: 500, y: 150, button: "left" });
  await d.click({ x: 520, y: 160, button: "right" });
  await d.wheel(0, 240);
  await d.drag({ from: { x: 450, y: 150 }, to: { x: 650, y: 250 }, steps: 8 });
  await new Promise((r) => setTimeout(r, 500));

  const keys = [...out.matchAll(/KeyPress[\s\S]*?keycode \d+ \(keysym 0x[0-9a-f]+, ([a-zA-Z0-9_]+)\)/g)].map((m) => m[1]);
  for (const k of ["a", "h", "e", "l", "o", "A", "z", "Return", "Tab"]) assert.ok(keys.includes(k), `key ${k} observed (saw: ${keys.join(",")})`);
  const presses = out.split("ButtonPress event").slice(1).map((b) => b.match(/button (\d+)/)?.[1]);
  assert.ok(presses.includes("1"), "left click observed");
  assert.ok(presses.includes("3"), "right click observed");
  const pressCoords = out.split("ButtonPress event").slice(1)
    .map((b) => b.match(/\(\d+,\d+\), root:\((\d+),(\d+)\)/))
    .filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(pressCoords.some(([x, y]) => x === 500 && y === 150), `click landed at (500,150), saw ${JSON.stringify(pressCoords)}`);
  assert.equal(presses.filter((b) => b === "5").length, 2, "wheel dy=240 → two button-5 notches");
  assert.ok((out.match(/MotionNotify/g) ?? []).length >= 8, "drag interpolated motion observed");

  // windows(): no WM on bare Xvfb → typed empty, never a crash.
  const w = await d.windows();
  assert.equal(w.windows.length, 0);

  // screen_info stays honest after everything.
  const info2 = await d.screenInfo();
  assert.equal(info2.w, 1280);
});

test("linux desktop: screenshot budget ladder downscales instead of dying", { skip: !xvfb ? "requires Xvfb for a private display (sudo apt install xvfb)" : false }, async (t) => {
  const server = await startXvfb();
  assert.ok(server);
  t.after(() => server.stop());
  const { LinuxDriver } = await import("../src/desktop/linux.js");
  const d = new LinuxDriver(server.display);
  t.after(() => d.dispose());

  // Fill the screen with content a flat-black Xvfb lacks: windows with text.
  const wins = [];
  t.after(() => { for (const w of wins) { try { w.kill(); } catch {} } });
  for (let i = 0; i < 6; i++) {
    wins.push(spawn("xmessage", ["-display", server.display, "-geometry", `600x400+${(i % 3) * 300}+${Math.floor(i / 3) * 250}`, `content row ${i} lorem ipsum dolor sit amet ${"x".repeat(40)}`], { stdio: "ignore" }));
  }
  await new Promise((r) => setTimeout(r, 900));

  // A full-screen capture under a harsh budget must still return a decodable
  // image (SOF0 dims prove which rung of the ladder answered).
  const shot = await d.screenshot({ x: 0, y: 0, w: 1280, h: 800, budgetBytes: 20_000 });
  const jpg = Buffer.from(shot.base64, "base64");
  const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0, "SOF0 present");
  const h = jpg.readUInt16BE(sof + 5);
  const w = jpg.readUInt16BE(sof + 7);
  assert.ok(shot.bytes <= 20_000, `bytes ${shot.bytes} within budget`);
  assert.ok(w < 1280 || h < 800, `ladder downscaled (got ${w}x${h}) — quality alone should not fit rich content in 20KB`);
  assert.ok(w >= 320 && h >= 200, `still legible (${w}x${h})`);
  assert.ok(shot.downscaled, "downscale note present");
});

test("linux desktop: long text pastes through the clipboard when xclip exists", { skip: !xvfb ? "requires Xvfb for a private display (sudo apt install xvfb)" : false }, async (t) => {
  const hasXclip = spawnSync("which", ["xclip"]).status === 0;
  if (!hasXclip) return; // allowlisted via the suite's xvfb gate reason
  const server = await startXvfb();
  assert.ok(server);
  t.after(() => server.stop());
  const { LinuxDriver } = await import("../src/desktop/linux.js");
  const d = new LinuxDriver(server.display);
  t.after(() => d.dispose());

  // Something focused to receive ctrl+v.
  const xev = spawn("xev", ["-display", server.display, "-geometry", "300x200+400+100"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { xev.kill(); } catch {} });
  let out = "";
  xev.stdout.on("data", (c) => { out += String(c); });
  await new Promise((r) => setTimeout(r, 700));
  const wid = Number(out.match(/Outer window is (0x[0-9a-f]+)/)?.[1]);
  await d.activate({ windowId: wid });

  const payload = "This sentence is deliberately longer than forty-eight characters to take the clipboard path.";
  const r1 = await d.type(payload);
  assert.equal(r1.via, "clipboard-paste");
  assert.equal(r1.clipboard_replaced, true);
  await new Promise((r) => setTimeout(r, 300));
  xev.kill();

  // The clipboard itself carries the payload (xclip -o against that display).
  const readback = spawnSync("xclip", ["-display", server.display, "-selection", "clipboard", "-out"], { encoding: "utf8" });
  assert.equal(readback.stdout.trim(), payload);

  // The paste really pressed ctrl+v into the focused window.
  assert.match(out, /KeyPress[\s\S]*?Control[\s\S]*?keysym 0x76, v/, "ctrl+v observed");
});

test("linux desktop: JPEG decodes in an independent decoder when PIL exists", { skip: !xvfb ? "requires Xvfb for a private display (sudo apt install xvfb)" : false }, async (t) => {
  const server = await startXvfb();
  assert.ok(server);
  t.after(() => server.stop());
  const { LinuxDriver } = await import("../src/desktop/linux.js");
  const d = new LinuxDriver(server.display);
  t.after(() => d.dispose());
  // Red window, then verify the average pixel is red through PIL.
  const xmsg = spawn("xmessage", ["-display", server.display, "-geometry", "200x100+50+50", "-bg", "red", "RED"], { stdio: "ignore" });
  t.after(() => { try { xmsg.kill(); } catch {} });
  await new Promise((r) => setTimeout(r, 700));
  const shot = await d.screenshot({ x: 50, y: 50, w: 200, h: 100, budgetBytes: 60_000 });
  const path = join(tmpdir(), `axuse-linux-shot-${Date.now()}.jpg`);
  writeFileSync(path, Buffer.from(shot.base64, "base64"));
  const check = spawnSync("python3", ["-c", `
from PIL import Image
import sys
im = Image.open(${JSON.stringify(path)}).convert("RGB")
px = list(im.getdata())
n = len(px)
avg = tuple(sum(c[i] for c in px)//n for i in range(3))
sys.exit(0 if avg[0] > 150 and avg[1] < 60 and avg[2] < 60 else 2)
`]);
  rmSync(path, { force: true });
  assert.equal(check.status, 0, `PIL verification failed (rc=${check.status})`);
});
