// 本机 MITM 代理：解 TLS 后把游戏网关的 WebSocket 帧读出来，抓到 LoginRequest 就回调。
//
// 做成工厂是因为两个地方都要用它：命令行抓包工具（tools/capture-credentials.mjs）和
// 网页控制台（src/capture.mjs）。代理本身不碰文件、不碰注册表，只负责监听与解密；
// 「装证书、改系统代理、回滚」这些系统改动由调用方负责。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { leafFor, isInstalled } from './mitm-ca.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { createCodec } from '../src/codec.mjs';
import { inspectGameFrame } from '../src/frame-header.mjs';

// 与控制台默认端口分开：控制台 17321，代理 17322。
export const DEFAULT_PROXY_PORT = Number(process.env.CW_PROXY_PORT ?? 17322);
let codec;
function defaultCodec() {
  return codec ??= createCodec(loadProtocol());
}

export function decodeWsFrame(bytes) {
  if (!inspectGameFrame(bytes)) return null;
  try {
    return defaultCodec().decode(bytes);
  } catch {
    return null;
  }
}

function makeFrameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentedOpcode = null;
  let fragmentedLength = 0;
  let failed = false;
  const maxMessageBytes = 16 * 1024 * 1024;
  return (chunk) => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      // Extensions (including permessage-deflate) are not negotiated by this proxy.
      if (buffer[0] & 0x70) { failed = true; buffer = Buffer.alloc(0); return; }
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wideLength = buffer.readBigUInt64BE(2);
        if (wideLength > BigInt(maxMessageBytes)) { failed = true; buffer = Buffer.alloc(0); return; }
        length = Number(wideLength);
        offset = 10;
      }
      if (length > maxMessageBytes) { failed = true; buffer = Buffer.alloc(0); return; }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        onMessage({ opcode, payload });
        return;
      }
      if (opcode === 0x9 || opcode === 0xa) continue;
      if (opcode === 1 || opcode === 2) {
        if (fragmentedOpcode !== null) { failed = true; return; }
        fragmentedOpcode = opcode;
      } else if (opcode !== 0 || fragmentedOpcode === null) {
        failed = true;
        return;
      }
      fragmentedLength += payload.length;
      if (fragmentedLength > maxMessageBytes) { failed = true; fragments = []; return; }
      fragments.push(payload);
      if (fin) {
        onMessage({ opcode: fragmentedOpcode, payload: Buffer.concat(fragments) });
        fragments = [];
        fragmentedOpcode = null;
        fragmentedLength = 0;
      }
    }
  };
}

// onLogin 收到 { url, name, body, rawFrameHex }，只会在本次运行里触发一次。
// rawLogin 仅保留原始报文，body 为 null，不代表已验证账号或支持抖音登录。
// onFrame 可选，用来把下行帧也记下来（调试用）。
export function createProxy({
  port = DEFAULT_PROXY_PORT, onLogin, onFrame, log = () => {}, interceptPorts,
  rawLogin = false, interceptHosts,
  certificateFor = leafFor, caIsInstalled = isInstalled, upstreamCa,
} = {}) {
  // Fail before changing any settings in decoded mode; raw mode needs no game bundle.
  const decoder = rawLogin ? null : defaultCodec();
  const hosts = interceptHosts === undefined ? null
    : new Set(interceptHosts.map((host) => host.toLowerCase()));
  const intercept = new Set(interceptPorts ?? (process.env.CW_INTERCEPT_PORTS ?? '443').split(',').map((text) => Number(text.trim())));
  const tlsServers = new Map();
  const liveSockets = new Set();
  const requests = new Set();
  let captured = false;
  let started = false;

  const httpServer = http.createServer(onRequest);
  httpServer.on('upgrade', onUpgrade);
  httpServer.on('connect', onConnect);
  function trackSocket(socket) {
    if (liveSockets.has(socket)) return socket;
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
    return socket;
  }
  httpServer.on('connection', trackSocket);

  function trackRequest(request) {
    requests.add(request);
    request.on('close', () => requests.delete(request));
    request.on('socket', trackSocket);
    return request;
  }

  function handleLogin(url, name, body, rawFrame) {
    if (captured) return;
    captured = true;
    try {
      Promise.resolve(onLogin?.({ url, name, body: body == null ? null : JSON.parse(JSON.stringify(body)), rawFrameHex: Buffer.from(rawFrame).toString('hex') }))
        .catch((error) => log('capture', `处理登录包失败: ${error.message}`));
    } catch (error) {
      log('capture', `处理登录包失败: ${error.message}`);
    }
  }

  function attachWebSocketLogging(socket, direction, context) {
    const reader = makeFrameReader(({ opcode, payload }) => {
      if (opcode === 0x8) {
        log('ws', `${context} 连接关闭`);
        return;
      }
      let decoded = inspectGameFrame(payload);
      if (decoded && decoder) {
        try { decoded = decoder.decode(payload); } catch { decoded = null; }
      }
      if (decoded && direction === 'up' && decoded.name === 'LoginRequest') handleLogin(context, decoded.name, decoded.body, payload);
      if (!decoded) return;
      if (direction === 'up') log('ws', `${context} 上行 ${decoded.name} seq=${decoded.seq}`);
      else log('ws', `${context} 下行 ${decoded.name} seq=${decoded.seq}`);
      onFrame?.({ direction, context, name: decoded.name, seq: decoded.seq, body: decoded.body });
    });
    socket.on('data', reader);
    return reader;
  }

  function tlsServerFor(host, targetPort) {
    const key = `${host}:${targetPort}`;
    if (tlsServers.has(key)) return tlsServers.get(key);
    const { cert, keyPem } = certificateFor(host);
    const server = tls.createServer({ cert, key: keyPem }, (socket) => {
      socket._target = { host, port: targetPort };
      httpServer.emit('connection', socket);
    });
    server.on('tlsClientError', (error) => log('tls', `${key} 客户端错误: ${error.message}`));
    tlsServers.set(key, server);
    return server;
  }

  function onConnect(req, clientSocket, head) {
    let target;
    try { target = new URL(`https://${req.url}`); }
    catch { clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const targetPort = Number(target.port || 443);
    const key = `${host}:${targetPort}`;
    log('connect', key);
    clientSocket.on('error', () => {});

    // 只解密我们要的端口，其它流量原样隧道转发，免得影响无关程序。
    if (!intercept.has(targetPort) || (hosts && !hosts.has(host.toLowerCase()))) {
      const upstream = trackSocket(net.connect(targetPort, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      }));
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.unshift(head);
    try { tlsServerFor(host, targetPort).emit('connection', clientSocket); }
    catch (error) { log('tls', `生成目标证书失败: ${error.message}`); clientSocket.destroy(); }
  }

  function onRequest(req, res) {
    let target = req.socket._target;
    let requestPath = req.url;
    if (!target && /^https?:\/\//i.test(req.url)) {
      const url = new URL(req.url);
      target = { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
      requestPath = `${url.pathname}${url.search}`;
    }
    if (!target) {
      res.writeHead(502);
      res.end('proxy: no target');
      return;
    }
    const secure = target.port !== 80;
    const transport = secure ? https : http;
    log('http', `${req.method} ${secure ? 'https' : 'http'}://${target.host}:${target.port}${requestPath}`);

    const upstream = trackRequest(transport.request({
      host: target.host,
      port: target.port,
      path: requestPath,
      method: req.method,
      headers: req.headers,
      servername: target.host,
      rejectUnauthorized: true,
      ...(upstreamCa ? { ca: upstreamCa } : {}),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }));
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.on('error', (error) => {
      log('http', `上游出错: ${error.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }

  function onUpgrade(req, clientSocket, head) {
    const target = req.socket._target;
    if (!target) {
      clientSocket.destroy();
      return;
    }
    const secure = target.port !== 80;
    const transport = secure ? https : http;
    const scheme = secure ? 'wss' : 'ws';
    const context = `${scheme}://${target.host}:${target.port}${req.url}`;
    log('upgrade', context);

    const headers = { ...req.headers };
    delete headers['sec-websocket-extensions'];
    const upstream = trackRequest(transport.request({
      host: target.host,
      port: target.port,
      path: req.url,
      method: 'GET',
      headers,
      servername: target.host,
      rejectUnauthorized: true,
      ...(upstreamCa ? { ca: upstreamCa } : {}),
    }));
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const headers = Object.entries(upstreamRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      const readDown = attachWebSocketLogging(upstreamSocket, 'down', context);
      const readUp = attachWebSocketLogging(clientSocket, 'up', context);

      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => clientSocket.destroy());
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      if (head && head.length) { readUp(head); upstreamSocket.write(head); }
      if (upstreamHead && upstreamHead.length) { readDown(upstreamHead); clientSocket.write(upstreamHead); }
    });
    upstream.on('error', (error) => {
      log('upgrade', `上游出错: ${error.message}`);
      clientSocket.destroy();
    });
    upstream.end();
  }

  return {
    get port() { return httpServer.address()?.port ?? port; },
    get captured() {
      return captured;
    },
    listen() {
      if (started) return Promise.resolve();
      started = true;
      if (!caIsInstalled()) log('warn', '当前用户根存储里没有本工具的 CA，请先安装再抓包');
      return new Promise((resolve, reject) => {
        const failed = (error) => { started = false; reject(error); };
        httpServer.once('error', failed);
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.removeListener('error', failed);
          log('start', `代理监听 127.0.0.1:${port}`);
          resolve();
        });
      });
    },
    // httpServer.close() 会等活连接自己结束，所以还要把连接都断掉。
    async stop() {
      if (!started) return;
      started = false;
      const closed = new Promise((resolve) => httpServer.close(() => resolve()));
      for (const request of requests) request.destroy();
      requests.clear();
      for (const socket of liveSockets) socket.destroy();
      liveSockets.clear();
      for (const server of tlsServers.values()) server.close();
      tlsServers.clear();
      await closed;
    },
  };
}

// 直接跑就起一个独立代理，把抓到的登录包写到 data/credentials.json。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const out = path.resolve(import.meta.dirname, '../data/credentials.json');
  const logFile = path.resolve(import.meta.dirname, '../data/capture.log');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const log = (kind, message) => {
    const line = `${new Date().toISOString()} [${kind}] ${message}`;
    console.log(line);
    stream.write(`${line}\n`);
  };
  const proxy = createProxy({
    log,
    onLogin: ({ url, body, rawFrameHex }) => {
      fs.writeFileSync(out, JSON.stringify({ url, login: body, loginFrameHex: rawFrameHex, source: 'mitm', capturedAt: new Date().toISOString() }, null, 2));
      log('capture', `已保存登录凭证 -> ${out}`);
    },
  });
  proxy.listen();
}
