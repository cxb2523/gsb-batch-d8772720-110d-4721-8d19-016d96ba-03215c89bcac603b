import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createConsoleOutput, supportsPinnedHeader, CONSOLE_GUIDANCE } from '../src/console-output.mjs';

class Terminal extends EventEmitter {
  constructor({ columns = 80, rows = 24, isTTY = true } = {}) {
    super(); Object.assign(this, { columns, rows, isTTY, chunks: [], block: false, fail: false });
    this.reset();
  }
  reset() { this.screen = Array.from({ length: this.rows }, () => Array(this.columns).fill(' ')); this.row = 0; this.column = 0; this.top = 0; this.bottom = this.rows - 1; }
  lineFeed() {
    if (this.row === this.bottom) {
      this.screen.splice(this.top, 1); this.screen.splice(this.bottom, 0, Array(this.columns).fill(' '));
    } else this.row = Math.min(this.rows - 1, this.row + 1);
  }
  write(text, callback) {
    if (this.fail) throw Error('模拟输出失败');
    this.chunks.push(text);
    if (this.isTTY) {
      for (let i = 0; i < text.length;) {
        const command = /^\u001b\[([\d;]*)([A-Za-z])/.exec(text.slice(i));
        if (command) {
          const values = command[1].split(';').map(Number), kind = command[2]; i += command[0].length;
          if (kind === 'r') { this.top = (values[0] || 1) - 1; this.bottom = (values[1] || this.rows) - 1; this.row = 0; this.column = 0; }
          else if (kind === 'H') { this.row = (values[0] || 1) - 1; this.column = (values[1] || 1) - 1; }
          else if (kind === 'J') this.screen = Array.from({ length: this.rows }, () => Array(this.columns).fill(' '));
          else if (kind === 'K') this.screen[this.row].fill(' ');
          else assert.fail('未知终端命令 ' + command[0]);
          continue;
        }
        const character = String.fromCodePoint(text.codePointAt(i)); i += character.length;
        if (character === '\r') { this.column = 0; continue; }
        if (character === '\n') { this.lineFeed(); continue; }
        if (/\p{Mark}/u.test(character)) continue;
        const width = /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u.test(character) || /\p{Extended_Pictographic}/u.test(character) ? 2 : 1;
        if (this.column + width > this.columns) { this.column = 0; this.lineFeed(); }
        this.screen[this.row][this.column] = character;
        if (width === 2) this.screen[this.row][this.column + 1] = '';
        this.column += width;
      }
    }
    callback?.();
    return !this.block;
  }
  resize(columns, rows) { this.columns = columns; this.rows = rows; this.reset(); this.emit('resize'); }
  lines() { return this.screen.map(line => line.join('').trimEnd()); }
  text() { return this.chunks.join(''); }
}

const url = 'http://127.0.0.1:17323';
const output = stream => createConsoleOutput({ stdout: stream, platform: 'win32', release: '10.0.26100', env: {} });
const flush = async () => { for (let i = 0; i < 8; i++) await nextTurn(); };
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };

await test('现代CMD可置顶，旧终端、未知TTY、dumb及显式关闭退化纯文本', () => {
  const stream = new Terminal();
  assert(supportsPinnedHeader(stream, { platform: 'win32', release: '10.0.26100', env: {} }));
  assert(!supportsPinnedHeader(stream, { platform: 'win32', release: '6.1.7601', env: {} }));
  assert(!supportsPinnedHeader(stream, { platform: 'linux', release: '', env: {} }));
  assert(!supportsPinnedHeader(stream, { platform: 'win32', release: '10.0.26100', env: { TERM: 'dumb' } }));
  assert(!supportsPinnedHeader(stream, { platform: 'win32', release: '10.0.26100', env: { CW_PIN_HEADER: '0' } }));
  assert(!supportsPinnedHeader({ isTTY: false }, { platform: 'win32', release: '10.0.26100', env: {} }));
});

await test('顶部地址与提示固定，大量日志及同屏stderr只滚动下方区域', async () => {
  const terminal = new Terminal(), sink = output(terminal);
  sink.start(url); await flush();
  const top = terminal.top, header = terminal.lines().slice(0, top);
  assert(header.join('').includes(url)); assert(header.join('').includes('Ctrl+C'));
  for (let i = 0; i < 100; i++) sink.write('运行日志第' + i + '轮');
  await flush();
  assert.deepEqual(terminal.lines().slice(0, top), header);
  assert(terminal.lines().some(line => line.includes('第99轮')));
  terminal.write('外部错误警告\r\n'.repeat(60));
  assert.deepEqual(terminal.lines().slice(0, top), header);
  await sink.close();
  assert.equal(terminal.top, 0); assert.equal(terminal.bottom, terminal.rows - 1);
  assert.equal(terminal.listenerCount('resize'), 0); assert.equal(terminal.listenerCount('drain'), 0);
});

await test('窗口缩放重新计算中文标题行数，重绘最近日志且不截断地址', async () => {
  const terminal = new Terminal(), sink = output(terminal);
  sink.start(url); for (let i = 0; i < 20; i++) sink.write('最近日志-' + i);
  await flush();
  terminal.resize(32, 24); await flush();
  assert(terminal.lines().slice(0, terminal.top).join('').includes(url));
  assert(terminal.lines().some(line => line.includes('最近日志-19')));
  assert(terminal.top < terminal.bottom);
  terminal.resize(100, 35); await flush();
  assert(terminal.lines()[0].includes(url));
  assert(terminal.lines().some(line => line.includes('最近日志-19')));
  await sink.close();
});

await test('极窄窗口安全退化，扩大后可恢复置顶', async () => {
  const terminal = new Terminal({ columns: 18, rows: 8 }), sink = output(terminal);
  sink.start(url); await flush();
  assert(!sink.pinned); assert(!terminal.text().includes('\u001b'));
  terminal.resize(80, 24); await flush(); assert(sink.pinned);
  terminal.resize(18, 8); await flush(); assert(!sink.pinned); assert.equal(terminal.top, 0);
  await sink.close();
});

await test('重定向不含ANSI，日志保持账号时间格式与完整提示', async () => {
  const terminal = new Terminal({ isTTY: false }), sink = output(terminal);
  sink.log({ t: Date.now(), account: 'abcd1234long', level: 'info', message: '后台运行' });
  sink.start(url); await sink.close();
  assert.match(terminal.text(), /\[\d{2}:\d{2}:\d{2}\] \[abcd1234\] \[信息\] 后台运行/);
  assert(terminal.text().includes(CONSOLE_GUIDANCE)); assert(!terminal.text().includes('\u001b'));
});

await test('多行及恶意控制符不能改写顶部或终端标题', async () => {
  const terminal = new Terminal(), sink = output(terminal);
  sink.start(url); await flush();
  const top = terminal.top, header = terminal.lines().slice(0, top);
  sink.log({ account: null, message: '\u001b[2J\u001b[H伪造顶部\n下一行\u001b]0;恶意标题\u0007', level: 'warn' });
  sink.write('超长中文消息'.repeat(100)); await flush();
  assert.deepEqual(terminal.lines().slice(0, top), header);
  assert(!terminal.text().includes('恶意标题'));
  await sink.close();
});

await test('慢终端遵守drain且有界丢弃，日志爆发不阻塞事件循环', async () => {
  const terminal = new Terminal({ isTTY: false }), sink = output(terminal);
  terminal.block = true; sink.write('开始'); await flush();
  const count = terminal.chunks.length;
  for (let i = 0; i < 3000; i++) sink.write('日志' + i + ':' + 'a'.repeat(200));
  await flush(); assert.equal(terminal.chunks.length, count);
  terminal.block = false; terminal.emit('drain');
  for (let i = 0; i < 40; i++) await nextTurn();
  assert(terminal.text().includes('终端输出积压，已省略'));
  assert(terminal.text().includes('日志2999:'));
  assert(terminal.text().length < 300000);
  await sink.close();
});

await test('写入异常与流错误不会冒泡打断业务，退出恢复幂等', async () => {
  const terminal = new Terminal(), sink = output(terminal);
  sink.start(url); await flush();
  terminal.fail = true; sink.write('写入失败'); await flush();
  assert.doesNotThrow(() => terminal.emit('error', Error('断管')));
  assert.doesNotThrow(() => sink.log({ message: '继续业务' }));
  await sink.close(); assert.doesNotThrow(() => sink.restore());
});

await test('退出处理有界等待慢输出并恢复全屏滚动区域', async () => {
  const terminal = new Terminal(), sink = output(terminal);
  sink.start(url); await flush();
  terminal.block = true; sink.write('停止'); await flush();
  await sink.close();
  assert.equal(terminal.top, 0); assert.equal(terminal.bottom, terminal.rows - 1);
  const count = terminal.chunks.length; sink.write('已关闭'); await flush(); assert.equal(terminal.chunks.length, count);
});

console.log('终端固定标题专项 ' + passed + '/' + passed + ' 通过');
