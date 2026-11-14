// All registry, certificate, socket, timer, and process actions are in-memory fakes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCaptureController, DEFAULT_CAPTURE_TIMEOUT_MS } from '../src/capture.mjs';

const PORT = 17322;
const HOST = 'dhyaoj-gate.khlgamen.com';
const ORIGINAL = { ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890', ProxyOverride: '<local>;*.example' };
const RECORD = { url: `wss://${HOST}/ws?token=do-not-log`, name: 'LoginRequest', body: {}, rawFrameHex: 'abcd' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function harness({ mode = '', trusted = false, certExists = trusted, original = ORIGINAL } = {}) {
  const events = [];
  const runtime = new EventEmitter();
  runtime.exit = (code) => events.push(`exit:${code}`);
  const h = {
    events, runtime, mode, trusted, certExists, active: { ...original }, sharedBackup: null,
    options: null, timers: new Map(), listener: deferred(), stopper: deferred(),
  };
  let nextTimer = 0;
  h.controller = createCaptureController({
    acquireLock: async () => {
      if (h.mode === 'busy') throw new Error('fixture lock busy');
      h.locked = true;
      return () => { h.locked = false; };
    },
    process: runtime, port: PORT, now: () => new Date('2026-10-19T00:00:00.000Z'),
    setTimeout(callback, milliseconds) {
      const timer = ++nextTimer;
      h.timers.set(timer, { callback, milliseconds });
      return timer;
    },
    clearTimeout(timer) { h.timers.delete(timer); },
    ca: {
      CA_CN: 'Fixture CA', CA_CRT: 'fixture.crt',
      caFingerprint() { if (!h.certExists) throw new Error('ENOENT'); return 'fixture-fingerprint'; },
      isInstalled() { return h.trusted; },
      initCa() {
        events.push('ca:init');
        if (h.mode === 'init-failure') throw new Error('fixture initialization failure');
        h.certExists = true;
      },
      prepareLeaf(host) {
        assert.equal(host, HOST);
        if (h.mode === 'missing-leaf') throw new Error('leaf.key');
      },
      installCa() {
        events.push('ca:install');
        if (h.mode === 'install-before-write-failure') throw new Error('fixture install rejected before trust changed');
        h.trusted = true;
        if (h.mode === 'install-failure') throw new Error('fixture partial certificate installation');
      },
      uninstallCa() {
        events.push('ca:remove');
        if (h.mode === 'ca-cleanup-failure') throw new Error('fixture removal failure');
        h.trusted = false;
      },
      removeCaFiles() { events.push('ca:files-removed'); },
    },
    proxySettings: {
      readCurrent() { return { ...h.active }; },
      backup(snapshot) { h.sharedBackup = { ...snapshot }; },
      setProxy(host, port) {
        events.push('proxy:set');
        h.sharedBackup = { ...h.active };
        h.active = { ProxyEnable: '0x1', ProxyServer: `${host}:${port}`, ProxyOverride: '<local>' };
        if (h.mode === 'set-failure') throw new Error('fixture partial proxy change');
        if (h.mode === 'set-verification-failure') h.active.ProxyServer = original.ProxyServer;
      },
      restore(snapshot, names) {
        events.push('proxy:restore');
        assert.deepEqual(snapshot, original, 'restore must receive this run’s in-memory original');
        if (h.mode === 'restore-failure') throw new Error('fixture registry failure');
        for (const name of names) {
          if (name in snapshot) h.active[name] = snapshot[name];
          else delete h.active[name];
        }
      },
    },
    createProxy(options) {
      events.push('proxy:create');
      assert.deepEqual(options.interceptHosts, [HOST]);
      assert.deepEqual(options.interceptPorts, [443]);
      assert.notEqual(options.rawLogin, true, 'WeChat capture must decode the validated game protocol');
      if (h.mode === 'create-failure') throw new Error('fixture missing protocol');
      h.options = options;
      return {
        async listen() {
          events.push('proxy:listen');
          if (h.mode === 'listen-failure') throw new Error('fixture bind failure');
          if (h.mode === 'pending-listen') await h.listener.promise;
        },
        async stop() {
          events.push('proxy:stop');
          if (h.mode === 'pending-stop') await h.stopper.promise;
        },
      };
    },
  });
  h.emitLogin = (record = RECORD) => h.options.onLogin(record);
  h.fireTimeout = () => {
    assert.equal(h.timers.size, 1);
    h.timers.values().next().value.callback();
  };
  h.assertClean = ({ retained = trusted } = {}) => {
    assert.deepEqual(h.active, original);
    assert.equal(h.trusted, retained);
    assert(!h.locked);
    assert.equal(h.controller.captureState().running, false);
    assert.equal(h.timers.size, 0);
    for (const event of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(runtime.listenerCount(event), 0);
  };
  return h;
}

const fresh = harness();
assert.equal(fresh.controller.captureState().ca.fingerprint, null);
assert.equal(fresh.controller.captureState().running, false);
assert.deepEqual(fresh.events, [], 'first status read must neither initialize a CA nor change settings');
await fresh.controller.stopCapture();
assert.deepEqual(fresh.events, []);

for (const trusted of [false, true]) {
  const h = harness({ trusted });
  let loginCalls = 0;
  const started = await h.controller.startCapture({ onLogin: async () => { loginCalls++; return { id: 'fixture-account' }; } });
  assert.equal(started.running, true);
  assert.deepEqual(started.originalProxy, ORIGINAL);
  assert.equal(started.caInstalledBefore, trusted);
  assert.equal(started.caAddedByCapture, !trusted);
  assert.equal(h.timers.values().next().value.milliseconds, DEFAULT_CAPTURE_TIMEOUT_MS);
  assert(h.events.indexOf('proxy:listen') < h.events.indexOf('proxy:set'));
  await h.emitLogin({ ...RECORD, url: 'wss://unrelated.example/ws' });
  assert.equal(loginCalls, 0, 'ignore unrelated hosts');
  h.sharedBackup = { ProxyEnable: '0x1', ProxyServer: 'overwritten-shared-backup:1' };
  h.options.log('upgrade', RECORD.url);
  await h.emitLogin();
  await h.emitLogin();
  const captured = h.controller.captureState();
  assert.equal(loginCalls, 1);
  assert.equal(captured.accountId, 'fixture-account');
  assert(captured.capturedAt);
  assert.equal(captured.error, null);
  assert(!captured.log.join('\n').includes('do-not-log'));
  assert(h.events.indexOf('proxy:restore') < h.events.indexOf('proxy:stop'));
  if (trusted) assert(!h.events.includes('ca:install') && !h.events.includes('ca:remove') && !h.events.includes('ca:files-removed'));
  else assert(h.events.includes('ca:files-removed'), 'remove generated CA files after successful stop');
  h.assertClean();
  const cleanEvents = [...h.events];
  await h.controller.stopCapture('重复停止');
  assert.deepEqual(h.events, cleanEvents);
}

const callbackFailure = harness();
await callbackFailure.controller.startCapture({ onLogin: async () => { throw new Error('secret-token'); } });
await callbackFailure.emitLogin();
assert.match(callbackFailure.controller.captureState().error, /保存或处理失败/);
assert(!JSON.stringify(callbackFailure.controller.captureState()).includes('secret-token'));
callbackFailure.assertClean();

const reentrant = harness();
await reentrant.controller.startCapture({
  onLogin: async () => {
    await reentrant.controller.stopCapture('server callback already stops');
    return { id: 'reentrant-account' };
  },
});
await reentrant.emitLogin();
assert.equal(reentrant.controller.captureState().accountId, 'reentrant-account');
assert.equal(reentrant.events.filter((event) => event === 'proxy:stop').length, 1);
reentrant.assertClean();

for (const mode of ['busy', 'missing-leaf', 'create-failure', 'init-failure', 'install-before-write-failure', 'install-failure', 'listen-failure', 'set-failure', 'set-verification-failure']) {
  const h = harness({ mode });
  const result = await h.controller.startCapture();
  assert.equal(result.running, false, mode);
  assert(result.error, mode);
  if (mode === 'busy') assert.deepEqual(h.events, []);
  if (mode === 'missing-leaf') {
    assert.match(result.error, /leaf\.key/);
    assert(!h.events.includes('ca:install') && !h.events.includes('proxy:listen'));
  }
  if (mode === 'create-failure') assert(!h.events.includes('ca:init'), 'load protocol before any trust changes');
  if (!mode.startsWith('set-')) assert(!h.events.includes('proxy:set'), mode);
  if (mode === 'install-failure') assert(h.events.includes('ca:remove') && h.events.includes('ca:files-removed'), 'clean partially installed CA and generated files');
  if (mode === 'install-before-write-failure') assert(!h.events.includes('ca:remove'), 'do not delete absent trust after an early install failure');
  if (mode.startsWith('set-')) assert(h.events.includes('proxy:restore'), 'restore even partially changed proxy');
  h.assertClean();
}

for (const server of ['127.0.0.1:17322', 'localhost:17322', 'http=localhost:17322;https=127.0.0.1:17322', '[::1]:17322']) {
  const h = harness({ original: { ProxyEnable: '0x1', ProxyServer: server } });
  const result = await h.controller.startCapture();
  assert.match(result.error, /原始备份/);
  assert.deepEqual(h.events, [], 'stale capture proxy must fail before trust, listening, or backup changes');
  h.assertClean();
}

const changed = harness({ original: { ProxyEnable: '0x0', ProxyServer: 'before:8080' } });
await changed.controller.startCapture();
changed.active.ProxyServer = 'user-choice:8081';
changed.active.ProxyOverride = '*.new';
await changed.controller.stopCapture();
assert.deepEqual(changed.active, { ProxyEnable: '0x1', ProxyServer: 'user-choice:8081', ProxyOverride: '*.new' });

const timeout = harness();
await timeout.controller.startCapture({ timeoutMs: 25 });
assert.equal(timeout.timers.values().next().value.milliseconds, 25);
timeout.fireTimeout();
await timeout.controller.stopCapture('join timeout cleanup');
assert.match(timeout.controller.captureState().error, /超时/);
timeout.assertClean();

const concurrent = harness({ mode: 'pending-stop' });
await concurrent.controller.startCapture();
const firstStop = concurrent.controller.stopCapture('first');
const secondStop = concurrent.controller.stopCapture('second');
assert.equal(firstStop, secondStop, 'concurrent stops must share one cleanup operation');
await flush();
concurrent.stopper.resolve();
await Promise.all([firstStop, secondStop]);
assert.equal(concurrent.events.filter((event) => event === 'proxy:stop').length, 1);
concurrent.assertClean();

const duringSetup = harness({ mode: 'pending-listen' });
const startPending = duringSetup.controller.startCapture();
const stopPending = duringSetup.controller.stopCapture('cancel pending listen');
duringSetup.listener.resolve();
await Promise.all([startPending, stopPending]);
assert(!duringSetup.events.includes('proxy:set'), 'cancelled setup must never enable the proxy later');
duringSetup.assertClean();

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  const h = harness();
  await h.controller.startCapture();
  h.runtime.emit(signal);
  assert.deepEqual(h.active, ORIGINAL, 'signals restore registry synchronously');
  assert.equal(h.trusted, false, 'signals remove newly added trust synchronously');
  await flush();
  assert(h.events.includes(`exit:${code}`));
  h.assertClean();
}

const exit = harness({ trusted: true });
await exit.controller.startCapture();
exit.runtime.emit('exit', 1);
assert.deepEqual(exit.active, ORIGINAL);
assert.equal(exit.trusted, true);
await exit.controller.stopCapture('test joins fake process exit');
exit.assertClean();

for (const mode of ['restore-failure', 'ca-cleanup-failure']) {
  const h = harness({ mode });
  await h.controller.startCapture();
  const result = await h.controller.stopCapture();
  assert.equal(result.phase, 'error');
  assert(h.locked, 'keep lock while cleanup needs retry');
  assert(result.error);
  assert(h.runtime.listenerCount('exit') > 0, 'retain exit retry while cleanup remains incomplete');
  h.mode = '';
  await h.controller.stopCapture('retry cleanup');
  h.assertClean();
}

const staleCallback = harness();
const pendingCallback = deferred();
await staleCallback.controller.startCapture({ onLogin: () => pendingCallback.promise });
const callback = staleCallback.emitLogin();
await staleCallback.controller.stopCapture('old capture cancelled');
await staleCallback.controller.startCapture();
pendingCallback.resolve({ id: 'old-account' });
await callback;
assert.equal(staleCallback.controller.captureState().running, true, 'late callback must not stop a new capture');
assert.equal(staleCallback.controller.captureState().accountId, null);
await staleCallback.controller.stopCapture();
staleCallback.assertClean();

console.log('WeChat capture selftest passed: first status, success/failure rollback, original snapshot, CA preservation, timeout, signals, and concurrent/reentrant stop; no real system operations.');
