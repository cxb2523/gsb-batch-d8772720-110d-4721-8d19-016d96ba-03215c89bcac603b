import os from 'node:os';
// 使用隔离目录和虚构账号验证，不登录真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commentsFixture } from './fixtures/console-comments.mjs';
import { dailySingleState, addDailyOptions, runDailySingle } from '../src/daily-single.mjs';
import { surveyDailies } from '../src/dailies.mjs';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import { readGuild, claimMyGuildAid } from '../src/guild.mjs';

const parent = path.join(os.tmpdir(),'cw-comments-test-runs');
fs.mkdirSync(parent, { recursive: true });
process.env.CW_DATA_DIR = fs.mkdtempSync(path.join(parent, 'run-'));
const config = { tables: { ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 16 }] } }, materialName: id => id };
const results = [];
async function check(name, action) {
  try { await action(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
}
let counter = 0;
function setup() {
  const fixture = commentsFixture(), state = dailySingleState(), settings = defaultSettings();
  const ledger = createUsageLedger('fixture-' + ++counter);
  const guard = createActionGuard(fixture.client, () => settings, ledger);
  const view = async () => addDailyOptions(await surveyDailies(fixture.client, fixture.protocol, { config, player: fixture.player, settings }), state);
  const run = (token, extra) => runDailySingle(fixture.client, fixture.protocol, { config, player: fixture.player, settings, state, token, guard, wait: async () => {}, ...extra });
  return { ...fixture, dailyState: state, settings, ledger, view, run };
}
const option = (view, id) => view.tasks.find(row => row.task.id === id).manual;

await check('单项完成只执行所选任务并领取该项奖励', async () => {
  const f = setup(), view = await f.view();
  const result = await f.run(option(view, 1004).token);
  assert(result.ok && result.claimed);
  assert.deepEqual(f.state.writes.map(row => [row.name, row.body]), [['DrawAfkRewardRequest', {}], ['DrawDailyTaskRewardRequest', { id: 1004 }]]);
  assert.equal(f.state.dailyTask[0].rewardClaimed, false);
  await assert.rejects(f.run(option(view, 1004).token), /已经提交/);
});
await check('已达标行只领本行，未开放行无执行入口', async () => {
  const f = setup(), view = await f.view();
  assert.equal(option(view, 1014).token, undefined);
  assert.equal(option(view, 1001).label, '领取奖励');
  assert((await f.run(option(view, 1001).token)).ok);
  assert.deepEqual(f.state.writes, [{ name: 'DrawDailyTaskRewardRequest', body: { id: 1001 } }]);
});
await check('费用变化、日重置和无效报价均拒绝发送', async () => {
  const f = setup(), view = await f.view();
  f.state.price = 20;
  await assert.rejects(f.run(option(view, 1007).token, { paid: true }), /费用已变化/);
  f.state.dailyResetTime++;
  await assert.rejects(f.run(option(view, 1004).token), /已变化/);
  await assert.rejects(f.run('伪造报价'), /过期/);
  assert.equal(f.state.writes.length, 0);
});
await check('钻石操作受本页授权、总开关、保留量及每日额度保护', async () => {
  const f = setup(), token = option(await f.view(), 1007).token;
  await assert.rejects(f.run(token), /先勾选/);
  await assert.rejects(f.run(token, { paid: true }), /总开关/);
  f.settings.resources.allowDiamonds = true; f.settings.resources.diamondThreshold = 990;
  await assert.rejects(f.run(token, { paid: true }), /保留数量/);
  f.settings.resources.diamondThreshold = 0; f.settings.resources.diamondDailyLimit = 10;
  await assert.rejects(f.run(token, { paid: true }), /上限/);
  assert.equal(f.state.writes.length, 0);
  f.settings.resources.diamondDailyLimit = 16;
  assert((await f.run(token, { paid: true })).ok);
  assert.equal(f.ledger.snapshot().counters.diamonds, 16);
  assert.equal(f.state.writes.filter(row => row.name === 'DiscountShopBuyRequest').length, 1);
});
await check('未知结果不报完成，同状态刷新不重复发送', async () => {
  const f = setup(); f.state.unknownDaily = true;
  const result = await f.run(option(await f.view(), 1004).token);
  assert.equal(result.ok, false); assert.match(result.label, /待确认/);
  assert.match(option(await f.view(), 1004).reason, /待确认/);
  assert.equal(f.state.writes.length, 1);
});
await check('手动单项不改自动开关，执行前暂停不发送', async () => {
  const f = setup(); f.settings.dailies.enabled = false;
  const token = option(await f.view(), 1004).token;
  await assert.rejects(f.run(token, { enabled: () => false }), /暂停/);
  assert.equal(f.state.writes.length, 0);
  assert((await f.run(token)).ok); assert.equal(f.settings.dailies.enabled, false);
});
await check('未知钻石结果保留额度，明确拒绝才释放', async () => {
  const f = setup(); f.settings.resources.allowDiamonds = true; f.state.unknownDaily = true;
  assert.equal((await f.run(option(await f.view(), 1007).token, { paid: true })).ok, false);
  assert.equal(f.ledger.snapshot().counters.diamonds, 16);
  const g = setup(); g.settings.resources.allowDiamonds = true;
  const token = option(await g.view(), 1007).token;
  g.client.sendWatch = async name => { throw Object.assign(new Error('服务器明确拒绝'), { request: name, prompt: { prompt: 1 } }); };
  await assert.rejects(g.run(token, { paid: true }), /明确拒绝/);
  assert.equal(g.ledger.snapshot().counters.diamonds ?? 0, 0);
  assert(option(await g.view(), 1007).token);
});
await check('单项钻石请求明确未发送时撤销额度，新报价可重试', async () => {
  const f = setup(); f.settings.resources.allowDiamonds = true;
  const token = option(await f.view(), 1007).token;
  const send = f.client.sendWatch.bind(f.client);
  f.client.sendWatch = async name => { throw Object.assign(new Error('连接已关闭，本次未发送'), { notSent: true, request: name }); };
  await assert.rejects(f.run(token, { paid: true }), /未发送/);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0, '未发送不能占用每日钻石额度');
  assert.equal(f.dailyState.attempted.size, 0, '未发送不能保留消费状态防重标记');
  await assert.rejects(f.run(token, { paid: true }), /已经提交/, '旧报价仍不能重放');
  const next = option(await f.view(), 1007).token;
  assert(next && next !== token, '刷新生成可重新核对的新报价');
  f.client.sendWatch = send;
  assert((await f.run(next, { paid: true })).ok);
  assert.equal(f.ledger.snapshot().counters.diamonds, 16);
  assert.equal(f.state.writes.filter(row => row.name === 'DiscountShopBuyRequest').length, 1);
});
await check('真实协议个人求助类型与精确ID、角标计数', async () => {
  const f = setup(), view = await readGuild(f.client, config, f.player);
  assert.equal(view.requests.length, 2); assert.equal(view.myAidCount, 2);
  assert.deepEqual(view.myRequests.map(row => row.id), ['9007199254741995', '9007199254741997', '9007199254741999']);
  assert.equal(view.myRequests[1].status, '待领取', '已援助记录不能按求助截止时间排除');
  assert.equal(f.state.writes.length, 0);
  const result = await claimMyGuildAid(f.client, config, { player: f.player });
  assert(result.ok); assert.equal(result.count, 2);
  assert.deepEqual(f.state.writes, [{ name: 'GotMyGuildAidRequest', body: { type: 0 } }]);
  assert.equal((await readGuild(f.client, config, f.player)).myAidCount, 0);
  assert.equal((await claimMyGuildAid(f.client, config, { player: f.player })).count, 0);
  assert.equal(f.state.writes.length, 1);
});
await check('个人求助读取失败显示未知，未知领取和暂停不重试', async () => {
  const f = setup(); f.state.aidReadError = true;
  const view = await readGuild(f.client, config, f.player);
  assert.equal(view.myAidCount, null); assert.match(view.myAidError, /读取失败/);
  f.state.aidReadError = false; f.state.unknownAid = true;
  assert.equal((await claimMyGuildAid(f.client, config, { player: f.player })).ok, false);
  await assert.rejects(claimMyGuildAid(f.client, config, { player: f.player }), /待确认/);
  await assert.rejects(claimMyGuildAid(f.client, config, { player: f.player, enabled: () => false }), /暂停/);
  assert.equal(f.state.writes.length, 1);
});

fs.writeFileSync(path.join(process.env.CW_DATA_DIR, 'accounts.json'), JSON.stringify({ version: 1, activeId: 'a', accounts: ['a', 'b'].map(id => ({ id, label: '隔离验证' + id, url: 'ws://127.0.0.1:1', login: {}, automation: { enabled: false, paused: true } })) }));
const { createConsole } = await import('../src/server.mjs');
const app = createConsole({ port: 0 }); await app.listen();
const base = 'http://127.0.0.1:' + app.server.address().port;
const request = async (route, account = 'a', body) => {
  const res = await fetch(base + '/api/' + route + (route.includes('?') ? '&' : '?') + 'account=' + account, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const streamText = async (account, headers) => {
  const response = await fetch(base + '/api/events?account=' + account, { headers });
  const reader = response.body.getReader();
  try { return new TextDecoder().decode((await reader.read()).value); } finally { await reader.cancel(); }
};
try {
  for (const id of ['a', 'b']) { await request('settings', id); const f = commentsFixture(), session = app.sessions.get(id); session.client = f.client; session.player = f.player; session.paused = false; session.fixture = f; }
  await check('HTTP同账号双击合并，跨账号旧报价不可用', async () => {
    const view = (await request('dailies')).data, token = option(view, 1004).token;
    assert.equal((await request('dailies/single', 'b', { confirm: true, token })).status, 400);
    const pair = await Promise.all([1, 2].map(() => request('dailies/single', 'a', { confirm: true, token })));
    assert(pair.every(row => row.status === 200 && row.data.ok));
    assert.equal(app.sessions.get('a').fixture.state.writes.length, 2);
  });
  await check('清空只影响当前账号和旧回放，新日志仍到达', async () => {
    const a = app.sessions.get('a'), b = app.sessions.get('b');
    app.emit(a, 'info', 'A旧日志'); app.emit(b, 'info', 'B旧日志'); app.emit(null, 'info', '共享旧日志');
    const clear = await request('logs/clear', 'a', { confirm: true }); assert.equal(clear.status, 200);
    assert.equal(a.log.length, 0); assert(b.log.some(row => row.message === 'B旧日志'));
    app.emit(a, 'info', 'A新日志');
    const aText = await streamText('a'), bText = await streamText('b');
    assert.match(aText, /A新日志/); assert.doesNotMatch(aText, /A旧日志|共享旧日志/);
    assert.match(bText, /B旧日志/); assert.match(bText, /共享旧日志/); assert.doesNotMatch(bText, /A新日志/);
  });
  await check('清空事件通知同账号窗口，读取中暂停取消排队写入', async () => {
    const stream = await fetch(base + '/api/events?account=a'), reader = stream.body.getReader();
    try {
      await reader.read();
      await request('logs/clear', 'a', { confirm: true });
      const event = new TextDecoder().decode((await reader.read()).value);
      assert.match(event, /event: logs-cleared/);
    } finally { await reader.cancel(); }
    const b = app.sessions.get('b'), token = option((await request('dailies', 'b')).data, 1004).token;
    let release, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    b.fixture.state.beforeRead = async name => { if (name === 'DailyTaskInfoRequest') { entered(); await gate; } };
    const pending = request('dailies/single', 'b', { confirm: true, token });
    await enteredPromise; b.paused = true; b.generation++; release();
    assert.equal((await pending).status, 400); assert.equal(b.fixture.state.writes.length, 0);
    b.fixture.state.beforeRead = null; b.paused = false;
  });
  await check('断线错过清空通知后，重连先同步原水位再回放新日志', async () => {
    const a = app.sessions.get('a');
    const old = app.emit(a, 'info', '断线窗口曾显示的旧记录');
    const cleared = (await request('logs/clear', 'a', { confirm: true })).data;
    const fresh = app.emit(a, 'info', '清空之后保留的新记录');
    const text = await streamText('a', { 'Last-Event-ID': String(old.id) });
    const events = text.trim().split('\n\n').map(block => ({
      type: block.startsWith('event: logs-cleared') ? 'clear' : 'log',
      value: JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6)),
    }));
    assert.equal(events[0].type, 'clear'); assert.deepEqual(events[0].value, cleared);
    assert.equal(events[1].value.id, fresh.id);
    assert.doesNotMatch(text, /断线窗口曾显示的旧记录/);
    assert(fresh.id > cleared.before);
    const again = await streamText('a', { 'Last-Event-ID': String(fresh.id) });
    assert.match(again, /event: logs-cleared/);
    assert.equal(JSON.parse(again.trim().split('\n').find(line => line.startsWith('data: ')).slice(6)).at, cleared.at, '不能把重连时刻当清空时刻误删后来的本地错误');
    assert.doesNotMatch(again, /清空之后保留的新记录/, '已收到的记录不重放');
  });
  await check('暂停账号拒绝日常和个人领取，但允许清理本地日志', async () => {
    const b = app.sessions.get('b'); const view = (await request('dailies', 'b')).data;
    b.paused = true; b.generation++;
    assert.equal((await request('dailies/single', 'b', { confirm: true, token: option(view, 1004).token })).status, 400);
    assert.equal((await request('guild/aid/claim', 'b', { confirm: true })).status, 400);
    assert.equal((await request('logs/clear', 'b', { confirm: true })).status, 200);
    assert.equal(b.fixture.state.writes.length, 0);
  });
  await check('手动海面加速默认不授权，已保存农田加速也不能绕过本轮开关', async () => {
    const session = app.sessions.get('a'), f = commentsFixture();
    f.player.worldId = 9001;
    session.client = f.client; session.player = f.player; session.paused = false;
    session.preferences = defaultSettings();
    session.preferences.building.enabled = session.preferences.factory.enabled = session.preferences.resident.enabled = false;
    session.preferences.factory.demandFirst = false;
    Object.assign(session.preferences.farm, { enabled: true, autoPlant: false, customPlant: true, harvest: false, speedUp: true, crops: [{ id: '小麦', target: 10 }] });
    for (const key of Object.keys(session.loop.tasks)) session.loop.tasks[key] = false;
    session.loop.tasks.farm = session.loop.tasks.speedUp = true;
    const settingsBefore = JSON.stringify(session.preferences);
    const farm = { productId: '小麦', ripeTime: Math.floor(Date.now() / 1000) + 600 };
    const original = f.client.request;
    f.client.request = async (name, body, responseName) => {
      const value = name === 'OnWaterRequest' ? { building: [{ buildingId: '1农田', level: 1, farm }], workerOrder: [] }
        : name === 'AllItemRequest' ? { items: [{ itemId: '加速器', num: 20 }] } : null;
      if (!value) return original(name, body, responseName);
      const type = f.protocol[responseName]; return type.decode(type.encode(value).finish());
    };
    f.client.sendWatch = async (name, body) => { assert.equal(name, 'FarmSpeedUpRequest'); f.state.writes.push({ name, body }); };
    const previews = await Promise.all([request('world?speedUp=false'), request('world?speedUp=true')]);
    assert(previews.every(row => row.status === 200));
    assert(!previews[0].data.plan.some(step => step.request === 'FarmSpeedUpRequest'));
    assert(previews[1].data.plan.some(step => step.request === 'FarmSpeedUpRequest'), '同时读取不同本轮开关时不能共用错误的预览');
    for (const payload of [{ confirm: true }, { confirm: true, speedUp: false }]) {
      const response = await request('world/run', 'a', payload);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(f.state.writes.length, 0, '未明确授权不得消耗加速器');
    }
    const approved = await request('world/run', 'a', { confirm: true, speedUp: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(f.state.writes.length, 1, '仅本轮明确授权后允许发送已配置的催熟');
    assert.equal(f.state.writes[0].body.param.type, 2);
    assert.equal(JSON.stringify(session.preferences), settingsBefore, '本轮开关不改保存配置');
  });
} finally { app.server.closeAllConnections(); await app.close(); }
const report = path.join(parent, 'result-' + Date.now() + '.json');
fs.writeFileSync(report, JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
console.log(results.filter(row => row.passed).length + '/' + results.length + ' 通过；' + report);
if (results.some(row => !row.passed)) process.exitCode = 1;
