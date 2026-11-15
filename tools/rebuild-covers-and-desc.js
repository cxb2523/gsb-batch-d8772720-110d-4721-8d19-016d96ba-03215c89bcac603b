/**
 * tools/rebuild-covers-and-desc.js — 修两件事：
 *   ① 重出封面：按队列里每条任务【实际引用的文件名】重出，走 make-cover.js（底图+文字层一步到位）
 *   ② 补正文  ：directTitle 任务原来没设 description → 正文空 → 卡片和详情都没文案
 *
 * 为什么按「实际文件名」重出而不是按 shows.json 推：
 *   队列里的 imageUrls 是早先写死的（例如 `香港利淑元-1-xuliang-v1.jpg`），
 *   而香港那个场次后来改成了「奥利淑元」。按队列里的文件名出，才不会出现
 *   「出了新图但任务引用的还是旧文件名」这种对不上的情况。
 *
 * 用法:
 *   node tools/rebuild-covers-and-desc.js --dry     # 只列出要做的事
 *   node tools/rebuild-covers-and-desc.js           # 出图 + 补正文（只写文件与队列，不碰线上）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = require('../lib/out');
const agent = require('../lib/agent');
const queue = require('../lib/queue');
const { ROOT, PATHS, STORE } = require('../lib/env');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry');
const IMG_DIR = path.join(PATHS.images, STORE) + '/';
const TMP_DIR = path.join(ROOT, '渲染确认');
const COVER_TPLS = ['xuliang-v1', 'tpl_redtext'];
const HK_POSTER = IMG_DIR + '香港奥利淑元-底图.jpg';

/** 从 `香港利淑元-1-xuliang-v1.jpg` 反推 { tpl, cityStar } */
function parseName(fn, city) {
  const tpl = COVER_TPLS.find((k) => fn.indexOf('-' + k + '.') >= 0) || 'xuliang-v1';
  const i = fn.indexOf('-' + tpl + '.');
  const cityStar = i > 0 ? fn.slice(0, i) : '';
  const idx = /-(\d+)$/.exec(cityStar);
  return { tpl, cityStar: idx ? cityStar.slice(0, -idx[0].length) : cityStar };
}

(async () => {
  const q = queue.readQueue();
  const tasks = (q.tasks || []).filter((t) => String(t.id || '').indexOf('show') === 0);

  out.head('计划');
  out.kv('队列 show* 任务', tasks.length + ' 条');
  out.kv('图片目录', IMG_DIR);

  const rows = [];
  tasks.forEach((t) => {
    const fn = (t.imageUrls || [])[0] || '';
    const { tpl, cityStar } = parseName(fn, t.city);
    const star = cityStar.slice(String(t.city).length) || t.city;
    rows.push([t.id, t.city, star, tpl, fn, t.description ? '有' : '缺']);
  });
  out.table(['id', '城市', '明星名', '模板', '目标文件名', '正文'], rows,
    { maxCol: [10, 6, 12, 14, 30, 4] });

  const needDesc = tasks.filter((t) => t.directTitle && !t.description);
  out.kv('需要补正文', needDesc.length + ' 条');

  if (DRY) { out.plain(''); out.kv('DRY', '未出图、未写队列'); out.done(0); }

  // ── 1. 逐条重出封面 ──
  out.head('重出封面');
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const NODE = process.execPath;
  const MK = path.join(ROOT, 'tools', 'make-cover.js');
  let okN = 0, failN = 0;

  for (const t of tasks) {
    const fn = (t.imageUrls || [])[0] || '';
    if (!fn) { out.warn('  ' + t.id + ' 没有 imageUrls，跳过'); continue; }
    const { tpl, cityStar } = parseName(fn, t.city);
    const star = cityStar.slice(String(t.city).length) || t.city;
    const specPath = path.join(TMP_DIR, '_spec_' + t.id + '.json');
    const tmpOut = path.join(TMP_DIR, '_out_' + t.id + '.jpg');
    const spec = { city: t.city, star: star, tpl: tpl, out: tmpOut };
    if (t.city === '香港' && fs.existsSync(HK_POSTER)) spec.poster = HK_POSTER;
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    process.stdout.write('  … ' + t.id + ' ' + t.city + star + ' (' + tpl + ')');
    try {
      const r = execFileSync(NODE, [MK, '--spec=' + specPath], { encoding: 'utf8', timeout: 420000, maxBuffer: 8 * 1024 * 1024 });
      const line = (r.split('\n').find((l) => l.indexOf('{"ok"') >= 0) || '').trim();
      const j = line ? JSON.parse(line) : null;
      if (!j || !j.file) throw new Error('make-cover 没返回文件');
      // 写到队列引用的那个文件名（保持引用不变）
      fs.copyFileSync(j.file, IMG_DIR + fn);
      okN++;
      process.stdout.write('  ✅ ' + Math.round(fs.statSync(IMG_DIR + fn).size / 1024) + 'KB  文字层×' + j.layers + '\n');
    } catch (e) {
      failN++;
      process.stdout.write('  ❌ ' + (e.message || '').slice(0, 120) + '\n');
    }
  }
  out.ok('封面：成功 ' + okN + ' / 失败 ' + failN);

  // ── 2. 补正文 ──
  out.head('补正文');
  let DESC = '';
  try {
    const raw = await agent.evalOnStore(
      '(function(){try{var d=loadDailyTasks();var id=d.templateId||1;var t=null;' +
      'for(var i=0;i<CONCERT_TEMPLATES.length;i++){if(CONCERT_TEMPLATES[i].id===id){t=CONCERT_TEMPLATES[i];break;}}' +
      'if(!t)t=CONCERT_TEMPLATES[0];return JSON.stringify({desc:(t&&t.descPattern)||""});}catch(e){return JSON.stringify({err:e.message});}})()',
      { timeout: 60000 });
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    DESC = j.desc || '';
  } catch (e) { out.warn('取正文失败：' + e.message); }
  out.kv('正文来源', DESC ? '页面 CONCERT_TEMPLATES（' + DESC.length + ' 字）' : '❌ 取不到');

  if (DESC) {
    // 走统一写入口：暂停发布链 → 读 → 改 → 写盘（带备份）→ 推页面 → 回读核对 → 恢复发布链
    const res = await queue.guardWrite(async (qq) => {
      const ts = (qq.tasks || []).filter((t) => String(t.id || '').indexOf('show') === 0);
      const fixed = ts.filter((t) => t.directTitle && t.description !== DESC);
      fixed.forEach((t) => { t.description = DESC; });
      return { fixed: fixed.length };
    });
    out.ok('补了 ' + res.result.fixed + ' 条');
    const v = res.verify;
    out.kv('写后核对', '磁盘 ' + v.diskTasks + ' 条 / 页面 ' + v.pageTasks + ' 条，重复 ' + v.dup +
      (v.ok ? '  ✅ 一致' : '  ❌ 不一致'));
  }

  out.head('完成');
  out.plain('  封面已重出并覆盖到队列引用的文件名；正文已补。');
  out.plain('  下一步（第 3 步）才是下架重发 —— 需要你确认后再做。');
  out.done(failN ? 1 : 0);
})().catch((e) => out.fail(e));
