// 真实协议编解码 + 假 WebSocket/时钟；不连接游戏或读取账号。
import assert from 'node:assert/strict';
import { GameClient, PING_TIMEOUT_MS, MAX_MISSED_PINGS, HEARTBEAT_DEADLINE_MS } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { createCodec } from '../src/codec.mjs';

const protocol = loadProtocol(), codec = createCodec(protocol);
const originalWebSocket = globalThis.WebSocket, originalNow = Date.now;
let wall = Date.parse('2026-11-12T12:00:00+08:00'), mono = 0, passed = 0;
const sockets = [], clients = [];
Date.now = () => wall;
class FakeSocket {
  constructor() { this.readyState = 0; this.frames = []; this.closes = []; sockets.push(this); }
  send(frame) { if (this.sendError) throw Error('模拟发送失败'); this.frames.push(codec.decode(frame)); }
  close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(name, body, seq = 0) { this.onmessage?.({ data: codec.encode(name, seq, body) }); }
}
globalThis.WebSocket = FakeSocket;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
function fixture() {
  const client = new GameClient({ url: 'ws://invalid.invalid', protocol });
  client.heartbeatNow = () => mono;
  clients.push(client);
  const closed = [], warnings = [];
  client.on('close', event => closed.push(event));
  client.on('warn', warning => warnings.push(warning));
  return { client, closed, warnings };
}
async function login(f = fixture()) {
  const pending = f.client.connect({});
  const socket = sockets.at(-1);
  socket.open();
  socket.receive('LoginResponse', { result: 0, initSeqNo: 100, playerInfo: { nickname: '离线测试' } });
  await pending;
  // 手动驱动时间，不等待真实心跳间隔。
  clearInterval(f.client.tickTimer); f.client.tickTimer = null;
  return { ...f, socket };
}
function advance(ms, wallMs = ms) { mono += ms; wall += wallMs; }
function pong(f, timestamp = f.client.lastPingTimestamp) {
  f.socket.receive('PingResponse', { clientTimestamp: timestamp, serverTimestamp: wall });
}

try {
  await test('登录后独立发送序号0心跳，正常连接的业务序号不受影响', async () => {
    const f = await login();
    assert.deepEqual(f.socket.frames.map(frame => frame.name), ['LoginRequest', 'PingRequest']);
    assert.equal(f.socket.frames.at(-1).seq, 0);
    assert.equal(f.client.sendSeqNo, 100);
    assert.equal(f.client.pingAttempts.size, 1);
    f.client.stop();
  });

  await test('两秒延迟的有效心跳不会误断线，Long时间戳仍能匹配', async () => {
    const f = await login(), timestamp = f.client.lastPingTimestamp;
    advance(2000); f.client.tick();
    assert.equal(f.closed.length, 0);
    pong(f, timestamp);
    assert.equal(f.client.lastPingTimestamp, 0);
    assert.equal(f.client.pingAttempts.size, 0);
    assert(f.client.latencyMs >= 0);
    f.client.stop();
  });

  await test('连续三次探测无应答才断开，30秒期限与原因可供恢复使用', async () => {
    assert.equal(MAX_MISSED_PINGS, 3);
    assert.equal(HEARTBEAT_DEADLINE_MS, 30000);
    const f = await login();
    for (let attempt = 1; attempt < MAX_MISSED_PINGS; attempt++) {
      advance(PING_TIMEOUT_MS); f.client.tick();
      assert.equal(f.closed.length, 0);
      assert.equal(f.client.pingAttempts.size, attempt + 1);
    }
    advance(PING_TIMEOUT_MS); f.client.tick();
    assert.equal(f.closed.length, 1);
    assert.equal(f.client.closeReason, 'heartbeat-timeout');
    assert.equal(f.closed[0].cause, 'heartbeat-timeout');
    assert.equal(f.client.connected, false);
    assert.equal(f.client.pingAttempts.size, 0);
    assert.equal(f.socket.closes.length, 1);
    f.client.tick(); f.client.failConnection('重复通知');
    assert.equal(f.closed.length, 1);
  });

  await test('重试后迟到的前一次应答也能恢复，不再反复误超时', async () => {
    const f = await login(), first = f.client.lastPingTimestamp;
    advance(PING_TIMEOUT_MS); f.client.tick();
    const second = f.client.lastPingTimestamp;
    assert.notEqual(second, first);
    advance(500); pong(f, first);
    assert.equal(f.client.pingAttempts.size, 0);
    assert.equal(f.closed.length, 0);
    f.client.tick();
    const third = f.client.lastPingTimestamp;
    pong(f, second);
    assert.equal(f.client.lastPingTimestamp, third, '旧重试的重复应答不能确认下一轮心跳');
    pong(f, third);
    f.client.stop();
  });

  await test('系统时钟向前或向后调整，不影响单调时钟超时判定', async () => {
    const f = await login();
    advance(1000, 86400000); f.client.tick();
    assert.equal(f.closed.length, 0);
    assert.equal(f.client.pingAttempts.size, 1);
    advance(PING_TIMEOUT_MS - 1000, -86400000); f.client.tick();
    assert.equal(f.client.pingAttempts.size, 2);
    assert.equal(f.closed.length, 0);
    f.client.stop();
  });

  await test('事件循环长暂停恢复后先重新探测，不瞬间耗尽重试', async () => {
    const f = await login();
    advance(3600000); f.client.tick();
    assert.equal(f.client.pingAttempts.size, 2);
    assert.equal(f.closed.length, 0);
    advance(100); pong(f);
    assert.equal(f.client.pingAttempts.size, 0);
    f.client.stop();
  });

  await test('长业务请求和只读门控不阻止心跳，正常推送也不停止探测', async () => {
    const f = await login();
    f.client.readGate = new Promise(() => {});
    pong(f); advance(1000); f.client.tick();
    assert.equal(f.socket.frames.at(-1).name, 'PingRequest');
    f.client.onMessage(codec.encode('OkResponse', 101, {}));
    advance(PING_TIMEOUT_MS); f.client.tick();
    assert.equal(f.client.pingAttempts.size, 2);
    assert.equal(f.closed.length, 0);
    f.client.readGate = null;
    f.client.stop();
  });

  await test('连续健康心跳跨越多天，只有明确失联才关闭', async () => {
    const f = await login();
    for (let index = 0; index < 10; index++) {
      advance(86400000); f.client.tick();
      pong(f);
      advance(1000); f.client.tick();
      assert.equal(f.closed.length, 0);
    }
    f.client.stop();
  });

  await test('心跳发送异常变为可恢复网络断线，定时器不会向外抛错', async () => {
    const f = await login(); pong(f);
    f.socket.sendError = true;
    assert.doesNotThrow(() => f.client.tick());
    assert.equal(f.client.closeReason, 'network');
    assert.equal(f.closed.length, 1);
    assert.equal(f.client.tickTimer, null);
  });

  await test('真正断线及时拒绝在途请求，停止清理全部心跳及ACK状态', async () => {
    const f = await login();
    const pending = f.client.request('AllItemRequest', {}, 'AllItemResponse').catch(error => error);
    f.client.ack(101);
    f.socket.readyState = 3;
    f.socket.onclose({ code: 1006, reason: '' });
    assert.match((await pending).message, /断开/);
    assert.equal(f.client.closeReason, 'network');
    assert.equal(f.client.ackTimer, null);
    assert.equal(f.client.nextAckSeqNo, null);
    assert.equal(f.client.pending.length, 0);
    assert.equal(f.client.pingAttempts.size, 0);
    f.client.stop();
    assert.equal(f.client.closeReason, 'stopped');
  });

  await test('被顶号和协议损坏有独立原因，不能当作普通网络错误', async () => {
    const kicked = await login();
    kicked.socket.receive('SCChannelExpired', {});
    assert.equal(kicked.client.closeReason, 'kicked');
    const bad = await login();
    bad.socket.onmessage({ data: new Uint8Array([1]) });
    assert.equal(bad.client.closeReason, 'protocol');
  });

  await test('登录超时关闭孤立socket，保留可恢复错误标记', async () => {
    const f = fixture();
    const pending = f.client.connect({}, { timeout: 10 }).catch(error => error);
    const socket = sockets.at(-1);
    const error = await pending;
    assert.match(error.message, /login timeout/);
    assert.equal(error.recoverable, true);
    assert.equal(f.client.closeReason, 'network');
    assert.equal(socket.closes.length, 1);
    assert.equal(f.client.socket, null);
    assert.equal(f.client.loginAbort, null);
  });

  await test('手动停止立即取消进行中的登录，不等待登录超时', async () => {
    const f = fixture();
    const pending = f.client.connect({}, { timeout: 10000 }).catch(error => error);
    const socket = sockets.at(-1);
    f.client.stop();
    const error = await pending;
    assert.match(error.message, /client stopped/);
    assert.equal(error.recoverable, false);
    assert.equal(f.client.state, 'STOPPED');
    assert.equal(f.client.loginAbort, null);
    assert.equal(socket.closes.length, 1);
    assert.equal(socket.onmessage, null);
  });

  await test('登录拒绝关闭socket并标为不可恢复，不冒充网络失败', async () => {
    const f = fixture();
    const pending = f.client.connect({}).catch(error => error);
    const socket = sockets.at(-1);
    socket.open(); socket.receive('LoginResponse', { result: 1, errorMessage: '拒绝' });
    const error = await pending;
    assert.equal(error.recoverable, false);
    assert.equal(error.loginResponse.result, 1);
    assert.equal(f.client.closeReason, 'login-rejected');
    assert.equal(socket.closes.length, 1);
  });

  await test('旧socket迟到回调不影响重连，旧探测nonce也已清理', async () => {
    const f = await login();
    const oldClose = f.socket.onclose, oldMessage = f.socket.onmessage, oldError = f.socket.onerror;
    f.client.stop();
    const next = await login(f);
    const active = next.client.socket;
    oldClose({ code: 1006 });
    oldError();
    oldMessage({ data: codec.encode('SCChannelExpired', 0, {}) });
    assert.equal(next.client.socket, active);
    assert.equal(next.client.connected, true);
    assert.equal(next.client.closeReason, null);
    assert.equal(next.closed.length, 0);
    // 同一毫秒重连也允许复用线上时间戳；只有旧socket回调被隔离才不会误认旧应答。
    assert.equal(next.client.pingAttempts.size, 1);
    next.client.stop();
  });
  await test('取消旧登录后立即重新连接，旧Promise拒绝不覆盖新状态', async () => {
    const f = fixture();
    const first = f.client.connect({}).catch(error => error);
    f.client.stop();
    const next = await login(f);
    assert.equal((await first).recoverable, false);
    assert.equal(next.client.state, 'READY');
    assert.equal(next.client.closeReason, null);
    assert(next.client.connected);
    next.client.stop();
  });
  console.log('客户端心跳专项 ' + passed + '/' + passed + ' 通过');
} finally {
  for (const client of clients) client.stop();
  globalThis.WebSocket = originalWebSocket;
  Date.now = originalNow;
}
