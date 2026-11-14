import { createHash } from 'node:crypto';
import { toNumber } from './client.mjs';

const fleetType = '远征船';
const defaultPreset = 1;
const careers = ['坦克', '战士', '法师', '射手'];
const busy = new WeakSet();
const rows = (config, table) => config?.tables?.[table]?.data ?? [];

function formationMatches(formation, heroes) {
  if (formation?.presetId !== defaultPreset || formation.heroPositions?.length !== heroes.length) return false;
  return heroes.every(hero => formation.heroPositions.some(p =>
    p.heroId === hero.heroId && p.pos?.x === hero.x && p.pos?.y === hero.y));
}

export async function readFleetFormations(client, config, player) {
  const requiredLevel = rows(config, 'ModuleOpenCfg').find(r => r.moduleId === '世界')?.playerLevel;
  if (!Number.isSafeInteger(requiredLevel) || requiredLevel < 1) throw new Error('缺少世界开放等级配置');
  const locked = !Number.isSafeInteger(player?.level) || player.level < requiredLevel;
  const view = { locked, requiredLevel, docks: [] };
  if (locked) return view;
  const buildings = (await client.request('OnWaterRequest', {}, 'OnWaterResponse')).building;
  if (!Array.isArray(buildings)) throw new Error('无法确认已建成的远征舰队');
  const docks = buildings.filter(b => b.level > 0 && b.buildingId?.endsWith(fleetType))
    .sort((a, b) => a.buildingId.localeCompare(b.buildingId, 'zh-CN', { numeric: true }));
  if (!docks.length) return view;
  const fleets = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse')).fleets;
  const roster = (await client.request('AllHeroRequest', {}, 'AllHeroResponse')).heroes;
  if (!Array.isArray(fleets) || !Array.isArray(roster)) throw new Error('无法确认世界舰队或可用英雄');
  const occupied = new Set(docks.flatMap(dock => (dock.fleet?.formation?.heroPositions ?? []).map(p => p.heroId)));
  const configHeroes = new Map(rows(config, 'HeroCfg').map(h => [h.id, h]));
  const names = new Map(roster.map(h => [h.heroId, h.showName || configHeroes.get(h.heroId)?.name || h.heroId]));
  const slots = rows(config, 'FormationTypePositionCfg').filter(r => r.id === defaultPreset)
    .sort((a, b) => b.position[0] - a.position[0]);
  const capacity = rows(config, 'FormationHeroNumCfg').reduce((max, row) =>
    player.mainlineStage > row.mainlineStage ? Math.max(max, row.heroNum) : max, 0);
  if (!slots.length || slots.some(r => !Array.isArray(r.position) || r.position.length !== 2 || !r.position.every(Number.isSafeInteger))
    || new Set(slots.map(r => r.position.join(','))).size !== slots.length) throw new Error('缺少默认舰队阵型配置');
  const heroes = roster.filter(h => !occupied.has(h.heroId) && configHeroes.has(h.heroId))
    .sort((a, b) => toNumber(b.power ?? 0) - toNumber(a.power ?? 0) || a.heroId.localeCompare(b.heroId))
    .slice(0, Math.min(capacity, slots.length))
    .sort((a, b) => careers.indexOf(configHeroes.get(a.heroId).career) - careers.indexOf(configHeroes.get(b.heroId).career))
    .map((h, i) => ({ heroId: h.heroId, name: names.get(h.heroId), x: slots[i].position[0], y: slots[i].position[1] }));
  for (const b of docks) {
    const fleet = fleets.find(f => f.buildingId === b.buildingId);
    const formation = b.fleet?.formation;
    const saved = (formation?.heroPositions?.length ?? 0) > 0;
    const existing = (formation?.heroPositions ?? []).map(p => ({ heroId: p.heroId, name: names.get(p.heroId) ?? p.heroId, x: p.pos?.x, y: p.pos?.y }));
    const reason = saved ? '已有编队' : formation && (formation.presetId !== defaultPreset || toNumber(formation.petUid ?? 0) !== 0) ? '已有自定义阵型或海兽'
      : fleet && (fleet.state !== 1 || fleet.autoFight?.isOn || fleet.treasureLootUid || fleet.chipWar?.rewardTs) ? '舰队正在执行其他任务'
      : !capacity ? '尚未解锁编队位置' : !heroes.length ? '没有可编入的闲置英雄' : '';
    const number = b.buildingId.match(/^(\d+)/)?.[1];
    const name = number ? '远征舰队 ' + number + ' 队' : '远征舰队';
    const previewKey = reason ? null : createHash('sha256').update(JSON.stringify([b.buildingId, defaultPreset, heroes.map(h => [h.heroId,h.x,h.y])])).digest('hex');
    view.docks.push({ buildingId: b.buildingId, name, reason, previewKey, heroes: saved ? existing : reason ? [] : heroes, saved, visible: Boolean(fleet) });
  }
  return view;
}

export async function initializeFleetFormation(client, config, player, { buildingId, previewKey, enabled = () => true }) {
  if (busy.has(client)) throw new Error('另一支舰队正在编队，请稍后刷新');
  busy.add(client);
  try {
    const { docks } = await readFleetFormations(client, config, player);
    const dock = docks.find(d => d.buildingId === buildingId);
    if (!dock || dock.reason) throw new Error(dock?.reason || '远征舰队尚未解锁或建成');
    if (!previewKey || previewKey !== dock.previewKey) throw new Error('可用英雄或阵型已变化，请刷新后重新选择');
    if (!enabled()) throw new Error('账号已暂停或连接已更换');
    const heroPositions = dock.heroes.map(({ heroId, x, y }) => ({ heroId, pos: { x, y } }));
    await client.sendWatch('FleetSaveFormationRequest', { buildingId, formation: { presetId: defaultPreset, heroPositions } });
    const after = (await client.request('OnWaterRequest', {}, 'OnWaterResponse')).building?.find(b => b.buildingId === buildingId);
    if (!formationMatches(after?.fleet?.formation, dock.heroes)) throw new Error('服务端未确认这次首次编队，请刷新后查看');
    const saved = dock.name + '已编入' + dock.heroes.map(h => h.name).join('、');
    try {
      const fleets = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse')).fleets;
      if (!Array.isArray(fleets)) throw new Error('未收到世界舰队列表');
      const visible = fleets.some(f => f.buildingId === buildingId);
      return { heroes: dock.heroes, visible, label: saved + (visible ? '，已出现在世界舰队列表' : '，尚未出现在世界舰队列表') };
    } catch {
      return { heroes: dock.heroes, visible: null, label: saved + '，暂未能核对世界舰队列表' };
    }
  } finally {
    busy.delete(client);
  }
}
