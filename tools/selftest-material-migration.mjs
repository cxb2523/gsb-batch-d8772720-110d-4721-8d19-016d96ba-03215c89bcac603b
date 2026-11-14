import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceCargo } from '../src/cargo.mjs';
import { runBaseAutomation } from '../src/base-automation.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { beginOrderMaterialSpend, cancelOrderMaterialSpend, readOrderReservedStock } from '../src/order-reservations.mjs';
import { SPEED_UP_ITEM } from '../src/world.mjs';

const now = () => Math.floor(Date.now() / 1000);
const asset = (id, num) => ({ type: 0, id, num });
const config = { tables: { CargoUnlockCfg: { data: [{ index: 1, playerLevel: 9 }] } }, materialName: id => id };
const names = ['OnWater', 'AllItem', 'WeekInfo', 'WeekOrderInfo', 'CargoShips', 'MuseumInfo', 'MuseumStartExplore'];
const protocol = Object.fromEntries(names.flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
const tempRoot = path.resolve(os.tmpdir());
let serial = 960000;

function fixture(directory) {
  const player = { playerId: ++serial, worldId: 1000001, guildId: 10, level: 30 };
  const settings = defaultSettings(); settings.cargo.enabled = true; settings.museum.enabled = true;
  const ledger = createUsageLedger(String(player.playerId), { file: path.join(directory, String(player.playerId) + '.json') });
  return {
    player, settings, ledger, connected: true, running: true, stale: true,
    actual: new Map([['fish', 20], ['wood', 20], [SPEED_UP_ITEM, 2]]),
    visible: new Map([['fish', 20], ['wood', 20], [SPEED_UP_ITEM, 2]]),
    ships: [{ index: 1, status: 0, orderItem: [{ filled: false, asset: asset('fish', 5) }] }],
    resident: [], week: [], weekOrder: [], writes: [], prepared: [], cancelled: [], reports: [],
    async request(name, body) {
      switch (name) {
        case 'AllItemRequest': {
          const items = [...(this.stale ? this.visible : this.actual)].map(([itemId, num]) => ({ itemId, num }));
          return { items: this.inventory?.(items) ?? items };
        }
        case 'CargoShipsRequest': return { ship: structuredClone(this.ships) };
        case 'OnWaterRequest': return { building: [], workerOrder: structuredClone(this.resident) };
        case 'WeekInfoRequest': return { activityTime: structuredClone(this.week) };
        case 'WeekOrderInfoRequest': return { order: structuredClone(this.weekOrder), isGotFinal: false };
        case 'MuseumInfoRequest': return { exploreStages: [{ stageId: 1, progress: 0,
          expedition: !this.stale && this.expedition ? structuredClone(this.expedition)
            : { startTime: 0, endTime: 0, heroIds: [], factor: 1, cost: { asset: [asset('fish', this.museumCost)] } } }] };
        case 'MuseumStartExploreRequest':
          this.writes.push(name);
          this.actual.set('fish', this.actual.get('fish') - this.museumCost);
          this.expedition = { startTime: now(), endTime: now() + 3600, heroIds: [...body.heroIds], factor: body.factor };
          return { expedition: structuredClone(this.expedition) };
        case 'FillCargoShipRequest': {
          this.writes.push(name); this.failBefore(name);
          const ship = this.ships.find(row => row.index === body.shipIndex);
          for (const slot of body.cargoIndex) {
            const item = ship.orderItem[slot - 1];
            this.actual.set(item.asset.id, this.actual.get(item.asset.id) - item.asset.num);
            item.filled = true;
          }
          if (ship.orderItem.every(item => item.filled)) { ship.status = 1; ship.arriveTime = now() + 3600; }
          if (this.failure === 'lost') throw new Error('reply lost');
          return {};
        }
        default: assert.fail('unexpected request ' + name);
      }
    },
    failBefore(request) {
      if (this.failure === 'refused') throw Object.assign(new Error('server refused'), { prompt: {}, request });
      if (this.failure === 'unattributed') throw Object.assign(new Error('unattributed prompt'), { prompt: {} });
      if (this.failure === 'unrelated') throw Object.assign(new Error('unrelated prompt'), { prompt: {}, request: 'OtherRequest' });
      if (this.failure === 'timeout') throw new Error('timeout');
    },
    async sendWatch(name) {
      assert.equal(name, 'SpeedUpShipRequest');
      this.writes.push(name); this.failBefore(name);
      this.actual.set(SPEED_UP_ITEM, this.actual.get(SPEED_UP_ITEM) - 1);
      this.ships[0].arriveTime -= 600;
      if (this.failure === 'lost') throw new Error('reply lost');
      return {};
    },
    cargo(options = {}) {
      const guard = createActionGuard(this, () => this.settings, this.ledger, { player: this.player, enabled: () => this.running });
      return serviceCargo(this, config, {
        enabled: () => this.running, getSettings: () => this.settings, ledger: this.ledger,
        beforeAction: async step => {
          this.prepared.push(step);
          const ticket = await guard.before(step);
          await this.afterBefore?.(step);
          return ticket;
        },
        afterAction: guard.after,
        cancelAction: (step, ticket, details) => { this.cancelled.push({ step, details }); return guard.cancel(step, ticket, details); },
        log: (label, details) => this.reports.push({ label, ...details }), ...options,
      });
    },
    read() { return readOrderReservedStock(this, protocol, config, { player: this.player }); },
    museum(cost) {
      this.museumCost = cost;
      return runBaseAutomation(this, protocol, config, { actions: [{
        kind: 'museumStart', scope: 'base', setting: 'museum.enabled', request: 'MuseumStartExploreRequest', response: 'MuseumStartExploreResponse',
        body: { stageId: 1, heroIds: ['h1'], factor: 1 }, costs: [{ id: 'fish', num: cost }], label: 'museum dispatch',
      }] }, { player: this.player, getSettings: () => this.settings, ledger: this.ledger, enabled: () => this.running });
    },
  };
}

export async function testMaterialMigration() {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'cw-material-migration-'));
  try {
    for (const id of ['fish', 'wood']) {
      const oldFirst = fixture(directory);
      beginOrderMaterialSpend(oldFirst.player, [{ id, have: 20, need: 5 }], 'legacy consumer');
      oldFirst.actual.set(id, 15);
      await assert.rejects(oldFirst.cargo(), /扣款尚未确认/);
      assert.deepEqual(oldFirst.writes, []);
      assert.equal(oldFirst.ledger.snapshot().uncertain, 0);
      const reconnected = Object.create(oldFirst); oldFirst.player.guildId++;
      await assert.rejects(reconnected.cargo(), /扣款尚未确认/, 'connection and guild changes cannot release an old debit');
      oldFirst.stale = false;
      await oldFirst.cargo();
      assert.deepEqual(oldFirst.writes, ['FillCargoShipRequest']);
      await oldFirst.read();
    }

    const cargoFirst = fixture(directory);
    cargoFirst.ships[0].orderItem = [2, 3].map(num => ({ filled: false, asset: asset('fish', num) }));
    cargoFirst.inventory = items => { if (cargoFirst.writes.length) throw new Error('消费后库存暂不可读'); return items; };
    await cargoFirst.cargo();
    assert.equal(cargoFirst.actual.get('fish'), 15, 'duplicate cargo materials aggregate into one shared debit');
    assert.equal(cargoFirst.prepared[0].request, 'FillCargoShipRequest');
    assert.equal(cargoFirst.ledger.snapshot().counters.cargoLoads, 1);
    assert.equal(cargoFirst.ledger.snapshot().uncertain, 0, 'acknowledged loading confirms the counter but still holds the inventory debit');
    await assert.rejects(cargoFirst.read(), /库存暂不可读/);
    await assert.rejects(Object.create(cargoFirst).read(), /库存暂不可读/);
    const other = fixture(directory);
    await other.cargo(); other.stale = false; await other.read();
    assert.deepEqual(other.writes, ['FillCargoShipRequest'], 'another account has its own material barrier');
    cargoFirst.stale = false;
    delete cargoFirst.inventory;
    assert.equal((await cargoFirst.read()).available.get('fish'), 15);
    const resumed = beginOrderMaterialSpend(cargoFirst.player, [{ id: 'fish', have: 15, need: 1 }], 'legacy resumed');
    cancelOrderMaterialSpend(resumed);

    const refused = fixture(directory); refused.failure = 'refused';
    await assert.rejects(refused.cargo(), /server refused/);
    assert.equal(refused.ledger.snapshot().counters.cargoLoads, 0);
    assert.equal(refused.ledger.snapshot().uncertain, 0);
    assert.equal((await refused.read()).available.get('fish'), 15, 'attributed refusal releases materials and counters');
    refused.failure = null;
    await refused.cargo(); refused.stale = false; await refused.read();
    assert.equal(refused.writes.length, 2);

    for (const failure of ['timeout', 'lost', 'unattributed', 'unrelated']) {
      const uncertain = fixture(directory); uncertain.failure = failure;
      await assert.rejects(uncertain.cargo());
      assert.equal(uncertain.ledger.snapshot().counters.cargoLoads, 1);
      assert.equal(uncertain.ledger.snapshot().uncertain, 1);
      assert.equal(uncertain.cancelled.length, 0);
      if (failure === 'lost') {
        uncertain.stale = false;
        assert.equal((await uncertain.read()).available.get('fish'), 15, 'matching filled slots followed by complete inventory recover a lost reply');
        assert.equal(uncertain.ledger.snapshot().uncertain, 0);
      } else await assert.rejects(uncertain.read(), /扣款尚未确认/, failure + ' must retain its cross-module debit');
    }

    for (const stop of ['pause', 'setting']) {
      const paused = fixture(directory);
      paused.afterBefore = () => { if (stop === 'pause') paused.running = false; else paused.settings.cargo.enabled = false; };
      await paused.cargo();
      assert.deepEqual(paused.writes, [], 'a stop after the guard must prevent loading');
      assert.equal(paused.cancelled[0].details.notSent, true);
      assert.equal(paused.ledger.snapshot().counters.cargoLoads, 0);
      assert.equal(paused.ledger.snapshot().uncertain, 0);
      assert.equal((await paused.read()).available.get('fish'), 15, 'an unsent action releases its material reservation');
    }

    for (const failure of [null, 'refused', 'timeout']) {
      const speed = fixture(directory); speed.ships[0].status = 1; speed.ships[0].arriveTime = now() + 3600; speed.failure = failure;
      if (failure) await assert.rejects(speed.cargo({ testSpeedUp: true }));
      else await speed.cargo({ testSpeedUp: true });
      assert.equal(speed.prepared[0].request, 'SpeedUpShipRequest');
      assert.deepEqual(speed.writes, ['SpeedUpShipRequest']);
      if (failure === 'refused') await speed.read();
      else if (failure) await assert.rejects(speed.read(), /扣款尚未确认/, 'unconfirmed speed-up retains its material reservation');
      else { speed.stale = false; await speed.read(); }
    }
    const stoppedSpeed = fixture(directory); stoppedSpeed.ships[0].status = 1; stoppedSpeed.ships[0].arriveTime = now() + 3600;
    stoppedSpeed.afterBefore = () => { stoppedSpeed.running = false; };
    await stoppedSpeed.cargo({ testSpeedUp: true });
    assert.deepEqual(stoppedSpeed.writes, []);
    assert.equal(stoppedSpeed.cancelled[0].details.notSent, true);
    await stoppedSpeed.read();

    const preview = fixture(directory);
    await preview.cargo({ dryRun: true });
    assert.deepEqual(preview.writes, []); assert.deepEqual(preview.prepared, []);
    assert.equal(preview.ledger.snapshot().uncertain, 0);
    assert(preview.reports.some(row => row.planned));
    await preview.read();
    const pending = beginOrderMaterialSpend(preview.player, [{ id: 'wood', have: 20, need: 5 }], 'old pending during preview');
    await preview.cargo({ dryRun: true });
    await assert.rejects(preview.read(), /扣款尚未确认/, 'a dry preview cannot clear an existing debit');
    cancelOrderMaterialSpend(pending);

    for (const inventory of [items => [...items, { itemId: 'wood', num: 1 }], items => items.map(row => row.itemId === 'wood' ? { ...row, num: -1 } : row)]) {
      const malformed = fixture(directory); malformed.inventory = inventory;
      await assert.rejects(malformed.cargo(), /完整确认/);
      assert.deepEqual(malformed.writes, [], 'partial or malformed inventory must never release an old debit');
    }

    const museum = fixture(directory);
    museum.resident = [{ index: 1, workerId: 1, requirements: [asset('fish', 5)] }];
    museum.week = [{ type: 5, period: 1, startTime: now() - 60, endTime: now() + 3600 }];
    museum.weekOrder = [asset('fish', 5)];
    const blocked = await museum.museum(6);
    assert.equal(blocked[0].ok, false);
    assert.match(blocked[0].error, /周订单.*贸易港.*居民订单/);
    assert.deepEqual(museum.writes, []);
    assert((await museum.museum(5))[0].ok, 'only stock beyond all three order reservations is available to a new expedition');
    await assert.rejects(museum.read(), /扣款尚未确认/);
    museum.stale = false;
    assert.equal((await museum.read()).available.get('fish'), 0);

    const museumPending = fixture(directory);
    beginOrderMaterialSpend(museumPending.player, [{ id: 'fish', have: 20, need: 5 }], 'old museum');
    assert.match((await museumPending.museum(1))[0].error, /扣款尚未确认/);
    assert.deepEqual(museumPending.writes, []);
  } finally {
    const cleanup = path.resolve(directory);
    assert.equal(path.dirname(cleanup), tempRoot);
    assert(path.basename(cleanup).startsWith('cw-material-migration-'));
    fs.rmSync(cleanup, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testMaterialMigration();
  console.log('material migration ok: real cargo guard, stale balances, cancellation, previews and museum order reservations');
}
