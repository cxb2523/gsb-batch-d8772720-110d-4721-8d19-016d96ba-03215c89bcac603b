/**
 * tools/fix-desc-and-dedupe.js — 修两件事：
 *   ① 补正文：directTitle 任务缺 description → 卡片和详情都没文案
 *      正文来源改为【本地文件】~/.xianyu-templates.json（不再依赖页面状态，
 *      上次就是因为去页面取 CONCERT_TEMPLATES 取不到、又只 warn 不报错，静默失败了）
 *   ② 去重：队列里有 2 条重复任务（show4_2 / show5_1 各两份），下架重发前必须清掉
 *
 * 用法:
 *   node tools/fix-desc-and-dedupe.js --dry
 *   node tools/fix-desc-and-dedupe.js
 * 退出码: 0 成功；1 有问题（缺正文/仍有重复）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const queue = require('../lib/queue');
const { ROOT, STORE } = require('../lib/env');

const DRY = process.argv.includes('--dry');
const TPL_FILE = path.join(os.homedir(), '.xianyu-templates.json');

/** 去重：同 id 只留一条。纯函数，体检与真写两条路共用 */
function dedupe(all) {
  const seen = new Map();
  const dups = [];
  const kept = [];
  all.forEach((t) => {
    const k = t.id;
    if (!seen.has(k)) { seen.set(k, t); kept.push(t); return; }
    // 重复：保留【有 itemId 的那条】（已发布的记录），否则保留先来的
    const prev = seen.get(k);
    if (!prev.itemId && t.itemId) {
      kept[kept.indexOf(prev)] = t;
      seen.set(k, t);
    }
    dups.push({ id: k, droppedItemId: t.itemId || '', keptItemId: (seen.get(k).itemId || '') });
  });
  return { kept, dups };
}

(async () => {
  const q = queue.readQueue();
  const all = q.tasks || [];

  out.head('队列体检');
  out.kv('总条数', all.length);

  // ── ② 去重 ──
  const plan = dedupe(all);
  const kept = plan.kept;
  const dups = plan.dups;
  out.kv('去重后条数', kept.length);
  if (dups.length) {
    out.warn('去掉 ' + dups.length + ' 条重复：');
    dups.forEach((d) => out.plain('    ' + d.id + '  （丢弃 itemId=' + (d.droppedItemId || '无') +
      '，保留 itemId=' + (d.keptItemId || '无') + '）'));
  } else out.ok('没有重复任务');

  // ── ① 正文 ──
  let DESC = '';
  try {
    const tf = JSON.parse(fs.readFileSync(TPL_FILE, 'utf8'));
    const t1 = (tf.templates || [])[0] || {};
    DESC = String(t1.descPattern || '');
    out.kv('正文来源', path.basename(TPL_FILE) + ' 模板「' + (t1.name || '?') + '」  ' + DESC.length + ' 字');
  } catch (e) {
    out.kv('正文来源', '读取失败：' + e.message);
  }
  if (!DESC) {
    out.bad('❌ 取不到正文 —— 直接失败退出（上次就是因为这里只 warn 不报错，静默跳过了）');
    out.done(1);
  }

  const need = kept.filter((t) => String(t.id || '').indexOf('show') === 0 && t.directTitle);
  const missing = need.filter((t) => !t.description);
  out.kv('directTitle 任务', need.length + ' 条，其中缺正文 ' + missing.length + ' 条');

  // 补（也把不一致的统一成同一份正文）
  let changed = 0;
  need.forEach((t) => { if (t.description !== DESC) { t.description = DESC; changed++; } });
  out.ok('已补/统一正文 ' + changed + ' 条');

  if (DRY) { out.plain(''); out.kv('DRY', '未写入'); out.done(0); }

  // ── 写入磁盘 + 页面：走统一写入口 ──
  // 暂停发布链 → 读 → 改 → 写盘（带备份）→ 推页面 → 回读核对 → 恢复发布链
  const res = await queue.guardWrite(async (qq) => {
    // 对【刚读到的】队列重算去重（不用体检那份，避免用陈旧对象）
    const r = dedupe(qq.tasks || []);
    qq.tasks = r.kept;
    let n = 0;
    r.kept.forEach((t) => {
      if (String(t.id || '').indexOf('show') === 0 && t.directTitle && t.description !== DESC) {
        t.description = DESC;
        n++;
      }
    });
    return { changed: n, dropped: r.dups.length };
  });

  const v = res.verify;
  out.head('写后核对');
  out.kv('磁盘条数', v.diskTasks);
  out.kv('页面条数', v.pageTasks);
  out.kv('show* 条数', v.showTasks);
  out.kv('重复剩余', v.dup);
  out.kv('带正文', v.withDesc + ' / ' + v.diskTasks);

  let bad = 0;
  if (v.dup) { out.bad('❌ 队列里仍有 ' + v.dup + ' 条重复'); bad++; }
  if (v.withDesc !== v.diskTasks) { out.bad('❌ 仍有 ' + (v.diskTasks - v.withDesc) + ' 条没有正文'); bad++; }
  if (!v.ok) { out.bad('❌ 写后核对不通过（磁盘 ' + v.diskTasks + ' 条 / 页面 ' + v.pageTasks + ' 条）'); bad++; }
  if (!bad) out.ok('✅ 无重复、全部带正文');
  out.done(bad ? 1 : 0);
})().catch((e) => out.fail(e));
