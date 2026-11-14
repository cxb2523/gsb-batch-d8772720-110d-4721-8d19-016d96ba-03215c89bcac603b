// Definite pre-send failure releases only its own write; later read failures do not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-spend-cancellation-'));
const priorData = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
const { loadProtocol } = await import('../src/proto.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { createUsageLedger, defaultSettings } = await import('../src/automation-settings.mjs');
const { pendingOrderMaterialSpends } = await import('../src/order-reservations.mjs');
const { runWorld } = await import('../src/world.mjs');
const { runBaseAutomation } = await import('../src/base-automation.mjs');
const { runHeroPlan } = await import('../src/heroes.mjs');
const { serviceCargo } = await import('../src/cargo.mjs');
const protocol = loadProtocol(), config = { tables: {} };
const now = Math.floor(Date.now() / 1000);
let serial = 17800000, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const notSent = request => Object.assign(new Error('测试：请求尚未发出'), { notSent: true, request });
const asset = (id, num) => ({ type: 0, id, num });

function fixture(mode, route) {
  const player = { playerId: ++serial, worldId: 1000001, level: 40, guildId: 1 };
  const settings = defaultSettings();
  settings.pet.enabled = settings.pet.advance = settings.cargo.enabled = true;
  settings.museum.enabled = settings.museum.useGuide = true;
  settings.museum.dailyGuideLimit = 10;
  settings.factory.cooperateNative = true;
  const state = { attempts: [], writes: [], readFailures: [], cancelled: [], afterCalls: 0,
    ship: { index: 1, status: route === 'cargo-watch' ? 1 : 0, arriveTime: now + 3600,
      orderItem: [{ filled: false, asset: asset('fish', 10) }] } };
  const reads = new Set(['AllItemRequest', 'AllResourceRequest', 'AllPetRequest', 'AllHeroRequest', 'OnWaterRequest', 'MuseumInfoRequest', 'CargoShipsRequest', 'WeekInfoRequest']);
  const client = { connected: true,
    async request(name, body = {}) {
      assert(protocol[name], '真实协议中存在 ' + name);
      protocol[name].encode(body).finish();
      if (reads.has(name)) {
        if (mode === 'read-unsent' && state.writes.length) {
          state.readFailures.push(name); throw notSent(name);
        }
        if (name === 'AllItemRequest') return { items: ['fish', '英雄经验', '加速器'].map(itemId => ({ itemId, num: 100 })) };
        if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: 100000 }] };
        if (name === 'AllPetRequest') return { pets: [{ uid: '1', grade: 0, profFeed: [{ attrFeed: [{ times: state.writes.length }] }] }] };
        if (name === 'AllHeroRequest') return { heroes: [{ heroId: 'A', level: 1 + state.writes.length, star: 1 + state.writes.length, skillLevels: [1] }] };
        if (name === 'OnWaterRequest') return { autoProduceForever: true,
          building: [{ buildingId: 'target', level: 1, factory: { autoProductId: 'old', factoryQ: [] } }],
          workerOrder: [{ index: 1, workerId: 1, textId: 1, requirements: [asset('fish', 10)] }], orderOfTheDay: { orderNum: 0 } };
        if (name === 'MuseumInfoRequest') return { exploreStages: [{ stageId: 1, expedition: { endTime: now + 600 } }] };
        if (name === 'CargoShipsRequest') return { ship: [structuredClone(state.ship)] };
        return { activityTime: [] };
      }
      state.attempts.push(name);
      if (mode === 'write-unsent') throw notSent(name);
      if (mode === 'write-rejected') throw Object.assign(new Error('测试：明确拒绝'), { prompt: {}, request: name });
      if (mode === 'write-other-prompt') throw Object.assign(new Error('测试：其他请求拒绝'), { prompt: {}, request: 'AllItemRequest' });
      state.writes.push(name);
      if (mode === 'write-unknown') throw new Error('测试：写结果未知');
      if (name === 'FillCargoShipRequest') { state.ship.orderItem[0].filled = true; state.ship.status = 1; }
      if (name === 'SpeedUpShipRequest') state.ship.arriveTime--;
      return { reward: { asset: [asset('EXP', 1)] }, expedition: { endTime: now + 600 } };
    },
    async sendWatch(name, body) { return this.request(name, body); },
  };
  const ledger = createUsageLedger('offline', { file: path.join(directory, player.playerId + '.json') });
  const guard = createActionGuard(client, () => settings, ledger, { player });
  const callbacks = {
    beforeAction: guard.before,
    async afterAction(...args) {
      state.afterCalls++;
      if (mode === 'after-unsent') throw notSent('AllItemRequest');
      return guard.after(...args);
    },
    async cancelAction(step, ticket, reason) { state.cancelled.push(reason); return guard.cancel(step, ticket, reason); },
  };
  const cost = [{ id: 'fish', num: 10 }];
  const run = async () => {
    if (route.startsWith('world-')) {
      const step = route === 'world-response'
        ? { kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse', body: { index: 1 }, costs: cost }
        : route === 'world-native'
          ? { kind: 'startProduce', request: 'SetFactoryAutoProduceRequest', body: { buildingId: 'target', productId: 'new' }, previousProduct: 'old', costs: cost }
          : { kind: 'build', request: 'BuildBuildingRequest', body: { buildingId: 'new' }, costs: cost };
      return runWorld(client, protocol, { actions: [step] }, { player, config, allowMutate: true,
        ...(route === 'world-native' ? { getSettings: () => settings } : {}),
        beforeStep: callbacks.beforeAction, afterStep: callbacks.afterAction, cancelStep: callbacks.cancelAction });
    }
    if (route.startsWith('base-')) {
      const step = route === 'base-response'
        ? { kind: 'museumGuide', setting: 'museum.useGuide', request: 'MuseumSpeedUpExploreRequest', response: 'MuseumSpeedUpExploreResponse',
          body: { stageId: 1 }, costs: cost, counters: { museumGuides: 1 }, verify: { endTime: now + 3600 } }
        : { kind: 'petAdvanceFeed', setting: 'pet.advance', request: 'PetUpgradeFeedRequest', body: { buildingId: 'target' },
          costs: cost, verify: { petUid: '1', fed: 0, grade: 0 } };
      return runBaseAutomation(client, protocol, config, { actions: [step] }, { player, getSettings: () => settings, ledger });
    }
    if (route.startsWith('hero-')) {
      const step = route === 'hero-response' ? { kind: 'star', heroId: 'A', from: 1, to: 2, costs: cost }
        : { kind: 'level', heroId: 'A', from: 1, count: 1, levelCosts: [10] };
      return runHeroPlan(client, protocol, { steps: [step] }, { allowMutate: true, getSettings: () => settings, ...callbacks });
    }
    return serviceCargo(client, config, { enabled: () => true, getSettings: () => settings, ledger,
      testSpeedUp: route === 'cargo-watch', log() {}, ...callbacks });
  };
  return { player, state, ledger, run };
}

try {
  const routes = ['world-response', 'world-watch', 'base-response', 'base-watch', 'hero-response', 'hero-watch', 'cargo-response', 'cargo-watch'];
  for (const route of routes) for (const mode of ['write-unsent', 'write-unknown', 'write-rejected', 'write-other-prompt']) {
    await test(route + '：' + mode, async () => {
      const f = fixture(mode, route);
      await f.run().catch(error => assert.match(error.message, /测试：/));
      assert.equal(f.state.attempts.length, 1, '必须实际到达主写请求边界');
      const released = mode === 'write-unsent' || mode === 'write-rejected';
      assert.equal(pendingOrderMaterialSpends(f.player).length, released ? 0 : 1,
        '仅明确未发送或该写请求被拒才释放预留');
      if (mode === 'write-unsent') assert.equal(f.state.writes.length, 0);
      if (route === 'base-response') assert.equal(f.ledger.snapshot().counters.museumGuides ?? 0, released ? 0 : 1);
    });
  }
  for (const route of ['world-native', 'base-response', 'base-watch', 'cargo-response', 'cargo-watch']) {
    await test(route + '：写完成后回读notSent仍保留预留', async () => {
      const f = fixture('read-unsent', route);
      await f.run().catch(error => assert.match(error.message, /测试：/));
      assert.equal(f.state.writes.length, 1);
      assert(f.state.readFailures.length > 0, '必须触发写完成后的回读失败');
      assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
      assert.equal(f.state.cancelled.length, 0);
    });
  }
  for (const route of ['world-response', 'world-watch', 'hero-response', 'hero-watch', 'cargo-response', 'cargo-watch']) {
    await test(route + '：afterAction的notSent不能撤销已完成主写', async () => {
      const f = fixture('after-unsent', route);
      await f.run().catch(error => assert.match(error.message, /测试：/));
      assert.equal(f.state.writes.length, 1);
      assert.equal(f.state.afterCalls, 1);
      assert.equal(f.state.cancelled.length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
    });
  }
  console.log('消费取消边界专项 ' + passed + '/' + passed + ' 通过');
} finally {
  if (priorData === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = priorData;
  fs.rmSync(directory, { recursive: true, force: true });
}
