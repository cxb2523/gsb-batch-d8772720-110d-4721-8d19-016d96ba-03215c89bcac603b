// 隔离配置缓存与同步入口，不读取账号、不连接游戏、不改动本机缓存。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-config-cache-'));
const home = path.join(directory, 'home');
const cache = path.join(home, 'AppData/Roaming/Tencent/xwechat/radium/users/test/applet/local/wx2ea52a972ea18e5e/usr/gamecaches/config_cn');
const local = path.join(directory, 'work/cdn/config_cn_pack.json');
const originalHome = os.homedir, originalOverride = process.env.CW_CONFIG_PACK, originalResourceDir = process.env.CW_RESOURCE_DIR;
const results = [];
const pack = (marker, size = 1_010_000) => JSON.stringify([
  ...Array.from({ length: 100 }, (_, i) => [i, 'Table' + i, { data: [] }]),
  [101, 'MarkerCfg', { data: [{ marker }] }], 'x'.repeat(size),
]);
const write = (file, marker, time, size) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pack(marker, size));
  fs.utimesSync(file, time, time);
  return file;
};
const check = async (name, run) => {
  try { await run(); results.push(true); console.log('通过：' + name); }
  catch (error) { results.push(false); console.error('失败：' + name + '\n' + error.stack); }
};

try {
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'tools'), { recursive: true });
  for (const name of ['src/config.mjs', 'src/resource-store.mjs', 'tools/sync-config.mjs']) {
    fs.copyFileSync(new URL('../' + name, import.meta.url), path.join(directory, name));
  }
  os.homedir = () => home;
  process.env.CW_RESOURCE_DIR = path.join(directory, 'work/cdn/resources');
  delete process.env.CW_CONFIG_PACK;
  const { findConfigPack, loadTables } = await import(pathToFileURL(path.join(directory, 'src/config.mjs')));
  const old = write(path.join(cache, '1000.json'), 'old', 1000, 1_100_000);
  const newer = write(path.join(cache, '2000.json'), 'new', 2000, 1_100_000);
  await check('同样大小的微信缓存选择较新的包', () => {
    assert.equal(findConfigPack(), newer);
  });
  await check('新版包变小仍优先，不按大小回退到旧配置', () => {
    write(newer, 'new', 2000);
    assert.equal(findConfigPack(), newer);
  });
  await check('旧同步副本不遮蔽更新的微信缓存', () => {
    write(local, 'synced-old', 1500);
    assert.equal(findConfigPack(), newer);
  });
  await check('较新的同步副本保留优先级，显式覆盖仍优先', () => {
    write(local, 'synced-new', 3000);
    assert.equal(findConfigPack(), local);
    process.env.CW_CONFIG_PACK = old;
    try { assert.equal(findConfigPack(), old); }
    finally { delete process.env.CW_CONFIG_PACK; }
  });
  await check('小型bundle描述文件不冒充配置包', () => {
    const descriptor = path.join(cache, 'descriptor.json');
    fs.writeFileSync(descriptor, '{}'); fs.utimesSync(descriptor, 5000, 5000);
    assert.equal(findConfigPack(), local);
  });
  const sync = args => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import os from 'node:os'; os.homedir = () => ${JSON.stringify(home)}; await import(${JSON.stringify(pathToFileURL(path.join(directory, 'tools/sync-config.mjs')).href)});`,
    ...args], { encoding: 'utf8', env: { ...process.env } });
  await check('默认同步从新缓存更新旧副本，并保留源修改时间', () => {
    write(local, 'synced-old', 1500);
    const result = sync([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(loadTables(local).MarkerCfg.data[0].marker, 'new');
    assert.equal(fs.statSync(local).mtimeMs, fs.statSync(newer).mtimeMs);
  });
  await check('重复同步同一路径不自复制或伪造更新日期', () => {
    process.env.CW_CONFIG_PACK = local;
    const before = fs.statSync(local).mtimeMs, contents = fs.readFileSync(local);
    try {
      const result = sync([]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(local), contents);
      assert.equal(fs.statSync(local).mtimeMs, before);
    } finally { delete process.env.CW_CONFIG_PACK; }
  });
  await check('缓存清理后仍可读取同步副本，无任何来源时返回空', () => {
    fs.rmSync(path.join(home, 'AppData'), { recursive: true });
    assert.equal(findConfigPack(), local);
    fs.rmSync(local);
    assert.equal(findConfigPack(), null);
  });
} finally {
  os.homedir = originalHome;
  if (originalOverride === undefined) delete process.env.CW_CONFIG_PACK;
  else process.env.CW_CONFIG_PACK = originalOverride;
  if (originalResourceDir === undefined) delete process.env.CW_RESOURCE_DIR;
  else process.env.CW_RESOURCE_DIR = originalResourceDir;
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(results.filter(Boolean).length + '/' + results.length + ' 通过');
if (results.some(passed => !passed)) process.exitCode = 1;
