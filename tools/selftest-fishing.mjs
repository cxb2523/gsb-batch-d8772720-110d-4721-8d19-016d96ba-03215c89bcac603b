import assert from 'node:assert/strict';
import { fishOnce } from '../src/fishing.mjs';

const config = {
  tables: {
    BuildingCfg: { data: [{ buildingType: '钓鱼椅' }] },
    FishParamCfg: { data: [{ paramName: '自动钓鱼', paramValue: 2 }] },
    FishBaseCfg: { data: [{ fishId: 2, name: '印尼虎鱼' }] },
  },
  materialName: id => ({ 鱼: '鱼', RUBY: '钻石' })[id],
};
const asset = (id, num) => ({ asset: [{ type: id === 'RUBY' ? 1 : 0, id, num }] });

function fishingClient(options = {}) {
  const calls = [];
  const replies = {
    OnWaterRequest: { fishingLevel: { level: 2 }, building: [{ buildingId: '1钓鱼椅', level: 1 }] },
    GameEffectRequest: { effects: [{ id: 16, value: 100 }] },
    AllItemRequest: { items: [{ itemId: '鱼', num: 93 }] },
    StartFishingRequest: { fishId: 0, reward: asset('鱼', 7) },
    GainBigFishRequest: { isNew: true, extReward: asset('RUBY', 11) },
    ...options,
  };
  return {
    calls,
    async request(name, body, response) {
      calls.push(name);
      if (name === 'GainBigFishRequest') assert.equal(response, 'GainBigResponse');
      if (name === 'StartFishingRequest') assert.equal(response, 'StartFishingResponse');
      assert.deepEqual(body, {});
      if (!(name in replies)) assert.fail('意外的钓鱼请求：' + name);
      if (replies[name] instanceof Error) throw replies[name];
      return replies[name];
    },
  };
}
const mutations = client => client.calls.filter(name => ['StartFishingRequest', 'GainBigFishRequest'].includes(name));

export async function testFishing() {
  for (const options of [
    { OnWaterRequest: { fishingLevel: { level: 2 }, building: [{ buildingId: '1钓鱼椅', level: 0 }] } },
    { OnWaterRequest: { fishingLevel: { level: 1 }, building: [{ buildingId: '1钓鱼椅', level: 1 }] } },
    { AllItemRequest: { items: [{ itemId: '鱼', num: 100 }] } },
    { GameEffectRequest: { effects: [{ id: 15, value: 100 }] } },
  ]) {
    const client = fishingClient(options);
    const skip = await fishOnce(client, config, () => true);
    assert.equal(skip.skipped, true);
    assert.ok(skip.reason);
    assert.deepEqual(mutations(client), []);
  }
  const stopped = fishingClient();
  await fishOnce(stopped, config, () => !stopped.calls.includes('AllItemRequest'));
  assert.deepEqual(mutations(stopped), [], '读取仓库后关闭开关不再抛竿');

  const normal = fishingClient();
  const catchOne = await fishOnce(normal, config, () => true);
  assert.equal(catchOne.ok, true);
  assert.match(catchOne.label, /鱼\s*[×x]\s*7/);
  assert.deepEqual(mutations(normal), ['StartFishingRequest']);

  const bigStart = { fishId: 2, reward: asset('鱼', 7) };
  const stopAfterCast = fishingClient({ StartFishingRequest: bigStart });
  const cancelled = await fishOnce(stopAfterCast, config, () => !stopAfterCast.calls.includes('StartFishingRequest'));
  assert.equal(cancelled.skipped, true);
  assert.deepEqual(mutations(stopAfterCast), ['StartFishingRequest'], '抛竿后暂停不再结算大鱼');
  const big = fishingClient({ StartFishingRequest: bigStart });
  const catchBig = await fishOnce(big, config, () => true);
  assert.equal(catchBig.ok, true);
  assert.match(catchBig.label, /印尼虎鱼/);
  assert.match(catchBig.label, /新/);
  assert.match(catchBig.label, /鱼\s*[×x]\s*7/);
  assert.match(catchBig.label, /钻石\s*[×x]\s*11/);
  assert.deepEqual(mutations(big), ['StartFishingRequest', 'GainBigFishRequest']);

  const lostCast = fishingClient({ StartFishingRequest: new Error('timeout waiting for StartFishingResponse (sent StartFishingRequest)') });
  await assert.rejects(fishOnce(lostCast, config, () => true), /timeout|超时|未确认/);
  assert.deepEqual(mutations(lostCast), ['StartFishingRequest']);
  const timeout = new Error('timeout waiting for GainBigResponse (sent GainBigFishRequest)');
  const lost = fishingClient({ StartFishingRequest: bigStart, GainBigFishRequest: timeout });
  await assert.rejects(fishOnce(lost, config, () => true), /timeout|超时|未确认/);
  assert.deepEqual(mutations(lost), ['StartFishingRequest', 'GainBigFishRequest'], '未确认结算时不重复下竿或领鱼');
}
