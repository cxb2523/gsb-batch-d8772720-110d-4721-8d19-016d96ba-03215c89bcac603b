// 实验性样本采集：不解码登录消息，也不会导入或覆盖任何账号。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { acquireCaptureLock } from './capture-lock.mjs';
import { pointsToCapture, prepareCaptureProxy } from './proxy-settings.mjs';

export const DEFAULT_HOST = 'dhyaoj-gate.khlgamen.com';
const LOCAL_HOST = '127.0.0.1';
const HELP = `抖音 PC 小游戏登录样本采集（实验功能，尚未验证抖音协议）

用法：node tools/capture-douyin-login.mjs [选项]
  --help             显示帮助，不修改系统设置
  --host <网关域名>  仅解密此主机，可重复；明确指定后替换默认值
  --timeout <秒>     最长等待时间，1–86400，默认 300
  --yes              明确同意本次安装测试 CA 并临时设置系统代理

默认主机 ${DEFAULT_HOST} 仅为微信版已知网关，抖音是否使用尚未验证。
先在 Windows 抖音客户端登录本人账号，再运行采集并进入《疯狂水世界》。
本机工具不采集手机流量；不会生成登录二维码；样本尚非可用账号。
确认后临时修改当前用户的根证书和系统代理，结束或 Ctrl+C 时还原。
已有测试 CA 会保留，仅移除本次新安装的 CA。
样本可能包含登录凭证，请仅在本地保存，不要公开上传。
保存到 CW_DATA_DIR 或项目 data 目录中的 douyin-login-sample-时间戳.json。
`;

export function parseOptions(argv = []) {
  const result = { help: false, yes: false, hosts: [], timeout: 300 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') result.help = true;
    else if (arg === '--yes') result.yes = true;
    else if (arg === '--host') {
      const value = argv[++index]?.toLowerCase();
      if (!value || value.length > 253 || !value.split('.').every((part) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
        throw new Error('--host 需要完整网关域名，不能包含协议、端口、路径或通配符。');
      }
      result.hosts.push(value);
    } else if (arg === '--timeout') {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 86400) {
        throw new Error('--timeout 需要 1–86400 之间的整数秒。');
      }
      result.timeout = Number(value);
    } else throw new Error('未知参数，请使用 --help 查看用法。');
  }
  result.hosts = [...new Set(result.hosts.length ? result.hosts : [DEFAULT_HOST])];
  return result;
}

function confirm(input, output) {
  const terminal = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    terminal.once('close', () => resolve(false));
    terminal.question('输入 yes 同意上述临时系统改动，其他输入取消：', (answer) => {
      resolve(answer.trim().toLowerCase() === 'yes');
      terminal.close();
    });
  });
}

// 注入依赖只用于测试；导入此模块不会读取注册表、安装证书或启动代理。
// main 返回退出码。测试可替换 ca、proxySettings、createProxy、port、process、
// io、fs、confirm、now、setTimeout、clearTimeout 和 dataDir。
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const runtime = dependencies.process ?? process;
  const io = dependencies.io ?? console;
  const files = dependencies.fs ?? fs;
  const later = dependencies.setTimeout ?? setTimeout;
  const cancelTimer = dependencies.clearTimeout ?? clearTimeout;
  const now = dependencies.now ?? (() => new Date());
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    io.error(error.message);
    return 2;
  }
  if (options.help) {
    io.log(HELP);
    return 0;
  }
  if (runtime.platform !== 'win32') {
    io.error('此采集工具需要 Windows 抖音客户端和当前用户系统代理。');
    return 2;
  }
  io.log('这是待验证的抖音登录样本采集，尚不支持直接扫码添加账号。');
  io.log(`仅解密以下主机：${options.hosts.join(', ')}`);
  if (options.hosts.includes(DEFAULT_HOST)) {
    io.log('默认主机仅为微信版已知网关假设；抖音网关尚未确认。');
  }
  io.log('先在 Windows 抖音客户端登录本人账号，采集就绪后再打开游戏。');
  io.log('本机工具不采集手机流量；样本尚非可用账号，可能含凭证，请勿公开。');
  io.log('本次将临时安装当前用户测试 CA 并修改系统代理，退出时还原；已有 CA 保留。');
  if (!options.yes) {
    if (!runtime.stdin.isTTY) {
      io.error('非交互环境拒绝修改系统。请交互输入 yes，或在明确同意后使用 --yes。');
      return 2;
    }
    const accepted = await (dependencies.confirm ?? confirm)(runtime.stdin, runtime.stdout);
    if (!accepted) {
      io.log('已取消，未修改系统。');
      return 0;
    }
  }

  let ca;
  let settings;
  let proxy;
  let proxySettings;
  let releaseLock;
  let removeCa = false;
  let timer;
  let done = false;
  let outcome;
  let stage = '加载采集组件';
  let cleanupFailed = false;
  const installAbort = new AbortController();
  const finished = new Promise((resolve) => {
    outcome = (value) => {
      if (done) return;
      done = true;
      installAbort.abort(new Error(value.message));
      resolve(value);
    };
  });
  const handlers = new Map([
    ['SIGINT', () => outcome({ code: 130, message: '已中止采集。' })],
    ['SIGTERM', () => outcome({ code: 143, message: '已终止采集。' })],
    ['SIGHUP', () => outcome({ code: 129, message: '采集会话已关闭。' })],
    ['uncaughtException', () => outcome({ code: 1, message: '采集发生未处理异常。' })],
    ['unhandledRejection', () => outcome({ code: 1, message: '采集发生异步异常。' })],
  ]);
  let exitCode = 1;
  try {
    ca = dependencies.ca ?? await import('./mitm-ca.mjs');
    settings = dependencies.proxySettings ?? await import('./proxy-settings.mjs');
    const proxyModule = dependencies.createProxy
      ? { createProxy: dependencies.createProxy, DEFAULT_PROXY_PORT: 17322 }
      : await import('./mitm-proxy.mjs');
    const port = dependencies.port ?? proxyModule.DEFAULT_PROXY_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port');
    for (const [event, handler] of handlers) runtime.on(event, handler);
    timer = later(() => outcome({ code: 124, message: '等待超时，未获得登录样本；抖音网关或协议可能不同，或客户端未使用系统代理。' }), options.timeout * 1000);

    stage = '取得当前用户采集锁，请先结束其他采集任务';
    releaseLock = await (dependencies.acquireLock ?? acquireCaptureLock)();
    if (done) return (await finished).code;
    stage = '检查遗留采集代理（如未恢复，请先运行 node tools/proxy-settings.mjs restore）';
    if (pointsToCapture(settings.readCurrent(), port)) throw new Error('stale capture proxy');
    stage = '准备本地测试 CA';
    const installedBefore = ca.isInstalled();
    const initialized = ca.initCa();
    if (installedBefore && initialized.created) {
      throw new Error('已有可信 CA 但缺少对应本地证书，请检查证书状态');
    }
    for (const host of options.hosts) {
      stage = `准备 ${host} 的目标证书，请检查本地 CA 和签发密钥`;
      ca.prepareLeaf(host);
    }
    if (!installedBefore) {
      stage = '安装当前用户测试 CA';
      await ca.verifyRootView?.();
      installAbort.signal.throwIfAborted();
      // 安装可能在报错前已写入证书存储，所以先登记清理责任。
      removeCa = true;
      await ca.installCa({ signal: installAbort.signal });
      if (!ca.isInstalled()) throw new Error('CA verification');
    }
    stage = '启动本地采集代理';
    proxy = proxyModule.createProxy({
      port,
      rawLogin: true,
      interceptHosts: options.hosts,
      interceptPorts: [443],
      // 代理的普通调试日志可能含 URL 查询串；此入口不输出原始日志。
      log: () => {},
      onLogin: ({ url, name, rawFrameHex }) => {
        if (done) return;
        try {
          const target = new URL(url);
          if (!['ws:', 'wss:'].includes(target.protocol) || !options.hosts.includes(target.hostname.toLowerCase())) return;
          if (name !== 'LoginRequest' || !/^(?:[0-9a-f]{2})+$/i.test(rawFrameHex ?? '')) return;
          const capturedAt = now().toISOString();
          const dataDir = path.resolve(dependencies.dataDir ?? runtime.env.CW_DATA_DIR ?? path.join(import.meta.dirname, '../data'));
          const output = path.join(dataDir, `douyin-login-sample-${capturedAt.replace(/[:.]/g, '-')}.json`);
          files.mkdirSync(dataDir, { recursive: true });
          files.writeFileSync(output, `${JSON.stringify({
            kind: 'login-sample', platform: 'douyin', appId: 'tt76340089e939a1bf02',
            url, loginFrameHex: rawFrameHex, capturedAt,
          }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          io.log(`已捕获主机：${target.hostname}`);
          io.log(`样本已保存：${output}`);
          outcome({ code: 0, message: '样本尚需协议验证，未添加账号。' });
        } catch {
          outcome({ code: 1, message: '登录样本保存失败；未添加账号。' });
        }
      },
    });
    await Promise.race([proxy.listen(), finished]);
    if (!done) {
      stage = '检查遗留采集代理（如未恢复，请先运行 node tools/proxy-settings.mjs restore）';
      proxySettings = prepareCaptureProxy(settings, port);
      stage = '备份并设置当前用户系统代理';
      proxySettings.enable();
      io.log('采集已就绪。现在打开 Windows 抖音中的《疯狂水世界》；已开着的游戏请退出后重新进入。');
      io.log('正在等待登录样本，Ctrl+C 可停止并还原设置。');
    }
    const result = await finished;
    exitCode = result.code;
    io.log(result.message);
  } catch (error) {
    if (done) {
      const result = await finished;
      io.log(result.message);
      exitCode = result.code;
    } else {
      if (['CW_MISSING_CA_FILE', 'CW_CA_TRUST', 'CW_CA_VIEW'].includes(error.code)) io.error(error.message);
      io.error(`${stage}失败，正在还原本次系统改动。`);
      exitCode = 1;
    }
  } finally {
    done = true;
    if (timer !== undefined) cancelTimer(timer);
    // 先还原代理，避免停止监听后系统仍指向已关闭端口。
    if (proxySettings) {
      try {
        proxySettings.restore();
        io.log('本次代理改动已清理。');
      } catch {
        cleanupFailed = true;
        io.error('系统代理还原失败，请运行 node tools/proxy-settings.mjs restore 并检查 Windows 代理设置。');
      }
    }
    try {
      await proxy?.stop();
    } catch {
      cleanupFailed = true;
      io.error('本地采集代理未能正常关闭，请结束此进程。');
    }
    if (removeCa) {
      let removed = false;
      try {
        if (ca.isInstalled()) ca.uninstallCa();
        if (ca.isInstalled()) throw new Error('CA removal verification');
        removed = true;
        io.log('本次安装的测试 CA 已移除。');
      } catch {
        cleanupFailed = true;
        io.error('本次测试 CA 移除失败，请运行 node tools/mitm-ca.mjs uninstall 并检查证书存储。');
      }
      if (removed) {
        try { ca.removeCaFiles?.(); io.log('本次生成的本地测试证书文件已清理。'); }
        catch {
          cleanupFailed = true;
          io.error('本地测试证书文件清理失败，请手动删除项目的 certificates 目录。');
        }
      }
    }
    if (releaseLock) await releaseLock();
    for (const [event, handler] of handlers) runtime.removeListener(event, handler);
  }
  return cleanupFailed ? 1 : exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error('采集未能启动。');
    process.exitCode = 1;
  });
}
