import os from 'node:os';
// 藏品养成专项：虚构账号与库存，真实协议编解码，不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateSettings, importAutomationSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { readAntiqueUpgrade, planAntiqueUpgrade, runAntiqueUpgrade } from '../src/antique-upgrade.mjs';
import { antiqueFixture, antiqueConfig, antiqueSettings } from './fixtures/antique.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-antique-test-'));
let sequence = 0;
const ledger = () => createUsageLedger('藏品验证账号', { file: path.join(directory, 'usage-' + (++sequence) + '.json') });
const player = { playerId: '9007199254740001', worldId: 1001001, level: 40 };
const read = f => readAntiqueUpgrade(f.client, f.protocol, f.config, player);
const plan = async (f, s, usage = ledger()) => planAntiqueUpgrade(await read(f), f.config, s, { usage: usage.snapshot(), keys: usage.keyRecords() });
const run = (f, s, usage = ledger()) => runAntiqueUpgrade(f.client, f.protocol, f.config, player, { getSettings: () => s, ledger: usage });
const checks = [];
const check = async (name, work) => {
  try { await work(); checks.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
};

await check('设置默认关闭、导入兼容和动作/品质校验', () => {
  const old = validateSettings(antiqueSettings());
  delete old.antique;
  const imported = importAutomationSettings({ format: 'crazywaterword-automation', version: 1, settings: old });
  assert.equal(imported.antique.enabled, false);
  assert.equal(imported.antique.dailyGoldLimit, 20000);
  const idle = antiqueSettings(); idle.antique.enabled = true; idle.antique.activate = false; idle.antique.star = false; idle.antique.master = false; idle.antique.suit = false;
  assert.throws(() => validateSettings(idle), /至少开启/);
  const bad = antiqueSettings(); bad.antique.activateQualities = [];
  assert.throws(() => validateSettings(bad), /激活/);
  const ok = antiqueSettings(); assert.doesNotThrow(() => validateSettings(ok));
  for (const n of [-1, 26, 1.5, '25']) { const s = antiqueSettings(); s.antique.targetStar = n; assert.throws(() => validateSettings(s)); }
});

await check('按碎片激活藏品并回读确认，释放防重键', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { master: false, suit: false, star: false });
  f.client.setItem('蓝藏1碎片', 10);
  const before = await plan(f, s, u);
  assert.equal(before.actions.length, 1); assert.equal(before.actions[0].kind, 'antiqueActivate');
  const result = await run(f, s, u);
  assert.equal(result.results[0]?.status, 'confirmed');
  assert.deepEqual(f.client.writes.map(row => row.name), ['ActivateAntiqueRequest']);
  assert(f.state.antiques.some(row => row.id === '蓝藏1'));
  assert.equal(u.hasKey(before.actions[0].uniqueKey), false);
  assert.equal(await plan(f, s, u).then(p => p.actions.length), 0);
});

await check('升星按颜色碎片扣除，万能碎片只在允许时补足，目标星级生效', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { activate: false, master: false, suit: false, star: true, starQualities: ['BLUE'], universal: true, targetStar: 2 });
  f.state.antiques = [{ id: '蓝藏1', star: 0 }];
  f.client.setItem('蓝藏万能碎片', 10);
  let p = await plan(f, s, u); assert.equal(p.actions.length, 1); assert.equal(p.actions[0].targetStar, 1);
  assert.deepEqual(p.actions[0].costs, [{ id: '蓝藏万能碎片', num: 2 }]);
  let result = await run(f, s, u); assert.equal(result.results[0]?.status, 'confirmed'); assert.equal(f.state.antiques[0].star, 1);
  p = await plan(f, s, u); assert.equal(p.actions[0]?.targetStar, 2); assert.deepEqual(p.actions[0].costs, [{ id: '蓝藏万能碎片', num: 4 }]);
  result = await run(f, s, u); assert.equal(result.results[0]?.status, 'confirmed'); assert.equal(f.state.antiques[0].star, 2);
  p = await plan(f, s, u); assert.equal(p.actions.length, 0);
  assert(f.client.writes.every(row => row.name === 'AntiqueStarUpRequest' && row.body.universal === true));
});

await check('结果未知不重发，服务器状态出现后自动核销', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { master: false, suit: false, star: false });
  f.client.setItem('蓝藏1碎片', 10); f.client.unknown = true;
  const p = await plan(f, s, u); const key = p.actions[0].uniqueKey;
  let result = await run(f, s, u);
  assert.equal(result.results[0]?.status, 'unknown'); assert.equal(u.hasKey(key), true);
  f.client.unknown = false;
  await run(f, s, u); assert.equal(f.client.writes.length, 1, '未知记录存在时不能再次激活');
  f.state.antiques.push({ id: '蓝藏1', star: 0 });
  result = await run(f, s, u);
  assert.equal(u.hasKey(key), false); assert.equal(f.client.writes.length, 1);
  assert(result.results.some(row => row.status === 'completed'));
});

await check('明确拒绝撤销记录，冷却期内不重复发送', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { master: false, suit: false, star: false });
  f.client.setItem('蓝藏1碎片', 10); f.client.reject = true;
  const p = await plan(f, s, u); const key = p.actions[0].uniqueKey;
  const result = await run(f, s, u);
  assert.equal(result.results[0]?.status, 'rejected'); assert.equal(u.hasKey(key), false);
  await run(f, s, u); assert.equal(f.client.writes.length, 1);
});

await check('大师等级先满足总星级和徽章，再提高套装等级上限并扣除金币经验', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { activate: false, star: false, master: true, suit: true, suitQualities: ['BLUE'], maxActions: 3 });
  f.state.antiques = [{ id: '蓝藏1', star: 1 }, { id: '蓝藏2', star: 1 }];
  f.client.setItem('蓝藏品经验', 100); f.client.setItem('藏品大师经验', 100);
  const p = await plan(f, s, u);
  assert.deepEqual(p.actions.map(row => row.kind), ['antiqueMaster', 'antiqueSuit', 'antiqueSuit']);
  assert.deepEqual(p.actions.map(row => row.targetLevel), [2, 1, 2]);
  const result = await run(f, s, u);
  assert.deepEqual(result.results.map(row => row.status), ['confirmed', 'confirmed', 'confirmed']);
  assert.equal(f.state.masterLv, 2); assert.deepEqual(f.state.suits, [{ id: 1001, level: 2 }]);
  assert.equal(f.state.gold, 950); assert.equal(f.state.items.get('蓝藏品经验'), 90); assert.equal(f.state.items.get('藏品大师经验'), 95);
  assert.equal(u.snapshot().counters.antiqueGold, 50); assert.equal(u.snapshot().counters.antiqueGold, u.confirmedCounters().antiqueGold);
});

await check('大师等级为0时仍可激活已集齐的套装，但不继续升级', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { activate: false, star: false, master: false, suit: true, suitQualities: ['BLUE'] });
  f.state.masterLv = 0; f.state.antiques = [{ id: '蓝藏1', star: 0 }, { id: '蓝藏2', star: 0 }];
  const p = await plan(f, s, u);
  assert.deepEqual(p.actions.map(row => row.kind), ['antiqueSuit']); assert.equal(p.actions[0].targetLevel, 1);
});
await check('红色套装需至少两件已激活，套装日金币预算限制后续等级', async () => {
  const f = antiqueFixture(), s = antiqueSettings(), u = ledger();
  Object.assign(s.antique, { activate: false, star: false, master: false, suit: true, suitQualities: ['RED'] });
  f.state.antiques = [{ id: '红藏1', star: 0 }]; f.client.setItem('红藏品经验', 100);
  let p = await plan(f, s, u); assert.equal(p.actions.length, 0); assert.match(p.notes.join(' '), /需要 2 件/);
  f.state.antiques.push({ id: '红藏2', star: 0 });
  p = await plan(f, s, u); assert.equal(p.actions[0]?.targetLevel, 1);
  f.state.suits = [{ id: 4001, level: 1 }]; s.antique.dailyGoldLimit = 99;
  p = await plan(f, s, u); assert.equal(p.actions.length, 0); assert.match(p.notes.join(' '), /日预算/);
  s.antique.dailyGoldLimit = 0; p = await plan(f, s, u); assert.equal(p.actions[0]?.targetLevel, 2);
  f.state.suits[0].level = 2;
  p = await plan(f, s, u); assert.equal(p.actions.length, 0);
});

const report = path.join(directory, 'result.json');
fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), checks }, null, 2));
console.log(checks.filter(row => row.passed).length + '/' + checks.length + ' 通过；' + report);
if (checks.some(row => !row.passed)) process.exitCode = 1;
