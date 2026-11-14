// 只读探测：海面世界（建筑 / 工厂 / 居民订单）与任务（主线 / 支线）的实时状态。
// 全部是信息类请求，不改账号状态。用法: node tools/probe-world.mjs
import fs from 'node:fs';
import path from 'node:path';
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { getConfig } from '../src/config.mjs';

const CREDENTIALS = path.resolve(import.meta.dirname, '../data/credentials.json');
const raw = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
const protocol = loadProtocol();
const config = getConfig();
const client = new GameClient({ url: raw.url || raw.wsUrl, protocol });
client.on('warn', (message) => console.log(`warn: ${message}`));

const login = await client.connect(raw.login || raw.body);
console.log(`login ok: ${login.playerInfo?.nickname} lv${login.playerInfo?.level}`);

const get = async (name, body = {}) => {
  const responseName = `${name.slice(0, -7)}Response`;
  try {
    return await client.request(name, body, responseName, 8000);
  } catch (error) {
    console.log(`! ${name} 失败: ${error.message}`);
    return null;
  }
};

const itemList = await get('AllItemRequest');
const items = new Map();
for (const item of itemList?.items ?? []) {
  const id = item.itemId ?? item.id;
  items.set(id, (items.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
}
const resList = await get('AllResourceRequest');
const res = new Map((resList?.list ?? []).map((e) => [e.res, Number(e.amount ?? 0)]));

const num = (v) => (v == null ? 0 : typeof v === 'object' ? (v.low ?? 0) + (v.high ?? 0) * 4294967296 : Number(v));
const have = (id) => (items.get(id) ?? 0) + (res.get(resName(id)) ?? 0);
function resName(id) {
  const row = (config.tables.ResourceCfg?.data ?? []).find((r) => r.id === id || r.res === id);
  return row?.name ?? String(id);
}

// --- 主线 / 支线任务 ---------------------------------------------------------
const main = await get('MainTaskInfoRequest');
const tasks = main?.task ? [main.task] : [];
const branch = main?.branch ?? [];
console.log(`\n=== 任务: 主线 ${tasks.length} 条, 支线 ${branch.length} 条`);
if (tasks.length) console.log('  mainTask', JSON.stringify(main.task));
const claimableBranch = branch.filter((t) => !t.rewardClaimed);
console.log(`  支线可领 ${claimableBranch.length}/${branch.length}`);
for (const t of branch.slice(0, 8)) console.log('   ', JSON.stringify(t));

// --- 海面世界 ---------------------------------------------------------------
const water = await get('OnWaterRequest');
if (water) {
  console.log(`\n=== 海面: 建筑 ${water.building?.length ?? 0}, 居民订单 ${water.workerOrder?.length ?? 0}`);
  console.log('  orderOfTheDay', JSON.stringify(water.orderOfTheDay));
  console.log(`  autoProduceEndTime=${water.autoProduceEndTime} autoProduceForever=${water.autoProduceForever} autoFarming=${water.autoFarming}`);

  const now = Date.now() / 1000;
  let collectable = 0;
  let building = 0;
  const rows = [];
  for (const b of water.building ?? []) {
    const products = b.factory?.finishedProducts ?? [];
    const jobs = b.factory?.factoryQ ?? [];
    const buildingUp = b.buildFinishTime > 0;
    if (products.length) collectable += 1;
    if (buildingUp) building += 1;
    if (products.length || buildingUp || jobs.length) {
      rows.push({
        id: b.buildingId,
        lv: b.level,
        products: products.map((p) => `${p.id}x${num(p.num)}`).join(','),
        jobs: jobs.map((j) => `${j.productId}@${j.finishTime}`).join(','),
        build: buildingUp ? `${b.buildStartTime}->${b.buildFinishTime} (${b.buildFinishTime - now > 0 ? Math.round(b.buildFinishTime - now) + 's left' : 'done'})` : '',
        auto: b.auto,
      });
    }
  }
  console.log(`  有成品待收的建筑 ${collectable}, 正在建造/升级的建筑 ${building}`);
  for (const r of rows.slice(0, 25)) console.log('   ', JSON.stringify(r));

  console.log('\n  居民订单:');
  for (const o of water.workerOrder ?? []) {
    const need = (o.requirements ?? []).map((r) => `${r.id} ${num(r.num)}(有${have(r.id)})`).join(' + ');
    const enough = (o.requirements ?? []).every((r) => have(r.id) >= num(r.num));
    console.log(`   idx=${o.index} worker=${o.workerId} special=${o.isSpecial} ${enough ? '材料够' : '材料缺'} | ${need}`);
  }
}

// --- 资源田 -----------------------------------------------------------------
const fields = await get('MyResFieldsRequest');
console.log('\n=== 资源田', JSON.stringify(fields));

// --- 工厂生产配额 -----------------------------------------------------------
const waterBuildings = new Map((water?.building ?? []).map((b) => [b.buildingId, b]));
const makeable = [];
for (const row of config.tables.BuildingProduceCfg?.data ?? []) {
  const b = waterBuildings.get(row.buildType);
  if (!b) continue;
  const missing = (row.costItem ?? []).filter(([id, n]) => have(id) < n).map(([id, n]) => `${id} ${have(id)}/${n}`);
  makeable.push({ build: row.buildType, lv: b.level, item: row.itemId, time: row.produceTime, ok: !missing.length, missing });
}
console.log(`\n=== 可生产项 ${makeable.length}（建筑已存在且配方匹配）`);
for (const m of makeable.slice(0, 20)) console.log('   ', JSON.stringify(m));

client.stop();
