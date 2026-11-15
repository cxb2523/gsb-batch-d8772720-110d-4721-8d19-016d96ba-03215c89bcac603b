/**
 * tools/event-ads.js —— 按【活动】停/放推广（一串计划 id），核心动作就是维护 AD-EXCLUDE.json
 *
 * 老板 2026-10-12：「今天深圳王者荣耀共创之夜和奇妙夜推广，早上10点后推广全部暂停」。
 *
 * 为什么必须动 AD-EXCLUDE，而不是"暂停一下"就完事：
 *   08:00 的 `ad-window --on` 会把**全店**暂停的计划一起开回来，
 *   08:40 起的 `XianyuAdWindowGuard` 还会按「现在该开投」再核对一次；
 *   `ad-watch-stuck` 每 30 分钟也会把 statusDescCode=16 的暂停计划恢复。
 *   这三条路都只认一个例外：**AD-EXCLUDE.json 名单里的计划不开**。
 *   所以「停某几个计划」= 加名单 + 暂停；「放回去」= 从名单里删掉（开投交给 08:00 那轮）。
 *
 * 为什么不叫 tools/ad-*.js：`tools/ad-*.js` 是【运营】领地（见 协作约定.md §1），
 *   这个工具是老板直接派给【工程】的一次性活动闸门 —— 换个名字，别占人家的文件名段。
 *
 * 用法:
 *   node tools/event-ads.js --ids=99921823,100284773 --why="老板…"     # 停：加名单 + 暂停 + 回读校验
 *   node tools/event-ads.js --ids=99921823,100284773 --release         # 放：从名单删掉（不强制开投）
 *   node tools/event-ads.js --ids=99921823 --dry                       # 只说明会做什么，不动
 */
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const ROOT = __dirname ? path.join(__dirname, '..') : '.';

const mtop = require(path.join(ROOT, 'lib', 'mtop'));
const EXCLUDE = path.join(ROOT, 'AD-EXCLUDE.json');
const LOGF = path.join(ROOT, 'event-ads.log');

const ARGV = process.argv.slice(2);
const argOf = (k) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=').slice(1).join('=') : ''; };
const IDS = argOf('ids').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
const WHY = argOf('why') || '(未说明)';
const RELEASE = ARGV.includes('--release');
const DRY = ARGV.includes('--dry');

function log(m) {
  const l = '[' + new Date().toLocaleString('zh-CN') + '] ' + m;
  console.log(l);
  try { fs.appendFileSync(LOGF, l + '\n'); } catch (e) {}
}
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
/** 原子写：AD-EXCLUDE 是共享文件，写一半坏掉会连累全店开投 */
function writeJSONAtomic(p, o) {
  const t = p + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2) + '\n', 'utf8');
  fs.renameSync(t, p);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!IDS.length) { console.log('用法: node tools/event-ads.js --ids=1,2[,3] [--release] [--why="…"] [--dry]'); process.exit(2); }
  log((RELEASE ? '【放】' : '【停】') + ' 计划 ' + IDS.join(',') + (DRY ? '  [--dry 不动手]' : '') + '   原因: ' + WHY);

  const ex = readJSON(EXCLUDE, { ids: [] });
  ex.ids = ex.ids || [];
  const before = ex.ids.length;

  if (RELEASE) {
    const hit = IDS.filter((id) => ex.ids.includes(id));
    if (!hit.length) { log('  这些计划本来就不在名单里，无需处理'); return 0; }
    if (!DRY) {
      ex.ids = ex.ids.filter((id) => !IDS.includes(id));
      writeJSONAtomic(EXCLUDE, ex);
    }
    log('  已从 AD-EXCLUDE 移出 ' + hit.join(',') + '（' + before + ' → ' + (DRY ? before : ex.ids.length) + '）');
    log('  它们仍是暂停态；下次 08:00 的 ad-window --on 会把全店非名单计划一起开起来');
    return 0;
  }

  // ── 停：加名单 ──
  const added = IDS.filter((id) => !ex.ids.includes(id));
  if (!DRY) {
    IDS.forEach((id) => { if (!ex.ids.includes(id)) ex.ids.push(id); });
    ex._计划明细 = ex._计划明细 || {};
    IDS.forEach((id) => { ex._计划明细[id] = (ex._计划明细[id] ? ex._计划明细[id] + ' ／ ' : '') + WHY; });
    ex['_2026-10-12_深圳两个活动10点后停'] = '老板 2026-10-12：深圳王者荣耀共创之夜 + 奇妙夜（周年庆嘉年华暨KPL奇妙日），早上 10 点后推广全部暂停。'
      + '计划 ' + IDS.join('、') + '。由 tools/event-ads.js 在 10:00 一次性任务里加进本名单并暂停。'
      + '明天 07:30 由同一工具的 --release 放回（若老板要一直停，删掉 XianyuResumeShenzhenAds 那个任务即可）。';
    writeJSONAtomic(EXCLUDE, ex);
  }
  log('  名单 ' + before + ' → ' + (DRY ? before : ex.ids.length) + '（新增 ' + added.length + ' 个：' + (added.join(',') || '无') + '）');

  // ── 停：逐条暂停 + 逐条回读（不再"统一暂停 + 统一校验"）──
  // 【2026-10-13 改·真实事故】原来先写名单 → 一次性 adPause → 最后统一校验。
  //   2026-10-12 10:00 那次就是这么半成品的：名单写进去了、adPause 抛错
  //   （当时广告页卡在 dayu.goofish.com 的登录页 —— 浏览器被夜间回收后没回到广告后台），
  //   结果是「计划还在投、但名单里已经有了」；老板看到的是「说了停还在投」，
  //   而脚本只留了个退出码 1，**没有任何人去读**。这是【运营】在 协作-待办.md 里点出来的。
  //   现在：一条一条来，每条暂停完立刻回读；不一致不只退出码 1，还要留显眼的实体凭据
  //   （event-ads-FAILED.txt），因为"没人读的退出码"等于没报错。
  const results = [];
  for (const id of IDS) {
    if (DRY) { results.push({ id, ok: true, ret: '(dry)', st: '(dry)' }); continue; }
    let ret = '(未调用)';
    try {
      const r = await mtop.adPause([id], { pauseStatus: 1 });
      ret = (r.ret || []).join(' | ');
    } catch (e) { ret = '抛错: ' + ((e && e.message) || e); }
    await sleep(6000);
    let st = '(读不到)';
    try {
      const ps = await mtop.adPlans();
      const p = ps.find((x) => String(x.id) === String(id));
      st = p ? p.verdictCn : '(平台上找不到)';
    } catch (e) { st = '回读抛错: ' + ((e && e.message) || e); }
    const ok = st !== '投放中' && ret.indexOf('抛错') < 0 && st.indexOf('抛错') < 0;
    results.push({ id, ok, ret, st });
    log('  ' + (ok ? '✅' : '❌') + ' ' + id + '  暂停返回=' + ret + '  回读状态=' + st);
  }

  if (DRY) { log('  --dry：没动名单也没暂停，故不做回读校验'); return 0; }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    const line = '[' + new Date().toLocaleString('zh-CN') + '] ' + failed.length + '/' + IDS.length +
      ' 条没停成功：' + failed.map((f) => f.id + '（回读状态=' + f.st + '，暂停返回=' + f.ret + '）').join('；') +
      '  —— ⚠️ 名单已写进 AD-EXCLUDE，但这些计划【还在投】。' +
      '原因多半是浏览器不在广告后台（卡登录页 / 被夜间回收）。修法：先预热店铺页，再重跑本命令。\r\n';
    try { fs.appendFileSync(path.join(ROOT, 'event-ads-FAILED.txt'), line, 'utf8'); } catch (e) {}
    log('❌ ' + failed.length + '/' + IDS.length + ' 条没停成功 → 已写 event-ads-FAILED.txt（仓库根目录，别忽略它）');
    log('   重跑：node tools/event-ads.js --ids=' + failed.map((f) => f.id).join(','));
    process.exit(1);
  }
  log('✅ 全部 ' + IDS.length + ' 条：已暂停 + 已在名单（08:00 不会再开）');
  process.exit(0);
})().catch((e) => {
  // 连"抛异常"都要留凭据：本脚本失败 = 有活动该停没停，静默失败会被老板当成「说了不停」
  const line = '[' + new Date().toLocaleString('zh-CN') + '] ❌ event-ads 抛异常（计划可能没停）：' + ((e && e.stack) || e) + '\r\n';
  try { fs.appendFileSync(path.join(ROOT, 'event-ads-FAILED.txt'), line, 'utf8'); } catch (e2) {}
  log('❌ FAIL ' + ((e && e.stack) || e));
  process.exit(1);
});
