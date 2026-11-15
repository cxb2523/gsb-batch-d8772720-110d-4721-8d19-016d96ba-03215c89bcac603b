/**
 * tools/fix-shows-titles.js — 给队列里的 show* 任务指定【完整标题】，绕开店铺模板
 *
 * 为什么必须做：
 *   店铺级文案模板是「【稳中代拍】{城市}{明星}演唱会代拍 （可看评价）…」——
 *   **没有 {场次类型} 占位符**。所以我原来靠 sessionType 区分「首开/二开」的设计失效，
 *   同一场次的两条链接会渲染出【一模一样】的标题 → 重复上架。
 *
 * 修法（publish.js:1584 给的口子）：
 *   `if (currentStore === 'casa家居' || task.directTitle) { title = task.star; desc = task.description; }`
 *   → 设 directTitle / star(=完整标题) / description(=正文)，完全不走模板。
 *
 * 标题规则：同一场次的第 1 条用【稳中代拍】句式，第 2 条用【必中代拍】句式。
 *   两条都在 30~40 字内（fitTitle 不会截断也不会补感叹号）。
 *
 * 只改【未发布】的任务（status 非 done、无 itemId），已发出去的绝不动。
 *
 * 用法: node tools/fix-shows-titles.js [--dry]
 */
const fs = require('fs');
const os = require('os');
const out = require('../lib/out');
const agent = require('../lib/agent');
const queue = require('../lib/queue');
const { STORE } = require('../lib/env');

const DRY = process.argv.includes('--dry');

// 句式 A / B：与店铺已有链接同风格，两条用不同前缀和不同尾巴
const tplA = (city, star, ev) => '【稳中代拍】' + city + star + ev + '代拍 （可看评价） 全价位都能接！';
const tplB = (city, star, ev) => '【必中代拍】' + city + star + ev + '代拍 全价位都能接 秒付必中 高命中率';

// 活动类型（演唱会 / 音乐会 / 见面会），按老板原话
const EV = { '周深': '演唱会', '那英': '演唱会', '欧阳娜娜': '演唱会', '放肆快乐': '演唱会', '宋雨琦': '音乐会', '利淑元': '见面会' };

(async () => {
  if (!(await agent.isUp())) { out.bad('服务没在跑'); out.done(2); }
  await agent.ready();

  // 正文从页面里现取，保证和现在用的完全一致（不自己编）
  const descRaw = await agent.evalOnStore(
    '(function(){try{var d=loadDailyTasks();var id=d.templateId||1;' +
    'var t=null;for(var i=0;i<CONCERT_TEMPLATES.length;i++){if(CONCERT_TEMPLATES[i].id===id){t=CONCERT_TEMPLATES[i];break;}}' +
    'if(!t)t=CONCERT_TEMPLATES[0];return JSON.stringify({id:id,desc:(t&&t.descPattern)||""});}catch(e){return JSON.stringify({err:e.message});}})()',
    { timeout: 60000 });
  const descInfo = typeof descRaw === 'string' ? JSON.parse(descRaw) : descRaw;
  const DESC = descInfo.desc || '';
  out.kv('正文来源', 'templateId=' + descInfo.id + '（' + DESC.length + ' 字）' + (DESC ? '' : '  ⚠️ 取不到，将不设 description'));

  /** 改写：只动【未发布】的 show* 任务。返回 {changed, skipped} */
  const apply = (q) => {
    const changed = [];
    const skipped = [];
    (q.tasks || []).forEach((t) => {
      if (String(t.id || '').indexOf('show') !== 0) return;
      if (t.status === 'done' || t.status === 'failed' || t.itemId) { skipped.push(t); return; }
      const ev = EV[t.star] || t.eventType || '演唱会';
      const isSecond = /_2$/.test(t.id);
      const title = isSecond ? tplB(t.city, t.star, ev) : tplA(t.city, t.star, ev);
      t.directTitle = true;
      t.star = title;                 // directTitle 模式下 star 就是完整标题
      if (DESC) t.description = DESC;
      t._预览标题 = title;
      t._标题字数 = title.length;
      changed.push(t);
    });
    return { changed, skipped };
  };

  /** 打印改写结果（DRY 与真写两条路都要打，所以抽出来） */
  const show = (r) => {
    const changed = r.changed;
    out.head('标题改写');
    out.table(['id', '字数', '完整标题'],
      changed.map((t) => [t.id, String(t._标题字数), t._预览标题]),
      { maxCol: [10, 5, 60] });

    const tooLong = changed.filter((t) => t._标题字数 > 40);
    const tooShort = changed.filter((t) => t._标题字数 < 30);
    const titles = changed.map((t) => t._预览标题);
    const dup = titles.filter((t, i) => titles.indexOf(t) !== i);

    if (tooLong.length) out.warn('超 40 字会被截断：' + tooLong.map((t) => t.id).join('、'));
    if (tooShort.length) out.warn('不足 30 字会被补感叹号：' + tooShort.map((t) => t.id + '(' + t._标题字数 + ')').join('、'));
    if (dup.length) out.warn('标题重复：' + [...new Set(dup)].join('、'));
    if (!tooLong.length && !tooShort.length && !dup.length) out.ok(changed.length + ' 条标题长度合适且互不重复');
  };

  // DRY 走只读路径：不进 guardWrite（否则会暂停发布链并真的写盘）
  if (DRY) {
    show(apply(queue.readQueue()));
    out.plain(''); out.plain('  DRY：未写入'); out.done(0);
  }

  // 走统一写入口：暂停发布链 → 读 → 改 → 写盘（带备份）→ 推页面 → 回读核对 → 恢复发布链
  const res = await queue.guardWrite(async (q) => {
    const r = apply(q);
    show(r);
    // 原来写的是 JSON 深拷贝 clean，这里就地删预览字段（写盘前删，效果一样）
    (q.tasks || []).forEach((t) => { delete t._预览标题; delete t._标题字数; });
    return r;
  });

  const v = res.verify;
  out.head('写入完成');
  out.ok('改写 ' + res.result.changed.length + ' 条；已发过的 ' + res.result.skipped.length + ' 条未动');
  out.kv('写后核对', '磁盘 ' + v.diskTasks + ' 条 / 页面 ' + v.pageTasks + ' 条，重复 ' + v.dup +
    (v.ok ? '  ✅ 一致' : '  ❌ 不一致'));
  out.done(0);
})().catch((e) => out.fail(e));
