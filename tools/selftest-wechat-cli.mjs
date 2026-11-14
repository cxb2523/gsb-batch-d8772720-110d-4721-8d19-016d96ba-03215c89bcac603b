// Offline CLI lifecycle tests: fake capture callbacks, real files in one temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureWaitMs, main, requestConfirmation } from './capture-credentials.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wechat-cli-'));
const oldCredential = '{"saved":"previous-fixture"}\n';
const record = {
  url: 'wss://fixture.invalid/ws',
  body: { eworldParams: { openId: 'fixture-open-id', token: 'fixture-private-token', sign: 'fixture-private-sign', timestamp: 1 } },
  rawFrameHex: '00010203',
};
const capturedAt = '2026-10-19T00:00:00.000Z';

function prepare(name, { existing = true } = {}) {
  const output = path.join(temporary, name, 'credentials.json');
  if (existing) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, oldCredential);
  }
  return output;
}

function harness(overrides = {}) {
  const calls = { confirm: 0, start: 0, stop: 0, logs: [], options: null };
  const dependencies = {
    env: {},
    log: (message) => calls.logs.push(String(message)),
    now: () => capturedAt,
    confirm: async () => { calls.confirm += 1; return true; },
    startCapture: async (options) => {
      calls.start += 1;
      calls.options = options;
      options.onLog('fixture-private-token must never reach CLI logs');
      await options.onLogin(record);
      // The controller may finish automatic cleanup before start resolves.
      return { running: false, error: null };
    },
    stopCapture: async () => { calls.stop += 1; return { running: false }; },
    ...overrides,
  };
  return { calls, dependencies };
}

function assertNoSecrets(logs) {
  const output = logs.join('\n');
  assert.ok(!output.includes(record.body.eworldParams.token), 'CLI must not print token values');
  assert.ok(!output.includes(record.body.eworldParams.sign), 'CLI must not print signing values');
  assert.ok(!output.includes(record.rawFrameHex), 'CLI must not print raw login frames');
}

function assertNoTemporaryFiles(output) {
  assert.deepEqual(fs.readdirSync(path.dirname(output)), ['credentials.json'], 'remove same-directory temporary files');
}

try {
  assert.equal(captureWaitMs(), 300000);
  assert.equal(captureWaitMs('1000'), 1000);
  assert.equal(captureWaitMs(1800000), 1800000);
  for (const value of [0, -1, 999, 1800001, 1000.5, 'no', '', Infinity]) {
    assert.throws(() => captureWaitMs(value), /CW_WAIT_MS/);
  }
  assert.equal(await requestConfirmation({ input: { isTTY: false }, output: { isTTY: true } }), false);
  assert.equal(await requestConfirmation({ input: { isTTY: true }, output: { isTTY: false } }), false);

  // Declining must not create any output directory, CA, proxy, or credential file.
  {
    const output = prepare('cancelled', { existing: false });
    const { calls, dependencies } = harness({
      confirm: async () => false,
      filesystem: new Proxy({}, { get: () => () => assert.fail('cancelled CLI touched the filesystem') }),
    });
    assert.deepEqual(await main({ outPath: output }, dependencies), { status: 'cancelled' });
    assert.equal(calls.start, 0);
    assert.equal(calls.stop, 0);
    assert.equal(fs.existsSync(path.dirname(output)), false);
  }

  // First use creates the data directory; a successful callback preserves the full record.
  {
    const output = prepare('new-directory', { existing: false });
    const { calls, dependencies } = harness();
    const result = await main({ outPath: output, waitMs: 1000 }, dependencies);
    assert.deepEqual(result, { status: 'captured', path: output, capturedAt });
    assert.equal(calls.confirm, 1);
    assert.equal(calls.start, 1);
    assert.equal(calls.stop, 1);
    assert.equal(calls.options.timeoutMs, 1000);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
      url: record.url, login: record.body, loginFrameHex: record.rawFrameHex, source: 'mitm', capturedAt,
    });
    assertNoTemporaryFiles(output);
    assertNoSecrets(calls.logs);
  }

  // Existing credentials remain readable until the single same-directory rename.
  {
    const dataDirectory = path.join(temporary, 'configured-data');
    const { dependencies } = harness({ env: { CW_DATA_DIR: dataDirectory } });
    const result = await main({}, dependencies);
    assert.equal(result.path, path.join(dataDirectory, 'credentials.json'));
    assert.equal(JSON.parse(fs.readFileSync(result.path, 'utf8')).source, 'mitm');
  }

  // Existing credentials remain readable until the single same-directory rename.
  {
    const output = prepare('atomic-replace');
    const filesystem = Object.create(fs);
    let renames = 0;
    filesystem.renameSync = (from, to) => {
      assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
      assert.equal(path.dirname(from), path.dirname(output));
      assert.equal(to, output);
      assert.notEqual(from, to);
      renames += 1;
      return fs.renameSync(from, to);
    };
    const { calls, dependencies } = harness({ filesystem });
    await main({ outPath: output }, dependencies);
    assert.equal(renames, 1);
    assert.equal(calls.stop, 1);
    assertNoTemporaryFiles(output);
    assertNoSecrets(calls.logs);
  }

  // A partial disk write or failed replacement cannot delete the old credentials.
  for (const operation of ['write', 'rename']) {
    const output = prepare(`failed-${operation}`);
    const filesystem = Object.create(fs);
    if (operation === 'write') {
      filesystem.writeFileSync = (file, _data, options) => {
        fs.writeFileSync(file, 'partial', options);
        throw new Error('simulated disk write failure');
      };
    } else {
      filesystem.renameSync = () => { throw new Error('simulated rename failure'); };
    }
    const { calls, dependencies } = harness({ filesystem });
    await assert.rejects(main({ outPath: output }, dependencies), /simulated/);
    assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
    assert.equal(calls.stop, 1, 'write failure still awaits capture cleanup');
    assertNoTemporaryFiles(output);
    assertNoSecrets(calls.logs);
  }

  // Errors before a callback still clean up and retain the old credentials.
  {
    const output = prepare('failed-directory');
    const filesystem = Object.create(fs);
    filesystem.mkdirSync = () => { throw new Error('simulated output directory failure'); };
    const { calls, dependencies } = harness({ filesystem });
    await assert.rejects(main({ outPath: output }, dependencies), /simulated output directory failure/);
    assert.equal(calls.start, 0, 'do not install a CA or enable a proxy when output preparation fails');
    assert.equal(calls.stop, 0, 'do not stop a capture that this CLI has not started');
    assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
  }

  // Errors before a callback still clean up and retain the old credentials.
  {
    const output = prepare('failed-start');
    const { calls, dependencies } = harness({ startCapture: async () => ({ running: false, error: 'simulated start failure' }) });
    await assert.rejects(main({ outPath: output }, dependencies), /simulated start failure/);
    assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
    assert.equal(calls.stop, 1);
  }

  // Invalid frames are not saved as usable accounts.
  {
    const output = prepare('invalid-record');
    const { calls, dependencies } = harness({ startCapture: async ({ onLogin }) => onLogin({ url: record.url, body: {} }) });
    await assert.rejects(main({ outPath: output }, dependencies), /账号标识/);
    assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
    assert.equal(calls.stop, 1);
    assertNoTemporaryFiles(output);
  }

  // Simulate timeout without waiting or touching a real proxy.
  {
    const output = prepare('timeout');
    let timerCleared = false;
    const { calls, dependencies } = harness({
      env: { CW_WAIT_MS: '1234' },
      startCapture: async (options) => {
        assert.equal(options.timeoutMs, 1234);
        assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
        return { running: true };
      },
      setTimeout: (callback, delay) => {
        assert.equal(delay, 1234);
        queueMicrotask(callback);
        return 'fake-timer';
      },
      clearTimeout: (timer) => { assert.equal(timer, 'fake-timer'); timerCleared = true; },
    });
    assert.deepEqual(await main({ outPath: output }, dependencies), { status: 'timeout' });
    assert.equal(calls.stop, 1);
    assert.equal(timerCleared, true);
    assert.equal(fs.readFileSync(output, 'utf8'), oldCredential);
    assertNoTemporaryFiles(output);
  }

  // A saved record must not hide failures to restore system settings.
  {
    const output = prepare('cleanup-failure');
    let callbackLog;
    const failure = '系统代理还原失败，请停止其他采集任务后重试停止，并检查 Windows 代理设置。';
    const { calls, dependencies } = harness({
      startCapture: async ({ onLogin, onLog }) => {
        callbackLog = onLog;
        await onLogin(record);
        return { running: false, error: null };
      },
      stopCapture: async () => {
        callbackLog(failure);
        return { running: false, phase: 'error', error: failure };
      },
    });
    await assert.rejects(main({ outPath: output }, dependencies), /系统清理尚未完成.*系统代理还原失败/);
    assert.ok(calls.logs.includes(failure), 'show the actionable cleanup failure');
    assert.ok(!calls.logs.some((line) => line.startsWith('登录请求已保存')), 'do not announce success before cleanup');
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).login.eworldParams.openId, 'fixture-open-id');
    assertNoSecrets(calls.logs);
  }

  {
    const output = prepare('cleanup-success-logs');
    let callbackLog;
    const { calls, dependencies } = harness({
      startCapture: async ({ onLogin, onLog }) => {
        callbackLog = onLog;
        await onLogin(record);
        return { running: false, error: null };
      },
      stopCapture: async () => {
        callbackLog('本次代理改动已清理。');
        callbackLog('本次安装的测试 CA 已移除。');
        return { running: false, phase: 'idle', error: null };
      },
    });
    await main({ outPath: output }, dependencies);
    assert.ok(calls.logs.includes('本次代理改动已清理。'));
    assert.ok(calls.logs.includes('本次安装的测试 CA 已移除。'));
    assert.ok(calls.logs.at(-1).startsWith('登录请求已保存，采集清理已完成：'));
  }

  console.log('wechat CLI selftest ok: non-TTY/cancel, CW_DATA_DIR, atomic replacement, write/rename/start failures, invalid records, timeout, cleanup visibility, no credential logging');
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('cw-wechat-cli-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
