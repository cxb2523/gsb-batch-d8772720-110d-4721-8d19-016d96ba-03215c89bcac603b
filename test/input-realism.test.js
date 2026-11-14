/**
 * Input realism + per-instance proxy — the lanes massive server operations
 * need beyond the base trusted-input path:
 *
 *  - unit (always): the human planners are pure and in-shape (keystroke
 *    cadence, approach trajectory), the proxy spec parser is typed.
 *  - live (browser): per-key human typing produces the event stream a
 *    keystroke-dynamics sampler expects; human clicks arrive on a real
 *    trajectory; a browser launched with proxy credentials routes through a
 *    local 407-challenging proxy (exercising the CDP Fetch auth path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { planHumanKeystrokes, planHumanApproach } from "../src/core/actuate.js";
import { locateBrowser, parseProxySpec } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const hasBrowser = !!locateBrowser();

/* ---------------------------------------------------------------- unit */

test("human typing: per-char plan with human cadence", () => {
  let i = 0;
  const seq = () => [0.5, 0.5, 0.5, 0.5, 0.5][i++ % 5]; // deterministic draws
  const plan = planHumanKeystrokes("ab 12", { random: seq });
  assert.equal(plan.length, 5);
  // known layout keys carry full descriptors (letters, digits, space)
  assert.deepEqual([plan[0].key, plan[0].code, plan[0].vk], ["A", "KeyA", 65]);
  assert.equal(plan[4].key, "2");
  assert.equal(plan[2].text, " ");
  // every char: a pre-gap, a hold, and text for the insert
  for (const [n, k] of plan.entries()) {
    assert.ok(k.delayMs >= 20 && k.delayMs <= 500, `gap ${n}: ${k.delayMs}`);
    assert.ok(k.holdMs >= 25 && k.holdMs <= 90, `hold ${n}: ${k.holdMs}`);
    assert.ok(typeof k.text === "string" && k.text.length === 1);
  }
  // unknown-to-layout chars still carry text (the insert path)
  const umlaut = planHumanKeystrokes("é", { random: () => 0.5 })[0];
  assert.equal(umlaut.text, "é");
  assert.equal(umlaut.code, "");
});

test("human click: approach plan is a curved, settled trajectory", () => {
  let i = 0;
  const seq = () => [0.3, 0.7, 0.5, 0.9, 0.1, 0.4][i++ % 6]; // varying draws → a real bend
  const p = planHumanApproach({ x: 400, y: 300 }, { random: seq });
  // 3–6 curve moves + overshoot + settle
  assert.ok(p.events.length >= 5 && p.events.length <= 8, `events: ${p.events.length}`);
  const last = p.events.at(-1);
  assert.equal(last.x, 400);
  assert.equal(last.y, 300, "settles exactly on the target");
  const [overshoot] = [p.events.at(-2)];
  assert.ok(Math.hypot(overshoot.x - 400, overshoot.y - 300) <= 4, "overshoot is 1–3 px");
  // start point is 40–130 px away
  const d = Math.hypot(p.from.x - 400, p.from.y - 300);
  assert.ok(d >= 40 && d <= 130, `start distance ${d}`);
  // per-move gaps are human-scale, total under ~0.6 s
  const total = p.events.reduce((a, e) => a + e.dtMs, 0) + p.dwellMs;
  assert.ok(total >= 120 && total <= 700, `total ${total}ms`);
  // the path bends (not a laser-straight line)
  const first = p.events[0];
  const straight = Math.abs(
    (last.y - p.from.y) * first.x - (last.x - p.from.x) * first.y + last.x * p.from.y - last.y * p.from.x,
  ) / Math.hypot(last.x - p.from.x, last.y - p.from.y);
  assert.ok(straight > 0.5, `curve deviation ${straight.toFixed(1)}px`);
});

test("proxy: spec parsing is typed and credentials never ride the flag", () => {
  assert.deepEqual(parseProxySpec("http://1.2.3.4:8080"), { server: "http://1.2.3.4:8080" });
  assert.deepEqual(parseProxySpec("1.2.3.4:8080"), { server: "http://1.2.3.4:8080" }, "scheme defaults to http");
  assert.deepEqual(parseProxySpec("socks5://u:p%40x@example.com:1080"), {
    server: "socks5://example.com:1080", username: "u", password: "p@x",
  }, "creds split out, percent-decoded");
  assert.equal(parseProxySpec(""), null);
  for (const bad of ["ftp://h:1", "http://host", "http://host:99999", "://x", "not a url at all://"]) {
    assert.throws(() => parseProxySpec(bad), (e) => e.code === "COMMAND_REJECTED" && e.retry === "never", `must reject: ${bad}`);
  }
});

/* ---------------------------------------------------------------- live */

test("human input: typing and clicking land as human-shaped trusted events", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  const html = `data:text/html,<input id="t" style="margin:120px">
    <script>
      window.__k = []; window.__m = [];
      const t = document.getElementById("t");
      ["keydown","keyup","input"].forEach((n) => t.addEventListener(n, (e) =>
        window.__k.push({ n, key: e.key, code: e.code || null, trusted: e.isTrusted })));
      ["mousemove","mousedown","mouseup","click"].forEach((n) => document.addEventListener(n, (e) =>
        window.__m.push({ n, x: Math.round(e.clientX), y: Math.round(e.clientY), trusted: e.isTrusted })));
    </script>`;
  await c.execute("open", { url: html, headless: true, settle_ms: 150 });
  const ev = async (e) => JSON.parse((await c.execute("evaluate", { expression: e })).value ?? "null");

  // Human typing: per-char keydown/keyup pairs with layout codes, human pace.
  // (replace: false — the select-all combo would add its own key events.)
  const t0 = Date.now();
  await c.execute("type", { target: { ref: "e1" }, text: "he12", human: true, replace: false, settle_ms: 100 });
  const typingMs = Date.now() - t0;
  const keys = await ev("window.__k");
  const downs = keys.filter((k) => k.n === "keydown");
  const ups = keys.filter((k) => k.n === "keyup");
  assert.equal(downs.length, 4, "one keydown per character");
  assert.equal(ups.length, 4, "one keyup per character");
  assert.ok(downs.every((k) => k.trusted), "all key events trusted");
  assert.deepEqual(downs.map((k) => k.code), ["KeyH", "KeyE", "Digit1", "Digit2"], "US layout codes");
  assert.ok(typingMs >= 4 * 45, `human pace (${typingMs}ms for 4 chars) — not a bulk insert`);
  assert.deepEqual(await ev("document.getElementById('t').value"), "he12");

  // Human click: a trajectory of moves BEFORE the press, ending on the point.
  // (lastIndexOf: the type() focus-click earlier also recorded a press.)
  const input = await ev("(() => { const r = document.getElementById('t').getBoundingClientRect(); return { x: Math.round(r.x + 4), y: Math.round(r.y + 4) }; })()");
  await c.execute("click", { target: { x: input.x, y: input.y }, human: true, settle_ms: 100 });
  const m = await ev("window.__m");
  const pressIdx = m.map((e) => e.n).lastIndexOf("mousedown");
  assert.ok(pressIdx >= 3, `approach trajectory before the press (${pressIdx} prior events)`);
  const moves = m.slice(0, pressIdx).filter((e) => e.n === "mousemove");
  assert.ok(moves.length >= 3, `≥3 approach moves (got ${moves.length})`);
  assert.ok(moves.every((e) => e.trusted), "all approach moves trusted");
  const settled = moves.at(-1);
  assert.ok(Math.hypot(settled.x - input.x, settled.y - input.y) <= 1, "last approach move is on target");
  assert.ok(m[pressIdx + 1].n === "mouseup", "press → release");
});

test("human fill: ax_fill {human:true} focuses and types humanly into every field", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  const html = `data:text/html,<form>
    <input id="u" aria-label="user"><input id="p" type="password" aria-label="pass">
    <script>
      window.__k = [];
      for (const id of ["u", "p"]) {
        const el = document.getElementById(id);
        ["keydown", "input"].forEach((n) => el.addEventListener(n, (e) =>
          window.__k.push({ id, n, key: e.key, code: e.code || null, ctrl: e.ctrlKey, trusted: e.isTrusted })));
      }
    </script></form>`;
  const opened = await c.execute("open", { url: html, headless: true, settle_ms: 150 });
  const refs = {};
  for (const m of opened.observation.text.matchAll(/textbox "(\w+)"[^\[]*\[ref=(e\d+)\]/g)) refs[m[1]] = m[2];
  assert.ok(refs.user && refs.pass, `both fields have refs: ${JSON.stringify(refs)}`);
  const t0 = Date.now();
  const filled = await c.execute("fill", {
    fields: [{ ref: refs.user, value: "ada" }, { ref: refs.pass, value: "s3cret" }],
    human: true,
    settle_ms: 120,
  });
  assert.equal(filled.action_sent, "sent");
  const keys = JSON.parse((await c.execute("evaluate", { expression: "window.__k" })).value ?? "[]");
  // per-char pairs in EACH field (the select-all Ctrl+A pairs are excluded
  // by the ctrl flag — they are the command's, not the typing's).
  const downs = keys.filter((k) => k.n === "keydown" && !k.ctrl && k.key.length === 1);
  // per-char pairs in EACH field (select-all combos add Ctrl/A pairs, excluded here)
  assert.equal(downs.filter((k) => k.id === "u").length, 3, "3 keydowns in the user field");
  assert.equal(downs.filter((k) => k.id === "p").length, 6, "6 keydowns in the pass field");
  assert.ok(keys.every((k) => k.trusted), "every event trusted");
  assert.deepEqual(keys.filter((k) => k.id === "u" && k.n === "input").length, [3][0]);
  assert.ok(Date.now() - t0 >= (3 + 6) * 45, `human pace across both fields (${Date.now() - t0}ms)`);
  const vals = JSON.parse((await c.execute("evaluate", { expression: "({u: document.getElementById('u').value, p: document.getElementById('p').value})" })).value ?? "{}");
  assert.deepEqual(vals, { u: "ada", p: "s3cret" });
});

test("proxy: browser egress routes through a credentialed local proxy (407 → CDP auth)", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  // Plain origin server (the "site").
  const site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1 id=\"ok\">hello-through-proxy</h1>");
  });
  await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
  t.after(() => site.close());
  const sitePort = site.address().port;

  // Minimal forwarding proxy with a 407 Basic challenge: first request has
  // no Proxy-Authorization → 407; Chrome answers via our CDP auth handler →
  // retry with credentials → forwarded.
  const USER = "fleet", PASS = "s3cret";
  const seen = { challenges: 0, authorized: 0 };
  const proxy = http.createServer((req, res) => {
    const auth = req.headers["proxy-authorization"];
    if (!auth) {
      seen.challenges++;
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="axuse-test"' });
      res.end();
      return;
    }
    seen.authorized++;
    const expect = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
    assert.equal(auth, expect, "credentials answered over CDP arrive as Basic Proxy-Authorization");
    const target = new URL(req.url); // absolute URI (plain HTTP proxying)
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: req.method, headers: { ...req.headers, host: target.host } },
      (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); },
    );
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  t.after(() => proxy.close());
  const proxyPort = proxy.address().port;

  const c = new Controller();
  t.after(() => c.dispose());
  const opened = await c.execute("open", {
    url: `http://127.0.0.1:${sitePort}/`,
    headless: true,
    proxy: `http://${USER}:${PASS}@127.0.0.1:${proxyPort}`,
    proxy_bypass: "<-loopback>", // include localhost so the fixture is proxied
    settle_ms: 300,
  });
  // The page rendered THROUGH the proxy (its content, not a Chrome error page).
  assert.match(opened.observation.text, /hello-through-proxy/);
  assert.ok(seen.challenges >= 1, "the proxy challenged (407)");
  assert.ok(seen.authorized >= 1, "the CDP-answered retry carried credentials");
  await c.execute("close", { browser: true });
});
