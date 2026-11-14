// 执行真实前端函数，以可控时钟、隔离账号文件验证自动保存及请求竞争。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, validateSettings, saveAutomationSettings, loadAutomationSettings, importAutomationSettings, exportAutomationSettings } from '../src/automation-settings.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-autosave-'));
const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = script.indexOf(from), end = script.indexOf(to, start);
  assert(start >= 0 && end > start, from);
  return script.slice(start, end);
};
const sources = [
  section('// 游戏配置编辑器', 'function configGet('),
  section('function configGet(', 'function configRevealTab('),
  section('async function configLoad(', 'async function configRefreshPlayers('),
  section('function configSave(', 'async function configExport('),
].join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let serial = 0, passed = 0;
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

function fixture() {
  const file = path.join(directory, 'settings-' + (++serial) + '.json');
  for (const id of ['a', 'b']) saveAutomationSettings(id, defaultSettings(), { file, revision: 0 });
  let now = 0, timerId = 0;
  const timers = new Map(), nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, childNodes: [], value: '', hidden: false, disabled: false,
      classList: { contains: () => true }, setAttribute() {}, removeAttribute() {}, append() {}, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const view = account => ({ ...loadAutomationSettings(account, { file }), catalog: {}, rules: {}, tasks: [], usage: {}, pendingUsage: {}, running: false });
  const env = {
    node, calls: [], renders: 0, focuses: 0, confirmations: 0, failPosts: 0, inFlight: 0, maxInFlight: 0,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    confirm() { env.confirmations++; return false; },
    async call(account, route, options) {
      const payload = options?.body ? JSON.parse(options.body) : null;
      env.calls.push({ account, route, payload });
      if (route === '/api/settings/validate') return { settings: payload.document ? importAutomationSettings(payload.document) : validateSettings(payload.settings) };
      if (route === '/api/loop') return { controls: [] };
      assert.equal(route, '/api/settings');
      if (!payload) { const data = view(account); await env.onGet?.(); return data; }
      env.inFlight++; env.maxInFlight = Math.max(env.maxInFlight, env.inFlight);
      try {
        if (env.failPosts-- > 0) throw new TypeError('模拟网络断开');
        saveAutomationSettings(account, payload.settings, { file, revision: payload.revision });
        const data = view(account);
        await env.onPost?.(payload);
        return data;
      } finally { env.inFlight--; }
    },
  };
  const api = new Function('env', sources + `
    let current = 'a', loopSettingsRevision = 1, loopFieldDefaults = null;
    const accounts = [], $ = env.node, window = { confirm: env.confirm };
    const setTimeout = env.setTimeout, clearTimeout = env.clearTimeout;
    const call = (route, options) => env.call(current, route, options);
    const configRenderUsage = () => {}, configUpdateVisibility = () => {};
    const configActivate = () => { env.focuses++; }, configActivateGroup = () => {};
    const configRender = () => { env.renders++; };
    const resetWorldMap = () => {}, resetActivityRanks = () => {};
    const clear = node => node, el = () => ({});
    return {
      editor: configEditor, set: configSet, load: configLoad, save: configSave, flush: configFlush,
      dirty: configIsDirty, importFile: configImportFile, mayChange: configMayChangeAccount,
      revision: () => loopSettingsRevision,
      change(next) { current = next; configAccountChanged(); },
    };
  `)(env);
  return { ...api, env, node, file, view,
    posts: () => env.calls.filter(row => row.route === '/api/settings' && row.payload),
    async tick(ms) {
      const end = now + ms; let executions = 0;
      await settle();
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert(++executions < 100, '自动保存不能无界重试');
        const [id, timer] = next; timers.delete(id); now = timer.at; timer.callback(); await settle();
      }
      now = end; await settle();
    },
  };
}

await test('打开配置不写盘，连续输入只保存最终值并更新版本提示', async () => {
  const f = fixture(); await f.load(); await f.tick(1000);
  assert.equal(f.posts().length, 0);
  f.set('factory.keepStock', 10); await f.tick(400);
  f.set('factory.keepStock', 125); await f.tick(599);
  assert.equal(f.posts().length, 0);
  await f.tick(1);
  assert.equal(f.posts().length, 1); assert.equal(f.view('a').settings.factory.keepStock, 125);
  assert.equal(f.revision(), 2); assert(!f.dirty());
  assert.match(f.node('config-state').textContent, /配置已同步/);
  assert.equal(f.node('config-retry').hidden, true);
});

await test('多选、顺序、开关和互斥联动一起自动保存', async () => {
  const f = fixture(); await f.load();
  f.set('treasure.followNames', ['甲', '乙']);
  f.set('factory.demandPriority', [...f.editor.draft.factory.demandPriority].reverse());
  f.set('farm.customPlant', true); f.set('farm.crops', [{ id: '小麦', target: 12 }]);
  await f.tick(600);
  assert.equal(f.posts().length, 1);
  assert.deepEqual(f.view('a').settings, validateSettings(f.editor.draft));
  assert.equal(f.view('a').settings.farm.autoPlant, false);
});

await test('在途保存期间继续编辑，串行保存后一批而不覆盖输入', async () => {
  const f = fixture(); await f.load(); const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 80); await f.tick(600);
  assert(f.editor.saving); assert.match(f.node('config-state').textContent, /正在自动保存/);
  f.set('factory.keepStock', 90); await f.tick(600);
  assert.equal(f.posts().length, 1);
  f.env.onPost = null; gate.resolve(); await settle();
  assert.equal(f.editor.draft.factory.keepStock, 90); assert(f.dirty());
  await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.env.maxInFlight, 1);
  assert.equal(f.posts()[1].payload.revision, 2); assert.equal(f.view('a').settings.factory.keepStock, 90);
});

await test('在途保存时改回原值，仍把用户最后的值持久化', async () => {
  const f = fixture(); await f.load(); const original = f.editor.draft.factory.keepStock;
  const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', original + 1); await f.tick(600);
  f.set('factory.keepStock', original); assert(!f.dirty());
  f.env.onPost = null; gate.resolve(); await settle(); await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.view('a').settings.factory.keepStock, original); assert(!f.dirty());
});

await test('数字输入为空时不提交、不抢焦点，补齐后自动保存', async () => {
  const f = fixture(); await f.load();
  const input = { checkValidity: () => Number.isInteger(f.editor.draft.ads.waitSeconds) && f.editor.draft.ads.waitSeconds >= 5,
    focus() { f.env.focuses++; }, reportValidity() { f.env.focuses++; } };
  f.editor.widgets.set('ads.waitSeconds', { row: { querySelectorAll: () => [input] }, control: { setAttribute() {} }, error: {}, clearError() {} });
  f.set('ads.waitSeconds', null); await f.tick(10000);
  assert.equal(f.posts().length, 0); assert.equal(f.env.focuses, 0); assert(f.dirty());
  f.set('ads.waitSeconds', 21); await f.tick(600);
  assert.equal(f.view('a').settings.ads.waitSeconds, 21); assert(!f.dirty());
});

await test('跨字段校验失败不会循环提交，修正后自动重试', async () => {
  const f = fixture(); await f.load();
  f.set('treasure.enabled', true); await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.match(f.node('config-state').textContent, /请修正/);
  assert.equal(f.env.focuses, 0); assert.equal(f.view('a').settings.treasure.enabled, false);
  f.set('treasure.fleetIds', ['1远征船']); await f.tick(600);
  assert.equal(f.posts().length, 2); assert.equal(f.view('a').settings.treasure.enabled, true); assert(!f.dirty());
});

await test('网络失败有界退避重试，恢复后自动保存', async () => {
  const f = fixture(); await f.load(); f.env.failPosts = 3;
  f.set('factory.keepStock', 91); await f.tick(8000);
  assert.equal(f.posts().length, 4); assert.equal(f.view('a').settings.factory.keepStock, 91); assert(!f.dirty());
});

await test('持续失败保留更改并显示重试入口，不误报已保存', async () => {
  const f = fixture(); await f.load(); f.env.failPosts = 10;
  f.set('factory.keepStock', 92); await f.tick(60000);
  assert.equal(f.posts().length, 4); assert(f.dirty()); assert.equal(f.node('config-retry').hidden, false);
  assert.match(f.node('config-state').textContent, /自动保存失败/);
  f.env.failPosts = 0; await f.save();
  assert.equal(f.view('a').settings.factory.keepStock, 92); assert(!f.dirty());
});

await test('多页面版本冲突保留本地修改，不自动覆盖另一页的配置', async () => {
  const f = fixture(); await f.load();
  const external = f.view('a'); external.settings.factory.keepStock = 123;
  saveAutomationSettings('a', external.settings, { file: f.file, revision: external.revision });
  f.set('ads.waitSeconds', 22); await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.match(f.node('config-state').textContent, /冲突/);
  f.set('ads.waitSeconds', 23); await f.tick(10000);
  assert.equal(f.posts().length, 1); assert.equal(await f.flush(), false);
  assert.equal(f.editor.data.revision, 1); assert.equal(f.view('a').settings.factory.keepStock, 123);
  await f.load(true); assert(!f.dirty()); assert.equal(f.editor.saveError, null);
});

await test('开始任务前立即保存待提交内容，并等待在途修改全部完成', async () => {
  const f = fixture(); await f.load(); const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 101);
  const flushed = f.flush(); await settle();
  assert.equal(f.posts().length, 1);
  f.set('factory.keepStock', 102); f.env.onPost = null; gate.resolve();
  assert.equal(await flushed, true);
  assert.equal(f.view('a').settings.factory.keepStock, 102); assert.equal(f.posts().length, 2);
  await f.tick(10000); assert.equal(f.posts().length, 2);
});

await test('切换账号先自动保存，无须确认；定时器不会写到新账号', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 103);
  assert.equal(await f.mayChange('b'), true); assert.equal(f.env.confirmations, 0);
  f.change('b'); await f.load(); await f.tick(10000);
  assert.equal(f.view('a').settings.factory.keepStock, 103);
  assert.equal(f.view('b').settings.factory.keepStock, 50);
  assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].account, 'a');
});

await test('账号被外部移除或切换后，旧请求回复不污染新账号', async () => {
  const f = fixture(); await f.load(); const gate = deferred(); f.env.onPost = () => gate.promise;
  f.set('factory.keepStock', 104); await f.tick(600);
  f.change('b'); await f.load();
  f.env.onPost = null; gate.resolve(); await settle(); await f.tick(10000);
  assert.equal(f.editor.owner, 'b'); assert.equal(f.editor.data.revision, 1);
  assert.equal(f.editor.draft.factory.keepStock, 50); assert.equal(f.posts().length, 1);
});

await test('重新载入取消尚未提交的修改，载入期间新输入不会丢失', async () => {
  const f = fixture(); await f.load(); f.set('factory.keepStock', 105);
  await f.load(true); await f.tick(10000);
  assert.equal(f.posts().length, 0); assert.equal(f.editor.draft.factory.keepStock, 50);
  const gate = deferred(); f.env.onGet = () => gate.promise;
  const pending = f.load(true); f.set('factory.keepStock', 106); await f.tick(600);
  f.env.onGet = null; gate.resolve(); await pending; await f.tick(600);
  assert.equal(f.view('a').settings.factory.keepStock, 106);
});

await test('导入校验通过后自动保存，不需要额外点击按钮', async () => {
  const f = fixture(); await f.load(); const settings = defaultSettings(); settings.ads.waitSeconds = 24;
  const document = JSON.stringify(exportAutomationSettings(settings));
  await f.importFile({ target: { value: 'fixture.json', files: [{ size: document.length, text: async () => document }] } });
  await f.tick(600);
  assert.equal(f.posts().length, 1); assert.equal(f.view('a').settings.ads.waitSeconds, 24); assert(!f.dirty());
});

await test('三支硅矿舰队独立编辑自动保存，刷新和切号保留各自字段', async () => {
  const f = fixture(); await f.load();
  f.set('silicon.fleets.0.enabled', true); f.set('silicon.fleets.0.tier', 'PURPLE');
  f.set('silicon.fleets.1.safePlayers', ['甲']); f.set('silicon.fleets.2.dailyAttackLimit', 7);
  f.set('guildShip.redStartTime', '21:30'); await f.tick(600);
  assert.equal(f.posts().length, 1); assert(Array.isArray(f.view('a').settings.silicon.fleets));
  await f.load(true);
  assert.equal(f.editor.draft.silicon.fleets[0].tier, 'PURPLE');
  assert.deepEqual(f.editor.draft.silicon.fleets[1].safePlayers, ['甲']);
  assert.equal(f.editor.draft.silicon.fleets[2].dailyAttackLimit, 7);
  assert.equal(f.editor.draft.guildShip.redStartTime, '21:30');
  assert.equal(f.view('b').settings.silicon.fleets[0].enabled, false);
});

console.log('配置自动保存专项 ' + passed + '/' + passed + ' 通过');
