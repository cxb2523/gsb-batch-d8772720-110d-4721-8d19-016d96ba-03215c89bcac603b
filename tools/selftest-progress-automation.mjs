import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { automationTasks, taskSettings } from '../src/automation.mjs';
import { runLoop } from '../src/loop.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';
import { surveyDailies } from '../src/dailies.mjs';
import { PAGE } from '../src/page.mjs';

const keys = ['guildOrders', 'radarAuto', 'radarRepair', 'equipmentCollect', 'equipmentCraft',
  'museumCollect', 'museumExplore', 'petCollect', 'petBreed'];
const migrated = taskSettings({ mail: true });
for (const key of keys) {
  assert.equal(automationTasks.find(task => task.key === key)?.initial, false);
  assert.equal(migrated[key], false, 'existing accounts must opt in to new spending');
  const control = [...PAGE.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(button => button.includes('data-auto-task="schedule.' + key + '"'));
  assert.ok(control?.includes('role="switch"'), 'the saved schedule control must be a real rendered switch');
  assert.ok(!PAGE.includes('data-legacy="true"'), 'compatibility controls must be real switches');
}

function fixture() {
  const client = new EventEmitter();
  client.connected = true;
  client.request = async name => assert.fail('unexpected game request: ' + name);
  client.sendWatch = async name => assert.fail('unexpected game mutation: ' + name);
  let queued = false;
  const reports = [];
  const options = {
    allowMutate: true, rounds: 1,
    player: { level: 1, playerId: '1', guildId: 0, worldId: 2001001001 },
    config: { tables: {
      ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 16 }, { moduleId: '联盟情报', playerLevel: 18 }] },
      BuildingUnlockCfg: { data: [
        { buildingType: '装备厂', buildingId: '1装备厂', playerLevel: 17 },
        { buildingType: '博物馆', buildingId: '1博物馆', playerLevel: 28 },
        { buildingType: '宠物培育室', buildingId: '1宠物培育室', playerLevel: 23 },
      ] },
      MuseumExpeditionTeamCfg: { data: [{ teamCount: 1, playerLevel: 28 }] },
    } },
    async schedule(work) {
      assert.equal(queued, false);
      queued = true;
      try { await work(); } finally { queued = false; }
    },
    onStep(entry) { assert.equal(queued, true, 'new services must run inside the account operation queue'); reports.push(entry); },
  };
  return { client, options, reports };
}

// With all new switches off, even a single query is unexpected.
{
  const f = fixture();
  await runLoop(f.client, {}, { ...f.options, isEnabled: () => false });
  assert.deepEqual(f.reports, []);
}

// All services reach their own unlock checks; none assumes an unavailable
// feature is usable. Independent settings stay visible in the loop history.
{
  const f = fixture();
  const result = await runLoop(f.client, {}, { ...f.options, isEnabled: key => keys.includes(key) });
  assert.deepEqual(new Set(f.reports.map(entry => entry.key)), new Set(keys));
  assert.ok(f.reports.every(entry => entry.skipped && entry.reason));
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].world.results.length, 4);
  assert.equal(result.history[0].dailies.results.length, 5);
}

// Pausing while an account operation is queued prevents all new services.
{
  const f = fixture(), stop = { aborted: false };
  await runLoop(f.client, {}, { ...f.options, stop, isEnabled: key => keys.includes(key),
    async schedule(work) { stop.aborted = true; await work(); } });
  assert.deepEqual(f.reports, []);
}

// Guild membership changes invalidate only that account's relevant cooldowns.
{
  const a = fixture().client, b = fixture().client;
  const sa = rewardSchedule(a), sb = rewardSchedule(b);
  for (const key of keys) { sa.defer(key, sa.now() + 300); sb.defer(key, sb.now() + 300); }
  a.emit('message', { name: 'SCJoinGuild', body: {} });
  for (const key of ['guildOrders', 'radarAuto', 'radarRepair']) {
    assert.equal(sa.due(key), true);
    assert.equal(sb.due(key), false);
  }
  assert.equal(sa.due('equipmentCraft'), false);
}

// The daily page points to the implemented flow instead of claiming that the
// server rejected a feature whose driver never evaluated the server response.
{
  const client = { async request(name) {
    if (name === 'DailyTaskInfoRequest') return { dailyTask: [1011, 1012, 1015, 1016].map(id => ({ id, progress: 0, targetProgress: 1 })) };
    assert.fail('unexpected daily probe: ' + name);
  } };
  const view = await surveyDailies(client, {}, { idle: true, probeGift: false });
  for (const row of view.tasks.filter(row => [1011, 1012].includes(row.task.id))) {
    assert.equal(row.status, 'waiting');
    assert.match(row.reason, /挂机 → 联盟/);
  }
  assert.equal(view.tasks.find(row => row.task.id === 1015).status, 'waiting');
  assert.match(view.tasks.find(row => row.task.id === 1015).reason, /城战接续/);
  assert.equal(view.tasks.find(row => row.task.id === 1016).status, 'waiting');
  assert.match(view.tasks.find(row => row.task.id === 1016).reason, /挂机 → 博物馆/);
}

console.log('Progression automation integration self-test passed');
