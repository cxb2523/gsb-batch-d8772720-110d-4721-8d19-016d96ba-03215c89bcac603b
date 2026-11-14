import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, validateSettings, importAutomationSettings, SETTINGS_FORMAT, createUsageLedger, nativeTaskValues } from '../src/automation-settings.mjs';
import { idleAutomationControls } from '../src/automation-controls.mjs';
import { createChallengeRun, runChallengeRound } from '../src/challenge-automation.mjs';
import { runLoop } from '../src/loop.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { pirateAdvanceFixture } from './fixtures/pirate-advance.mjs';
import { createPirateAdvanceTask } from '../src/pirate-advance.mjs';
import { waitForChallenge, CHALLENGE_INTERVAL_MS } from '../src/battle-pacing.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-challenge-auto-'));
const oldData = process.env.CW_DATA_DIR;
const oldPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.CW_DATA_DIR);
const protocol = loadProtocol();
let count = 0, ledgerId = 0;
const ledger = () => createUsageLedger('simulated', { file: path.join(root, 'usage-' + ++ledgerId + '.json') });
const test = async (name, fn) => { await fn(); count++; console.log('通过：' + name); };

function fixture() {
  const settings = defaultSettings(), client = new EventEmitter(), state = createChallengeRun();
  client.connected = true;
  settings.loop.world = settings.loop.dailies = settings.loop.tasks = settings.loop.heroes = false;
  settings.dailies.enabled = false;
  const player = { playerId: '123', level: 37, mainlineStage: 1, worldId: 1001001, scenarioId: 1 };
  const table = data => ({ data });
  const config = { tables: {
    StageCfg: table(Array.from({ length: 20 }, (_, i) => ({ stage: i + 1, playerLevel: 1 }))),
    TrialRaidCfg: table([1,2,3].map(raidId => ({ raidId, title: '模拟试炼' + raidId }))),
    TrialRaidStageCfg: table([1,2,3].flatMap(raidId => [1,2,3,4,5].map(stageLevel => ({ raidId, stageLevel, stageId: raidId * 100 + stageLevel, openLevel: 1 })))),
  } };
  const writes = [], passed = new Map();
  const f = { client, player, config, settings, state, writes, won: false, hook: null, queued: false, requireQueue: false };
  client.request = async (name, body = {}) => {
    assert(protocol[name], 'real protocol exists: ' + name);
    protocol[name].decode(protocol[name].encode(body).finish());
    if (f.requireQueue) assert(f.queued, 'challenge must execute inside account queue');
    if (name === 'TrialRaidInfoRequest') {
      await f.hook?.(name, body);
      return { raid: { raidId: body.raidId, passedStage: passed.get(body.raidId) ?? 0 } };
    }
    if (name === 'ChallengeStageRequest' || name === 'TrialRaidChallengeRequest') {
      writes.push({ name, body });
      await f.hook?.(name, body);
      const won = typeof f.won === 'function' ? f.won(name, body) : f.won;
      if (name === 'ChallengeStageRequest') return { initialData: { mainlineStage: body.stage }, stats: { isLeftWin: won } };
      if (won) passed.set(body.raidId, body.stageId);
      return { raidId: body.raidId, stageId: body.stageId };
    }
    assert.fail('unexpected request ' + name);
  };
  f.once = extra => runChallengeRound(client, config, { player, getSettings: () => settings, state, wait: async () => {}, ledger: f.ledger ??= ledger(), ...extra });
  f.loop = (rounds, extra = {}) => runLoop(client, protocol, { config, player, rounds, getSettings: () => settings,
    challengeRun: state, isEnabled: () => false, allowMutate: true, everyMs: 1, sleep: async () => {}, usageLedger: f.ledger ??= ledger(),
    schedule: async work => { assert(!f.queued); f.queued = true; try { return await work(); } finally { f.queued = false; } }, ...extra });
  return f;
}

try {
  await test('旧设置与导入保留主线选择，新增试炼/海盗需主动开启，失败次数校验', () => {
    const old = defaultSettings(); delete old.progression; delete old.pirateHunt.enabled; delete old.pirateHunt.maxFailures;
    old.schedule.stageAuto = true;
    for (const s of [validateSettings(old, { partial: true }), importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old })]) {
      assert.equal(s.progression.mainline, true); assert.equal(s.progression.trials, false); assert.equal(s.pirateHunt.enabled, false);
      assert.equal(s.progression.maxFailures, 3); assert.equal(nativeTaskValues(s).stageAuto, true);
    }
    const s = defaultSettings();
    for (const bad of [0, -1, 1.5, 101]) { s.progression.maxFailures = bad; assert.throws(() => validateSettings(s)); }
    s.progression.maxFailures = 3; s.pirateHunt.enabled = true; assert.throws(() => validateSettings(s), /舰队/);
    assert(idleAutomationControls.some(c => c.key === 'progression.enabled' && c.configTarget === 'progression'));
    assert(idleAutomationControls.some(c => c.key === 'pirateHunt.enabled'));
  });
  await test('关闭挑战不开网络请求，保存配置本身不启动任务', async () => {
    const f = fixture(); await f.loop(2); assert.equal(f.writes.length, 0);
  });
  await test('主线与不同试炼共用五秒间隔，等待期间暂停不会发送', async () => {
    const f = fixture(), waits = [];
    Object.assign(f.settings.progression, { mainline: true, trials: true, raidIds: ['1','2'] });
    await f.once({ wait: async ms => { waits.push(ms); } });
    assert.equal(f.writes.length, 3); assert.equal(waits.length, 2);
    assert(waits.every(ms => ms > 0 && ms <= CHALLENGE_INTERVAL_MS));
    const g = fixture(); Object.assign(g.settings.progression, { mainline: true, trials: true, raidIds: ['1'] });
    await g.once({ wait: async () => { g.settings.progression.enabled = false; } });
    assert.equal(g.writes.length, 1);
    const controller = new AbortController(), dummy = {}; let time = 1000;
    await waitForChallenge(dummy, { now: () => time, beforeSend: () => { time += 7000; } });
    time += 1000;
    await assert.rejects(waitForChallenge(dummy, { signal: controller.signal, now: () => time, wait: async ms => { assert.equal(ms, 4000); controller.abort(); } }), /abort/i);
  });
  await test('服务器明确拒绝不记战败或未知结果，只在下一轮重新检查', async () => {
    for (const key of ['mainline', 'trials']) {
      const f = fixture(); f.settings.progression[key] = true; f.settings.progression.raidIds = ['1'];
      f.hook = name => { if (name.includes('Challenge') && f.writes.length === 1) throw Object.assign(new Error('server prompt: too frequent, retry later'), { prompt: { prompt: 1 }, request: name }); };
      await f.once();
      const state = key === 'mainline' ? f.state.mainline : f.state.trials[1];
      assert.equal(state.failures ?? 0, 0); assert(!state.halted); assert.equal(f.writes.length, 1);
      await f.once(); assert.equal(f.writes.length, 2); assert.equal(state.failures, 1);
    }
  });
  await test('主线每轮执行，三次战败后后续轮次不再发送且始终在队列内', async () => {
    const f = fixture(); f.settings.progression.mainline = true; f.requireQueue = true;
    await f.loop(6); assert.equal(f.writes.length, 3); assert.equal(f.state.mainline.failures, 3); assert.equal(f.state.mainline.halted, true);
  });
  await test('通关清零连败计数，下一关继续，无总挑战次数限制', async () => {
    const f = fixture(); f.settings.progression.mainline = true;
    f.won = () => f.writes.length === 2;
    for (let i = 0; i < 5; i++) await f.once();
    assert.deepEqual(f.writes.map(x => x.body.stage), [1,1,2,2,2]);
    assert.equal(f.state.mainline.wins, 1); assert.equal(f.state.mainline.failures, 3); assert(f.state.mainline.halted);
  });
  await test('所选试炼每轮挑战，按副本分别停止，不影响主线或其他副本', async () => {
    const f = fixture(); Object.assign(f.settings.progression, { mainline: true, trials: true, raidIds: ['1','2'], maxFailures: 2 });
    f.won = (name, body) => name === 'ChallengeStageRequest' || body.raidId === 2;
    await f.loop(4);
    assert.equal(f.writes.filter(x => x.name === 'ChallengeStageRequest').length, 4);
    assert.equal(f.writes.filter(x => x.body.raidId === 1).length, 2);
    assert.equal(f.writes.filter(x => x.body.raidId === 2).length, 4);
    assert(!f.writes.some(x => x.body.raidId === 3)); assert(f.state.trials[1].halted); assert(!f.state.trials[2].halted);
  });
  await test('跨重连保留战败计数，用户重新开始才重置', async () => {
    const f = fixture(); f.settings.progression.mainline = true; await f.loop(2);
    const next = fixture(); next.settings.progression.mainline = true;
    await next.loop(4, { challengeRun: f.state });
    assert.equal(next.writes.length, 1); assert(f.state.mainline.halted);
    await next.loop(1, { challengeRun: createChallengeRun() }); assert.equal(next.writes.length, 2);
  });
  await test('战报未知不记战败且阻止跨轮重发', async () => {
    for (const type of ['mainline', 'trials']) {
      const f = fixture(); f.settings.progression[type] = true; f.settings.progression.raidIds = ['1'];
      f.hook = name => { if (name.includes('Challenge')) throw new Error('模拟响应超时'); };
      await f.loop(3); assert.equal(f.writes.length, 1);
      const progress = type === 'mainline' ? f.state.mainline : f.state.trials[1];
      assert.equal(progress.failures ?? 0, 0); assert(progress.halted); assert.match(progress.reason, /未确认/);
    }
  });
  await test('排队期间暂停、读取后关闭及手动任务占用均不再自动发送', async () => {
    const f = fixture(), stop = { aborted: false }; f.settings.progression.mainline = true;
    await f.loop(1, { stop, schedule: async work => { stop.aborted = true; return work(); } }); assert.equal(f.writes.length, 0);
    const g = fixture(); g.settings.progression.trials = true; g.settings.progression.raidIds = ['1'];
    g.hook = () => { g.settings.progression.enabled = false; };
    await g.once(); assert.equal(g.writes.length, 0);
    f.settings.progression.trials = true; await f.once({ isStageBusy: () => true, isTrialBusy: () => true }); assert.equal(f.writes.length, 0);
  });
  await test('海盗跨轮确认首杀和三次战败上限，不重置汽油预算', async () => {
    for (const mode of ['lose', 'win']) {
      const f = pirateAdvanceFixture({ mode }), state = createChallengeRun(), l = ledger();
      Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3, fuelBudget: mode === 'win' ? 600 : 3000 });
      for (let i = 0; i < 7; i++) await runChallengeRound(f.client, f.config, { player: f.player, getSettings: () => f.settings, state, ledger: l });
      assert.equal(f.client.writes.length, mode === 'lose' ? 3 : 2);
      assert.equal(state.pirate.state.spent, mode === 'lose' ? 900 : 600);
      if (mode === 'lose') { assert.equal(state.pirate.state.failures, 3); assert(state.pirate.state.halted); }
    }
  });
  await test('海盗在途与未知结果跨轮不重派，停止不会强制召回', async () => {
    for (const mode of ['wait', 'unknown']) {
      const f = pirateAdvanceFixture({ mode }), state = createChallengeRun(), l = ledger();
      Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3 });
      for (let i = 0; i < 4; i++) await runChallengeRound(f.client, f.config, { player: f.player, getSettings: () => f.settings, state, ledger: l });
      assert.equal(f.client.writes.length, 1); assert.equal(state.pirate.state.failures, 0);
    }
  });
  await test('调低海盗失败上限后立即停止，不因增加预算继续派遣', async () => {
    const f = pirateAdvanceFixture({ mode: 'lose' }), state = createChallengeRun(), l = ledger();
    Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3, fuelBudget: 300 });
    const round = () => runChallengeRound(f.client, f.config, { player: f.player, getSettings: () => f.settings, state, ledger: l });
    await round(); await round();
    assert.equal(state.pirate.state.failures, 1); assert.equal(f.client.writes.length, 1);
    Object.assign(f.settings.pirateHunt, { maxFailures: 1, fuelBudget: 3000 });
    await round(); assert(state.pirate.state.halted); assert.equal(f.client.writes.length, 1);
  });
  await test('海盗自动派遣进入挂机串行队列，每轮最多一次，不需手动启动', async () => {
    const f = pirateAdvanceFixture(), state = createChallengeRun(), l = ledger(), perRound = [];
    Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3 });
    f.settings.loop.world = f.settings.loop.dailies = f.settings.loop.tasks = f.settings.loop.heroes = false;
    let queued = false;
    const request = f.client.request, send = f.client.sendWatch;
    f.client.request = (...args) => { assert(queued); return request(...args); };
    f.client.sendWatch = (...args) => { assert(queued); return send(...args); };
    await runLoop(f.client, protocol, { config: f.config, player: f.player, rounds: 4, allowMutate: true,
      getSettings: () => f.settings, isEnabled: () => false, usageLedger: l, challengeRun: state, everyMs: 1, sleep: async () => {},
      schedule: async work => { assert(!queued); queued = true; try { return await work(); } finally { queued = false; } },
      onRound: () => perRound.push(f.client.writes.length) });
    assert.deepEqual(perRound, [1,2,3,3]); assert.equal(state.pirate.state.wins, 3);
  });
  await test('隔离控制台按账号保存统一配置，未启动时无游戏连接', async () => {
    process.env.CW_CONFIG_PACK = path.join(root, 'config.json');
    const tables = { ...pirateAdvanceFixture().config.tables, ...fixture().config.tables, BuildingUnlockCfg: { data: [{ buildingType: '远征船', buildingId: '1远征船' }] } };
    fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(tables).map(([name, table], index) => [index, name, table])));
    fs.writeFileSync(path.join(process.env.CW_DATA_DIR, 'accounts.json'), JSON.stringify({ version: 1, activeId: 'a', accounts: ['a','b'].map(id => ({ id, label: '模拟账号' + id, url: 'ws://127.0.0.1:1', login: {}, automation: { paused: true } })) }));
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 });
    try {
      const url = await app.listen();
      const a = await (await fetch(url + '/api/settings?account=a')).json();
      a.settings.progression.maxFailures = 7;
      const saved = await fetch(url + '/api/settings?account=a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: a.settings, revision: a.revision, baseRevision: a.baseRevision }) });
      assert.equal(saved.status, 200, await saved.text());
      assert.equal((await (await fetch(url + '/api/settings?account=a')).json()).settings.progression.maxFailures, 7);
      assert.equal((await (await fetch(url + '/api/settings?account=b')).json()).settings.progression.maxFailures, 3);
      assert(!Object.hasOwn(await (await fetch(url + '/api/stages?account=a')).json(), 'configuredMaxFailures'));
      assert(!app.sessions.get('a').client); assert(!app.sessions.get('b').client);
      const session = app.sessions.get('a'), checkedAt = Math.floor(Date.now() / 1000);
      session.loop.controlStatus = new Map(['stageAuto', 'trialAuto:1', 'pirateAuto'].map(key => [key, { text: key + ' 已检查', state: 'waiting', checkedAt }]));
      const loop = await (await fetch(url + '/api/loop?account=a')).json();
      for (const [key, task] of [['progression.mainline','stageAuto'], ['progression.trials','trialAuto:1'], ['pirateHunt.enabled','pirateAuto']]) {
        assert.equal(loop.controls.find(control => control.key === key).observation.text, task + ' 已检查');
      }
      const page = await (await fetch(url)).text();
      assert(page.includes('data-auto-task="progression.enabled"')); assert(page.includes('data-auto-task="pirateHunt.enabled"'));
      assert(page.includes('失败停止次数')); assert(!page.includes('>次数</label>'));
      const stageHtml = page.slice(page.indexOf('id="tab-stages"'), page.indexOf('id="tab-stages"') + 18000);
      assert.match(stageHtml, /<input[^>]*id="stage-failures"/);
      assert(stageHtml.includes('id="pirate-advance-start"'));
      const idleHtml = page.slice(page.indexOf('id="tab-idle"'), page.indexOf('id="tab-settings"'));
      assert(!idleHtml.includes('id="pirate-advance-start"'));
      for (const [, script] of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
  await test('手动主线和试炼使用本次参数，不继承或修改挂机失败上限', async () => {
    const f = fixture(); f.client.stop = () => { f.client.connected = false; };
    const { createConsole } = await import('../src/server.mjs'), app = createConsole({ port: 0 });
    try {
      const url = await app.listen(); await fetch(url + '/api/settings?account=a');
      const session = app.sessions.get('a');
      Object.assign(session, { client: f.client, player: f.player, paused: false });
      session.loop.tasks.afk = false;
      const post = async (route, payload) => {
        const response = await fetch(url + route + '?account=a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, ...payload }) });
        const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
      };
      for (const [route, payload] of [['/api/stages', {}], ['/api/trials', { raidId: 1 }]]) {
        for (const maxFailures of [undefined, 1]) {
          const started = await post(route + '/start', { ...payload, ...(maxFailures ? { maxFailures } : {}) });
          assert.equal(started.maxFailures, maxFailures ?? 3);
          await post(route + '/stop', payload);
          const task = route.endsWith('stages') ? session.stages : session.trials.get(1);
          for (let i = 0; task.view().running && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(task.view().running, false);
        }
      }
      assert.equal(session.loop.running, false);
      const settings = await (await fetch(url + '/api/settings?account=a')).json();
      assert.equal(settings.settings.progression.maxFailures, 7);
      assert.equal(settings.settings.progression.mainline, false);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
  await test('手动海盗失败上限独立，默认一次战败停止，显式参数可覆盖', async () => {
    for (const limit of [undefined, 2]) {
      const f = pirateAdvanceFixture({ mode: 'lose' }), task = createPirateAdvanceTask();
      f.settings.pirateHunt.maxFailures = 7;
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const state = task.start(f.settings.pirateHunt, async () => ({ client: f.client, config: f.config, player: f.player,
        ledger: ledger(), getSettings: () => f.settings, enabled: () => true, sleep: async () => {} }), s => { if (!s.running) finish(s); }, limit);
      assert.equal(state.maxFailures, limit ?? 1);
      const result = await done; assert.equal(result.failures, limit ?? 1); assert.equal(f.client.writes.length, limit ?? 1);
      assert.equal(f.settings.pirateHunt.maxFailures, 7);
    }
  });
  await test('海盗预览沿用自动挂机预算与停止状态，读取不发送派遣', async () => {
    const f = pirateAdvanceFixture();
    f.client.stop = () => { f.client.connected = false; };
    const { createConsole } = await import('../src/server.mjs'), app = createConsole({ port: 0 });
    try {
      const url = await app.listen();
      await fetch(url + '/api/settings?account=b');
      const session = app.sessions.get('b');
      Object.assign(session, { client: f.client, player: f.player, paused: false });
      session.loop.running = true;
      session.loop.challengeRun = createChallengeRun();
      const progress = session.loop.challengeRun.pirate.state = { spent: 0 };
      const preview = async () => {
        const response = await fetch(url + '/api/settings/preview?account=b', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: f.settings, category: 'pirateHunt' }) });
        const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
      };
      assert.equal((await preview()).actions.length, 1);
      progress.spent = f.settings.pirateHunt.fuelBudget;
      const exhausted = await preview(); assert.equal(exhausted.actions.length, 0); assert.match(exhausted.notes.join(' '), /预算/);
      Object.assign(progress, { spent: 0, halted: true, reason: '达到失败停止次数' });
      const halted = await preview(); assert.equal(halted.actions.length, 0); assert.match(halted.notes.join(' '), /失败停止次数/);
      session.loop.running = false;
      assert.equal((await preview()).actions.length, 1);
      assert.equal(f.client.writes.length, 0);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
} finally {
  if (oldData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = oldData;
  if (oldPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = oldPack;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('自动推关与讨伐专项 ' + count + '/' + count + ' 通过');
