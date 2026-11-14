/* HTTP integration test: drives index.html's exact inline script against a real
 * static server (python -m http.server) using Node's native fetch, streams,
 * AbortController and Blob. Run from repo root while the server is up:
 *   node tests/http-integration.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.TEST_BASE || "http://127.0.0.1:8923/";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const INLINE = HTML.match(/<script>([\s\S]*?)<\/script>/g).pop()
  .replace(/^<script>/, "").replace(/<\/script>$/, "");

let failures = 0;
const assert = (c, m) => { if (c) console.log("  ✓ " + m); else { failures++; console.error("  ✗ FAIL: " + m); } };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function makeEl(id) {
  const el = { id, hidden: false, disabled: false, _text: "", _html: "", style: {}, className: "", _listeners: {} };
  Object.defineProperty(el, "textContent", { get: () => el._text, set: (v) => { el._text = v == null ? "" : String(v); } });
  Object.defineProperty(el, "innerHTML", { get: () => el._html, set: (v) => { el._html = v; } });
  el.addEventListener = (ev, fn) => { (el._listeners[ev] ||= []).push(fn); };
  return el;
}
class FakeElement { constructor(t) { this.tag = t; } appendChild(c) { return c; } }

function loadPage(scenario) {
  const ids = ["scenario","rerun","nav-meta","mode-note","summary","progress-wrap",
    "progress-bar","stat-progress","stat-ok","stat-fail","stat-skip","stat-trust","banner-slot","list-slot"];
  const registry = Object.fromEntries(ids.map((id) => [id, makeEl(id)]));
  registry.scenario.value = scenario;
  const documentStub = { getElementById: (id) => (registry[id] ||= makeEl(id)), createElement: (t) => new FakeElement(t) };
  let rerunHandler = null;
  registry.rerun.addEventListener = (ev, fn) => { if (ev === "click") rerunHandler = fn; };
  registry.scenario.addEventListener = () => {};
  // Relative URLs in manifests resolve against the real server base.
  const serverFetch = (url, opts) => fetch(new URL(url, BASE), opts);
  const win = {
    location: { protocol: "http:", href: BASE + "index.html" },
    fetch: serverFetch, AbortController, Blob, TextDecoder, setTimeout, clearTimeout, Date,
  };
  new Function("window","document","fetch","AbortController","Blob","TextDecoder",
    "setTimeout","clearTimeout","Promise", INLINE)(
      win, documentStub, serverFetch, AbortController, Blob, TextDecoder, setTimeout, clearTimeout, Promise);
  return { el: registry, rerun: () => rerunHandler && rerunHandler() };
}
async function settle(el, maxMs = 15000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await tick();
    if (!el["stat-trust"].textContent.includes("采集中") &&
        !el["banner-slot"].innerHTML.includes("正在加载采集清单") &&
        el.rerun.disabled === false) return;
  }
}
const item = (el, i, key) => el["status-" + i] ? (key === "status" ? el["status-" + i].textContent : el["detail-" + i].innerHTML) : "";

async function scenario(name, checks) {
  console.log("\n[HTTP] " + name);
  const page = loadPage(name);
  await settle(page.el);
  checks(page.el);
}

try {
  await scenario("manifest-all-success.json", (el) => {
    assert(el["stat-progress"].textContent === "4 / 4", "进度 4/4（实际 " + el["stat-progress"].textContent + "）");
    assert(el["stat-ok"].textContent === "4" && el["stat-fail"].textContent === "0", "4 成功 0 失败");
    assert(el["stat-trust"].textContent === "可信", "整轮可信");
    for (let i = 0; i < 4; i++) assert(item(el, i, "status") === "成功", "第" + (i+1) + "项成功且字段已渲染");
  });

  await scenario("manifest-optional-fail.json", (el) => {
    assert(el["stat-fail"].textContent === "2", "2 个非必需失败（实际 " + el["stat-fail"].textContent + "）");
    assert(el["stat-trust"].textContent === "可信", "必需全成功 → 仍可信");
    assert(item(el, 3, "detail").includes("64 KiB"), "真实流式抓取在 64KiB 处中止并判失败");
    assert(item(el, 4, "detail").includes("地址不可达") || item(el, 4, "detail").includes("404"), "404 缺失文件给出失败原因");
  });

  await scenario("manifest-all-fail.json", (el) => {
    assert(el["stat-fail"].textContent === "3" && el["stat-skip"].textContent === "1", "3 失败 1 跳过");
    assert(el["stat-trust"].textContent === "不可信", "整轮不可信");
    assert(el["banner-slot"].innerHTML.includes("不可信"), "顶部醒目不可信横幅");
    assert(item(el, 3, "status") === "跳过", "空地址项跳过");
  });

  await scenario("manifest-empty.json", (el) => {
    assert(el["banner-slot"].innerHTML.includes("清单为空"), "空清单空态");
    assert(el["stat-progress"].textContent === "0 / 0", "0/0 且无加载中");
  });

  console.log("\n========================================");
  if (failures) { console.error(failures + " 个断言失败"); process.exit(1); }
  console.log("HTTP 集成测试全部通过 ✅（真实 fetch / 流式 64KiB 闸 / 真实 404）");
} catch (e) {
  console.error("集成测试异常（服务器是否已启动？）：", e);
  process.exit(1);
}
