import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProtocol } from '../src/proto.mjs';
import { createCodec } from '../src/codec.mjs';

const caTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mitm-ca-'));
const caTestDir = path.join(caTestRoot, 'certificates');
process.env.CW_CA_DIR = caTestDir;
const { initCa, leafFor, removeCaFiles } = await import('./mitm-ca.mjs');
initCa();

const PROXY_PORT = 17999;
const UPSTREAM_PORT = 18080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const codec = createCodec(loadProtocol());

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(payload, { mask = false } = {}) {
  const length = payload.length;
  const header = [];
  header.push(0x82);
  if (length < 126) header.push((mask ? 0x80 : 0) | length);
  else if (length < 65536) header.push((mask ? 0x80 : 0) | 126, length >> 8, length & 0xff);
  else header.push((mask ? 0x80 : 0) | 127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  const head = Buffer.from(header);
  if (!mask) return Buffer.concat([head, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4];
  return Buffer.concat([head, key, masked]);
}

function frameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
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
      onMessage({ opcode, payload });
    }
  };
}

const { cert, keyPem } = leafFor('127.0.0.1');
const upstream = https.createServer({ cert, key: keyPem }, (req, res) => {
  res.writeHead(200);
  res.end('plain');
});
upstream.on('upgrade', (req, socket) => {
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}`,
    '',
    '',
  ].join('\r\n'));
  const reply = codec.encode('LoginResponse', 1, { result: 0, initSeqNo: 100, playerInfo: { nickname: 'echo' } });
  socket.on('data', frameReader(() => socket.write(encodeFrame(reply))));
});

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));

const outPath = path.resolve(import.meta.dirname, '../data/credentials.json');
const { createProxy } = await import('./mitm-proxy.mjs');
const proxy = createProxy({
  port: PROXY_PORT, interceptPorts: [443, UPSTREAM_PORT], upstreamCa: fs.readFileSync(path.join(caTestDir, 'ca.crt')),
  onLogin: ({ url, body, rawFrameHex }) => {
    fs.writeFileSync(outPath, JSON.stringify({ url, login: body, loginFrameHex: rawFrameHex, source: 'mitm' }, null, 2));
  },
});
await proxy.listen();

const socket = await new Promise((resolve, reject) => {
  const raw = net.connect(PROXY_PORT, '127.0.0.1', () => {
    raw.write(`CONNECT 127.0.0.1:${UPSTREAM_PORT} HTTP/1.1\r\nHost: 127.0.0.1:${UPSTREAM_PORT}\r\n\r\n`);
  });
  raw.once('data', (chunk) => {
    assert.match(chunk.toString(), /^HTTP\/1\.1 200/, 'CONNECT should return 200');
    const secure = tls.connect({
      socket: raw,
      servername: '127.0.0.1',
      ca: fs.readFileSync(path.join(caTestDir, 'ca.crt')),
      rejectUnauthorized: true,
    }, () => resolve(secure));
    secure.on('error', reject);
  });
  raw.on('error', reject);
});

const wsKey = crypto.randomBytes(16).toString('base64');
socket.write([
  `GET /ws HTTP/1.1`,
  `Host: 127.0.0.1:${UPSTREAM_PORT}`,
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Key: ${wsKey}`,
  'Sec-WebSocket-Version: 13',
  '',
  '',
].join('\r\n'));

await new Promise((resolve, reject) => {
  const onData = (chunk) => {
    if (socket._handshakeDone) return;
    if (chunk.toString('latin1').includes('101 Switching Protocols')) {
      socket._handshakeDone = true;
      socket.off('data', onData);
      resolve();
    }
  };
  socket.on('data', onData);
  socket.on('error', reject);
  setTimeout(() => reject(new Error('handshake timeout')), 5000);
});

const loginFrame = codec.encode('LoginRequest', 7, {
  language: 'zh_CN',
  worldId: 1,
  eworldParams: { openId: 'oSELFTEST', token: 'tok', timestamp: 1700000000, sign: 'sig' },
});
const replies = [];
socket.on('data', frameReader(({ payload }) => {
  try {
    replies.push(codec.decode(payload));
  } catch {
    /* not a game frame */
  }
}));
socket.write(encodeFrame(loginFrame, { mask: true }));

await new Promise((resolve) => setTimeout(resolve, 800));

assert.ok(fs.existsSync(outPath), 'proxy should have written credentials.json');
const captured = JSON.parse(fs.readFileSync(outPath, 'utf8'));
assert.equal(captured.url, `wss://127.0.0.1:${UPSTREAM_PORT}/ws`, 'captured url');
assert.equal(captured.login.eworldParams.openId, 'oSELFTEST', 'captured openId');
assert.deepEqual(
  Buffer.from(captured.loginFrameHex, 'hex'),
  Buffer.from(loginFrame),
  'captured frame bytes',
);
assert.equal(replies.length, 1, 'client received echoed frame');
assert.equal(replies[0].name, 'LoginResponse', 'echo decoded name');

socket.destroy();

// A CONNECT to a port we do not intercept must be a transparent byte tunnel, so
// unrelated client traffic keeps working while the proxy is on.
const TUNNEL_PORT = 18081;
const echo = net.createServer((connection) => connection.pipe(connection));
await new Promise((resolve) => echo.listen(TUNNEL_PORT, '127.0.0.1', resolve));

const tunneled = await new Promise((resolve, reject) => {
  const raw = net.connect(PROXY_PORT, '127.0.0.1', () => {
    raw.write(`CONNECT 127.0.0.1:${TUNNEL_PORT} HTTP/1.1\r\nHost: 127.0.0.1:${TUNNEL_PORT}\r\n\r\n`);
  });
  let replied = false;
  raw.on('data', (chunk) => {
    if (!replied) {
      assert.match(chunk.toString(), /^HTTP\/1\.1 200/, 'tunnel CONNECT should return 200');
      replied = true;
      raw.write('raw-bytes-not-tls');
      return;
    }
    resolve(chunk.toString());
  });
  raw.on('error', reject);
  setTimeout(() => reject(new Error('tunnel timeout')), 5000);
});
assert.equal(tunneled, 'raw-bytes-not-tls', 'non-intercepted port passes through untouched');

echo.close();
await proxy.stop();
upstream.close();
fs.rmSync(outPath, { force: true });
try { removeCaFiles(); } catch { fs.rmSync(caTestRoot, { recursive: true, force: true }); }
fs.rmSync(caTestRoot, { recursive: true, force: true });

console.log('mitm selftest ok: CONNECT + TLS + upgrade + LoginRequest capture + echo + pass-through');
