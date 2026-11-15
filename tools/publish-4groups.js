/**
 * tools/publish-4groups.js —— 按【组】定时发布 + 定时开推广
 *
 * 老板 2026-10-13 的要求：
 *   「上架北京宋雨琦音乐会2个链接，间隔5分钟，并10分钟后一起开推广；
 *     上海宋雨琦、北京王一珩、深圳王一珩同上；每组的间隔是2小时；推广时间设置8~23点。」
 *
 * 排期表：publish-groups/_4groups-timed.json（4 组，08:00 / 10:00 / 12:00 / 14:00）
 * 触发  ：计划任务 XianyuPublish4Groups 每 5 分钟跑一次本脚本
 * 本脚本只做「到点了、还没做」的那一件，没到点就退出 0。所以既能被计划任务反复调，
 * 也能人手跑一次补做。
 *
 * ── 为什么不用 tools/publish-schedule.js（【工程】的）────────────────
 * 那个是「一条链接一个 slot + 15 分钟轮询」的形态，**做不到组内两条间隔 5 分钟**
 * （15 分钟轮询下第二条会晚 15 分钟）。本需求的最小单位是**一组 = 2 条链接**，
 * 正好是 tools/publish-group.js 的形态：它的 itemGapSec=300 就是组内 5 分钟，
 * 一次调用把两条发完。**是两种不同的排期形态，不是多抄一份逻辑。**
 *
 * ── 依赖的既有工具（不复制它们任何逻辑）──────────────────────────
 *   tools/publish-group.js  发布（区分配/主图版式/标题/回读校验/写台账）→ 输出
 *                           publish-group-result-<ts>.json（里面的 itemId 就是我们要的）
 *   tools/ad-plan-create.js 建擦亮计划（我 2026-10-13 用它建过 WUUHAA 和三亚那两条）
 *   tools/ad-power.js       开/停计划
 *   lib/browser-lock.js     浏览器互斥（发布要导航，必须持锁）
 *
 * ── 🔴 夜间护栏（本脚本自己加，别删）──────────────────────────────
 * 老板 2026-10-12 定「11点到8点这段时间停止活动」。但**我们的发布脚本里没有
 * PAUSE-PUBLISH 检查**（只有 lib/queue.js 提到它）→ 夜间隔音挡不住我们自己这条链路。
 * 所以本脚本直接拒绝在 23:00-08:00 之间发布。
 *
 * 用法:
 *   node tools/publish-4groups.js --status     # 打印进度
 *   node tools/publish-4groups.js --dry        # 只说到点该做什么，不动手
 *   node tools/publish-4groups.js              # 做所有到点的事（计划任务用的就是这个）
 *   node tools/publish-4groups.js --force=1    # 忽略时间，立刻做第 1 组
 *   node tools/publish-4groups.js --retry=N    # 原因修好后，把第 N 组的失败计数清零重来
 *   node tools/publish-4groups.js --force-night # 越过夜间禁发（默认永远拦，用了会留痕）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHED = path.join(ROOT, 'publish-groups', '_4groups-timed.json');
const LOCK = path.join(ROOT, 'publish-4groups.lock');
const LOG = path.join(ROOT, 'publish-4groups.log');
const NIGHT_FROM = 23, NIGHT_TO = 8;      // 老板定的夜间禁发（左闭右开）

const argv = process.argv.slice(2);
const STATUS = argv.includes('--status');
const DRY = argv.includes('--dry');
const FORCE = Number(((argv.find((a) => a.startsWith('--force=')) || '').split('=')[1]) || 0);
const RETRY = Number(((argv.find((a) => a.startsWith('--retry=')) || '').split('=')[1]) || 0);

const log = (m) => {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch (e) { /* 日志写不了不致命 */ }
};
const read = () => { let s = fs.readFileSync(SCHED, 'utf8'); if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); return JSON.parse(s); };
const save = (j) => fs.writeFileSync(SCHED, JSON.stringify(j, null, 2), 'utf8');
const hm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const isNight = (d) => { const h = d.getHours(); return h >= NIGHT_FROM || h < NIGHT_TO; };

/** 跑一个子命令，输出同时进日志。返回 { code, out } */
function run(args, label) {
  log('  ▶ ' + label);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  out.split('\n').filter((l) => l.trim()).slice(-14).forEach((l) => log('    | ' + l.trim().slice(0, 160)));
  return { code: r.status, out };
}

/** 取最近一次 publish-group 的产物里、本次运行之后生成的 itemId */
function newItemIds(sinceMs) {
  const cands = fs.readdirSync(ROOT)
    .filter((f) => /^publish-group-result-\d+\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .filter((x) => x.t >= sinceMs - 2000)
    .sort((a, b) => b.t - a.t);
  if (!cands.length) return { ids: [], file: '' };
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, cands[0].f), 'utf8'));
  return { ids: (j.results || []).filter((r) => r.ok && r.itemId).map((r) => String(r.itemId)), file: cands[0].f };
}

(async () => {
  const s = read();
  const now = new Date();
  const groups = s.groups || [];

  if (STATUS) {
    console.log('排期表: publish-groups/_4groups-timed.json');
    console.log('现在  : ' + now.toLocaleString('zh-CN', { hour12: false }) + (isNight(now) ? '（夜间禁发区间）' : ''));
    console.log('');
    groups.forEach((g) => {
      console.log('  第' + g.n + '组 ' + g.at + '  ' + g.plan.split('/').pop().replace('.json', ''));
      console.log('    状态=' + g.status + '  发布=' + (g.publishedAt || '-') +
        '  宝贝=' + ((g.itemIds || []).join(',') || '-') +
        '  计划=' + (g.planId || '-') + '  开推广=' + (g.openedAt || (g.adAt ? ('待 ' + g.adAt) : '-')));
    });
    return;
  }

  // ① 补做：已经建了计划但还没开的（幂等；万一上次那"睡到 10 分钟"被打断）
  for (const g of groups) {
    if (g.planId && !g.openedAt && g.adAt && new Date(g.adAt) <= now) {
      if (DRY) { log('（预演）该开推广：第' + g.n + '组 计划 ' + g.planId); continue; }
      run(['tools/ad-power.js', 'on', String(g.planId)], '开推广 第' + g.n + '组 ' + g.planId);
      g.openedAt = now.toISOString(); g.status = 'done';
      save(s);
      log('  ✅ 第' + g.n + '组 开推广已下发（新计划通常先落 statusDescCode=16，由 ad-watch-stuck 兜底）');
    }
  }

  // ② 该发布的那一组
  const due = groups.filter((g) => !g.publishedAt && (FORCE === g.n || (!FORCE && hm(now) >= g.at)));
  // 【2026-10-14 02:3x】原来这里是 `if (FORCE || STATUS)` —— 漏了 DRY，
  //   结果 `--dry` 在没到点时会**一声不吭地退出**（日志里什么都看不到）。
  //   预演的价值就在于"它得说话"：不说话的预演等于没预演。
  if (!due.length) {
    if (FORCE || STATUS || DRY) {
      const nx = groups.filter((x) => !x.publishedAt).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
      log('没有到点的组（现在 ' + hm(now) + '）' + (nx ? '；下一组：第' + nx.n + '组 ' + nx.at + '  ' + nx.plan.split('/').pop() : '；全部已完成'));
    }
    return;
  }
  const g = due.sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];

  // 【2026-10-14 02:3x 修·我自己的 bug】原来写的是 `if (!FORCE && isNight(now))`，
  //   意思是"用了 --force 就跳过夜间护栏"—— 结果我实测 --force=1 时**真的在 02:28 发出了一条**。
  //   护栏不该能被"到点判定"的开关顺带绕掉：--force 只该忽略【到点没到点】，
  //   夜间禁发必须单独用一个明确的开关才能越过（默认永远拦）。
  if (isNight(now) && !argv.includes('--force-night')) {
    log('⛔ 第' + g.n + '组到点了，但现在是 ' + hm(now) + '，落在夜间禁发区间（' + NIGHT_FROM + ':00-' + NIGHT_TO + ':00）→ 跳过。');
    log('   （这条护栏是本脚本自己加的：我们的发布脚本里没有 PAUSE-PUBLISH 检查，夜间隔音挡不住它。）');
    log('   确实要在夜里发，才用 --force-night（会写进日志，留痕）。');
    return;
  }
  if (DRY) { log('（预演）该发布：第' + g.n + '组 ' + g.at + '  ' + g.plan); return; }

  // ── 🔴 重试退避与上限（2026-10-14 12:0x 加 · 血的教训）────────────────────
  // 事故：08:00 那组因为「店铺未就绪」一直失败。而失败组的 publishedAt 永远是 null，
  //   `hm(now) >= g.at` 就永远成立 → **每 5 分钟重试一次，从 08:00 一直撞到 12:00**（约 48 轮）。
  //   每轮都要开浏览器、往闲鱼图床传 9 张图 → 把图床和 mtop 一起打爆，
  //   连老板都察觉"网是不是坏了"。
  //   一个"到点没做成"的任务，重试**必须有上限、有退避** —— 否则它不是排期，是压测工具。
  const MAX_TRY = 3;
  if (RETRY === g.n) {                       // 人工确认原因已修好后，用它重置计数
    log('（--retry=' + g.n + '）把第' + g.n + '组的重试计数清零，重新开始');
    g.tries = 0; delete g.lastTryAt; save(s);
  }
  const tries = g.tries || 0;
  if (tries >= MAX_TRY) {
    log('⛔ 第' + g.n + '组已失败 ' + tries + ' 次（上限 ' + MAX_TRY + '）→ 不再自动重试，等人工处理。');
    log('   原因修好后再跑：node tools/publish-4groups.js --retry=' + g.n);
    return;
  }
  if (g.lastTryAt) {
    const backoffMin = Math.min(60, 5 * Math.pow(2, tries));   // 失败1次→10分, 2次→20分, 3次→上限
    const waitMs = backoffMin * 60000 - (now.getTime() - Date.parse(g.lastTryAt));
    if (waitMs > 0) {
      log('第' + g.n + '组上次失败于 ' + g.lastTryAt + '，退避中（还剩约 ' +
        Math.ceil(waitMs / 60000) + ' 分钟，已失败 ' + tries + '/' + MAX_TRY + ' 次）→ 本轮跳过');
      return;
    }
  }

  // 防止与上一次运行叠加（发布一条要几分钟）
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 25 * 60 * 1000) { log('上一轮还在跑（' + Math.round(age / 1000) + 's），本轮跳过'); return; }
    log('发现超过 25 分钟的旧锁，抢占');
  }
  fs.writeFileSync(LOCK, JSON.stringify({ at: now.toISOString(), group: g.n }), 'utf8');
  const t0 = Date.now();
  // 先把"这一次尝试"记下来。为什么写在 try 之前：万一进程被掐死/断电，计数也已经落盘，
  //   下次不会当成"从没试过"再撞一遍（这正是 08:00→12:00 连撞 48 轮的帮凶）。
  g.tries = tries + 1;
  g.lastTryAt = now.toISOString();
  save(s);
  try {
    log('=== 第' + g.n + '组 开始 ' + g.at + ' → ' + g.plan + '（组内两条间隔 5 分钟，预计 6-10 分钟）===');

    // 持浏览器锁（发布要导航；就绪检查与查重也都走浏览器，所以一起放进锁里）
    run(['lib/browser-lock.js', 'acquire', '运营', 'publish-4groups 第' + g.n + '组'], '拿浏览器锁');
    try {
      // ── ⓪ 先确保店铺页就绪（2026-10-14 12:0x 加 · 这才是 08:00 全败的真因）──────
      // 真因：店铺页 context 被回收后（机器睡过一觉 / 浏览器长时间闲置），
      //   mtop 报「店铺「好易美代拍」未就绪」、图床报「图床返回异常(HTTP 200)」——
      //   **两个错是同一个根**：拿一个已经没有会话的 context 去干活。
      //   tools/ensure-agent.js 的 ready() 就是专门修这个的（它为 ad-watch-stuck 而写）。
      //   ⚠️ 少了这一步，本脚本在"夜间闲置后"几乎必然全败 —— 08:00 正是这个场景。
      const ens = run(['tools/ensure-agent.js'], '确保店铺页就绪（context 被回收就重建）');
      if (ens.code !== 0) {
        log('⛔ 店铺页起不来（ensure-agent 退出 ' + ens.code + '）→ **本轮不发布**，不拿残缺页面硬干。');
        throw new Error('店铺未就绪');
      }

      // ── ① 发布前查重（仓库硬规矩；2026-10-14 加，因为我自己踩了）──────────
      // 事故：2026-10-14 02:28 我用 --force 测夜间护栏时，护栏被 `!FORCE` 顺带绕掉，
      //   真的发出去了 1 条（1089720043648）。所以发布前必须先扫一遍货架。
      // 判据只看【在售(status=0)】：别的状态（1=已下架、-9=已删除/审核未过）都不算重复。
      const planJson = JSON.parse(fs.readFileSync(path.join(ROOT, g.plan), 'utf8'));
      const star = planJson.star;
      const city = planJson.city;
      const chk = run(['tools/list-onsale.js', star], '发布前查重（同明星+同城市是否已有在售）: ' + city + star);
      const cm = chk.out.match(/在售\s*(\d+)\s*条/);
      // 【2026-10-14 12:0x 修 · 严重】原来写成 `if (cm && Number(cm[1]) > 0)` ——
      //   查重脚本自己崩了（店铺未就绪）时 cm 是 null，于是**跳过整个判断，还打印"✅ 查重通过"**。
      //   08:00-12:00 那 48 轮就是这么过去的：日志里"未就绪"和"✅ 查重通过"紧挨着，是句谎话。
      //   一个查不动的护栏必须**拦**：查重失败 = 不知道有没有重复 = 不能发。
      if (!cm) {
        log('⛔ 查重脚本没给出「在售 N 条」（多半是店铺未就绪/被限流）→ **拒绝发布**。');
        log('   查重的意义就是"不确定时不发"。查不动 ≠ 没有重复。');
        throw new Error('查重结果读不到');
      }
      // 【2026-10-14 12:1x 修 · 会自己绊自己】原来只按【明星】判：第 1 组发出「北京宋雨琦」后，
      //   第 2 组（上海宋雨琦）一查"宋雨琦在售 2 条"就被自己的队友挡下；王一珩那两组同理。
      //   判据要收到【明星 + 城市】—— 四组就是 2 城 × 2 星，城市才是区分同场次的那个维度。
      //   解析 list-onsale 的 🟢在售 行（格式：`  🟢在售   <itemId>  <标题>`），只看标题里带本城市的。
      const onSaleLines = [];
      const re = /🟢在售\s+(\d+)\s+(.+)/g;
      let mm;
      while ((mm = re.exec(chk.out)) !== null) onSaleLines.push({ id: mm[1], title: mm[2].trim() });
      const sameCity = onSaleLines.filter((x) => x.title.indexOf(city) >= 0);
      if (sameCity.length) {
        log('⛔ 已有 ' + sameCity.length + ' 条「' + city + '·' + star + '」在售 → **拒绝发布**（防止同一场次重复铺货）：');
        sameCity.forEach((x) => log('     ' + x.id + '  ' + x.title));
        log('   先人工确认那几条是什么、要不要下架，再重跑本组。');
        throw new Error('发布前查重不通过');
      }
      log('  ✅ 查重通过：没有「' + city + '·' + star + '」在售' +
        (onSaleLines.length ? '（同明星别城在售 ' + onSaleLines.length + ' 条，不算重复）' : ''));

      const pub = run(['tools/publish-group.js', g.plan], '发布 第' + g.n + '组');
      if (pub.code !== 0) { log('  ❌ 发布返回非 0（' + pub.code + '）—— 记下来人工看，本轮不再往下走'); throw new Error('发布失败'); }

      const { ids, file } = newItemIds(t0);
      if (ids.length !== 2) { log('  ⚠️ 只取到 ' + ids.length + ' 个 itemId（产物 ' + file + '）—— 建计划要求正好 2 条，故停下人工确认'); throw new Error('itemId 数不对'); }
      g.itemIds = ids;
      g.publishedAt = new Date().toISOString();
      g.status = 'published';
      save(s);
      log('  ✅ 第' + g.n + '组 两条已发布: ' + ids.join(', '));

      // 【2026-10-14 12:4x 加】只上架、不建推广的组：方案里不给 adName 就走这里。
      //   为什么需要：老板对珠海航展两组的口径是「上架」——没点推广。
      //   （对比：宋雨琦/王一珩那四组老板明确要「10 分钟后一起开推广」。）
      if (!g.adName) {
        g.status = 'done';
        g.tries = 0;
        save(s);
        log('  ✅ 第' + g.n + '组 只上架、不建推广（本组没给 adName）→ 本组完成');
        return;                     // 内层 finally 会放浏览器锁，外层 finally 会清 LOCK
      }

      // 建计划（1 个计划绑这 2 条，照「一场次一计划」的老规矩）
      //
      // 【2026-10-14 12:5x 改·出价口径】老板原话：
      //   「新上架的链接不要直接到4，出价是系统推荐的百分之120就好，
      //     不然后面没有提价空间，而且计划容易跑飞。」
      //   所以不再用拍死的 s.bid，改成【系统建议价 × s.bidRate】。
      //   建议价必须**发布后**按这一组宝贝去问（同一链接、不同宝贝组合建议价不同），
      //   这里的位置天然就是"刚发完、有 itemId"——顺序是对的。
      //   取不到建议价就**不建计划**（fail-closed）：宁可先不投，也不瞎填一个价。
      let bidYuan = s.bid || 4;
      if (s.bidRate) {
        const pct = Math.round(s.bidRate * 100);
        const sg = run(['tools/ad-bid-suggest.js', '--items=' + ids.join(','), '--rate=' + pct],
          '问系统建议出价（本店口径 ×' + pct + '%）');
        const bm = sg.out.match(/BID=([\d.]+)/);
        if (!bm) {
          log('  ⛔ 取不到系统建议价 → **本组不建计划**（fail-closed：宁可先不投，也不瞎填价）。');
          log('     宝贝已发布（' + ids.join(',') + '），等广告库同步后可单独补建。');
          g.status = 'published';
          save(s);
          return;
        }
        bidYuan = Number(bm[1]);
        log('  ✅ 出价 = 系统建议价 × ' + pct + '% = ¥' + bidYuan.toFixed(2) + '（红线 ¥4 由 ad-bid-suggest 夹住）');
      }
      const mk = run(['tools/ad-plan-create.js', '--store=好易美代拍', '--items=' + ids.join(','),
        '--bid=' + bidYuan, '--budget=' + (s.budget || 150), '--name=' + g.adName, '--apply'], '建计划 ' + g.adName);
      const m = mk.out.match(/✅\s*id=(\d+)/);
      if (!m) { log('  ⚠️ 建计划的输出里没解析到 id —— 停下人工确认（宝贝已发布，别重发）'); throw new Error('没解析到 planId'); }
      g.planId = m[1];
      g.bid = bidYuan;
      g.status = 'planned';
      const delayMin = s.adDelayMin || 10;
      g.adAt = new Date(Date.now() + delayMin * 60000).toISOString();
      save(s);
      log('  ✅ 计划 ' + g.planId + ' 已建（出价 ¥' + bidYuan.toFixed(2) + ' / 预算 ¥' + (s.budget || 150) +
        ' / 时段 8-22 = 8:00-23:00）；' + delayMin + ' 分钟后开 → ' + g.adAt);
    } finally {
      run(['lib/browser-lock.js', 'release'], '放浏览器锁');
    }

    // 睡到点再开（精确 10 分钟）。被打断也没关系 —— 开头那段补做会按 adAt 补开。
    //
    // 【2026-10-14 12:1x 加 waitInProcess】老板当天新约束：「14 点前发完」+「14~18 点别干活」。
    //   四组要塞进 12:10-14:00，而如果在进程里干等这 10 分钟，每轮就变成 ~20 分钟，
    //   最后一组会被拖到 13:40（离 14:00 只剩 20 分钟余量，一有个闪失就破线）。
    //   设 waitInProcess=false 就不干等：发布完立刻收工，**开推广交给下一次轮询按 adAt 补做**
    //   （开头那段"① 补做"本来就是幂等的，天生支持这种形态）。
    //   代价：开推广时点由 5 分钟轮询决定，可能是"发布后 10~15 分钟"而不是精确 10 分钟。
    const waitMs = Date.parse(g.adAt) - Date.now();
    if (s.waitInProcess === false) {
      log('  （waitInProcess=false）不干等：开推广交给下一次轮询按 adAt=' + g.adAt + ' 补做（实际约发布后 10~15 分钟）');
    } else if (waitMs > 0) {
      log('  等 ' + Math.round(waitMs / 1000) + ' 秒后开推广...');
      await new Promise((r) => setTimeout(r, waitMs));
      run(['tools/ad-power.js', 'on', String(g.planId)], '开推广 第' + g.n + '组 ' + g.planId);
      g.openedAt = new Date().toISOString();
      g.status = 'done';
      g.tries = 0;                     // 整组做完 → 清零，万一以后要重发不会带着旧计数
      save(s);
      log('  ✅ 第' + g.n + '组 全部完成（发布 + 开推广）');
    }
  } catch (e) {
    log('  ❌ 第' + g.n + '组 中断: ' + e.message);
  } finally {
    try { fs.unlinkSync(LOCK); } catch (e) { /* 已清 */ }
    log('=== 第' + g.n + '组 本轮结束 ===');
  }
})().catch((e) => { console.error('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
