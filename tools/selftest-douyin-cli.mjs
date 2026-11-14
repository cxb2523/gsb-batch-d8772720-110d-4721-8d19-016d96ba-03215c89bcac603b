// 所有系统操作、文件写入和代理监听均替换为内存依赖。
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_HOST, main, parseOptions } from './capture-douyin-login.mjs';

const HOST = 'gate.example';
const SECRET = 'private-test-token';
const FIXED_DATE = new Date('2026-10-19T01:02:03.004Z');
const DATA_DIR = path.resolve('data', 'douyin-cli-test-in-memory');
const SAMPLE_PATH = path.join(DATA_DIR, 'douyin-login-sample-2026-10-19T01-02-03-004Z.json');

async function runCase({
  mode = 'capture', trustedBefore = false, args = ['--yes', '--host', HOST],
  tty = false, accepted = false, existingSample = false,
} = {}) {
  const events = [];
  const logs = [];
  const writes = [];
  const runtime = new EventEmitter();
  Object.assign(runtime, { platform: 'win32', stdin: { isTTY: tty }, stdout: {}, env: {} });
  let trusted = trustedBefore;
  const originalProxy = mode === 'stale-proxy'
    ? { ProxyEnable: '0x1', ProxyServer: 'http=localhost:17322;https=[::1]:17322' }
    : { ProxyEnable: '0x0', ProxyServer: 'original.proxy:9000' };
  let activeProxy = { ...originalProxy };
  const previousBackup = { ProxyEnable: '0x0', ProxyServer: 'recoverable.proxy:9001' };
  let savedProxy = { ...previousBackup };
  const files = new Map([
    [path.join(DATA_DIR, 'credentials.json'), '{"keep":"credentials"}'],
    [path.join(DATA_DIR, 'accounts.json'), '{"keep":"accounts"}'],
  ]);
  if (existingSample) files.set(SAMPLE_PATH, 'existing sample');
  const initialFiles = new Map(files);
  const code = await main(args, {
    acquireLock: async () => {
      events.push('lock');
      if (mode === 'busy') throw new Error('busy');
      return () => events.push('unlock');
    },
    process: runtime,
    io: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    dataDir: DATA_DIR,
    now: () => FIXED_DATE,
    confirm: async () => { events.push('confirm'); return accepted; },
    fs: {
      mkdirSync() { events.push('mkdir'); },
      writeFileSync(filename, text, options) {
        assert.equal(options.flag, 'wx', 'sample must never overwrite an existing file');
        if (files.has(filename)) throw new Error('EEXIST');
        events.push('write');
        writes.push({ filename, text, options });
        files.set(filename, text);
      },
    },
    ca: {
      isInstalled() { return trusted; },
      initCa() { events.push('init'); return { created: false }; },
      prepareLeaf(host) {
        assert.equal(host, HOST);
        if (mode === 'missing-leaf') throw new Error('missing leaf.key');
      },
      installCa() {
        events.push('install');
        trusted = true;
        if (mode === 'install-error') throw new Error(SECRET);
      },
      uninstallCa() { events.push('uninstall'); trusted = false; },
    },
    proxySettings: {
      backup() {
        events.push('backup');
        if (mode === 'backup-error') throw new Error(SECRET);
        savedProxy = { ...activeProxy };
        return savedProxy;
      },
      setProxy(host, port) {
        events.push('set');
        activeProxy.ProxyEnable = '0x1';
        if (mode === 'set-error') throw new Error(SECRET);
        activeProxy = { ProxyEnable: '0x1', ProxyServer: `${host}:${port}`, ProxyOverride: '<local>' };
        if (mode === 'overwritten-backup') {
          // Another capture replaces the shared backup file while this run is active.
          savedProxy = { ProxyEnable: '0x1', ProxyServer: 'other.capture.proxy:9100' };
        }
      },
      readCurrent() { return { ...activeProxy }; },
      restore(snapshot, names) {
        events.push('restore');
        assert.deepEqual(snapshot, originalProxy, 'must restore the snapshot owned by this capture');
        if (mode === 'restore-error') throw new Error(SECRET);
        for (const name of names) {
          if (name in snapshot) activeProxy[name] = snapshot[name];
          else delete activeProxy[name];
        }
      },
    },
    createProxy(options) {
      events.push('create');
      assert.equal(options.rawLogin, true);
      assert.deepEqual(options.interceptHosts, [HOST]);
      assert.deepEqual(options.interceptPorts, [443]);
      assert.equal(options.onFrame, undefined, 'must not persist other account traffic');
      return {
        async listen() {
          events.push('listen');
          if (mode === 'busy') assert.deepEqual(result.events, ['lock']);
  if (mode === 'missing-leaf') assert(!result.events.includes('install') && !result.events.includes('listen'));
  if (mode === 'listen-error') throw new Error(SECRET);
          setImmediate(() => {
            if (mode === 'switch-proxy') activeProxy.ProxyServer = 'user-choice:9000';
            if (mode === 'signal') runtime.emit('SIGINT');
            else if (mode === 'uncaught') runtime.emit('uncaughtException', new Error(SECRET));
            else if (mode === 'rejection') runtime.emit('unhandledRejection', new Error(SECRET));
            else if (mode !== 'timeout') {
              options.log('http', `https://${HOST}/?token=${SECRET}`);
              options.onLogin({
                url: `wss://${HOST}/game?token=${SECRET}`, name: 'LoginRequest',
                body: null, rawFrameHex: 'abcd',
              });
            }
          });
        },
        async stop() { events.push('stop'); },
      };
    },
    // A short fake timer exercises the timeout path without a real 300-second wait.
    ...(mode === 'timeout' ? { setTimeout: (callback) => setImmediate(callback), clearTimeout: clearImmediate } : {}),
  });
  assert(!logs.join('\n').includes(SECRET), 'must not print tokens, URLs, or raw errors');
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
    assert.equal(runtime.listenerCount(event), 0, 'must release process handlers');
  }
  for (const [filename, text] of initialFiles) assert.equal(files.get(filename), text, 'existing data must remain intact');
  if (trustedBefore) {
    assert(!events.includes('uninstall'), 'must preserve an existing CA');
    assert(!events.includes('install'), 'must not reinstall an existing CA');
    assert.equal(trusted, true);
  } else assert.equal(trusted, false, 'must remove this run’s CA, including partial installation failures');
  if (events.includes('set') && mode !== 'restore-error') {
    const expected = mode === 'switch-proxy' ? { ProxyEnable: '0x1', ProxyServer: 'user-choice:9000' } : originalProxy;
    assert.deepEqual(activeProxy, expected);
    assert(events.indexOf('listen') < events.indexOf('set'), 'listen must precede system proxy changes');
    assert(events.indexOf('backup') < events.indexOf('set'), 'backup must precede system proxy changes');
    assert(events.indexOf('restore') < events.indexOf('stop'), 'restore system routing before stopping the proxy');
  }
  if (mode === 'stale-proxy') {
    assert.deepEqual(activeProxy, originalProxy, 'must leave stale proxy settings available for explicit recovery');
    assert.deepEqual(savedProxy, previousBackup, 'must not overwrite the recovery backup from a previous capture');
  }
  if (events.includes('lock') && mode !== 'busy') assert.equal(events.at(-1), 'unlock');
  return { code, events, logs, writes, files };
}

assert.deepEqual(parseOptions([]), { help: false, yes: false, hosts: [DEFAULT_HOST], timeout: 300 });
assert.deepEqual(parseOptions(['--host', 'Gate.Example', '--host', 'other.example', '--host', 'gate.example', '--timeout', '30']), {
  help: false, yes: false, hosts: ['gate.example', 'other.example'], timeout: 30,
});
for (const args of [
  ['--host'], ['--host', 'https://gate.example'], ['--host', 'gate.example:443'],
  ['--host', '*.example'], ['--timeout'], ['--timeout', '0'], ['--timeout', '-1'],
  ['--timeout', '1.5'], ['--timeout', '86401'], ['--unknown'],
]) assert.throws(() => parseOptions(args));
console.log('PASS: argument validation and explicit host selection');

for (const options of [
  { args: ['--help'], expectedCode: 0, expectedEvents: [] },
  { args: [], expectedCode: 2, expectedEvents: [] },
  { args: [], tty: true, expectedCode: 0, expectedEvents: ['confirm'] },
]) {
  const result = await runCase(options);
  assert.equal(result.code, options.expectedCode);
  assert.deepEqual(result.events, options.expectedEvents, 'help/decline must not initialize any system dependency');
}
console.log('PASS: help, non-TTY refusal, and interactive cancellation have no side effects');

for (const trustedBefore of [false, true]) {
  const result = await runCase({ trustedBefore });
  assert.equal(result.code, 0);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].filename, SAMPLE_PATH);
  assert.deepEqual(JSON.parse(result.writes[0].text), {
    kind: 'login-sample', platform: 'douyin', appId: 'tt76340089e939a1bf02',
    url: `wss://${HOST}/game?token=${SECRET}`, loginFrameHex: 'abcd', capturedAt: FIXED_DATE.toISOString(),
  });
}
console.log('PASS: capture saves only a sample, keeps existing credentials, preserves existing CA, and redacts logs');

for (const [mode, expectedCode] of [
  ['switch-proxy', 0], ['busy', 1], ['missing-leaf', 1], ['listen-error', 1], ['backup-error', 1], ['set-error', 1], ['install-error', 1],
  ['signal', 130], ['uncaught', 1], ['rejection', 1], ['timeout', 124],
]) {
  const result = await runCase({ mode });
  assert.equal(result.code, expectedCode, mode);
  if (mode === 'listen-error' || mode === 'backup-error' || mode === 'install-error') {
    assert(!result.events.includes('set'), 'must not set system proxy after a prerequisite failure');
  }
  if (mode === 'set-error') assert(result.events.includes('restore'), 'partial set failure still needs rollback');
}
console.log('PASS: timeout, signals, exceptions, and partial setup failures all roll back');

const replacedBackup = await runCase({ mode: 'overwritten-backup' });
assert.equal(replacedBackup.code, 0);
assert(replacedBackup.events.includes('restore'));
const staleProxy = await runCase({ mode: 'stale-proxy' });
assert.equal(staleProxy.code, 1);
for (const event of ['init', 'install', 'listen', 'backup', 'set', 'restore']) {
  assert(!staleProxy.events.includes(event), 'stale capture proxy must be rejected before touching the recovery backup');
}
assert.equal(staleProxy.writes.length, 0);
assert(staleProxy.logs.some((line) => line.includes('proxy-settings.mjs restore')));
console.log('PASS: restores the current run’s snapshot after shared-backup replacement and preserves stale-proxy recovery data');

const collision = await runCase({ existingSample: true });
assert.equal(collision.code, 1);
assert.equal(collision.writes.length, 0);
const failedRestore = await runCase({ mode: 'restore-error' });
assert.equal(failedRestore.code, 1, 'cleanup failure must not report success');
assert(failedRestore.logs.some((line) => line.includes('proxy-settings.mjs restore')));
assert(failedRestore.events.includes('stop') && failedRestore.events.includes('uninstall'));
console.log('PASS: refuses sample overwrite and reports rollback failures while continuing cleanup');
console.log('Douyin CLI selftest passed; no certificate, registry, network, or filesystem mutations were performed.');
