/**
 * Server mode — the display-less-Linux-host lane: headed Chrome on an
 * auto-booted private Xvfb (never --headless, which challenge/anti-bot pages
 * detect as their first step).
 *
 * Two lanes:
 *  - unit (always): pure decision seams — size parsing, DISPLAY parsing +
 *    dead-display detection, the launch decision matrix, display-number
 *    picking, env parsing, the no-sandbox decision.
 *  - live (Linux + Xvfb + a browser): the REAL lane end-to-end with a dead
 *    DISPLAY forced in-process — server mode must boot a private Xvfb,
 *    launch Chrome fully headed on it, and expose an anti-bot posture
 *    (no Headless UA, navigator.webdriver false, desktop viewport, WebGL).
 *    The live tests are hermetic: they force a dead DISPLAY value and boot
 *    their own Xvfb; they never touch the operator's session display.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  parseDisplaySize, displayNumber, displayUsable, displayGeometry,
  serverModeEnabled, serverModePlan, pickDisplayNumber, takenDisplayNumbers,
  needsNoSandbox, virtualDisplayStatus, __resetVirtualDisplay,
  COMMON_DISPLAY_SIZES, pickFleetDisplaySize, validTimezone,
  isStaleAxuseXvfb, sweepStaleXvfb,
} from "../src/core/vdisplay.js";
import { locateBrowser, postureScript } from "../src/core/cdp.js";
import { planPointerJitter } from "../src/core/actuate.js";
import { Controller } from "../src/core/controller.js";

/* ------------------------------------------------------------ unit lane */

test("server mode: display-size parsing accepts only sane geometries", () => {
  assert.deepEqual(parseDisplaySize("1920x1080x24"), { w: 1920, h: 1080, d: 24 });
  assert.deepEqual(parseDisplaySize("1366x768"), { w: 1366, h: 768, d: 24 });
  assert.equal(parseDisplaySize("8000x600"), null); // width over cap
  assert.equal(parseDisplaySize("320x240"), null); // under floor
  assert.equal(parseDisplaySize("1920"), null);
  assert.equal(parseDisplaySize("1920x1080x8"), null); // bad depth
  assert.equal(parseDisplaySize(""), null);
  assert.equal(parseDisplaySize(null), null);
  // geometry falls back to the default when AXUSE_DISPLAY_SIZE is garbage
  assert.deepEqual(displayGeometry({}), { w: 1920, h: 1080, d: 24 });
  assert.deepEqual(displayGeometry({ AXUSE_DISPLAY_SIZE: "1280x720x32" }), { w: 1280, h: 720, d: 32 });
});

test("server mode: DISPLAY parsing and dead-display detection", () => {
  assert.equal(displayNumber(":1"), 1);
  assert.equal(displayNumber(":1.0"), 1);
  assert.equal(displayNumber("localhost:10.0"), 10);
  assert.equal(displayNumber("unix:0"), 0);
  assert.equal(displayNumber(""), null);
  assert.equal(displayNumber(null), null);
  assert.equal(displayNumber("garbage"), null);
  // A dead DISPLAY counts as absent — that is what makes the fallback safe
  // on hosts that carry a stale value (closed SSH forward, dead CI :99).
  assert.equal(displayUsable(":65530"), false); // no such X socket, ever
  // Injectable exists seam: a "socket" for :42 → usable
  // (the socket path uses the platform's separator, so match either)
  assert.equal(displayUsable(":42", { exists: (p) => /[\\/]X42$/.test(p) }), true);
  assert.equal(displayUsable(":43", { exists: (p) => /[\\/]X42$/.test(p) }), false);
});

test("server mode: the launch decision matrix is pure and typed", () => {
  const base = { platform: "linux", headless: false, display: "", usable: false, xvfb: true, enabled: true };
  assert.equal(serverModePlan({ ...base }).action, "boot");
  // not linux / headless / live display → no server mode involvement
  assert.equal(serverModePlan({ ...base, platform: "win32" }).action, "native");
  assert.equal(serverModePlan({ ...base, headless: true }).action, "skip");
  assert.equal(serverModePlan({ ...base, usable: true }).action, "native");
  // dead display + disabled → typed hint naming AXUSE_SERVER_MODE
  const off = serverModePlan({ ...base, enabled: false });
  assert.equal(off.action, "fail-disabled");
  assert.match(off.hint, /AXUSE_SERVER_MODE/);
  // dead display + no Xvfb → typed install hint
  const noX = serverModePlan({ ...base, xvfb: false });
  assert.equal(noX.action, "fail-xvfb");
  assert.match(noX.hint, /apt-get install -y xvfb/);
  assert.match(noX.hint, /detect --headless/);
});

test("server mode: free display numbers are picked away from taken ones", () => {
  const taken = takenDisplayNumbers();
  assert.ok(taken.includes(0) && taken.includes(1), "native session displays are never taken");
  // Deterministic draws: 20 (busy), 21 (busy), then a free one.
  let i = 0;
  const seq = () => [0, 1 / 978, 0.5][i++];
  const n1 = pickDisplayNumber({ taken: [20, 21], random: seq });
  assert.ok(![20, 21].includes(n1) && n1 >= 20 && n1 <= 997, `picked a free number, got ${n1}`);
  const n2 = pickDisplayNumber({ taken: [], random: () => 0.5 });
  assert.ok(n2 >= 20 && n2 <= 997);
  // taken: everything in the range → falls back above 1000 instead of failing
  const busy = Array.from({ length: 978 }, (_, k) => 20 + k);
  assert.ok(pickDisplayNumber({ taken: busy, random: () => 0 }) >= 1000);
});

test("server mode: AXUSE_SERVER_MODE / no-sandbox env parsing", () => {
  for (const v of ["", "auto", "1", "true", "on", undefined]) {
    assert.equal(serverModeEnabled({ AXUSE_SERVER_MODE: v }), true, `enabled: ${v}`);
  }
  for (const v of ["0", "off", "false", "no"]) {
    assert.equal(serverModeEnabled({ AXUSE_SERVER_MODE: v }), false, `disabled: ${v}`);
  }
  // no-sandbox: explicit env beats everything; root forces it; otherwise off
  assert.deepEqual(needsNoSandbox({ uid: 1000, env: { AXUSE_NO_SANDBOX: "1" } }), { add: true, reason: "AXUSE_NO_SANDBOX=1" });
  assert.equal(needsNoSandbox({ uid: 0, env: {} }).add, true);
  assert.match(needsNoSandbox({ uid: 0, env: {} }).reason, /root/);
  assert.equal(needsNoSandbox({ uid: 1000, env: {} }).add, false);
});

test("server mode: fleet display diversity — 'random' is stable per machine and stays in the common list", () => {
  // Deterministic per machine (seed) — one persona per machine across boots.
  const a = pickFleetDisplaySize("host-a:1000");
  const b = pickFleetDisplaySize("host-a:1000");
  assert.deepEqual(a, b, "same machine → same geometry");
  assert.ok(COMMON_DISPLAY_SIZES.some((s) => s.w === a.w && s.h === a.h), "picked from the weighted common list");
  // A fleet spreads: 24 machines cover ≥3 distinct geometries.
  const distinct = new Set(Array.from({ length: 24 }, (_, i) => {
    const g = pickFleetDisplaySize(`host-${i}:1000`);
    return `${g.w}x${g.h}`;
  }));
  assert.ok(distinct.size >= 3, `24 machines spread across only ${distinct.size} geometries`);
  // displayGeometry honors 'random' (case-insensitive) and rejects garbage.
  assert.ok(COMMON_DISPLAY_SIZES.some((s) => {
    const g = displayGeometry({ AXUSE_DISPLAY_SIZE: "RANDOM" });
    return s.w === g.w && s.h === g.h;
  }));
  assert.deepEqual(displayGeometry({ AXUSE_DISPLAY_SIZE: "nonsense" }), { w: 1920, h: 1080, d: 24 });
});

test("server mode: IANA timezone validation (the same engine Chrome uses)", () => {
  assert.equal(validTimezone("Europe/Amsterdam"), "Europe/Amsterdam");
  assert.equal(validTimezone("America/New_York"), "America/New_York");
  assert.equal(validTimezone("Not/AZone"), null);
  assert.equal(validTimezone(""), null);
  assert.equal(validTimezone(null), null);
});

test("server mode: pointer park-fuzz stays tight with rare excursions, human cadence", () => {
  let i = 0;
  const seq = () => [0.01, 0.5, 0.99, 0.3, 0.7][i++ % 5];
  const anchor = { x: 500, y: 400 };
  let excursions = 0;
  let micros = 0;
  for (let n = 0; n < 60; n++) {
    const j = planPointerJitter(anchor, { random: seq });
    const d = Math.hypot(j.x - anchor.x, j.y - anchor.y);
    assert.ok(d >= 1 && d <= 20, `jitter distance ${d}`);
    if (d > 5) excursions++; else micros++;
    assert.ok(j.nextInMs >= 1400 && j.nextInMs <= 4200, `cadence ${j.nextInMs}`);
  }
  assert.ok(excursions >= 1 && micros > excursions, `mix: ${micros} micro / ${excursions} excursions`);
});

test("server mode: posture script — conditional, tamper-invisible, opt-in persona overrides", () => {
  const base = postureScript({});
  // The guard: on builds where the AutomationControlled flag already returns
  // false, the script must touch NOTHING (replacing a native getter with JS
  // source is itself detectable — measured live).
  assert.match(base, /if \(navigator\.webdriver !== false\)/, "patches only when the flag did not fix it");
  // The mask: fallback getters present native source at the descriptor level.
  assert.match(base, /\[native code\]/);
  assert.doesNotMatch(base, /hardwareConcurrency/, "honest cores stay the default");
  assert.doesNotMatch(base, /deviceMemory/, "honest memory stays the default");
  const cores = postureScript({ AXUSE_FP_CORES: "8" });
  assert.match(cores, /return 8;/, "cores override present");
  assert.match(cores, /get hardwareConcurrency\(\) \{ \[native code\] \}/, "cores override is masked");
  assert.doesNotMatch(cores, /deviceMemory/);
  // deviceMemory lands in Chrome's 0.25/0.5/1/2/4/8 buckets (16 GB input → 8),
  // and only where the platform exposes the API.
  const mem = postureScript({ AXUSE_FP_MEMORY: "16" });
  assert.match(mem, /'deviceMemory' in navigator[^]+return 8;/);
  assert.match(postureScript({ AXUSE_FP_MEMORY: "3" }), /return 2;/);
  // Garbage values are ignored, never a broken page.
  const junk = postureScript({ AXUSE_FP_CORES: "zero", AXUSE_FP_MEMORY: "-1" });
  assert.doesNotMatch(junk, /hardwareConcurrency/);
  assert.doesNotMatch(junk, /deviceMemory/);
});

test("server mode: Xvfb zombie sweep — only our exact-signature orphans die", () => {
  const mk = (pid, ppid, argv, first = "Xvfb") => ({ pid, ppid, argv: [first, ...argv] });
  const ours = mk(101, 1, [":311", "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp", "-noreset"]);
  const liveParent = mk(102, 900, [":312", "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp", "-noreset"]);
  const noReset = mk(103, 1, [":313", "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp"]); // not ours (no -noreset)
  const otherName = mk(104, 1, [":314", "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp", "-noreset"], "Xvfb-run-wrapper");
  assert.equal(isStaleAxuseXvfb(ours), true);
  assert.equal(isStaleAxuseXvfb(liveParent), false, "a live parent owns it — never touched");
  assert.equal(isStaleAxuseXvfb(noReset), false, "no -noreset: not our signature");
  assert.equal(isStaleAxuseXvfb(otherName), false, "argv[0] must be exactly Xvfb");
  // sweepStaleXvfb: fake /proc, only the orphan is killed.
  const killed = [];
  const stat = { 101: ours, 102: liveParent, 103: noReset, 104: otherName };
  const swept = sweepStaleXvfb({
    listDir: () => Object.keys(stat),
    readFile: (p) => {
      const m = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(p);
      const e = stat[Number(m[1])];
      return m[2] === "stat"
        ? `Xvfb (x) S ${e.ppid}`
        : e.argv.join("\0");
    },
    kill: (pid) => { killed.push(pid); },
  });
  assert.deepEqual(swept, [{ pid: 101, display: ":311" }]);
  assert.deepEqual(killed, [101]);
  // No /proc (non-Linux-shaped hosts): sweep is a silent no-op.
  assert.deepEqual(sweepStaleXvfb({ listDir: () => { throw new Error("ENOENT"); }, kill: () => assert.fail("must not kill") }), []);
});

/* ------------------------------------------------------------ live lane */

const linux = process.platform === "linux";
const xvfb = spawnSync("which", ["Xvfb"]).status === 0;
const hasBrowser = !!locateBrowser();
const liveGate = linux && xvfb && hasBrowser;
const liveSkip = liveGate ? false
  : "requires Linux + Xvfb + a Chromium-family browser (sudo apt install xvfb; server mode is the display-less Linux lane)";
const DEAD_DISPLAY = ":988"; // the suite's own dead value (desktop lane uses :977-:980)

/** Force the in-process dead-display world; restores afterwards. */
function withDeadDisplay() {
  const savedDisplay = process.env.DISPLAY;
  const savedMode = process.env.AXUSE_SERVER_MODE;
  process.env.DISPLAY = DEAD_DISPLAY;
  process.env.AXUSE_SERVER_MODE = undefined;
  return () => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    if (savedMode === undefined) delete process.env.AXUSE_SERVER_MODE;
    else process.env.AXUSE_SERVER_MODE = savedMode;
    __resetVirtualDisplay();
  };
}

test("server mode: stays off when disabled (typed failure, no Xvfb boot)", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  process.env.AXUSE_SERVER_MODE = "0";
  const c = new Controller();
  t.after(() => c.dispose());
  await assert.rejects(
    () => c.execute("open", { url: "about:blank", settle_ms: 100 }),
    (e) => e.code === "LAUNCH_FAILED" && /AXUSE_SERVER_MODE/.test(e.message) && e.retry === "never",
  );
  assert.equal(virtualDisplayStatus().active, false, "disabled server mode never boots an Xvfb");
});

test("server mode: headed Chrome auto-boots a virtual display (anti-bot posture)", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const c = new Controller();
  t.after(() => c.dispose());
  const geo = displayGeometry();

  const r = await c.execute("open", {
    url: "data:text/html,<h1>server mode</h1><button id=\"b\" onclick=\"this.textContent='clicked'\">go</button>",
    settle_ms: 150,
  });
  // The fact the model sees: headed on an auto-booted virtual display.
  assert.equal(r.display?.virtual, true);
  assert.match(r.display.id, /^:\d+$/);
  assert.equal(r.display.width, geo.w);
  assert.equal(r.display.height, geo.h);

  // Anti-bot posture, measured in the real browser — the whole point of the
  // lane: a genuine headed build, no headless fingerprint anywhere.
  const ua = JSON.parse((await c.execute("evaluate", { expression: "navigator.userAgent" })).value ?? '""');
  const fp = JSON.parse((await c.execute("evaluate", {
    expression: "({ webdriver: navigator.webdriver, w: innerWidth, h: innerHeight, webgl: !!document.createElement('canvas').getContext('webgl') })",
  })).value ?? "{}");
  assert.doesNotMatch(ua, /headless/i);
  assert.equal(fp.webdriver, false);
  // Tamper-invisibility (measured regression): with the AutomationControlled
  // flag working, the prototype getter must be Chrome's NATIVE one — the
  // posture script touches nothing when the flag already fixed the value.
  const desc = JSON.parse((await c.execute("evaluate", {
    expression: `(() => { const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver") || {}; return { src: String(d.get ?? ""), native: String(d.get ?? "").includes("[native code]"), value: navigator.webdriver }; })()`,
  })).value ?? "{}");
  assert.equal(desc.value, false);
  assert.equal(desc.native, true, `getter must stay native — got: ${desc.src}`);
  assert.ok(fp.w >= geo.w - 80, `viewport width ${fp.w} ≈ ${geo.w} (--window-size honored)`);
  assert.equal(fp.webgl, true, "WebGL present (SwiftShader) — a signal anti-bot checks");

  // Pixels work too (challenge solvers vision-crop from screenshots).
  const shot = await c.execute("screenshot", { budget_bytes: 60_000 });
  assert.ok(shot.image.bytes > 2000, "a real rendered frame, not a black void");
  assert.ok(shot.image.base64.startsWith("/9j/"), "JPEG SOI");

  // The virtual display is a singleton: a second launch reuses it.
  const r2 = await c.execute("open", { url: "about:blank", settle_ms: 100 });
  assert.equal(r2.display?.id, r.display.id);

  // And the trusted-input path works on it (the solver lane's primitives).
  // Two tabs are controlled now — the strict lane requires the tab id.
  const clicked = await c.execute("click", { target: { x: 8, y: 8 }, tab_id: r2.tab_id, settle_ms: 50 });
  assert.ok(clicked, "input dispatch on the virtual display is fine");
});

test("server mode: persona coherence — TZ, language and core/memory overrides reach the page", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const saved = ["AXUSE_TIMEZONE", "AXUSE_LANG", "AXUSE_FP_CORES", "AXUSE_FP_MEMORY"].map((k) => [k, process.env[k]]);
  process.env.AXUSE_TIMEZONE = "Europe/Amsterdam";
  process.env.AXUSE_LANG = "en-GB";
  process.env.AXUSE_FP_CORES = "8";
  process.env.AXUSE_FP_MEMORY = "4";
  t.after(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  __resetVirtualDisplay();
  const c = new Controller();
  t.after(() => c.dispose());
  const r = await c.execute("open", { url: "data:text/html,<h1>persona</h1>", settle_ms: 150 });
  assert.equal(r.display?.virtual, true, "server mode still boots (persona overrides change no lane)");
  const p = JSON.parse((await c.execute("evaluate", {
    expression: `(() => {
      const g = document.createElement('canvas').getContext('webgl');
      const dbg = g && g.getExtension('WEBGL_debug_renderer_info');
      return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, intl: Intl.DateTimeFormat().resolvedOptions().locale,
        lang: navigator.language, langs: navigator.languages && navigator.languages[0],
        cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, webdriver: navigator.webdriver,
        renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null, webgl: !!g };
    })()`,
  })).value ?? "{}");
  // TZ reaches Date/Intl in the page (matches the egress persona).
  assert.equal(p.tz, "Europe/Amsterdam");
  // --accept-lang drives navigator.language AND the Accept-Language header
  // source; the derived LC_ALL makes the Intl default locale agree (this
  // host generates en_GB.utf8 — the doctor checks and warns when a host
  // does not).
  assert.equal(p.lang, "en-GB");
  assert.match(p.intl, /^en[-_]GB/, `Intl default locale follows AXUSE_LANG (got ${p.intl})`);
  // Persona overrides land (opt-in caps for high-core servers). deviceMemory
  // only exists on platforms that expose the API (this Linux build does not)
  // — the override applies exactly there, never inventing an API surface
  // the platform's honest Chrome lacks.
  assert.equal(p.cores, 8);
  assert.ok(p.mem === 4 || p.mem === undefined, `deviceMemory: ${p.mem}`);
  // And the posture facts still hold under the persona.
  assert.equal(p.webdriver, false);
  assert.equal(p.webgl, true);
  assert.ok(typeof p.renderer === "string" && p.renderer.length > 0, `renderer reported honestly: ${p.renderer}`);
});

test("server mode: ambient pointer park-fuzz moves the pointer while the agent idles", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const c = new Controller();
  t.after(() => c.dispose());
  await c.execute("open", {
    url: `data:text/html,<button id="b" style="margin:200px">x</button><script>
      window.__m = [];
      ["mousemove"].forEach((n) => document.addEventListener(n, (e) =>
        window.__m.push({ x: Math.round(e.clientX), y: Math.round(e.clientY), trusted: e.isTrusted })));
    </script>`,
    settle_ms: 150,
  });
  // Anchor the pointer with a real action, then let the agent "think".
  await c.execute("click", { target: { ref: "e1" }, settle_ms: 100 });
  const anchor = await c.execute("evaluate", { expression: "(() => { const r = document.getElementById('b').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()" })
    .then((r) => JSON.parse(r.value));
  await c.execute("wait_for", { expression: "window.__m.length >= 3", timeout_ms: 12_000 });
  const moves = JSON.parse((await c.execute("evaluate", { expression: "window.__m" })).value ?? "[]");
  assert.ok(moves.length >= 3, `ambient moves arrived (${moves.length})`);
  assert.ok(moves.every((m) => m.trusted), "ambient moves are trusted input");
  const after = moves.filter((m) => Math.hypot(m.x - anchor.x, m.y - anchor.y) <= 25);
  assert.ok(after.length >= 2, `jitter parks near the action anchor (${after.length}/${moves.length})`);
  // Opt-out honored: no ambient while disabled.
  const prevOff = process.env.AXUSE_AMBIENT_MOTION;
  process.env.AXUSE_AMBIENT_MOTION = "0";
  t.after(() => { if (prevOff === undefined) delete process.env.AXUSE_AMBIENT_MOTION; else process.env.AXUSE_AMBIENT_MOTION = prevOff; });
  const n0 = JSON.parse((await c.execute("evaluate", { expression: "window.__m.length" })).value ?? "0");
  await new Promise((ok) => setTimeout(ok, 3500));
  const n1 = JSON.parse((await c.execute("evaluate", { expression: "window.__m.length" })).value ?? "0");
  assert.equal(n1, n0, "AXUSE_AMBIENT_MOTION=0 parks the pointer");
});

test("server mode: Xvfb death mid-session → typed failure, then full regeneration on the next open", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const c = new Controller();
  t.after(() => c.dispose());
  const first = await c.execute("open", { url: "about:blank", settle_ms: 150 });
  assert.equal(first.display?.virtual, true);
  const firstDisplay = first.display.id;
  // The X server dies (OOM, operator cleanup — whatever kills it).
  __resetVirtualDisplay();
  // The live browser on the dead display fails typed (broken windows);
  // the process keeps the stale DISPLAY value — displayUsable must catch
  // the gone socket and server mode must regenerate on the next open.
  await assert.rejects(
    () => c.execute("evaluate", { expression: "1 + 1" }),
    (e) => typeof e.code === "string",
  );
  const second = await c.execute("open", { url: "data:text/html,<h1>regenerated</h1>", settle_ms: 200 });
  assert.equal(second.display?.virtual, true, "a fresh virtual display booted after the death");
  assert.ok(second.observation.text.includes("regenerated"));
  const vd = virtualDisplayStatus();
  assert.ok(vd.active && firstDisplay, "the singleton is live again");
});

test("server mode: AXUSE_HEADLESS=1 lane still opens headless on a dead display", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const savedHeadless = process.env.AXUSE_HEADLESS;
  process.env.AXUSE_HEADLESS = "1";
  t.after(() => { if (savedHeadless === undefined) delete process.env.AXUSE_HEADLESS; else process.env.AXUSE_HEADLESS = savedHeadless; });
  __resetVirtualDisplay();
  const c = new Controller();
  t.after(() => c.dispose());
  const r = await c.execute("open", { url: "about:blank", settle_ms: 100 });
  assert.equal(r.display, undefined, "headless launches never report a virtual display");
  assert.equal(virtualDisplayStatus().active, false, "headless needs no display — none was booted");
});
