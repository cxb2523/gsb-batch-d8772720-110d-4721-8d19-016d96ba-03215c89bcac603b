/* Behavioral test for the collection page logic (index.html).
 *
 * Pure Node, no dependencies: a minimal DOM stub + fetch mock drive the exact
 * inline script shipped in index.html. Run from repo root:
 *   node tests/run-tests.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const INLINE = HTML.match(/<script>([\s\S]*?)<\/script>/g).pop()
  .replace(/^<script>/, "").replace(/<\/script>$/, "");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ FAIL: " + msg); }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/* ---------- minimal per-test DOM ---------- */
function makeEl(id) {
  const el = {
    id, hidden: false, disabled: false, _text: "", _html: "", style: {}, className: "",
    _listeners: {}, _children: {},
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
  };
  // Real DOM stringifies textContent; the stub must do the same.
  Object.defineProperty(el, "textContent", {
    get() { return el._text; },
    set(v) { el._text = v == null ? "" : String(v); },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    // Merge: ids that already exist (e.g. stat elements re-rendered each round)
    // keep their stub identity instead of being wiped.
    set(v) {
      el._html = v;
      for (const m of v.matchAll(/id="([^"]+)"/g)) {
        if (!(m[1] in el._children)) el._children[m[1]] = makeEl(m[1]);
      }
    },
  });
  return el;
}
class FakeElement {
  constructor(tag) { this.tag = tag; this.children = []; this.innerHTML = ""; this.style = {}; this.textContent = ""; }
  appendChild(c) { this.children.push(c); return c; }
}

function createDom(initialScenario) {
  const ids = ["scenario","rerun","nav-meta","mode-note","summary","progress-wrap",
    "progress-bar","stat-progress","stat-ok","stat-fail","stat-skip","stat-trust",
    "banner-slot","list-slot"];
  // One persistent registry per DOM: getElementById always resolves an id to the
  // same stub, even after the page rewrites innerHTML.
  const registry = {};
  for (const id of ids) registry[id] = makeEl(id);
  registry.scenario.value = initialScenario;
  const documentStub = {
    getElementById(id) {
      if (!(id in registry)) registry[id] = makeEl(id);
      return registry[id];
    },
    createElement: (t) => new FakeElement(t),
  };
  return { elMap: registry, documentStub };
}

/* ---------- fetch mock ---------- */
let fetchMode = "http";
let routeTable = {};
let fetchLog = [];

class FakeAbortController {
  constructor() {
    this.signal = { listeners: [], addEventListener: (_e, fn) => this.signal.listeners.push(fn) };
  }
  abort() { this.signal.listeners.forEach((fn) => fn()); }
}

function makeFetch() {
  return function fakeFetch(rawUrl, opts) {
    // Page resolves relative URLs against the manifest's directory; map back to
    // route-table keys: "samples/<manifest>" or (manifest-relative) "data/<file>".
    let key = rawUrl;
    if (/^https?:\/\//.test(rawUrl)) {
      const p = new URL(rawUrl).pathname;                 // /samples/manifest.json | /samples/data/x.json
      key = p.startsWith("/samples/data/") ? p.slice("/samples/".length)  // data/x.json
            : p.slice(1);                                                   // samples/manifest.json
    }
    fetchLog.push({ url: rawUrl, key, opts });
    const route = routeTable[key];
    const delay = route && route.delayMs ? route.delayMs : 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      };
      // page's per-item timeout fires this signal after timeoutMs
      if (opts && opts.signal) opts.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (!route || route.failNetwork) { reject(new TypeError("Failed to fetch")); return; }
        if (route.status && route.status !== 200) {
          resolve({ ok: false, status: route.status, statusText: "Err", body: null, text: () => Promise.resolve(route.body || "") });
          return;
        }
        const body = route.body != null ? route.body : "";
        const buf = Buffer.from(body);
        let offset = 0;
        const reader = {
          read() {
            if (offset >= buf.length) return Promise.resolve({ done: true, value: undefined });
            const chunk = buf.subarray(offset, Math.min(offset + 4096, buf.length));
            offset += chunk.length;
            return Promise.resolve({ done: false, value: new Uint8Array(chunk) });
          },
          cancel() { offset = buf.length; return Promise.resolve(); },
        };
        resolve({
          ok: true, status: 200, statusText: "OK",
          body: { getReader: () => reader },
          text: () => Promise.resolve(body),
        });
      }, delay);
    });
  };
}

/* ---------- load page script in sandbox ---------- */
function loadPage(scenario) {
  const { elMap, documentStub } = createDom(scenario);
  const win = {
    location: { protocol: fetchMode === "file" ? "file:" : "http:", href: "http://test.local/index.html" },
    SAMPLE_REGISTRY: undefined,
    fetch: makeFetch(),
    AbortController: FakeAbortController,
    Blob: class { constructor(parts) { this.size = Buffer.byteLength(parts.join("")); } },
    TextDecoder,
    setTimeout, clearTimeout, Date,
  };
  new Function("window", fs.readFileSync(path.join(ROOT, "samples", "sample-registry.js"), "utf8"))(win);
  let rerunHandler = null;
  elMap.rerun.addEventListener = (ev, fn) => { if (ev === "click") rerunHandler = fn; };
  elMap.scenario.addEventListener = () => {};
  new Function("window","document","fetch","AbortController","Blob","TextDecoder",
    "setTimeout","clearTimeout","Promise", INLINE)(
      win, documentStub, win.fetch, FakeAbortController, win.Blob, TextDecoder, setTimeout, clearTimeout, Promise);
  return { win, elMap, rerun: () => rerunHandler && rerunHandler() };
}

async function settle(elMap, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await tick(20);
    const trust = elMap["stat-trust"].textContent;
    const banner = elMap["banner-slot"].innerHTML;
    if (!trust.includes("采集中") && !banner.includes("正在加载采集清单") && elMap.rerun.disabled === false) return;
  }
}
function readItem(elMap, i) {
  return {
    status: elMapGet(elMap, "status-" + i).textContent,
    card: elMapGet(elMap, "item-" + i).className,
    detailHtml: elMapGet(elMap, "detail-" + i).innerHTML,
  };
}
function elMapGet(elMap, id) {
  return elMap[id] || { textContent: "", innerHTML: "", className: "" };
}

/* ---------- routes from real files ---------- */
function routesFromManifest(manifestName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "samples", manifestName), "utf8"));
  const routes = {};
  for (const item of manifest.items) {
    if (!item.url) continue;
    const filePath = path.join(ROOT, "samples", item.url);
    routes[item.url] = fs.existsSync(filePath)
      ? { status: 200, body: fs.readFileSync(filePath, "utf8") }
      : { failNetwork: true };
  }
  routes["samples/" + manifestName] = { status: 200, body: fs.readFileSync(path.join(ROOT, "samples", manifestName), "utf8") };
  return { manifest, routes };
}

/* ================= TESTS ================= */
async function testAllSuccess() {
  console.log("\n[情形一] 全部成功（真实 fetch 路径）");
  fetchMode = "http";
  const { manifest, routes } = routesFromManifest("manifest-all-success.json");
  routeTable = routes; fetchLog = [];
  const { elMap } = loadPage("manifest-all-success.json");
  await settle(elMap);
  const n = manifest.items.length;
  assert(elMap["stat-progress"].textContent === n + " / " + n, "已完成/总数 = " + n + "/" + n + "（实际：" + elMap["stat-progress"].textContent + "）");
  assert(elMap["stat-ok"].textContent === String(n), "成功数 = " + n + "（实际 " + elMap["stat-ok"].textContent + "）");
  assert(elMap["stat-fail"].textContent === "0", "失败数 = 0");
  assert(elMap["stat-trust"].textContent === "可信", "整轮可信");
  assert(elMap["banner-slot"].innerHTML.includes("可信") && !elMap["banner-slot"].innerHTML.includes("不可信"), "顶部为可信提示");
  assert(fetchLog.length === n + 1, "fetch 调用次数 = 清单1次 + 数据" + n + "次（实际 " + fetchLog.length + "）");
  manifest.items.forEach((item, i) => {
    const r = readItem(elMap, i);
    assert(r.status === "成功", "第" + (i+1) + "项状态=成功");
    assert(r.detailHtml.includes("fv"), "第" + (i+1) + "项渲染了展示字段");
  });
  const dataFetches = fetchLog.slice(1).map((f) => f.key);
  assert(JSON.stringify(dataFetches) === JSON.stringify(manifest.items.map((i) => i.url)), "按清单顺序逐项 fetch");
  manifest.items.forEach((item, i) => {
    assert(fetchLog[i+1].opts && fetchLog[i+1].opts.signal, "第" + (i+1) + "项使用独立超时信号（AbortController）");
  });
}

async function testOptionalFail() {
  console.log("\n[情形二] 单项非必需失败（超限 + 缺文件），必需项全成功");
  fetchMode = "http";
  const { manifest, routes } = routesFromManifest("manifest-optional-fail.json");
  routeTable = routes; fetchLog = [];
  const { elMap } = loadPage("manifest-optional-fail.json");
  await settle(elMap);
  const n = manifest.items.length;
  assert(elMap["stat-progress"].textContent === n + " / " + n, "全部项有结局（" + elMap["stat-progress"].textContent + "）");
  assert(elMap["stat-fail"].textContent === "2", "失败数 = 2（1 个超 64KiB + 1 个地址缺失），实际 " + elMap["stat-fail"].textContent);
  assert(elMap["stat-trust"].textContent === "可信", "非必需失败 → 整轮仍可信");
  const oversize = readItem(elMap, 3);
  assert(oversize.status === "失败" && oversize.detailHtml.includes("64 KiB"), "超限项判失败且原因含 64 KiB 说明");
  assert(oversize.detailHtml.includes("非必需"), "超限项标注为非必需、不阻断");
  const missing = readItem(elMap, 4);
  assert(missing.status === "失败" && missing.detailHtml.includes("地址不可达"), "缺文件项判网络失败并给出原因");
  assert(elMap["banner-slot"].innerHTML.includes("非必需"), "顶部提示说明仅非必需项失败");
  assert(fetchLog.some((f) => f.key === manifest.items[4].url), "失败后仍继续采集后续项（未阻断）");
}

async function testAllFail() {
  console.log("\n[情形三] 全部失败（必需项失败 + 跳过项）");
  fetchMode = "http";
  const { manifest, routes } = routesFromManifest("manifest-all-fail.json");
  routeTable = routes; fetchLog = [];
  const { elMap } = loadPage("manifest-all-fail.json");
  await settle(elMap);
  const n = manifest.items.length;
  assert(elMap["stat-progress"].textContent === n + " / " + n, "全部项有结局，未停在加载中");
  assert(elMap["stat-fail"].textContent === "3", "失败数 = 3，实际 " + elMap["stat-fail"].textContent);
  assert(elMap["stat-skip"].textContent === "1", "跳过数 = 1");
  assert(elMap["stat-trust"].textContent === "不可信", "必需项失败 → 整轮不可信");
  assert(elMap["banner-slot"].innerHTML.includes("不可信"), "顶部醒目不可信提示");
  const skipped = readItem(elMap, 3);
  assert(skipped.status === "跳过" && skipped.detailHtml.includes("跳过"), "空地址项=跳过并记录原因");
  assert(readItem(elMap, 0).detailHtml.includes("必需项"), "必需失败项写明整轮不可信后果");
  assert(elMap.rerun.disabled === false, "结束后重新采集按钮恢复可用");
}

async function testEmptyManifest() {
  console.log("\n[情形四] 空清单 → 明确空态");
  fetchMode = "http";
  const { routes } = routesFromManifest("manifest-empty.json");
  routeTable = routes; fetchLog = [];
  const { elMap } = loadPage("manifest-empty.json");
  await settle(elMap);
  assert(elMap["banner-slot"].innerHTML.includes("清单为空"), "顶部给出空态说明");
  assert(elMap["stat-progress"].textContent === "0 / 0", "进度 0/0");
  assert(!elMap.rerun.disabled, "不在加载中，按钮可用");
}

async function testTimeout() {
  console.log("\n[超时] 单项超时按配置触发并判失败，后续项继续");
  fetchMode = "http";
  const { manifest, routes } = routesFromManifest("manifest-all-success.json");
  // route resolves at 500ms, page per-item timeout for this entry is 4000ms ->
  // use a per-item override by making the route slower than the effective wait.
  // Instead, point the entry at a 6s route but shrink the settle window below it
  // is impossible; so the mock supports an "abort first" contract: the page's
  // AbortController fires at timeoutMs and our fetch rejects immediately.
  routes["data/line-status.json"] = { delayMs: 6000, body: "{}" };
  routeTable = routes; fetchLog = [];
  const { elMap } = loadPage("manifest-all-success.json");
  await settle(elMap, 8000);
  assert(readItem(elMap, 0).status === "失败", "超时项判失败");
  assert(readItem(elMap, 0).detailHtml.includes("超时"), "失败原因包含超时说明");
  assert(readItem(elMap, 1).status === "成功", "超时后后续项继续并成功");
  assert(elMap["stat-trust"].textContent === "不可信", "必需项超时 → 整轮不可信");
}

async function testHttpErrorAndBadJsonAndMissingField() {
  console.log("\n[解析/协议] HTTP 500、非法 JSON、缺字段各自给出明确原因");
  fetchMode = "http";
  const { routes } = routesFromManifest("manifest-all-success.json");
  routes["data/line-status.json"] = { status: 500, body: "err" };
  routes["data/output.json"] = { status: 200, body: "not-json{" };
  routes["data/quality.json"] = { status: 200, body: JSON.stringify({ inspected: 1 }) };
  routeTable = routes; fetchLog = [];
  const { elMap } = loadPage("manifest-all-success.json");
  await settle(elMap);
  assert(readItem(elMap, 0).detailHtml.includes("500"), "HTTP 500 原因展示");
  assert(readItem(elMap, 1).detailHtml.includes("合法 JSON"), "非法 JSON 原因展示");
  assert(readItem(elMap, 2).detailHtml.includes("缺少约定字段"), "缺字段原因展示");
  assert(readItem(elMap, 3).status === "成功", "非必需设备项仍成功");
}

async function testRerunClearsPrevious() {
  console.log("\n[重新采集] 点击后清空上一轮结果再重跑");
  fetchMode = "http";
  const failRoutes = routesFromManifest("manifest-all-fail.json");
  routeTable = failRoutes.routes; fetchLog = [];
  const page = loadPage("manifest-all-fail.json");
  await settle(page.elMap);
  assert(page.elMap["stat-trust"].textContent === "不可信", "首轮为不可信");
  const ok = routesFromManifest("manifest-all-success.json");
  routeTable = ok.routes; fetchLog = [];
  page.elMap.scenario.value = "manifest-all-success.json";
  page.rerun();
  await settle(page.elMap);
  assert(page.elMap["stat-trust"].textContent === "可信", "重跑后可信度刷新为可信");
  assert(page.elMap["stat-fail"].textContent === "0", "上一轮失败结果已清空（失败数=0）");
  assert(!page.elMap["banner-slot"].innerHTML.includes("不可信"), "顶部不可信提示已清除");
  for (let i = 0; i < ok.manifest.items.length; i++) assert(readItem(page.elMap, i).status === "成功", "重跑后第" + (i+1) + "项成功");
}

async function testFileProtocolFallback() {
  console.log("\n[file:// 回退] Chromium 拦截 fetch 时用同目录静态样例复现三种情形");
  fetchMode = "file";
  for (const name of ["manifest-all-success.json","manifest-optional-fail.json","manifest-all-fail.json","manifest-empty.json"]) {
    const { manifest } = routesFromManifest(name);
    const routes = {};
    for (const item of manifest.items) if (item.url) routes[item.url] = { failNetwork: true };
    routes["samples/" + name] = { failNetwork: true };
    routeTable = routes; fetchLog = [];
    const { elMap } = loadPage(name);
    await settle(elMap);
    const n = manifest.items.length;
    if (name === "manifest-all-success.json")
      assert(elMap["stat-ok"].textContent === String(n) && elMap["stat-trust"].textContent === "可信", "file:// 全部成功可复现");
    if (name === "manifest-optional-fail.json") {
      assert(elMap["stat-fail"].textContent === "2" && elMap["stat-trust"].textContent === "可信", "file:// 非必需失败可复现");
      assert(readItem(elMap, 3).detailHtml.includes("64 KiB"), "file:// 回退数据同样执行 64KiB 体积闸");
    }
    if (name === "manifest-all-fail.json")
      assert(elMap["stat-trust"].textContent === "不可信" && elMap["stat-skip"].textContent === "1", "file:// 全部失败可复现");
    if (name === "manifest-empty.json")
      assert(elMap["banner-slot"].innerHTML.includes("清单为空"), "file:// 空清单空态可复现");
  }
}

async function testManifestLoadFailure() {
  console.log("\n[清单加载失败] 清单地址不可达 → 明确失败态，不停在加载中");
  fetchMode = "http";
  routeTable = { "samples/manifest-all-success.json": { failNetwork: true } };
  const { elMap } = loadPage("manifest-all-success.json");
  await settle(elMap);
  assert(elMap["banner-slot"].innerHTML.includes("清单加载失败"), "展示清单加载失败态");
  assert(!elMap.rerun.disabled, "按钮恢复可用，未卡在加载中");
}

const tests = [testAllSuccess, testOptionalFail, testAllFail, testEmptyManifest,
  testTimeout, testHttpErrorAndBadJsonAndMissingField, testRerunClearsPrevious,
  testFileProtocolFallback, testManifestLoadFailure];

for (const t of tests) {
  try { await t(); }
  catch (e) { failures++; console.error("  ✗ EXCEPTION in", t.name, "—", e.stack); }
}
console.log("\n========================================");
if (failures) { console.error(failures + " 个断言失败"); process.exit(1); }
console.log("全部测试通过 ✅");
process.exit(0);
