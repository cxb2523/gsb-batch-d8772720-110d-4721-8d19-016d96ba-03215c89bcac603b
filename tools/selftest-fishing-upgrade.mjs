import assert from 'node:assert/strict';
import { upgradeFishingOnce } from '../src/fishing-upgrade.mjs';

const levels = [
  { level: 1, enhance: 10, cost: ['GOLD', 50], condition: ['钓鱼椅', 1] },
  { level: 2, enhance: 10, cost: ['GOLD', 300], condition: ['钓鱼椅', 2] },
];
const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '小玩法升级', playerLevel: 7 }] },
  FishLevelCfg: { data: levels },
} };
const ordinary = { level: 1, enhance: 2 };
const promote = { level: 1, enhance: 10 };
const chairs = [{ buildingId: '1钓鱼椅', level: 3 }, { buildingId: '2钓鱼椅', level: 1 }];
const run = (client, options = {}) => upgradeFishingOnce(client, config, { playerLevel: 9, reserveGold: 1000, enabled: () => true, ...options });

function mock({ info = ordinary, buildings = chairs, gold = 1050, after = { level: 1, enhance: 3 } } = {}) {
  const requests = [];
  return {
    requests,
    async request(name, body, response) {
      requests.push(name);
      assert.deepEqual(body, {});
      if (name === 'OnWaterRequest') return { fishingLevel: info, building: buildings };
      if (name === 'AllResourceRequest') return { list: gold == null ? [] : [{ res: 3, amount: gold }] };
      assert.equal(name, 'FishingLevelUpRequest');
      assert.equal(response, 'SCFishingLevelUpdate');
      if (after instanceof Error) throw after;
      return { levelInfo: after };
    },
  };
}

export async function testFishingUpgrade() {
  for (const [data, settings, reason] of [
    [{}, { playerLevel: 6 }, /7 级/],
    [{}, { playerLevel: undefined }, /角色等级/],
    [{}, { reserveGold: undefined }, /预留金币/],
    [{ buildings: [] }, {}, /钓鱼椅/],
    [{ info: null }, {}, /强化进度/],
    [{ info: { level: 1 } }, {}, /强化进度/],
    [{ info: { level: 2, enhance: 0 } }, {}, /最高等级/],
    [{ gold: 1049 }, {}, /保留 1000/],
    [{ gold: null }, {}, /金币余额/],
    [{ info: promote, buildings: [chairs[0], { buildingId: '2钓鱼椅', level: 0 }] }, {}, /已建成 1 把/],
  ]) {
    const client = mock(data);
    const result = await run(client, settings);
    assert.equal(result.skipped, true);
    assert.match(result.reason, reason);
    assert(!client.requests.includes('FishingLevelUpRequest'));
  }
  const stopped = mock();
  const stoppedResult = await run(stopped, { enabled: () => !stopped.requests.includes('AllResourceRequest') });
  assert(stoppedResult.skipped);
  assert(!stopped.requests.includes('FishingLevelUpRequest'));

  // A balance equal to cost plus reserve permits a single paid enhancement.
  const normal = mock();
  const upgraded = await run(normal);
  assert(upgraded.ok);
  assert.match(upgraded.label, /2 → 3\/10/);
  assert.match(upgraded.label, /50 金币/);
  assert.deepEqual(normal.requests, ['OnWaterRequest', 'AllResourceRequest', 'FishingLevelUpRequest']);

  // Once the progress bar is full, the next tier needs built chairs, not gold.
  const promotion = mock({ info: promote, gold: 0, after: { level: 2, enhance: 0 } });
  assert((await run(promotion)).ok);
  assert.deepEqual(promotion.requests, ['OnWaterRequest', 'FishingLevelUpRequest']);

  for (const after of [null, ordinary, new Error('等待强化结果超时')]) {
    const client = mock({ after });
    await assert.rejects(run(client), /未确认|超时/);
    assert.equal(client.requests.filter(name => name === 'FishingLevelUpRequest').length, 1);
  }
}
