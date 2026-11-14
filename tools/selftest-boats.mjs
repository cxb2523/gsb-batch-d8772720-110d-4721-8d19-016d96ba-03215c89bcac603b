import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-boats-'));
process.env.CW_DATA_DIR = directory;
const { serviceBoats } = await import('../src/boats.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const { normalize } = await import('../src/worlds.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { defaultSettings } = await import('../src/automation-settings.mjs');
const protocol = loadProtocol();
const materials = ['海藻', '金属', '玻璃', '塑料', '木材', '碎布'];
const collectKeys = ['autoDive', 'autoSalvage'];
const table = data => ({ data });
const config = {
  materialName: id => id,
  tables: {
    BuildingCfg: table(['仓库', '潜水船', '探险船'].map(buildingType => ({ buildingType }))),
    BuildingUpgradeCfg: table([{ buildingType: '仓库', level: 1, effect: [['资源储量上限', 500]] }]),
    DiveParamCfg: table([{ paramName: '自动潜水', paramValue: 2 }]),
    SalvageParamCfg: table([{ paramName: '自动拾荒', paramValue: 2 }]),
    DiveLevelCfg: table([1, 2, 3, 4].map(level => ({ level, reduceTime: 30 + level * 30, enhance: 10, condition: ['潜水船', 1], cost: ['GOLD', 50] }))),
    SalvageLevelCfg: table([1, 2, 3, 4].map(level => ({ level, warehouse: level * 100, enhance: 10, condition: ['探险船', 1], cost: ['GOLD', 50] }))),
  },
};

// Match the observed account: four level-one warehouses total only 2000 in
// BuildingUpgradeCfg, while GameEffectResponse reports a real limit of 3200.
function fixture({ limit = 3200, stock = 2500 } = {}) {
  const f = {
    calls: [], writes: [], enabled: true, afterRead: null, error: null,
    effects: { effects: [{ id: 16, value: limit }] },
    stock: Object.fromEntries(materials.map(id => [id, stock])),
    water: {
      building: [1, 2, 3, 4].map(n => ({ buildingId: n + '仓库', level: 1 })).concat([
        { buildingId: '1潜水船', level: 1 }, { buildingId: '1探险船', level: 1 },
      ]),
      divingLevel: { level: 3 }, salvageLevel: { level: 3 },
    },
  };
  f.client = Object.assign(new EventEmitter(), { connected: true,
    async request(name, body, response) {
      f.calls.push(name);
      assert.ok(protocol[name]?.encode, name + ' 必须存在于真实协议');
      assert.ok(protocol[response]?.decode, response + ' 必须存在于真实协议');
      const input = normalize(protocol[name].decode(protocol[name].encode(body).finish()));
      let reply;
      if (name === 'OnWaterRequest') reply = f.water;
      else if (name === 'GameEffectRequest') reply = f.effects;
      else if (name === 'AllItemRequest') reply = { items: materials.map(itemId => ({ itemId, num: f.stock[itemId] })) };
      else {
        assert.ok(['DivingRequest', 'EndSalvageRequest', 'DivingLevelUpRequest', 'SalvageLevelUpRequest'].includes(name), '意外写请求 ' + name);
        f.writes.push({ name, body: input });
        if (f.error?.name === name) throw f.error.error;
        if (name.endsWith('LevelUpRequest')) {
          const field = name === 'DivingLevelUpRequest' ? 'divingLevel' : 'salvageLevel';
          f.water[field] = { level: f.water[field].level + 1, enhance: 0 };
          reply = { levelInfo: f.water[field] };
        } else {
          const asset = name === 'DivingRequest' ? input.reward.asset : input.pickedFloaters.map(row => ({
            type: 0, id: ({ 塑料垃圾1: '塑料', 木材垃圾1: '木材', 布垃圾1: '碎布' })[row.floaterId], num: row.num,
          }));
          const quota = name === 'DivingRequest' ? 30 + f.water.divingLevel.level * 30 : f.water.salvageLevel.level * 100;
          assert.ok(asset.reduce((sum, row) => sum + row.num, 0) <= quota, '不超过当前等级采集额度');
          const rewards = [], overflowedItems = [];
          for (const { id, num } of asset) {
            assert.ok(materials.includes(id)); assert.ok(num > 0 && Number.isSafeInteger(num));
            const received = Math.max(0, Math.min(num, limit - f.stock[id]));
            f.stock[id] += received;
            if (received) rewards.push({ type: 0, id, num: received });
            if (received < num) overflowedItems.push(id);
          }
          reply = { [name === 'DivingRequest' ? 'reward' : 'rewards']: { asset: rewards },
            ...(name === 'EndSalvageRequest' ? { overflowedItems } : {}) };
        }
      }
      f.afterRead?.(name);
      return protocol[response].decode(protocol[response].encode(reply).finish());
    },
    async sendWatch(name, body) {
      assert.equal(name, 'BeginSalvageRequest');
      assert.ok(protocol[name]?.encode);
      f.calls.push(name); f.writes.push({ name, body }); f.afterRead?.(name);
    },
  });
  f.run = async (options = {}, keys = collectKeys, cfg = config) => {
    const out = [];
    await serviceBoats(f.client, cfg, key => f.enabled && keys.includes(key), entry => out.push(entry), options);
    return out;
  };
  return f;
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log('ok ' + name); }
try {
  await check('库存高于建筑推算值但低于服务器上限时，两种采集均执行', async () => {
    const f = fixture(); const out = await f.run();
    assert.equal(out.filter(e => e.ok).length, 2, JSON.stringify(out));
    assert.deepEqual(f.writes.map(r => r.name), ['DivingRequest', 'BeginSalvageRequest', 'EndSalvageRequest']);
    assert.equal(f.stock.海藻, 2620); assert.equal(f.stock.塑料, 2800);
  });
  await check('先补足各原料空位，剩余额度继续搜索并由服务器裁剪溢出', async () => {
    const f = fixture({ stock: 3200 }); Object.assign(f.stock, { 海藻: 3190, 金属: 3180, 塑料: 3199, 碎布: 3197 });
    const out = await f.run(); assert.ok(out.every(e => e.ok));
    assert.ok(materials.every(id => f.stock[id] === 3200));
    assert.deepEqual(f.writes[0].body.reward.asset.map(({ id, num }) => [id, num]), [['金属', 110], ['海藻', 10]]);
    assert.deepEqual(f.writes[2].body.pickedFloaters, [{ floaterId: '布垃圾1', num: 299 }, { floaterId: '塑料垃圾1', num: 1 }]);
    assert.match(out[1].label, /溢出：碎布.*下轮继续搜索/);
  });
  await check('仓储低于建筑推算值时也遵守服务器上限', async () => {
    const f = fixture({ limit: 100, stock: 90 }); await f.run();
    assert.ok(materials.every(id => f.stock[id] === 100));
  });
  await check('满仓和空奖励仍执行，溢出不阻止下一轮搜索', async () => {
    const f = fixture({ stock: 3200 }); const out = await f.run();
    assert.equal(out.length, 2); assert.ok(out.every(e => e.ok && !e.skipped && /下轮继续搜索/.test(e.label)));
    assert.match(out[0].label, /没有获得材料/); assert.match(out[1].label, /溢出：塑料/);
    assert.equal(f.writes.length, 3);
    assert.ok((await f.run()).every(e => e.ok)); assert.equal(f.writes.length, 6);
    assert.ok(materials.every(id => f.stock[id] === 3200));
  });
  await check('无法确认仓储上限时不退回建筑估算、不写入', async () => {
    for (const effects of [{}, { effects: [] }, { effects: [{ id: 15, value: 3200 }] }, { effects: [{ id: 16, value: 0 }] }]) {
      const f = fixture({ stock: 0 }); f.effects = effects;
      const out = await f.run(); assert.ok(out.every(e => e.skipped && /仓储上限/.test(e.reason))); assert.deepEqual(f.writes, []);
    }
  });
  await check('仓储读取失败时报告失败，不从本地配置猜测容量', async () => {
    const f = fixture({ stock: 0 }); const request = f.client.request;
    f.client.request = async (name, ...args) => {
      if (name === 'GameEffectRequest') throw new Error('模拟仓储读取超时');
      return request(name, ...args);
    };
    const out = await f.run(); assert.equal(out.length, 2);
    assert.ok(out.every(e => e.ok === false && /仓储读取超时/.test(e.error))); assert.deepEqual(f.writes, []);
  });
  await check('不依赖仓库建筑配置即可使用服务器的有效上限', async () => {
    const f = fixture(); const cfg = { ...config, tables: structuredClone(config.tables) }; delete cfg.tables.BuildingUpgradeCfg;
    assert.ok((await f.run({}, collectKeys, cfg)).every(e => e.ok));
  });
  await check('只读预览在有空位和满仓时均显示持续搜索计划，不写入', async () => {
    for (const stock of [2500, 3200]) {
      const f = fixture({ stock }); const out = await f.run({ dryRun: true });
      assert.deepEqual(out.filter(e => e.planned).map(e => e.action.kind), collectKeys); assert.deepEqual(f.writes, []);
      assert.ok(out.every(e => /满仓或溢出仍继续/.test(e.action.label)));
    }
  });
  await check('本轮升级到自动解锁等级后立即搜索，继续升级后按新额度搜索', async () => {
    for (const start of [1, 3]) {
      const f = fixture({ stock: 3200 });
      f.water.divingLevel = f.water.salvageLevel = { level: start, enhance: 10 };
      const out = await f.run({}, ['diveEnhance', 'salvageEnhance', ...collectKeys]);
      assert.equal(out.length, 4); assert.ok(out.every(e => e.ok), JSON.stringify(out));
      assert.equal(f.writes.find(r => r.name === 'DivingRequest').body.reward.asset.reduce((sum, row) => sum + row.num, 0), 30 + (start + 1) * 30);
      assert.equal(f.writes.find(r => r.name === 'EndSalvageRequest').body.pickedFloaters.reduce((sum, row) => sum + row.num, 0), (start + 1) * 100);
    }
  });
  await check('升级后记账回调报错，仍按已确认等级搜索', async () => {
    const f = fixture({ stock: 3200 }); f.water.divingLevel = { level: 1, enhance: 10 };
    const out = await f.run({ afterAction: async () => { throw new Error('模拟记账等待核对'); } }, ['diveEnhance', 'autoDive']);
    assert.equal(out[0].ok, false); assert.equal(out[1].ok, true);
    assert.equal(f.writes.find(r => r.name === 'DivingRequest').body.reward.asset[0].num, 90);
  });
  await check('达到养成目标只停止升级，不停止满仓搜索', async () => {
    const f = fixture({ stock: 3200 }), settings = defaultSettings(); settings.gather.targetLevel = 3;
    const out = await f.run({ settings }, ['diveEnhance', 'salvageEnhance', ...collectKeys]);
    assert.equal(out.filter(e => e.skipped).length, 2); assert.equal(out.filter(e => e.ok).length, 2);
    assert.equal(f.writes.length, 3);
  });
  await check('升级预览不冒充实际升级，关闭采集后不因升级重开', async () => {
    const f = fixture(); f.water.divingLevel = { level: 1, enhance: 10 };
    const out = await f.run({ dryRun: true }, ['diveEnhance', 'autoDive']);
    assert.ok(out[0].planned); assert.ok(out[1].skipped); assert.deepEqual(f.writes, []);
    const s = fixture(); s.water.divingLevel = { level: 1, enhance: 10 };
    s.afterRead = name => { if (name === 'DivingLevelUpRequest') s.enabled = false; };
    await s.run({}, ['diveEnhance', 'autoDive']);
    assert.deepEqual(s.writes.map(r => r.name), ['DivingLevelUpRequest']);
  });
  await check('等级未达自动解锁门槛或建筑未建成时保持跳过', async () => {
    for (const change of [f => { f.water.divingLevel.level = f.water.salvageLevel.level = 1; }, f => { f.water.building.forEach(b => b.level = 0); }]) {
      const f = fixture(); change(f); const out = await f.run();
      assert.ok(out.every(e => e.skipped)); assert.deepEqual(f.writes, []);
      assert.ok(!f.calls.includes('GameEffectRequest'));
    }
  });
  await check('发送前关闭不执行，已开始拾荒则空结算退出', async () => {
    const f = fixture(); f.afterRead = name => { if (name === 'AllItemRequest') f.enabled = false; };
    await f.run(); assert.deepEqual(f.writes, []);
    const s = fixture(); s.afterRead = name => { if (name === 'BeginSalvageRequest') s.enabled = false; };
    await s.run({}, ['autoSalvage']);
    assert.deepEqual(s.writes.map(r => r.name), ['BeginSalvageRequest', 'EndSalvageRequest']);
    assert.deepEqual(s.writes[1].body.pickedFloaters, []);
    assert.ok(materials.every(id => s.stock[id] === 2500));
  });
  await check('潜水被拒不冒充成功，不阻塞拾荒，不即时重试', async () => {
    const f = fixture(); f.error = { name: 'DivingRequest', error: new Error('模拟服务器拒绝') };
    const out = await f.run(); assert.equal(out[0].ok, false); assert.match(out[0].error, /拒绝/); assert.equal(out[1].ok, true);
    assert.equal(f.writes.filter(r => r.name === 'DivingRequest').length, 1);
  });
  await check('真实挂机入口同时触发两种采集，并上报对应任务', async () => {
    const f = fixture(), events = [], settings = defaultSettings();
    settings.building.enabled = settings.factory.enabled = settings.resident.enabled = false;
    settings.gather.diving = settings.gather.salvage = true;
    await runLoop(f.client, protocol, { config, player: { level: 24 }, allowMutate: true, rounds: 1,
      isEnabled: key => collectKeys.includes(key), getSettings: () => settings, onStep: event => events.push(event) });
    assert.deepEqual(events.filter(e => e.ok).map(e => e.taskKey), collectKeys);
    assert.equal(f.writes.length, 3);
  });
  await check('满仓下挂机连续三轮均搜索，下一轮关闭则立即停止', async () => {
    for (const closeAfter of [0, 1]) {
      const f = fixture({ stock: 3200 }), events = [], settings = defaultSettings();
      settings.building.enabled = settings.factory.enabled = settings.resident.enabled = false;
      settings.gather.diving = settings.gather.salvage = true;
      await runLoop(f.client, protocol, { config, player: { level: 24 }, allowMutate: true, rounds: 3, everyMs: 0,
        isEnabled: key => collectKeys.includes(key), getSettings: () => settings, onStep: e => events.push(e),
        onRound: round => { if (round.round === closeAfter) settings.gather.diving = settings.gather.salvage = false; } });
      const expected = closeAfter ? 1 : 3;
      for (const key of collectKeys) assert.equal(events.filter(e => e.taskKey === key && e.ok).length, expected);
      assert.equal(f.writes.length, 3 * expected);
    }
  });
  await check('详细配置关闭采集或基地总开关时，挂机不能绕过', async () => {
    for (const worldEnabled of [true, false]) {
      const f = fixture(), settings = defaultSettings();
      settings.loop.world = worldEnabled; settings.resident.enabled = false;
      settings.building.enabled = settings.factory.enabled = false;
      settings.gather.diving = settings.gather.salvage = !worldEnabled;
      await runLoop(f.client, protocol, { config, player: { level: 24 }, allowMutate: true, rounds: 1,
        isEnabled: key => collectKeys.includes(key), getSettings: () => settings });
      assert.deepEqual(f.writes, []);
    }
  });
  await check('采集总开关在读取中关闭立即拦截，重开后保留原选项继续搜索', async () => {
    const f = fixture({ stock: 3200 }), settings = defaultSettings(), events = [];
    settings.building.enabled = settings.factory.enabled = settings.resident.enabled = false;
    settings.gather.diving = settings.gather.salvage = true;
    f.afterRead = name => { if (name === 'AllItemRequest') settings.gather.enabled = false; };
    const options = { config, player: { level: 24 }, allowMutate: true, rounds: 1,
      isEnabled: key => collectKeys.includes(key), getSettings: () => settings, onStep: e => events.push(e) };
    await runLoop(f.client, protocol, options); assert.deepEqual(f.writes, []);
    f.afterRead = null; settings.gather.enabled = true;
    await runLoop(f.client, protocol, options);
    assert.equal(f.writes.length, 3); assert.equal(events.filter(e => e.ok).length, 2);
    assert.equal(settings.gather.diving, true); assert.equal(settings.gather.salvage, true);
  });
  await check('玩法状态短暂缺失时补读一次并继续采集', async () => {
    const f = fixture(), request = f.client.request; let waterReads = 0;
    f.client.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === 'OnWaterRequest' && ++waterReads === 1) { delete result.divingLevel; delete result.salvageLevel; }
      return result;
    };
    assert.ok((await f.run()).every(e => e.ok)); assert.equal(waterReads, 2); assert.equal(f.writes.length, 3);
  });
  await check('持续缺失玩法状态与缺少等级配置给出不同原因', async () => {
    const f = fixture(); delete f.water.divingLevel; delete f.water.salvageLevel;
    assert.ok((await f.run()).every(e => e.skipped && /服务器未返回有效/.test(e.reason)));
    assert.equal(f.calls.filter(n => n === 'OnWaterRequest').length, 2); assert.equal(f.writes.length, 0);
    const g = fixture(); g.water.divingLevel = g.water.salvageLevel = { level: 99 };
    assert.ok((await g.run()).every(e => e.skipped && /没有对应配置/.test(e.reason))); assert.equal(g.writes.length, 0);
  });
  await check('优先按建筑解锁表识别类型，不依赖名称后缀', async () => {
    const f = fixture(), cfg = { ...config, tables: structuredClone(config.tables) };
    cfg.tables.BuildingUnlockCfg = table([{ buildingId: 'dock-a', buildingType: '潜水船' }, { buildingId: 'boat-b', buildingType: '探险船' }]);
    f.water.building = [{ buildingId: 'dock-a', level: 1 }, { buildingId: 'boat-b', level: 1 }];
    assert.ok((await f.run({}, collectKeys, cfg)).every(e => e.ok));
  });
  console.log(`boats ok: ${passed} checks, real protocol encoding, capacity, gates, preview and loop`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
