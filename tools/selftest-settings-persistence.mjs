// 完整 HTTP 保存、服务重建和跨进程回读；只使用临时目录及离线客户端。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-persistence-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { settingsFromNative, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const tasks = Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail']));
const connected = new Set();
Object.defineProperty(GameClient.prototype, 'connected', { get() { return connected.has(this); } });
GameClient.prototype.connect = async function () {
  connected.add(this);
  return { playerInfo: { playerId: 1516001, worldId: 9001, level: 5 } };
};
GameClient.prototype.send = () => {};
GameClient.prototype.request = async name => name === 'EmailBoxRequest' ? { email: [] } : {};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.stop = function () { this.stopping = true; connected.delete(this); };

saveStore({ activeId: 'detailed', accounts: ['detailed', 'legacy', 'other'].map(id => ({
  id, url: 'ws://invalid.invalid', login: {}, automation: { enabled: false, tasks, everySeconds: 60 },
})) });
saveAutomationSettings('detailed', settingsFromNative(tasks), { revision: 0 });
saveAutomationSettings('other', settingsFromNative(tasks), { revision: 0 });
const otherBefore = loadAutomationSettings('other');
let app, root, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function open() { app = createConsole({ port: 0 }); root = await app.listen(); }
async function close() {
  const jobs = [...app.sessions.values()].map(session => session.loop.job).filter(Boolean);
  app.server.closeAllConnections();
  await app.close();
  await Promise.allSettled(jobs);
}
async function api(route, body, account = 'detailed') {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body ? { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function finished(account) {
  const deadline = Date.now() + 5000;
  while (app.sessions.get(account)?.loop.running && Date.now() < deadline) await sleep(10);
  assert.equal(app.sessions.get(account)?.loop.running, false);
}
await open();
try {
  await test('挂机页启动参数同步详细配置，其他参数与其他账号保持不变', async () => {
    const before = loadAutomationSettings('detailed');
    await api('loop/start', { rounds: 1, everySeconds: 17 });
    await finished('detailed');
    const after = loadAutomationSettings('detailed');
    const expected = structuredClone(before.settings);
    expected.loop.rounds = 1; expected.loop.everySeconds = 17;
    assert.deepEqual(after.settings, expected);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(loadAutomationSettings('other'), otherBefore);
    const view = await api('settings');
    assert.equal(view.settings.loop.everySeconds, 17);
  });
  await test('真实子进程从磁盘读回启动参数与版本', () => {
    const module = new URL('../src/automation-settings.mjs', import.meta.url).href;
    const source = `import { loadAutomationSettings } from ${JSON.stringify(module)}; console.log(JSON.stringify(loadAutomationSettings('detailed')));`;
    const read = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
    assert.deepEqual(read, loadAutomationSettings('detailed'));
  });
  await test('未保存详细配置的旧账号也记住轮数与间隔', async () => {
    const before = await api('settings', null, 'legacy');
    await api('loop/start', { rounds: 1, everySeconds: 23 }, 'legacy');
    await finished('legacy');
    const view = await api('settings', null, 'legacy');
    assert.equal(view.revision, 0, '不因启动强制迁移旧任务执行路径');
    assert.equal(view.settings.loop.rounds, 1);
    assert.equal(view.settings.loop.everySeconds, 23);
    assert.notEqual(view.baseRevision, before.baseRevision);
  });
  await test('重建服务保留两种账号参数，有限轮数不会自动续跑', async () => {
    await close(); await open();
    for (const [id, seconds] of [['detailed', 17], ['legacy', 23]]) {
      const view = await api('loop', null, id);
      assert.equal(view.rounds, 1);
      assert.equal(view.everyMs, seconds * 1000);
      assert.equal(view.running, false);
      assert.equal(app.sessions.get(id).client, null);
    }
  });
  await test('启动未传参数时沿用保存值，重复启动不制造新配置版本', async () => {
    const before = loadAutomationSettings('detailed');
    const view = await api('loop/start', {});
    assert.equal(view.rounds, 1); assert.equal(view.everyMs, 17000);
    await finished('detailed');
    assert.deepEqual(loadAutomationSettings('detailed'), before);
  });
  await test('持续挂机重启按最新间隔恢复，停止状态仍单独持久化', async () => {
    await api('loop/start', { rounds: 0, everySeconds: 19 });
    await close();
    assert.equal(loadStore().accounts.find(a => a.id === 'detailed').automation.enabled, true);
    await open();
    const view = await api('loop');
    assert.equal(view.running, true); assert.equal(view.rounds, 0); assert.equal(view.everyMs, 19000);
    await api('loop/stop', {}); await finished('detailed');
    assert.equal(loadStore().accounts.find(a => a.id === 'detailed').automation.enabled, false);
  });
} finally { await close(); }
console.log('配置持久化专项 ' + passed + '/' + passed + ' 通过');
