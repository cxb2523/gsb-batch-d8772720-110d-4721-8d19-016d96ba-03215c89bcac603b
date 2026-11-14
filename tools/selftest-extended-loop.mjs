// 完整挂机循环集成测试：虚构客户端、临时账本和虚拟时钟，不连接真实账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-extended-loop-'));
const originalDataDir = process.env.CW_DATA_DIR, originalNow = Date.now;
process.env.CW_DATA_DIR = folder;
const base = Date.UTC(2026, 10, 14, 4);
let wall = base, serial = 0;
Date.now = () => wall;
const results = [];

try {
  // accounts.mjs 的数据路径在加载时确定，因此必须先隔离再导入。
  const { runLoop } = await import('../src/loop.mjs');
  const { createUsageLedger } = await import('../src/automation-settings.mjs');
  const { siliconFixture, siliconSettings } = await import('./fixtures/silicon.mjs');

  function integration({ rounds = 1, mainEveryMs = 3600000 } = {}) {
    const fixture = siliconFixture(), settings = siliconSettings();
    for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
    Object.assign(settings.loop, { world: false, tasks: false, dailies: false, heroes: false, everySeconds: mainEveryMs / 1000 });
    settings.resident.rewards = false; settings.dailies.enabled = false; settings.progression.enabled = false;
    const ledger = createUsageLedger('虚构扩展循环账号-' + (++serial), { file: path.join(folder, serial + '.json') });
    const stop = { aborted: false }, sleeps = [], reports = [], violations = [], protocolCalls = [], protocolErrors = [];
    let currentSettings = settings, scheduled = 0, active = false, inFlight = 0, maxInFlight = 0;
    let queue = Promise.resolve(), sleepHook = null, reportHook = null;
    const schedule = work => {
      const job = queue.then(async () => {
        if (active) violations.push('同账号队列任务出现重入');
        assert.equal(active, false, '同账号不能同时执行两个队列任务');
        active = true; scheduled++;
        try { return await work(); } finally { active = false; }
      });
      queue = job.catch(() => {});
      return job;
    };
    for (const method of ['request', 'sendWatch']) {
      const original = fixture.client[method];
      fixture.client[method] = async (...args) => {
        if (!active) violations.push(args[0] + '绕过账号队列');
        if (inFlight) violations.push(args[0] + '与写协议并发');
        assert.equal(active, true, '协议必须在账号串行队列中执行');
        assert.equal(inFlight, 0, '写协议期间不能并发其他操作');
        if (method === 'sendWatch') { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); }
        protocolCalls.push({ method, name: args[0], at: wall });
        try { return await original(...args); }
        catch (error) { protocolErrors.push({ name: args[0], message: error.message }); throw error; }
        finally { if (method === 'sendWatch') inFlight--; }
      };
    }
    const run = async () => {
      const result = await runLoop(fixture.client, fixture.protocol, {
        config: fixture.config, player: fixture.player, rounds, everyMs: mainEveryMs,
        getEveryMs: () => mainEveryMs, allowMutate: true, isEnabled: () => false,
        getSettings: () => currentSettings, usageLedger: ledger, stop, schedule,
        sleep: async ms => {
          assert(ms > 0, '不能零毫秒忙轮询');
          sleeps.push(ms); assert(sleeps.length < 100, '等待必须有界，不能忙轮询');
          if (sleepHook) await sleepHook(ms, sleeps.length); else wall += ms;
        },
        onStep: row => { reports.push(row); reportHook?.(row); }
      });
      await queue;
      return result;
    };
    const clean = () => {
      assert.deepEqual(violations, [], '不能绕开同账号协议队列');
      assert.deepEqual(protocolErrors, [], '关闭其他模块时不能读取它们的协议，不能把协议错误吞入备注');
      assert.deepEqual(reports.filter(row => row.error && !row.skipped), [], '挂机接线不能吞掉协议错误');
      assert.equal(fixture.client.listenerCount('automationSettingsChanged'), 0, '退出循环应移除配置监听');
    };
    return Object.assign(fixture, { settings, ledger, stop, sleeps, reports, protocolCalls, run, schedule, clean,
      getSettings: () => currentSettings, setSettings: value => { currentSettings = value; },
      scheduled: () => scheduled, isScheduled: () => active, maxInFlight: () => maxInFlight,
      sleepHook: fn => { sleepHook = fn; }, reportHook: fn => { reportHook = fn; } });
  }
  const test = async (name, run) => {
    wall = base;
    try { await run(); results.push(true); console.log('通过：' + name); }
    catch (error) { results.push(false); console.error('失败：' + name + '\n' + error.stack); }
  };
  const dispatches = f => f.client.writes.filter(row => row.name === 'ChipMineSendFleetRequest');
  const fillHighMine = f => { for (let index = 0; index < 3; index++) f.enemy(index, '占位船长' + index, 100000); };
  const stopAfterDispatch = (f, count = 1) => f.reportHook(() => { if (dispatches(f).length >= count) f.stop.aborted = true; });

  await test('原生任务全关时三舰队仍由完整循环独立派遣，预算落盘', async () => {
    const f = integration();
    for (const fleet of f.settings.silicon.fleets) fleet.enabled = true;
    assert(Object.values(f.settings.schedule).every(value => value === false));
    await f.run();
    assert.deepEqual(dispatches(f).map(row => row.body.fleetId), ['1远征船', '2远征船', '3远征船']);
    assert.equal(new Set(dispatches(f).map(row => row.body.gridId + ':' + row.body.index)).size, 3);
    assert.equal(f.ledger.snapshot().counters.siliconPetrol, 1500);
    const persisted = createUsageLedger('虚构扩展循环账号-' + serial, { file: path.join(folder, serial + '.json') });
    assert.equal(persisted.snapshot().counters.siliconPetrol, 1500, '读取磁盘账本仍有已确认消费');
    assert.equal(f.maxInFlight(), 1); f.clean();
  });
  await test('关闭硅矿总开关保留舰队配置但不读写硅矿', async () => {
    const f = integration(); f.settings.silicon.enabled = false;
    for (const fleet of f.settings.silicon.fleets) fleet.enabled = true;
    await f.run();
    assert.equal(f.client.reads.length, 0); assert.equal(f.client.writes.length, 0); f.clean();
  });
  await test('只开总开关而三支舰队均关闭时没有派遣', async () => {
    const f = integration(); for (const fleet of f.settings.silicon.fleets) fleet.enabled = false;
    await f.run();
    assert.equal(f.client.writes.length, 0); assert.equal(f.ledger.snapshot().counters.siliconPetrol ?? 0, 0); f.clean();
  });
  await test('一小时主循环之间按十分钟硅矿周期回读并派遣', async () => {
    const f = integration({ rounds: 2 }); fillHighMine(f); stopAfterDispatch(f);
    f.sleepHook(ms => { wall += ms; f.state.positions[5000] = f.state.positions[5000].filter(row => row.index !== 0); });
    await f.run();
    assert.deepEqual(f.sleeps, [600000]); assert.equal(wall - base, 600000);
    assert.equal(dispatches(f).length, 1); assert(f.scheduled() >= 2); f.clean();
  });
  await test('有效追击配置使用两分钟独立检查周期', async () => {
    const f = integration({ rounds: 2 }); fillHighMine(f); stopAfterDispatch(f);
    Object.assign(f.settings.silicon.fleets[0], { pursuit: true, emptyOnly: false });
    f.sleepHook(ms => { wall += ms; f.state.positions[5000] = []; });
    await f.run();
    assert.deepEqual(f.sleeps, [120000]); assert.equal(dispatches(f).length, 1); f.clean();
  });
  await test('保存新配置提前唤醒休眠中的关闭模块，不等下一主轮', async () => {
    const f = integration({ rounds: 2 }); f.settings.silicon.enabled = false; stopAfterDispatch(f);
    f.sleepHook(() => {
      wall += 1000; assert.equal(f.isScheduled(), false);
      const next = structuredClone(f.getSettings()); next.silicon.enabled = true; f.setSettings(next);
      const before = f.protocolCalls.length;
      f.client.emit('automationSettingsChanged');
      assert.equal(f.protocolCalls.length, before, '保存事件只唤醒调度，不直接执行游戏协议');
    });
    await f.run();
    assert.equal(f.sleeps[0], 3600000); assert.equal(wall - base, 1000);
    assert.equal(dispatches(f).length, 1); f.clean();
  });
  await test('矿位推送风暴提前唤醒，回调不读写且不重复派遣', async () => {
    const f = integration({ rounds: 2 }); fillHighMine(f); stopAfterDispatch(f);
    f.sleepHook(() => {
      wall += 1000; f.state.positions[5000] = [];
      const before = f.protocolCalls.length;
      for (let index = 0; index < 30; index++) f.client.emit('message', { name: 'SCChipMine', body: { gridId: 5000 } });
      assert.equal(f.protocolCalls.length, before, '服务端推送不能直接发送协议');
    });
    await f.run();
    assert.equal(wall - base, 1000); assert.equal(dispatches(f).length, 1);
    const before = f.protocolCalls.length;
    f.client.emit('message', { name: 'SCChipMine', body: { gridId: 5000 } });
    await Promise.resolve(); assert.equal(f.protocolCalls.length, before, '停止挂机后推送不能执行任务'); f.clean();
  });
  await test('等待期间关闭总开关和随后推送都不能继续硅矿读取或派遣', async () => {
    const f = integration({ rounds: 2 }); fillHighMine(f); let readsAtDisable;
    f.sleepHook((ms, index) => {
      if (index === 1) {
        wall += 1000; readsAtDisable = f.client.reads.length;
        const next = structuredClone(f.getSettings()); next.silicon.enabled = false; f.setSettings(next);
        f.client.emit('automationSettingsChanged'); f.state.positions[5000] = [];
        f.client.emit('message', { name: 'SCChipMine', body: { gridId: 5000 } });
      } else wall += ms;
    });
    await f.run();
    assert.equal(f.client.reads.length, readsAtDisable); assert.equal(dispatches(f).length, 0); f.clean();
  });
  await test('最终回读期间关闭总开关阻止已排入队列的派遣', async () => {
    const f = integration(); let lists = 0;
    f.beforeRead = name => {
      if (name === 'ChipMineListRequest' && ++lists === 2) {
        const next = structuredClone(f.getSettings()); next.silicon.enabled = false; f.setSettings(next);
        f.client.emit('automationSettingsChanged');
      }
    };
    await f.run();
    assert(lists >= 2); assert.equal(dispatches(f).length, 0);
    assert.equal(f.ledger.snapshot().counters.siliconPetrol ?? 0, 0); f.clean();
  });
  await test('三舰队写入期间连续推送仍串行，后续复查不会重复发送', async () => {
    const f = integration({ rounds: 2, mainEveryMs: 10000 });
    for (const fleet of f.settings.silicon.fleets) fleet.enabled = true;
    f.afterWrite = () => {
      const before = f.protocolCalls.length;
      for (let index = 0; index < 30; index++) f.client.emit('message', { name: 'SCMyFleetUpdate', body: {} });
      assert.equal(f.protocolCalls.length, before, '在途推送只能安排后续队列检查');
    };
    await f.run();
    assert.equal(dispatches(f).length, 3); assert.equal(f.maxInFlight(), 1);
    assert.equal(f.ledger.snapshot().counters.siliconPetrol, 1500); assert(f.scheduled() >= 2); f.clean();
  });
  await test('挂机写入期间进入同账号的手动操作等待本轮结束，不并发消费', async () => {
    const f = integration(); f.settings.silicon.fleets[1].enabled = true;
    f.state.fleets[2].durability = 1999;
    let manualJob;
    f.afterWrite = name => {
      if (name === 'ChipMineSendFleetRequest' && !manualJob) {
        manualJob = f.schedule(() => f.client.sendWatch('RepairFleetRequest', { buildingId: '3远征船' }));
        for (let index = 0; index < 20; index++) f.client.emit('message', { name: 'SCMyFleetUpdate', body: {} });
      }
    };
    await f.run(); await manualJob;
    assert.deepEqual(f.client.writes.map(row => row.name), ['ChipMineSendFleetRequest', 'ChipMineSendFleetRequest', 'RepairFleetRequest']);
    assert.equal(f.state.fleets[2].state, 4); assert.equal(f.maxInFlight(), 1);
    assert.equal(f.scheduled(), 2, '手动任务在挂机整轮之后单独进入同一队列'); f.clean();
  });
  await test('派遣结果未知跨主轮仍保留预算和矿位，不因空闲状态重发', async () => {
    const f = integration({ rounds: 2, mainEveryMs: 600000 }); f.unknown = true;
    await f.run();
    assert.equal(dispatches(f).length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
    assert.equal(f.ledger.pendingCounters().siliconPetrol, 500); f.clean();
  });

  console.log('扩展挂机循环测试：' + results.filter(Boolean).length + '/' + results.length + ' 项通过');
  if (results.some(result => !result)) process.exitCode = 1;
} finally {
  Date.now = originalNow;
  if (originalDataDir === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalDataDir;
  fs.rmSync(folder, { recursive: true, force: true });
}
