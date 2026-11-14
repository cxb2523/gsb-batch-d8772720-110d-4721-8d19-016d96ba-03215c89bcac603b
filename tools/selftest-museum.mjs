import assert from 'node:assert/strict';
import fs from 'node:fs';
import { serviceMuseum } from '../src/museum.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { loadConfig } from '../src/config.mjs';

const protocol = loadProtocol();
const clock = Math.floor(Date.now() / 1000);
const asset = (id = '木板', num = 5) => ({ type: 0, id, num });
const expedition = (extra = {}) => ({ startTime: 0, endTime: 0, heroIds: [], conditionId: 7, factor: 1, cost: { asset: [asset()] }, ...extra });
const stage = (stageId = 1, extra = {}) => ({ stageId, progress: 0, expedition: expedition(), ...extra });
const done = (stageId = 1) => stage(stageId, { expedition: expedition({ startTime: clock - 20000, endTime: clock - 50, heroIds: ['h1', 'h2'] }) });
const config = { tables: Object.fromEntries(Object.entries({
  BuildingUnlockCfg: [{ buildingId: '1博物馆', buildingType: '博物馆', playerLevel: 28 }],
  CargoUnlockCfg: [{ index: 1, playerLevel: 9 }],
  MuseumExpeditionTeamCfg: [{ teamCount: 1, playerLevel: 28 }, { teamCount: 2, playerLevel: 36 }],
  MuseumExploreTimeFactorCfg: [{ factor: 1, playerLevel: 1 }],
  MuseumExpeditionStageCfg: [1, 2, 3].map(stageId => ({ stageId, exploreTime: 14400, name: '遗迹' + stageId })),
  MuseumExpeditionConditionCfg: [{ conditionId: 7, heroCount: 2, heroStar: 2, heroQualityIndex: 1, careerLimit: '战士', factionLimit: '阵营A' }],
  HeroCfg: [1, 2, 3, 4, 5, 6].map(n => ({ id: 'h' + n, qualityIndex: 1, career: '战士', faction: '阵营A' })),
}).map(([name, data]) => [name, { data }])), materialName: id => id };
let serial = 1000;

function mock(options = {}) {
  const player = options.player ?? { playerId: { low: ++serial, high: 2097152 }, worldId: 2000001, guildId: 0, level: 28 };
  const data = {
    stages: [stage()], heroes: [1, 2, 3, 4, 5, 6].map(n => ({ heroId: 'h' + n, level: 1, power: 1000 - n, star: 1, exclusive: { star: 1 } })),
    stock: 30, buildings: [{ buildingId: '1博物馆', level: 1 }], workerOrder: [], ship: [], activityTime: [], weekOrder: [], ...options,
  };
  const calls = [], writes = [], reports = [];
  const client = { data, async request(name, body, responseName) {
    assert(protocol[name]); assert(protocol[responseName]);
    assert.equal(responseName, name.replace(/Request$/, 'Response'));
    calls.push({ name, body });
    const writing = ['MuseumCompleteExploreRequest', 'MuseumRewardRequest', 'MuseumStartExploreRequest'].includes(name);
    if (writing) {
      const decodedBody = protocol[name].decode(protocol[name].encode(body).finish());
      assert.equal(decodedBody.stageId, body.stageId);
      writes.push({ name, body: structuredClone(body) });
    }
    data.before?.(name, client);
    if (data.fail === name) throw (data.reject ? Object.assign(new Error('server prompt: feature locked'), { prompt: {}, request: data.rejectRequest ?? name }) : new Error('timeout waiting for ' + responseName + ' (sent ' + name + ')'));
    let result;
    const s = data.stages.find(s => s.stageId === body.stageId);
    switch (name) {
      case 'MuseumInfoRequest': result = { popularity: 0, topPopularity: 0, uncollectedRevenue: 0, revenueLastSettleTime: 0, exploreStages: data.staleStages ?? data.stages }; break;
      case 'AllHeroRequest': result = { heroes: data.heroes }; break;
      case 'OnWaterRequest': return { building: data.buildings, workerOrder: data.workerOrder };
      case 'AllItemRequest': result = { items: [{ itemId: '木板', num: data.stock }] }; break;
      case 'WeekInfoRequest': return { activityTime: data.activityTime };
      case 'WeekOrderInfoRequest': return { order: data.weekOrder, isGotFinal: false };
      case 'CargoShipsRequest': return { ship: data.ship };
      case 'MuseumCompleteExploreRequest':
        result = { grade: 3, progressGain: 20, factor: 1, fixedReward: { asset: [asset('人气币', 100)] }, randomReward: { asset: [] } }; break;
      case 'MuseumRewardRequest':
        s.progress += 20; s.expedition = expedition();
        result = { reward: { asset: [asset('人气币', 100)] }, exploreStage: s }; break;
      case 'MuseumStartExploreRequest':
        assert.equal(body.factor, 1);
        s.expedition = expedition({ heroIds: body.heroIds, startTime: Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000),
          endTime: Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000) + 14400 });
        if (!data.staleStock) data.stock -= 5;
        result = { expedition: s.expedition }; break;
      default: assert.fail('意外请求 ' + name);
    }
    if (data.invalid === name) result = name === 'MuseumCompleteExploreRequest' ? { grade: 0, progressGain: 0 } : {};
    if (data.responseOverride?.[name]) result = data.responseOverride[name];
    data.after?.(name, client);
    if (data.lost === name) throw new Error('timeout waiting for ' + responseName + ' (sent ' + name + ')');
    // All museum responses, hero rosters and item numbers go through the real
    // codec, including required fields, int64 values and repeated defaults.
    return protocol[responseName].decode(protocol[responseName].encode(result).finish());
  } };
  const run = extra => serviceMuseum(client, protocol, config, { player, enabled: () => true, report: entry => reports.push(entry), ...extra });
  return { client, data, player, calls, writes, reports, run };
}

const count = (f, name) => f.writes.filter(w => w.name === name + 'Request').length;

export async function testMuseum() {
  const actual = loadConfig().tables;
  assert(actual.BuildingUnlockCfg.data.some(r => r.buildingType === '博物馆' && r.playerLevel === 28));
  assert(actual.MuseumExpeditionTeamCfg.data.some(r => r.teamCount === 1 && r.playerLevel === 28));
  // Verify the actual client flow, rather than assuming progress is a claimed
  // star marker: Complete opens OverPop; its claim button sends Reward.
  const clientSource = new URL('../work/extracted/_subpackages_main_/subpackages/main/game.js', import.meta.url);
  if (fs.existsSync(clientSource)) {
    const source = fs.readFileSync(clientSource, 'utf8');
    assert.match(source, /_onClaim=function\(\)\{[^}]{0,160}MuseumRewardRequest/);
    assert.match(source, /busyHeroIds=function[\s\S]{0,500}1===s\|\|2===s/);
  }
  const off = mock(); await serviceMuseum(off.client, protocol, config, { player: off.player }); assert.equal(off.calls.length, 0);
  const low = mock(); low.player.level = 1;
  assert.equal((await low.run()).filter(e => e.skipped).length, 2); assert.equal(low.calls.length, 0);
  for (const buildings of [[], [{ buildingId: '1博物馆', level: 0 }], [{ buildingId: '1博物馆', level: 1, buildStartTime: clock - 100, buildFinishTime: clock - 1 }]]) {
    const unavailable = mock({ buildings, stages: [done()] });
    assert.equal((await unavailable.run()).filter(e => e.skipped).length, 2);
    assert.equal(unavailable.writes.length, 0, '服务器有旧关卡也不能对未建成/施工中的博物馆操作');
  }
  for (const action of ['MuseumCompleteExploreRequest', 'MuseumRewardRequest', 'MuseumStartExploreRequest']) for (const unavailable of ['construction', 'missing', 'read-failure']) {
    const f = mock({ stages: action === 'MuseumStartExploreRequest' ? [stage()] : [done()] });
    let change = true;
    f.data.before = (name, client) => {
      // Complete has one initial and one write-time building read; Reward has
      // one more. Start also reads buildings for shared inventory reservations.
      const reads = f.calls.filter(c => c.name === 'OnWaterRequest').length;
      const threshold = action === 'MuseumCompleteExploreRequest' ? 2 : 3;
      if (change && name === 'OnWaterRequest' && reads === threshold) {
        if (unavailable === 'construction') client.data.buildings[0].buildStartTime = clock;
        else if (unavailable === 'missing') client.data.buildings = [];
        else throw new Error('timeout waiting for OnWaterResponse');
      }
    };
    await f.run({ enabled: key => key === (action === 'MuseumStartExploreRequest' ? 'museumExplore' : 'museumCollect') });
    assert.equal(count(f, action.replace('Request', '')), 0, '写前检查建筑不可用状态：' + action + '/' + unavailable);
    change = false; f.data.buildings = [{ buildingId: '1博物馆', level: 1 }];
    await f.run({ enabled: key => key === (action === 'MuseumStartExploreRequest' ? 'museumExplore' : 'museumCollect') });
    assert.equal(count(f, action.replace('Request', '')), 1, '尚未发送的操作不能留下永久防重锁：' + action);
  }

  const first = mock();
  assert((await first.run()).some(e => e.key === 'museumExplore' && e.ok));
  assert.equal(count(first, 'MuseumStartExplore'), 1);
  assert.deepEqual(first.writes[0].body.heroIds, ['h1', 'h2'], '专武星级纳入条件；与主线/舰队任命无额外冲突过滤');
  await first.run(); assert.equal(count(first, 'MuseumStartExplore'), 1, '运行中不重复派队');
  assert.equal(count(first, 'MuseumReward'), 0, '进度/星级不是可领取标记');
  first.client.serverClockOffsetMs = 14401 * 1000;
  assert((await first.run()).some(e => e.key === 'museumCollect' && e.ok));
  assert.equal(count(first, 'MuseumCompleteExplore'), 1);
  assert.equal(count(first, 'MuseumReward'), 1);
  assert.equal(count(first, 'MuseumStartExplore'), 2, '派队→到期结算→实际领取→同关卡续派形成完整闭环');

  const finish = mock({ stages: [done()] });
  assert((await finish.run({ enabled: key => key === 'museumCollect' })).some(e => e.ok));
  assert.deepEqual(finish.writes.map(w => w.name), ['MuseumCompleteExploreRequest', 'MuseumRewardRequest']);
  assert.equal(finish.data.stages[0].progress, 20);
  await finish.run({ enabled: key => key === 'museumCollect' }); assert.equal(finish.writes.length, 2);
  const progressOnly = mock({ stages: [stage(1, { progress: 750 })] });
  await progressOnly.run({ enabled: key => key === 'museumCollect' }); assert.equal(progressOnly.writes.length, 0);

  let on = true;
  const cancel = mock({ stages: [done()], after(name) { if (name === 'MuseumCompleteExploreRequest') on = false; } });
  await cancel.run({ enabled: key => key === 'museumCollect' && on });
  assert.equal(count(cancel, 'MuseumCompleteExplore'), 1); assert.equal(count(cancel, 'MuseumReward'), 0);
  on = true; cancel.data.after = undefined;
  const resumed = mock({ player: cancel.player, stages: structuredClone(cancel.data.stages) });
  await resumed.run({ enabled: key => key === 'museumCollect' });
  assert.equal(count(resumed, 'MuseumCompleteExplore'), 0, '同账号换连接沿用已经确认的结算结果');
  assert.equal(count(resumed, 'MuseumReward'), 1);

  for (const request of ['MuseumCompleteExploreRequest', 'MuseumRewardRequest', 'MuseumStartExploreRequest']) {
    const f = mock({ stages: request === 'MuseumStartExploreRequest' ? [stage()] : [done()], fail: request });
    assert((await f.run()).some(e => e.ok === false));
    const retry = mock({ player: f.player, stages: structuredClone(f.data.stages) });
    await retry.run();
    assert.equal(count(retry, request.replace('Request', '')), 0, '超时后换连接也不能重复写：' + request);
    assert.equal(count(retry, 'MuseumStartExplore'), 0, '未领取的旧探险与未知派队都占用名额');
  }
  for (const request of ['MuseumCompleteExploreRequest', 'MuseumRewardRequest', 'MuseumStartExploreRequest']) {
    const denied = mock({ stages: request === 'MuseumStartExploreRequest' ? [stage()] : [done()], fail: request, reject: true });
    await denied.run(); denied.data.fail = undefined;
    assert((await denied.run()).some(e => e.ok));
    assert.equal(count(denied, request.replace('Request', '')), 2, '对应请求明确拒绝可以重新检查后尝试：' + request);
    const unrelated = mock({ stages: request === 'MuseumStartExploreRequest' ? [stage()] : [done()], fail: request, reject: true, rejectRequest: 'OtherRequest' });
    await unrelated.run(); unrelated.data.fail = undefined; await unrelated.run();
    assert.equal(count(unrelated, request.replace('Request', '')), 1, '其他请求提示不能解除结果未知的防重锁：' + request);
  }

  const rewardLost = mock({ stages: [done()], lost: 'MuseumRewardRequest' });
  await rewardLost.run();
  const reconnected = mock({ player: rewardLost.player, stages: structuredClone(rewardLost.data.stages) });
  await reconnected.run({ enabled: key => key === 'museumCollect' });
  assert.equal(reconnected.writes.length, 0, '领奖回包丢失但服务器进度和队伍已更新，不能再领');
  const emptyReward = mock({ stages: [done()], responseOverride: { MuseumRewardRequest: { exploreStage: stage(1, { progress: 20 }) } } });
  assert((await emptyReward.run()).some(e => e.ok === false));
  assert(!emptyReward.reports.some(e => e.ok), '没有实际reward不能仅凭progress报领取成功');

  const held = mock({ stock: 12, workerOrder: [{ index: 1, requirements: [asset('木板', 3)] }],
    ship: [{ status: 0, orderItem: [{ filled: false, asset: asset('木板', 2) }] }],
    activityTime: [{ type: 5, period: 1, startTime: clock - 100, endTime: clock + 1000 }], weekOrder: [asset('木板', 3)] });
  assert((await held.run()).some(e => /预留|保留/.test(e.reason))); assert.equal(held.writes.length, 0);
  held.data.stock = 13;
  assert((await held.run()).some(e => e.ok)); assert.equal(held.data.stock, 8);
  const missingRead = mock({ fail: 'OnWaterRequest' }); await missingRead.run(); assert.equal(missingRead.writes.length, 0);

  const two = mock({ stages: [stage(1), stage(2), stage(3)] }); two.player.level = 36;
  await two.run(); assert.equal(count(two, 'MuseumStartExplore'), 1, '每轮最多新开一队');
  await two.run(); assert.equal(count(two, 'MuseumStartExplore'), 2);
  assert.deepEqual(two.writes[1].body.heroIds, ['h3', 'h4'], '不能让两个探险同时使用相同英雄');
  await two.run(); assert.equal(count(two, 'MuseumStartExplore'), 2, '按等级队伍容量止步');
  const finishedOccupies = mock({ stages: [done(1), stage(2)] });
  await finishedOccupies.run({ enabled: key => key === 'museumExplore' }); assert.equal(finishedOccupies.writes.length, 0, '已到期未领奖仍占队伍');
  const occupiedHeroes = mock({ stages: [stage(1, { expedition: expedition({ startTime: clock, endTime: clock + 1000, heroIds: ['h1', 'h2'] }) }), stage(2)],
    heroes: [{ heroId: 'h1', star: 2, level: 1, power: 1000 }, { heroId: 'h2', star: 2, level: 1, power: 900 }] });
  occupiedHeroes.player.level = 36; await occupiedHeroes.run(); assert.equal(occupiedHeroes.writes.length, 0);
  const stale = mock({ stock: 5, staleStock: true, stages: [stage(1), stage(2)] }); stale.player.level = 36;
  stale.data.staleStages = structuredClone(stale.data.stages);
  await stale.run(); await stale.run(); assert.equal(count(stale, 'MuseumStartExplore'), 1, '仅收到派队回包，关卡状态未同步时不能重复花同一份材料');

  for (const remove of ['BuildingUnlockCfg', 'MuseumExpeditionTeamCfg', 'MuseumExploreTimeFactorCfg', 'MuseumExpeditionConditionCfg', 'MuseumExpeditionStageCfg']) {
    const c = mock();
    const without = { ...config, tables: { ...config.tables, [remove]: { data: [] } } };
    await serviceMuseum(c.client, protocol, without, { player: c.player, enabled: () => true });
    assert.equal(c.writes.length, 0, '缺配置时不猜：' + remove);
  }
  const noCost = mock({ stages: [stage(1, { expedition: expedition({ cost: { asset: [] } }) })] });
  await noCost.run(); assert.equal(noCost.writes.length, 0);
  const changed = mock({ before(name, client) { if (name === 'AllHeroRequest') client.data.heroes.forEach(h => { h.star = 0; h.exclusive.star = 0; }); } });
  await changed.run(); assert.equal(changed.writes.length, 0);
  const occupiedLate = mock({ stages: [stage(1), stage(2)], before(name, client) {
    if (name === 'AllHeroRequest') client.data.stages[1].expedition = expedition({ heroIds: ['h1', 'h2'], startTime: clock, endTime: clock + 1000 });
  } });
  await occupiedLate.run(); assert.equal(occupiedLate.writes.length, 0, '读取英雄期间其他关卡占队，写入前须重新核对');
  const identityChange = mock({ before(name) { if (name === 'AllItemRequest') identityChange.player.playerId.low++; } });
  await identityChange.run(); assert.equal(identityChange.writes.length, 0);

  const due = mock({ stages: [done()] }); const deadlines = [];
  await due.run({ scheduler: { due: key => key === 'museumExplore', now: () => clock, defer: (...args) => deadlines.push(args) } });
  assert.equal(due.writes.length, 0, '派队到期不应顺带结算未到期的开关');
  assert(deadlines.every(([key]) => key === 'museumExplore'));
  const scheduled = mock({ stages: [stage(1, { expedition: expedition({ startTime: clock, endTime: clock + 14400, heroIds: ['h1', 'h2'] }) })] });
  const checks = [];
  await scheduled.run({ scheduler: { due: () => true, now: () => clock, defer: (...args) => checks.push(args) } });
  assert(checks.some(([key, at]) => key === 'museumCollect' && at === clock + 14405));
  assert(checks.some(([key, at]) => key === 'museumExplore' && at === clock + 14405));
  const onlyCollect = mock({ stages: [done()] });
  await onlyCollect.run({ scheduler: { due: key => key === 'museumCollect', now: () => clock, defer() {} } });
  assert.equal(count(onlyCollect, 'MuseumStartExplore'), 0);
  const overlap = mock(); await Promise.all([overlap.run(), overlap.run()]); assert.equal(count(overlap, 'MuseumStartExplore'), 1);
  const isolated = mock(); await isolated.run(); assert.equal(count(isolated, 'MuseumStartExplore'), 1, '不同账号状态互不污染');
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testMuseum();
  console.log('museum ok: real protocol flow, two-phase collection, reserved materials, team capacity, identity and uncertain outcomes');
}
