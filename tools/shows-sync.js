/**
 * tools/shows-sync.js — 生成/更新【场次档案】 shows/<城市>-<明星>-<场次类型>.json
 *
 * 为什么需要它（老板 2026-10-08：「以后我上下架、开推广直接和你怎么说最好，你也能留下数据统计」）：
 *   现在台账只有「链接」这一层 —— 知道哪条链接什么时候上的、用了什么版式，
 *   但【不知道这个场次什么时候开票、什么时候演出】。而代拍需求是脉冲式的，
 *   当天两次实测都证明了：
 *     · 泉州徐良「已经开票抢完了」→ 出价提到 ¥3.50，曝光 84→155 能买到，
 *       但单次咨询成本冲到 ¥5.42（超 ¥4 红线）—— 买得到曝光买不到转化；
 *     · 孙燕姿三开/回流阶段 → 一天只花 ¥0.05–2.40，根本拿不到量。
 *   所以「开票时间」是判断该不该继续花钱的唯一关键变量，必须有个地方存。
 *
 * 设计要点：档案是【人机共写】的
 *   · 自动字段（links / 推广计划 / 自动状态）每跑一次刷新
 *   · 手填字段（开票时间 / 演出日期 / 备注 / 状态手填）**永不被覆盖**
 *     这样老板随口说一句「10/20 开票」，我填进去就长期有效，不会被下次同步冲掉。
 *
 * 用法:
 *   node tools/shows-sync.js            # 预演（只打印，不写盘）
 *   node tools/shows-sync.js --apply    # 写 shows/
 *   node tools/shows-sync.js --apply --show=三亚-周杰伦-二开   # 只同步一个
 */
const fs = require('fs');
const path = require('path');
const mtop = require('../lib/mtop');
const { ROOT } = require('../lib/env');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--show=')) || '').split('=')[1] || '';
const SHOWDIR = path.join(ROOT, 'shows');

/** 手填字段：同步时从旧文件里原样带过来 */
const MANUAL_KEYS = ['开票时间', '演出日期', '备注', '状态手填'];

const keyOf = (r) => [r.city || r.城市, r.star || r.明星, r.session || r.场次类型].join('-')
  .replace(/[\\/:*?"<>|]/g, '_');   // 文件名安全

function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return dflt; } }

(async () => {
  const led = loadJson(path.join(ROOT, '上架台账.json'), []);
  if (!Array.isArray(led) || !led.length) { console.log('❌ 台账读不到或为空'); process.exit(1); }

  // 1) 台账按场次分组
  const groups = {};
  for (const r of led) {
    if (!r.itemId) continue;
    const k = keyOf(r);
    if (!groups[k]) groups[k] = { key: k, 城市: r.city, 明星: r.star, 活动类型: r.event, 场次类型: r.session, rows: [] };
    groups[k].rows.push(r);
  }

  // 2) 拉全店推广计划，按【绑定商品】把它们挂到场次上（不按计划名猜）
  let plans = [];
  try { plans = await mtop.adPlans(); }
  catch (e) { console.log('⚠️ 拉推广计划失败（' + e.message + '），本轮只同步 links、不更新推广计划'); }

  const planByItem = {};
  for (const p of plans) {
    for (const id of String(p.items || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      (planByItem[id] = planByItem[id] || []).push(p);
    }
  }

  if (!fs.existsSync(SHOWDIR)) fs.mkdirSync(SHOWDIR, { recursive: true });

  let n = 0;
  for (const k of Object.keys(groups).sort()) {
    if (ONLY && k !== ONLY) continue;
    const g = groups[k];
    const file = path.join(SHOWDIR, k + '.json');
    const old = loadJson(file, null);

    // links（自动）：台账里属于本场次的链接，最近的在前
    const sorted = g.rows.slice().sort((a, b) => String(b.时间).localeCompare(String(a.时间)));
    const links = sorted.map((r) => ({
      itemId: String(r.itemId),
      城市: r.city, 明星: r.star, 活动类型: r.event, 场次类型: r.session,
      区: (String(r.定位 || '').split('/')[2] || ''),
      divisionId: (String(r.定位 || '').split('/')[3] || ''),
      价格: r.price, 主图版式: r.主图模板 || '', 文案模板: r.文案模板id,
      标题: r.标题 || '', 上架时间: r.时间 || '',
      台账状态: r.状态 || '', 重发为: r.重发为 || '',
    }));

    // 推广计划（自动）：凡绑了本场次任一条链接的计划
    const idset = new Set(links.map((l) => l.itemId));
    const seen = new Set();
    const myPlans = [];
    for (const id of idset) {
      for (const p of (planByItem[id] || [])) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const bound = String(p.items || '').split(',').map((s) => s.trim()).filter(Boolean);
        myPlans.push({
          id: p.id, 名称: p.name, 出价: p.bidYuan, 预算: p.budgetYuan,
          宝贝数: bound.length,
          本场次宝贝: bound.filter((b) => idset.has(b)),
          _还绑了别的场次: bound.filter((b) => !idset.has(b)),
          状态: p.verdictCn, 状态说明: p.desc || '',
          今日花费: p.dayCost, 今日咨询: p.dayChat, 今日曝光: p.dayShows,
          累计花费: p.cumCost, 累计咨询: p.cumChat,
        });
      }
    }
    myPlans.sort((a, b) => Number(b.今日花费) - Number(a.今日花费));

    // 自动状态：有在跑的计划 → 在推；有计划但全停 → 已停；没有计划 → 待投
    const running = myPlans.filter((p) => p.状态 === '投放中').length;
    const autoStatus = running ? '在推（' + running + ' 个计划在跑）' : (myPlans.length ? '已停' : '待投');

    const merged = {
      _schema: 'show/1',
      _说明: '场次档案。带「自动」注释的字段由 tools/shows-sync.js 刷新；'
        + '开票时间 / 演出日期 / 备注 / 状态手填 属于人工字段，同步时【永不覆盖】。',
      城市: g.城市, 明星: g.明星, 活动类型: g.活动类型, 场次类型: g.场次类型,
      开票时间: (old && old.开票时间) || '',
      演出日期: (old && old.演出日期) || [],
      备注: (old && old.备注) || [],
      状态手填: (old && old.状态手填) || '',
      自动状态: autoStatus,
      链接数: links.length,
      推广计划数: myPlans.length,
      links: links,
      推广计划: myPlans,
    };

    const changed = JSON.stringify(old) !== JSON.stringify(merged);
    console.log((changed ? '  ✎ ' : '  = ') + k + '.json   链接 ' + links.length +
      '  计划 ' + myPlans.length + '   ' + autoStatus +
      (old ? '' : '   ← 新建'));
    if (APPLY && changed) fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
    n++;
  }

  console.log('\n共 ' + n + ' 个场次' + (APPLY ? '，已写 ' + SHOWDIR : '（预演，加 --apply 才写盘）'));
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
