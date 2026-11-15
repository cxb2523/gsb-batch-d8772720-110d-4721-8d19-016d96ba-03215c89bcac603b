/**
 * tools/run-batch.js — 一批「新增链接 + 定时开推广」的编排器
 *
 * 老板 2026-09-30 的要求：
 *   上架 3 组（成都宋雨琦音乐会 / 泉州徐良 / 广州周杰伦），每组再加 2 条链接 = 6 条
 *   每 5 分钟发一条
 *   每组的两条都上架后 10 分钟，开超级擦亮【咨询量】计划（出价 = 系统预估 × 120%，预算 ¥50）
 *
 * 为什么写成一条龙脚本而不是分几步手动：
 *   「上架后 10 分钟再开推广」是个【时序要求】，手动做要盯 40 分钟。
 *
 * 发布顺序刻意【轮转】：8-1 → 2-1 → 1-1 → 8-2 → 2-2 → 1-2
 *   这样三组在第二轮结束时【同时】齐活，只需等一次 10 分钟，然后开 3 个计划。
 *
 * 用法:
 *   node tools/run-batch.js --shows=1,2,8 --per=2 --gap=5 --promo-delay=10 --rate=120 --budget=50
 *   node tools/run-batch.js --build-only     # 只建任务，不发布
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const queue = require('../lib/queue');
const { ROOT, PATHS, readJSON } = require('../lib/env');
const { execFileSync } = require('child_process');

const A = require('../lib/args').parse();
const SHOWS = String(A.shows || '1,2,8').split(',').map(Number).filter((x) => !isNaN(x));
const PER = Number(A.per) > 0 ? Number(A.per) : 2;
const GAP_MIN = Number(A.gap) > 0 ? Number(A.gap) : 5;
const PROMO_DELAY_MIN = Number(A['promo-delay']) >= 0 ? Number(A['promo-delay']) : 10;
const RATE = Number(A.rate) > 0 ? Number(A.rate) : 120;
const BUDGET = Number(A.budget) > 0 ? Number(A.budget) : 50;
const BUILD_ONLY = !!A['build-only'];
const BATCH_TAG = String(A.tag || 'b2');        // 任务 id / 图名里的批次标记
const IMG_DIR = path.join(PATHS.images, queue.STORE) + '/';
const TMP = path.join(ROOT, '渲染确认');
const COVER_TPLS = ['xuliang-v1', 'tpl_redtext'];
const LOGF = path.join(ROOT, 'run-batch.log');

const NODE = process.execPath;
// 【2026-09-30 修】标题句式必须【按批次区分】。
// 事故：b2 批次沿用了和 b1 相同的两套模板 → 同场次出现【完全相同的标题】
//   （广州周杰伦 5 条、泉州徐良 4 条都成对重复；成都宋雨琦有一条直接没进在售，疑似被判重）。
// 原来只保证「同批次内两条不撞」，忘了「跨批次也不能撞」。
// 现在：批次号 b<N> 决定用哪两句（b1→0,1  b2→2,3  b3→4,5…），共 6 句可用。
const TITLE_TPL = [
  (c, s, e) => '【稳中代拍】' + c + s + e + '代拍 （可看评价） 全价位都能接！',
  (c, s, e) => '【必中代拍】' + c + s + e + '代拍 全价位都能接 秒付必中 高命中率',
  (c, s, e) => '【高命中代拍】' + s + c + '站' + e + '门票代拍帮抢 全价都能接',
  (c, s, e) => '【接代拍】' + s + c + '站' + e + '首开代抢 秒付前排 全价位都能接',
  (c, s, e) => '【代拍必中】' + c + s + e + '接代拍首开代抢' + s + e + '代抢秒付',
  (c, s, e) => '【稳中必中】' + s + e + c + '站代拍 战绩可查 全价位可接 秒付',
];
/** 按批次号取该批用的两句标题模板 */
function pickTitle(batchTag) {
  const n = parseInt(String(batchTag).replace(/\D/g, ''), 10) || 1;
  const base = ((n - 1) * 2) % TITLE_TPL.length;
  return TITLE_TPL[base];
}
function pickTitle2(batchTag) {
  const n = parseInt(String(batchTag).replace(/\D/g, ''), 10) || 1;
  const base = ((n - 1) * 2 + 1) % TITLE_TPL.length;
  return TITLE_TPL[base];
}

function say(m) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + m;
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOGF, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = readJSON(path.join(ROOT, 'shows.json'));
  const shows = SHOWS.map((no) => (cfg.shows || []).find((s) => s.no === no)).filter(Boolean);
  if (shows.length !== SHOWS.length) { out.bad('shows.json 里找不到场次：' + SHOWS.join(',')); out.done(2); }

  out.head('建批');
  out.kv('场次', shows.map((s) => s.city + s.star).join('、'));
  out.kv('每组条数', PER + ' 条（共 ' + (shows.length * PER) + ' 条）');
  out.kv('发布间隔', GAP_MIN + ' 分钟');
  out.kv('推广', '上架后 ' + PROMO_DELAY_MIN + ' 分钟 · 咨询量 · 出价 系统预估×' + RATE + '% · 预算 ¥' + BUDGET);

  // ── 1. 建任务（含出图）──
  const tasks = [];
  shows.forEach((s) => {
    const ev = s.eventType || '演唱会';
    for (let i = 0; i < PER; i++) {
      const tpl = COVER_TPLS[i % COVER_TPLS.length];
      const fn = s.city + s.star + '-' + BATCH_TAG + '-' + (i + 1) + '-' + tpl + '.jpg';
      tasks.push({
        id: 'show' + s.no + '_' + BATCH_TAG + '_' + (i + 1),
        city: s.city, star: s.star, eventType: ev, sessionType: i === 0 ? '首开' : '二开',
        categoryName: '代购', price: '50', stock: '9999',
        imageUrls: [fn], imageName: fn,
        store: queue.STORE,
        bidPrice: 2.6, maxDayBudget: 50, bidTarget: 'chat', campaignCount: 1,
        status: 'pending', priority: false, skipCampaign: true,
        subImg: true, specs: { enabled: false },
        subSet: (i === 0 ? '第二组副图' : '第一组副图'),
        directTitle: true,
        star_title: null,
        _tpl: tpl, _fn: fn, _cover: null,
      });
      tasks[tasks.length - 1].star = (i === 0 ? pickTitle(BATCH_TAG) : pickTitle2(BATCH_TAG))(s.city, s.star, ev);
    }
  });

  fs.mkdirSync(TMP, { recursive: true });
  let okC = 0;
  for (const t of tasks) {
    const spec = { city: t.city, star: t.city.slice(0, 0) + t._origStar || '', tpl: t._tpl, out: path.join(TMP, '_rb_' + t.id + '.jpg') };
    // 出图要用【明星名】而不是标题（t.star 现在已被替换成完整标题）
    const showObj = shows.find((s) => t.id.indexOf('show' + s.no + '_') === 0);
    spec.star = showObj.star;
    const specPath = path.join(TMP, '_rbspec_' + t.id + '.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
    try {
      const r = execFileSync(NODE, [path.join(ROOT, 'tools', 'make-cover.js'), '--spec=' + specPath],
        { encoding: 'utf8', timeout: 420000, maxBuffer: 8 * 1024 * 1024 });
      const line = (r.split('\n').find((l) => l.indexOf('{"ok"') >= 0) || '').trim();
      const j = JSON.parse(line);
      fs.copyFileSync(j.file, IMG_DIR + t._fn);
      t._cover = t._fn;
      okC++;
      say('  封面 OK  ' + t.id + '  ' + t._fn + '  文字层×' + j.layers);
    } catch (e) { say('  ❌ 封面失败 ' + t.id + '：' + (e.message || '').slice(0, 100)); }
  }
  out.kv('封面', okC + ' / ' + tasks.length);
  if (okC !== tasks.length) { out.bad('有封面没出成，中止（避免发出光底图）'); out.done(1); }

  // ── 2. 入队（走唯一写入口）──
  const clean = tasks.map((t) => { const c = Object.assign({}, t); delete c._tpl; delete c._fn; delete c._cover; delete c._origStar; return c; });
  const res = await queue.guardWrite(async (q) => {
    const ids = new Set((q.tasks || []).map((x) => String(x.id)));
    const add = clean.filter((t) => !ids.has(t.id));
    q.tasks = (q.tasks || []).filter((x) => !clean.some((c) => c.id === x.id)).concat(clean);
    return { added: add.length, replaced: clean.length - add.length };
  });
  out.kv('入队', JSON.stringify(res.result) + ' 核对=' + JSON.stringify(res.verify));
  if (!res.verify.ok) { out.bad('入队核对不通过'); out.done(1); }

  // ── 3. 轮转发布 ──
  if (BUILD_ONLY) { out.plain(''); out.ok('只建任务（--build-only），未发布'); out.done(0); }

  say('=== 开始发布，' + tasks.length + ' 条，每 ' + GAP_MIN + ' 分钟一条 ===');
  for (let round = 0; round < PER; round++) {
    for (const s of shows) {
      const t = tasks.find((x) => x.id === 'show' + s.no + '_' + BATCH_TAG + '_' + (round + 1));
      say('▶ 发布 ' + t.id + '  ' + t.star.slice(0, 30));
      try {
        const r = execFileSync(NODE, [path.join(ROOT, 'tools', 'fire-one-publish.js')],
          { encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
        const tail = r.split('\n').filter((l) => l.trim()).slice(-2).join(' | ');
        say('  ← ' + tail.slice(0, 160));
      } catch (e) { say('  ❌ 发布异常：' + (e.message || '').slice(0, 120)); }
      if (!(round === PER - 1 && s === shows[shows.length - 1])) await sleep(GAP_MIN * 60 * 1000);
    }
  }

  // ── 4. 上架后 N 分钟开推广 ──
  say('=== 发布阶段结束，等 ' + PROMO_DELAY_MIN + ' 分钟再开推广 ===');
  await sleep(PROMO_DELAY_MIN * 60 * 1000);
  for (const s of shows) {
    say('▶ 开推广 ' + s.city + s.star + '（咨询量 · ' + RATE + '% · ¥' + BUDGET + '）');
    try {
      const r = execFileSync(NODE, [path.join(ROOT, 'tools', 'open-chat-campaigns.js'),
        '--apply', '--rate=' + RATE, '--budget=' + BUDGET, '--only=' + s.no],
        { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
      say('  ← ' + r.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 200));
    } catch (e) { say('  ❌ 开推广异常：' + (e.message || '').slice(0, 150)); }
  }
  say('=== 全部完成 ===');
  out.ok('批次完成；日志见 run-batch.log');
  out.done(0);
})().catch((e) => { say('❌ 未捕获: ' + (e && e.stack || e)); out.done(1); });
