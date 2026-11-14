/**
 * axuse — server mode: headed Chrome on an auto-provisioned virtual display.
 *
 * The problem this module exists for: agent harnesses (codex, claude code,
 * opencode CLIs) run on Ubuntu servers with no desktop session. Challenge /
 * anti-bot pages (Turnstile, reCAPTCHA, hCaptcha, slider gates) check whether
 * the browser is headless as their FIRST step — `--headless` is a detection
 * signal, not a workaround. The supported server lane is the opposite:
 * launch Chrome FULLY HEADED on a private X virtual framebuffer (Xvfb), so
 * the browser is a genuine headed build with the real rendering stack
 * (fonts, raster, WebGL via SwiftShader, window chrome) and no headless
 * fingerprint anywhere.
 *
 * Lineage: the Linux desktop driver already mounts over Xvfb (verified on
 * Xorg 1.21 / Ubuntu 22.04+, and in CI lanes) — this module brings the same
 * "private Xvfb, zero extra packages at runtime" pattern to the BROWSER lane
 * and wires it into BrowserHandle.launch, so every entry point (ax_open,
 * ax_solve_captcha {url}, plugin ctx.open, axuse solve/open-urls CLIs) gets
 * it for free.
 *
 * Contract (all pure seams are injectable for deterministic tests):
 *   - serverModeEnabled()  — AXUSE_SERVER_MODE: auto (default) / 0|off|false
 *   - displayUsable()      — DISPLAY is set AND its X socket answers (a dead
 *                            DISPLAY, e.g. a stale CI :99, counts as absent)
 *   - serverModePlan()     — the decision: native | skip | boot | fail-…
 *   - ensureVirtualDisplay() — boot the singleton: pick a free display
 *                            number, spawn Xvfb, wait for its X socket,
 *                            export DISPLAY, install exit cleanup
 *   - virtualDisplayStatus() — facts for results, doctor and tests
 *
 * Hardening applied on the virtual-display lane (see cdp.js):
 *   - --window-size=W,H and --window-position=0,0 (no monitor → Chrome would
 *     otherwise default to a tiny window on a WM-less screen)
 *   - --hide-crash-restore-bubble (persistent vault profiles that were
 *     killed mid-run must not wake up behind a "restore pages?" bubble)
 *   - --no-sandbox when running as root (Chrome refuses root otherwise —
 *     the norm in containers) or AXUSE_NO_SANDBOX=1
 *   - never --headless, never --disable-gpu (SwiftShader WebGL is an
 *     anti-bot signal you WANT to keep)
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AxError, Codes } from "./errors.js";

export const DEFAULT_DISPLAY_SIZE = "1920x1080x24";
const X11_SOCKET_DIR = "/tmp/.X11-unix";
const XVFB_BOOT_TIMEOUT_MS = 5000;
const XVFB_ATTEMPTS = 3;

/** Weighted common-consumer resolutions for fleet diversity ("random"): a
 *  fleet of identical 1920x1080 viewports is a cross-account correlation
 *  signal; real desktops spread across these. */
export const COMMON_DISPLAY_SIZES = [
  { w: 1920, h: 1080, d: 24, weight: 45 },
  { w: 1366, h: 768, d: 24, weight: 25 },
  { w: 1600, h: 900, d: 24, weight: 10 },
  { w: 1680, h: 1050, d: 24, weight: 8 },
  { w: 1440, h: 900, d: 24, weight: 7 },
  { w: 2560, h: 1440, d: 24, weight: 5 },
];

/** Stable 31-bit hash (FNV-1a) — machine identity → one fleet geometry. */
function stableHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pick the fleet geometry for this machine: deterministic per machine
 *  (hostname + uid), so one machine keeps one persona across boots while a
 *  fleet spreads across the weighted list. */
export function pickFleetDisplaySize(seed = `${hostname() ?? ""}:${typeof process.getuid === "function" ? process.getuid() : ""}`) {
  const total = COMMON_DISPLAY_SIZES.reduce((a, s) => a + s.weight, 0);
  let slot = stableHash(String(seed)) % total;
  for (const s of COMMON_DISPLAY_SIZES) {
    if (slot < s.weight) return { w: s.w, h: s.h, d: s.d };
    slot -= s.weight;
  }
  return { w: 1920, h: 1080, d: 24 };
}

/* ------------------------------------------------------------------ config */

/** AXUSE_SERVER_MODE: unset/"auto"/"1" → enabled; "0"/"off"/"false"/"no" → off. */
export function serverModeEnabled(env = process.env) {
  const v = String(env.AXUSE_SERVER_MODE ?? "").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** Parse "WxHxD" (depth optional, default 24) into geometry, or null. */
export function parseDisplaySize(s) {
  const m = /^(\d{3,4})x(\d{3,4})(?:x(\d{1,2}))?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]), d = m[3] ? Number(m[3]) : 24;
  if (w < 640 || h < 480 || w > 7680 || h > 4320) return null;
  if (![16, 24, 32].includes(d)) return null;
  return { w, h, d };
}

/** The effective virtual-display geometry (AXUSE_DISPLAY_SIZE, validated).
 *  "random" = the fleet lane: one stable geometry per machine, spread
 *  across the weighted common-consumer list (identical fleet viewports are
 *  a cross-account correlation signal). */
export function displayGeometry(env = process.env) {
  const raw = String(env.AXUSE_DISPLAY_SIZE ?? "").trim();
  if (/^random$/i.test(raw)) return pickFleetDisplaySize();
  return parseDisplaySize(env.AXUSE_DISPLAY_SIZE) ?? parseDisplaySize(DEFAULT_DISPLAY_SIZE);
}

/** Validate an IANA timezone the way the browser will resolve it (Intl —
 *  the same engine Chrome uses for Date/Intl). null when invalid. */
export function validTimezone(tz) {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }).resolvedOptions().timeZone;
    return resolved ? tz : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- display discovery */

/** DISPLAY ":1", "localhost:10.0", "unix:0" → display number, or null. */
export function displayNumber(display) {
  const m = /(?:^|:)(\d+)(?:\.\d+)?$/.exec(String(display ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** The X socket path for a display number (filesystem sockets on Linux). */
export function displaySocketPath(n) {
  return join(X11_SOCKET_DIR, `X${n}`);
}

/** DISPLAY is set AND its X server's socket exists. Dead values (stale CI
 *  :99, closed SSH forwards) count as absent — that is what makes the
 *  server-mode fallback safe on machines that HAVE a display variable. */
export function displayUsable(display = process.env.DISPLAY, { exists = existsSync } = {}) {
  const n = displayNumber(display);
  if (n === null) return false;
  try {
    return exists(displaySocketPath(n));
  } catch {
    return false;
  }
}

/** Display numbers already claimed: X sockets + lock files + a few numbers
 *  that conventionally belong to real desktop sessions. */
export function takenDisplayNumbers({ read = readdirSync } = {}) {
  const taken = new Set([0, 1, 2]); // native session displays — never take
  try {
    for (const name of read(X11_SOCKET_DIR)) {
      const m = /^X(\d+)$/.exec(name);
      if (m) taken.add(Number(m[1]));
    }
  } catch { /* no socket dir: nothing mounted — fine */ }
  // Lock files can exist without sockets (crashed X server): scan them too.
  try {
    for (const name of read("/tmp")) {
      const m = /^\.X(\d+)-lock$/.exec(name);
      if (m) taken.add(Number(m[1]));
    }
  } catch { /* /tmp unreadable: extremely unlikely */ }
  return [...taken];
}

/** Pick one free display number (injectable randomness for tests). */
export function pickDisplayNumber({ taken = [], random = Math.random } = {}) {
  const busy = new Set(taken);
  for (let i = 0; i < 100; i++) {
    const n = 20 + Math.floor(random() * 978); // :20–:997, away from :99 CI
    if (!busy.has(n)) return n;
  }
  // Everything drawn was busy (≈ a machine running 900+ X servers): fall back
  // to the first free number above 1000 rather than fail.
  for (let n = 1000; n < 1100; n++) if (!busy.has(n)) return n;
  return null;
}

/** Locate the Xvfb binary (injectable for deterministic tests). */
export function xvfbBinary({ which = (b) => spawnSync("which", [b]).status === 0 ? b : null } = {}) {
  return which("Xvfb");
}

/* -------------------------------------------------------------- the decision */

/**
 * Pure decision for one launch: what does the headed lane do on this host?
 *   native        — a live X display exists (or not Linux / not our problem)
 *   skip          — headless launch; no display needed
 *   boot          — auto-boot the private Xvfb (server mode)
 *   fail-xvfb     — server mode wanted, Xvfb not installed → typed hint
 *   fail-disabled — AXUSE_SERVER_MODE=0 and no display → typed hint
 */
export function serverModePlan({
  platform = process.platform,
  headless = false,
  display = process.env.DISPLAY,
  usable = null,
  xvfb = null,
  enabled = serverModeEnabled(),
} = {}) {
  if (platform !== "linux") return { action: "native", reason: "not linux — headed launch is the platform default" };
  if (headless) return { action: "skip", reason: "headless launch — no display needed" };
  const alive = usable ?? displayUsable(display);
  if (alive) return { action: "native", reason: `X display ${display} is alive — headed launch goes there` };
  if (!enabled) {
    return {
      action: "fail-disabled",
      reason: "server mode is disabled (AXUSE_SERVER_MODE=0) and no X display is alive",
      hint: "Unset AXUSE_SERVER_MODE (or set it to auto) so axuse boots a private Xvfb, or run the harness inside an X session / under xvfb-run, or pass headless: true for trusted-internal pages only.",
    };
  }
  const hasXvfb = xvfb ?? xvfbBinary();
  if (!hasXvfb) {
    return {
      action: "fail-xvfb",
      reason: "no X display is alive and Xvfb was not found",
      hint: "Server mode needs Xvfb for a headed browser: sudo apt-get install -y xvfb (challenge/anti-bot pages detect --headless Chrome — headed-on-Xvfb is the supported server lane). Or run under xvfb-run, or pass headless: true for trusted-internal pages only.",
    };
  }
  return { action: "boot", reason: `no live X display — booting a private Xvfb (headed Chrome, anti-bot-safe)` };
}

/* ---------------------------------------------------------------- the boot */

let active = null; // the singleton virtual display (this process)
let booting = null; // one boot at a time (concurrent first launches)

/** Current virtual-display facts: { active, display, width, height, depth }. */
export function virtualDisplayStatus() {
  if (!active) return { active: false };
  const { display, width, height, depth } = active;
  return { active: true, display, width, height, depth };
}

/** test hook: drop the singleton (kills the Xvfb we booted, if any). */
export function __resetVirtualDisplay() {
  if (active) { try { active.proc.kill(); } catch {} }
  active = null;
}

/* --------------------------------------------------------- zombie hygiene */

/** Read one /proc/<pid> entry: { pid, ppid, argv } or null. Injectable for tests. */
function procEntry(pid, { readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const stat = (() => { try { return readFile(`/proc/${pid}/stat`); } catch { return null; } })();
  const cmd = (() => { try { return readFile(`/proc/${pid}/cmdline`); } catch { return null; } })();
  if (!stat || !cmd) return null;
  // ppid is stat field 4 — after comm, which may contain spaces/parens.
  const after = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { pid, ppid: Number(after[1]), argv: cmd.split("\0").filter(Boolean) };
}

/** Does one /proc entry look like an axuse-spawned Xvfb (our exact launch
 *  signature) whose parent is gone (reparented to init — a leaked zombie
 *  from a SIGKILLed harness)? Conservative by construction: the full arg
 *  set must match and the parent must be dead. */
export function isStaleAxuseXvfb(entry) {
  if (!entry || typeof entry.pid !== "number") return false;
  const a = entry.argv ?? [];
  if (!/Xvfb$/.test(a[0] ?? "")) return false;
  if (!/^:\d+$/.test(a[1] ?? "")) return false;
  for (const need of ["-screen", "0", "-ac", "-nolisten", "tcp", "-noreset"]) {
    if (!a.includes(need)) return false;
  }
  return entry.ppid === 1;
}

/** Sweep leaked axuse Xvfb zombies (SIGKILLed harness processes leave an
 *  orphaned X server behind: ~10 MB each and a display number gone, which
 *  matters at fleet scale). Only OUR exact-signature orphans die; a display
 *  still owned by a live process has a live parent, not ppid 1. */
export function sweepStaleXvfb({ listDir = readdirSync, readFile, kill = (pid) => process.kill(pid, "SIGTERM") } = {}) {
  const swept = [];
  let pids;
  try { pids = listDir("/proc").filter((n) => /^\d+$/.test(n)); } catch { return swept; }
  for (const pid of pids) {
    const entry = procEntry(Number(pid), { readFile });
    if (!isStaleAxuseXvfb(entry)) continue;
    try { kill(entry.pid); swept.push({ pid: entry.pid, display: entry.argv[1] }); } catch {}
  }
  return swept;
}

function sleep(ms) { return new Promise((ok) => setTimeout(ok, ms)); }

/** Wait for Xvfb's X socket (its readiness signal) or its early death. */
async function waitUntilUp(proc, n, timeoutMs = XVFB_BOOT_TIMEOUT_MS) {
  const path = displaySocketPath(n);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false; // died: display raced/flags bad
    try { accessSync(path); return true; } catch {}
    await sleep(40);
  }
  return false;
}

/**
 * Boot the process-wide virtual display (idempotent; concurrent callers share
 * one boot). Spawns Xvfb on a free display, waits for its socket, exports
 * DISPLAY for every later spawn (Chrome, xclip, …) and installs exit cleanup.
 * @returns the active record: { display, width, height, depth, pid, virtual: true }
 */
export async function ensureVirtualDisplay({ force = false } = {}) {
  if (active) return active;
  if (booting) return booting;
  booting = (async () => {
    const plan = serverModePlan({ headless: false });
    if (plan.action === "native") {
      throw new AxError(Codes.INTERNAL, "virtual display not needed — a live X display exists");
    }
    const bin = xvfbBinary();
    if (!bin) {
      throw new AxError(Codes.LAUNCH_FAILED, `Cannot boot server mode: Xvfb was not found. ${plan.hint ?? ""}`, { retry: "never" });
    }
    const geo = displayGeometry();
    // Zombie hygiene first: a SIGKILLed harness leaves an orphaned Xvfb
    // (~10 MB, one display number gone each time — fleet scale poison).
    // Freed displays then rejoin the pickable pool.
    const swept = sweepStaleXvfb();
    if (swept.length) await sleep(400);
    const taken = takenDisplayNumbers();
    for (let attempt = 1; attempt <= XVFB_ATTEMPTS; attempt++) {
      const n = pickDisplayNumber({ taken });
      if (n === null) {
        throw new AxError(Codes.LAUNCH_FAILED, "No free X display number found (100+ displays mounted?) — close some X servers and retry.", { retry: "retry" });
      }
      taken.push(n);
      const display = `:${n}`;
      // Same proven arg set as the desktop-driver test lane: -ac (no access
      // control on a private display), -nolisten tcp (never a network port),
      // -noreset (survive browser restarts within this process's lifetime).
      const proc = spawn(bin, [
        display, "-screen", "0", `${geo.w}x${geo.h}x${geo.d}`,
        "-ac", "-nolisten", "tcp", "-noreset",
      ], { stdio: "ignore" });
      // The X server must never keep the harness process alive: unref it.
      // Teardown is the explicit exit handler below (and process-group
      // kills / systemd KillMode=control-group — see docs/server-mode.md).
      proc.unref();
      if (!(await waitUntilUp(proc, n))) {
        try { proc.kill(); } catch {}
        continue; // candidate raced or Xvfb refused it — try the next one
      }
      process.env.DISPLAY = display; // the export the whole process sees
      active = {
        display, width: geo.w, height: geo.h, depth: geo.d,
        pid: proc.pid, virtual: true, startedAt: Date.now(), proc,
        ...(swept.length ? { swept } : {}),
      };
      // Cleanup: normal exits kill our Xvfb. Signal deaths are covered by
      // process-group kills (the norm for harness/CLI teardown) and by
      // systemd KillMode=control-group (see docs/server-mode.md).
      process.once("exit", () => { try { proc.kill(); } catch {} });
      proc.once("exit", () => { if (active && active.proc === proc) active = null; });
      return active;
    }
    throw new AxError(Codes.LAUNCH_FAILED,
      `Xvfb died during startup on ${XVFB_ATTEMPTS} candidate displays (check 'Xvfb :990 -screen 0 ${geo.w}x${geo.h}x${geo.d}' by hand, and /tmp space).`,
      { retry: "retry" });
  })();
  try {
    return await booting;
  } finally {
    booting = null;
  }
}

/* ------------------------------------------------------------- font probe */

/** --no-sandbox decision for virtual-display launches: root (the norm in
 *  containers — Chrome refuses to start as root otherwise) or explicit. */
export function needsNoSandbox({ uid = typeof process.getuid === "function" ? process.getuid() : null, env = process.env } = {}) {
  if (/^(1|true)$/i.test(String(env.AXUSE_NO_SANDBOX ?? ""))) {
    return { add: true, reason: "AXUSE_NO_SANDBOX=1" };
  }
  if (uid === 0) {
    return { add: true, reason: "running as root — Chrome refuses to start without --no-sandbox" };
  }
  return { add: false, reason: uid === null ? "uid unknown" : `uid ${uid}` };
}

/** Server-render screenshots need real fonts. Count installed font families
 *  via fc-list when present (injectable for tests); 0 or missing → hint. */
export function fontProbe({ run = (cmd, args) => spawnSync(cmd, args, { timeout: 4000 }) } = {}) {
  try {
    const r = run("fc-list", ["--format", "%{family}\n"]);
    if (r.error || r.status !== 0) return { ok: false, families: 0, note: "fc-list not available (fontconfig not installed)" };
    const families = new Set(String(r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
    return { ok: families.size > 0, families: families.size };
  } catch {
    return { ok: false, families: 0, note: "font probe failed" };
  }
}

/** Hint line for a fontless host (boxes instead of glyphs poison vision OCR). */
export function fontHint(probe) {
  return probe.ok
    ? null
    : `no usable fonts found (${probe.note ?? `${probe.families} families`}) — text renders as boxes and vision/OCR fails: sudo apt-get install -y fonts-liberation fonts-dejavu-core fontconfig`;
}
