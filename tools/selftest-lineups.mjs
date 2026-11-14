import assert from 'node:assert/strict';
import { getConfig } from '../src/config.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { applyLineup, lineupCatalog, readLineups } from '../src/lineups.mjs';

const protocol = loadProtocol();
const form = (id, formInfo, formId, heros, stances, pet = '') => ({
  id, formInfo, formId, pet,
  heros: heros.map(h => [h]), heroPos: heros.map(() => ['位']), heroStance: stances.map(s => [s]),
});
const slots = (id, positions) => positions.map(position => ({ id, position }));
const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }, { moduleId: '远征', playerLevel: 30 }, { moduleId: '跨服积分赛', playerLevel: 25 }] },
  LeagueDanCfg: { data: [{ dan: 1, teamCount: 2 }] },
  FormationHeroNumCfg: { data: [{ heroNum: 3, mainlineStage: 0 }] },
  FormationTypeUnlockCfg: { data: [{ id: 7, name: '攻速增强' }] },
  FormationTypePositionCfg: { data: [...slots(1, [[1, 1], [4, 4], [2, 2]]), ...slots(7, [[5, 5], [5, 1], [4, 6]])] },
  HeroCfg: { data: ['坦克', '战士', '法师', '射手', '坦克', '战士', '法师'].map((career, i) => ({ id: 'h' + i, name: '英雄' + i, career })) },
  HeroStrategyFormationCfg: { data: [
    form('a', '常规搭配', 7, ['h0', 'h1', 'h2'], ['5,5', '5,1', '4,6'], '海兽建议'),
    form('b', '世界BOSS阵容', 7, ['h0', 'h1', 'h2'], ['5,5', '5,1', '4,6']),
    form('c', 'PVP对战', 1, ['h3', 'h4', 'h5'], ['1,1', '4,4', '2,2']),
    form('d', '二队主C', 1, ['h4', 'h5', 'h6'], ['1,1', '4,4', '2,2']),
    form('bad-seat', '常规搭配', 7, ['h3', 'h5', 'h6'], ['1,1', '5,1', '4,6']),
    form('bad-hero', '常规搭配', 7, ['h0', 'h1', '不存在'], ['5,5', '5,1', '4,6']),
    form('bad-dup', '常规搭配', 7, ['h1', 'h3', 'h5'], ['5,1', '5,1', '4,6']),
  ] },
} };
const player = { level: 30, mainlineStage: 5 };

function fixture(overrides = {}) {
  const f = {
    heroes: [90, 80, 70, 60, 50, 40].map((power, i) => ({ heroId: 'h' + i, power: { low: power, high: 0, unsigned: false } })),
    presets: [7],
    mainline: { presetId: 1, heroPositions: [{ heroId: 'h3', pos: { x: 1, y: 1 } }], petUid: { low: 9, high: 0, unsigned: false } },
    water: [{ buildingId: '1远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: 'h0', pos: { x: 1, y: 1 } }] } } },
      { buildingId: '2远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: 'h3', pos: { x: 1, y: 1 } }] } } },
      { buildingId: '1舰队码头', level: 3 }],
    fleets: [{ buildingId: '1远征船', state: 1 }, { buildingId: '2远征船', state: 1 }],
    expedition: { raidId: 3, hero: [{ heroId: 'h0', hp: 100 }, { heroId: 'h1', hp: 100 }, { heroId: 'h2', hp: 0 }, { heroId: 'h3', hp: 5 }, { heroId: 'h4', hp: 5 }, { heroId: 'h5', hp: 5 }],
      formation: { presetId: 1, heroPositions: [], petUid: 0 } },
    league: { roomDan: 1, ownFormations: [{ index: 1, presetId: 1, heroPositions: [{ heroId: 'h5', pos: { x: 1, y: 1 } }], petUid: 0 }] },
    writes: [], names: [], failing: new Set(), staleSave: false,
    async request(name, body, response) {
      assert(protocol[name], name);
      assert(protocol[response], response);
      this.names.push(name);
      if (this.failing.has(name)) throw new Error('服务端拒绝');
      const replies = {
        AllHeroRequest: () => ({ heroes: this.heroes }),
        MyFormationPresetRequest: () => ({ ids: this.presets }),
        GetFormationRequest: () => ({ formation: this.mainline }),
        OnWaterRequest: () => ({ building: this.water }),
        MyFleetsRequest: () => ({ fleets: this.fleets }),
        ExpeditionInfoRequest: () => this.expedition,
        LeagueInfoRequest: () => this.league,
        SaveFormationRequest: () => { this.write(name, body); return { formation: this.staleSave ? this.mainline : body.formation }; },
        ExpeditionSaveFormationRequest: () => { this.write(name, body); return { formation: body.formation }; },
        LeagueSaveFormationRequest: () => { this.write(name, body); return { formations: [...this.league.ownFormations.filter(t => t.index !== body.formation.index), body.formation] }; },
      };
      assert(replies[name], name);
      return structuredClone(replies[name]());
    },
    async sendWatch(name, body) {
      this.write(name, body);
      if (!this.staleSave) this.water.find(b => b.buildingId === body.buildingId).fleet = { formation: structuredClone(body.formation) };
    },
    write(name, body) {
      assert(protocol[name], name);
      const decoded = protocol[name].decode(protocol[name].encode(body).finish());
      assert.equal(decoded.formation.heroPositions.length, body.formation.heroPositions.length);
      this.writes.push({ name, body });
    },
    target(key, view) { return view.targets.find(t => t.key === key); },
    ...overrides,
  };
  return f;
}

{
  const catalog = lineupCatalog(config);
  assert.equal(catalog.length, 3, 'drops bad rows and merges duplicate lineups');
  assert.deepEqual(catalog[0].labels, ['常规搭配', '世界BOSS阵容']);
}

{
  const f = fixture();
  const view = await readLineups(f, config, player);
  assert.deepEqual(view.targets.map(t => t.key), ['mainline', 'fleet:1远征船', 'fleet:2远征船', 'expedition:3', 'league:1', 'league:2']);
  assert.equal(JSON.parse(JSON.stringify(view)).targets.length, 6, 'view is JSON safe');
  assert(view.targets.every(t => !('save' in t)));
  assert.equal(f.writes.length, 0, 'reading never writes');

  const mainline = f.target('mainline', view);
  assert.equal(mainline.current.power, 60);
  assert.equal(mainline.recommended[0].label, '常规搭配 / 世界BOSS阵容');
  assert.equal(mainline.recommended[0].power, 240);
  assert.equal(mainline.recommended[0].delta, 180);
  assert.equal(mainline.recommended[0].presetName, '攻速增强');
  assert.equal(mainline.recommended[0].pet, '海兽建议');
  assert.deepEqual(mainline.near[0].missing, ['英雄6'], 'names the missing hero');
  assert.equal(mainline.recommended.some(r => r.label === '二队主C'), false);

  const first = f.target('fleet:1远征船', view);
  assert.deepEqual(first.recommended.map(r => r.label), ['常规搭配 / 世界BOSS阵容'], 'h3 is locked in the other fleet');
  assert.match(first.near[0].blocked[0], /英雄3（在远征舰队 2 队）/);

  const expedition = f.target('expedition:3', view);
  assert.equal(expedition.recommended[0].label, 'PVP对战', 'dead hero h2 blocks the higher power lineup');
  assert.match(expedition.near.find(n => n.label.startsWith('常规')).blocked[0], /英雄2（已阵亡）/);

  assert.equal(f.target('league:1', view).recommended[0].label, 'PVP对战', 'league prefers PVP lineups and a team may keep its own heroes');
  assert.equal(f.target('league:2', view).recommended[0].label, '常规搭配 / 世界BOSS阵容');
  assert.match(f.target('league:2', view).near.find(n => n.label === 'PVP对战').blocked[0], /英雄5（在第 1 队）/);
}

{
  const f = fixture();
  const pick = await readLineups(f, config, player);
  const mainline = f.target('mainline', pick).recommended[0];
  await assert.rejects(applyLineup(f, config, player, { targetKey: 'mainline', previewKey: mainline.previewKey, enabled: () => false }), /暂停/);
  assert.equal(f.writes.length, 0);
  const saved = await applyLineup(f, config, player, { targetKey: 'mainline', previewKey: mainline.previewKey });
  assert.match(saved.label, /主线闯关已换成「常规搭配 \/ 世界BOSS阵容」.*原阵容：英雄3/);
  const write = f.writes.at(-1);
  assert.equal(write.body.module, 1);
  assert.equal(write.body.formation.presetId, 7);
  assert.deepEqual(write.body.formation.petUid, { low: 9, high: 0, unsigned: false }, 'keeps the assigned sea beast');
  assert.deepEqual(write.body.formation.heroPositions[0], { heroId: 'h0', pos: { x: 5, y: 5 } });
  f.mainline = write.body.formation;
  await assert.rejects(applyLineup(f, config, player, { targetKey: 'mainline', previewKey: mainline.previewKey }), /已变化/, 'replaying a stale preview does nothing');
  assert.equal(f.writes.length, 1);
  const again = await readLineups(f, config, player);
  const same = f.target('mainline', again).recommended.find(r => r.isCurrent);
  assert(same && same.previewKey === null && same.delta === 0, 'an already applied lineup cannot be applied again');
}

{
  const f = fixture();
  const pick = f.target('fleet:1远征船', await readLineups(f, config, player)).recommended[0];
  await applyLineup(f, config, player, { targetKey: 'fleet:1远征船', previewKey: pick.previewKey });
  const write = f.writes.at(-1);
  assert.equal(write.name, 'FleetSaveFormationRequest');
  assert.equal(write.body.buildingId, '1远征船');
  assert.equal('petUid' in write.body.formation, false, 'matches the client, which never sends a pet for fleets');

  const busy = fixture({ fleets: [{ buildingId: '1远征船', state: 3 }, { buildingId: '2远征船', state: 1 }] });
  const target = busy.target('fleet:1远征船', await readLineups(busy, config, player));
  assert.match(target.reason, /其他任务/);
  await assert.rejects(applyLineup(busy, config, player, { targetKey: target.key, previewKey: target.recommended[0].previewKey }), /其他任务/);
  assert.equal(busy.writes.length, 0);

  const ignored = fixture();
  const preview = ignored.target('fleet:1远征船', await readLineups(ignored, config, player)).recommended[0];
  ignored.staleSave = true;
  await assert.rejects(applyLineup(ignored, config, player, { targetKey: 'fleet:1远征船', previewKey: preview.previewKey }), /未确认/);
}

{
  const f = fixture();
  const pick = f.target('expedition:3', await readLineups(f, config, player)).recommended[0];
  await applyLineup(f, config, player, { targetKey: 'expedition:3', previewKey: pick.previewKey });
  assert.equal(f.writes.at(-1).name, 'ExpeditionSaveFormationRequest');
  assert.equal(f.writes.at(-1).body.raidId, 3);

  const league = fixture();
  const second = league.target('league:2', await readLineups(league, config, player)).recommended[0];
  await applyLineup(league, config, player, { targetKey: 'league:2', previewKey: second.previewKey });
  const write = league.writes.at(-1);
  assert.equal(write.name, 'LeagueSaveFormationRequest');
  assert.equal(write.body.formation.index, 2, 'league team numbers start at 1');
}

{
  const f = fixture({ presets: [] });
  const view = await readLineups(f, config, player);
  const locked = f.target('mainline', view).recommended.find(r => r.label.startsWith('常规'));
  assert.equal(locked.presetId, 1);
  assert.match(locked.note, /攻速增强尚未解锁/);
  assert.deepEqual(locked.heroPositions.map(p => [p.heroId, p.pos.x]), [['h0', 4], ['h1', 2], ['h2', 1]], 'front seats go to tanks first, like the client');
}

{
  const seats = ['5,5', '5,1', '4,6'];
  const twins = { tables: { ...config.tables, HeroStrategyFormationCfg: { data: [
    form('x', '平民国家队', 7, ['h0', 'h1', 'h2'], seats),
    form('y', '中期', 7, ['h1', 'h2', 'h0'], seats),
  ] } } };
  const f = fixture({ presets: [] });
  const mainline = f.target('mainline', await readLineups(f, twins, player));
  assert.equal(mainline.recommended.length, 1, 'same seats after the preset fallback show once');
  assert.equal(mainline.recommended[0].label, '平民国家队 / 中期');
  const unlocked = fixture();
  assert.equal(unlocked.target('mainline', await readLineups(unlocked, twins, player)).recommended.length, 2, 'different seats stay separate choices');
  const sameCareer = { tables: { ...config.tables, HeroStrategyFormationCfg: { data: [
    form('x', '甲', 7, ['h0', 'h4', 'h1'], seats),
    form('y', '乙', 7, ['h4', 'h0', 'h1'], seats),
  ] } } };
  const tied = fixture({ presets: [] });
  assert.equal(tied.target('mainline', await readLineups(tied, sameCareer, player)).recommended.length, 1, 'heroes of the same career get stable default seats');
  const missing = fixture({ heroes: [{ heroId: 'h0', power: 1 }, { heroId: 'h1', power: 1 }] });
  assert.equal(missing.target('mainline', await readLineups(missing, twins, player)).near.length, 1, 'one near miss per hero set');
}

{
  const low = await readLineups(fixture(), config, { level: 20, mainlineStage: 5 });
  assert.match(low.targets.find(t => t.key === 'expedition').reason, /30 级/);
  assert.match(low.targets.find(t => t.key === 'league').reason, /25 级/);

  const failed = fixture();
  failed.failing.add('LeagueInfoRequest');
  const view = await readLineups(failed, config, player);
  assert.match(view.targets.find(t => t.key === 'league').reason, /读取失败：服务端拒绝/);
  assert(view.targets.find(t => t.key === 'mainline').recommended.length, 'one failed mode leaves the others usable');
  await assert.rejects(applyLineup(failed, config, player, { targetKey: 'league', previewKey: 'x' }), /读取失败/);

  const notStarted = fixture({ expedition: { raidId: 0, hero: [] } });
  assert.match((await readLineups(notStarted, config, player)).targets.find(t => t.key === 'expedition').reason, /先在游戏内开始远征/);
}

{
  const real = getConfig();
  if (real) {
    const catalog = lineupCatalog(real);
    assert(catalog.length >= 20, 'the real strategy table still yields lineups');
    const known = new Set(real.tables.HeroCfg.data.map(h => h.id));
    const allowed = new Map();
    for (const row of real.tables.FormationTypePositionCfg.data) allowed.set(row.id, [...(allowed.get(row.id) ?? []), row.position.join(',')]);
    for (const lineup of catalog) {
      assert(lineup.members.every(m => known.has(m.heroId)));
      assert(lineup.members.every(m => allowed.get(lineup.presetId).includes(m.x + ',' + m.y)), lineup.labels.join());
    }
  }
}

console.log('lineups ok: catalog cleanup, per-mode targets, hero conflicts, preset fallback, stale previews, write confirmation');
