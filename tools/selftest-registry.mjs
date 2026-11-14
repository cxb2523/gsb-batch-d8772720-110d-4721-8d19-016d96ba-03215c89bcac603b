import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'HKCU\\Software\\CwProxySelfTest';
const BACKUP = path.join(os.tmpdir(), 'cw-proxy-backup-selftest.json');
process.env.CW_REG_KEY = KEY;
process.env.CW_PROXY_BACKUP = BACKUP;

const { readCurrent, setProxy, restore, isProxyOn } = await import('./proxy-settings.mjs');

function reg(args) {
  try {
    return execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (error) {
    return error.stdout?.toString() ?? '';
  }
}

const seed = {
  ProxyEnable: '0x0',
  ProxyServer: '127.0.0.1:7890',
  ProxyOverride: '<local>;*.qq.com;*.weixin.qq.com',
};

reg(['delete', KEY, '/f']);
fs.rmSync(BACKUP, { force: true });
for (const [name, value] of Object.entries(seed)) {
  reg(['add', KEY, '/v', name, '/t', name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ', '/d', value, '/f']);
}

const original = readCurrent();
assert.deepEqual(original, seed, 'seed read back');
assert.equal(isProxyOn(), false, 'seeded proxy is off');

const changed = setProxy('127.0.0.1', 17321);
assert.equal(changed.ProxyEnable, '0x1', 'proxy enabled');
assert.equal(changed.ProxyServer, '127.0.0.1:17321', 'proxy server set');
assert.equal(changed.ProxyOverride, '<local>', 'proxy override narrowed');
assert.equal(isProxyOn(), true, 'isProxyOn sees it enabled');

const restored = restore();
assert.deepEqual(restored, seed, 'restore reproduces the original values exactly');
assert.equal(isProxyOn(), false, 'proxy disabled again');
assert.deepEqual(readCurrent(), seed, 'second read confirms stability');

// A value that never existed must be removed again, not left behind.
reg(['delete', KEY, '/v', 'ProxyOverride', '/f']);
fs.rmSync(BACKUP, { force: true });
const withoutOverride = readCurrent();
assert.equal(withoutOverride.ProxyOverride, undefined, 'override absent in seed');
setProxy('127.0.0.1', 17321);
const afterRestore = restore();
assert.equal(afterRestore.ProxyOverride, undefined, 'override removed on restore');

reg(['delete', KEY, '/f']);
fs.rmSync(BACKUP, { force: true });
console.log('registry selftest ok: backup/set/restore round-trip, missing values removed');
