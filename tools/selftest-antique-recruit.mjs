import assert from 'node:assert/strict';
import { serviceAntiqueRecruit } from '../src/antique-recruit.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';

const draw = 'freeAntiqueRecruit';
const claim = 'antiqueRecruitRewards';
const config = {
  tables: {
    ModuleOpenCfg: { data: [{ moduleId: '藏品', playerLevel: 10 }] },
    AntiqueBaseCfg: { data: [{ antiqueId: '藏品蓝1', showName: '黑白掌机' }] },
    AntiqueRecruitTaskCfg: { data: [
      { season: 1, id: 1, times: 50 }, { season: 1, id: 2, times: 100 },
      { season: 2, id: 1, times: 200 }, { season: 2, id: 2, times: 400 },
    ] },
  },
  materialName: id => id === 'RUBY' ? '钻石' : '未知材料',
};
const player = { level: 15, worldId: 1000001 };
const later = Math.floor(Date.now() / 1000) + 3600;
function mock(options = {}) {
  const client = {
    writes: [], reads: [],
    station: { buildingId: '1广播站', level: 1 },
    antique: { freeEndTimeSeconds: 0, recruitTimes: 49, task: { gotId: 0, times: 49 } },
    async request(name, body, response) {
      if (name === 'OnWaterRequest') { this.reads.push(name); return { building: this.station ? [this.station] : [] }; }
      if (name === 'RecruitInfoRequest') { this.reads.push(name); return { antique: structuredClone(this.antique) }; }
      this.writes.push(name);
      if (name === 'AntiqueRecruitRequest') {
        assert.deepEqual(body, { type: 1, way: 1 });
        assert.equal(response, 'AntiqueRecruitResponse');
        if (this.drawTimeout) throw new Error('等待招募结果超时');
        this.antique.task.times++;
        this.antique.recruitTimes++;
        this.antique.freeEndTimeSeconds = later;
        return { recruitData: structuredClone(this.antique), reward: [{ antiqueId: '藏品蓝1' }] };
      }
      assert.equal(name, 'GotAntiqueRecruitTaskRequest');
      assert.equal(response, 'GotRecruitTaskResponse');
      assert.deepEqual(body, {});
      const id = this.antique.task.gotId + 1;
      if (!this.ignoreClaim) this.antique.task.gotId = id;
      return { gotId: id, reward: { asset: [{ id: 'RUBY', num: 5 }] } };
    },
  };
  return Object.assign(client, options);
}

async function run(client, { role = player, flags = [draw, claim], enabled = key => flags.includes(key), scheduler } = {}) {
  const entries = [];
  await serviceAntiqueRecruit(client, config, { player: role, enabled, scheduler, report: e => entries.push(e) });
  return entries;
}

export async function testAntiqueRecruit() {
  for (const [client, role] of [
    [mock(), { level: 9, worldId: 1000001 }],
    [mock({ station: null }), player],
    [mock({ station: { buildingId: '1广播站', level: 0, buildFinishTime: later } }), player],
    [mock({ antique: null }), player],
  ]) {
    const entries = await run(client, { role });
    assert.equal(entries.length, 2);
    assert(entries.every(e => e.skipped && e.reason));
    assert.deepEqual(client.writes, []);
  }
  const same = mock();
  const successes = await run(same);
  assert.deepEqual(same.writes, ['AntiqueRecruitRequest', 'GotAntiqueRecruitTaskRequest']);
  assert.match(successes.find(e => e.key === draw && e.ok).label, /黑白掌机/);
  assert.match(successes.find(e => e.key === claim && e.ok).label, /第 1 档.*钻石 ×5/);
  same.writes = [];
  const cooldown = await run(same);
  assert.deepEqual(same.writes, []);
  assert(cooldown.find(e => e.key === draw && e.skipped).reason.includes('下次免费'));
  assert(cooldown.find(e => e.key === claim && e.skipped).reason.includes('50/100'));
  assert.deepEqual(await run(same), cooldown, '未变化的等待日志可去重');

  const lateSeason = mock({ antique: { freeEndTimeSeconds: later, task: { gotId: 0, times: 50 } } });
  await run(lateSeason, { role: { level: 15, worldId: 3000001 }, flags: [claim] });
  assert.deepEqual(lateSeason.writes, [], '第3赛季按最近配置第2赛季处理，不套用第1赛季门槛');
  for (const invalid of [null, { times: 100 }, { times: 100, gotId: 99 }]) {
    const client = mock({ antique: { freeEndTimeSeconds: later, task: invalid } });
    assert((await run(client, { flags: [claim] }))[0].skipped);
    assert.deepEqual(client.writes, []);
  }
  const many = mock({ antique: { task: { times: 100, gotId: 0 } } });
  const awards = await run(many, { flags: [claim] });
  assert.deepEqual(many.writes, ['GotAntiqueRecruitTaskRequest', 'GotAntiqueRecruitTaskRequest']);
  assert.deepEqual(awards.map(e => e.ok), [true, true]);
  assert.equal(many.antique.task.gotId, 2);

  const noProgress = mock({ ignoreClaim: true, antique: { task: { times: 100, gotId: 0 } } });
  assert((await run(noProgress, { flags: [claim] })).some(e => !e.ok && e.error?.includes('未确认')));
  assert.deepEqual(noProgress.writes, ['GotAntiqueRecruitTaskRequest']);
  const timeout = mock({ drawTimeout: true });
  assert((await run(timeout)).some(e => e.key === draw && !e.ok && e.error?.includes('超时')));
  assert.deepEqual(timeout.writes, ['AntiqueRecruitRequest']);
  const stopped = mock();
  await run(stopped, { enabled: () => !stopped.reads.includes('RecruitInfoRequest') });
  assert.deepEqual(stopped.writes, [], '读取状态后停用开关，不再写入');

  let seconds = Math.floor(Date.now() / 1000);
  const timed = mock();
  Object.defineProperty(timed, 'serverClockOffsetMs', { get: () => seconds * 1000 + 500 - Date.now() });
  timed.antique.freeEndTimeSeconds = seconds + 10;
  const scheduler = rewardSchedule(timed);
  const round = () => run(timed, { scheduler, enabled: key => scheduler.due(key) });
  await round();
  assert(!scheduler.due(draw) && !scheduler.due(claim));
  timed.reads = [];
  seconds += 9;
  await round();
  assert.deepEqual(timed.reads, [], '免费冷却中且累计档位未到复核时间，不重复读取建筑、招募');
  seconds++;
  assert(scheduler.due(draw) && !scheduler.due(claim));
  const dueNow = await round();
  assert.deepEqual(dueNow.filter(r => r.ok).map(r => r.key), [draw, claim], '免费抽取达标，当轮立即领取，不受累计奖励短复核影响');
  assert(!scheduler.due(draw), '刚成功的免费抽取也按回包冷却延迟');
  timed.writes = [];
  timed.antique.task.times = 100;
  seconds += 180;
  await round();
  assert.deepEqual(timed.writes, ['GotAntiqueRecruitTaskRequest'], '累计次数短复核不必等待免费招募冷却');
  seconds = later - 1;
  assert(!scheduler.due(draw));
  seconds++;
  assert(scheduler.due(draw), '到达服务端给的时间才重新查询免费招募');
  const lost = mock({ drawTimeout: true });
  const uncertain = rewardSchedule(lost);
  await run(lost, { scheduler: uncertain, flags: [draw] });
  assert(uncertain.due(draw), '失去招募回包不封锁后续核对');
  const noAck = mock({ ignoreClaim: true, antique: { task: { times: 50, gotId: 0 } } });
  const uncertainReward = rewardSchedule(noAck);
  await run(noAck, { scheduler: uncertainReward, flags: [claim] });
  assert(uncertainReward.due(claim), '无法确认领取状态时不延后复核');
}
