#!/usr/bin/env node
/**
 * judge_star.js — 明星级"该加 / 该衰 / 该停 / 判不了"判定器
 *
 * 落地自：深度学习-糕仔-20261110.md 的 M1（边际口径）、M9（判定式）、M11（分级）
 *
 * 设计原则
 *  1) 只读本地 JSON，不连任何接口（接口数据请先落盘，见 data/stars-YYYYMMDD.json）
 *  2) INSUFFICIENT 是一等公民：样本不够就明确说"还差几天"，绝不硬给方向
 *  3) 观察性估计，不是因果；输出里永远带这句
 *
 * 用法
 *  node tools/judge_star.js --in data/stars-20261105.json --dry --explain
 *  node tools/judge_star.js --in data/stars-2026110x.json --days 7 --explain --json out.json
 *
 * 参数
 *  --in <file>     输入 JSON（数组，或 {rows:[...]}；每行至少 star_name/fee/inbox/click/impression，有 date 更好）
 *  --days <n>      当输入是"区间聚合"（没有 date 字段）时，按 n 天计；默认 1
 *  --dry           只用现有数据跑，不写任何文件、不联网（本脚本永不联网，此开关只做语义标识）
 *  --explain       打印每个明星"为什么判 INSUFFICIENT / 还差多少样本"
 *  --json <file>   另存一份结构化结果
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------- 可调参数（改这里，别散落在代码里） ----------------
const CFG = {
  MIN_DAYS: 5,          // 完整性门：少于 5 天不判（M9）
  MIN_SPEND: 100,       // 完整性门：窗口内消耗 < 100 元不判（避免拿零头明星下结论）
  MIN_CLICKS: 30,       // 完整性门：点击太少，私信率不准
  SHOCK_Z: 2,           // 需求冲击剔除阈值（比异常检测的 4 松，见 M5）
  HIGH_SHARE: 0.30,     // 两档法：高档 = 消耗最高的 30% 天（M13）
  NORMALIZER: 1 / 0.3 + 1, // 两档法方差系数 = 4.333（三档法为 5.833）
  SAT_RATIO: 0.7,       // 边际产出 / 平均产出 < 0.7 → 强衰减（liuyizhou 的 SQL 判据）
  CPL_RED_LINE: 11,     // 私信成本红线（元/条，由 11-05 实测推出）
  EFFECT: 0.30,         // 要识别的相对效应 30%
  Z: 1.96,              // 95% 置信
  MAX_ADD: 0.30         // 加预算上限（与 juguang-skill / LMMM 边界一致）
};

// ---------------- 小工具 ----------------
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a');
function median(a) {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
function mad(a) {
  if (!a.length) return NaN;
  const m = median(a);
  return median(a.map((x) => Math.abs(x - m)));
}

// ---------------- 读入 ----------------
function loadRows(file, fallbackDays) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.rows || [];
  if (!rows.length) throw new Error('输入为空：' + file);

  return rows.map((row, i) => {
    const star = row.star_name || row.star || row.name;
    if (!star) throw new Error(`第 ${i + 1} 行缺 star_name`);
    const spend = num(row.fee != null ? row.fee : row.spend);
    const inbox = num(row.inbox != null ? row.inbox : row.msg_chat_user_cnt);
    const click = num(row.click);
    const impression = num(row.impression);
    const date = row.date || row.dt || null;
    return { star, date, spend, inbox, click, impression, days: date ? 1 : fallbackDays };
  });
}

/** 按明星聚合；有 date 的按天去重，没有 date 的按 fallbackDays 折算 */
function groupByStar(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.star)) map.set(r.star, { star: r.star, days: [], dates: new Set() });
    const g = map.get(r.star);
    const key = r.date || `__agg_${g.days.length}`;
    if (g.dates.has(key)) {
      // 同一天同一明星多行 → 合并（多计划/多创意）
      const d = g.days.find((x) => x.date === key);
      d.spend += r.spend; d.inbox += r.inbox; d.click += r.click; d.impression += r.impression;
    } else {
      g.dates.add(key);
      g.days.push({ date: key, spend: r.spend, inbox: r.inbox, click: r.click, impression: r.impression });
    }
  }
  return [...map.values()].map((g) => ({
    star: g.star,
    days: g.days,
    nDays: g.days.length,
    spend: sum(g.days.map((d) => d.spend)),
    inbox: sum(g.days.map((d) => d.inbox)),
    click: sum(g.days.map((d) => d.click)),
    impression: sum(g.days.map((d) => d.impression))
  }));
}

// ---------------- 需求冲击（组合级） ----------------
function demandShockDates(stars) {
  const byDate = new Map();
  for (const s of stars) {
    for (const d of s.days) {
      if (!byDate.has(d.date)) byDate.set(d.date, { inbox: 0, click: 0 });
      const o = byDate.get(d.date);
      o.inbox += d.inbox; o.click += d.click;
    }
  }
  const rows = [...byDate.entries()]
    .filter(([, v]) => v.click > 0)
    .map(([date, v]) => ({ date, cvr: v.inbox / v.click }));
  if (rows.length < CFG.MIN_DAYS) {
    return { shocks: new Set(), info: `日期数 ${rows.length} < ${CFG.MIN_DAYS}，无法建立稳健基线，本轮不剔除` };
  }
  const cvrs = rows.map((r) => r.cvr);
  const med = median(cvrs);
  const m = mad(cvrs);
  const scale = 1.4826 * m;
  const shocks = new Set();
  if (scale > 0) {
    for (const r of rows) {
      const z = (r.cvr - med) / scale;
      if (z > CFG.SHOCK_Z) shocks.add(r.date);
    }
  }
  return { shocks, info: `组合日私信率 median=${pct(med)}、MAD=${pct(m)}，剔除 ${shocks.size} 天` };
}

// ---------------- 样本量（式 A / 式 B） ----------------
function requiredDays(lambda, deltaInbox, relEffect) {
  if (!(deltaInbox > 0) || !(lambda > 0)) return Infinity;
  return (CFG.NORMALIZER * lambda * Math.pow(CFG.Z / (relEffect * deltaInbox), 2));
}

// ---------------- 经验贝叶斯收缩（Beta-Binomial，矩估计） ----------------
function shrinkage(stars) {
  const usable = stars.filter((s) => s.click > 0);
  if (usable.length < 8) {
    return { enabled: false, why: `有效明星数 ${usable.length} < 8，先验不稳，本轮回退原始值` };
  }
  const ps = usable.map((s) => s.inbox / s.click);
  const pbar = mean(ps);
  const s2 = mean(ps.map((p) => (p - pbar) ** 2));
  const denom = s2 > 0 ? pbar * (1 - pbar) / s2 - 1 : NaN;
  if (!(denom > 0)) return { enabled: false, why: '组内方差异常（s²=0 或 α+β≤0），回退原始值' };
  const sumAB = denom;
  const alpha = pbar * sumAB;
  const beta = sumAB - alpha;
  return { enabled: true, pbar, s2, alpha, beta, why: `p̄=${pct(pbar)}、s²=${s2.toFixed(5)}、α=${alpha.toFixed(2)}、β=${beta.toFixed(2)}` };
}

function shrunkenCpl(star, eb) {
  if (!eb.enabled || star.click <= 0) return null;
  const p = (star.inbox + eb.alpha) / (star.click + eb.alpha + eb.beta);
  return p > 0 ? star.spend / (p * star.click) : null;
}

// ---------------- 单个明星判定 ----------------
function judge(star, shocks, eb) {
  const days = star.days.filter((d) => !shocks.has(d.date));
  const n = days.length;
  const spend = sum(days.map((d) => d.spend));
  const inbox = sum(days.map((d) => d.inbox));
  const click = sum(days.map((d) => d.click));

  const base = {
    star: star.star,
    nDays: n,
    spend: r2(spend),
    inbox,
    click,
    cpl: inbox > 0 ? r2(spend / inbox) : null,
    cplShrunk: r2(shrunkenCpl({ ...star, spend, inbox, click }, eb)),
    avgYield: spend > 0 ? inbox / spend : null,
    marginalYield: null,
    ratio: null,
    needCut: null,
    needSat: null,
    verdict: 'INSUFFICIENT',
    reason: '',
    action: null
  };

  // 门 1：长尾（消耗太小直接不进判断池，M11 的 C 档），先判它，理由比"天数不够"更有用
  if (spend < CFG.MIN_SPEND) {
    base.reason = `窗口消耗 ${r2(spend)} 元 < ${CFG.MIN_SPEND} 元，属长尾，不进判断池（M11 的 C 档）`;
    return base;
  }
  // 门 2：天数
  if (n < CFG.MIN_DAYS) {
    base.reason = `天数 ${n} < 门槛 ${CFG.MIN_DAYS}，还差 ${CFG.MIN_DAYS - n} 天`;
    // 仍然算一下"统计上本来需要几天"，好让 explain 说清到底卡在哪
    const lam = n > 0 ? inbox / n : 0;
    const daily = days.map((d) => d.spend);
    let dsp = daily.length > 1 ? Math.max(...daily) - Math.min(...daily) : 0;
    if (dsp <= 0) dsp = 0.62 * (spend / Math.max(1, n)); // 单日无法估离散度 → 用 11-05 分布的经验系数（高46%/低16%）
    if (lam > 0 && dsp > 0 && base.avgYield) {
      const dInbox = base.avgYield * dsp;
      base.needCut = Math.ceil(requiredDays(lam, dInbox, 1));
      base.needSat = Math.ceil(requiredDays(lam, dInbox, CFG.EFFECT));
    }
    return base;
  }
  // 门 3：点击
  if (click < CFG.MIN_CLICKS) {
    base.reason = `点击 ${click} < ${CFG.MIN_CLICKS}，私信率不可估`;
    return base;
  }

  // 两档：高档 = 消耗最高的 30%；基准档 = 其余
  const sorted = [...days].sort((a, b) => b.spend - a.spend);
  const kHigh = Math.max(1, Math.ceil(sorted.length * CFG.HIGH_SHARE));
  const high = sorted.slice(0, kHigh);
  const rest = sorted.slice(kHigh);
  if (!rest.length) {
    base.reason = '高档占满全部天数，无法与基准档对比';
    return base;
  }
  const hs = mean(high.map((d) => d.spend));
  const ms = mean(rest.map((d) => d.spend));
  const hi = mean(high.map((d) => d.inbox));
  const mi = mean(rest.map((d) => d.inbox));
  const dx = hs - ms;
  const dy = hi - mi;

  if (!(dx > 0)) {
    base.reason = `高档与基准档日消耗无区分度（Δ=${r2(dx)} 元），边际无法估`;
    return base;
  }

  const lambda = inbox / n;
  const dInboxExpected = base.avgYield * dx;          // 恒定回报下应有的 Δ私信
  const needCut = requiredDays(lambda, dInboxExpected, 1);
  const needSat = requiredDays(lambda, dInboxExpected, CFG.EFFECT);
  base.needCut = Math.ceil(needCut);
  base.needSat = Math.ceil(needSat);

  const marginal = dy / dx;
  base.marginalYield = r2(marginal);
  base.ratio = base.avgYield ? r2(marginal / base.avgYield) : null;

  // 样本不够判 CUT → 直接 INSUFFICIENT
  if (n < needCut) {
    base.reason = `天数 ${n} < 判 CUT 所需 ${Math.ceil(needCut)} 天，连"该停"都判不了`;
    return base;
  }
  // 判 CUT：边际为负 / 或成本越红线且边际低于平均
  if (marginal <= 0) {
    base.verdict = 'CUT';
    base.reason = `边际产出 ${r2(marginal)} ≤ 0：再加钱不进私信`;
    base.action = `停或降 50%（-${r2(spend * 0.5)} 元）`;
    return base;
  }
  if (base.cpl && base.cpl > CFG.CPL_RED_LINE && marginal < base.avgYield) {
    base.verdict = 'CUT';
    base.reason = `私信成本 ${base.cpl} 元 > 红线 ${CFG.CPL_RED_LINE} 元，且边际已低于平均`;
    base.action = '停或降 50%';
    return base;
  }
  if (n < needSat) {
    base.reason = `边际方向偏${base.ratio >= 1 ? '好' : '差'}，但判加/衰还需 ${Math.ceil(needSat)} 天，现 ${n} 天，还差 ${Math.ceil(needSat - n)} 天`;
    return base;
  }
  if (base.ratio >= 1) {
    base.verdict = 'SCALE';
    base.reason = `边际 ${r2(marginal)} ≥ 平均 ${r2(base.avgYield)}（比值 ${base.ratio}）`;
    base.action = `小步加预算 ≤ ${Math.round(CFG.MAX_ADD * 100)}%（+${r2(spend * CFG.MAX_ADD)} 元），16:00 前加，人工确认`;
    return base;
  }
  base.verdict = base.ratio < CFG.SAT_RATIO ? 'SATURATING' : 'SATURATING';
  base.reason = `边际 ${r2(marginal)} < 平均 ${r2(base.avgYield)}（比值 ${base.ratio}${base.ratio < CFG.SAT_RATIO ? '，强衰减' : ''}）`;
  base.action = '不加；先查素材/定向，3 天后再看';
  return base;
}

// ---------------- 主流程 ----------------
function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const inFile = arg('--in', '');
  if (!inFile) {
    console.error('用法：node tools/judge_star.js --in <stars.json> [--days N] [--dry] [--explain] [--json out.json]');
    process.exit(2);
  }
  const fallbackDays = Number(arg('--days', '1')) || 1;
  const windowDays = argv.includes('--days') ? Number(arg('--days', '0')) || 0 : 0;
  const explain = argv.includes('--explain');
  const dry = argv.includes('--dry');
  const jsonOut = arg('--json', null);

  const rows0 = loadRows(inFile, fallbackDays);
  // --days N：只保留最近 N 个有数据的日期（有 date 字段时才生效；纯聚合输入仍按 fallbackDays 计）
  let rows = rows0;
  let windowNote = '';
  if (windowDays > 0) {
    const dates = [...new Set(rows0.map((r) => r.date).filter(Boolean))].sort();
    if (dates.length) {
      const keep = new Set(dates.slice(-windowDays));
      rows = rows0.filter((r) => keep.has(r.date));
      windowNote = `窗口 --days ${windowDays}：可用日期 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}），实际纳入 ${keep.size} 天`;
    } else {
      windowNote = `窗口 --days ${windowDays}：输入无 date 字段，按 ${fallbackDays} 天口径处理`;
    }
  }
  const stars = groupByStar(rows);
  const { shocks, info } = demandShockDates(stars);
  const eb = shrinkage(stars);

  const results = stars.map((s) => judge(s, shocks, eb)).sort((a, b) => (b.spend || 0) - (a.spend || 0));
  const counts = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});

  const line = '-'.repeat(96);
  const widths = [20, 5, 9, 6, 7, 8, 10, 7, 9, 9, 14];
  const padW = (s, w) => {
    const t = String(s);
    const disp = [...t].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    return t + ' '.repeat(Math.max(0, w - disp));
  };
  console.log('');
  console.log('明星级判定（观察性估计，非因果；来源：' + path.basename(inFile) + '）');
  console.log('参数：门槛 ' + CFG.MIN_DAYS + ' 天 / ' + CFG.MIN_SPEND + ' 元 / ' + CFG.MIN_CLICKS + ' 点击；两档 ' +
    Math.round(CFG.HIGH_SHARE * 100) + '%；需求冲击 z>' + CFG.SHOCK_Z);
  if (windowNote) console.log(windowNote);
  console.log('需求冲击：' + info);
  console.log('经验贝叶斯：' + (eb.enabled ? '启用（' + eb.why + '）' : '未启用（' + eb.why + '）'));
  console.log(line);
  console.log(['明星', '天数', '消耗', '私信', 'CPL', 'CPL收缩', '边际产出', '比值', '需n_CUT', '需n_SAT', '判定']
    .map((h, i) => padW(h, widths[i])).join(''));
  console.log(line);
  for (const r of results) {
    console.log([
      String(r.star),
      String(r.nDays),
      r.spend != null ? String(r.spend) : '-',
      String(r.inbox),
      r.cpl != null ? String(r.cpl) : '无',
      r.cplShrunk != null ? String(r.cplShrunk) : '-',
      r.marginalYield != null ? String(r.marginalYield) : 'n/a',
      r.ratio != null ? String(r.ratio) : 'n/a',
      r.needCut != null ? String(r.needCut) : '-',
      r.needSat != null ? String(r.needSat) : '-',
      r.verdict
    ].map((c, i) => padW(c, widths[i])).join(''));
  }
  console.log(line);
  console.log('汇总：' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join(' · '));
  console.log('注意：这是观察性估计，不是因果结论；加预算一律 ≤30% 且需人工确认（M12）。');

  if (explain) {
    console.log('');
    console.log('=== --explain：为什么这样判 ===');
    for (const r of results) {
      console.log('');
      console.log('· ' + r.star + ' → ' + r.verdict);
      console.log('  天数 ' + r.nDays + '｜消耗 ' + r.spend + ' 元｜私信 ' + r.inbox +
        '｜CPL ' + (r.cpl != null ? r.cpl + ' 元' : '无') +
        (r.cplShrunk != null ? '（收缩后 ' + r.cplShrunk + ' 元）' : ''));
      console.log('  统计门槛：判 CUT 需 ' + (r.needCut != null ? r.needCut : '不可估') +
        ' 天｜判加/衰需 ' + (r.needSat != null ? r.needSat : '不可估') + ' 天');
      if (r.verdict === 'INSUFFICIENT' && r.nDays < (r.needSat || Infinity)) {
        const gap = r.needSat != null ? Math.max(0, r.needSat - r.nDays) : null;
        if (gap != null) console.log('  → 还差 ' + gap + ' 天才能给"加/衰"的方向结论');
      }
      console.log('  原因：' + r.reason);
      if (r.action) console.log('  建议：' + r.action);
    }
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), dry, cfg: CFG, eb, shocks: [...shocks], results }, null, 2), 'utf8');
    console.log('\n已写出：' + jsonOut);
  }
}

main();
