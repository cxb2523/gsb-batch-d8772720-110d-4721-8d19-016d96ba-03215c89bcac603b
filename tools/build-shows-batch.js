/**
 * tools/build-shows-batch.js — 把 shows.json 里「未上架」的场次建成 System B 的发布任务
 *
 * System B（唤醒发布链）说明：
 *   XianyuWakePublish 计划任务每 30 分钟唤醒电脑 → 页面里 window.kunPublish.runBatchPublish(1)
 *   → 发 1 条 → 回睡。用户在用电脑时该脚本会自动跳过（空闲 <300 秒）。
 *   任务队列落在 ~/.xianyu-daily-tasks-<店铺>.json，页面启动时 syncTasksFromDisk() 拉进去。
 *
 * 为什么不经 achun 的 publish-batch.js：老板要的是「间隔半小时 + 断点续传」，
 * 那正是唤醒发布链的行为（发 1 条回睡，明早开机自动接着发）。publish-batch.js 是一次性批处理。
 *
 * 关键安全点（读 publish.js 得出）：
 *   - runBatchPublish 只挑 status 不是 done/failed 且【没有 itemId】的任务 → 已发过的永不重发
 *   - skipCampaign = !autoPolish || campaignMode==='batch' → 由顶层 autoPolish 决定要不要建推广
 *   - 单任务推广参数取 task.bidPrice/bidTarget/campaignCount，所以推广内容完全可控
 *   - imageUrls 里的非 http 项当【文件名】，去 闲鱼上架图片/<店铺>/ 找
 *
 * 用法:
 *   node tools/build-shows-batch.js --dry     # 预览：只出图、只打印，不写队列
 *   node tools/build-shows-batch.js           # 出图 + 写入队列
 *   node tools/build-shows-batch.js --no-covers   # 跳过出图（图已存在时）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const out = require('../lib/out');
const http = require('../lib/http');
const queue = require('../lib/queue');
const { ROOT, PATHS, readJSON, STORE } = require('../lib/env');

const a = require('../lib/args').parse();
const DRY = !!a.dry;
const SKIP_COVERS = !!a['no-covers'];

const SHOWS_FILE = path.join(ROOT, 'shows.json');
const IMG_FOLDER = path.join(PATHS.images, STORE) + '/';
const ONLY = a.only ? String(a.only).split(',').map((x) => Number(x.trim())) : null;

/** 出图是分钟级的长任务，必须实时打屏（out 是缓冲到最后才吐的，看不到进度） */
function say(s) { process.stdout.write(s + '\n'); }

// 每个场次两条链接：用不同的【主图模板】+ 不同的【场次类型】区分，标题不会撞
const COVER_TPLS = ['xuliang-v1', 'tpl_redtext'];
const SESSIONS = ['首开', '二开'];

// 场次语义（标题要用）。eventType 按老板原话区分「演唱会 / 音乐会 / 见面会」
const SHOW_META = {
  4: { eventType: '演唱会', sessions: ['首开', '二开'] },
  5: { eventType: '演唱会', sessions: ['二开', '三开'] },   // 佛山那英「二开」
  6: { eventType: '演唱会', sessions: ['首开', '二开'] },
  7: { eventType: '演唱会', sessions: ['首开', '二开'] },
  8: { eventType: '音乐会', sessions: ['首开', '二开'] },   // 音乐分享会
  9: { eventType: '见面会', sessions: ['首开', '二开'] },   // 见面会
};

/** 出图文件名（唯一来源，出图与核对都用它） */
function coverName(show, idx, tplKey) {
  return show.city + show.star + '-' + (idx + 1) + '-' + tplKey + '.jpg';
}

/** 出图并落盘到店铺图片目录，返回文件名。
 *  2026-09-29 事故：这里原来只调 /api/poster/make 拿【底图】就落盘，没叠模板文字层
 *  → 12 条商品封面全是光底图。现在改为调 tools/make-cover.js（底图 + 文字层一步到位）。
 *  AI 兜底出图（大麦无在架站时）要 60 秒且会被打断，所以带重试。 */
async function makeCover(show, idx, tplKey, tries) {
  const fn = coverName(show, idx, tplKey);
  const full = IMG_FOLDER + fn;
  if (SKIP_COVERS && fs.existsSync(full)) return { fn, skipped: true };

  tries = tries || 3;
  let lastErr = '';
  for (let attempt = 1; attempt <= tries; attempt++) {
    // 临时 spec 是运行期产物：中文参数走文件，命令行只传文件名（PowerShell 会吃中文）
    const specPath = path.join(os.tmpdir(), '_cover_spec_' + Date.now() + '_' + idx + '_' + tplKey + '.json');
    const tmpOut = path.join(os.tmpdir(), '_cover_out_' + Date.now() + '_' + idx + '_' + tplKey + '.jpg');
    try {
      fs.writeFileSync(specPath, JSON.stringify({ city: show.city, star: show.star, tpl: tplKey, out: tmpOut }, null, 2), 'utf8');
      const r = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-cover.js'), '--spec=' + specPath],
        { encoding: 'utf8', timeout: 420000, maxBuffer: 8 * 1024 * 1024 });
      // make-cover.js 成功时 stdout 最后一行是 {"ok":true,"file":"...","layers":N}
      const line = (String(r).split('\n').filter((l) => l.indexOf('{"ok"') >= 0).pop() || '').trim();
      const j = line ? JSON.parse(line) : null;
      if (!j || !j.ok || !j.file) throw new Error('make-cover 没返回文件：' + line);
      fs.mkdirSync(IMG_FOLDER, { recursive: true });
      fs.copyFileSync(j.file, full);
      return { fn, kb: Math.round(fs.statSync(full).size / 1024),
        base: (j.format || '?') + ' 文字层×' + (j.layers || 0), attempt };
    } catch (e) {
      lastErr = e.message;
      if (attempt < tries) say('    ↻ 第 ' + attempt + ' 次失败（' + lastErr.slice(0, 60) + '），2 秒后重试');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(lastErr);
}

/** System B 的标题渲染（复刻 renderConcertTitle + fitTitle，用于预览与查重） */
const SB_TPL = {
  1: '【{场次类型}代拍】{城市}{明星}{活动类型}接代拍{场次类型}代抢',
  2: '【代拍必中】{城市}{明星}{活动类型}接代拍{场次类型}代抢秒付必中',
};
const PAD = [' 全站全价位都可接', ' 全价位都能接', ' 高命中率', ' 全价位接', ' 可上号', ' 秒付前排', ' 稳中', ' 秒付', '包中'];
function fitTitle(t) {
  if (t.length > 40) return t.slice(0, 40);
  if (t.length < 30) {
    const gap = 30 - t.length;
    let best = '';
    for (const f of PAD) if (f.length <= gap && f.length > best.length) best = f;
    t += best;
    while (t.length < 30) t += '！';
  }
  return t;
}
function renderTitle(tplId, show, ev, sess) {
  const raw = SB_TPL[tplId].replace(/\{明星\}/g, show.star).replace(/\{城市\}/g, show.city)
    .replace(/\{场次类型\}/g, sess).replace(/\{活动类型\}/g, ev);
  return fitTitle(raw);
}

(async () => {
  const cfg = readJSON(SHOWS_FILE);
  if (!cfg) { out.bad('读不到 ' + SHOWS_FILE); out.done(2); }
  // 只建清单里【未上架】的（shows.json 的 no 4..9 是这次要补的）
  const shows = cfg.shows.filter((s) => SHOW_META[s.no] && (!ONLY || ONLY.indexOf(s.no) >= 0));
  if (!shows.length) { out.bad('shows.json 里没有可建批的场次（需要 no 4..9）'); out.done(2); }

  const TPL_ID = 1;   // System B 顶层 templateId，全局一个
  out.head('建批 · ' + STORE);
  out.kv('场次', shows.length + ' 个 × 2 条 = ' + (shows.length * 2) + ' 条链接');
  out.kv('标题模板', 'System B templateId=' + TPL_ID + '（全局，两条用不同「场次类型」区分）');
  out.kv('主图模板', COVER_TPLS.join(' / '));
  out.kv('模式', DRY ? 'DRY（只出图，不写队列）' : '写入队列');
  out.kv('图片目录', IMG_FOLDER);

  // ── 1. 出图 ──
  out.head('出图');
  const covers = [];
  if (!SKIP_COVERS) {
    for (const s of shows) {
      for (let i = 0; i < 2; i++) {
        const tpl = COVER_TPLS[i % COVER_TPLS.length];
        const t0 = Date.now();
        say('  … ' + s.label + ' #' + (i + 1) + ' (' + tpl + ') 出图中');
        try {
          const c = await makeCover(s, i, tpl);
          covers.push(Object.assign({ no: s.no, idx: i }, c));
          say('  ✅ ' + c.fn + (c.kb ? '  ' + c.kb + 'KB  ' + c.base : '  (已存在，跳过)') +
            '  ' + Math.round((Date.now() - t0) / 1000) + 's');
        } catch (e) {
          out.bad('  ❌ ' + s.label + ' #' + (i + 1) + '  ' + e.message);
          say('  ❌ ' + s.label + ' #' + (i + 1) + '  ' + e.message);
          covers.push({ no: s.no, idx: i, error: e.message });
        }
      }
    }
  } else {
    // --no-covers：不重新出图，但必须逐个核对文件确实存在，否则任务会因无图失败
    out.kv('跳过出图', '--no-covers，改为核对已有文件');
    for (const s of shows) {
      for (let i = 0; i < 2; i++) {
        const tpl = COVER_TPLS[i % COVER_TPLS.length];
        const fn = coverName(s, i, tpl);
        const full = IMG_FOLDER + fn;
        if (fs.existsSync(full)) {
          const kb = Math.round(fs.statSync(full).size / 1024);
          covers.push({ no: s.no, idx: i, fn, kb, skipped: true });
          say('  ✅ ' + fn + '  ' + kb + 'KB  (复用)');
        } else {
          covers.push({ no: s.no, idx: i, error: '缺图 ' + fn });
          say('  ❌ 缺图 ' + fn);
        }
      }
    }
  }

  const coverFail = covers.filter((c) => c.error);
  if (coverFail.length) {
    out.head('中止');
    out.bad('有 ' + coverFail.length + ' 张图没出成，不写队列（避免任务因无图失败）');
    out.done(1);
  }

  // ── 2. 组装任务 ──
  const tasks = [];
  shows.forEach((s) => {
    const meta = SHOW_META[s.no];
    for (let i = 0; i < 2; i++) {
      const cov = covers.find((c) => c.no === s.no && c.idx === i);
      const sess = meta.sessions[i % meta.sessions.length];
      const title = renderTitle(TPL_ID, s, meta.eventType, sess);
      tasks.push({
        // id 必须稳定（不含时间戳），否则重跑一次就会插一批重复任务
        id: 'show' + s.no + '_' + (i + 1),
        star: s.star, city: s.city,
        eventType: meta.eventType, sessionType: sess,
        categoryName: '代购', price: '50', stock: '9999',
        imageUrls: [cov.fn], imageName: cov.fn,
        store: STORE,
        // 推广参数：即使以后打开 autoPolish，也只会建【咨询量 @ ¥2.6 / ¥50】这一个安全计划
        bidPrice: 2.6, maxDayBudget: 50, bidTarget: 'chat', campaignCount: 1,
        status: 'pending', priority: false, skipCampaign: true,
        _预览标题: title,
      });
    }
  });

  out.head('任务预览');
  out.table(['序', '场次', '场次类型', '标题（=实际会发的）', '主图'],
    tasks.map((t, i) => [i + 1, t.city + t.star, t.sessionType, t._预览标题, t.imageUrls[0]]),
    { maxCol: [3, 14, 8, 48, 26] });

  const titles = tasks.map((t) => t._预览标题);
  const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
  if (dup.length) out.warn('标题重复：' + [...new Set(dup)].join('、'));
  else out.ok('12 条标题互不重复');

  if (DRY) { out.plain(''); out.kv('DRY', '未写队列'); out.done(0); }

  // ── 3. 合并进队列（保留旧的已完成记录，只追加） ──
  const DEF_Q = { templateId: TPL_ID, imageUrl: '', publishInterval: 30, batchSize: 0, batchInterval: 30,
    autoPolish: false, confirmMode: false, campaignMode: 'single', tasks: [] };
  // 队列文件不存在时先建骨架：原来靠 try/catch 兜「新文件」，现在 guardWrite 走 readQueue
  //（缺文件会抛错），所以显式建一次。
  if (!fs.existsSync(queue.QUEUE)) queue.writeQueue(DEF_Q);

  // 走统一写入口：暂停发布链 → 读 → 改 → 写盘（带备份）→ 推页面 → 回读核对 → 恢复发布链
  const res = await queue.guardWrite(async (q) => {
  // 原来靠 Object.assign(默认值, 读到的) 补齐缺的键，这里等价地补一遍
  for (const k of Object.keys(DEF_Q)) if (q[k] === undefined) q[k] = DEF_Q[k];

  // 顶层：只上架、不自动建推广（老板批准后再打开）。间隔 30 分钟。
  q.autoPolish = false;
  q.publishInterval = 30;
  q.batchInterval = 30;
  q.batchSize = 0;
  q.templateId = TPL_ID;

  const oldTasks = Array.isArray(q.tasks) ? q.tasks : [];
  // 【2026-09-30 修】去重键从「语义键 city|star|sessionType」改成【稳定的任务 id】。
  // 原因（真实事故）：fix-shows-titles.js 会把 t.star 改写成【完整标题】（directTitle 模式），
  // 语义键随之改变 → 本脚本再跑时把同一任务当成新的 → 追加出一条重复任务。
  // （队列里反复出现的 show9_1/show9_2 重复就是这么来的。）
  // 任务 id（show4_2 / show9_1 …）由本脚本自己生成、之后任何工具都不会改，才是可靠的身份。
  const keyOf = (t) => String(t.id || '');
  const oldKeys = new Set(oldTasks.map(keyOf));
  const added = tasks.filter((t) => !oldKeys.has(keyOf(t)));
  const clean = added.map((t) => { const c = Object.assign({}, t); delete c._预览标题; return c; });
  if (!added.length) out.kv('去重', '这些任务已在队列里，不重复添加');

  // 身份替换：把旧的同 id 任务用新的覆盖，避免一队列两份
  const newKeys = new Set(tasks.map(keyOf));
  const kept = oldTasks.filter((t) => !newKeys.has(keyOf(t)));

  q.tasks = kept.concat(tasks.map((t) => { const c = Object.assign({}, t); delete c._预览标题; return c; }));
  return { added: clean.length, tasks: q.tasks, autoPolish: q.autoPolish, interval: q.publishInterval };
  });

  const v = res.verify;
  out.head('写入完成');
  out.ok('新增任务 ' + res.result.added + ' 条；队列共 ' + v.diskTasks + ' 条');
  out.kv('待发布（runBatchPublish 会挑的）', v.pending + ' 条');
  out.kv('autoPolish', String(res.result.autoPolish) + '（false = 只上架，不自动开推广）');
  out.kv('间隔', res.result.interval + ' 分钟（由 XianyuWakePublish 每 30 分钟唤醒驱动，1 轮 1 条）');
  out.kv('队列文件', queue.QUEUE);
  out.kv('写后核对', '磁盘 ' + v.diskTasks + ' 条 / 页面 ' + v.pageTasks + ' 条，重复 ' + v.dup +
    (v.ok ? '  ✅ 一致' : '  ❌ 不一致'));

  out.full(res.result.tasks, 'shows-tasks');
  out.done(0);
})().catch((e) => out.fail(e));
