/**
 * tools/republish-bad.js — 下架发错的商品，并从队列重发（保留原任务 id）
 *
 * 适用场景：某条已发布的商品有关键字段错误（规格没关、所在地不对、价格不对），
 *   想在【不改动队列结构】的前提下重发一条正确的。
 *
 * 原理（publish.js 的注释原文）：「itemId 已存在的任务永不重发（防陈旧状态回写导致重复上架）；
 *   需重发请先清掉 itemId」——所以只要把队列里那条任务的 itemId 清掉、status 置回 pending，
 *   下一轮唤醒发布就会重发它，而保留的 id 保证了不会多出重复任务。
 *
 * 同时会把这条任务的 specs 关掉、价格/库存归位，并补上 directTitle 标题。
 *
 * 2026-09-30 修（真实事故）：下架成败【不再看 do-offshelf.js 的返回文字】
 * —— 有一条格式没匹配上被判失败，却照样把任务置回 pending，结果 1 条未下架的商品
 * 被重发成重复链接。现在改为：跑完下架后统一拉一次【真实在售池】，
 *   不在在售池   → 确认已下架 → 清 itemId、置回 pending
 *   仍在售       → 保留 itemId、不动它，并报错、退出码 1
 * 判据来自货架，不来自解析返回文字。
 *
 * 用法:
 *   node tools/republish-bad.js <itemId> [<itemId>...]        # 下架并重排
 *   node tools/republish-bad.js <itemId> --dry                # 只看会做什么
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const queue = require('../lib/queue');
const { ROOT, STORE } = require('../lib/env');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry');
const ALL_DONE = process.argv.includes('--all-done');

// --all-done：把队列里【所有已发布】的 show* 任务一起重发（换封面/正文时用），
// 免去手抄一堆 itemId 出错。
let IDS = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (ALL_DONE) {
  const qq = queue.readQueue();
  IDS = (qq.tasks || [])
    .filter((t) => String(t.id || '').indexOf('show') === 0 && t.itemId)
    .map((t) => String(t.itemId));
}
if (!IDS.length) { out.bad('用法: node tools/republish-bad.js <itemId> [...] 或 --all-done'); out.done(2); }

// 与 fix-shows-titles.js 同一套句式：_1 用「稳中代拍」，_2 用「必中代拍」
const tplA = (city, star, ev) => '【稳中代拍】' + city + star + ev + '代拍 （可看评价） 全价位都能接！';
const tplB = (city, star, ev) => '【必中代拍】' + city + star + ev + '代拍 全价位都能接 秒付必中 高命中率';
const EV = { '周深': '演唱会', '那英': '演唱会', '欧阳娜娜': '演唱会', '放肆快乐': '演唱会', '宋雨琦': '音乐会', '奥利淑元': '演唱会' };

// 场次/明星名更正表（老板改了信息时在这里加一条，重发时会自动把旧标题换掉）
const RENAME = [
  { from: '利淑元', to: '奥利淑元', ev: '演唱会' },   // 2026-09-29 老板更正
];

/** 真实在售池的 itemId 集合（取数与 tools/resync-queue-to-shelf.js 的 liveIds 一致） */
async function liveIds() {
  const code = [
    "const r = await mtop.request({ api:'mtop.taobao.idle.ad.item.searchV2', v:'1.0', type:'POST',",
    "  data:{ requestJson: JSON.stringify({ pageNum:1, pageSize:200, tab:'all', needTabs:true }) } });",
    "if (!(r && r.ret && String(r.ret[0]).indexOf('SUCCESS') === 0)) return JSON.stringify({ err:(r&&r.ret)||null });",
    'const d = (r.data || {}).result || r.data || {};',
    'return JSON.stringify({ ids:(d.itemList||[]).map(function(i){ return String(i.itemId); }) });',
  ].join('\n');
  const r = await agent.mtop(code);
  const d = typeof r === 'string' ? JSON.parse(r) : r;
  if (!d || d.err) throw new Error('拉在售池失败：' + JSON.stringify(d && d.err));
  return new Set(d.ids || []);
}

(async () => {
  const q0 = queue.readQueue();
  const tasks = q0.tasks || [];

  // 1. 按 itemId 找到队列里对应的任务
  const hits = [];
  IDS.forEach((id) => {
    const t = tasks.find((x) => String(x.itemId || '') === id);
    if (t) hits.push({ id, task: t });
    else out.warn('队列里没有 itemId=' + id + ' 的任务（可能是别的系统发的，只能纯下架、不能自动重发）');
  });

  out.head('将要下架并重发');
  out.table(['itemId', '任务 id', '场次', '原标题'],
    hits.map((h) => [h.id, h.task.id, h.task.city + h.task.star, String(h.task.star).slice(0, 34)]),
    { maxCol: [18, 10, 16, 36] });

  if (DRY) { out.plain(''); out.plain('  DRY：未执行'); out.done(0); }
  if (!hits.length) { out.bad('没有可处理的任务'); out.done(1); }

  // 2. 下架（用已有的 do-offshelf.js，它有 4 重守卫）
  //    ⚠️ 这里【不看它的返回文字】判成败 —— 2026-09-30 事故就是这么来的：
  //    有一条格式没匹配上被判失败，却照样置回 pending → 未下架的商品被重发成重复链接。
  //    真正的判据是第 3 步的【真实在售池】。
  out.head('下架');
  const NODE = process.execPath;
  let ranOk = 0;
  IDS.forEach((id) => {
    try {
      execFileSync(NODE, [path.join(ROOT, 'do-offshelf.js'), id],
        { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
      ranOk++;
      out.plain('  ✅ ' + id + '  已跑完下架（是否真下架，以第 3 步的在售池为准）');
    } catch (e) {
      out.bad('  ' + id + ' 下架失败：' + (e.message || '').slice(0, 120));
    }
  });
  if (!ranOk) { out.bad('一条都没跑成下架，中止（不下架就重发会产生重复）'); out.done(1); }

  // 3. 拉真实在售池：判据来自货架，不来自返回文字
  await agent.ready();
  const live = await liveIds();
  out.kv('在售可投池', live.size + ' 条');

  // 4. 重置队列任务：只有【确认不在在售池里】的才清 itemId → pending
  out.head('重排');
  // 走统一写入口：暂停发布链 → 读 → 改 → 写盘（带备份）→ 推页面 → 回读核对 → 恢复发布链
  const res = await queue.guardWrite(async (q) => {
    const still = [];
    const reset = [];
    IDS.forEach((id) => {
      const t = (q.tasks || []).find((x) => String(x.itemId || '') === id);
      if (!t) return;
      // 仍在售 → 保留 itemId，绝不置回 pending（否则会被重发成重复链接）
      if (live.has(String(id))) { still.push({ id: t.id, itemId: id }); return; }

      // ↓↓↓ 以下与原来 hits.forEach((h)) 里的重排逻辑逐行一致（只换了 t 的来源）↓↓↓
      delete t.itemId;
    delete t.error;
    t.status = 'pending';
    t.specs = { enabled: false };              // 关掉 50/500/800 那套规格
    t.price = '50';
    t.stock = '9999';
    const ev = t.eventType || EV[t.star] || '演唱会';
    // t.star 有两种形态：① 没被 fix-shows-titles 处理过的仍是【明星名】；
    //                    ② 处理过的是【完整标题】（以【开头）。按形态分别处理。
    if (String(t.star).indexOf('【') !== 0) {
      t.star = /_2$/.test(t.id) ? tplB(t.city, t.star, ev) : tplA(t.city, t.star, ev);
    }
    // 场次信息更正（老板 2026-09-29 更正）：
    //   香港那条不是「利淑元 ·《世你-月圆之约》见面会」，
    //   而是「奥利 & 淑元《世你·万圣之夜》演唱会，2026/10/31 亚洲国际博览馆」。
    // 标题里还留着旧名，这里一并换掉（此时 star 已是完整标题，所以按内容替换重写）。
    RENAME.forEach((R) => {
      if (String(t.star).indexOf(R.from) >= 0) {
        const t2 = /_2$/.test(t.id) ? tplB(t.city, R.to, R.ev) : tplA(t.city, R.to, R.ev);
        out.plain('  ' + t.id + '  标题更正：' + R.from + ' → ' + R.to + '（活动类型 ' + R.ev + '）');
        t.star = t2;
        t.eventType = R.ev;
      }
    });
    t.directTitle = true;
    out.plain('  ' + t.id + '  → pending   规格关   50/9999');
    out.plain('      标题: ' + t.star);
    reset.push({ id: t.id, title: t.star });
    });
    return { still: still, reset: reset };
  });

  const v = res.verify;
  out.head('完成');
  out.ok('已下架（在售池确认不在售） ' + res.result.reset.length + ' 条；仍在售 ' + res.result.still.length + ' 条');
  out.kv('下架执行', ranOk + ' / ' + IDS.length + ' 条跑完 do-offshelf.js');
  out.kv('写后核对', '磁盘 ' + v.diskTasks + ' 条 / 页面 ' + v.pageTasks + ' 条，重复 ' + v.dup +
    (v.ok ? '  ✅ 一致' : '  ❌ 不一致'));
  if (res.result.still.length) {
    res.result.still.forEach((s) => out.bad('  ❌ 仍在售：' + s.id + '  itemId=' + s.itemId + '（保留 itemId，未置回 pending，不会重发）'));
    out.bad('仍有 ' + res.result.still.length + ' 条在售未重排 —— 退出码 1。请先确认它们是否真的不该下架。');
    out.done(1);
  }
  out.plain('  它们会在接下来的唤醒轮次里被重新发出（每 30 分钟 1 条）。');
  out.done(0);
})().catch((e) => out.fail(e));
