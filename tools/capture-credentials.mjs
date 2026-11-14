import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startCapture, stopCapture, DEFAULT_PROXY_PORT } from '../src/capture.mjs';

const DEFAULT_OUT = path.resolve(import.meta.dirname, '../data/credentials.json');
const DEFAULT_WAIT_MS = 300000;
const CLEANUP_MESSAGES = [
  '本次代理改动已清理。',
  '本次安装的测试 CA 已移除。',
  '系统代理还原失败，请停止其他采集任务后重试停止，并检查 Windows 代理设置。',
  '本次测试 CA 移除失败，请重试停止或运行 node tools/mitm-ca.mjs uninstall。',
  '本地采集代理关闭失败，请重试停止。',
];

export function captureWaitMs(value = DEFAULT_WAIT_MS) {
  const waitMs = Number(value);
  if (!Number.isInteger(waitMs) || waitMs < 1000 || waitMs > 1800000) {
    throw new Error('CW_WAIT_MS 必须是 1000 到 1800000 之间的整数毫秒数');
  }
  return waitMs;
}

export async function requestConfirmation({ input = process.stdin, output = process.stdout } = {}) {
  // Piped input must not silently approve installing a certificate or changing a proxy.
  if (!input.isTTY || !output.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question('确认开始电脑微信抓包？[y/N] ', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export function writeCredentialAtomically(outPath, record, { filesystem = fs, now = () => new Date().toISOString() } = {}) {
  if (!record?.body?.eworldParams?.openId || !record.url) {
    throw new Error('登录包缺少网关地址或账号标识，原有凭证已保留');
  }
  const output = path.resolve(outPath);
  const directory = path.dirname(output);
  const temporary = path.join(directory, `.${path.basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  const capturedAt = now();
  const credential = {
    url: record.url,
    login: record.body,
    loginFrameHex: record.rawFrameHex,
    source: 'mitm',
    capturedAt,
  };
  filesystem.mkdirSync(directory, { recursive: true });
  try {
    filesystem.writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    filesystem.renameSync(temporary, output);
  } finally {
    try { filesystem.rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
  }
  return { path: output, capturedAt };
}

// Dependency injection keeps the CLI's lifecycle and file handling testable offline.
export async function main(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const waitMs = captureWaitMs(options.waitMs ?? env.CW_WAIT_MS ?? DEFAULT_WAIT_MS);
  const defaultOutput = env.CW_DATA_DIR ? path.join(path.resolve(env.CW_DATA_DIR), 'credentials.json') : DEFAULT_OUT;
  const output = path.resolve(options.outPath ?? defaultOutput);
  const confirm = dependencies.confirm ?? requestConfirmation;
  const start = dependencies.startCapture ?? startCapture;
  const stop = dependencies.stopCapture ?? stopCapture;
  const filesystem = dependencies.filesystem ?? fs;
  const log = dependencies.log ?? console.log;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;

  log('本次将在当前用户范围安装本地测试证书，并临时启用系统代理，结束后还原。');
  log('请让电脑微信与手机使用同一微信账号，再在电脑微信中打开《疯狂水世界》。');
  log('此流程捕获并保存真实游戏登录请求；是否登录成功仍需由游戏网关验证。');
  if (!(await confirm())) {
    log('已取消，未启动抓包。非交互终端默认取消。');
    return { status: 'cancelled' };
  }

  let timer = null;
  let saved = null;
  let startAttempted = false;
  let result;
  let complete;
  const completion = new Promise((resolve) => { complete = resolve; });
  try {
    filesystem.mkdirSync(path.dirname(output), { recursive: true });
    startAttempted = true;
    const state = await start({
      port: options.port ?? DEFAULT_PROXY_PORT,
      timeoutMs: waitMs,
      // Only known cleanup messages are safe to forward: never print transport URLs or records.
      onLog: (message) => {
        if (CLEANUP_MESSAGES.includes(message)) log(message);
      },
      onLogin: async (record) => {
        try {
          saved = writeCredentialAtomically(output, record, { filesystem, now: dependencies.now });
          complete({ status: 'captured', ...saved });
          return { id: record.body.eworldParams.openId };
        } catch (error) {
          complete({ status: 'failed', error });
          throw error;
        }
      },
    });
    if (state?.error) throw new Error(state.error);
    if (state?.running === false && !saved) throw new Error('抓包未启动，原有凭证已保留');
    log(`等待电脑游戏发送登录请求，最多 ${Math.round(waitMs / 1000)} 秒；游戏已运行时请先完全退出再打开。`);
    timer = setTimer(() => complete({ status: 'timeout' }), waitMs);
    result = await completion;
    if (result.status === 'failed') throw result.error;
  } finally {
    if (timer !== null) clearTimer(timer);
    if (startAttempted) {
      const stopped = await stop(saved ? 'CLI 已保存登录请求' : 'CLI 捕获结束');
      if (stopped?.phase === 'error') {
        throw new Error(`系统清理尚未完成：${stopped.error || '请检查系统代理及本次安装的测试 CA'}`);
      }
      if (saved && stopped?.error) {
        throw new Error(`登录请求已保存，但采集未正常结束：${stopped.error}`);
      }
    }
  }
  if (result.status === 'captured') log(`登录请求已保存，采集清理已完成：${result.path}`);
  else log('等待超时，未捕获登录请求；原有凭证已保留，采集清理已完成。');
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((result) => {
    if (result.status === 'timeout') process.exitCode = 1;
  }).catch((error) => {
    console.error(`抓包失败：${error.message}`);
    process.exitCode = 1;
  });
}
