import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatConsoleLog } from '../src/console-log.mjs';

const time = new Date(2026, 10, 12, 13, 14, 15).getTime();
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(time);
const entry = { t: time, account: 'account-123456', level: 'info', message: '自动挂机开始' };
const prefix = (account = 'account-', level = '信息') => `[${clock}] [${account}] [${level}] `;
let passed = 0;
function test(name, fn) {
  fn(); passed++; console.log('通过：' + name);
}

test('时间按本地时区显示，账号仅显示前八个字符', () => {
  assert.equal(formatConsoleLog(entry), prefix() + '自动挂机开始');
  assert.equal(formatConsoleLog({ ...entry, account: 'a' }), prefix('a') + '自动挂机开始');
});

test('系统日志和中文等级', () => {
  for (const [level, expected] of [['info', '信息'], ['warn', '警告'], ['error', '错误'], ['state', '状态']]) {
    assert.equal(formatConsoleLog({ ...entry, account: null, level }), prefix('系统', expected) + '自动挂机开始');
  }
  assert.equal(formatConsoleLog({ ...entry, account: '', level: 'unknown' }), prefix('系统') + '自动挂机开始');
});

test('多行正文每一行都带时间、账号和等级', () => {
  const message = '第一行\n第二行\r\n第三行\r第四行';
  assert.equal(formatConsoleLog({ ...entry, message }), ['第一行', '第二行', '第三行', '第四行'].map(line => prefix() + line).join('\n'));
});

test('ANSI 颜色、光标、标题命令和其他控制字符不进入终端', () => {
  const message = '\u001b[31m红字\u001b[0m\u001b[2J\u001b[H\u001b]0;伪造标题\u0007\u0000\u0008\t\u007f\u0085正文\n下一行';
  const result = formatConsoleLog({ ...entry, message });
  assert.equal(result, prefix() + '红字正文\n' + prefix() + '下一行');
  assert.doesNotMatch(result, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(result, /伪造标题/);
});

test('账号中的控制符不能伪造额外日志行', () => {
  assert.equal(formatConsoleLog({ ...entry, account: '\u001b[31mac\r\ncount-123\u0007' }), prefix('account-') + '自动挂机开始');
});

test('不访问或输出 detail、extra 和其他原始字段', () => {
  const secret = { ...entry, login: { password: '不可输出的密码' } };
  Object.defineProperties(secret, {
    detail: { get() { throw new Error('不得读取原始详情'); } },
    extra: { get() { throw new Error('不得读取额外字段'); } },
  });
  assert.equal(formatConsoleLog(secret), prefix() + '自动挂机开始');
  const result = formatConsoleLog({ ...entry, detail: 'token=私密值', extra: { protocol: { password: '私密密码' } } });
  assert.equal(result, prefix() + '自动挂机开始');
  assert.doesNotMatch(result, /token|私密|password|protocol/);
});

test('空正文和无效时间不会使日志输出抛错', () => {
  assert.equal(formatConsoleLog({ ...entry, message: null }), prefix());
  assert.equal(formatConsoleLog({ ...entry, t: 'invalid' }), '[--:--:--] [account-] [信息] 自动挂机开始');
});

// Exercise the real CLI entrypoint with an empty, isolated account store. The
// only process terminated below is the child created by this test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-log-cli-'));
const configFile = path.join(dir, 'config.json');
fs.writeFileSync(configFile, '[]');
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ version: 1, activeId: null, accounts: [] }));
const repo = fileURLToPath(new URL('../', import.meta.url));
let child;
let closed;
try {
  child = spawn(process.execPath, ['src/app.mjs', 'console'], {
    cwd: repo,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CW_DATA_DIR: dir, CW_CONFIG_PACK: configFile,
      CW_NO_BROWSER: '1', CW_QUIET_START: '1', CW_PORT: '0',
    },
  });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stderr.on('data', text => { stderr += text; });
  const started = /\[\d{2}:\d{2}:\d{2}\] \[系统\] \[信息\] 控制台已启动 (http:\/\/127\.0\.0\.1:([1-9]\d*))/;
  const guidance = '关闭网页后挂机会继续，运行日志显示在此窗口。请保持此窗口打开；Ctrl+C 或关闭此窗口会结束后台进程。';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('CLI 启动输出超时：' + stderr)), 10000);
    const finish = error => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
      child.stdout.off('data', onData);
      if (error) reject(error); else resolve();
    };
    const onError = error => finish(error);
    const onClose = (code, signal) => finish(new Error(`CLI 提前退出：code=${code} signal=${signal}\n${stderr}`));
    const onData = text => {
      stdout += text;
      if (started.test(stdout) && stdout.includes(guidance)) finish();
    };
    child.once('error', onError);
    child.once('close', onClose);
    child.stdout.on('data', onData);
  });
  const match = stdout.match(started);
  assert.ok(match, '真实 CLI 必须将格式化业务日志输出到 stdout');
  assert.ok(Number(match[2]) <= 65535, '启动日志必须显示实际监听端口');
  assert.doesNotMatch(stdout, /控制台已启动 http:\/\/127\.0\.0\.1:0\b/);
  assert.ok(stdout.includes(guidance), '启动提示必须区分关闭网页与关闭启动窗口');
  assert.equal(child.exitCode, null, '没有浏览器连接时，后台进程仍保持运行');
  assert.equal(child.signalCode, null);
  const response = await fetch(match[1] + '/api/accounts', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accounts, [], '子进程只读取隔离目录的空账号库');
  passed++;
  console.log('通过：真实 CLI 在无浏览器和空账号下保持运行，输出实际地址及启动窗口保留提示');
} finally {
  if (child && closed) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试子进程未及时退出')), 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('终端日志格式专项 ' + passed + '/' + passed + ' 通过');
