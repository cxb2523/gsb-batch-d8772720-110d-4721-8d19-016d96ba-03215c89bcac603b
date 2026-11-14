import assert from 'node:assert/strict';
import { challengeTrial, trialProgress, sweepTrials } from '../src/trials.mjs';

export async function testTrialSweeps() {
  const config = { materialName: id => ({ IRON: '强化石' })[id], tables: {
    TrialRaidCfg: { data: [{ raidId: 2, title: '强化石副本' }] },
    TrialRaidStageCfg: { data: [1, 2].map(stageLevel => ({
      raidId: 2, openLevel: 16, stageId: 2000 + stageLevel, stageLevel, power: 125000,
      reward: [['IRON', 2800]], sweepReward: [['IRON', 1300]],
    })) },
    TrialRaidBuySweepCfg: { data: [{ buyTimes: 1, costRuby: 0 }, { buyTimes: 2, costRuby: 50 }, { buyTimes: 3, costRuby: 0 }] },
    TrialRaidParamCfg: { data: [{ paramName: '试炼副本扫荡次数', paramValue: 3 }] },
  } };
  const raid = { raidId: 2, passedStage: 0, buySweepTimes: 0, sweepTimes: 3 };
  let echoed = true;
  const writes = [], reports = [];
  const client = {
    async request(name, { raidId }) {
      assert.equal(name, 'TrialRaidInfoRequest');
      assert.equal(raidId, 2);
      return { raid: { ...raid } };
    },
    async sendWatch(name, body) {
      assert.equal(name, 'TrialRaidBuySweepRequest');
      assert.deepEqual(body, { raidId: 2, useAdvCard: false });
      writes.push(raid.buySweepTimes + 1);
      if (echoed) raid.buySweepTimes++;
    },
  };
  const progress = async () => (await trialProgress(client, config, 16))[0];
  const run = () => sweepTrials(client, config, 16, () => true, row => reports.push(row));

  assert.equal((await progress()).freeLeft, 0);
  assert.match((await progress()).sweepHint, /首通/);
  await run();
  assert.deepEqual(writes, [], '未首通不能发扫荡或挑战请求');
  let connected = true;
  await assert.rejects(challengeTrial({
    async request(name) {
      assert.equal(name, 'TrialRaidInfoRequest', '查进度期间账号被暂停，不能再发起挑战');
      connected = false;
      return { raid };
    },
  }, config, 16, 2, 2001, () => connected), /账号状态已变化/);

  raid.passedStage = 2001;
  assert.equal((await progress()).freeLeft, 1, '忽略其他字段和总上限，也不能把付费档之后的免费档算进来');
  assert.match((await progress()).sweepRewards, /强化石 ×1300/);
  assert.match((await progress()).next.rewards, /强化石 ×2800/);
  await run();
  raid.sweepTimes = 0;
  await run();
  assert.deepEqual(writes, [1], '第一次免费用完就停，无论 sweepTimes 为几都不跨入付费或广告档');
  assert.equal((await progress()).freeLeft, 0);
  assert(reports[0].ok);

  raid.buySweepTimes = 0;
  echoed = false;
  await run();
  assert.equal(reports.at(-1).ok, false);
  assert.match(reports.at(-1).error, /未确认扫荡次数/);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await testTrialSweeps();
  console.log('trial sweeps ok: first-clear gate, immediately free tiers, separately reported sweep drops and confirmation');
}
