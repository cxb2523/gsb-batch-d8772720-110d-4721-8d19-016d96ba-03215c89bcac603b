import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-museum-materials-'));
const previousDataDirectory = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;

const { serviceCargo } = await import('../src/cargo.mjs');
const { runBaseAutomation } = await import('../src/base-automation.mjs');
const { serviceMuseum } = await import('../src/museum.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { createUsageLedger, defaultSettings } = await import('../src/automation-settings.mjs');
const reservations = await import('../src/order-reservations.mjs');
const { readMuseumMaterialState, settleMuseumMaterialState } = await import('../src/museum-materials.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const protocol = loadProtocol();
const time = Math.floor(Date.now() / 1000);
const asset = (id, num) => ({ type: 0, id, num });
const idleExpedition = () => ({ startTime: 0, endTime: 0, heroIds: [], conditionId: 7, factor: 1,
  cost: { asset: [asset('木板', 5)] } });
const idleStage = (stageId = 1) => ({ stageId, progress: 0, expedition: idleExpedition() });
const config = { materialName: id => id, tables: Object.fromEntries(Object.entries({
  CargoUnlockCfg: [{ index: 1, playerLevel: 9 }],
  BuildingUnlockCfg: [{ buildingId: '1博物馆', buildingType: '博物馆', playerLevel: 28 }],
  MuseumExpeditionTeamCfg: [{ teamCount: 2, playerLevel: 28 }],
  MuseumExploreTimeFactorCfg: [{ factor: 1, playerLevel: 1 }, { factor: 2, playerLevel: 28 }],
  MuseumExpeditionStageCfg: [{ stageId: 1, name: '遗迹', exploreTime: 3600 }],
  MuseumExpeditionConditionCfg: [{ conditionId: 7, heroCount: 1, heroStar: 0, heroQualityIndex: 1, careerLimit: '', factionLimit: '' }],
  HeroCfg: [{ id: 'h1', qualityIndex: 1, career: '战士', faction: '阵营A' }],
}).map(([name, data]) => [name, { data }])) };
let serial = 981600;

function fixture() {
  const player = { playerId: ++serial, worldId: 1000001, guildId: 0, level: 30 };
  const settings = defaultSettings(); settings.cargo.enabled = true; settings.museum.enabled = true;
  const f = {
    player, settings, connected: true, running: true,
    ledger: createUsageLedger(String(player.playerId), { file: path.join(directory, String(player.playerId) + '.json') }),
    stock: new Map([['木板', 20], ['铜锭', 20]]), stages: [idleStage()], calls: [], writes: [], reports: [],
    ships: [{ index: 1, status: 0, orderItem: [{ filled: false, asset: asset('木板', 5) }] }],
    async request(name, body = {}, response = name.replace(/Request$/, 'Response')) {
      assert(protocol[name], '真实协议请求存在：' + name);
      assert(protocol[response], '真实协议响应存在：' + response);
      this.calls.push(name);
      await this.beforeRead?.(name);
      let reply;
      switch (name) {
        case 'MuseumInfoRequest':
          reply = { popularity: 0, topPopularity: 0, uncollectedRevenue: 0, revenueLastSettleTime: 0,
            exploreStages: structuredClone(this.stages) };
          reply = this.museumView?.(reply) ?? reply;
          break;
        case 'AllItemRequest':
          reply = { items: [...this.stock].map(([itemId, num]) => ({ itemId, num })) };
          reply = this.inventoryView?.(reply) ?? reply;
          break;
        case 'OnWaterRequest': return { building: [{ buildingId: '1博物馆', level: 1 }], workerOrder: [] };
        case 'AllHeroRequest': return { heroes: [{ heroId: 'h1', level: 1, star: 1, power: 100 }] };
        case 'WeekInfoRequest': return { activityTime: [] };
        case 'CargoShipsRequest': return { ship: structuredClone(this.ships) };
        case 'MuseumStartExploreRequest': {
          const wire = protocol[name].decode(protocol[name].encode(body).finish());
          assert.equal(wire.stageId, body.stageId); assert.equal(wire.factor, body.factor);
          this.writes.push({ name, body: structuredClone(body) });
          if (this.startMode === 'reject') throw Object.assign(new Error('server rejected dispatch'), { prompt: {}, request: name });
          if (this.startMode === 'timeout') throw new Error('dispatch timeout');
          const stage = this.stages.find(row => row.stageId === body.stageId);
          assert(stage && stage.expedition.endTime === 0, '不能重复向已占用地图派遣');
          this.stock.set('木板', this.stock.get('木板') - 5 * body.factor);
          stage.expedition = { ...idleExpedition(), heroIds: [...body.heroIds], factor: body.factor, startTime: time, endTime: time + 3600 };
          await this.afterStart?.();
          if (this.startMode === 'lost') throw new Error('dispatch response lost');
          reply = { expedition: structuredClone(stage.expedition) };
          break;
        }
        case 'FillCargoShipRequest': {
          this.writes.push({ name, body: structuredClone(body) });
          const ship = this.ships.find(row => row.index === body.shipIndex);
          for (const index of body.cargoIndex) {
            const slot = ship.orderItem[index - 1];
            assert(this.stock.get(slot.asset.id) >= slot.asset.num);
            this.stock.set(slot.asset.id, this.stock.get(slot.asset.id) - slot.asset.num);
            slot.filled = true;
          }
          ship.status = 1; return {};
        }
        default: assert.fail('意外请求：' + name);
      }
      // Malformed read fixtures deliberately bypass the codec, preserving missing
      // fields instead of having protobuf defaults fill them in.
      if (name === 'MuseumStartExploreRequest') return protocol[response].decode(protocol[response].encode(reply).finish());
      return reply;
    },
    count(name) { return this.writes.filter(row => row.name === name).length; },
    pending() { return reservations.pendingMuseumMaterialSpends(this.player); },
    read() { return reservations.readOrderReservedStock(this, protocol, config, { player: this.player, enabled: () => this.running }); },
    museum({ factor = 1 } = {}) {
      return runBaseAutomation(this, protocol, config, { actions: [{
        kind: 'museumStart', scope: 'base', setting: 'museum.enabled', request: 'MuseumStartExploreRequest', response: 'MuseumStartExploreResponse',
        body: { stageId: 1, heroIds: ['h1'], factor }, costs: [{ id: '木板', num: 5 * factor }], label: '派遣地图 1，' + factor + ' 倍探宝',
      }] }, { player: this.player, getSettings: () => this.settings, ledger: this.ledger, enabled: () => this.running });
    },
    legacyMuseum() {
      return serviceMuseum(this, protocol, config, { player: this.player, enabled: key => this.running && key === 'museumExplore' });
    },
    cargo() {
      const guard = createActionGuard(this, () => this.settings, this.ledger, { player: this.player, enabled: () => this.running });
      return serviceCargo(this, config, { enabled: () => this.running, getSettings: () => this.settings, ledger: this.ledger,
        beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel, log: (label, details) => this.reports.push({ label, ...details }) });
    },
  };
  return f;
}

let passed = 0;
async function test(label, fn) { await fn(); passed++; console.log('✓ ' + label); }
const pendingError = /尚未确认|待确认|等待.*确认|派遣.*确认/;
const keepOldStage = f => { f.museumView = reply => f.count('MuseumStartExploreRequest') ? { ...reply, exploreStages: [idleStage()] } : reply; };
async function unknownDispatch() {
  const f = fixture(); f.startMode = 'lost'; keepOldStage(f);
  const result = await f.museum();
  assert.equal(result[0].ok, false);
  assert.equal(f.count('MuseumStartExploreRequest'), 1);
  return f;
}

try {
  for (const stock of [18, 20, 25]) await test('补产后木板 ' + stock + '，贸易港恢复装货', async () => {
    const f = fixture(); f.afterStart = () => f.stock.set('木板', stock);
    const result = await f.museum();
    assert.equal(result[0].ok, true, result[0].error ?? result[0].reason);
    await f.cargo();
    assert.equal(f.count('FillCargoShipRequest'), 1);
    assert.equal(f.stock.get('木板'), stock - 5);
    assert.equal(f.pending().length, 0);
    assert(f.calls.lastIndexOf('MuseumInfoRequest') < f.calls.lastIndexOf('AllItemRequest'));
  });

  await test('只有派遣成功回包，尚未读到队伍时仍保留材料', async () => {
    const f = fixture(); keepOldStage(f); f.afterStart = () => f.stock.set('木板', 20);
    await f.museum();
    assert.equal(f.pending().length, 1);
    await assert.rejects(f.cargo(), pendingError);
    assert.equal(f.count('FillCargoShipRequest'), 0);
    f.museumView = null;
    await f.cargo(); assert.equal(f.count('FillCargoShipRequest'), 1);
  });

  await test('双倍探宝按实际倍率匹配队伍和材料', async () => {
    const f = fixture(); f.afterStart = () => f.stock.set('木板', 25);
    const result = await f.museum({ factor: 2 });
    assert.equal(result[0].ok, true, result[0].error ?? result[0].reason);
    await f.cargo();
    assert.equal(f.count('FillCargoShipRequest'), 1); assert.equal(f.pending().length, 0);
  });

  await test('真实协议省略空闲队伍时间，仍可派遣并确认', async () => {
    const f = fixture(); let checkedDefaults = false;
    f.museumView = reply => {
      for (const stage of reply.exploreStages) if (stage.expedition.endTime === 0) {
        delete stage.expedition.startTime; delete stage.expedition.endTime;
      }
      const decoded = protocol.MuseumInfoResponse.decode(protocol.MuseumInfoResponse.encode(reply).finish());
      const empty = decoded.exploreStages.find(stage => stage.expedition.endTime === 0)?.expedition;
      if (empty) {
        assert.equal(empty.startTime, 0); assert.equal(empty.endTime, 0);
        assert.equal(Object.hasOwn(empty, 'startTime'), false); assert.equal(Object.hasOwn(empty, 'endTime'), false);
        checkedDefaults = true;
      }
      return decoded;
    };
    f.afterStart = () => f.stock.set('木板', 20);
    const result = await f.museum();
    assert.equal(result[0].ok, true, result[0].error ?? result[0].reason);
    assert(checkedDefaults, '必须实际经过真实协议的原型默认字段');
    await f.cargo();
    assert.equal(f.count('MuseumStartExploreRequest'), 1); assert.equal(f.count('FillCargoShipRequest'), 1);
    assert.equal(f.pending().length, 0);
  });

  await test('丢回包后换连接核对队伍和补货库存，不重复派遣', async () => {
    const f = await unknownDispatch(); f.stock.set('木板', 25);
    await assert.rejects(f.cargo(), pendingError);
    f.museumView = null;
    const replacement = Object.create(f);
    await replacement.cargo();
    assert.equal(f.count('MuseumStartExploreRequest'), 1);
    assert.equal(f.count('FillCargoShipRequest'), 1);
    assert.equal(f.pending().length, 0);
  });

  await test('已领奖的关卡进度也可确认旧派遣', async () => {
    const f = await unknownDispatch();
    f.stages = [{ ...idleStage(), progress: 20 }]; f.museumView = null; f.stock.set('木板', 20);
    await f.cargo();
    assert.equal(f.count('FillCargoShipRequest'), 1);
    assert.equal(f.pending().length, 0);
  });

  await test('真实协议领奖进度增长但省略 expedition，仍可恢复', async () => {
    const f = await unknownDispatch();
    f.stages = [{ stageId: 1, progress: 20 }]; f.stock.set('木板', 20);
    f.museumView = reply => {
      const decoded = protocol.MuseumInfoResponse.decode(protocol.MuseumInfoResponse.encode(reply).finish());
      assert.equal(Object.hasOwn(decoded.exploreStages[0], 'expedition'), false);
      return decoded;
    };
    await f.cargo();
    assert.equal(f.count('FillCargoShipRequest'), 1); assert.equal(f.pending().length, 0);
  });

  await test('较早读取的探宝快照不能结算后来建立的记录', async () => {
    const f = await unknownDispatch(); f.museumView = null;
    const old = f.pending()[0];
    const snapshot = await readMuseumMaterialState(f, f.player);
    assert(snapshot.museum);
    reservations.cancelOrderMaterialSpend(old);
    const later = reservations.beginOrderMaterialSpend(f.player, old.costs, '后来的探宝', { museum: old.museum });
    settleMuseumMaterialState(f.player, snapshot, new Map(f.stock));
    assert.deepEqual(f.pending(), [later], '旧快照只拥有读取前捕获的句柄');
    reservations.cancelOrderMaterialSpend(later);
  });

  for (const [label, mutate] of [
    ['旧空闲状态', reply => { reply.exploreStages = [idleStage()]; }],
    ['其他英雄', reply => { reply.exploreStages[0].expedition.heroIds = ['h2']; }],
    ['错误倍率', reply => { reply.exploreStages[0].expedition.factor = 2; }],
    ['其他地图', reply => { reply.exploreStages[0].stageId = 2; }],
    ['重复地图', reply => { reply.exploreStages.push(structuredClone(reply.exploreStages[0])); }],
    ['缺少队伍', reply => { delete reply.exploreStages[0].expedition.heroIds; }],
    ['缺少时间', reply => { delete reply.exploreStages[0].expedition.startTime; }],
  ]) await test(label + '不能释放待确认材料', async () => {
    const f = await unknownDispatch();
    f.museumView = reply => { mutate(reply); return reply; };
    await assert.rejects(f.cargo(), pendingError);
    assert.equal(f.count('FillCargoShipRequest'), 0);
    assert.equal(f.pending().length, 1);
  });

  await test('余额降到旧阈值但派遣未知，不能仅凭余额重用材料', async () => {
    const f = await unknownDispatch();
    assert.equal(f.stock.get('木板'), 15);
    await assert.rejects(f.cargo(), pendingError);
    assert.equal(f.pending().length, 1);
    await f.museum();
    assert.equal(f.count('MuseumStartExploreRequest'), 1);
  });

  await test('未确认的木板探宝不阻塞铜锭装货', async () => {
    const f = await unknownDispatch();
    f.ships[0].orderItem = [{ filled: false, asset: asset('铜锭', 5) }];
    await f.cargo();
    assert.equal(f.count('FillCargoShipRequest'), 1);
    assert.equal(f.pending().length, 1);
  });

  for (const [label, inventory] of [
    ['缺少清单', () => ({})],
    ['重复记录', reply => ({ items: [...reply.items, reply.items[0]] })],
    ['负库存', reply => ({ items: reply.items.map(row => ({ ...row, num: -1 })) })],
    ['读取失败', () => { throw new Error('inventory timeout'); }],
  ]) await test(label + '保留材料，完整读取后恢复', async () => {
    const f = await unknownDispatch(); f.museumView = null; f.inventoryView = inventory;
    await assert.rejects(f.read());
    assert.equal(f.pending().length, 1);
    f.inventoryView = null; f.stock.set('木板', 25);
    await f.read();
    assert.equal(f.pending().length, 0);
    await f.cargo(); assert.equal(f.count('FillCargoShipRequest'), 1);
  });

  await test('状态读取期间暂停，不解除预留或装货', async () => {
    const f = await unknownDispatch(); f.museumView = null;
    f.beforeRead = name => { if (name === 'MuseumInfoRequest') f.running = false; };
    await assert.rejects(f.cargo(), /暂停|确认/);
    assert.equal(f.pending().length, 1); assert.equal(f.count('FillCargoShipRequest'), 0);
    f.running = true; f.beforeRead = null;
    await f.cargo(); assert.equal(f.count('FillCargoShipRequest'), 1);
  });

  await test('状态读取期间账号变化，不能释放原账号记录', async () => {
    const f = await unknownDispatch(); f.museumView = null;
    const originalId = f.player.playerId;
    f.beforeRead = name => { if (name === 'MuseumInfoRequest') f.player.playerId = originalId + 1000000; };
    await assert.rejects(f.cargo(), /账号|身份/);
    f.player.playerId = originalId; f.beforeRead = null;
    assert.equal(f.pending().length, 1); assert.equal(f.count('FillCargoShipRequest'), 0);
    await f.cargo(); assert.equal(f.count('FillCargoShipRequest'), 1);
  });

  for (const method of ['read', 'cargo']) for (const stop of ['pause', 'account']) {
    await test(method + ' 在状态确认后的库存读取期间' + (stop === 'pause' ? '暂停' : '切号') + '，仍保留材料', async () => {
      const f = await unknownDispatch(); f.museumView = null;
      const originalId = f.player.playerId; let observedState = false, interrupted = false;
      f.beforeRead = name => {
        if (name === 'MuseumInfoRequest') observedState = true;
        if (name === 'AllItemRequest' && observedState) {
          interrupted = true;
          if (stop === 'pause') f.running = false;
          else f.player.playerId = originalId + 1000000;
        }
      };
      await assert.rejects(f[method](), /暂停|账号|身份/);
      assert(interrupted, '必须在 MuseumInfo 后续库存读取内触发');
      f.player.playerId = originalId; f.running = true; f.beforeRead = null;
      assert.equal(f.pending().length, 1); assert.equal(f.count('FillCargoShipRequest'), 0);
      await f.cargo(); assert.equal(f.count('FillCargoShipRequest'), 1);
    });
  }

  await test('另一账号不会继承待确认探宝记录', async () => {
    const first = await unknownDispatch(), second = fixture();
    await second.cargo();
    assert.equal(second.count('FillCargoShipRequest'), 1);
    assert.equal(first.pending().length, 1);
  });

  await test('明确拒绝释放材料，后续贸易港可用', async () => {
    const f = fixture(); f.startMode = 'reject';
    assert.equal((await f.museum())[0].ok, false);
    assert.equal(f.pending().length, 0);
    await f.cargo(); assert.equal(f.count('FillCargoShipRequest'), 1);
  });

  await test('旧博物馆入口补产后也恢复贸易港', async () => {
    const f = fixture(); f.afterStart = () => f.stock.set('木板', 25);
    await f.legacyMuseum();
    assert.equal(f.count('MuseumStartExploreRequest'), 1);
    await f.cargo();
    assert.equal(f.count('FillCargoShipRequest'), 1); assert.equal(f.pending().length, 0);
  });

  await test('旧博物馆丢回包后由贸易港补确认', async () => {
    const f = fixture(); f.startMode = 'lost'; keepOldStage(f);
    await f.legacyMuseum();
    assert.equal(f.count('MuseumStartExploreRequest'), 1);
    await assert.rejects(f.cargo(), pendingError);
    f.museumView = null; f.stock.set('木板', 20);
    await f.cargo();
    assert.equal(f.count('MuseumStartExploreRequest'), 1);
    assert.equal(f.count('FillCargoShipRequest'), 1); assert.equal(f.pending().length, 0);
  });
  console.log('博物馆材料同步专项 ' + passed + '/' + passed + ' 通过');
} finally {
  if (previousDataDirectory === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDirectory;
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('cw-museum-materials-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
