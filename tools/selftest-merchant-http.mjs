// HTTP实况/单步入口使用隔离账号与真实协议夹具，不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-http-'));
process.env.CW_DATA_DIR = directory;
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { saveAutomationSettings } = await import('../src/automation-settings.mjs');
const { seasonalFixture } = await import('./fixtures/seasonal-suite.mjs');
const f = seasonalFixture();
saveStore({ activeId: 'merchant-http', accounts: [{ id: 'merchant-http', label: '海商王HTTP离线',
  url: 'ws://invalid.invalid', login: {}, automation: { enabled: false } }] });
f.settings.schedule.merchantTrade = true;
saveAutomationSettings('merchant-http', f.settings, { revision: 0 });
const app = createConsole({ port: 0 }), root = await app.listen();
const api = async (route, body) => {
  const response = await fetch(root + '/api/' + route + '?account=merchant-http', {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, data: await response.json() };
};
let passed = 0;
const test = async (name, work) => { await work(); console.log('通过：' + name); passed++; };
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
try {
  ok(await api('settings'));
  const session = app.sessions.get('merchant-http');
  Object.assign(session, { client: f.client, player: f.player });
  f.client.stop = () => { f.client.connected = false; };
  await test('实况和历史读取没有买卖或升级副作用，也不导出凭据', async () => {
    const result = ok(await api('merchant'));
    assert.equal(result.available, true);
    assert.equal(result.plan.kind, 'buy');
    assert.equal(f.state.writes.length, 0);
    const history = ok(await api('merchant/history'));
    assert.deepEqual(history.summary, []);
    assert.deepEqual(history.entries, []);
    assert.doesNotMatch(JSON.stringify({ result, history }), /invalid\.invalid|"login"|"token"/);
  });
  await test('单步要求确认且尊重已保存走商开关', async () => {
    assert.equal((await api('merchant/step', {})).status, 400);
    let s = ok(await api('settings')); s.settings.schedule.merchantTrade = false;
    ok(await api('settings', { settings: s.settings, revision: s.revision, baseRevision: s.baseRevision }));
    assert.equal((await api('merchant/step', { confirm: true })).status, 400);
    assert.equal(f.state.writes.length, 0);
    s = ok(await api('settings')); s.settings.schedule.merchantTrade = true;
    ok(await api('settings', { settings: s.settings, revision: s.revision, baseRevision: s.baseRevision }));
  });
  await test('重复点击串行去重，一次采购有实际回读与独立成交记录', async () => {
    const results = await Promise.all([api('merchant/step', { confirm: true }), api('merchant/step', { confirm: true })]);
    results.forEach(ok);
    assert.equal(f.state.writes.filter(row => row.name === 'TradeBuyRequest').length, 1);
    assert.equal(results[0].data.state.journal.buys, 1);
    assert(results[0].data.state.journal.buyCost > 0);
    const history = ok(await api('merchant/history'));
    assert.equal(history.summary[0].buys, 1);
    const trade = history.entries.find(row => row.type === 'trade');
    assert(trade.before && trade.after);
    assert.equal(trade.status, 'confirmed');
  });
  await test('排队期间暂停账号取消单步，历史仍能离线查看', async () => {
    session.paused = true;
    const count = f.state.writes.length;
    assert.equal((await api('merchant/step', { confirm: true })).status, 400);
    assert.equal(f.state.writes.length, count);
    assert.equal(ok(await api('merchant/history')).summary[0].buys, 1);
  });
  console.log('海商王HTTP验证通过：' + passed + ' 项');
} finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
