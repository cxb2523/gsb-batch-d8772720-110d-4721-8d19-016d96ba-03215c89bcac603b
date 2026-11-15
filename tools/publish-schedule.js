/**
 * tools/publish-schedule.js — 按【排期表】一小时发一条链接，并自动建好擦亮计划
 *
 * 老板 2026-10-10 原话：「明天继续上架南宁许嵩演唱会首开、贵阳王力宏演唱会首开、
 * 深圳王者荣耀共创之夜、三亚周杰伦、广州徐良各两个商品链接，现在一小时一小时上架一个链接，
 * 并开好计划，计划是从早上八点开始；超过八点发布的，隔半小时再开推广。」
 *
 * 排期表：publish-schedule.json（SSOT，10 个 slot = 5 场 × 2 条）
 * 触发  ：计划任务 XianyuPublishSchedule 每 15 分钟跑一次本脚本
 *
 * 本脚本只做一件事：把「到点了、还没做」的那一条做掉。没到点就什么都不做，直接退出 0。
 * 所以它既可以被计划任务反复调，也可以人手跑一次补发。
 *
 * ── 为什么发布用 publish-group.js 而不是自己写 ──
 * 发布路径（区分配 / 主图版式 / 标题模板 / 回读校验 / 写台账）全在 tools/publish-group.js 里，
 * 这里只负责「生成一条方案文件 → 交给它跑」，不复制任何发布逻辑。少一份逻辑就少一处分叉。
 *
 * ── 为什么发布后必须「先建计划再立刻暂停」──
 * 见 ad-pending.js 头注释的三个坑：① run-cfgs 建完平台就在跑；② 光暂停会被 ad-watch-stuck 复活；
 * ③ 进 AD-EXCLUDE 后必须 07:45 放行，否则 08:00 全店开启时它不会跟着开。
 * 分界点就是老板那句话：08:00 前的 → 进名单等 07:45 放行；08:00 后的 → 等 30 分钟自己开。
 *
 * 用法:
 *   node tools/publish-schedule.js                 # 执行所有到点的 slot（正常一次只到点一条）
 *   node tools/publish-schedule.js --dry           # 只打印当前到点 / 待办，不动手
 *   node tools/publish-schedule.js --slot 3        # 忽略时间，立刻做第 3 条
 *   node tools/publish-schedule.js --status        # 打印排期进度
 *   node tools/publish-schedule.js --release       # 07:45 用：把 08:00 前那几条从 AD-EXCLUDE 移出
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const mtop = require(path.join(ROOT, 'lib', 'mtop'));
const storeProfile = require(path.join(ROOT, 'lib', 'store-profile'));
const lock = require(path.join(ROOT, 'lib', 'browser-lock'));
const { STORE } = require(path.join(ROOT, 'lib', 'env'));

// 【2026-10-11 加·协作约定 §2.1】发布要驱动共用浏览器（8093），必须先拿实体锁 browser.lock。
// 本会话老板已点名为【工程】（2026-10-11）—— 锁里和台账里都署这个名。
const ROLE = process.env.DSH_SESSION_ROLE || '工程';

const SCHED = path.join(ROOT, 'publish-schedule.json');
const LEDGER = path.join(ROOT, '上架台账.json');
const EXCLUDE = path.join(ROOT, 'AD-EXCLUDE.json');
const PENDING_STATE = path.join(ROOT, 'ad-pending-state.json');
const GROUPS = path.join(ROOT, 'publish-groups');
const LOGF = path.join(ROOT, 'publish-schedule.log');

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const valOf = (f) => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : null; };

function log(m) {
  const l = '[' + new Date().toLocaleString('zh-CN') + '] ' + m;
  console.log(l);
  try { fs.appendFileSync(LOGF, l + '\n'); } catch (e) {}
}
/** 原子写：先写 .tmp 再 rename —— 断电/被杀时不会留下半截 JSON 把排期表毁掉 */
function writeJsonAtomic(p, obj) {
  const t = p + '.tmp';
  fs.writeFileSync(t, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(t, p);
}
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 ad-pending.js 的计划规格保持一致（咨询量 · 提升120% · 预算¥50 · 8:00-23:00） */
const SPEC = { target: 'chat', improvePct: 120, expectedBid: '2.5', budget: 50, startHour: 8, endHour: 22, submit: true };
/** 计划名：沿用平台现有命名习惯（澳门梓渝-咨询120）*/
const planNameOf = (slot) => slot.city + slot.star + '-咨询120' + (Number(slot.n) % 2 === 0 ? '-2' : '');

function nowHm() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
/** 本地日期。⚠️ 不能用 toISOString().slice(0,10) —— 那是 UTC，早上 08:00 前会写成前一天 */
function ymdLocal(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ── 排期表读写 ────────────────────────────────────────────────────────────
function loadSched() {
  const s = readJson(SCHED, null);
  if (!s || !Array.isArray(s.slots) || !s.slots.length) { log('❌ 读不到 publish-schedule.json 或 slots 为空'); process.exit(2); }
  return s;
}
function priceOf() {
  try {
    const P = storeProfile.load(STORE);
    const v = P && P.价格 && P.价格.default;
    if (v != null && v !== '') return String(v);
  } catch (e) {}
  return '50';
}

// ── 第 1 步：生成这一条的方案文件 ────────────────────────────────────────
function makePlanFile(slot) {
  const f = path.join(GROUPS, '_sched-' + (slot.date || ymdLocal()) + '-slot-' + slot.n + '.json');
  const plan = {
    _说明: '由 tools/publish-schedule.js 自动生成（排期表 publish-schedule.json 第 ' + slot.n + ' 条）。不要手改：改排期表。',
    _老板原话: '一小时一小时上架一个链接，并开好计划；超过八点发布的，隔半小时再开推广。',
    city: slot.city, star: slot.star, event: slot.event, session: slot.session,
    itemGapSec: 0,
    items: [{ seq: 1, tplId: slot.titleTplId, price: priceOf(), mainTpl: slot.mainTpl }],
  };
  writeJsonAtomic(f, plan);
  return f;
}

function runGroup(planFile, planOnly) {
  const args = [path.join(ROOT, 'tools', 'publish-group.js'), planFile];
  if (planOnly) args.push('--plan');
  // 【2026-10-11 加】台账署名交给 publish-one.js 在【写的时候】就带上（KUN_BY，【运营】16:55 加的）。
  //   publish-group.js 是 Object.assign(process.env, …) 传子进程，所以在这里显式塞一次就够。
  //   下面 stampLedger 的事后回填保留为兜底（只补不覆盖），两条路不打架。
  const r = spawnSync(process.execPath, args, {
    stdio: 'inherit', cwd: ROOT, timeout: planOnly ? 120000 : 1800000,
    env: Object.assign({}, process.env, { KUN_BY: ROLE }),
  });
  return r.status;
}

/** 从 publish-group 写下的结果文件里取这一条的 itemId（只认本方案文件的结果） */
function itemIdFromResult(planFile) {
  const base = path.basename(planFile).replace(/\.json$/, '');
  const cands = fs.readdirSync(ROOT).filter((f) => /^publish-group-result-\d+\.json$/.test(f)).map((f) => path.join(ROOT, f));
  cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const c of cands.slice(0, 6)) {
    const j = readJson(c, null);
    if (!j || !Array.isArray(j.results) || !j.results.length) continue;
    // 结果文件里 plan 字段写的是传入的方案路径
    if (String(j.plan || '').indexOf(base) < 0) continue;
    return { file: c, itemId: j.results[0].itemId || null, title: j.results[0].title || null, area: j.results[0].area || null };
  }
  return { file: null, itemId: null };
}

// ── 第 2 步：建擦亮计划 → 立刻暂停 → 按 08:00 分界决定「怎么开」 ─────────
async function buildAdPlan(slot, itemId) {
  const item = String(itemId);
  const existing = await mtop.adPlans();
  // normalizePlan 的 items 是「逗号连接的字符串」，不是数组 —— 别写成 .includes()
  const hasItem = (p) => String(p.items || '').split(',').map((s) => s.trim()).indexOf(item) >= 0;
  const same = existing.filter((p) => p.name === planNameOf(slot));
  if (same.length) {
    const p = same[0];
    if (hasItem(p)) { log('  ⏭ 计划「' + p.name + '」(' + p.id + ') 已经绑了这条宝贝，复用'); return { id: String(p.id), name: p.name }; }
    // 【2026-10-11 真实事故】原来这里直接跳过 → 新链接一条计划都没有，而且是静默的。
    //   三亚周杰伦第 1 条就踩了：09401580「三亚周杰伦-咨询120」是上一批留下的老计划，
    //   名字撞上 → 新链接没进任何计划，日志里只有一句 ⏭ 跳过，没人会注意到。
    //   现在改成：换个没被占用的名字单独建，宁可多一个计划，也不能让链接「裸奔」。
    log('  ⚠️ 计划名「' + p.name + '」已被老计划 ' + p.id + ' 占用，且里面没有这条宝贝 → 另起一个名字单独建');
  }
  let name = planNameOf(slot);
  if (existing.some((p) => p.name === name)) {
    const used = new Set(existing.map((p) => p.name));
    for (let k = 3; k <= 6; k++) { const cand = name + '-' + k; if (!used.has(cand)) { name = cand; break; } }
    if (existing.some((p) => p.name === name)) { log('  ❌ 连备用名字都被占满了，本条需要人工建计划（itemId ' + item + '）'); return { id: null }; }
  }
  const cfg = Object.assign({ searchKey: slot.star, items: [item], planName: name }, SPEC);
  const cf = path.join(ROOT, 'ad-pending-sched-' + slot.n + '.cfg.json');
  writeJsonAtomic(cf, [cfg]);
  log('  建计划「' + name + '」 宝贝 ' + itemId);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'run-cfgs.js')],
    { stdio: 'inherit', cwd: ROOT, env: Object.assign({}, process.env, { CFGS_JSON: cf, CFGS_LOG: path.join(ROOT, 'run-cfgs-log-sched.ndjson') }) });
  log('  run-cfgs 退出码 ' + r.status);

  await sleep(5000);
  const after = await mtop.adPlans();
  const p = after.find((x) => x.name === name);
  if (!p) { log('  ⚠️ 回读不到计划「' + name + '」—— 需要人工确认，未做暂停'); return { id: null }; }
  log('  回读: ' + p.id + ' 状态=' + p.verdictCn + ' 出价¥' + p.bidYuan + ' 预算¥' + p.budgetYuan + ' 宝贝 ' + p.itemCount + ' 条');
  if (p.itemCount === 0) log('  ⚠️ 计划里宝贝数为 0 —— 建计划时商品可能还没被广告库收录，需要人工补');
  const pr = await mtop.adPause([String(p.id)], { pauseStatus: 1 });
  log('  暂停平台返回: ' + (pr.ret || []).join(' | '));
  await sleep(8000);
  const chk = (await mtop.adPlans()).find((x) => String(x.id) === String(p.id));
  log('  暂停校验 ' + p.id + ' → ' + (chk ? chk.verdictCn : '(找不到)'));
  return { id: String(p.id), name };
}

/**
 * 台账记名（协作约定 §3：往 上架台账.json 追加行时带 by 字段）。
 *
 * 为什么不直接改 publish-one.js 写 by：那是【运营】领地的文件，我只在自己的脚本里补。
 * 改的是共享文件 → 读写要原子、只碰自己刚写的那一行（按 itemId 精确定位，且不覆盖已有的 by）。
 * 写坏台账比不署名严重得多，所以整段包在 try 里，失败只告警、绝不影响发布。
 */
function stampLedger(itemId, by) {
  try {
    const rows = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    let n = 0;
    rows.forEach((r) => { if (String(r.itemId) === String(itemId) && !r.by) { r.by = by; n++; } });
    if (!n) return 0;
    const tmp = LEDGER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');   // 与 publish-one.js 的写法保持一致，避免整文件重排
    fs.renameSync(tmp, LEDGER);
    return n;
  } catch (e) { log('  ⚠️ 台账补 by 失败（不影响发布）: ' + ((e && e.message) || e)); return 0; }
}

/** 08:00 前发的：暂停 + 进 AD-EXCLUDE（等 07:45 release） */function excludeFromWindow(id, name) {
  const ex = readJson(EXCLUDE, { ids: [] });
  ex.ids = ex.ids || [];
  if (!ex.ids.includes(id)) ex.ids.push(id);
  ex._计划明细 = ex._计划明细 || {};
  ex._计划明细[id] = name + ' · 2026-10-11 排期自动建（08:00 前发布）→ 建后即暂停并进本名单；07:45 由 publish-schedule.js --release 移出，08:00 随全店一起开。';
  writeJsonAtomic(EXCLUDE, ex);
  log('  已进 AD-EXCLUDE，当前名单 ' + ex.ids.length + ' 个');
  // 同时并进 ad-pending-state.json，让老的 ad-pending.js release 也能兜住（两条放行路径都通）
  const st = readJson(PENDING_STATE, { ids: [], plans: [] });
  st.ids = st.ids || [];
  if (!st.ids.includes(id)) st.ids.push(id);
  st.plans = st.plans || [];
  if (!st.plans.some((x) => String(x.id) === String(id))) st.plans.push({ id: String(id), name, source: 'publish-schedule' });
  writeJsonAtomic(PENDING_STATE, st);
}

// ── 模式 1：执行到点的 slot ──────────────────────────────────────────────
async function run() {
  const DRY = has('--dry');
  const FORCE = valOf('--slot');
  const sched = loadSched();
  const today = ymdLocal();
  const hm = nowHm();

  // 一条正在跑（status=running）不能被第二次触发重跑 —— 计划任务 15 分钟一次，
  // 而发布 + 建计划要 5~15 分钟，重叠了就发两条。running 超过 40 分钟视为「上次崩了」才允许重来。
  const RUNNING_TTL_MS = 40 * 60000;
  const stuck = (s) => s.status === 'running' && (!s.startedAt || Date.now() - Date.parse(s.startedAt) > RUNNING_TTL_MS);
  const due = sched.slots.filter((s) => {
    if (s.status === 'done') return false;
    if (FORCE) return String(s.n) === String(FORCE);
    if (s.status === 'running' && !stuck(s)) return false;
    return s.at <= hm;
  });

  if (!due.length) { log('没有到点的 slot（现在 ' + hm + '）'); return 0; }

  // 进程级锁：计划任务每 15 分钟一次，上一轮还没跑完就直接退出，绝不并发发两条
  const LOCK = path.join(ROOT, 'publish-schedule.lock');
  if (!FORCE && !DRY) {
    try {
      const lk = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (lk && lk.at && Date.now() - Date.parse(lk.at) < RUNNING_TTL_MS) {
        log('⏭ 上一轮还在跑（' + lk.at + ' 起的，pid ' + lk.pid + '），本轮不动手');
        return 0;
      }
    } catch (e) {}
    fs.writeFileSync(LOCK, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, slot: due[0].n }), 'utf8');
  }

  // 一次只做最早的一条：一小时一条是老板的硬要求，批量跑会把间隔吃掉
  const slot = due.sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  log('=== 到点：第 ' + slot.n + ' 条 ' + slot.at + ' ' + slot.city + slot.star + ' ' + slot.session + '（现在 ' + hm + '）===');
  if (DRY) { log('  --dry：只打印不执行。方案文件会写成：publish-groups/_sched-*-slot-' + slot.n + '.json'); return 0; }

  slot.date = today;
  slot.startedAt = new Date().toISOString();
  slot.status = 'running';
  writeJsonAtomic(SCHED, sched);

  // ① 生成方案文件 + 先 --plan 留证据（预览与真跑共用同一份 .run.json，所以预览=执行）
  const pf = makePlanFile(slot);
  log('  方案文件: ' + path.relative(ROOT, pf));
  runGroup(pf, true);
  log('  ── 以上是预览，以下真发 ──');
  // 【2026-10-11 加·协作约定 §2.1】发布驱动共用浏览器，必须先拿实体锁。
  // 别的会话正拿着就不抢 —— 本条退回 pending，下一轮（15 分钟后）再试；
  // 「一小时一条」的节奏允许这点抖动，比两条会话抢页面报 Execution context was destroyed 好。
  if (!lock.acquire(ROLE, 'publish-schedule 第 ' + slot.n + ' 条 ' + slot.city + slot.star)) {
    slot.status = 'pending';
    slot.note = '浏览器被别的会话占着（browser.lock），本轮让路，下轮再发';
    writeJsonAtomic(SCHED, sched);
    log('⏭ 浏览器锁被占 → 本轮让路，本条回到 pending');
    return 0;
  }
  let code;
  try { code = runGroup(pf, false); } finally { lock.release(); }
  if (code !== 0) {
    slot.status = 'failed';
    slot.failedAt = new Date().toISOString();
    slot.note = 'publish-group 退出码 ' + code;
    writeJsonAtomic(SCHED, sched);
    log('❌ 发布失败（退出码 ' + code + '），本条保持 failed，下次触发会重试');
    return 1;
  }

  const res = itemIdFromResult(pf);
  slot.itemId = res.itemId;
  slot.title = res.title;
  slot.area = res.area;
  slot.publishedAt = new Date().toISOString();
  log('  发布结果: itemId=' + (res.itemId || '❌ 空') + ' 标题=' + (res.title || ''));
  if (res.itemId && stampLedger(res.itemId, ROLE)) log('  台账已署名 by=' + ROLE);

  if (!res.itemId) {
    slot.status = 'published-no-id';
    slot.note = '发布脚本跑完但结果里没有 itemId，需要人工核对台账';
    writeJsonAtomic(SCHED, sched);
    log('⚠️ 没拿到 itemId → 不建计划（建了也不知道绑哪条），等人工处理');
    return 1;
  }

  // ② 建计划 → 暂停 → 按 08:00 分界决定放行方式
  let ad = { id: null };
  try {
    ad = await buildAdPlan(slot, res.itemId);
  } catch (e) {
    log('❌ 建计划/暂停抛错: ' + ((e && e.message) || e));
    slot.status = 'published-ad-failed';
    slot.note = '链接已发布（' + res.itemId + '）但计划没建好，必须人工补：' + ((e && e.message) || e);
    writeJsonAtomic(SCHED, sched);
    return 1;
  }
  slot.adPlanId = ad.id;
  slot.adPlanName = ad.name || planNameOf(slot);

  const beforeEight = String(slot.at) < '08:00';
  slot.openRule = beforeEight ? 'before08: 进 AD-EXCLUDE，07:45 放行，08:00 随全店开' : 'after08: 建后暂停，隔 30 分钟自动开';
  if (ad.id) {
    if (beforeEight) {
      excludeFromWindow(ad.id, slot.adPlanName);
      slot.adExcluded = true;
    } else {
      slot.openAt = new Date(Date.now() + 30 * 60000).toISOString();
      log('  本条 08:00 后发布 → 计划已暂停，' + new Date(Date.parse(slot.openAt)).toLocaleTimeString('zh-CN') + ' 自动开（隔 30 分钟）');
    }
  }

  slot.status = 'done';
  slot.doneAt = new Date().toISOString();
  writeJsonAtomic(SCHED, sched);
  log('✅ 第 ' + slot.n + ' 条完成: ' + slot.city + slot.star + ' https://www.goofish.com/item?id=' + res.itemId + ' 计划=' + (ad.id || '-'));
  return 0;
}

// ── 模式 2：到点把「08:00 前发布」的计划开起来（每 15 分钟顺带做） ────────
async function openDue(sched) {
  const due = sched.slots.filter((s) => s.openAt && !s.openedAt && Date.parse(s.openAt) <= Date.now() && s.adPlanId);
  if (!due.length) return 0;
  const ids = due.map((s) => String(s.adPlanId));
  log('=== 到点该开的计划（' + due.length + ' 个）: ' + ids.join(',') + ' ===');
  const r = await mtop.adPause(ids, { pauseStatus: 0 });
  log('  恢复平台返回: ' + (r.ret || []).join(' | '));
  await sleep(15000);
  let chk = await mtop.adPlans();
  // 【2026-10-11 加】恢复接口回 SUCCESS 但计划没起来是真实存在的（深圳王者荣耀第 2 条），
  //   原来的代码 5 秒后就下结论，只知道「还是暂停」，不知道【为什么】。
  //   现在：① 等 15 秒再判 ② 再试一次 ③ 把平台给的原因（statusDescTitle）写进日志和排期表。
  //   真实原因样本：「部分商品因状态异常无法擦亮」→ 对应 ad.item.searchV2 里该商品的 supportAd=false。
  for (const s of due) {
    let p = chk.find((x) => String(x.id) === String(s.adPlanId));
    if (p && p.verdictCn !== '投放中') {
      log('  第一次没起来（' + (p.statusDescTitle || p.verdictCn) + '）→ 15 秒后再试一次');
      await mtop.adPause([String(s.adPlanId)], { pauseStatus: 0 });
      await sleep(15000);
      chk = await mtop.adPlans();
      p = chk.find((x) => String(x.id) === String(s.adPlanId));
    }
    s.openTries = (s.openTries || 0) + 1;
    const okNow = p && p.verdictCn === '投放中';
    if (okNow) {
      s.openedAt = new Date().toISOString();
      s.openResult = '投放中';
      log('  ✅ ' + s.adPlanId + ' → 投放中');
    } else {
      const why = p ? (p.statusDescTitle || p.verdictCn) : '(找不到)';
      s.openResult = '未起来：' + why;
      // 前 2 次失败留给下一轮（15 分钟后再试，有些是平台侧延迟）；第 3 次才认账并写进表里
      if (s.openTries >= 3) { s.openedAt = new Date().toISOString(); s.openFailed = true; }
      log('  ⚠️ ' + s.adPlanId + ' 第 ' + s.openTries + ' 次仍未起来：' + why +
        (s.openTries >= 3 ? '（已试 3 次，不再自动重试，需人工处理）' : '（下轮再试）'));
    }
  }
  writeJsonAtomic(SCHED, sched);
  return 0;
}

// ── 模式 3：07:45 放行（把 08:00 前那几条从 AD-EXCLUDE 移出） ────────────
function release() {
  const sched = loadSched();
  // 只处理「还没放行过」的 —— 否则每 15 分钟都会打一行「已把 … 移出（12 → 12）」，
  // 数字没变却说「已移出」，日志读起来像在反复干活，实际什么都没做。
  const pend = sched.slots.filter((s) => s.adExcluded && s.adPlanId && !s.releasedAt);
  if (!pend.length) return 0;
  const ids = pend.map((s) => String(s.adPlanId));
  const ex = readJson(EXCLUDE, { ids: [] });
  const before = (ex.ids || []).length;
  ex.ids = (ex.ids || []).filter((id) => !ids.includes(String(id)));
  writeJsonAtomic(EXCLUDE, ex);
  log('已把 ' + ids.join(',') + ' 从 AD-EXCLUDE 移出（' + before + ' → ' + ex.ids.length + '）');
  log('它们仍是暂停态，08:00 的 ad-window --on 会把全店暂停计划一起开起来');
  pend.forEach((s) => { s.releasedAt = new Date().toISOString(); });
  writeJsonAtomic(SCHED, sched);
  return 0;
}

function status() {
  const sched = loadSched();
  log('排期进度（' + sched.slots.length + ' 条，现在 ' + nowHm() + '）');
  sched.slots.forEach((s) => {
    log('  ' + String(s.n).padStart(2) + '  ' + s.at + '  ' + (s.city + s.star).padEnd(12) +
      ' ' + String(s.status).padEnd(18) + ' itemId=' + (s.itemId || '-') +
      ' 计划=' + (s.adPlanId || '-') + (s.openAt ? ' 定开=' + new Date(Date.parse(s.openAt)).toLocaleTimeString('zh-CN') : '') +
      (s.openedAt ? ' 已开=' + s.openResult : (s.openAt ? '' : '')) + (s.openFailed ? ' ❌需人工' : '') + (s.note ? '  注:' + s.note : ''));
  });
  return 0;
}

(async () => {
  if (has('--status')) process.exit(status());
  if (has('--release')) process.exit(release());
  const code = await run();
  try { if (!has('--slot')) fs.unlinkSync(path.join(ROOT, 'publish-schedule.lock')); } catch (e) {}
  // 07:45 之后每轮都补一次放行 —— 防止「第 3 条 07:35 才开始跑，等它把计划写进 AD-EXCLUDE 时
  // 07:45 的 XianyuAdRelease 已经跑完」这种时序漏网（release 是幂等的，重复跑无害）
  if (nowHm() >= '07:45') { try { release(); } catch (e) { log('⚠️ 补放行失败: ' + ((e && e.message) || e)); } }
  // 跑完顺带处理「该开的计划」——15 分钟一次足够，不额外加计划任务
  try { await openDue(loadSched()); } catch (e) { log('⚠️ 自动开计划失败: ' + ((e && e.message) || e)); }
  process.exit(code);
})().catch((e) => { log('❌ 未捕获: ' + ((e && e.stack) || e)); process.exit(1); });
