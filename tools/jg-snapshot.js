/**
 * tools/jg-snapshot.js —— 聚光每日快照（history 断链的替代方案）
 *
 * 依据：`聚光-日快照-fixture规格.md`（下称"规格"）。本文件**不改规格**；要改先改文档。
 * 纪律：**只读**。只 GET 聚光接口，只写本地 `data/jg-snapshot/`；不触发同步、不改调度、不写库。
 *
 * 用法：
 *   node tools/jg-snapshot.js --dry                 # 只打印，不落文件（默认 slot 按当前时刻推断）
 *   node tools/jg-snapshot.js --dry --slot=am       # 指定 slot
 *   node tools/jg-snapshot.js --self-test           # 不联网，用合成载荷验证字段与三类 empty_reason
 *   node tools/jg-snapshot.js --commit              # 真正落盘（写 data/jg-snapshot/…json + index.ndjson）
 *
 * 退出码：0 = 正常（含"接口空"这种合法空结果）｜2 = 未登录｜3 = 限流｜4 = 非预期
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const SCHEMA_VERSION = 1;
const ROOT = __dirname + path.sep + '..';
const OUT_DIR = path.join(ROOT, 'data', 'jg-snapshot');
const INDEX = path.join(OUT_DIR, 'index.ndjson');
const LOCK = path.join(OUT_DIR, '.lock');
const BASE = 'https://jg.hymqbz.top';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => {
  const eq = argv.find((x) => x.startsWith('--' + k + '='));
  if (eq) return eq.slice(k.length + 3);
  const i = argv.indexOf('--' + k);            // 同时支持 `--k=v` 与 `--k v` 两种写法
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return null;
};
const DRY = has('--dry');
const SELF = has('--self-test');
const COMMIT = has('--commit');

// ── slot：11:30 之前算 am，之后算 pm（规格 §二）────────────────────────────────
function pickSlot() {
  const forced = val('slot');
  if (forced && !['am', 'pm'].includes(forced)) { console.error('--slot 只能是 am 或 pm'); process.exit(2); }
  if (forced) return forced;
  return new Date().getHours() < 12 ? 'am' : 'pm';
}

function nowIso() {
  // 规格 §四：fetched_at 必须是带时区的 ISO8601
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(tz / 60) + ':' + pad(tz % 60);
}

function isoLocal(d) {
  const tz = -d.getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    (tz >= 0 ? '+' : '-') + pad(tz / 60) + ':' + pad(tz % 60);
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ── 只读 GET（不跟随重定向，把 302→/sso/login 也当"未登录"）───────────────────
function getJson(urlPath) {
  return new Promise((resolve) => {
    const u = new URL(BASE + urlPath);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'dsh-jg-snapshot/1' },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, location: res.headers.location || '', body, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: '', location: '', headers: {} }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/**
 * 空结果三分类（规格 §五：不许静默写空文件）
 *   未登录 / 限流 / 接口空  —— 外加一个显式的"非预期"，避免又把未知压进"接口空"里
 */
function classify(res, parsed) {
  const b = (res.body || '').toLowerCase();
  if (res.status === 401 || res.status === 403) return '未登录';
  if (res.status === 302 || /\/sso\/login|\/login/.test(res.location || '')) return '未登录';
  if (res.status === 429) return '限流';
  if (/rate.?limit|too many|fatigue|限流/.test(b)) return '限流';
  if (/请先登录|未登录|login required|unauthorized/.test(b)) return '未登录';
  if (res.status === 200 && parsed && Array.isArray(parsed.rows) && parsed.rows.length === 0) return '接口空';
  if (res.status !== 200) return '非预期 HTTP ' + res.status;
  return null; // 有数据
}

// ── 归一化：把接口形状压成规格 §一 的 8 个必填字段 ─────────────────────────────
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function normRows(raw, fetchedAt, source) {
  const rows = (raw || []).map((r) => {
    const inbox = num(r.inbox);
    const fee = num(r.fee);
    const rec = {
      date: r.date || todayLocal(),
      star: r.star == null ? null : String(r.star),
      city: r.city == null ? null : String(r.city),
      fee,
      impression: num(r.impression),
      click: num(r.click),
      inbox,
      // 规格 §一：inbox=0 时 cpl 写 null，不许写 0
      cpl: inbox === 0 || inbox == null ? null : (fee == null ? null : Number((fee / inbox).toFixed(2))),
      fetched_at: fetchedAt,
      source,
      schema_version: SCHEMA_VERSION,
    };
    if (r.star == null || r.city == null) rec.dim_missing = true;
    return rec;
  });
  return rows;
}

// ── starCity 拆分（规格 §一.2：只认城市名表的"最长后缀匹配"，拆不出就 null，不猜）──
let CITY_NAMES = null;
function cityNames() {
  if (CITY_NAMES) return CITY_NAMES;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'city-areas.json'), 'utf8'));
    CITY_NAMES = Object.keys(j).sort((a, b) => b.length - a.length); // 长的先匹配
  } catch (e) { CITY_NAMES = []; }
  return CITY_NAMES;
}
function splitStarCity(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return { star: null, city: null, dim_missing: true };
  const hits = cityNames().filter((c) => raw.length > c.length && raw.endsWith(c));
  if (hits.length === 0) return { star: raw, city: null, dim_missing: true };      // 没城市 → 全当明星名，标 dim_missing
  if (hits.length > 1 && hits[0].length === hits[1].length) {
    return { star: raw, city: null, dim_missing: true };                            // 同长度多命中 = 歧义，不猜
  }
  const city = hits[0];                                                             // 最长后缀
  return { star: raw.slice(0, raw.length - city.length), city, dim_missing: false };
}

// ── 从 payload 聚合到 (advertiser, star, city)（规格 §一.2 第 2 条：遍历，不写死第 0 条）──
function rowsFromPayload(payload, fetchedAt) {
  const sum = (payload && payload.summary) || {};
  const idleCost = num(sum.idle_cost);
  const idleRate = num(sum.idle_rate);
  const idleCreatives = num(sum.idle_creatives);
  const missing = [];
  if (idleCost === null) missing.push('summary.idle_cost');
  if (idleRate === null) missing.push('summary.idle_rate');
  if (idleCreatives === null) missing.push('summary.idle_creatives');

  const list = (payload && (payload.top_by_inbox || payload.top_creatives)) || [];
  const advertisers = (payload && Array.isArray(payload.advertiser_breakdown)) ? payload.advertiser_breakdown : null;

  // 有 advertiser_breakdown：按广告主各出一组（当前它只给汇总，没有 per-creative，故只在其有 top 时复用）
  const groups = advertisers && advertisers.length
    ? advertisers.map((a) => ({ id: a.advertiser_id || a.id || null, items: list, own: a }))
    : [{ id: null, items: list, own: null }];

  const rows = [];
  groups.forEach((g) => {
    const agg = new Map();
    (g.items || []).forEach((c) => {
      const key = String(c.starCity || c.star || '?');
      const sc = splitStarCity(key);
      const k = g.id + '|' + sc.star + '|' + sc.city;
      if (!agg.has(k)) agg.set(k, {
        date: todayLocal(), star: sc.star, city: sc.city,
        fee: 0, impression: 0, click: 0, inbox: 0,
        dim_missing: sc.dim_missing,
      });
      const m = agg.get(k);
      m.fee += num(c.cost) || 0;
      m.impression += num(c.impressionCount != null ? c.impressionCount : c.impression) || 0;
      m.click += num(c.clickCount != null ? c.clickCount : c.click) || 0;
      m.inbox += num(c.inboxCount != null ? c.inboxCount : c.inbox) || 0;
    });
    Array.from(agg.values()).forEach((m) => {
      rows.push({
        level: 'star',
        date: m.date, star: m.star, city: m.city,
        fee: Number(m.fee.toFixed(2)), impression: m.impression, click: m.click, inbox: m.inbox,
        cpl: m.inbox === 0 ? null : Number((m.fee / m.inbox).toFixed(2)),   // 规格：inbox=0 → null
        idle_cost: idleCost, idle_rate: idleRate, idle_creatives: idleCreatives,
        advertiser_id: g.id,
        fetched_at: fetchedAt,
        source: (g.items && g.items.length) ? 'payload.top_by_inbox' : 'payload.summary 级（无 star/city 维度）',
        schema_version: SCHEMA_VERSION,
        ...(m.dim_missing ? { dim_missing: true } : {}),
      });
    });

    // 规格 §一.4：创意级明细也要落（否则 50 条明细只剩 3 行聚合）
    (g.items || []).forEach((c) => {
      const sc = splitStarCity(String(c.starCity || c.star || '?'));
      const fee = num(c.cost);
      const inbox = num(c.inboxCount != null ? c.inboxCount : c.inbox);
      rows.push({
        level: 'creative',
        date: todayLocal(), star: sc.star, city: sc.city,
        fee, impression: num(c.impressionCount != null ? c.impressionCount : c.impression),
        click: num(c.clickCount != null ? c.clickCount : c.click),
        inbox,
        cpl: inbox === 0 || inbox == null ? null : (fee == null ? null : Number((fee / inbox).toFixed(2))),
        idle_cost: idleCost, idle_rate: idleRate, idle_creatives: idleCreatives,
        advertiser_id: g.id,
        plan_name: c.planName == null ? null : String(c.planName),
        creative_id: c.cid == null ? null : String(c.cid),
        paused: typeof c.paused === 'boolean' ? c.paused : null,
        in_whitelist: typeof c.inWhitelist === 'boolean' ? c.inWhitelist : null,
        status: c.status == null ? null : String(c.status),
        fetched_at: fetchedAt, source: 'payload.top_by_inbox',
        schema_version: SCHEMA_VERSION,
        ...(sc.dim_missing ? { dim_missing: true } : {}),
      });
    });
  });

  return { rows, missing, summary: sum };
}

// 兼容旧调用：把 /api/overview 直接当 payload 传
function fromOverview(ov, fetchedAt) { return rowsFromPayload(ov, fetchedAt).rows; }

// ── promote/rows：场次级决策表（分页翻全，字段原样抄，不造操作人）──────────────
// ── trend：逐分钟累计曲线（字段原样抄，只补 fetched_at）────────────────────
function trendRowsOf(payload, fetchedAt) {
  const list = (payload && (payload.trend || payload.rows || payload.data)) || [];
  return (Array.isArray(list) ? list : []).map((r) => ({
    level: 'account',
    ts: r.ts || r.time || r.t || null,
    fee: num(r.fee != null ? r.fee : r.cost),
    inbox: num(r.inbox != null ? r.inbox : r.inbox_count),
    inbox_cost: num(r.inboxCost != null ? r.inboxCost : r.inbox_cost),
    leads: num(r.leads), lead_cost: num(r.leadCost != null ? r.leadCost : r.lead_cost),
    opens: num(r.opens), active: num(r.active), creatives: num(r.creatives),
    impressions: num(r.impressions != null ? r.impressions : (r.impression != null ? r.impression : r.impression_count)),
    clicks: num(r.clicks != null ? r.clicks : (r.click != null ? r.click : r.click_count)),
    ctr: num(r.ctr),
    fetched_at: fetchedAt,
    source: 'GET /api/overview/trend',
    schema_version: SCHEMA_VERSION,
  }));
}

function promoteRowsOf(payload, fetchedAt) {
  const list = (payload && (payload.rows || payload.data || payload.list)) || [];
  return (Array.isArray(list) ? list : []).map((r) => ({
    level: 'promote',
    'A_日期': r.A == null ? null : String(r.A),
    slot_start: r.B == null ? null : String(r.B),
    slot_end: r.C == null ? null : String(r.C),
    'D_场次': r.D == null ? null : String(r.D),
    'F_开次': r.F == null ? null : String(r.F),
    'H_票种': r.H == null ? null : String(r.H),
    'I_数量': r.I == null ? null : r.I,
    'J_推停': r.J == null ? null : String(r.J),
    row: r.row == null ? null : r.row,
    fetched_at: r.fetched_at || fetchedAt || null,
    schema_version: SCHEMA_VERSION,
  }));
}

async function fetchPromoteRows(date) {
  const PAGE_SIZE = 100, MAX_PAGES = 50;
  let page = 1, all = [], first = null;
  while (page <= MAX_PAGES) {
    const res = await getJson('/api/promote/rows?date=' + encodeURIComponent(date) + '&page=' + page + '&pageSize=' + PAGE_SIZE);
    if (!first) first = res;
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch (e) {}
    const rowsThisPage = promoteRowsOf(parsed, null);
    const asRows = { rows: rowsThisPage };
    const err = classify(res, asRows);
    if (err) return { status: res.status, pages: page, rows: [], emptyReason: err };
    all = all.concat(rowsThisPage);
    if (rowsThisPage.length < PAGE_SIZE) break;
    page++;
  }
  return { status: first ? first.status : 0, pages: page, rows: all, emptyReason: all.length === 0 ? '接口空' : null };
}

// ── 落盘（规格 §三/§六：不覆盖、索引带 sha256、文件锁）───────────────────────
function writeOut(dateStr, slot, rows, meta, suffix) {
  fs.mkdirSync(path.dirname(path.join(OUT_DIR, 'x')), { recursive: true });
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 10 * 60 * 1000) { console.error('❌ 另一个采集进程持有锁（' + LOCK + '），退出'); process.exit(5); }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid), 'utf8');
  try {
    const y = dateStr.slice(0, 4), m = dateStr.slice(5, 7);
    const dir = path.join(OUT_DIR, y, m);
    fs.mkdirSync(dir, { recursive: true });
    const base = dateStr + '__' + slot + (suffix ? '__' + suffix : '');
    let file = path.join(dir, base + '.json');
    let n = 1;
    while (fs.existsSync(file)) { n++; file = path.join(dir, base + '.r' + n + '.json'); }
    const payload = { meta, rows };
    const text = JSON.stringify(payload, null, 1);
    fs.writeFileSync(file, text, 'utf8');
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    fs.appendFileSync(INDEX, JSON.stringify({
      path: path.relative(ROOT, file).replace(/\\/g, '/'), date: dateStr, slot,
      fetched_at: meta.fetched_at, row_count: rows.length, sha256: sha,
      empty_reason: meta.empty_reason || null,
      budget_daily: meta.budget_daily === undefined ? null : meta.budget_daily,
      budget_ts: meta.budget_ts === undefined ? null : meta.budget_ts,
      superseded_by: null,
    }) + '\n', 'utf8');
    return { file, sha };
  } finally { try { fs.unlinkSync(LOCK); } catch (e) {} }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
(async () => {
  // 三类 empty_reason 的离线自证（不联网）：把合成响应喂给真实的 classify()
  if (has('--classify-test')) {
    const cases = [
      ['401 未带会话', { status: 401, body: '', location: '', headers: {} }, null],
      ['302 跳 sso', { status: 302, body: '', location: '/sso/login?next=/', headers: {} }, null],
      ['429 平台限流', { status: 429, body: '{"error":"rate limit"}', location: '', headers: {} }, null],
      ['200 但报 fatigue', { status: 200, body: '{"msg":"request limit by fatigue"}', location: '', headers: {} }, null],
      ['200 空数组', { status: 200, body: '{"rows":[]}', location: '', headers: {} }, { rows: [] }],
      ['200 有数据', { status: 200, body: '{"rows":[{"a":1}]}', location: '', headers: {} }, { rows: [{ a: 1 }] }],
    ];
    cases.forEach(([name, res, parsed]) => {
      console.log((name + '                       ').slice(0, 22), '→', classify(res, parsed) === null ? '有数据' : classify(res, parsed));
    });
    process.exit(0);
  }

  let fetchedAt = nowIso();
  const dateStr = todayLocal();
  const slot = pickSlot();

  let rows = [], emptyReason = null, source = '', httpStatus = null, missing = [];
  let payloadForBudget = null;   // 供 meta 取 budget.*（overview 源）
  const fromJson = val('from-json');
  const SOURCE = (val('source') || 'overview').toLowerCase();
  const isPromote = SOURCE === 'promote-rows';
  const isTrend = SOURCE === 'trend' || SOURCE === 'overview-trend';
  let pagesFetched = null;

  if (SELF) {
    // 合成载荷：覆盖 ①正常 star ②inbox=0（验 cpl=null）③城市在尾部但明星名很长（验后缀拆分）
    const fake = {
      summary: { idle_cost: 113.89, idle_rate: 13.2, idle_creatives: 53 },
      advertiser_breakdown: [{ advertiser_id: '11523290', creatives: 1105 }],
      top_by_inbox: [
        { starCity: '汤令山香港', cost: 2059.04, impressionCount: 90000, clickCount: 1200, inboxCount: 412, planName: 'x' },
        { starCity: '徐良广州', cost: 170, impressionCount: 5000, clickCount: 30, inboxCount: 0, planName: 'y' },
        { starCity: '第十六届中国国际航空航天博览会珠海', cost: 12.5, impressionCount: 100, clickCount: 3, inboxCount: 2, planName: 'z' },
      ],
    };
    const built = rowsFromPayload(fake, fetchedAt);
    rows = built.rows; missing = built.missing;
    source = 'self-test 合成载荷（未联网、不落盘）';
  } else if (isPromote) {
    // ── --source=promote-rows：场次级"人为决策记录表"（A/B/C/D/F/H/I/J/row）──
    // 注意：该表**没有操作人字段**，这里也绝不编一个出来。
    if (fromJson) {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(fromJson, 'utf8')); }
      catch (e) { console.error('❌ 读不到或不是 JSON：' + fromJson); process.exit(4); }
      const fetched = (payload && (payload.fetched_at || (payload.meta && payload.meta.fetched_at))) ||
        isoLocal(new Date(fs.statSync(fromJson).mtimeMs));
      fetchedAt = fetched;
      const list = promoteRowsOf(payload, fetched);
      rows = list; missing = [];
      source = 'file:' + path.basename(fromJson) + ' → promote/rows';
      emptyReason = rows.length === 0 ? '接口空' : null;
    } else {
      const date = val('date') || dateStr;
      const got = await fetchPromoteRows(date);
      httpStatus = got.status;
      emptyReason = got.emptyReason;
      rows = got.rows; pagesFetched = got.pages; missing = [];
      source = 'GET /api/promote/rows?date=' + date + ' (pages=' + got.pages + ')';
      if (emptyReason) rows = [];
    }
  } else if (isTrend) {
    // ── --source=trend：当日逐分钟累计曲线（/api/overview/trend）──
    // 用途：账户级斜率先看"什么时候起量/什么时候停"，比两份快照 diff 细。
    if (fromJson) {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(fromJson, 'utf8')); }
      catch (e) { console.error('❌ 读不到或不是 JSON：' + fromJson); process.exit(4); }
      const fetched = (payload && (payload.fetched_at || (payload.meta && payload.meta.fetched_at))) ||
        isoLocal(new Date(fs.statSync(fromJson).mtimeMs));
      fetchedAt = fetched;
      const list = trendRowsOf(payload, fetchedAt);
      rows = list; missing = [];
      source = 'file:' + path.basename(fromJson) + ' → overview/trend';
      emptyReason = rows.length === 0 ? '接口空' : null;
    } else {
      const res = await getJson('/api/overview/trend');
      httpStatus = res.status;
      let parsed = null;
      try { parsed = JSON.parse(res.body); } catch (e) {}
      const list = trendRowsOf(parsed, fetchedAt);
      emptyReason = classify(res, { rows: list });
      if (emptyReason === null) { rows = list; source = 'GET /api/overview/trend'; }
      else { rows = []; source = 'GET /api/overview/trend'; }
    }
  } else if (fromJson) {
    // ── --from-json：有会话的人取，我这边解析落盘（规格 §一.3）──
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(fromJson, 'utf8')); }
    catch (e) { console.error('❌ 读不到或不是 JSON：' + fromJson + '  (' + e.message + ')'); process.exit(4); }
    // fetched_at 优先 payload.budget.ts，其次文件 mtime，都没有就报错（不许用解析时间冒充）
    let fetched = null;
    const ts = payload && payload.budget && payload.budget.ts;
    if (ts) fetched = String(ts).replace(' ', 'T') + (String(ts).includes('+') ? '' : '+08:00');
    else { try { fetched = isoLocal(new Date(fs.statSync(fromJson).mtimeMs)); } catch (e) {} }
    if (!fetched) { console.error('❌ payload 与文件都没有可取数时间，拒绝落盘（不许用解析时间冒充）'); process.exit(4); }
    fetchedAt = fetched;                  // 规格 §一.3：meta 与 rows 必须同一个取数时间
    payloadForBudget = payload;
    const built = rowsFromPayload(payload, fetched);
    rows = built.rows; missing = built.missing;
    source = 'file:' + path.basename(fromJson) + ' → payload.top_by_inbox';
    emptyReason = rows.length === 0 ? '接口空' : null;
  } else {
    const ov = await getJson('/api/overview');
    httpStatus = ov.status;
    let parsed = null;
    try { parsed = JSON.parse(ov.body); } catch (e) {}
    const asRows = parsed ? { rows: (parsed.top_by_inbox || parsed.top_creatives || []) } : null;
    emptyReason = classify(ov, asRows);
    if (emptyReason === null) {
      payloadForBudget = parsed;
      const built = rowsFromPayload(parsed, fetchedAt);
      rows = built.rows; missing = built.missing;
      source = 'GET /api/overview → top_by_inbox';
    } else { rows = []; source = 'GET /api/overview'; }
  }

  // 【2026-11-09 批准】预算进快照：预算被改这种事必须能自证。
  // budget_ts = **平台这份数的时间**；fetched_at = **我们取数的时间**。两者分开存，不许混。
  let budgetMeta = { budget_daily: null, budget_balance: null, budget_daily_cost: null, budget_ts: null };
  try {
    const b = payloadForBudget && payloadForBudget.budget;
    if (b) {
      const n = (v) => { const x = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : null; };
      budgetMeta = {
        budget_daily: n(b.budget), budget_balance: n(b.balance), budget_daily_cost: n(b.daily_cost),
        budget_ts: b.ts == null ? null : String(b.ts),
      };
    }
  } catch (e) { /* 预算字段缺失不阻断采集 */ }

  const meta = {
    date: dateStr, slot, fetched_at: fetchedAt, source, schema_version: SCHEMA_VERSION,
    ...budgetMeta,
    row_count: rows.length, star_rows: rows.filter((r) => r.level === 'star').length, creative_rows: rows.filter((r) => r.level === 'creative').length,
    empty_reason: emptyReason, http_status: httpStatus, missing_fields: missing,
    source_mode: isPromote ? 'promote-rows' : (isTrend ? 'trend' : 'overview'), pages_fetched: pagesFetched,
  };

  console.log('── 采集结果 ─────────────────────────────');
  console.log('date        :', meta.date);
  console.log('slot        :', meta.slot);
  console.log('fetched_at  :', meta.fetched_at);
  console.log('source      :', meta.source);
  console.log('http_status :', meta.http_status);
  console.log('row_count   :', meta.row_count, '(star', meta.star_rows, '+ creative', meta.creative_rows, '+ promote', rows.filter((r) => r.level === 'promote').length, '+ account', rows.filter((r) => r.level === 'account').length, ')');
  if (meta.pages_fetched) console.log('pages       :', meta.pages_fetched);
  console.log('empty_reason:', meta.empty_reason === null ? '(无，有数据)' : meta.empty_reason);
  if (meta.budget_daily !== null && meta.budget_daily !== undefined) {
    console.log('budget       : daily=' + meta.budget_daily + '  balance=' + meta.budget_balance + '  daily_cost=' + meta.budget_daily_cost);
    console.log('budget_ts    :', meta.budget_ts, '(平台时间，与 fetched_at 分开存)');
  }
  console.log('字段清单    :', rows[0] ? Object.keys(rows[0]).join(', ') : '(无行，字段固定为)' + [
    'date', 'star', 'city', 'fee', 'impression', 'click', 'inbox', 'cpl', 'fetched_at', 'source', 'schema_version'].join(', '));
  rows.slice(0, 2).forEach((r, i) => console.log('样例行 ' + (i + 1) + '   :', JSON.stringify(r)));

  // 不变量自检（规格 §五）
  const bad = rows.filter((r) => r.cpl === 0 && r.inbox === 0).length;
  console.log('不变量检查  :', bad === 0 ? '✅ inbox=0 的行 cpl 均为 null（不是 0）' : '❌ 有 ' + bad + ' 行 cpl 被写成 0');

  if (SELF) { console.log('（self-test：未联网、未落盘）'); process.exit(0); }
  if (DRY) { console.log('（--dry：未落盘）'); process.exit(emptyReason === '未登录' ? 2 : emptyReason === '限流' ? 3 : emptyReason ? 4 : 0); }
  if (!COMMIT) { console.log('（未加 --commit：未落盘。要落盘请加 --commit）'); process.exit(0); }

  // 【2026-11-09 修】未登录 / 限流 / 非预期 一律**不落盘**——0 行空文件会污染 index 与"新鲜度"统计。
  // 只有"接口空"（200 + 空数组）允许落一份 row_count=0 的快照，且 empty_reason 已写明。
  if (emptyReason && emptyReason !== '接口空') {
    console.log('⛔ 未落盘：' + emptyReason + '（登录态/限流/异常都不写空快照）');
    process.exit(emptyReason === '未登录' ? 2 : emptyReason === '限流' ? 3 : 4);
  }

  const out = writeOut(dateStr, slot, rows, meta, isPromote ? 'promote' : (isTrend ? 'trend' : null));
  console.log('✅ 已写:', path.relative(ROOT, out.file), ' sha256:', out.sha.slice(0, 16) + '…');
  process.exit(emptyReason === '未登录' ? 2 : emptyReason === '限流' ? 3 : emptyReason ? 4 : 0);
})();
