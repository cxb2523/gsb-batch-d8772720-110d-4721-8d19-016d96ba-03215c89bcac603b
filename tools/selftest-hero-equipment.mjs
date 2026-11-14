import assert from 'node:assert/strict';
import { readHeroEquipment, equipHeroEmptySlots, enhanceHeroEquipment } from '../src/hero-equipment.mjs';

const config = { materialName: id => id === '精铁' ? '强化石' : id, tables: {
  ModuleOpenCfg: { data: [{ moduleId: '英雄装备', playerLevel: 16 }] },
  EquipCfg: { data: [
    { id: '枪', name: '散弹枪', type: '武器', qualityIndex: 3 },
    { id: '护甲', name: '防弹衣', type: '防具', qualityIndex: 3 },
    { id: '刀', name: '锯刀', type: '饰品', qualityIndex: 2 },
  ] },
  EquipAttrCfg: { data: ['枪', '护甲', '刀'].map(id => ({ id, star: '0', maxLv: 3 })) },
  EquipUpDecomposeCfg: { data: [{ level: 2, upgradeCost: 50 }, { level: 3, upgradeCost: 80 }] },
  HeroCfg: { data: [{ id: 'h1', name: '海员' }, { id: 'h2', name: '船长' }] },
} };
const bigUid = { high: 2147483646, low: -3, unsigned: false };
const uidText = u => typeof u === 'number' ? String(u) : String((BigInt(u.high) << 32n) + BigInt(u.low >>> 0));
const targetUid = uidText(bigUid);
function fixture() {
  const equips = [
    { uid: 1, equipId: '枪', level: 2 }, { uid: bigUid, equipId: '枪', level: 1 },
    { uid: 3, equipId: '护甲', level: 1 }, { uid: 4, equipId: '刀', level: 1 },
    { uid: 5, equipId: '护甲', level: 3 },
  ];
  const heroes = [{ heroId: 'h1', equips: [equips[2]] }, { heroId: 'h2', equips: [equips[0]] }];
  const calls = [], writes = [], f = {
    iron: 50, calls, writes, heroes, equips,
    async request(name, _body, response) {
      calls.push(name);
      if (name === 'EquipsRequest') return { equip: structuredClone(equips) };
      if (name === 'AllHeroRequest') return { heroes: structuredClone(heroes) };
      if (name === 'AllItemRequest') return { items: [{ itemId: '精铁', num: f.iron }] };
      assert.fail('未知读取 ' + name + '/' + response);
    },
    async sendWatch(name, body) {
      writes.push([name, structuredClone(body)]);
      const item = equips.find(e => uidText(e.uid) === uidText(body.uid));
      assert(item);
      if (name === 'PutOnEquipRequest') heroes.find(h => h.heroId === body.heroId).equips.push(item);
      else if (name === 'EnhanceEquipRequest') { item.level++; f.iron -= 50; }
      else assert.fail('不应发送 ' + name);
    },
  };
  return f;
}

{
  const f = fixture();
  assert((await readHeroEquipment(f, config, 15)).locked);
  assert.equal(f.calls.length, 0);
  const view = await readHeroEquipment(f, config, 16);
  assert.equal(view.iron, 50);
  const h = view.heroes[0];
  assert.equal(h.name, '海员');
  assert.deepEqual(h.slots.map(s => [s.type,s.item?.uid,s.suggested?.uid]),
    [['武器',undefined,targetUid],['防具','3',undefined],['饰品',undefined,'4']]);
  const result = await equipHeroEmptySlots(f, config, 16, 'h1');
  assert.equal(result.count, 2);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[0][1].uid, bigUid);
  assert.equal(f.writes[0][1].heroId, 'h1');
  assert.equal((await equipHeroEmptySlots(f, config, 16, 'h1')).count, 0);
  assert.equal(f.writes.length, 2);
  const changed = await enhanceHeroEquipment(f, config, 16, { uid: targetUid, expectedLevel: 1, maxCost: 50 });
  assert.equal(changed.level, 2);
  assert.equal(changed.cost, 50);
  assert.equal(f.iron, 0);
  await assert.rejects(enhanceHeroEquipment(f, config, 16, { uid: targetUid, expectedLevel: 1, maxCost: 50 }), /已变化/);
  assert.equal(f.writes.length, 3);
}
for (const setup of [
  f => { f.iron = 49; return {}; },
  () => ({ maxCost: 49 }),
  () => ({ enabled: () => false }),
  () => ({ uid: '5', expectedLevel: 3 }),
  () => ({ uid: '9007199254740992', expectedLevel: 0 }),
]) {
  const f = fixture();
  await assert.rejects(enhanceHeroEquipment(f, config, 16, { uid: targetUid, expectedLevel: 1, maxCost: 50, ...setup(f) }));
  assert.equal(f.writes.length, 0);
}
{
  const f = fixture();
  await assert.rejects(equipHeroEmptySlots(f, config, 16, '不存在'), /尚未拥有/);
  await assert.rejects(equipHeroEmptySlots(f, config, 16, 'h1', () => !f.writes.length), /海员装备了散弹枪.*暂停/);
  assert.equal(f.writes.length, 1);
  const noAck = fixture();
  noAck.sendWatch = async () => {};
  await assert.rejects(equipHeroEmptySlots(noAck, config, 16, 'h1'), /未确认穿戴/);
  await assert.rejects(enhanceHeroEquipment(noAck, config, 16, { uid: targetUid, expectedLevel: 1, maxCost: 50 }), /未确认装备提升/);
}
console.log('hero equipment ok: level gate, ownership, vacant slots, exact int64 UID, cost, cancellation and server confirmation');
