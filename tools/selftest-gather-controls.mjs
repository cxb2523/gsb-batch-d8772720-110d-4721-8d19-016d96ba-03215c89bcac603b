import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gather-controls-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { defaultSettings, validateSettings, loadAutomationSettings, saveAutomationSettings, importAutomationSettings,
  exportAutomationSettings, settingsFromNative, nativeTaskValues, applyNativeTask, settingsUiRules, hasExtraWork } = await import('../src/automation-settings.mjs');
const { automationControls, idleAutomationControls, automationControlView, setAutomationControl } = await import('../src/automation-controls.mjs');
const { nativePreferenceEnabled, worldPreferenceEnabled, createActionGuard } = await import('../src/automation-policy.mjs');
const { previewNativeAutomation, planBaseAutomation, runBaseAutomation } = await import('../src/base-automation.mjs');
const { idlePanel } = await import('../src/ui/dist/console.mjs');
const pairs = [
  ['autoFish', 'fishing'], ['autoDive', 'diving'], ['autoSalvage', 'salvage'], ['floaters', 'floaters'],
  ['antiqueFloaters', 'antiqueFloaters'], ['fishEnhance', 'upgradeFishing'], ['diveEnhance', 'upgradeDiving'], ['salvageEnhance', 'upgradeSalvage'],
];
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('ok ' + name); };
try {
  await check('挂机只显示一个采集总开关，细项留在配置且带直达链接', () => {
    assert.deepEqual(idleAutomationControls.filter(c => c.key.startsWith('gather.')).map(c => c.key), ['gather.enabled']);
    const html = idlePanel(automationControls);
    assert.deepEqual([...html.matchAll(/data-auto-task="(gather\.[^"]+)"/g)].map(m => m[1]), ['gather.enabled']);
    assert.match(html, /href="#config-group-gather" aria-label="配置采集"/);
    const rules = settingsUiRules(); assert.ok(rules.controlFields.includes('gather.enabled'));
    for (const [, field] of pairs) assert.ok(!rules.controlFields.includes('gather.' + field));
  });
  await check('总开关只修改自身，开关往返保留混合选择及全部参数', () => {
    const s = defaultSettings(); s.gather.diving = s.gather.salvage = s.gather.keyOpen = true;
    s.gather.targetLevel = 5; const original = structuredClone(s);
    const off = setAutomationControl(s, 'gather.enabled', false);
    assert.deepEqual(off, { ...original, gather: { ...original.gather, enabled: false } });
    assert.deepEqual(setAutomationControl(off, 'gather.enabled', true), original); assert.deepEqual(s, original);
    assert.equal(nativeTaskValues(off, {}).autoDive, true, '细项选择不能被总开关清空');
    assert.equal(applyNativeTask(off, 'autoFish', true).gather.enabled, false, '修改细项不能偷偷重开总开关');
  });
  await check('总开关拦截八项采集及养成，打开只执行选中的项目', () => {
    const s = defaultSettings();
    for (const [task, field] of pairs) {
      s.gather[field] = true; assert.equal(nativePreferenceEnabled(s, task), true);
      s.gather.enabled = false; assert.equal(nativePreferenceEnabled(s, task), false);
      assert.equal(worldPreferenceEnabled(s, task), false);
      s.gather.enabled = true; s.gather[field] = false; assert.equal(nativePreferenceEnabled(s, task), false);
    }
    for (const [, field] of pairs) s.gather[field] = true;
    s.loop.world = false;
    for (const [task] of pairs) assert.equal(nativePreferenceEnabled(s, task), false);
  });
  await check('总览准确标记采集总开关阻断，重新开启解除', () => {
    const s = defaultSettings(); s.gather.diving = true; s.gather.enabled = false;
    const row = automationControlView(s).find(c => c.key === 'gather.diving');
    assert.equal(row.enabled, true); assert.ok(row.blockedBy.includes('采集总开关'));
    s.gather.enabled = true;
    assert.deepEqual(automationControlView(s).find(c => c.key === 'gather.diving').blockedBy, []);
  });
  await check('旧配置读取与旧版导入保留原选择，显式关闭值也保留', () => {
    const old = validateSettings(defaultSettings()); old.gather.diving = true; old.gather.salvage = false;
    delete old.gather.enabled;
    const file = path.join(directory, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { legacy: { settings: old, revision: 8 } } }));
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('legacy', { file });
    assert.equal(loaded.settings.gather.enabled, true); assert.equal(loaded.settings.gather.diving, true);
    assert.equal(loaded.settings.gather.salvage, false); assert.deepEqual(fs.readFileSync(file), bytes);
    const imported = importAutomationSettings({ format: 'crazywaterworld-automation', version: 1, settings: old });
    assert.deepEqual(imported.gather, { enabled: true, ...old.gather });
    imported.gather.enabled = false;
    assert.equal(importAutomationSettings(exportAutomationSettings(imported)).gather.enabled, false);
    assert.equal(settingsFromNative({ autoDive: true, autoSalvage: false }).gather.diving, true);
    assert.equal(settingsFromNative({ autoDive: true, autoSalvage: false }).gather.enabled, true);
    const invalid = defaultSettings(); invalid.gather.enabled = 'true'; assert.throws(() => validateSettings(invalid));
  });
  await check('总开关关闭时预览无采集计划、无读取或写入', async () => {
    const s = defaultSettings(); for (const [, field] of pairs) s.gather[field] = true;
    s.gather.enabled = false; s.gather.keyOpen = true;
    const client = { request() { assert.fail('关闭采集不得读取'); }, sendWatch() { assert.fail('不得写入'); } };
    const preview = await previewNativeAutomation(client, { tables: {} }, { level: 24 }, s,
      Object.fromEntries(pairs.map(([task]) => [task, true])), { have: () => 2 }, {});
    assert.deepEqual(preview.actions, []);
  });
  await check('钥匙开箱随总开关暂停，旧计划和消费保护也不能绕过', async () => {
    const s = defaultSettings(); s.gather.diving = s.gather.keyOpen = true;
    const snapshot = { notes: [], raids: [], world: { stock: new Map([['保险箱钥匙', 2]]), buildings: [], factories: [] }, now: 1000, player: { level: 24 } };
    const plan = planBaseAutomation(snapshot, { tables: {} }, s, {}, { diveCompleted: true });
    assert.equal(plan.actions.filter(a => a.kind === 'diveKey').length, 1); assert.equal(hasExtraWork(s), true);
    s.gather.enabled = false; assert.equal(hasExtraWork(s), false);
    assert.equal(planBaseAutomation(snapshot, { tables: {} }, s, {}, { diveCompleted: true }).actions.length, 0);
    const client = { connected: true, request() { assert.fail('关闭总开关后不得消费钥匙或金币'); } };
    const guard = createActionGuard(client, () => s);
    for (const step of [plan.actions[0], { kind: 'diveEnhance', setting: 'gather.upgradeDiving', costs: [{ id: 'GOLD', num: 50 }] }])
      await assert.rejects(guard.before(step), /设置已关闭/);
    const result = await runBaseAutomation(client, { AntiqueRecruitRequest: {}, AntiqueRecruitResponse: {} }, { tables: {} }, plan, { getSettings: () => s });
    assert.ok(result.every(r => !r.ok));
  });
  await check('HTTP总开关保存、配置细项保存、重载和账号隔离均正确', async () => {
    const { saveStore } = await import('../src/accounts.mjs');
    saveStore({ version: 1, activeId: 'qa-gather-a', accounts: ['qa-gather-a', 'qa-gather-b'].map(id => ({
      id, label: '采集测试', url: 'ws://127.0.0.1:1', login: {}, automation: { paused: true },
    })) });
    const s = defaultSettings(); s.gather.diving = s.gather.salvage = true;
    saveAutomationSettings('qa-gather-a', s, { revision: 0 });
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 }); await app.listen();
    const api = async (route, body, account = 'qa-gather-a') => {
      const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/' + route + '?account=' + account,
        { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    try {
      const a = await api('settings'), b = await api('settings', null, 'qa-gather-b');
      const off = await api('loop/control', { confirm: true, key: 'gather.enabled', enabled: false, revision: a.data.revision });
      assert.equal(off.status, 200);
      assert.ok(off.data.controls.find(c => c.key === 'gather.diving').blockedBy.includes('采集总开关'));
      const saved = await api('settings'); assert.equal(saved.data.settings.gather.enabled, false);
      assert.equal(saved.data.settings.gather.diving, true); assert.equal(saved.data.settings.gather.salvage, true);
      assert.equal(loadAutomationSettings('qa-gather-a').settings.gather.enabled, false);
      const changed = structuredClone(saved.data.settings); changed.gather.fishing = true;
      const result = await api('settings', { confirm: true, settings: changed, revision: saved.data.revision });
      assert.equal(result.status, 200); assert.equal(result.data.settings.gather.enabled, false);
      const on = await api('loop/control', { confirm: true, key: 'gather.enabled', enabled: true, revision: result.data.revision });
      assert.equal(on.status, 200);
      for (const field of ['diving', 'salvage', 'fishing']) assert.equal((await api('settings')).data.settings.gather[field], true);
      assert.equal((await api('settings')).data.settings.gather.upgradeDiving, false);
      assert.equal((await api('loop/control', { confirm: true, key: 'gather.enabled', enabled: false, revision: a.data.revision })).status, 400);
      assert.deepEqual((await api('settings', null, 'qa-gather-b')).data.settings, b.data.settings);
      assert.ok(!app.sessions.get('qa-gather-a').client, '设置操作不能登录游戏');
    } finally { await app.close(); }
  });
  console.log(`gather controls ok: ${passed} checks`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
