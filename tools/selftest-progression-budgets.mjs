import assert from 'node:assert/strict';
import { serviceGuildOrders } from '../src/guild-orders.mjs';
import { serviceMuseum } from '../src/museum.mjs';
import { readOrderReservedStock } from '../src/order-reservations.mjs';

const now = () => Math.floor(Date.now() / 1000);
const asset = num => ({ id: 'wood', type: 0, num });
const config = { tables: Object.fromEntries(Object.entries({
  ModuleOpenCfg: [{ moduleId: '联盟', playerLevel: 16 }],
  BuildingUnlockCfg: [{ buildingId: 'museum', buildingType: '博物馆', playerLevel: 28 }],
  CargoUnlockCfg: [{ index: 1, playerLevel: 9 }],
  GuildOrderNumCfg: [{ season: 2, playerLevel: 1, maxNum: 10 }],
  GuildOrderCfg: [{ itemId: 'wood' }],
  MuseumExpeditionTeamCfg: [{ playerLevel: 28, teamCount: 1 }],
  MuseumExploreTimeFactorCfg: [{ playerLevel: 1, factor: 1 }],
  MuseumExpeditionStageCfg: [{ stageId: 1, exploreTime: 14400, name: '遗迹' }],
  MuseumExpeditionConditionCfg: [{ conditionId: 1, heroCount: 1, heroStar: 0, heroQualityIndex: 1, careerLimit: '', factionLimit: '' }],
  HeroCfg: [{ id: 'h1', qualityIndex: 1, career: '战士', faction: '' }],
}).map(([name, data]) => [name, { data }])), materialName: id => id };
const names = ['GuildInfo', 'GuildOrder', 'GuildCityInfo', 'CounterInfo', 'OnWater', 'AllItem', 'WeekInfo', 'WeekOrderInfo', 'CargoShips',
  'FinishGuildOrder', 'MuseumInfo', 'MuseumStartExplore', 'MuseumCompleteExplore', 'MuseumReward', 'AllHero'];
const protocol = Object.fromEntries(names.flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
let serial = 80000;

function fixture() {
  const f = {
    player: { playerId: ++serial, worldId: 2000001, guildId: 123, level: 28 },
    actualStock: 10, visibleStock: 10, stale: true, done: 0, writes: [], reports: [], calls: [],
    stages: [{ stageId: 1, progress: 0, expedition: { heroIds: [], startTime: 0, endTime: 0, factor: 1, conditionId: 1, cost: { asset: [asset(5)] } } }],
    async request(name, body, response) {
      assert.equal(response, name.replace('Request', 'Response'));
      this.calls.push(name);
      let result;
      switch (name) {
        case 'GuildInfoRequest': result = { guild: { guildId: this.player.guildId } }; break;
        case 'GuildOrderRequest': result = { order: { requirements: [asset(5)], nextRefreshTime: now() + 86400 } }; break;
        case 'GuildCityInfoRequest': result = { cities: [{ cityId: 1, recommended: true }] }; break;
        case 'CounterInfoRequest': result = { counters: [{ type: 'DAILY_FINISH_GUILD_ORDER', num: this.done }] }; break;
        case 'OnWaterRequest': result = { building: [{ buildingId: 'museum', level: 1 }], workerOrder: [{ index: 1, workerId: 1, requirements: [asset(5)] }] }; break;
        case 'AllItemRequest':
          if (this.itemReadMode === 'failed') throw new Error('inventory read failed');
          result = this.itemReadMode === 'missing' ? {}
            : this.itemReadMode === 'duplicate' ? { items: [{ itemId: 'wood', num: 10 }, { itemId: 'wood', num: 10 }] }
              : { items: [{ itemId: 'wood', num: this.itemReadMode === 'negative' ? -1 : this.stale ? this.visibleStock : this.actualStock }] };
          break;
        case 'WeekInfoRequest': result = { activityTime: [] }; break;
        case 'CargoShipsRequest': result = { ship: [] }; break;
        case 'AllHeroRequest': result = { heroes: [{ heroId: 'h1', power: 100, star: 1 }] }; break;
        case 'MuseumInfoRequest': result = { exploreStages: this.stale && this.staleMuseumState ? this.initialStages : this.stages }; break;
        case 'FinishGuildOrderRequest':
          this.writes.push(name);
          if (this.reject === name) throw Object.assign(new Error('server refused'), { prompt: {}, request: name });
          if (this.uncertainPrompt === name) throw Object.assign(new Error('unattributed prompt'), { prompt: {} });
          if (this.timeout === name) throw new Error('timeout');
          this.actualStock -= 5; this.done++;
          this.afterWrite?.(name);
          result = { reward: { asset: [{ type: 0, id: '功勋', num: 25 }] } };
          if (this.lost === name) throw new Error('reply lost');
          break;
        case 'MuseumStartExploreRequest':
          this.writes.push(name);
          if (this.reject === name) throw Object.assign(new Error('server refused'), { prompt: {}, request: name });
          if (this.uncertainPrompt === name) throw Object.assign(new Error('unattributed prompt'), { prompt: {} });
          if (this.timeout === name) throw new Error('timeout');
          this.actualStock -= 5;
          this.stages[0].expedition = { ...this.stages[0].expedition, heroIds: body.heroIds, startTime: now(), endTime: now() + 14400 };
          this.afterWrite?.(name);
          result = { expedition: this.stages[0].expedition };
          if (this.lost === name) throw new Error('reply lost');
          break;
        default: assert.fail('unexpected request ' + name);
      }
      return structuredClone(result);
    },
    guild() { return serviceGuildOrders(this, protocol, config, { player: this.player, enabled: () => true, report: e => this.reports.push(e) }); },
    museum() { return serviceMuseum(this, protocol, config, { player: this.player, enabled: key => key === 'museumExplore', report: e => this.reports.push(e) }); },
    stock() { return readOrderReservedStock(this, protocol, config, { player: this.player }); },
  };
  f.initialStages = structuredClone(f.stages);
  return f;
}

export async function testProgressionBudgets() {
  const guildFirst = fixture();
  guildFirst.stale = false;
  guildFirst.afterWrite = request => { if (request === 'FinishGuildOrderRequest') guildFirst.actualStock += 5; };
  assert((await guildFirst.guild()).ok);
  assert.equal(guildFirst.actualStock, 10, 'production restores the consumed materials before the complete inventory read');
  assert((await guildFirst.museum()).some(e => e.ok), 'acknowledged order and complete replenished inventory allow the next consumer');
  assert.deepEqual(guildFirst.writes, ['FinishGuildOrderRequest', 'MuseumStartExploreRequest']);
  assert.equal(guildFirst.actualStock, 5, 'the next consumer still leaves the resident reservation intact');
  await guildFirst.museum();
  assert.equal(guildFirst.writes.length, 2, 'another loop cannot repeat a running expedition');
  const reconnected = Object.create(guildFirst);
  await reconnected.museum();
  assert.equal(guildFirst.writes.length, 2, 'reconnection still recognizes the running expedition');

  for (const mode of ['missing', 'duplicate', 'negative', 'failed']) {
    const incomplete = fixture();
    incomplete.stale = false;
    incomplete.afterWrite = request => {
      if (request === 'FinishGuildOrderRequest') { incomplete.actualStock += 5; incomplete.itemReadMode = mode; }
    };
    assert((await incomplete.guild()).ok, 'the direct order receipt confirms the operation');
    await assert.rejects(incomplete.stock(), /库存|inventory/, 'invalid inventory cannot settle an acknowledged debit');
    assert(!(await incomplete.museum()).some(e => e.ok));
    await Object.create(incomplete).museum();
    incomplete.player.guildId = 456;
    await Object.create(incomplete).museum();
    assert.deepEqual(incomplete.writes, ['FinishGuildOrderRequest'], 'read failures retain protection across connections and guild changes');
    incomplete.itemReadMode = undefined;
    assert((await incomplete.museum()).some(e => e.ok), 'a later complete replenished inventory recovers the acknowledged order');
    assert.equal(incomplete.actualStock, 5, 'recovery still preserves resident materials');
  }

  const otherAccount = fixture();
  assert((await otherAccount.museum()).some(e => e.ok));
  assert.equal(otherAccount.writes.length, 1, 'pending materials are account-isolated');
  assert.equal((await guildFirst.stock()).available.get('wood'), 0, 'a confirmed debit leaves existing resident goods intact');

  const museumFirst = fixture();
  museumFirst.staleMuseumState = true;
  assert(!(await museumFirst.museum()).some(e => e.ok), 'a dispatch response alone cannot confirm an unsynchronized expedition');
  assert.equal(museumFirst.actualStock, 5);
  assert.match((await museumFirst.guild()).reason, /扣款尚未确认/);
  assert.deepEqual(museumFirst.writes, ['MuseumStartExploreRequest']);
  await Object.create(museumFirst).guild();
  assert.equal(museumFirst.writes.length, 1);
  museumFirst.stale = false;
  await museumFirst.stock();
  museumFirst.actualStock += 5;
  assert((await museumFirst.guild()).ok);
  assert.equal(museumFirst.actualStock, 5, 'reverse order also preserves resident materials');

  for (const request of ['FinishGuildOrderRequest', 'MuseumStartExploreRequest']) {
    const f = fixture(); f.timeout = request;
    if (request === 'FinishGuildOrderRequest') await f.guild(); else await f.museum();
    await assert.rejects(Object.create(f).stock(), /扣款尚未确认/, 'unknown write must keep its cross-module debit');
    if (request === 'FinishGuildOrderRequest') await f.museum(); else await f.guild();
    assert.equal(f.writes.length, 1);
    const unrelated = fixture(); assert((await unrelated.guild()).ok);

    const denied = fixture(); denied.reject = request;
    if (request === 'FinishGuildOrderRequest') await denied.guild(); else await denied.museum();
    assert.equal((await denied.stock()).available.get('wood'), 5, 'definite rejection releases the reservation');
    denied.reject = undefined;
    if (request === 'FinishGuildOrderRequest') assert((await denied.museum()).some(e => e.ok));
    else assert((await denied.guild()).ok);
    assert.equal(denied.writes.length, 2);

    const late = fixture(); late.lost = request;
    late.staleMuseumState = true;
    late.afterWrite = () => { late.actualStock += 5; };
    if (request === 'FinishGuildOrderRequest') await late.guild(); else await late.museum();
    if (request === 'MuseumStartExploreRequest') await assert.rejects(late.stock(), /扣款尚未确认/, 'inventory alone cannot prove an unobserved expedition');
    else assert.equal((await late.stock()).available.get('wood'), 5, 'same-day order counter growth followed by complete replenished inventory recovers a lost receipt');
    assert.equal(late.writes.length, 1, 'recovery reads never repeat the operation');
    late.stale = false;
    assert.equal((await late.stock()).available.get('wood'), 5, 'matching business state followed by complete inventory recovers without a net decrease');

    const unattributed = fixture(); unattributed.uncertainPrompt = request;
    if (request === 'FinishGuildOrderRequest') await unattributed.guild(); else await unattributed.museum();
    await assert.rejects(unattributed.stock(), /扣款尚未确认/, 'a prompt without request attribution must not release the shared material guard');
    if (request === 'FinishGuildOrderRequest') await unattributed.museum(); else await unattributed.guild();
    assert.equal(unattributed.writes.length, 1);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testProgressionBudgets();
  console.log('progression material budgets ok: replenished balances, invalid inventory protection, business evidence, reconnects, guild changes and unknown outcomes');
}
