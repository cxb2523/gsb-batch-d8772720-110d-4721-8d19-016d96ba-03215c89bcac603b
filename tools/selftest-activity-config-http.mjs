// 配置下线仅改变可见性和有效执行，不删除历史偏好；所有账号和连接均为离线夹具。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-config-'));
const originalNow = Date.now;
const originalData = process.env.CW_DATA_DIR;
const originalPack = process.env.CW_CONFIG_PACK;
Date.now = () => Date.parse('2026-11-12T12:00:00+08:00');
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { activityAvailability } = await import('../src/activity-availability.mjs');
const retiredKeys = activityAvailability().hiddenTasks;
const keepKeys = ['beautyVotes', 'beautyGift', 'merchantTrade', 'armsRaceRewards', 'newbieLogin', 'pirateRankRewards', 'warRankRewards', 'weekPass'];
saveStore({ activeId: 'event-a', accounts: ['event-a', 'event-b'].map(id => ({
  id, label: id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false },
})) });
const app = createConsole({ port: 0 });
const root = await app.listen();
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function api(route, body = null, account = 'event-a') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === null ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
const selected = settings => ({
  schedule: Object.fromEntries(retiredKeys.map(key => [key, settings.schedule[key]])),
  eventActions: settings.eventActions,
});

try {
  await test('无游戏连接时下线16项联动配置，保留其他活动且没有登录副作用', async () => {
    assert.equal(retiredKeys.length, 16);
    const settings = ok(await api('settings'));
    const loop = ok(await api('loop'));
    for (const key of retiredKeys) {
      assert(!settings.tasks.some(task => task.key === key), key);
      assert(settings.rules.hiddenFields.includes('schedule.' + key), key);
      assert(!loop.tasks.some(task => task.key === key), key);
      assert(!loop.controls.some(control => control.key === 'schedule.' + key), key);
      assert.equal(typeof settings.settings.schedule[key], 'boolean');
    }
    for (const key of keepKeys) assert(settings.tasks.some(task => task.key === key), key);
    for (const field of ['eventActions.compassThreshold', 'eventActions.compassDrawCount']) {
      assert(settings.rules.hiddenFields.includes(field));
    }
    assert.equal(app.sessions.get('event-a').client, null);
  });

  await test('保存其他配置不清零历史开关和罗盘参数，账号互相隔离', async () => {
    let before = ok(await api('settings'));
    const other = ok(await api('settings', null, 'event-b'));
    const settings = structuredClone(before.settings);
    retiredKeys.forEach((key, index) => { settings.schedule[key] = index % 2 === 0; });
    settings.eventActions.compassThreshold = 23;
    settings.eventActions.compassDrawCount = 5;
    const history = selected(settings);
    before = ok(await api('settings', { settings, revision: before.revision, baseRevision: before.baseRevision }));
    assert.deepEqual(selected(before.settings), history);
    before.settings.resources.keepAccelerators = 42;
    const saved = ok(await api('settings', { settings: before.settings, revision: before.revision, baseRevision: before.baseRevision }));
    assert.deepEqual(selected(saved.settings), history);
    assert.equal(saved.settings.resources.keepAccelerators, 42);
    assert.deepEqual(ok(await api('settings', null, 'event-b')).settings, other.settings);
  });

  await test('导入导出保留全部隐藏偏好与参数', async () => {
    const before = ok(await api('settings'));
    const document = ok(await api('settings/export'));
    assert.deepEqual(selected(document.settings), selected(before.settings));
    const validated = ok(await api('settings/validate', { document }));
    assert.deepEqual(selected(validated.settings), selected(before.settings));
  });

  await test('旧页面不能重新启用下线任务，仍能主动关闭旧开关', async () => {
    const before = ok(await api('settings'));
    for (const [route, key] of [['loop/task', 'riverScore'], ['loop/control', 'schedule.compassSpin']]) {
      const blocked = await api(route, { confirm: true, key, enabled: true, revision: before.revision });
      assert.equal(blocked.status, 400);
      assert.match(blocked.data.error, /活动已下线/);
    }
    assert.deepEqual(ok(await api('settings')).settings, before.settings);
    ok(await api('loop/task', { confirm: true, key: 'riverScore', enabled: false }));
    const current = ok(await api('settings'));
    ok(await api('loop/control', { confirm: true, key: 'schedule.compassSpin', enabled: false, revision: current.revision }));
    const after = ok(await api('settings'));
    assert.equal(after.settings.schedule.riverScore, false);
    assert.equal(after.settings.schedule.compassSpin, false);
  });

  await test('运行安排不再把历史已开下线任务列为当前启用', async () => {
    const { settings } = ok(await api('settings'));
    const preview = ok(await api('settings/preview', { settings, category: 'runtime' }));
    assert(!preview.notes.some(note => /走江|酆都|罗盘|驱邪|联动活动/.test(note)));
  });

  await test('复开只恢复当前开放子活动，不修改配置版本或其他账号', async () => {
    const before = ok(await api('settings'));
    const now = Math.floor(Date.now() / 1000);
    const client = new EventEmitter();
    Object.assign(client, { connected: false, serverClockOffsetMs: 0, stop() {},
      festivals: [{ activityId: 99001, type: '捞尸人联动活动', startTime: now - 60, endTime: now + 3600,
        subActivity: [{ subActivityType: 28, openTime: now - 60, closeTime: now + 600 }] }],
    });
    app.sessions.get('event-a').client = client;
    const reopened = ok(await api('settings'));
    assert.equal(reopened.revision, before.revision);
    assert.deepEqual(reopened.settings, before.settings);
    assert(reopened.tasks.some(task => task.key === 'compassSpin'));
    assert(!reopened.tasks.some(task => task.key === 'riverScore'));
    assert(!reopened.rules.hiddenFields.includes('eventActions.compassThreshold'));
    const loop = ok(await api('loop'));
    assert(loop.controls.some(control => control.key === 'schedule.compassSpin'));
    ok(await api('loop/control', { confirm: true, key: 'schedule.compassSpin', enabled: true, revision: reopened.revision }));
    assert(!ok(await api('settings', null, 'event-b')).tasks.some(task => task.key === 'compassSpin'));
    client.festivals[0].subActivity[0].closeTime = now;
    assert(!ok(await api('settings')).tasks.some(task => task.key === 'compassSpin'));
    assert.equal(ok(await api('settings')).settings.schedule.compassSpin, true);
  });
  console.log('活动下线HTTP专项 ' + passed + '/' + passed + ' 通过');
} finally {
  await app.close();
  Date.now = originalNow;
  if (originalData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalData;
  if (originalPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = originalPack;
  fs.rmSync(directory, { recursive: true, force: true });
}
