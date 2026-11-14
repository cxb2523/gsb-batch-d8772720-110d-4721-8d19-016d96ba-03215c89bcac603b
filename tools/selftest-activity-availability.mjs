import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { activityAvailability, activityRetirements, isActivityTaskAvailable } from '../src/activity-availability.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-availability-'));
const previousDataDir = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = folder;
const { runLoop } = await import('../src/loop.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { createUsageLedger, defaultSettings, exportAutomationSettings, importAutomationSettings } = await import('../src/automation-settings.mjs');
const originalNow = Date.now;
const cutoff = Date.parse('2026-11-12T00:00:00+08:00');
let now = cutoff + 12 * 3600000;
Date.now = () => now;
const retiredKeys = Object.keys(activityRetirements[0].tasks);
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
const seconds = () => now / 1000;
const festival = (types, extra = {}) => ({
  type: '捞尸人联动活动', activityId: '10001', startTime: seconds() - 3600, endTime: seconds() + 3600,
  subActivity: types.map(subActivityType => ({ subActivityType })), ...extra,
});
const available = (key, rows) => isActivityTaskAvailable(key, { festivals: rows });
const toLong = number => ({ low: Number(BigInt.asIntN(32, BigInt(number))), high: Number(BigInt(number) >> 32n), unsigned: false });

try {
  await test('仅集中下线已确认结束的 16 项联动任务，完整保留注册表', () => {
    assert.equal(retiredKeys.length, 16);
    for (const key of retiredKeys) assert(automationTasks.some(task => task.key === key), key);
    const view = activityAvailability();
    assert.deepEqual(new Set(view.hiddenTasks), new Set(retiredKeys));
    assert.equal(view.hiddenFields.length, 18);
    assert(view.hiddenFields.includes('eventActions.compassThreshold'));
    assert(view.hiddenFields.includes('eventActions.compassDrawCount'));
    for (const key of ['beautyVotes', 'beautyGift', 'newbieLogin', 'pirateRankRewards', 'warRankRewards', 'merchantTrade', 'armsRaceRewards', 'weekPass']) {
      assert(isActivityTaskAvailable(key), key);
      assert(!view.hiddenFields.includes('schedule.' + key), key);
    }
  });

  await test('北京时间结束日午夜边界生效，公告期限以前不隐藏', () => {
    const savedNow = now;
    now = cutoff - 1;
    assert.deepEqual(activityAvailability(), { hiddenTasks: [], hiddenFields: [] });
    now = cutoff;
    assert.equal(activityAvailability().hiddenTasks.length, 16);
    now = savedNow;
  });

  await test('结束后仅恢复当前开放的对应子活动，罗盘参数跟随抽取入口', () => {
    const client = { festivals: [festival([28])] };
    const view = activityAvailability(client);
    for (const key of ['compassSpin', 'compassReward']) assert(!view.hiddenTasks.includes(key));
    for (const key of ['compassDaily', 'compassAdGift', 'riverScore', 'edictPass', 'festivalSign']) assert(view.hiddenTasks.includes(key));
    assert(!view.hiddenFields.some(key => key.startsWith('eventActions.')));
    client.festivals[0].subActivity.push({ subActivityType: 10 });
    assert(isActivityTaskAvailable('compassDaily', client));
    assert(isActivityTaskAvailable('compassAdGift', client));
  });

  await test('未来期次尚未开始、父活动结束或子活动到期均不能复开', () => {
    for (const row of [
      festival([28], { startTime: seconds() + 1 }),
      festival([28], { endTime: seconds() }),
      festival([28], { subActivity: [{ subActivityType: 28, openTime: seconds() + 1 }] }),
      festival([28], { subActivity: [{ subActivityType: 28, closeTime: seconds() }] }),
      festival([28], { startTime: 0 }),
      festival([28], { subActivity: [{ subActivityType: 28, openTime: 'invalid' }] }),
      festival([28], { subActivity: [{ subActivityType: 28, closeTime: Number.MAX_SAFE_INTEGER + 1 }] }),
    ]) assert(!available('compassSpin', [row]));
  });

  await test('父子窗口必须相交，礼包与罗盘不能跨期拼接恢复', () => {
    assert(!available('compassDaily', [festival([28]), festival([10], { activityId: '10002' })]));
    assert(!available('compassSpin', [festival([28], { endTime: seconds(), subActivity: [{ subActivityType: 28, closeTime: seconds() + 100 }] })]));
    assert(!available('compassSpin', [festival([28], { subActivity: [{ subActivityType: 28, openTime: seconds() + 100, closeTime: seconds() - 100 }] })]));
    assert(available('compassSpin', [festival([28], { subActivity: [{ subActivityType: 28, openTime: seconds() - 7200, closeTime: seconds() + 7200 }] })]));
  });

  await test('下一期全量开放可恢复全部字段，历史过期条目不干扰', () => {
    const client = { festivals: [festival([27, 28], { endTime: seconds() - 1 }), festival([6, 10, 11, 27, 28, 29, 30], { activityId: '10002' })] };
    assert.deepEqual(activityAvailability(client), { hiddenTasks: [], hiddenFields: [] });
    client.festivals = [];
    assert.equal(activityAvailability(client).hiddenTasks.length, 16);
  });

  await test('通用领奖子类型不能把普通节日误恢复为酆都联动', () => {
    const row = festival([6, 10, 11], { type: '未来节日' });
    for (const key of ['festivalSign', 'festivalActive', 'festivalActiveRewards', 'festivalFreeGift', 'festivalGifts']) assert(!available(key, [row]), key);
    assert(!available('snowballFree', [row]));
    assert(!available('compassSpin', [row]));
    row.subActivity.push({ subActivityType: 27 });
    assert(available('riverScore', [row]));
    assert(available('snowballFree', [row]));
    assert(!available('festivalSign', [row]));
  });

  await test('同一期专用子活动确认联动身份，仅恢复已有实现支持的领奖', () => {
    for (const type of [28, 29, 30]) {
      const row = festival([6, 10, 11, type], { type: '后续联动名称' });
      for (const key of ['festivalSign', 'festivalActive', 'festivalActiveRewards', 'festivalFreeGift', 'festivalGifts']) assert(available(key, [row]), key);
    }
    const selectOnly = festival([10, 28], { type: '后续联动名称' });
    assert(available('compassDaily', [selectOnly]));
    assert(available('compassAdGift', [selectOnly]));
    assert(!available('festivalGifts', [selectOnly]), '旧自选礼包只有明确命名的已核验配置表');
    assert(available('festivalGifts', [festival([10])]));
    assert(!available('festivalSign', [festival([11], { type: '普通节日' }), festival([28])]));
  });

  await test('协议 int64 和缺省子活动时间可判定，非法结构不能复开', () => {
    const row = festival([28]);
    row.startTime = toLong(row.startTime);
    row.endTime = String(row.endTime);
    row.subActivity[0] = { subActivityType: toLong(28), openTime: toLong(0), closeTime: toLong(0) };
    assert(available('compassSpin', [row]));
    assert(!isActivityTaskAvailable('compassSpin', { festivals: {} }));
    assert(!available('compassSpin', [null, festival([], { subActivity: null })]));
    assert(!available('compassSpin', [festival([], { subActivity: [null, 28] })]));
  });

  await test('判定使用服务器时钟偏移，不能被电脑时钟误判', () => {
    assert(isActivityTaskAvailable('compassSpin', { serverClockOffsetMs: cutoff - 1 - now }));
    const row = festival([28]);
    assert(!isActivityTaskAvailable('compassSpin', { festivals: [row], serverClockOffsetMs: 3600000 }));
    assert(isActivityTaskAvailable('compassSpin', { festivals: [row], serverClockOffsetMs: Number.NaN }));
  });

  await test('隐藏与复开不改历史开关及参数，导入导出完整保留', () => {
    const settings = defaultSettings();
    for (const [index, key] of retiredKeys.entries()) settings.schedule[key] = index % 2 === 0;
    settings.eventActions.compassThreshold = 37;
    settings.eventActions.compassDrawCount = 50;
    const before = structuredClone(settings);
    activityAvailability();
    activityAvailability({ festivals: [festival([6, 10, 11, 27, 28, 29, 30])] });
    assert.deepEqual(settings, before);
    const restored = importAutomationSettings(exportAutomationSettings(settings));
    for (const key of retiredKeys) assert.equal(restored.schedule[key], before.schedule[key]);
    assert.deepEqual(restored.eventActions, before.eventActions);
  });

  const loopFixture = (rows = []) => {
    const client = new EventEmitter(), calls = [], steps = [];
    Object.assign(client, { connected: true, festivals: rows, serverClockOffsetMs: 0 });
    client.request = async name => { calls.push(name); throw Error('不应读取协议：' + name); };
    const settings = defaultSettings();
    Object.assign(settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
    const ledger = createUsageLedger('offline-' + passed, { file: path.join(folder, 'ledger-' + passed + '.json') });
    const run = keys => runLoop(client, {}, { config: { tables: {} }, player: { level: 37, worldId: '2002001001' },
      getSettings: () => settings, usageLedger: ledger, rounds: 1, allowMutate: true,
      isEnabled: key => keys.includes(key), onStep: entry => steps.push(entry), sleep: async () => {} });
    return { client, settings, calls, steps, run };
  };

  await test('旧配置与兼容别名仍为开启时，已下线活动不调度也不发协议', async () => {
    const f = loopFixture();
    for (const key of retiredKeys) f.settings.schedule[key] = true;
    const before = structuredClone(f.settings);
    await f.run(retiredKeys);
    assert.deepEqual(f.calls, []);
    assert(!f.steps.some(entry => retiredKeys.includes(entry.taskKey)));
    assert.deepEqual(f.settings, before);
  });

  await test('复开后原签到只领取联动期次，不向同期开着的普通节日发请求', async () => {
    const row = festival([11, 28], { type: '后续联动名称', activityId: '10002' });
    row.subActivity[0].dailyActive = { checkInId: [] };
    const other = festival([11], { type: '普通节日' });
    other.subActivity[0].dailyActive = { checkInId: [] };
    const f = loopFixture([other, row]);
    f.settings.schedule.festivalSign = true;
    f.client.request = async (name, body) => {
      f.calls.push(name);
      assert.equal(name, 'ClaimActivityDailyCheckInRewardRequest');
      assert.equal(body.checkId, 1);
      assert.deepEqual(body.activityId, toLong(10002));
      return { checkId: [1], reward: { asset: [{ id: '木材', num: 1 }] } };
    };
    const options = { config: { tables: { LinkageLSRSignCfg: { data: [{ rewardId: 1, signDay: 1 }] } } },
      player: { level: 37, worldId: '2002001001' }, getSettings: () => f.settings,
      usageLedger: createUsageLedger('resumed', { file: path.join(folder, 'resumed.json') }),
      rounds: 1, allowMutate: true, isEnabled: key => key === 'festivalSign', sleep: async () => {} };
    await runLoop(f.client, {}, options);
    await runLoop(f.client, {}, options);
    assert.deepEqual(f.calls, ['ClaimActivityDailyCheckInRewardRequest']);
    assert.deepEqual(row.subActivity[0].dailyActive.checkInId, [1]);
    assert.deepEqual(other.subActivity[0].dailyActive.checkInId, []);
  });

  console.log('活动下线与复开专项 ' + passed + '/' + passed + ' 通过');
} finally {
  Date.now = originalNow;
  if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDir;
  fs.rmSync(folder, { recursive: true, force: true });
}
