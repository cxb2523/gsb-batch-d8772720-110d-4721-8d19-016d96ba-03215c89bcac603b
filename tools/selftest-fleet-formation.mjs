import assert from 'node:assert/strict';
import { initializeFleetFormation, readFleetFormations } from '../src/fleet-formation.mjs';

const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }] },
  FormationTypePositionCfg: { data: [{ id: 1, position: [1,3] }, { id: 1, position: [4,4] }] },
  FormationHeroNumCfg: { data: [{ heroNum: 1, mainlineStage: 0 }, { heroNum: 2, mainlineStage: 10 }] },
  HeroCfg: { data: ['坦克','战士','射手','法师'].map((career, i) => ({ id: 'h'+i, name: '英雄'+i, career })) },
} };
const player = { level: 16, mainlineStage: 11 };
const id = '1远征船';
function fixture() {
  const mock = {
    water: [{ buildingId: id, level: 1 }, { buildingId: '1舰队码头', level: 3 },
      { buildingId: '2远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: 'h1', pos: {x:1,y:3} }] } } }],
    heroes: [20,200,50,10].map((power,i) => ({ heroId: 'h'+i, power })),
    fleets: [], calls: [], writes: [],
    async request(name) {
      this.calls.push(name);
      if (name === 'OnWaterRequest') return { building: structuredClone(this.water) };
      if (name === 'MyFleetsRequest') return { fleets: structuredClone(this.fleets) };
      if (name === 'AllHeroRequest') return { heroes: structuredClone(this.heroes) };
      assert.fail(name);
    },
    async sendWatch(name, body) {
      assert.equal(name, 'FleetSaveFormationRequest');
      this.writes.push(body);
      this.water[0].fleet = { formation: structuredClone(body.formation) };
    },
    preview() { return readFleetFormations(this,config,player).then(view => view.docks[0]); },
    init(preview, enabled) { return initializeFleetFormation(this,config,player,{ buildingId: preview.buildingId, previewKey: preview.previewKey, enabled }); },
  };
  return mock;
}

{
  const f = fixture();
  assert((await readFleetFormations(f,config,{level:15})).locked);
  assert.equal(f.calls.length,0);
  const view = await readFleetFormations(f,config,player);
  assert.equal(view.docks.length,2); // the wharf is not the formation building
  assert.match(view.docks[1].reason,/已有编队/);
  const p = view.docks[0];
  assert(!p.saved && !p.visible && !p.reason);
  assert.deepEqual(p.heroes.map(h=>[h.heroId,h.x,h.y]),[['h0',4,4],['h2',1,3]]);
  await assert.rejects(f.init(p,()=>false), /暂停/);
  const saved = await f.init(p);
  assert.equal(saved.visible,false); // confirmed building formation, map roster may still be empty.
  assert.deepEqual(f.writes[0].formation, { presetId: 1, heroPositions: [{ heroId: 'h0', pos: {x:4,y:4} },{ heroId: 'h2', pos: {x:1,y:3} }] });
  await assert.rejects(f.init(p), /已有编队/);
  assert.equal(f.writes.length,1);
}
{
  const f = fixture(), p = await f.preview();
  f.water[1] = { buildingId:'3远征船',level:1,fleet:{formation:{presetId:1,heroPositions:[{heroId:'h2',pos:{x:4,y:4}}]}} };
  await assert.rejects(f.init(p), /已变化/);
  f.fleets = [{buildingId:id,state:3}];
  assert.match((await f.preview()).reason,/其他任务/);
  assert.equal(f.writes.length,0);
}
{
  const f=fixture();
  const p=await f.preview();
  f.sendWatch=async()=>{};
  await assert.rejects(f.init(p), /未确认/);
  f.water = [{ buildingId:'1舰队码头',level:1 }];
  assert.deepEqual((await readFleetFormations(f,config,player)).docks,[]);
}
console.log('fleet formation ok: empty map/first save, dock roles, occupied heroes, preset positions, stale previews, pause and confirmation');
