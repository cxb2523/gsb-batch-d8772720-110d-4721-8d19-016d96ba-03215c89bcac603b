// Entirely local: no system proxy changes, trust-store changes, or ~/.cw-ca files.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { acquireCaptureLock } from './capture-lock.mjs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { runOpenSsl } from './mitm-ca.mjs';

const TIMEOUT_MS = 5000;
const sockets = new Set();
const servers = [];
const proxies = [];
const originalReadFileSync = fs.readFileSync;
let protocolReads = 0;
let tempDir = null;

// Simulate the missing extracted protocol even on a checkout where it exists.
fs.readFileSync = function readWithoutProtocol(file, ...args) {
  if (path.basename(String(file)) === 'game.js') {
    protocolReads += 1;
    throw Object.assign(new Error('selftest: extracted game.js is unavailable'), { code: 'ENOENT' });
  }
  return originalReadFileSync.call(this, file, ...args);
};

function track(socket) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  // Individual readers handle errors; keep teardown errors from going unhandled.
  socket.on('error', () => {});
  return socket;
}

function waitForClose(socket) {
  return new Promise((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      reject(new Error('pending upgrade socket did not close after proxy.stop()'));
    }, TIMEOUT_MS);
    // Reset errors are expected when stop destroys an unfinished TLS request.
    socket.once('close', onClose);
  });
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.error = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.check();
    };
    this.onError = (error) => {
      this.error = error;
      this.check();
    };
    this.onClose = () => this.onError(new Error('socket closed before expected test data'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  check() {
    if (!this.pending) return;
    const { sizeOf, resolve, reject, timer } = this.pending;
    const size = sizeOf(this.buffer);
    if (size === null && !this.error) return;
    this.pending = null;
    clearTimeout(timer);
    if (size === null) reject(this.error);
    else {
      const value = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      resolve(value);
    }
  }

  read(sizeOf) {
    assert.equal(this.pending, null, 'only one pending read per socket');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('local socket test timed out'));
      }, TIMEOUT_MS);
      this.pending = { sizeOf, resolve, reject, timer };
      this.check();
    });
  }

  headers() {
    return this.read((buffer) => {
      const end = buffer.indexOf('\r\n\r\n');
      return end < 0 ? null : end + 4;
    });
  }

  bytes(length) {
    return this.read((buffer) => buffer.length >= length ? length : null);
  }

  detach() {
    assert.equal(this.pending, null);
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    assert.equal(this.buffer.length, 0, 'no buffered bytes lost when switching to TLS');
  }
}

async function listen(server, host) {
  servers.push(server);
  server.on('connection', track);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

function gameFrame(name, seq, { compressed = false, payload = Buffer.alloc(300, 0xff) } = {}) {
  const header = Buffer.alloc(10 + Buffer.byteLength(name) + (compressed ? 5 : 1));
  header.writeInt32BE(header.length + payload.length - 4, 0);
  header.writeUInt8(2, 4);
  header.writeInt32BE(seq, 5);
  header.writeUInt8(Buffer.byteLength(name), 9);
  header.write(name, 10, 'ascii');
  header.writeUInt8(compressed ? 1 : 0, 10 + name.length);
  if (compressed) header.writeInt32BE(4096, 11 + name.length);
  return Buffer.concat([header, payload]);
}

function wsFrame(payload, { opcode = 2, fin = true } = {}) {
  assert.ok(payload.length < 65536);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

async function connectTunnel(proxyPort, host, upstreamPort, head = Buffer.alloc(0)) {
  const socket = track(net.connect({ port: proxyPort, host: '127.0.0.1' }));
  const reader = new SocketReader(socket);
  socket.write(Buffer.concat([
    Buffer.from(`CONNECT ${host}:${upstreamPort} HTTP/1.1\r\nHost: ${host}:${upstreamPort}\r\n\r\n`),
    head,
  ]));
  assert.match((await reader.headers()).toString(), /^HTTP\/1\.1 200 /);
  return { socket, reader };
}

async function connectWs(proxyPort, upstreamPort, cert, head = Buffer.alloc(0), { waitForUpgrade = true } = {}) {
  const tunnel = await connectTunnel(proxyPort, 'localhost', upstreamPort);
  tunnel.reader.detach();
  const socket = track(tls.connect({ socket: tunnel.socket, servername: 'localhost', ca: cert }));
  const reader = new SocketReader(socket);
  const key = crypto.randomBytes(16).toString('base64');
  const request = Buffer.from([
    'GET /ws?channel=fixture HTTP/1.1',
    `Host: localhost:${upstreamPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13', '', '',
  ].join('\r\n'));
  // One write places the first WS frame in the HTTP upgrade event's head buffer.
  socket.write(Buffer.concat([request, head]));
  if (waitForUpgrade) assert.match((await reader.headers()).toString(), /^HTTP\/1\.1 101 /);
  return { socket, reader };
}

try {
  const { createProxy } = await import('./mitm-proxy.mjs');
  const { inspectGameFrame } = await import('../src/frame-header.mjs');
  const first = gameFrame('LoginRequest', 7);
  const compressed = gameFrame('LoginRequest', 8, { compressed: true });
  for (const [frame, seq, flag] of [[first, 7, 0], [compressed, 8, 1]]) {
    const parsed = inspectGameFrame(frame);
    assert.ok(parsed);
    assert.equal(parsed.name, 'LoginRequest');
    assert.equal(parsed.seq, seq);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.flag, flag);
    assert.equal(parsed.payloadOffset, 10 + 'LoginRequest'.length + (flag ? 5 : 1));
    const padded = Buffer.concat([Buffer.alloc(5), frame, Buffer.alloc(3)]);
    assert.deepEqual(inspectGameFrame(padded.subarray(5, 5 + frame.length)), parsed, 'respect Buffer byteOffset');
  }
  assert.equal(inspectGameFrame(Buffer.alloc(4)), null, 'reject truncated header');
  const wrongLength = Buffer.from(first);
  wrongLength.writeInt32BE(1, 0);
  assert.equal(inspectGameFrame(wrongLength), null, 'reject declared length mismatch');
  const wrongVersion = Buffer.from(first);
  wrongVersion[4] = 3;
  assert.equal(inspectGameFrame(wrongVersion), null, 'reject unknown protocol version');

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-raw-capture-'));
  const lockAddress = process.platform === 'win32' ? `//./pipe/cw-test-${crypto.randomUUID()}` : path.join(tempDir, 'test.sock');
  const release = await acquireCaptureLock(lockAddress);
  try {
    const lockModule = new URL('./capture-lock.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { acquireCaptureLock } from ${JSON.stringify(lockModule)};
      await assert.rejects(acquireCaptureLock(process.argv[1]), /采集锁不可用/);
    `, lockAddress], { timeout: TIMEOUT_MS });
  } finally { await release(); }
  await (await acquireCaptureLock(lockAddress))();

  // Reproduce the portable directory layout without touching the installed CA.
  const testTools = path.join(tempDir, 'repo', 'tools');
  fs.mkdirSync(testTools, { recursive: true });
  for (const file of ['mitm-ca.mjs', 'import-user-root.cs']) {
    fs.copyFileSync(new URL('./' + file, import.meta.url), path.join(testTools, file));
  }
  const caModule = pathToFileURL(path.join(testTools, 'mitm-ca.mjs')).href;
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -Path $env:CW_CAPTURE_WIZARD; [void][CaptureCertificateWizard]"], {
      env: { ...process.env, CW_CAPTURE_WIZARD: path.join(import.meta.dirname, 'import-user-root.cs') },
    });
  }
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { CA_DIR, initCa, prepareLeaf, installCa, caThumbprint, verifyRootView, removeCaFiles } from ${JSON.stringify(caModule)};
    assert.equal(CA_DIR, path.join(process.argv[1], 'repo', 'certificates'));
    if (process.platform === 'win32') {
      // No certificate exists: the native helper must fail before opening the store.
      await assert.rejects(installCa(), { code: 'CW_CA_TRUST' });
    }
    initCa();
    if (process.platform === 'win32') {
      await assert.rejects(verifyRootView(async () => true), { code: 'CW_CA_VIEW' });
      await verifyRootView(async () => false);
    }
    let checks = 0;
    const add = async () => {};
    const wait = async () => {};
    assert(await installCa({ add, wait, check: () => ++checks === 3 }));
    assert.equal(checks, 3);
    await assert.rejects(installCa({ add, wait, check: () => false }), (err) =>
      err.code === 'CW_CA_TRUST' && err.message.includes(caThumbprint()));
    const denied = new Error('denied');
    await assert.rejects(installCa({ add: () => { throw denied; }, check: () => assert.fail() }), (err) => err === denied);
    prepareLeaf('fixture.example');
    fs.unlinkSync(path.join(CA_DIR, 'leaf.key'));
    assert.throws(() => prepareLeaf('other.example'), /leaf[.]key/);
    removeCaFiles();
    assert.equal(fs.existsSync(CA_DIR), false);
  `, tempDir], { env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir }, timeout: 30000 });

  const keyPath = path.join(tempDir, 'test.key');
  const certPath = path.join(tempDir, 'test.crt');
  runOpenSsl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost',
  ]);
  const cert = fs.readFileSync(certPath);
  const keyPem = fs.readFileSync(keyPath);
  const upstream = https.createServer({ cert, key: keyPem });
  upstream.on('upgrade', (req, socket, head) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // This intentionally echoes bytes, including masking, for exact transport checks.
    if (head.length) socket.write(head);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream, 'localhost');
  const echoPort = await listen(net.createServer((socket) => socket.pipe(socket)), '127.0.0.1');
  let certificateCalls = 0;
  async function startProxy(records, interceptPorts = [upstreamPort, echoPort]) {
    const proxy = createProxy({
      port: 0,
      rawLogin: true,
      interceptHosts: ['localhost'],
      interceptPorts,
      upstreamCa: cert,
      certificateFor(host) {
        assert.equal(host, 'localhost');
        certificateCalls += 1;
        return { cert, keyPem };
      },
      caIsInstalled: () => true,
      onLogin: (record) => records.push(record),
    });
    proxies.push(proxy);
    await proxy.listen();
    assert.ok(proxy.port > 0, 'port getter must report the ephemeral listening port');
    return proxy;
  }

  const headRecords = [];
  const headProxy = await startProxy(headRecords);
  const reused = new Set();
  upstream.on('request', (req, res) => { reused.add(req.socket); res.end('ok'); });
  // Inspect the upstream agent's free socket after each real proxied request.
  let expectedListeners;
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: headProxy.port, path: `https://localhost:${upstreamPort}/ping` }, (res) => {
        assert.equal(res.statusCode, 200);
        res.resume().once('end', resolve);
      }).once('error', reject);
    });
    const socket = Object.values(https.globalAgent.freeSockets).flat().find((item) => item.remotePort === upstreamPort);
    assert(socket, 'upstream socket must be available for reuse');
    expectedListeners ??= socket.listenerCount('close');
    assert.equal(socket.listenerCount('close'), expectedListeners, 'reusing the upstream socket must not accumulate close listeners');
  }
  assert.equal(reused.size, 1);
  const initialWsFrame = wsFrame(first);
  const headClient = await connectWs(headProxy.port, upstreamPort, cert, initialWsFrame);
  assert.deepEqual(await headClient.reader.bytes(initialWsFrame.length), initialWsFrame, 'upgrade head reaches upstream intact');
  assert.equal(headRecords.length, 1, 'capture LoginRequest contained in upgrade head');
  assert.equal(headRecords[0].name, 'LoginRequest');
  assert.equal(headRecords[0].url, `wss://localhost:${upstreamPort}/ws?channel=fixture`);
  assert.equal(headRecords[0].rawFrameHex, first.toString('hex'), 'preserve undecodable protobuf bytes');
  assert.ok(headRecords[0].body == null, 'raw capture must not fabricate a decoded login body');
  const duplicate = wsFrame(gameFrame('LoginRequest', 9));
  headClient.socket.write(duplicate);
  assert.deepEqual(await headClient.reader.bytes(duplicate.length), duplicate);
  assert.equal(headRecords.length, 1, 'emit onLogin only once per proxy');

  const fragmentRecords = [];
  const fragmentProxy = await startProxy(fragmentRecords);
  const fragmentClient = await connectWs(fragmentProxy.port, upstreamPort, cert);
  const ignored = Buffer.concat([wsFrame(gameFrame('PingRequest', 2)), wsFrame(wrongLength)]);
  fragmentClient.socket.write(ignored);
  assert.deepEqual(await fragmentClient.reader.bytes(ignored.length), ignored);
  assert.equal(fragmentRecords.length, 0, 'ignore other messages and malformed game headers');
  const firstFragment = wsFrame(compressed.subarray(0, 20), { fin: false });
  const rest = Buffer.concat([
    wsFrame(Buffer.from('p'), { opcode: 9 }),
    wsFrame(compressed.subarray(20, 230), { opcode: 0, fin: false }),
    wsFrame(compressed.subarray(230), { opcode: 0 }),
  ]);
  fragmentClient.socket.write(firstFragment.subarray(0, 1));
  fragmentClient.socket.write(firstFragment.subarray(1, 3));
  fragmentClient.socket.write(firstFragment.subarray(3));
  fragmentClient.socket.write(rest);
  const wireFragments = Buffer.concat([firstFragment, rest]);
  assert.deepEqual(await fragmentClient.reader.bytes(wireFragments.length), wireFragments, 'forward fragments and control frame intact');
  assert.equal(fragmentRecords.length, 1, 'reassemble masked fragments around ping');
  assert.equal(fragmentRecords[0].rawFrameHex, compressed.toString('hex'), 'preserve compressed payload without decoding');

  const callsBeforeTunnel = certificateCalls;
  const rawPayload = Buffer.from('raw-not-tls\x00\xff', 'latin1');
  const transparent = await connectTunnel(fragmentProxy.port, '127.0.0.1', echoPort, rawPayload);
  assert.deepEqual(await transparent.reader.bytes(rawPayload.length), rawPayload, 'non-target host passes through even on an intercepted port');
  assert.equal(certificateCalls, callsBeforeTunnel, 'non-target host does not request a certificate');

  // An upstream may accept TLS and Upgrade but never send its HTTP 101 response.
  // Stopping the proxy must close that pending request and both ends of its socket.
  const stalledUpstream = https.createServer({ cert, key: keyPem });
  const stalledPort = await listen(stalledUpstream, 'localhost');
  const stalledProxy = await startProxy([], [stalledPort]);
  const upgradeReceived = once(stalledUpstream, 'upgrade', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const stalledClient = await connectWs(stalledProxy.port, stalledPort, cert, Buffer.alloc(0), { waitForUpgrade: false });
  const [, stalledSocket] = await upgradeReceived;
  stalledSocket.on('error', () => {});
  assert.equal(stalledSocket.destroyed, false, 'upstream upgrade must still be pending before stop');
  const closed = Promise.all([
    waitForClose(stalledSocket),
    waitForClose(stalledClient.socket),
  ]);
  await Promise.all([stalledProxy.stop(), closed]);
  assert.equal(stalledSocket.destroyed, true, 'stop destroys the unanswered upgrade connection');
  const connections = await new Promise((resolve, reject) => {
    stalledUpstream.getConnections((error, count) => error ? reject(error) : resolve(count));
  });
  assert.equal(connections, 0, 'stalled upstream has no remaining connections after stop');
  assert.equal(protocolReads, 0, 'raw import and capture never read extracted game.js');
  console.log('raw capture selftest ok: cross-process lock, leaf preflight, keep-alive socket reuse, no protocol bundle, upgrade head, raw bytes, masked fragments, one callback, host-scoped tunnel, stalled upgrade cleanup');
} finally {
  fs.readFileSync = originalReadFileSync;
  for (const socket of sockets) socket.destroy();
  for (const proxy of proxies) await proxy.stop();
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (tempDir) {
    const resolved = path.resolve(tempDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cw-raw-capture-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
