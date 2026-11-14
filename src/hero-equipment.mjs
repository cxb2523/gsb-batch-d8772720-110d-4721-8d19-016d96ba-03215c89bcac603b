import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';

const types = ['武器', '防具', '饰品'];
const ironId = '精铁';
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const maxUid = (1n << 63n) - 1n;

// Equipment IDs are int64. Never round-trip them through an unsafe JS number.
export function uidText(uid) {
  let n;
  if (typeof uid === 'string' && /^[1-9]\d{0,18}$/.test(uid)) n = BigInt(uid);
  else if (Number.isSafeInteger(uid)) n = BigInt(uid);
  else if (Number.isInteger(uid?.low) && Number.isInteger(uid.high)) n = (BigInt(uid.high) << 32n) + BigInt(uid.low >>> 0);
  return n > 0n && n <= maxUid ? n.toString() : null;
}

function wireUid(uid) {
  const n = BigInt(uid);
  return { low: Number(BigInt.asIntN(32, n)), high: Number(n >> 32n), unsigned: false };
}

function ownership(roster) {
  const map = new Map();
  for (const hero of roster) {
    for (const equip of hero.equips ?? []) {
      const id = uidText(equip.uid);
      if (!id || map.has(id)) throw new Error('无法确认装备归属，请刷新英雄装备');
      map.set(id, hero.heroId);
    }
  }
  return map;
}

function requireList(value, label) {
  if (!Array.isArray(value)) throw new Error('未能读取' + label);
  return value;
}

export async function readHeroEquipment(client, config, playerLevel) {
  const requiredLevel = rows(config, 'ModuleOpenCfg').find(r => r.moduleId === '英雄装备')?.playerLevel;
  if (!Number.isSafeInteger(requiredLevel) || requiredLevel < 1) throw new Error('缺少英雄装备开放等级配置');
  const ironName = displayMaterial(config, ironId);
  const view = { locked: !Number.isSafeInteger(playerLevel) || playerLevel < requiredLevel, requiredLevel, ironName, iron: 0, heroes: [], items: [] };
  if (view.locked) return view;
  const inventory = requireList((await client.request('EquipsRequest', {}, 'EquipsResponse')).equip, '装备仓库');
  const roster = requireList((await client.request('AllHeroRequest', {}, 'AllHeroResponse')).heroes, '英雄列表');
  const bag = requireList((await client.request('AllItemRequest', {}, 'AllItemResponse')).items, '材料库存');
  view.iron = toNumber(bag.find(item => item.itemId === ironId)?.num ?? 0);
  if (!Number.isSafeInteger(view.iron) || view.iron < 0) throw new Error('无法确认强化石库存');
  const owners = ownership(roster);
  const base = new Map(rows(config, 'EquipCfg').map(r => [r.id, r]));
  const itemsByUid = new Map();
  for (const equip of inventory) {
    const uid = uidText(equip.uid);
    if (!uid || itemsByUid.has(uid)) throw new Error('无法确认装备编号，请刷新装备仓库');
    const cfg = base.get(equip.equipId);
    const level = equip.level ?? 0, star = equip.star ?? 0;
    const max = rows(config, 'EquipAttrCfg').find(r => r.id === equip.equipId && Number(r.star) === star)?.maxLv;
    const cost = rows(config, 'EquipUpDecomposeCfg').find(r => r.level === level + 1)?.upgradeCost;
    const nextCost = cfg && Number.isSafeInteger(max) && level < max && Number.isSafeInteger(cost) && cost >= 0 ? cost : null;
    const item = { uid, name: cfg?.name || '未知装备', type: cfg?.type ?? '', qualityIndex: cfg?.qualityIndex ?? 0,
      level, star, owner: owners.get(uid) ?? null, maxLevel: max ?? null, nextCost };
    itemsByUid.set(uid, item);
    view.items.push(item);
  }
  // Fail closed if an occupied slot cannot be resolved from the two snapshots.
  for (const uid of owners.keys()) if (!itemsByUid.has(uid)) throw new Error('英雄装备与仓库记录不一致，请刷新');
  const idle = view.items.filter(item => !item.owner && types.includes(item.type)).sort((a, b) =>
    b.qualityIndex - a.qualityIndex || b.star - a.star || b.level - a.level);
  view.heroes = roster.map(hero => {
    const worn = (hero.equips ?? []).map(e => itemsByUid.get(uidText(e.uid)));
    const knownSlots = worn.every(item => types.includes(item.type)) && new Set(worn.map(item => item.type)).size === worn.length;
    const slots = types.map(type => {
      const item = worn.find(e => e.type === type) ?? null;
      return { type, item, suggested: !item && knownSlots ? idle.find(e => e.type === type) ?? null : null };
    });
    return { heroId: hero.heroId, name: hero.showName || rows(config, 'HeroCfg').find(r => r.id === hero.heroId)?.name || hero.heroId, slots };
  });
  return view;
}

export async function equipHeroEmptySlots(client, config, playerLevel, heroId, enabled = () => true) {
  let state = await readHeroEquipment(client, config, playerLevel);
  if (state.locked) throw new Error('英雄装备尚未开放');
  const result = { count: 0, lines: [] };
  for (const type of types) {
    const hero = state.heroes.find(h => h.heroId === heroId);
    if (!hero) throw new Error('尚未拥有该英雄');
    const candidate = hero.slots.find(slot => slot.type === type)?.suggested;
    if (!candidate) continue;
    try {
      if (!enabled()) throw new Error('账号已暂停或连接已更换');
      await client.sendWatch('PutOnEquipRequest', { uid: wireUid(candidate.uid), heroId });
      state = await readHeroEquipment(client, config, playerLevel);
      if (state.items.find(item => item.uid === candidate.uid)?.owner !== heroId) throw new Error('服务端未确认穿戴');
      result.lines.push(hero.name + '装备了' + candidate.name + '（' + type + '）');
      result.count++;
    } catch (error) {
      throw new Error((result.lines.length ? result.lines.join('；') + '。' : '') + candidate.name + '穿戴失败：' + error.message);
    }
  }
  if (!result.count) result.lines.push('没有可填入空槽的闲置装备');
  return result;
}

export async function enhanceHeroEquipment(client, config, playerLevel, { uid, expectedLevel, maxCost, enabled = () => true }) {
  if (typeof uid !== 'string' || uidText(uid) !== uid || !Number.isSafeInteger(expectedLevel) || expectedLevel < 0
    || !Number.isSafeInteger(maxCost) || maxCost < 0) throw new Error('请刷新装备等级与强化费用');
  const state = await readHeroEquipment(client, config, playerLevel);
  if (state.locked) throw new Error('英雄装备尚未开放');
  const item = state.items.find(e => e.uid === uid);
  if (!item || item.level !== expectedLevel) throw new Error('装备已变化，请刷新后选择');
  if (item.nextCost === null) throw new Error('装备已满级或缺少强化配置');
  if (item.nextCost > maxCost) throw new Error('强化费用已变化，请刷新后确认');
  if (state.iron < item.nextCost) throw new Error(state.ironName + '不足，本次需 ' + item.nextCost + '，现有 ' + state.iron);
  if (!enabled()) throw new Error('账号已暂停或连接已更换');
  await client.sendWatch('EnhanceEquipRequest', { uid: wireUid(uid) });
  const equips = requireList((await client.request('EquipsRequest', {}, 'EquipsResponse')).equip, '装备仓库');
  if (equips.find(e => uidText(e.uid) === uid)?.level !== expectedLevel + 1) throw new Error('服务端未确认装备提升一级，请刷新后查看');
  return { uid, level: expectedLevel + 1, cost: item.nextCost, label: item.name + '强化至 ' + (expectedLevel + 1) + ' 级，消耗' + state.ironName + ' ×' + item.nextCost };
}
