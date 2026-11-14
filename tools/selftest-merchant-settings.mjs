// 海商王参数回归：只使用临时配置和界面定义，不连接游戏或读取账号凭据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultSettings, validateSettings, exportAutomationSettings, importAutomationSettings,
  loadAutomationSettings, saveAutomationSettings, settingsUiRules
} from '../src/automation-settings.mjs';

const defaults = {
  quoteMaxAgeSeconds: 300, estimateDiscountPercent: 10, refreshWaitSeconds: 120, liquidationMinutes: 120,
  maxLossPercent: 0, minExpectedProfit: 1, autoSpeedUp: false, speedUpMinProfit: 1000, keepPointers: 0,
  speedUpMode: 'profit', speedUpMaxPerLeg: 4, monitorSeconds: 60,
  refreshWindowMinutes: 8, dailyPointerLimit: 28, autoBuyPointers: false, pointerDailyDiamondLimit: 0,
  profitLimit: 0, firstDepartureMode: 'smart', firstDepartureTime: '10:00', firstDepartureWaitMinutes: 29,
  autoUpgrade: false, upgradeCoinValuePerDiamond: 100, upgradeMinReturnPercent: 150, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300
};
let passed = 0;
const test = (name, run) => { run(); passed++; console.log('通过：' + name); };

test('保守默认值与独立开关，不因新增策略开启走商或指针消费', () => {
  const settings = defaultSettings();
  assert.deepEqual(settings.merchant, defaults);
  assert.equal(settings.schedule.merchantTrade, false);
  assert.equal(settings.merchant.autoSpeedUp, false);
  assert.deepEqual(validateSettings(settings).merchant, settings.merchant);
  settings.merchant.maxLossPercent = 12;
  assert.equal(defaultSettings().merchant.maxLossPercent, 0);
});

test('旧版导入补齐策略参数，保留走商及领奖的显式开关', () => {
  for (const format of ['crazywaterworld-automation', 'crazywaterword-automation']) {
    for (const enabled of [false, true]) {
      const document = exportAutomationSettings(defaultSettings());
      document.format = format;
      delete document.settings.merchant;
      document.settings.schedule.merchantTrade = enabled;
      document.settings.schedule.merchantRewards = !enabled;
      const before = structuredClone(document);
      const restored = importAutomationSettings(document);
      assert.deepEqual(restored.merchant, defaults);
      assert.equal(restored.schedule.merchantTrade, enabled);
      assert.equal(restored.schedule.merchantRewards, !enabled);
      assert.deepEqual(document, before, '迁移不得修改导入对象');
    }
  }
  const document = exportAutomationSettings(defaultSettings());
  document.settings.merchant = { autoSpeedUp: true, maxLossPercent: 5, keepPointers: 3 };
  assert.deepEqual(importAutomationSettings(document).merchant, {
    ...defaults, autoSpeedUp: true, maxLossPercent: 5, keepPointers: 3
  });
});

test('旧保存配置补默认，更新参数按账号隔离且导入导出不丢值', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-settings-'));
  const file = path.join(folder, 'settings.json');
  try {
    const old = defaultSettings();
    delete old.merchant;
    old.schedule.merchantTrade = true;
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old: { revision: 4, settings: old } } }));
    const loaded = loadAutomationSettings('old', { file });
    assert.deepEqual(loaded.settings.merchant, defaults);
    assert.equal(loaded.settings.schedule.merchantTrade, true);
    assert.equal(loaded.revision, 4);
    Object.assign(loaded.settings.merchant, {
      quoteMaxAgeSeconds: 180, estimateDiscountPercent: 25, refreshWaitSeconds: 0, liquidationMinutes: 30,
      maxLossPercent: 8, minExpectedProfit: 200, autoSpeedUp: true, speedUpMinProfit: 600, keepPointers: 4
    });
    saveAutomationSettings('old', loaded.settings, { file, revision: 4 });
    const saved = loadAutomationSettings('old', { file });
    assert.deepEqual(saved.settings, loaded.settings);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), loaded.settings);
    assert.deepEqual(loadAutomationSettings('new', { file }).settings.merchant, defaults);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('拒绝错误类型、越界参数、未知字段，合法边界与零值语义可保存', () => {
  const limits = settingsUiRules().numbers;
  for (const [key, initial] of Object.entries(defaults)) {
    if (typeof initial !== 'number') continue;
    const rule = limits['merchant.' + key];
    assert(rule, key + ' 必须提供界面边界');
    for (const value of [rule.min - 1, rule.max + 1, 1.5, String(initial), null, Infinity]) {
      const settings = defaultSettings();
      settings.merchant[key] = value;
      assert.throws(() => validateSettings(settings), error => !!error.fields?.['merchant.' + key], key);
    }
    for (const value of [rule.min, rule.max]) {
      const settings = defaultSettings();
      settings.merchant[key] = value;
      assert.equal(validateSettings(settings).merchant[key], value);
    }
  }
  for (const value of ['false', 0, null]) {
    const settings = defaultSettings();
    settings.merchant.autoSpeedUp = value;
    assert.throws(() => validateSettings(settings), error => !!error.fields?.['merchant.autoSpeedUp']);
  }
  for (const value of ['fast', '', null, 1]) {
    const settings = defaultSettings(); settings.merchant.speedUpMode = value;
    assert.throws(() => validateSettings(settings), error => !!error.fields?.['merchant.speedUpMode']);
  }
  const invalid = exportAutomationSettings(defaultSettings());
  invalid.settings.merchant.buyPointers = true;
  assert.throws(() => importAutomationSettings(invalid), /不支持的设置项/);
});

test('周期海商王界面完整接线，并说明估算、默认不亏卖和独立指针开关', () => {
  const script = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
  const definitions = script.slice(0, script.indexOf('function configGet('));
  const groups = new Function(definitions + '\nreturn configGroups;')();
  const group = groups.find(row => row.id === 'merchant-week');
  assert(group);
  const byKey = new Map(group.fields.map(field => [field.key, field]));
  for (const key of Object.keys(defaults)) assert(byKey.has('merchant.' + key), key);
  assert(byKey.has('schedule.merchantRewards'));
  assert.match(byKey.get('schedule.merchantTrade').help, /没有成员共享/);
  assert.match(byKey.get('merchant.estimateDiscountPercent').help, /估算/);
  assert.match(byKey.get('merchant.maxLossPercent').help, /不自动亏损/);
  assert.equal(byKey.get('merchant.autoSpeedUp').kind, 'switch');
  for (const key of ['speedUpMinProfit', 'keepPointers']) {
    const when = byKey.get('merchant.' + key).when;
    assert.equal(when(defaultSettings()), false);
    const enabled = defaultSettings();
    enabled.merchant.autoSpeedUp = true;
    assert.equal(when(enabled), true);
    assert.equal(when({}), undefined, '旧界面草稿缺分组时不抛错');
  }
});

console.log('海商王参数验证通过：' + passed + ' 项');
