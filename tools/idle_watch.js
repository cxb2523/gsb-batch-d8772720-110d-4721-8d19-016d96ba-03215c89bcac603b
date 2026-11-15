#!/usr/bin/env node
/**
 * idle_watch.js —— 空耗名单快照 + 差集（只做这两件事，不改任何判定逻辑）
 *
 * 背景：平台只给"空耗 58 个 / 153.22 元"这种汇总数，没有"变化明细"接口。
 * 只有两份名单才能做差集 —— 所以每次取数落一份快照，下次自动对比。
 *
 * 用法
 *   node tools/idle_watch.js --overview data/overview-20261109-1702.json
 *   node tools/idle_watch.js --idle data/idle-now.json          # 精简格式 [{id,name,cost,star,paused}]
 *   node tools/idle_watch.js --idle ... --dry                   # 只算不落盘
 *
 * 规约：快照文件 data/idle-YYYYMMDD-HHmm.json；对比对象 = 目录里除本次外最新的那份。
 * 不读接口、不联网、不发通知。判定阈值（50 元门槛等）一律不在这里改。
 */

'use strict';
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; }

/** 统一成 {id,name,cost,star,paused} */
function normalize(item) {
  const cost = Number(item.cost ?? item.fee ?? 0);
  return {
    id: item.id ?? item.cid ?? item.creativeId ?? null,
    name: item.name ?? item.creative_name ?? '',
    cost: Math.round(cost * 100) / 100,
    star: item.star ?? item.starCity ?? '',
    plan: item.plan ?? item.planName ?? '',
    paused: item.paused === true || item.status === '已暂停',
    inbox: Number(item.inbox ?? item.inboxCount ?? 0)
  };
}

function loadItems(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(raw.idle)) list = raw.idle;
  else if (Array.isArray(raw.items)) list = raw.items;   // 本工具自己落盘的快照格式
  else if (Array.isArray(raw.top_creatives)) {
    // overview 原文：自己筛"消耗>0 且 私信=0"
    list = raw.top_creatives
      .map((c) => ({ id: c.cid, name: c.name, cost: c.cost, star: c.starCity, plan: c.planName, paused: c.paused, status: c.status, inbox: c.inboxCount }))
      .filter((c) => Number(c.cost) > 0 && !(Number(c.inbox) > 0));
  } else throw new Error('无法识别的输入格式：' + file);
  const items = list.map(normalize).filter((x) => x.name);
  const total = items.reduce((s, x) => s + x.cost, 0);

  // 预算与账户快照：有就记，没有就是 null（不猜）
  const num = (v) => { const x = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(x) ? x : null; };
  const meta = {
    budget_daily: raw.budget ? num(raw.budget.budget) : (raw.meta && raw.meta.budget_daily != null ? raw.meta.budget_daily : null),
    budget_balance: raw.budget ? num(raw.budget.balance) : (raw.meta && raw.meta.budget_balance != null ? raw.meta.budget_balance : null),
    budget_ts: raw.budget ? raw.budget.ts : (raw.meta ? raw.meta.budget_ts : null),
    account_cost: raw.summary ? raw.summary.cost : (raw.meta ? raw.meta.account_cost : null),
    account_inbox: raw.summary ? raw.summary.inbox_count : (raw.meta ? raw.meta.account_inbox : null),
    idle_cost: raw.summary ? raw.summary.idle_cost : (raw.meta ? raw.meta.idle_cost : null),
    idle_creatives: raw.summary ? raw.summary.idle_creatives : (raw.meta ? raw.meta.idle_creatives : null),
    last_run: raw.summary ? raw.summary.last_run : (raw.meta ? raw.meta.last_run : null)
  };
  return { items, total: Math.round(total * 100) / 100, meta };
}

function findPrev(dir, currentPath) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^idle-\d{8}-\d{4}\.json$/.test(f))
    .map((f) => ({ f, p: path.join(dir, f) }))
    .filter((x) => path.resolve(x.p) !== path.resolve(currentPath))
    .sort((a, b) => a.f.localeCompare(b.f));
  return files.length ? files[files.length - 1].p : null;
}

function main() {
  const overview = arg('--overview', '');
  const idleFile = arg('--idle', '');
  const input = overview || idleFile;
  if (!input) {
    console.error('用法：node tools/idle_watch.js --overview <overview.json> | --idle <idle.json> [--out dir] [--dry]');
    process.exit(2);
  }

  const { items, total, meta } = loadItems(input);
  const outDir = arg('--out', path.join(process.cwd(), 'data'));
  const outPath = path.join(outDir, `idle-${stamp()}.json`);
  const prevPath = findPrev(outDir, outPath);
  const prevSnap = prevPath ? loadItems(prevPath) : null;

  const byName = (arr) => new Map(arr.map((x) => [x.name + '|' + (x.id || ''), x]));
  const cur = byName(items);
  const prev = prevSnap ? byName(prevSnap.items) : new Map();

  const added = [];
  const removed = [];
  if (prevPath) {
    for (const [k, v] of cur) if (!prev.has(k)) added.push(v);
    for (const [k, v] of prev) if (!cur.has(k)) removed.push(v);
  }

  console.log('');
  console.log('空耗名单快照' + (has('--dry') ? '（--dry：不落盘）' : ''));
  console.log(`本次：${items.length} 条 / ${total} 元｜输入：${path.basename(input)}`);
  console.log('对比基线：' + (prevPath ? path.basename(prevPath) : '（无历史快照，本次只落盘不做差集）'));

  if (prevPath) {
    console.log(`\n新增空耗（${added.length} 条，合计 ${Math.round(added.reduce((s, x) => s + x.cost, 0) * 100) / 100} 元）：`);
    if (!added.length) console.log('  （无）');
    for (const a of added.sort((x, y) => y.cost - x.cost)) console.log(`  + ${a.cost} 元  ${a.name}${a.star ? '  [' + a.star + ']' : ''}${a.paused ? '  已暂停' : '  ⚠️ 仍在投'}`);

    console.log(`\n退出空耗（${removed.length} 条）：`);
    if (!removed.length) console.log('  （无）');
    for (const r of removed.sort((x, y) => y.cost - x.cost)) console.log(`  - ${r.cost} 元  ${r.name}`);
  }

  const still = items.filter((x) => !x.paused);
  if (still.length) {
    console.log(`\n⚠️ 空耗但状态仍是「在投」的创意 ${still.length} 条（这些还会继续花钱）：`);
    for (const s of still.sort((x, y) => y.cost - x.cost)) console.log(`  · ${s.cost} 元  ${s.name}`);
  }

  // 预算/账户快照对比：预算被改动必须机器报出来，不靠口头
  const pm = prevSnap ? prevSnap.meta : null;
  if (pm) {
    const changed = [];
    const cmp = (label, a, b, unit) => {
      if (a != null && b != null && Math.abs(a - b) > 1e-9) changed.push(`  ⚠️ ${label}：${a}${unit} → ${b}${unit}`);
    };
    cmp('日预算', pm.budget_daily, meta.budget_daily, ' 元');
    console.log('\n账户快照对比（' + (pm.budget_ts || '无时间戳') + ' → ' + (meta.budget_ts || '无时间戳') + '）：');
    if (changed.length) changed.forEach((c) => console.log(c));
    else console.log('  日预算未变' + (meta.budget_daily != null ? `（${meta.budget_daily} 元）` : ''));
    const dCost = (meta.account_cost != null && pm.account_cost != null) ? Math.round((meta.account_cost - pm.account_cost) * 100) / 100 : null;
    const dInbox = (meta.account_inbox != null && pm.account_inbox != null) ? meta.account_inbox - pm.account_inbox : null;
    const dIdle = (meta.idle_cost != null && pm.idle_cost != null) ? Math.round((meta.idle_cost - pm.idle_cost) * 100) / 100 : null;
    if (dCost != null) console.log(`  消耗：${pm.account_cost} → ${meta.account_cost}（Δ ${dCost > 0 ? '+' : ''}${dCost}）`);
    if (dInbox != null) console.log(`  私信：${pm.account_inbox} → ${meta.account_inbox}（Δ ${dInbox > 0 ? '+' : ''}${dInbox}）`);
    if (dCost != null && dInbox != null && dInbox > 0) console.log(`  → 边际 CPL = ${Math.round((dCost / dInbox) * 100) / 100} 元/条`);
    if (dIdle != null) console.log(`  空耗：${pm.idle_cost} → ${meta.idle_cost}（Δ ${dIdle > 0 ? '+' : ''}${dIdle}），空耗创意 ${pm.idle_creatives} → ${meta.idle_creatives}`);
  }

  if (!has('--dry')) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ ts: stamp(), count: items.length, total, meta, items }, null, 2), 'utf8');
    console.log('\n已落盘：' + outPath);
  }
}

main();
