/**
 * lib/http.js — 访问本机 Playwright 服务（127.0.0.1:8093）的唯一底层
 *
 * 为什么存在：135 个脚本各自抄了一份 http.request 样板，超时、非 JSON 响应、
 * 服务没启动这些错误处理各不相同，出错信息也各不相同。
 *
 * 用法：
 *   const { post, get, probe } = require('./lib/http');
 *   const r = await post('/api/agent/eval-on-store', { store, code }, { timeout: 240000 });
 */
const http = require('http');
const { SVC, serviceBase } = require('./env');
const reqGate = require('./req-gate');

const DEFAULT_TIMEOUT = 180000;

class ServiceError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'ServiceError';
    Object.assign(this, extra || {});
  }
}

async function request(method, path, body, opts) {
  opts = opts || {};

  // ── 请求预算闸门（2026-10-13 加，事故见 lib/req-gate.js 头部）──
  // 只拦 /api/agent/eval*：那才是真正消耗闲鱼请求配额、会触发风控疲劳限流的调用。
  // status / start-one / screenshot 只打本机 8093，拦了没意义还会添乱。
  // 挂在【这一层】而不是 lib/agent.js：lib/agent 自己也是走这里的，
  // 所以这样做同时覆盖「用 lib/agent 的脚本」和「直接 post eval-on-store 的脚本」。
  const gated = reqGate.isGatedPath(path);
  if (gated) await reqGate.check({ path, label: opts.label || path });

  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const payload = body === undefined || body === null ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const headers = { 'x-api-key': SVC.apiKey };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      // agent:false = 不用全局连接池。
      // 为什么必须：Node 19+ 的 http 全局 agent 默认 keepAlive=true，会把连接留着复用；
      // 而 8093 服务会重启（start.bat 的失败重启循环 / 我们手动重启），
      // 池子里的旧 socket 已经死了，复用就报 read ECONNRESET ——
      // 表现为「PowerShell 能访问、Node 却连不上」。这一坑踩过一次。
      { host: SVC.host, port: SVC.port, path, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (opts.raw) return resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
          const text = buf.toString('utf8');
          let data;
          try { data = JSON.parse(text); }
          catch (e) {
            return reject(new ServiceError(
              '服务返回的不是 JSON（HTTP ' + res.statusCode + '）：' + text.slice(0, 200),
              { status: res.statusCode, text }));
          }
          // 闸门：成功就复位退避计数；文本里带限流特征就进入指数退避。
          // 事故里 eval 的返回只有 `FAIL_SYS_SESSION_EXPIRED::Session过期`，
          // 所以识别规则必须把它算进去（详见 lib/req-gate.js）。
          if (gated) reqGate.noteOutcome(text);
          resolve({ status: res.statusCode, data });
        });
      }
    );

    req.on('error', (e) => {
      const hint = (e.code === 'ECONNREFUSED')
        ? 'Playwright 服务没在跑。先执行 start.bat 或 POST /api/agent/start-all。'
        : '';
      reject(new ServiceError('连不上 ' + serviceBase + '：' + e.message + (hint ? '  ' + hint : ''), { code: e.code }));
    });

    req.setTimeout(timeout, () => req.destroy(new ServiceError('请求超时 ' + timeout + 'ms：' + path)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** POST，返回 body.data；HTTP 非 2xx 抛错 */
async function post(path, body, opts) {
  const r = await request('POST', path, body, opts);
  if (r.status >= 400) {
    const msg = (r.data && (r.data.error || r.data.message)) || ('HTTP ' + r.status);
    throw new ServiceError(msg, { status: r.status, data: r.data });
  }
  return r.data;
}

async function get(path, opts) {
  const r = await request('GET', path, null, opts);
  if (r.status >= 400) {
    const msg = (r.data && (r.data.error || r.data.message)) || ('HTTP ' + r.status);
    throw new ServiceError(msg, { status: r.status, data: r.data });
  }
  return r.data;
}

/** GET 原始字节（截图用） */
async function getBuffer(path, opts) {
  const r = await request('GET', path, null, Object.assign({ raw: true }, opts || {}));
  if (r.status >= 400) throw new ServiceError('HTTP ' + r.status + '：' + r.buffer.toString('utf8').slice(0, 200));
  return r.buffer;
}

/** 服务活着吗？不抛错，返回布尔 */
async function alive() {
  try { await get('/api/agent/status', { timeout: 5000 }); return true; }
  catch (e) { return false; }
}

module.exports = { request, post, get, getBuffer, alive, ServiceError, serviceBase };
