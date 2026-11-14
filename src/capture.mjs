// Current-user capture lifecycle. Creating/importing a controller changes no system settings.
import * as defaultCa from '../tools/mitm-ca.mjs';
import * as defaultSettings from '../tools/proxy-settings.mjs';
import { createProxy as defaultCreateProxy, DEFAULT_PROXY_PORT } from '../tools/mitm-proxy.mjs';
import { pointsToCapture, prepareCaptureProxy } from '../tools/proxy-settings.mjs';
import { acquireCaptureLock } from '../tools/capture-lock.mjs';
import { DEFAULT_GATEWAY } from './client.mjs';

export const DEFAULT_CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const GATEWAY = new URL(DEFAULT_GATEWAY);
export function createCaptureController(dependencies = {}) {
  const acquireLock = dependencies.acquireLock ?? acquireCaptureLock;
  const ca = dependencies.ca ?? defaultCa;
  const settings = dependencies.proxySettings ?? defaultSettings;
  const createProxy = dependencies.createProxy ?? defaultCreateProxy;
  const runtime = dependencies.process ?? process;
  const later = dependencies.setTimeout ?? setTimeout;
  const cancelTimer = dependencies.clearTimeout ?? clearTimeout;
  const now = dependencies.now ?? (() => new Date());
  const defaultPort = dependencies.port ?? DEFAULT_PROXY_PORT;
  const state = {
    running: false, phase: 'idle', error: null, port: defaultPort,
    originalProxy: null, caAddedByCapture: false, caInstalledBefore: false,
    capturedAt: null, accountId: null, startedAt: null, log: [],
  };
  let current = null;
  let latest = null;

  function note(line, run = latest) {
    if (run && run !== latest) return;
    state.log.push({ t: now().toISOString(), line });
    if (state.log.length > 200) state.log.shift();
    // UI logging cannot prevent rollback or turn a captured credential into an exception.
    try { run?.onLog?.(line); } catch {}
  }

  function captureState() {
    let proxy = null;
    let fingerprint = null;
    let thumbprint = null;
    let caInstalled = false;
    let caQueryError = null;
    try { proxy = { ...settings.readCurrent() }; } catch {}
    try { caInstalled = ca.isInstalled(); } catch (error) { caQueryError = error.message; }
    try { fingerprint = ca.caFingerprint(); } catch {}
    try { thumbprint = ca.caThumbprint(); } catch {}
    return {
      running: state.running, phase: state.phase, error: state.error, port: state.port, platform: state.platform ?? 'wechat',
      caInstalled, caQueryError, caInstalledBefore: state.caInstalledBefore,
      caAddedByCapture: state.caAddedByCapture,
      proxy, proxyOn: Number(proxy?.ProxyEnable) === 1,
      originalProxy: state.originalProxy ? { ...state.originalProxy } : null,
      accountId: state.accountId, capturedAt: state.capturedAt, startedAt: state.startedAt,
      log: state.log.slice(-40).map((entry) => entry.line),
      ca: { cn: ca.CA_CN, crt: ca.CA_CRT, fingerprint, thumbprint },
    };
  }

  function cleanupError(run, message) {
    if (latest === run) state.error = state.error ? `${state.error} ${message}` : message;
    note(message, run);
  }

  function restoreProxy(run) {
    if (!run.proxySettings) return;
    try {
      run.proxySettings.restore();
      run.proxySettings = null;
      note('本次代理改动已清理。', run);
    } catch {
      cleanupError(run, '系统代理还原失败，请停止其他采集任务后重试停止，并检查 Windows 代理设置。');
    }
  }

  function restoreCa(run) {
    if (!run.caAdded) return;
    const addedHere = run.caAdded;
    if (run.keepCa && run.ready) {
      run.caAdded = false;
      if (latest === run) state.caAddedByCapture = false;
      note('已按选项保留本次安装的测试 CA。', run);
      return;
    }
    try {
      // A failed install may have stopped before writing anything to the trust store.
      const present = ca.isInstalled();
      if (present) ca.uninstallCa();
      if (ca.isInstalled()) throw new Error('CA removal verification');
      run.caAdded = false;
      if (latest === run) state.caAddedByCapture = false;
      note(present ? '本次安装的测试 CA 已移除。' : '本进程未查到测试 CA，未执行删除。', run);
      if (addedHere) {
        try { ca.removeCaFiles?.(); note('本次生成的本地测试证书文件已清理。', run); }
        catch { cleanupError(run, '本次测试证书文件清理失败，请手动删除项目的 certificates 目录。'); }
      }
    } catch {
      cleanupError(run, '本次测试 CA 移除失败，请重试停止或运行 node tools/mitm-ca.mjs uninstall。');
    }
  }

  function removeHooks(run) {
    for (const [event, handler] of run.handlers) runtime.removeListener(event, handler);
    run.handlers.clear();
  }

  function stopRun(run, reason) {
    if (!run || run.finished) return Promise.resolve(captureState());
    run.cancelled = true;
    run.installAbort.abort(new Error('采集已停止'));
    if (run.timer !== undefined) { cancelTimer(run.timer); run.timer = undefined; }
    if (run.cleanupPromise) return run.cleanupPromise;
    if (latest === run) state.phase = 'stopping';
    note(`停止抓包（${reason}）`, run);
    run.cleanupPromise = (async () => {
      // Setup may be awaiting listen(); it must observe cancelled before setting the proxy.
      await run.setupFinished;
      restoreProxy(run);
      try {
        await run.proxy?.stop();
        run.proxy = null;
      } catch {
        cleanupError(run, '本地采集代理关闭失败，请重试停止。');
      }
      restoreCa(run);
      const clean = !run.proxySettings && !run.caAdded && !run.proxy;
      if (clean && run.releaseLock) await run.releaseLock();
      if (latest === run) {
        state.running = false;
        state.phase = clean ? 'idle' : 'error';
      }
      if (clean) {
        run.finished = true;
        removeHooks(run);
        if (current === run) current = null;
      } else {
        // Keep both the original snapshot and exit hooks available for another cleanup attempt.
        run.cleanupPromise = null;
      }
      return captureState();
    })();
    return run.cleanupPromise;
  }

  function stopCapture(reason = '停止') {
    return stopRun(current, reason);
  }

  function installHooks(run) {
    const onExit = () => {
      run.cancelled = true;
      // Node's exit event cannot await; registry and CA changes are synchronous.
      restoreProxy(run);
      if (!run.installPending) restoreCa(run);
    };
    run.handlers.set('exit', onExit);
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      run.handlers.set(signal, () => {
        // Restore immediately even if closing a socket later fails or stalls.
        onExit();
        void stopRun(run, signal).finally(() => runtime.exit(code));
      });
    }
    for (const [event, handler] of run.handlers) runtime.on(event, handler);
  }

  async function startCapture({
    onLogin, onLog, port = defaultPort, keepCa = false, timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS, platform = 'wechat',
  } = {}) {
    if (current) return captureState();
    let finishSetup;
    const run = {
      onLog, keepCa, proxy: null, proxySettings: null, releaseLock: null, caAdded: false,
      cancelled: false, finished: false, ready: false, captured: false, timer: undefined,
      handlers: new Map(), cleanupPromise: null,
      installAbort: new AbortController(),
      setupFinished: new Promise((resolve) => { finishSetup = resolve; }),
    };
    current = run;
    latest = run;
    Object.assign(state, {
      running: true, phase: 'starting', error: null, port, originalProxy: null, platform,
      caAddedByCapture: false, caInstalledBefore: false,
      accountId: null, capturedAt: null, startedAt: now().toISOString(), log: [],
    });
    let stage = '检查采集设置';
    let failed = false;
    try {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须是 1–65535 的整数');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error('采集超时必须在 1–86400000 毫秒之间');
      run.releaseLock = await acquireLock();
      if (run.cancelled) throw new Error('启动已取消');
      state.originalProxy = { ...settings.readCurrent() };
      if (pointsToCapture(state.originalProxy, port)) {
        throw new Error('系统代理已指向本机采集端口；请先恢复上次的代理设置，避免覆盖原始备份');
      }
      state.caInstalledBefore = ca.isInstalled();
      installHooks(run);
      run.timer = later(() => {
        if (run.finished || run.cancelled) return;
        if (latest === run) state.error = '采集超时，未完成登录报文采集与处理；已停止并还原设置。';
        void stopRun(run, '等待超时');
      }, timeoutMs);

      // Constructing decoded-mode proxy checks the extracted game protocol before trust changes.
      stage = '加载游戏协议';
      run.proxy = createProxy({
        port, interceptHosts: [GATEWAY.hostname], interceptPorts: [Number(GATEWAY.port || 443)],
        log: (kind) => {
          if (kind === 'upgrade') note('正在检查游戏网关的 WebSocket 登录报文。', run);
        },
        onLogin: async (record) => {
          if (run.cancelled || run.captured || current !== run) return;
          let target;
          try { target = new URL(record.url); } catch { return; }
          if (target.protocol !== GATEWAY.protocol || target.hostname !== GATEWAY.hostname
            || Number(target.port || 443) !== Number(GATEWAY.port || 443) || record.name !== 'LoginRequest') return;
          run.captured = true;
          state.capturedAt = now().toISOString();
          state.phase = 'captured';
          note('已采集登录报文，正在处理；实际登录结果需由游戏服务器确认。', run);
          try {
            const result = await onLogin?.(record);
            if (latest === run) state.accountId = result?.id ?? null;
          } catch {
            if (latest === run) state.error = '登录报文保存或处理失败。';
            note('登录报文保存或处理失败。', run);
          } finally {
            // Do not await this callback from stopRun: existing server callbacks themselves stop.
            await stopRun(run, '登录报文处理结束');
          }
        },
      });
      state.phase = 'ca';
      stage = '准备当前用户测试 CA';
      ca.initCa();
      ca.prepareLeaf(GATEWAY.hostname);
      if (!state.caInstalledBefore) {
        await ca.verifyRootView?.();
        if (run.cancelled) throw new Error('采集启动已取消');
        // certutil can install a certificate and subsequently fail; always own that rollback.
        run.caAdded = true;
        state.caAddedByCapture = true;
        run.installPending = true;
        try {
          await ca.installCa({ signal: run.installAbort.signal });
        } finally {
          run.installPending = false;
        }
        if (!ca.isInstalled()) throw new Error('安装后未能确认当前测试 CA');
      }
      if (run.cancelled) throw new Error('采集启动已取消');
      stage = '启动本地采集代理';
      state.phase = 'listening';
      await run.proxy.listen();
      if (!run.cancelled) {
        stage = '设置当前用户系统代理';
        state.phase = 'proxy';
        run.proxySettings = prepareCaptureProxy(settings, port);
        state.originalProxy = { ...run.proxySettings.original };
        run.proxySettings.enable();
        run.ready = true;
        state.phase = 'waiting';
        note('采集已就绪，请在电脑' + (platform === 'douyin' ? '抖音' : '微信') + '中重新打开《疯狂水世界》。', run);
      }
    } catch (error) {
      failed = true;
      state.error = `${stage}失败：${error.message}`;
      note(state.error, run);
    } finally {
      finishSetup();
    }
    if (failed || run.cancelled) await stopRun(run, failed ? '启动失败' : '启动已取消');
    return captureState();
  }

  return { captureState, startCapture, stopCapture };
}

const controller = createCaptureController();
export const captureState = controller.captureState;
export const startCapture = controller.startCapture;
export const stopCapture = controller.stopCapture;
export { DEFAULT_PROXY_PORT };
