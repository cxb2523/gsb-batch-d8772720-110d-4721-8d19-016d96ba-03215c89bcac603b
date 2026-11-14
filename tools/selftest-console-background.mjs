// 后台挂机与网页日志订阅解耦：真实 HTTP/SSE 和 runLoop，全部游戏请求均为离线假客户端。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-background-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

// These modules choose their data directory at import time. Never import them
// before the temporary directory above has replaced the real account storage.
const { GameClient } = await import('../src/client.mjs');
const { loadStore, saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { automationTasks } = await import('../src/automation.mjs');

const connected = new Set();
const gameRequests = [];
Object.defineProperty(GameClient.prototype, 'connected', { get() { return connected.has(this); } });
GameClient.prototype.connect = async function () {
  connected.add(this);
  return { playerInfo: { playerId: 1516001, worldId: 9001, nickname: '后台离线测试', level: 5 } };
};
GameClient.prototype.send = () => {};
GameClient.prototype.request = async function (name) {
  gameRequests.push(name);
  return name === 'EmailBoxRequest' ? { email: [] } : {};
};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.stop = function () { this.stopping = true; connected.delete(this); };

saveStore({ activeId: 'background', accounts: [{
  id: 'background', label: '后台离线测试', url: 'ws://invalid.invalid', login: {},
  automation: { enabled: false, everySeconds: 1,
    tasks: Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail'])) },
}] });

const sinkEntries = [];
let sinkThrows = false;
let sinkRejects = false;
let sinkFailures = 0;
const app = createConsole({ port: 0, onLog(entry) {
  sinkEntries.push(entry);
  if (sinkThrows) { sinkFailures++; throw new Error('模拟终端日志输出失败'); }
  if (sinkRejects) { sinkFailures++; return Promise.reject(new Error('模拟异步日志输出失败')); }
} });
const serverStreams = new Map();
const openStreams = new Set();
const httpRequests = [];
app.server.on('request', (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  httpRequests.push(url.pathname);
  if (url.pathname === '/api/events') serverStreams.set(url.searchParams.get('testStream'), response);
});

let root;
let closed = false;
let passed = 0;
const session = () => app.sessions.get('background');
const automation = () => loadStore().accounts[0].automation;
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail('等待超时：' + label);
};
const test = async (name, work) => {
  await work();
  console.log('通过：' + name);
  passed++;
};
const post = async (route, body) => {
  const response = await fetch(root + route + '?account=background', {
    method: 'POST', body: JSON.stringify({ confirm: true, ...body }), signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
};

function subscribe(name) {
  return new Promise((resolve, reject) => {
    const stream = { name, text: '', entries: [], ended: false, request: null, response: null };
    stream.request = http.get(root + '/api/events?account=background&testStream=' + encodeURIComponent(name), response => {
      stream.response = response;
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', chunk => {
        stream.text += chunk;
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const payload = block.split('\n').find(line => line.startsWith('data: '));
          if (payload) stream.entries.push(JSON.parse(payload.slice(6)));
        }
      });
      response.on('error', () => { stream.ended = true; });
      response.on('close', () => { stream.ended = true; openStreams.delete(stream); });
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('SSE 状态码 ' + response.statusCode));
        return;
      }
      openStreams.add(stream);
      resolve(stream);
    });
    stream.request.on('error', error => {
      stream.ended = true;
      if (!stream.response) reject(error);
    });
  });
}

async function closeStream(stream) {
  stream.request.destroy();
  stream.response?.destroy();
  await waitFor(() => stream.ended && serverStreams.get(stream.name)?.destroyed, '网页日志连接关闭');
}

try {
  await app.listen();
  root = 'http://127.0.0.1:' + app.server.address().port;

  await test('关闭网页和日志订阅后，无 HTTP 轮询仍完成多轮挂机并输出业务日志', async () => {
    const browser = await subscribe('initial-browser');
    await post('/api/loop/start', { rounds: 0, everySeconds: 1 });
    await closeStream(browser);
    const before = session().loop.completed;
    const requestCount = httpRequests.length;
    await waitFor(() => session().loop.completed >= before + 3, '网页关闭后继续完成三轮');
    assert.equal(httpRequests.length, requestCount, '没有前端轮询或 HTTP 请求驱动后续轮次');
    assert.equal(session().loop.running, true);
    assert.equal(session().client.connected, true);
    assert.equal(automation().enabled, true);
    assert.ok(gameRequests.includes('EmailBoxRequest'), '真实 runLoop 执行了启用的邮件任务');
    assert.ok(sinkEntries.some(entry => entry.account === 'background' && entry.message.includes('挂机第 ' + (before + 2) + ' 轮结束')),
      '关闭网页期间的轮次日志仍送至 onLog');
  });

  await test('重新打开网页能收到关闭期间积累的历史运行日志', async () => {
    const lastRound = session().loop.completed;
    const replay = await subscribe('replay-browser');
    await waitFor(() => replay.entries.some(entry => entry.message?.includes('挂机第 ' + lastRound + ' 轮结束')), '历史日志重放');
    assert.ok(replay.entries.some(entry => entry.message?.includes('自动挂机开始')));
    await closeStream(replay);
  });

  let survivor;
  await test('多个网页关闭其中一个或全部订阅均不停止挂机', async () => {
    const first = await subscribe('first-browser');
    const second = await subscribe('second-browser');
    const before = session().loop.completed;
    await closeStream(first);
    await waitFor(() => session().loop.completed > before, '关闭一个网页后完成下一轮');
    await waitFor(() => second.entries.some(entry => entry.message?.includes('挂机第 ' + (before + 1) + ' 轮结束')), '另一网页继续收日志');
    await closeStream(second);
    const afterOneClosed = session().loop.completed;
    await waitFor(() => session().loop.completed > afterOneClosed, '关闭全部网页后完成下一轮');
    assert.equal(session().loop.running, true);
    survivor = await subscribe('healthy-browser');
  });

  await test('损坏的 SSE 同步写异常和 error 事件不拖停后台或其他网页', async () => {
    const brokenWrite = await subscribe('broken-write');
    const brokenEvent = await subscribe('broken-event');
    let writeAttempts = 0;
    serverStreams.get(brokenWrite.name).write = () => { writeAttempts++; throw new Error('模拟 SSE 写入失败'); };
    assert.doesNotThrow(() => serverStreams.get(brokenEvent.name).emit('error', new Error('模拟 SSE 连接错误')));
    const before = session().loop.completed;
    await waitFor(() => session().loop.completed >= before + 2, '日志连接损坏后继续挂机');
    assert.equal(writeAttempts, 1, '损坏的订阅应立即移除，不应持续重复写入');
    assert.equal(session().loop.running, true);
    assert.equal(automation().enabled, true);
    await waitFor(() => survivor.entries.some(entry => entry.message?.includes('挂机第 ' + (before + 1) + ' 轮结束')), '健康订阅仍收到新日志');
    await closeStream(brokenWrite);
    await closeStream(brokenEvent);
  });

  await test('终端日志回调抛错不影响后续后台轮次', async () => {
    const before = session().loop.completed;
    const priorFailures = sinkFailures;
    sinkThrows = true;
    try {
      await waitFor(() => session().loop.completed >= before + 2, '日志输出异常后继续挂机');
      assert.ok(sinkFailures >= priorFailures + 2, '每轮仍尝试输出业务日志');
      assert.equal(session().loop.running, true);
      assert.equal(session().loop.error, null);
      assert.equal(automation().enabled, true);
    } finally { sinkThrows = false; }
  });

  await test('异步日志拒绝被处理，健康网页仍收到业务日志', async () => {
    const message = '异步日志拒绝隔离测试';
    const priorFailures = sinkFailures;
    sinkRejects = true;
    try {
      assert.doesNotThrow(() => app.emit(session(), 'info', message));
      await waitFor(() => survivor.entries.some(entry => entry.message === message), '异步日志拒绝后的健康订阅');
      // An unhandled rejection would fail this process while awaiting the SSE.
      assert.ok(sinkFailures > priorFailures);
      assert.equal(session().loop.running, true);
      assert.equal(session().loop.error, null);
      assert.equal(automation().enabled, true);
    } finally { sinkRejects = false; }
  });

  await test('SSE 背压仅断开慢订阅，健康网页和后台不受影响', async () => {
    const slow = await subscribe('slow-browser');
    const response = serverStreams.get(slow.name);
    Object.defineProperty(response, 'writableLength', { get: () => 1024 * 1024 });
    const message = '网页日志背压隔离测试';
    assert.doesNotThrow(() => app.emit(session(), 'info', message));
    await waitFor(() => response.destroyed && slow.ended, '断开积压的慢订阅');
    await waitFor(() => survivor.entries.some(entry => entry.message === message), '健康订阅继续接收日志');
    assert.equal(serverStreams.get(survivor.name).destroyed, false);
    assert.equal(session().loop.running, true);
    assert.equal(session().loop.error, null);
    assert.equal(automation().enabled, true);
  });

  await test('用户显式停止仍中止后台任务并清除持续运行开关', async () => {
    await post('/api/loop/stop');
    await waitFor(() => !session().loop.running, '主动停止挂机');
    assert.equal(automation().enabled, false);
    const stoppedAt = session().loop.completed;
    await sleep(1100);
    assert.equal(session().loop.completed, stoppedAt);
    assert.ok(sinkEntries.some(entry => entry.message === '自动挂机结束'));
  });

  await test('关闭控制台会结束仍打开的 SSE，不等待浏览器自行断开', async () => {
    const closing = app.close().then(() => { closed = true; });
    await waitFor(() => closed, '控制台关闭');
    await closing;
    await waitFor(() => survivor.ended, '控制台关闭时结束网页事件流');
    assert.equal(connected.size, 0);
  });
} finally {
  for (const stream of openStreams) {
    stream.request.destroy();
    stream.response?.destroy();
  }
  if (!closed) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('控制台后台挂机专项 ' + passed + '/' + passed + ' 通过');
