/**
 * tools/fix-b2-title.js — 给 b2 批次里【还没发出去】的成都宋雨琦 #2 换个不撞的标题，然后补发
 *
 * 背景（2026-09-30 我造成的事故）：
 *   b2 批次沿用了和 b1 相同的标题模板 → 同场次标题完全重复。
 *   广州/泉州那 4 条照发（在售），但成都宋雨琦有一条没进在售、另一条根本没发。
 *   run-batch.js 已修（批次号决定句式），这里把【还没发的这条】按新句式补上。
 *
 * 只改 show8_b2_2（status=pending 且无 itemId）—— 已发布的 4 条一概不碰，
 * 否则会被当成待发重发成重复链接。
 */
const out = require('../lib/out');
const queue = require('../lib/queue');
const { execFileSync } = require('child_process');
const path = require('path');
const { ROOT } = require('../lib/env');

// b2 批次该用的第二句（与 run-batch.js 的 TITLE_TPL[3] 一致）
const NEW_TITLE = '【接代拍】宋雨琦成都站音乐会首开代抢 秒付前排 全价位都能接';
const TARGET = 'show8_b2_2';

(async () => {
  const before = queue.readQueue();
  const t = (before.tasks || []).find((x) => x.id === TARGET);
  if (!t) { out.bad('队列里没有 ' + TARGET); out.done(2); }
  if (t.itemId) { out.warn(TARGET + ' 已有 itemId=' + t.itemId + '，不重发（避免重复链接）'); out.done(0); }

  const oldTitle = t.star;
  out.head('补发 ' + TARGET);
  out.kv('原标题', oldTitle + '  ← 与 b1 撞车');
  out.kv('新标题', NEW_TITLE);
  out.kv('长度', NEW_TITLE.length + ' 字');

  await queue.guardWrite(async (q) => {
    const x = (q.tasks || []).find((y) => y.id === TARGET);
    x.star = NEW_TITLE;
    x.directTitle = true;
    x.specs = { enabled: false };
    x.subImg = true;
    x.subSet = '第一组副图';
    x.status = 'pending';
    delete x.itemId;
    return { id: x.id };
  });
  out.ok('标题已改，状态 pending');

  out.head('补发');
  try {
    const r = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'fire-one-publish.js')],
      { encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
    r.split('\n').filter((l) => l.trim()).slice(-4).forEach((l) => out.plain('  ' + l.trim()));
  } catch (e) { out.bad('发布失败：' + (e.message || '').slice(0, 150)); out.done(1); }

  const after = queue.readQueue();
  const x = (after.tasks || []).find((y) => y.id === TARGET);
  out.head('结果');
  out.kv(TARGET, 'status=' + x.status + '  itemId=' + (x.itemId || '（还没有）'));
  out.done(x.itemId ? 0 : 1);
})().catch((e) => out.fail(e));
