import assert from 'node:assert/strict';
import fs from 'node:fs';
import { automationTasks } from '../src/automation.mjs';

const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const definitions = script.slice(0, script.indexOf('function configGet('));
const renderStart = script.indexOf('function configRender()');
const modelStart = script.indexOf('  const groups =', renderStart);
const modelEnd = script.indexOf('  const movedFields =', modelStart);
assert(modelStart > renderStart && modelEnd > modelStart);
const model = script.slice(modelStart, modelEnd);
const renderGroups = new Function('data', definitions + '\nconfigEditor.data=data;\n' + model + '\nreturn groups;');
const retiredKeys = [
  'riverScore', 'riverPass', 'riverHelp', 'edictPass', 'compassDaily', 'compassAdGift', 'compassSpin',
  'festivalSign', 'festivalFreeGift', 'festivalActive', 'festivalGifts', 'snowballFree',
  'festivalActiveRewards', 'evilExpel', 'edict', 'compassReward',
];
const hiddenFields = [...retiredKeys.map(key => 'schedule.' + key), 'eventActions.compassThreshold', 'eventActions.compassDrawCount'];
const dataFor = (hidden = hiddenFields, tasks = automationTasks) => ({
  settings: { schedule: Object.fromEntries(retiredKeys.map(key => [key, true])), eventActions: { compassThreshold: 21, compassDrawCount: 5 } },
  tasks, rules: { hiddenFields: hidden, mappedTasks: [] }, catalog: {}, revision: 7, baseRevision: 'base-7',
  usage: { rounds: 0 }, pendingUsage: {},
});
const keysOf = groups => groups.flatMap(group => group.fields.map(field => field.key));
let tests = 0;
async function test(name, run) { await run(); tests++; console.log('通过：' + name); }

await test('16 项联动开关及 2 个参数同时隐藏，静态与自动补齐不回流', () => {
  const data = dataFor(), before = structuredClone(data), groups = renderGroups(data), keys = keysOf(groups);
  for (const key of hiddenFields) assert(!keys.includes(key), key);
  assert(!groups.some(group => group.id === 'river-series'), '联动空组不进入标签或预览选项');
  assert(groups.every(group => group.fields.length), '不保留空组');
  assert.deepEqual(data, before, '过滤不得改变保存值、参数或任务定义');
});

await test('服务端已过滤任务时静态联动与广告入口仍隐藏', () => {
  const tasks = automationTasks.filter(task => !retiredKeys.includes(task.key));
  const groups = renderGroups(dataFor(hiddenFields, tasks));
  assert(!keysOf(groups).some(key => hiddenFields.includes(key)));
  assert(!groups.some(group => group.id === 'river-series'));
  assert(groups.find(group => group.id === 'ad-rewards').fields.some(field => field.key === 'schedule.adShop'));
});

await test('周期、风采、新手及其他任务不受联动下线影响', () => {
  const keys = new Set(keysOf(renderGroups(dataFor())));
  for (const key of ['armsRaceRewards', 'merchantTrade', 'merchantRewards', 'beautyVotes', 'beautyGift', 'newbieLogin', 'weekOrderSubmit', 'pirateRankRewards', 'warRankRewards']) {
    assert(keys.has('schedule.' + key), key);
  }
  assert(keys.has('building.enabled'));
});

await test('复开后全部入口和参数恢复，原配置定义未被过滤污染', () => {
  const hidden = renderGroups(dataFor());
  const reopened = renderGroups(dataFor([])), keys = new Set(keysOf(reopened));
  for (const key of hiddenFields) assert(keys.has(key), key);
  assert(reopened.some(group => group.id === 'river-series'));
  assert(!hidden.some(group => group.id === 'river-series'));
});

const loadSource = script.slice(script.indexOf('async function configLoad('), script.indexOf('async function configMayChangeAccount('));
const saveSource = script.slice(script.indexOf('function configSave('), script.indexOf('async function configImportFile('));
const dirtySource = script.slice(script.indexOf('function configIsDirty('), script.indexOf('function configVisible('));
const page = fs.readFileSync(new URL('../src/page.mjs', import.meta.url), 'utf8');
const toggleSource = page.slice(page.indexOf('async function toggleAutoTask('), page.indexOf('for (const input of taskInputs) input.onclick'));
function loadFixture(initial = dataFor([])) {
  const state = { next: structuredClone(initial), renders: [], usageRenders: 0, messages: [], calls: [] };
  const api = new Function('state', 'renderGroups', definitions + '\n' + dirtySource + '\n' + loadSource + '\n' + saveSource + '\n' + toggleSource + `
    const current = 'isolated-account', accounts = [];
    const savingTasks = new Set();
    let loopVersion = 0, loopSettingsRevision = 7;
    const setTaskSwitch = (input, value) => { input.checked = value; };
    const refreshLoop = () => {};
    const reportError = error => { throw error; };
    const $ = () => ({});
    const call = async route => { state.calls.push(route); return route === '/api/settings' ? structuredClone(state.next) : { controls: [] }; };
    const configBusy = value => { configEditor.busy = value; };
    const configMessage = (...args) => state.messages.push(args);
    const configUpdateState = () => {};
    const configUpdateVisibility = () => {};
    const configCheckForm = () => true;
    const configErrors = error => { throw error; };
    const configRenderUsage = () => { state.usageRenders++; };
    const configRender = () => state.renders.push({ groups: renderGroups(configEditor.data), draft: structuredClone(configEditor.draft) });
    return { editor: configEditor, load: configLoad, save: configSave, dirty: configIsDirty, toggle: toggleAutoTask };
  `)(state, renderGroups);
  return { state, ...api };
}

await test('保存版本和配置未变化时，下线与复开均即时刷新展示', async () => {
  const f = loadFixture(); await f.load();
  assert(f.state.renders[0].groups.some(group => group.id === 'river-series'));
  f.state.next.rules.hiddenFields = [...hiddenFields];
  await f.load();
  assert.equal(f.state.renders.length, 2);
  assert(!f.state.renders[1].groups.some(group => group.id === 'river-series'));
  assert.equal(f.editor.data.revision, 7);
  f.state.next.rules.hiddenFields = [];
  await f.load();
  assert.equal(f.state.renders.length, 3);
  assert(f.state.renders[2].groups.some(group => group.id === 'river-series'));
  assert(!f.dirty());
});

await test('未保存草稿保留，活动刷新不覆盖编辑或推进冲突版本', async () => {
  const f = loadFixture(); await f.load();
  f.editor.draft.schedule.riverScore = false;
  f.editor.draft.eventActions.compassThreshold = 88;
  const draft = f.editor.draft, baseline = f.editor.baseline, oldDataSettings = f.editor.data.settings;
  f.state.next = dataFor(); f.state.next.revision = 8; f.state.next.baseRevision = 'base-8';
  f.state.next.settings.eventActions.compassThreshold = 33;
  await f.load();
  assert.equal(f.state.renders.length, 2);
  assert(!f.state.renders[1].groups.some(group => group.id === 'river-series'));
  assert.equal(f.editor.draft, draft);
  assert.equal(f.editor.baseline, baseline);
  assert.equal(f.editor.data.settings, oldDataSettings);
  assert.equal(f.editor.draft.eventActions.compassThreshold, 88);
  assert.equal(f.editor.draft.schedule.riverScore, false);
  assert.equal(f.editor.data.revision, 7);
  assert.equal(f.editor.data.baseRevision, 'base-7');
  assert(f.dirty());
  f.state.next.rules.hiddenFields = [];
  await f.load();
  assert(f.state.renders[2].groups.some(group => group.id === 'river-series'));
  assert.equal(f.editor.draft.eventActions.compassThreshold, 88);
  assert.equal(f.editor.baseline, baseline);
});

await test('规则不变的后台刷新只更新运行数据，不反复重绘编辑器', async () => {
  const f = loadFixture(); await f.load();
  f.editor.draft.eventActions.compassThreshold = 42;
  f.state.next.usage.rounds = 9;
  await f.load();
  assert.equal(f.state.renders.length, 1);
  assert.equal(f.state.usageRenders, 1);
  assert.equal(f.editor.data.usage.rounds, 9);
  assert.equal(f.editor.draft.eventActions.compassThreshold, 42);
});

await test('挂机开关保存期间开始编辑，随后刷新保留同账号草稿和原冲突版本', async () => {
  const f = loadFixture(); await f.load();
  const owner = f.editor.owner;
  f.state.next.revision = 8;
  const input = { dataset: { autoTask: 'building.collect' }, checked: true, getAttribute() { return String(this.checked); } };
  const pending = f.toggle(input);
  f.editor.draft.eventActions.compassThreshold = 88;
  await pending;
  assert.equal(f.editor.owner, owner, '快捷开关不能让草稿失去账号归属');
  await f.load();
  assert.equal(f.editor.draft.eventActions.compassThreshold, 88);
  assert.equal(f.editor.data.revision, 7, '保留版本冲突保护，不能用旧草稿覆盖新开关');
  assert(f.dirty());
});

await test('只改变任务清单也更新动态配置入口', async () => {
  const f = loadFixture(); await f.load();
  f.state.next.tasks = f.state.next.tasks.filter(task => task.key !== 'festivalActive');
  await f.load();
  assert.equal(f.state.renders.length, 2);
  assert(!keysOf(f.state.renders[1].groups).includes('schedule.festivalActive'));
});

await test('保存回复带回新的下线规则时同步重绘，避免后续刷新误判展示未变', async () => {
  const f = loadFixture(); await f.load();
  f.editor.draft.schedule.riverScore = false;
  f.state.next.settings.schedule.riverScore = false;
  f.state.next.rules.hiddenFields = [...hiddenFields];
  f.state.next.running = true;
  await f.save();
  assert.equal(f.state.renders.length, 2);
  assert(!f.state.renders[1].groups.some(group => group.id === 'river-series'));
  assert(!keysOf(f.state.renders[1].groups).some(key => hiddenFields.includes(key)));
  assert.equal(f.editor.draft.eventActions.compassThreshold, 21);
  assert(!f.dirty());
});

new Function(script);
console.log('活动配置界面专项 ' + tests + '/' + tests + ' 通过');
