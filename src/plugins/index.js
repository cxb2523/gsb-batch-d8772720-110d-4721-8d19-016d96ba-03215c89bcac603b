/**
 * axuse — solver plugin system (the thin seam).
 *
 * Design stance: axuse core is (and stays) free for noncommercial use
 * (PolyForm Noncommercial 1.0.0, copyright CTOL Digital Solutions) and
 * CAPTCHA-agnostic. It knows nothing about Turnstile, hCaptcha or reCAPTCHA.
 * What it ships is a minimal, frozen plugin ABI:
 *
 *   a solver plugin = one ESM module exporting
 *     {
 *       id: "captcha-pro",            // unique, stable
 *       version: "1.0.0",
 *       providers: ["turnstile", "recaptcha-v2", "hcaptcha"],
 *       solve: async (provider, ctx, opts) => solve result (see below)
 *     }
 *
 * Discovery: every directory listed in AXUSE_PLUGINS (path.delimiter-separated)
 * plus "<repo>/plugins/". Drop a paid solver package in plugins/ and it is
 * live on the next `axuse mcp` / `axuse solve` start. Nothing else changes.
 *
 * The plugin never touches the Controller. It receives a narrow capability
 * context (ctx) — the four primitives a solver needs, shaped by the same
 * lessons the core commands encode:
 *
 *   ctx.evaluate(expr)   → parsed JSON value of the in-page expression
 *                           (single-encoded: the raw ax_evaluate JSON string
 *                           is parsed for you — a real trap we hit live)
 *   ctx.click({x,y}|{ref}, {settleMs, human})
 *                          → human: true adds a jittered curved mouse
 *                            approach before the press (challenge widgets)
 *   ctx.screenshot({crop:{x,y,w,h}, quality, budgetBytes})
 *                        → { base64, mime, bytes, quality, crop }
 *                           (crop-first: never vision-tax a whole page)
 *   ctx.waitFor({selector|expression|text, timeoutMs}) → { ok }
 *   ctx.wait(ms)
 *   ctx.meta             → { startedAt }
 *
 * Solve result contract (what ax_solve_captcha returns to the model):
 *   {
 *     solved: boolean,
 *     provider: string,
 *     token: string|null,          // null when unsolved (never fabricated)
 *     attempts, rounds, elapsedMs, // solver-chosen accounting facts
 *     notes: string,               // one honest sentence
 *     ...solver-specific facts (visionCalls, etc.)
 *   }
 *
 * Like desktop drivers, plugins run in-process and are trusted code: the seam
 * is for packaging/licensing separation (open core ↔ paid solvers), not
 * sandboxing. Plugins keep their own configuration (e.g. vision API keys) in
 * their own env vars — the core never sees them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AxError, Codes } from "../core/errors.js";
import { Contract } from "../core/commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_DIR = join(HERE, "..", "..", "plugins");

/** Validate one plugin module against the frozen ABI. Fail closed, typed. */
export function validateSolver(mod, source) {
  const where = source ?? "plugin";
  const fail = (msg) => new AxError(Codes.PLUGIN_LOAD_FAILED, `${where}: ${msg}`, { retry: "never" });
  if (!mod || typeof mod !== "object") throw fail("exports nothing (expected a solver object)");
  const { id, version, providers, solve } = mod;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
    throw fail(`id must be a short slug string (got ${JSON.stringify(id)})`);
  }
  if (typeof version !== "string" || !version) throw fail("version must be a non-empty string");
  if (!Array.isArray(providers) || !providers.length || providers.some((p) => typeof p !== "string" || !p)) {
    throw fail("providers must be a non-empty array of provider slugs, e.g. [\"turnstile\",\"recaptcha-v2\"]");
  }
  if (typeof solve !== "function" || solve.length < 2) {
    throw fail("solve must be an async function (provider, ctx, opts) — arity >= 2");
  }
  return { id, version, providers, solve, label: typeof mod.label === "string" ? mod.label : id };
}

/** Tool names the core already owns — a plugin tool may never shadow them. */
const RESERVED_TOOL_NAMES = new Set([
  "ax_solve_captcha", "ax_plugins",
  ...Object.keys(Contract).map((n) => `ax_${n}`),
]);

/** Validate a plugin's extra MCP tools (core prerequisite A1): same shape the
 *  core manifest generates — name/description/schema/handle — fail-closed so
 *  a broken paid package is reported by `axuse plugins`, never silently
 *  mounted on the MCP surface. */
export function validatePluginTools(id, tools, source) {
  const where = source ?? id;
  const fail = (msg) => new AxError(Codes.PLUGIN_LOAD_FAILED, `${where}: ${msg}`, { retry: "never" });
  if (!Array.isArray(tools) || !tools.length) throw fail("tools() must return a non-empty array of tool definitions");
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t !== "object") throw fail("tools: every entry must be an object");
    if (typeof t.name !== "string" || !/^ax_[a-z0-9_]{2,48}$/.test(t.name)) {
      throw fail(`tools: name must be an ax_<slug> string (got ${JSON.stringify(t.name)})`);
    }
    if (RESERVED_TOOL_NAMES.has(t.name)) {
      throw fail(`tools: name "${t.name}" is reserved by the core — pick a plugin-specific name`);
    }
    if (seen.has(t.name)) throw fail(`tools: duplicate tool name "${t.name}"`);
    seen.add(t.name);
    if (typeof t.description !== "string" || !t.description.trim() || t.description.length > 2000) {
      throw fail(`tools: "${t.name}" needs a non-empty description (<= 2000 chars)`);
    }
    const s = t.inputSchema;
    if (!s || typeof s !== "object" || Array.isArray(s) || s.type !== "object" || typeof s.properties !== "object" || s.properties === null) {
      throw fail(`tools: "${t.name}" inputSchema must be { type:"object", properties:{…} } (same generator shape as core tools)`);
    }
    for (const [k, v] of Object.entries(s.properties)) {
      if (!v || typeof v !== "object" || typeof v.type !== "string") {
        throw fail(`tools: "${t.name}" property "${k}" must be a JSON-schema fragment with a type`);
      }
    }
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string" || !s.properties[r]))) {
      throw fail(`tools: "${t.name}" required must list declared property names`);
    }
    if (typeof t.handle !== "function" || t.handle.length < 1) {
      throw fail(`tools: "${t.name}" handle must be an async function (args, ctx) — arity >= 1`);
    }
  }
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, handle: t.handle }));
}

/** Resolve a plugin directory to its entry module (index.js or package main). */
function entryOf(dir) {
  const idx = join(dir, "index.js");
  if (existsSync(idx)) return idx;
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const main = pkg.main ?? pkg.exports?.["."]?.import;
    if (typeof main === "string" && existsSync(join(dir, main))) return join(dir, main);
  }
  return null;
}

/** Load every valid solver from the given dirs. A search dir may be either
 * a CONTAINER of plugin subdirectories (e.g. the default plugins/) or a
 * plugin directory itself (index.js / package.json at its root — the shape
 * AXUSE_PLUGINS entries and docs point at). Invalid plugins fail typed
 * but never abort the server: one broken paid package must not take the
 * whole MCP surface down (same posture as a failed browser locate). */
export async function loadSolvers(dirs) {
  const search = [...new Set((dirs ?? pluginDirs()).filter(Boolean))];
  const solvers = [];
  const errors = [];
  for (const dir of search) {
    let candidates = [];
    try {
      const isItselfPlugin = existsSync(join(dir, "index.js")) || existsSync(join(dir, "package.json"));
      candidates = isItselfPlugin
        ? [dir]
        : readdirSync(dir).filter((n) => !n.startsWith(".") && !n.startsWith("_")).map((n) => join(dir, n));
    } catch {
      continue; // dir absent: normal for a fresh install
    }
    for (const full of candidates) {
      try {
        if (!statSync(full).isDirectory()) continue;
        const entry = entryOf(full);
        if (!entry) continue;
        const mod = await import(pathToFileURL(entry).href);
        const solver = validateSolver(mod.solver ?? mod.default ?? mod, full.split(/[\\/]/).pop());
        // Core prerequisite A1: plugins may register extra MCP tools from a
        // validated `tools()` export (same schema shape the core generates).
        // A broken tools() fails the whole plugin, typed — never the server.
        let tools = [];
        if (mod.tools !== undefined) {
          if (typeof mod.tools !== "function") {
            throw new AxError(Codes.PLUGIN_LOAD_FAILED,
              `${solver.id}: tools must be a function returning tool definitions`,
              { retry: "never" });
          }
          tools = validatePluginTools(solver.id, await mod.tools(), solver.id);
        }
        solvers.push({ ...solver, dir: full, ...(tools.length ? { tools } : {}) });
      } catch (e) {
        errors.push({
          plugin: full.split(/[\\/]/).pop(),
          code: e instanceof AxError ? e.code : Codes.PLUGIN_LOAD_FAILED,
          message: e.message,
        });
      }
    }
  }
  return { solvers, errors };
}

/** Default search path: AXUSE_PLUGINS list, then the repo's plugins/ dir. */
export function pluginDirs() {
  const env = process.env.AXUSE_PLUGINS;
  const list = env ? env.split(process.platform === "win32" ? ";" : ":").filter(Boolean) : [];
  list.push(DEFAULT_PLUGIN_DIR);
  return list.map((p) => resolve(p));
}

/** The narrow capability context handed to solver.solve(). Frozen surface,
 * JSON-parsed evaluate (kills the double-encoding trap), crop-first pixels. */
export function buildSolveContext(controller, tabId) {
  const meta = { startedAt: Date.now() };
  const withTab = (extra = {}) => (tabId ? { tab_id: tabId, ...extra } : extra);
  return Object.freeze({
    meta,
    /** The tab this ctx is bound to (null: active/none). */
    tabId: tabId ?? null,
    async evaluate(expression) {
      const r = await controller.execute("evaluate", { expression, ...(tabId ? { tab_id: tabId } : {}) });
      try {
        return JSON.parse(r.value ?? "null");
      } catch {
        return r.value ?? null; // truncated / non-JSON: hand back the raw string
      }
    },
    async click(target, { settleMs, human } = {}) {
      const r = await controller.execute("click", {
        target: "ref" in target ? { ref: target.ref } : { x: target.x, y: target.y },
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(human !== undefined ? { human } : {}),
        ...(tabId ? { tab_id: tabId } : {}),
      });
      return { actionSent: r.action_sent ?? null };
    },
    async screenshot({ crop, quality, budgetBytes } = {}) {
      const r = await controller.execute("screenshot", {
        ...(crop ? { crop } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(budgetBytes !== undefined ? { budget_bytes: budgetBytes } : {}),
        ...(tabId ? { tab_id: tabId } : {}),
      });
      return { ...r.image, crop: crop ?? null };
    },
    async waitFor(what) {
      const r = await controller.execute("wait_for", { ...what, ...(tabId ? { tab_id: tabId } : {}) });
      return { ok: !!r.ok, timeout: !!r.timeout };
    },
    async wait(ms) {
      await new Promise((res) => setTimeout(res, Math.min(Math.max(ms, 0), 30_000)));
    },
    /* ------------------------------------ Wave-1 plumbing (R1-R4 / A2) */
    /** Typed CDP passthrough on the tab's connection (Storage, Browser,
     *  WebAuthn, Fetch, Network, raw Input.* — the plugin-owned domains). */
    async cdp(method, params = {}, sessionId) {
      return controller.cdpSend(tabId, method, params, sessionId);
    },
    /** Send to the tab session + every OOPIF frame session, and replay the
     *  send on future frame attaches (R2 enable-on-frame-session). */
    async cdpBroadcast(method, params = {}) {
      return controller.cdpBroadcast(tabId, method, params);
    },
    /** Subscribe to raw CDP events on the tab's connection (R2 event
     *  delivery: Fetch.requestPaused, Network.requestWillBeSent, ...).
     *  Frame-session events are included — match msg.sessionId against
     *  tabs().frame_sessions to scope. Returns an unsubscribe function. */
    cdpOn(method, handler) {
      return controller.cdpOn(tabId, method, handler);
    },
    async press(combo, { settleMs, tab_id, platform } = {}) {
      const r = await controller.execute("press", withTab({
        combo,
        ...(platform !== undefined ? { platform } : {}),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
      return { actionSent: r.action_sent ?? null };
    },
    async type({ target, text, replace, submit, settleMs, tab_id, human } = {}) {
      const r = await controller.execute("type", withTab({
        text: String(text),
        ...(target !== undefined ? { target } : {}),
        ...(replace !== undefined ? { replace } : {}),
        ...(submit !== undefined ? { submit } : {}),
        ...(human !== undefined ? { human } : {}),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
      return { actionSent: r.action_sent ?? null };
    },
    async drag({ from, to, steps, settleMs, tab_id } = {}) {
      const r = await controller.execute("drag", withTab({
        from, to,
        ...(steps !== undefined ? { steps } : {}),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
      return { actionSent: r.action_sent ?? null };
    },
    async scroll({ direction, amount, dx, dy, until, target, settleMs, tab_id } = {}) {
      return controller.execute("scroll", withTab({
        ...(direction !== undefined ? { direction } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(dx !== undefined ? { dx } : {}),
        ...(dy !== undefined ? { dy } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
    },
    async upload({ ref, paths, settleMs, tab_id } = {}) {
      return controller.execute("upload", withTab({
        paths,
        ...(ref !== undefined ? { ref } : {}),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
    },
    /** AX snapshot (diff by default; find: contract matching on big pages). */
    async observe({ mode, find, maxNodes, maxChars, tab_id } = {}) {
      return controller.execute("observe", withTab({
        ...(mode !== undefined ? { mode } : {}),
        ...(find !== undefined ? { find } : {}),
        ...(maxNodes !== undefined ? { max_nodes: maxNodes } : {}),
        ...(maxChars !== undefined ? { max_chars: maxChars } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
    },
    /** Open a URL in a new tab (profileDir: persistent A2 profile). */
    async open(url, { headless, profileDir, settleMs, executablePath, proxy, proxyBypass, timezone, lang } = {}) {
      const r = await controller.execute("open", {
        url: String(url),
        ...(headless !== undefined ? { headless } : {}),
        ...(profileDir !== undefined ? { profile_dir: profileDir } : {}),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(executablePath !== undefined ? { executable_path: executablePath } : {}),
        ...(proxy !== undefined ? { proxy } : {}),
        ...(proxyBypass !== undefined ? { proxy_bypass: proxyBypass } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(lang !== undefined ? { lang } : {}),
      });
      return { tabId: r.tab_id, browserId: r.browser_id, observation: r.observation, dialog: r.dialog ?? null, display: r.display ?? null };
    },
    async navigate(url, { settleMs, tab_id } = {}) {
      const r = await controller.execute("navigate", withTab({
        url: String(url),
        ...(settleMs !== undefined ? { settle_ms: settleMs } : {}),
        ...(tab_id ? { tab_id } : {}),
      }));
      return { tabId: r.tab_id, observation: r.observation };
    },
    /** Controlled tabs (incl. per-tab frame/session facts for cdp routing). */
    async tabs() {
      return controller.execute("tabs", {});
    },
    /** Event-ring tail (navigations, dialogs, downloads (R1), frame churn). */
    async events({ after = 0, limit = 50, tab_id } = {}) {
      return controller.execute("events", withTab({
        after_sequence: after, limit,
        ...(tab_id ? { tab_id } : {}),
      }));
    },
  });
}

/** Dispatch: registry lookup + typed NO_SOLVER with an install hint. */
export async function solveWith(solvers, provider, ctx, opts = {}) {
  const match = solvers.find((s) => s.providers.includes(provider));
  if (!match) {
    throw new AxError(Codes.NO_SOLVER,
      `No loaded solver handles provider "${provider}" (loaded: ${solvers.map((s) => s.id).join(", ") || "none"}).`,
      { hint: "Solver plugins are separate packages. Drop one into the plugins/ directory (or list dirs in AXUSE_PLUGINS), then run `axuse plugins` to verify.", retry: "never" });
  }
  return match.solve(provider, ctx, opts);
}
