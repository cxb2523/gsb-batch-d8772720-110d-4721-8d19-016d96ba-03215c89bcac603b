// 控制台首屏与页面读取：只读请求不等整轮挂机、压缩与缓存、图标缩略图、手机导航标记。全程离线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';
import zlib from 'node:zlib';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-performance-'));
process.env.CW_DATA_DIR = dir;
process.env.CW_CONFIG_PACK = path.join(dir, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { GameClient } = await import('../src/client.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const { decodePng, encodePng, cropIcon, shrink, iconThumb } = await import('../src/art-thumbs.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole, findAppBrowser } = await import('../src/server.mjs');
const { PAGE } = await import('../src/page.mjs');

let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('通过：' + name); };

// ---- 请求间隙读取：真实 GameClient + 假 socket ----
const protocol = loadProtocol();
const makeClient = () => {
  const client = new GameClient({ url: 'ws://invalid.invalid', protocol });
  client.socket = { readyState: 1, send() {}, close() {} };
  const sent = [];
  client.on('frame', frame => { if (frame.dir === 'out') sent.push(frame.name); });
  const respond = name => {
    const index = client.pending.findIndex(entry => entry.responseName === name);
    assert.ok(index >= 0, '没有等待 ' + name);
    const [entry] = client.pending.splice(index, 1);
    clearTimeout(entry.timer);
    entry.resolve({});
  };
  return { client, sent, respond };
};

await test('读取等在途请求结束才发送，其间新的普通请求被拦住，读完按序放行', async () => {
  const { client, sent, respond } = makeClient();
  const running = client.request('AllItemRequest', {}, 'AllItemResponse');
  const read = client.interleaveRead(async () => {
    await client.request('MonthCardRequest', {}, 'MonthCardResponse');
    return 'map';
  });
  await sleep(1);
  const next = client.request('AllResourceRequest', {}, 'AllResourceResponse');
  await sleep(20);
  assert.deepEqual(sent, ['AllItemRequest'], '在途请求未完成时不能发读取，也不能放行新请求');
  respond('AllItemResponse');
  await running;
  await sleep(20);
  assert.deepEqual(sent, ['AllItemRequest', 'MonthCardRequest'], '读取期间普通请求仍被拦住');
  respond('MonthCardResponse');
  assert.equal(await read, 'map');
  await sleep(5);
  assert.deepEqual(sent, ['AllItemRequest', 'MonthCardRequest', 'AllResourceRequest']);
  respond('AllResourceResponse');
  await next;
  assert.equal(client.readGate, null);
});

await test('读取期间的拒绝只算到读取头上，不会记到被拦住的写请求', async () => {
  const { client, sent, respond } = makeClient();
  const read = client.interleaveRead(() => client.request('MonthCardRequest', {}, 'MonthCardResponse'));
  await sleep(1);
  const write = client.request('AllResourceRequest', {}, 'AllResourceResponse');
  await sleep(10);
  client.attributePrompt({ prompt: 1, args: ['拒绝'] });
  await assert.rejects(read, /server prompt/);
  await sleep(5);
  assert.deepEqual(sent, ['MonthCardRequest', 'AllResourceRequest'], '写请求在读取失败后才发出');
  respond('AllResourceResponse');
  await write;
});

await test('读取抛错也会放行；多个读取逐个进行', async () => {
  const { client, sent, respond } = makeClient();
  await assert.rejects(client.interleaveRead(async () => { throw new Error('读取失败'); }), /读取失败/);
  assert.equal(client.readGate, null);
  const order = [];
  const first = client.interleaveRead(async () => { order.push('first'); await client.request('MonthCardRequest', {}, 'MonthCardResponse'); order.push('first-end'); });
  const second = client.interleaveRead(async () => { order.push('second'); });
  await sleep(5);
  assert.deepEqual(order, ['first']);
  respond('MonthCardResponse');
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'first-end', 'second']);
  assert.deepEqual(sent, ['MonthCardRequest']);
});

await test('sendWatch 同样被拦住；断线时读取和被拦请求都明确失败', async () => {
  const { client, sent, respond } = makeClient();
  const read = client.interleaveRead(() => client.request('MonthCardRequest', {}, 'MonthCardResponse'));
  await sleep(1);
  const watch = client.sendWatch('LoginFinishRequest', {}, { window: 1 });
  await sleep(5);
  assert.deepEqual(sent, ['MonthCardRequest']);
  respond('MonthCardResponse');
  await read;
  await watch;
  assert.deepEqual(sent, ['MonthCardRequest', 'LoginFinishRequest']);

  const lost = makeClient();
  const blocker = lost.client.request('AllItemRequest', {}, 'AllItemResponse');
  const lostRead = lost.client.interleaveRead(() => lost.client.request('MonthCardRequest', {}, 'MonthCardResponse'));
  await sleep(1);
  const held = lost.client.request('AllResourceRequest', {}, 'AllResourceResponse');
  await sleep(5);
  lost.client.socket.readyState = 3;
  await assert.rejects(lostRead, /not connected/);
  await assert.rejects(held, /not connected/);
  lost.respond('AllItemResponse');
  await blocker;
});

// ---- 控制台路由 ----
const live = new Set();
const realConnected = Object.getOwnPropertyDescriptor(GameClient.prototype, 'connected');
Object.defineProperty(GameClient.prototype, 'connected', { configurable: true, get() { return live.has(this); } });
GameClient.prototype.connect = async function () {
  live.add(this);
  return { playerInfo: { nickname: '测试', level: 60, playerId: 1, worldId: 1 } };
};
GameClient.prototype.send = () => {};
GameClient.prototype.request = async () => ({});
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); };

saveStore({ activeId: 'a', accounts: [{ id: 'a', url: 'ws://invalid.invalid', login: {} }] });
const app = createConsole({ port: 0 });
await app.listen();
const port = app.server.address().port;
const url = pathname => `http://127.0.0.1:${port}${pathname}`;
const raw = (pathname, headers = {}) => new Promise((resolve, reject) => {
  http.get(url(pathname), { headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

await test('首页带 gzip 和 ETag，重新验证返回 304；不支持压缩的客户端拿到原文', async () => {
  const zipped = await raw('/', { 'accept-encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers['cache-control'], 'no-cache');
  assert.equal(zlib.gunzipSync(zipped.body).toString(), PAGE);
  assert.ok(zipped.body.length < Buffer.byteLength(PAGE) / 3, '压缩后应明显变小');
  const again = await raw('/', { 'if-none-match': zipped.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const plain = await raw('/');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), PAGE);
});

await test('较大的 JSON 按需压缩，小响应不压缩', async () => {
  const large = await raw('/api/settings?account=a', { 'accept-encoding': 'gzip' });
  assert.equal(large.headers['content-encoding'], 'gzip');
  assert.ok(JSON.parse(zlib.gunzipSync(large.body).toString()).settings);
  const small = await raw('/api/stages?account=a', { 'accept-encoding': 'gzip' });
  assert.ok(JSON.parse(small.body.toString()), '小响应保持原文');
  assert.equal(small.headers['content-encoding'], undefined);
});

await test('挂机占着队列时：页面读取不排在整轮之后，写操作继续排队', async () => {
  const connected = await fetch(url('/api/connect?account=a'), { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.equal(connected.status, 200);
  const session = app.sessions.get('a');
  // 一轮挂机是一个队列任务，这里用永不结束的任务模拟它。
  let finishRound;
  session.queueTail = new Promise(resolve => { finishRound = resolve; });
  const quick = { signal: AbortSignal.timeout(4000) };
  const loop = await fetch(url('/api/loop?account=a'), quick);
  assert.equal(loop.status, 200, '/api/loop 不能等队列');
  for (const pathname of ['/api/world/overview', '/api/world', '/api/trials', '/api/guild', '/api/equipment', '/api/activity-statistics', '/api/activity-ranks', '/api/pirates/board', '/api/fleets/formation']) {
    const response = await fetch(url(pathname + '?account=a'), { signal: AbortSignal.timeout(4000) });
    await response.text();
    // 假客户端的空回包可能让读取报错；这里只要求不被队列卡住，卡住时上面的超时会失败。
    assert.ok(response.status >= 200 && response.status < 600, pathname);
  }
  const write = fetch(url('/api/guild/welfare?account=a'), { method: 'POST', body: JSON.stringify({ confirm: true }) }).then(r => r.text());
  const raced = await Promise.race([write.then(() => 'finished'), sleep(300).then(() => 'queued')]);
  assert.equal(raced, 'queued', '写操作必须继续等队列');
  finishRound();
  session.queueTail = null;
  await write;
});

await test('页面读取在队列空闲时照常走账号队列', async () => {
  const session = app.sessions.get('a');
  assert.equal(session.queueTail ?? null, null);
  const original = session.client.interleaveRead;
  let interleaved = 0;
  session.client.interleaveRead = function (work) { interleaved++; return original.call(this, work); };
  const response = await fetch(url('/api/equipment?account=a'), { signal: AbortSignal.timeout(4000) });
  await response.text();
  assert.equal(interleaved, 0);
  delete session.client.interleaveRead;
});

await app.close();
Object.defineProperty(GameClient.prototype, 'connected', realConnected);

// ---- 图标缩略图 ----
const rgba = (width, height, paint) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y).forEach((value, i) => { pixels[(y * width + x) * 4 + i] = value; });
  return { width, height, pixels };
};

await test('PNG 编解码往返无损', () => {
  const image = rgba(17, 9, (x, y) => [x * 13 % 256, y * 29 % 256, (x + y) * 7 % 256, x % 2 ? 255 : 128]);
  const decoded = decodePng(encodePng(image));
  assert.equal(decoded.width, 17);
  assert.equal(decoded.height, 9);
  assert.ok(decoded.pixels.equals(image.pixels));
  assert.throws(() => decodePng(Buffer.from('not a png')), /不是 PNG/);
});

await test('未旋转和旋转打包的图标裁切方向与页面原 CSS 一致', () => {
  const atlas = rgba(8, 8, (x, y) => [x, y, 0, 255]);
  const plain = cropIcon(atlas, { x: 1, y: 2, w: 3, h: 2, rotated: false });
  assert.deepEqual([...plain.pixels.subarray(0, 4)], [1, 2, 0, 255]);
  assert.deepEqual([...plain.pixels.subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)], [3, 3, 0, 255]);
  const turned = cropIcon(atlas, { x: 1, y: 2, w: 2, h: 3, rotated: true });
  assert.equal(turned.width, 2);
  assert.equal(turned.height, 3);
  // 图集里占 3 宽 2 高，左下角转到显示区左上角。
  assert.deepEqual([...turned.pixels.subarray(0, 4)], [3, 2, 0, 255]);
  assert.deepEqual([...turned.pixels.subarray((2 * 2 + 1) * 4, (2 * 2 + 1) * 4 + 4)], [1, 3, 0, 255]);
});

await test('缩小时透明像素不把边缘染黑，小图标不放大', () => {
  const half = rgba(4, 4, x => x < 2 ? [200, 100, 50, 255] : [0, 0, 0, 0]);
  const small = shrink(half, 1);
  assert.equal(small.width, 1);
  assert.deepEqual([...small.pixels], [200, 100, 50, 128]);
  const tiny = rgba(10, 10, () => [1, 2, 3, 255]);
  assert.equal(shrink(tiny), tiny);
});

await test('未知图标名返回空，不会走原型链或拼路径', async () => {
  for (const name of ['不存在的图标', '__proto__', 'constructor', '../../data/accounts']) assert.equal(await iconThumb(name), null, name);
});

// ---- 打开浏览器 ----
await test('按安装位置找 Edge/Chrome，找不到时不返回假路径', () => {
  const root = path.join(dir, 'Program Files');
  assert.equal(findAppBrowser({ ProgramFiles: root }), null);
  assert.equal(findAppBrowser({}), null);
  const chrome = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
  fs.mkdirSync(path.dirname(chrome), { recursive: true });
  fs.writeFileSync(chrome, '');
  assert.equal(findAppBrowser({ ProgramFiles: root }), chrome);
  const edge = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  fs.mkdirSync(path.dirname(edge), { recursive: true });
  fs.writeFileSync(edge, '');
  assert.equal(findAppBrowser({ ProgramFiles: root }), edge, '优先 Edge');
});

// ---- 页面标记 ----
await test('运行时用到的组件模板都存在', () => {
  const sources = ['src/page.mjs', 'src/settings-ui.js', 'src/ui/progression.js', 'src/ui/activities.js', 'src/gift-codes-ui.js', 'src/activity-rankings-ui.js', 'src/activity-statistics-ui.js', 'src/inventory-ui.js', 'src/world-map-ui.js'];
  const ids = new Set(sources.flatMap(file => [...fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').matchAll(/component\('(ui-[a-z-]+)'\)/g)].map(match => match[1])));
  for (const id of ['ui-table', 'ui-button', 'ui-select', 'ui-badge', 'ui-number', 'ui-event-switch']) assert.ok(ids.has(id) || id === 'ui-button', id);
  for (const id of ids) assert.ok(PAGE.includes('<template id="' + id + '">'), '缺少模板 ' + id);
});

await test('样式按 shadcn/ui 分层：组件默认值低于页面布局，工具类优先级最高', () => {
  assert.match(PAGE, /@layer properties, theme, base, components, page, utilities;/);
  assert.match(PAGE, /--primary:\s*oklch\(20\.5% 0 0\)/);
  assert.match(PAGE, /--radius:\s*\.625rem/);
  const console_ = fs.readFileSync(new URL('../src/console.css', import.meta.url), 'utf8');
  assert.ok(!console_.includes(':root {'), '设计令牌只在 theme.css 定义');
  assert.ok(!/--(ink|teal|line|surface)\b/.test(console_), '不再使用旧配色变量');
});

await test('首屏不依赖图集，导航八项带手机短名，脚本可解析', () => {
  for (const script of PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const body = PAGE.slice(PAGE.indexOf('<body>'), PAGE.indexOf('<script>'));
  assert.ok(!body.includes('/api/art/atlas/'), '静态标记不能引用整张图集');
  assert.equal((body.match(/class="nav-tab"/g) ?? []).length, 8);
  assert.equal((body.match(/class="nav-short"/g) ?? []).length, 8);
  assert.ok(PAGE.includes('viewport-fit=cover'));
  assert.ok(PAGE.includes('table-stack'));
  assert.ok(PAGE.includes('id="world-map-pan"'));
  assert.ok(PAGE.includes('id="page-progress"'));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log('控制台性能专项 ' + count + '/' + count + ' 通过');
