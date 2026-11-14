// 所有远端响应为虚构 CDN 数据；临时目录、可控时钟，不使用账号或游戏网关。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceUpdater } from '../src/resource-updater.mjs';
import { activeResources, resourceUpdatePolicy } from '../src/resource-store.mjs';
import { getConfig, findConfigPack } from '../src/config.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resource-updater-'));
const envKeys = ['CW_RESOURCE_DIR', 'CW_CONFIG_PACK', 'CW_DATA_DIR'];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.CW_DATA_DIR = path.join(directory, 'accounts');
fs.mkdirSync(process.env.CW_DATA_DIR);
delete process.env.CW_CONFIG_PACK;
let sequence = 0, passed = 0;
const check = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const policy = { enabled: true, intervalMinutes: 30, appVersion: '1.14.5', disabledReason: '' };

function fixture() {
  const root = path.join(directory, 'case-' + ++sequence), calls = [], events = [];
  const f = { root, calls, events, revision: 1, release: 1, hook: null };
  const pack = () => {
    const data = { ResourceCfg: [{ id: 'GOLD', show_name: '金币' }], ItemCfg: [{ id: '汽油' }],
      ModuleOpenCfg: [{ moduleId: '世界', playerLevel: 16 }], WorldParamCfg: [{ paramName: '攻城战消耗耐久', paramValue: 100 }],
      WorldScenarioCfg: [{ id: 1 }, { id: 2 }], MarkerCfg: [{ revision: f.revision }] };
    for (const id of [1, 2]) {
      data[id + '_CityCfg'] = [{ id: 1, guildIndex: 7 }, { id: 2, guildIndex: 8 }];
      data[id + '_AttackCityConsumeCfg'] = [{ dist: 1, cost: f.revision * 0.4 }];
    }
    for (let i = 0; i < 100; i++) data['Extra' + i] = [];
    return Object.entries(data).map(([name, rows], index) => [index, name, { data: rows }]);
  };
  const map = () => [null, null, null, null, null, [[0, 'map', {
    mapInfo: { width: 2, height: 2, tileWidth: 100 * f.revision, tileHeight: 75 },
    mapData: [1, 2, 1, 2], cityInfo: { 1: { gridIdx: 0 }, 2: { gridIdx: 1 } },
  }]]];
  f.fetchImpl = async (url, options) => {
    calls.push(url); const p = new URL(url).pathname; let value;
    if (p.endsWith('version.manifest')) value = { version: '1.14.5.' + f.release,
      bundleVers: { config_cn: 'cfg' + f.revision, world_map: 'map' + f.revision } };
    else if (/config_cn\/config\./.test(p)) value = { packs: { abconfig: [0] }, uuids: ['abconfig'], versions: { import: [0, 'p' + f.revision] } };
    else if (/config_cn\/import\//.test(p)) value = pack();
    else if (/world_map\/config\./.test(p)) value = { paths: { 0: ['world_map1', 0], 1: ['world_map2', 0] },
      types: ['cc.JsonAsset'], uuids: ['abmap1', 'abmap2'], versions: { import: [0, 'm' + f.revision, 1, 'm' + f.revision] } };
    else if (/world_map\/import\//.test(p)) value = map();
    else throw new Error('未声明的网络请求：' + p);
    const custom = await f.hook?.(p, value, options);
    return custom ?? new Response(JSON.stringify(value));
  };
  f.updater = createResourceUpdater({ root, policy, fetchImpl: f.fetchImpl, onEvent: event => events.push(event) });
  return f;
}

try {
  await check('默认每30分钟检查，支持间隔、关闭及显式配置覆盖', () => {
    assert.equal(resourceUpdatePolicy({}).intervalMinutes, 30);
    assert.equal(resourceUpdatePolicy({ CW_RESOURCE_UPDATE_MINUTES: '60' }).intervalMinutes, 60);
    assert.equal(resourceUpdatePolicy({ CW_RESOURCE_AUTO_UPDATE: '0' }).enabled, false);
    assert.equal(resourceUpdatePolicy({ CW_CONFIG_PACK: 'fixed.json' }).enabled, false);
    for (const value of ['0', '-1', '1.5', 'NaN', '1441']) assert.throws(() => resourceUpdatePolicy({ CW_RESOURCE_UPDATE_MINUTES: value }));
    assert.throws(() => resourceUpdatePolicy({ CW_RESOURCE_APP_VERSION: '../other' }));
  });
  await check('无微信缓存可首次下载配置和两张地图，版本不变只取清单', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    assert.equal((await f.updater.check()).status, 'updated');
    assert.equal(f.calls.length, 6);
    const active = activeResources(), config = getConfig();
    assert.equal(findConfigPack(), active.configFile); assert.equal(config.tables.MarkerCfg.data[0].revision, 1);
    assert.equal(config.resources.generation, active.generation);
    assert.equal((await f.updater.check()).status, 'current'); assert.equal(f.calls.length, 7);
    assert.equal(f.events.filter(event => event.level === 'info').length, 1);
    await f.updater.stop();
  });
  await check('仅发布清单变化时不重复下载，更新发布版本记录', async () => {
    const f = fixture(); await f.updater.check(); const before = activeResources({ root: f.root });
    f.release = 2; assert.equal((await f.updater.check()).version, '1.14.5.2');
    const after = activeResources({ root: f.root }); assert.equal(after.generation, before.generation);
    assert.equal(after.version, '1.14.5.2'); assert.equal(f.calls.length, 7); await f.updater.stop();
  });
  await check('更新只发布完整配置地图，新旧任务的配置与地图快照各自一致', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    await f.updater.check(); const old = getConfig();
    const { loadMapAsset } = await import('../src/world.mjs');
    const oldMap = await loadMapAsset(1, old.resources); assert.equal(oldMap.tileWidth, 100);
    f.revision = f.release = 2; await f.updater.check(); const current = getConfig();
    assert.notStrictEqual(current, old); assert.equal(old.tables.MarkerCfg.data[0].revision, 1);
    assert.equal(current.tables.MarkerCfg.data[0].revision, 2);
    assert.equal((await loadMapAsset(1, current.resources)).tileWidth, 200);
    assert.equal((await loadMapAsset(1, old.resources)).tileWidth, 100);
    assert(fs.existsSync(old.resources.configFile)); await f.updater.stop();
  });
  await check('第二张地图下载失败不启用半套版本，下次检查可恢复', async () => {
    const f = fixture(); await f.updater.check(); const before = fs.readFileSync(path.join(f.root, 'active.json'));
    f.revision = f.release = 2;
    f.hook = p => p.includes('/abmap2.') ? new Response('unavailable', { status: 503 }) : undefined;
    assert.equal((await f.updater.check()).status, 'error');
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'active.json')), before);
    f.hook = null; assert.equal((await f.updater.check()).status, 'updated');
    assert.equal(activeResources({ root: f.root }).version, '1.14.5.2'); await f.updater.stop();
  });
  await check('畸形清单、路径、配置、费用及地图不被启用', async () => {
    const corruptions = [
      (p, v) => { if (p.endsWith('manifest')) v.version = '2.0.0.1'; },
      (p, v) => { if (p.endsWith('manifest')) v.bundleVers.config_cn = '../../other'; },
      (p, v) => { if (p.includes('config_cn/config.')) v.versions.import = []; },
      (p, v) => { if (p.includes('config_cn/import/')) v.length = 0; },
      (p, v) => { if (p.includes('config_cn/import/')) v.find(row => row[1] === '2_AttackCityConsumeCfg')[2].data[0].cost = -1; },
      (p, v) => { if (p.includes('world_map/config.')) delete v.paths[1]; },
      (p, v) => { if (p.includes('world_map/import/')) v[5][0][2].mapData.pop(); },
      (p, v) => { if (p.includes('world_map/import/')) delete v[5][0][2].cityInfo[2]; },
    ];
    for (const corrupt of corruptions) {
      const f = fixture(); f.hook = corrupt;
      assert.equal((await f.updater.check()).status, 'error');
      assert.equal(activeResources({ root: f.root }), null); await f.updater.stop();
    }
  });
  await check('超大响应、坏JSON及网络失败均保留原有效版本', async () => {
    for (const response of [() => new Response('{}', { headers: { 'content-length': '999999999' } }),
      () => new Response('invalid json'), () => { throw new Error('network offline'); }]) {
      const f = fixture(); await f.updater.check(); const before = activeResources({ root: f.root }).generation;
      f.hook = response; assert.equal((await f.updater.check()).status, 'error');
      assert.equal(activeResources({ root: f.root }).generation, before); await f.updater.stop();
    }
  });
  await check('同一检查合并并发请求，停止后不发布迟到的下载', async () => {
    const f = fixture(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.hook = async p => { if (p.endsWith('manifest')) await gate; };
    const one = f.updater.check(), two = f.updater.check(); assert.strictEqual(one, two);
    const stopping = f.updater.stop(); release(); await stopping;
    assert.equal((await one).status, 'stopped'); assert.equal(f.calls.length, 1);
    assert.equal(activeResources({ root: f.root }), null);
    assert.equal((await f.updater.check()).status, 'disabled');
  });
  await check('文件损坏时即使版本号未变也重新下载修复', async () => {
    const f = fixture(); await f.updater.check(); const before = activeResources({ root: f.root });
    fs.writeFileSync(before.configFile, '{}');
    assert.equal((await f.updater.check()).status, 'updated');
    assert.notEqual(activeResources({ root: f.root }).generation, before.generation); await f.updater.stop();
  });
  await check('定时器按30分钟触发，失败仍安排重试，关闭后取消定时器', async () => {
    const f = fixture(); let time = Date.UTC(2026, 10, 13), timer, canceled = 0;
    const updater = createResourceUpdater({ root: f.root, policy, fetchImpl: f.fetchImpl, now: () => time,
      setTimer: (fn, ms) => (timer = { fn, ms, unref() {} }), clearTimer: () => { canceled++; } });
    await updater.start(); assert.equal(timer.ms, 30 * 60000);
    assert.equal(updater.view().nextCheckAt, new Date(time + 30 * 60000).toISOString());
    f.revision = f.release = 2; time += timer.ms; await timer.fn();
    assert.equal(updater.view().version, '1.14.5.2');
    f.hook = () => { throw new Error('offline'); }; time += timer.ms; await timer.fn();
    assert.equal(updater.view().status, 'error'); assert(updater.view().nextCheckAt);
    await updater.stop(); assert.equal(canceled, 1); assert.equal(updater.view().nextCheckAt, null);
    await timer.fn(); assert.equal(canceled, 1); await f.updater.stop();
  });
  await check('关闭或显式指定配置时不发起任何远程请求', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root; await f.updater.check();
    const file = path.join(directory, 'override.json'); fs.writeFileSync(file, '[]'); process.env.CW_CONFIG_PACK = file;
    try {
      assert.equal(activeResources(), null); assert.equal(findConfigPack(), file);
      const updater = createResourceUpdater({ root: f.root, policy: resourceUpdatePolicy(process.env), fetchImpl: () => { throw new Error('不应下载'); } });
      await updater.start(); assert.equal((await updater.check()).status, 'disabled'); await updater.stop();
    } finally { delete process.env.CW_CONFIG_PACK; await f.updater.stop(); }
  });
  await check('控制台启动、状态接口和关闭接入更新器，无需游戏账号', async () => {
    const f = fixture(); process.env.CW_RESOURCE_DIR = f.root;
    const { createConsole } = await import('../src/server.mjs');
    const app = createConsole({ port: 0, resourceUpdater: f.updater });
    try {
      const url = await app.listen(); const response = await fetch(url + '/api/resources'); const view = await response.json();
      assert.equal(response.status, 200); assert.equal(view.enabled, true); assert.equal(view.intervalMinutes, 30);
      assert.equal(view.version, '1.14.5.1'); assert(view.lastCheckedAt); assert(view.nextCheckAt);
      assert.equal(app.sessions.size, 0);
    } finally { app.server.closeAllConnections(); await app.close(); }
    assert.equal(f.updater.view().status, 'stopped'); assert.equal(f.updater.view().nextCheckAt, null);
  });
} finally {
  for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('远程资源更新专项 ' + passed + '/' + passed + ' 通过');
