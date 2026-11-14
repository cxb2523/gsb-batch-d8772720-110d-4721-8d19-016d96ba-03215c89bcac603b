// 网络恢复通过真实 HTTP / runLoop 驱动；不连接游戏，也不读取真实账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-recovery-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { createUsageLedger } = await import('../src/automation-settings.mjs');

const live = new Set();
const states = new Map();
const apps = new Set();
const tasks = Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail']));
let sequence = 0, passed = 0;
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  const state = states.get(login.fixtureId);
  this.fixtureState = state;
  this.stopping = false;
  this.closeReason = null;
  state.clients.push(this);
  state.logins++;
  if (state.loginError || state.failures > 0) {
    state.failures = Math.max(0, state.failures - 1);
    this.closeReason = state.loginError?.loginResponse ? 'login-rejected' : 'network';
    throw state.loginError ?? new Error('socket error during login');
  }
  if (state.loginGate) {
    this.cancelLogin = () => state.loginGate.reject(Object.assign(new Error('client stopped'), { recoverable: false }));
    try { await state.loginGate.promise; } finally { this.cancelLogin = null; }
  }
  live.add(this);
  return { result: 0, playerInfo: { playerId: 555001, worldId: 9001, nickname: '离线恢复测试', level: 5 } };
};
GameClient.prototype.send = function (name) {
  if (name === 'LoginFinishRequest' && this.fixtureState?.closeBeforeLoginFinish > 0) {
    this.fixtureState.closeBeforeLoginFinish--;
    // 认证已成功但 WebSocket 正在 closing，close 事件尚未到达。
    live.delete(this);
    throw new Error('not connected');
  }
};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.request = async function (name) {
  const state = this.fixtureState;
  state.requests.push({ client: this, name });
  if (name === 'EmailBoxRequest') {
    await state.mailGate?.promise;
    if (state.dropOnMail > 0) { state.dropOnMail--; drop(this); }
    return { email: [] };
  }
  return {};
};
GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); this.cancelLogin?.(); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function waitFor(check, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail('等待超时：' + label);
}
function drop(client, reason = 'network') {
  client.closeReason = reason;
  live.delete(client);
  if (reason === 'kicked') client.emit('fatal', { reason: 'SCChannelExpired' });
  client.emit('close', { reason });
}
async function fixture(options = {}) {
  const id = 'recovery-' + ++sequence;
  const state = { clients: [], logins: 0, failures: 0, requests: [], ...options.state };
  states.set(id, state);
  const store = loadStore();
  store.accounts.push({ id, label: id, url: 'ws://invalid.invalid', login: { fixtureId: id },
    automation: { enabled: false, everySeconds: 1, tasks } });
  store.activeId = id;
  saveStore(store);
  const delays = [];
  const app = createConsole({ port: 0, recoveryDelayMs(attempt) { delays.push(attempt); return options.delay ?? 25; } });
  apps.add(app);
  const root = await app.listen();
  const response = async (route, body = null) => {
    const response = await fetch(root + '/api/' + route + '?account=' + id, {
      ...(body === null ? {} : { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  const api = async (route, body = null) => {
    const result = await response(route, body);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const session = () => app.sessions.get(id);
  const automation = () => loadStore().accounts.find(account => account.id === id)?.automation;
  const start = async (rounds = 0, everySeconds = 1) => api('loop/start', { rounds, everySeconds });
  const close = async () => {
    state.mailGate?.resolve();
    const job = session()?.loop.job;
    await app.close();
    await job;
    apps.delete(app);
  };
  const stop = async () => {
    const job = session()?.loop.job;
    await api('loop/stop', {});
    state.mailGate?.resolve();
    await job;
  };
  return { id, state, app, delays, api, response, session, automation, start, close, stop };
}
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
saveStore({ activeId: null, accounts: [] });

try {
  await test('心跳断线后无需网页轮询即重连并继续累计轮次，保留持久运行意图', async () => {
    const f = await fixture();
    try {
      await f.start(0, 3600);
      await waitFor(() => f.session().loop.completed === 1, '完成首轮');
      const prior = f.session().client;
      drop(prior, 'heartbeat-timeout');
      await waitFor(() => f.state.logins === 2 && f.session().loop.completed === 2, '心跳恢复并完成第二轮');
      assert.equal(f.session().loop.running, true);
      assert.equal(f.automation().enabled, true);
      assert.notEqual(f.session().client, prior);
      assert.deepEqual(f.session().loop.history.map(row => row.round), [1, 2]);
      assert.equal(f.session().loop.recovery, null);
    } finally { await f.close(); }
  });

  await test('连续网络登录失败按次数退避，成功完成一轮后恢复正常', async () => {
    const f = await fixture({ state: { failures: 2 } });
    try {
      await f.start();
      await waitFor(() => f.state.logins === 3 && f.session().loop.completed >= 1, '两次网络失败后恢复');
      assert.deepEqual(f.delays.slice(0, 2), [1, 2]);
      assert.equal(f.automation().enabled, true);
      assert.equal(f.session().loop.error, null);
    } finally { await f.close(); }
  });

  await test('认证后发登录完成时已断开且close未到，仍可识别网络错误恢复', async () => {
    const f = await fixture({ state: { closeBeforeLoginFinish: 1 } });
    try {
      await f.start(0, 3600);
      await waitFor(() => f.state.logins === 2 && f.session().loop.completed === 1, '登录完成阶段网络恢复');
      assert.equal(f.state.clients[0].closeReason, null, '夹具未提前发close事件或设置分类');
      assert.deepEqual(f.delays, [1]);
      assert.equal(f.session().loop.running, true);
      assert.equal(f.automation().enabled, true);
      assert.equal(f.session().loop.error, null);
    } finally { await f.close(); }
  });

  await test('有限轮数重连后只完成剩余轮数，不重置进度或变成持续挂机', async () => {
    const f = await fixture();
    try {
      await f.start(2, 3600);
      await waitFor(() => f.session().loop.completed === 1, '有限轮完成首轮');
      drop(f.session().client);
      await waitFor(() => !f.session().loop.running, '有限轮恢复后完成');
      assert.equal(f.state.logins, 2);
      assert.equal(f.session().loop.completed, 2);
      assert.equal(f.session().loop.rounds, 2);
      assert.deepEqual(f.session().loop.history.map(row => row.round), [1, 2]);
      assert.equal(f.automation().enabled, false);
    } finally { await f.close(); }
  });

  await test('刚连上又掉线不会重置退避次数，完成一轮后才重新计数', async () => {
    const f = await fixture({ state: { dropOnMail: 2 } });
    try {
      await f.start(0, 3600);
      await waitFor(() => f.state.logins === 3 && f.session().loop.completed === 1, '连续断线后首次完成');
      assert.deepEqual(f.delays.slice(0, 2), [1, 2]);
      drop(f.session().client, 'sequence-gap');
      await waitFor(() => f.state.logins === 4 && f.session().loop.completed === 2, '重传失败后恢复');
      assert.deepEqual(f.delays, [1, 2, 1]);
    } finally { await f.close(); }
  });

  await test('旧轮次尚未退出时不创建第二条连接，未完成轮次不计数', async () => {
    const gate = deferred();
    const f = await fixture({ state: { mailGate: gate } });
    try {
      await f.start();
      await waitFor(() => f.state.requests.some(row => row.name === 'EmailBoxRequest'), '旧轮请求挂起');
      drop(f.session().client);
      await sleep(100);
      assert.equal(f.state.logins, 1);
      assert.equal(f.session().loop.completed, 0);
      f.state.mailGate = null;
      gate.resolve();
      await waitFor(() => f.state.logins === 2 && f.session().loop.completed === 1, '旧轮退出后恢复');
      assert.deepEqual(f.session().loop.history.map(row => row.round), [1]);
    } finally { gate.resolve(); await f.close(); }
  });

  await test('旧轮退出前网页总览和手动连接不能绕过后台恢复等待', async () => {
    const gate = deferred();
    const f = await fixture({ state: { mailGate: gate }, delay: 80 });
    try {
      await f.start();
      await waitFor(() => f.state.requests.some(row => row.name === 'EmailBoxRequest'), '等待旧轮退出');
      drop(f.session().client);
      assert(f.session().loop.connectionFailure);
      assert.equal(f.session().loop.recovery, null, '旧轮还没退出，尚未开始退避');
      for (const [route, body] of [['overview', null], ['connect', {}]]) {
        const result = await f.response(route, body);
        assert.equal(result.status, 400, route);
        assert.match(result.data.error, /后台正在恢复连接/);
        assert.equal(f.state.logins, 1, route + '不能额外登录');
      }
      f.state.mailGate = null;
      gate.resolve();
      await waitFor(() => f.state.logins === 2 && f.session().loop.completed === 1, '旧轮退出后由后台恢复');
    } finally { gate.resolve(); await f.close(); }
  });

  await test('等待恢复时手动停止立即取消重连并清除持续运行开关', async () => {
    const f = await fixture({ delay: 180 });
    try {
      await f.start();
      await waitFor(() => f.session().loop.completed === 1, '停止前首轮');
      drop(f.session().client);
      await waitFor(() => f.session().loop.recovery, '进入重连等待');
      const view = await f.api('loop');
      assert(view.recovery.nextAttemptAt > 0);
      await f.stop();
      await sleep(220);
      assert.equal(f.state.logins, 1);
      assert.equal(f.session().loop.running, false);
      assert.equal(f.automation().enabled, false);
    } finally { await f.close(); }
  });

  await test('登录尚未返回时停止会取消连接，不留下登录超时等待或恢复任务', async () => {
    const f = await fixture({ state: { loginGate: deferred() } });
    try {
      await f.start();
      await waitFor(() => f.state.clients[0]?.cancelLogin, '登录等待');
      await f.stop();
      await sleep(100);
      assert.equal(f.state.logins, 1);
      assert.equal(f.session().loop.running, false);
      assert.equal(f.session().client.connected, false);
      assert.equal(f.session().connecting, null);
      assert.equal(f.automation().enabled, false);
    } finally { await f.close(); }
  });

  await test('暂停托管或主动断开可取消恢复，不自动与用户抢连接', async () => {
    for (const route of ['accounts/pause', 'disconnect']) {
      const f = await fixture({ delay: 180 });
      try {
        await f.start();
        await waitFor(() => f.session().loop.completed === 1, route + '首轮');
        drop(f.session().client);
        await waitFor(() => f.session().loop.recovery, route + '重连等待');
        const job = f.session().loop.job;
        await f.api(route, route === 'accounts/pause' ? { paused: true } : {});
        await job;
        await sleep(220);
        assert.equal(f.state.logins, 1, route);
        assert.equal(f.session().loop.running, false, route);
        if (route === 'accounts/pause') assert.equal(f.automation().paused, true);
        else assert.equal(f.automation().enabled, false);
      } finally { await f.close(); }
    }
  });

  await test('删除账号和关闭控制台会取消等待中的恢复', async () => {
    for (const action of ['remove', 'close']) {
      const f = await fixture({ delay: 180 });
      let closed = false;
      try {
        await f.start();
        await waitFor(() => f.session().loop.completed === 1, action + '首轮');
        drop(f.session().client);
        await waitFor(() => f.session().loop.recovery, action + '重连等待');
        const job = f.session().loop.job;
        if (action === 'remove') await f.api('accounts/remove', { id: f.id });
        else { await f.close(); closed = true; }
        await job;
        await sleep(220);
        assert.equal(f.state.logins, 1, action);
        if (action === 'remove') assert(!loadStore().accounts.some(account => account.id === f.id));
      } finally { if (!closed) await f.close(); }
    }
  });

  await test('被顶号与协议错误停止挂机且不自动重新登录', async () => {
    for (const reason of ['kicked', 'protocol']) {
      const f = await fixture();
      try {
        await f.start();
        await waitFor(() => f.session().loop.completed === 1, reason + '首轮');
        const job = f.session().loop.job;
        drop(f.session().client, reason);
        await job;
        await sleep(100);
        assert.equal(f.state.logins, 1, reason);
        assert.equal(f.automation().enabled, false, reason);
        assert.equal(f.session().loop.running, false, reason);
      } finally { await f.close(); }
    }
  });

  await test('服务器拒绝登录不会重试，恢复尝试被拒也会停止', async () => {
    for (const initiallyConnected of [false, true]) {
      const f = await fixture();
      try {
        if (initiallyConnected) {
          await f.start();
          await waitFor(() => f.session().loop.completed === 1, '拒绝前首轮');
        }
        f.state.loginError = Object.assign(new Error('login rejected'), { loginResponse: { result: 1 } });
        if (initiallyConnected) drop(f.session().client);
        else await f.start();
        await waitFor(() => !f.session().loop.running, '拒绝后停止');
        await sleep(100);
        assert.equal(f.state.logins, initiallyConnected ? 2 : 1);
        assert.equal(f.automation().enabled, false);
      } finally { await f.close(); }
    }
  });

  await test('重连不丢弃未知消费记录、预算及账号设置', async () => {
    const f = await fixture();
    try {
      const ledger = createUsageLedger(f.id);
      ledger.reserve({ diamonds: 3 }, {}, {}, { uniqueKey: 'unknown-before-disconnect', details: { request: 'FixtureRequest', scope: 'offline' } });
      const before = ledger.keyRecords();
      const pending = ledger.pendingCounters();
      const settings = await f.api('settings');
      await f.start();
      await waitFor(() => f.session().loop.completed === 1, '未知记录首轮');
      drop(f.session().client);
      await waitFor(() => f.state.logins === 2 && f.session().loop.completed === 2, '未知记录重连');
      assert.deepEqual(createUsageLedger(f.id).keyRecords(), before);
      assert.deepEqual(createUsageLedger(f.id).pendingCounters(), pending);
      assert.deepEqual((await f.api('settings')).settings, settings.settings);
    } finally { await f.close(); }
  });

  console.log('挂机网络恢复专项 ' + passed + '/' + passed + ' 通过');
} finally {
  for (const state of states.values()) state.mailGate?.resolve();
  for (const app of apps) { const jobs = [...app.sessions.values()].map(session => session.loop.job); await app.close(); await Promise.allSettled(jobs); }
  fs.rmSync(directory, { recursive: true, force: true });
}
