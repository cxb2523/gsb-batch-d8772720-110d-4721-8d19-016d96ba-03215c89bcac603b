import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { formatConsoleLog } from './console-log.mjs';

export const CONSOLE_GUIDANCE = '关闭网页后挂机会继续，运行日志显示在此窗口。请保持此窗口打开；Ctrl+C 或关闭此窗口会结束后台进程。';
const ESC = '\u001b[';
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

function plain(value) {
  return stripVTControlCharacters(String(value ?? '').replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, ''))
    .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

function cellWidth(text) {
  if (/^\p{Mark}+$/u.test(text)) return 0;
  const code = text.codePointAt(0);
  return /\p{Extended_Pictographic}/u.test(text) || code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a || code >= 0x2e80 && code <= 0xa4cf ||
    code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
    code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 ||
    code >= 0xffe0 && code <= 0xffe6 || code >= 0x20000 && code <= 0x3ffff
  ) ? 2 : 1;
}

function wrap(text, columns) {
  const rows = [];
  for (const line of text.split('\n')) {
    let row = '', width = 0;
    for (const { segment } of segmenter.segment(line)) {
      const size = cellWidth(segment);
      if (width + size > columns && row) { rows.push(row); row = ''; width = 0; }
      row += segment; width += size;
    }
    rows.push(row);
  }
  return rows;
}

// Node/libuv enables VT output on modern Windows consoles. DECSTBM needs the
// Windows 10 VT host; old consoles and redirected streams stay plain text.
// https://learn.microsoft.com/windows/console/console-virtual-terminal-sequences
export function supportsPinnedHeader(stream, { env = process.env, platform = process.platform, release = os.release() } = {}) {
  if (!stream?.isTTY || env.CW_PIN_HEADER === '0' || env.TERM === 'dumb') return false;
  if (platform === 'win32') {
    if (env.WT_SESSION || env.TERM_PROGRAM || /^(xterm|screen|tmux|cygwin)/.test(env.TERM ?? '')) return true;
    const [major, , build] = release.split('.').map(Number);
    return major > 10 || major === 10 && build >= 10586;
  }
  return /^(xterm|screen|tmux|rxvt|vt100|ansi|linux)/.test(env.TERM ?? '') || !!env.TERM_PROGRAM;
}

export function createConsoleOutput({ stdout = process.stdout, env = process.env, platform = process.platform, release = os.release() } = {}) {
  const capable = supportsPinnedHeader(stdout, { env, platform, release });
  let address = null, pinned = false, redraw = false, failed = false, closing = false, closed = false;
  let queue = [], queuedBytes = 0, history = [], historyBytes = 0, dropped = 0;
  let scheduled = null, blocked = false, waiter = null;
  const dimensions = () => ({ columns: Math.max(0, Number(stdout.columns) || 0), rows: Math.max(0, Number(stdout.rows) || 0) });

  function layout() {
    const { columns, rows } = dimensions();
    if (!capable || !address || columns < 20 || rows < 6) return null;
    const width = columns - 1; // Avoid a last-column auto-wrap changing the cursor row.
    const title = wrap('控制台已启动 ' + address, width);
    let guidance = wrap(CONSOLE_GUIDANCE, width);
    if (title.length + guidance.length + 3 > rows) guidance = wrap('关闭网页可继续；保留窗口。Ctrl+C/关窗口即停止。', width);
    if (title.length + guidance.length + 3 > rows) return null;
    const lines = [...title, ...guidance, '─'.repeat(width)];
    return { lines, top: lines.length + 1, bottom: rows, width };
  }

  function remember(text) {
    history.push(text); historyBytes += Buffer.byteLength(text);
    while (history.length > 200 || historyBytes > MAX_HISTORY_BYTES) historyBytes -= Buffer.byteLength(history.shift());
  }

  function stopOnError() {
    failed = true; queue = []; queuedBytes = 0; blocked = false;
    if (scheduled !== null) clearImmediate(scheduled);
    scheduled = null;
    waiter?.(); waiter = null;
  }

  function send(text) {
    if (!text || failed) return true;
    try {
      const accepted = stdout.write(text);
      if (!accepted) blocked = true;
      return accepted;
    } catch { stopOnError(); return false; }
  }

  function header() {
    const frame = layout();
    if (!frame) {
      const reset = pinned ? ESC + 'r' + ESC + String(dimensions().rows || 1) + ';1H\r\n' : '';
      const wasPinned = pinned; pinned = false;
      return reset + (wasPinned ? '控制台已启动 ' + address + '\n' + CONSOLE_GUIDANCE + '\n' : '');
    }
    pinned = true;
    const past = wrap(history.join('\n'), frame.width).slice(-(frame.bottom - frame.top));
    return ESC + 'r' + ESC + '2J' + ESC + 'H' +
      frame.lines.map((line, index) => ESC + (index + 1) + ';1H' + ESC + '2K' + line).join('') +
      ESC + frame.top + ';' + frame.bottom + 'r' + ESC + frame.top + ';1H' +
      (past.length && history.length ? past.join('\r\n') + '\r\n' : '');
  }

  function schedule() {
    if (!failed && !closed && !blocked && scheduled === null) scheduled = setImmediate(flush);
  }

  function flush() {
    scheduled = null;
    if (failed || closed || blocked) return;
    let text = '';
    if (redraw) { redraw = false; text += header(); }
    if (dropped) { const notice = '[系统] 终端输出积压，已省略 ' + dropped + ' 条较早日志；最近记录可在网页查看。'; text += notice + '\n'; remember(notice); dropped = 0; }
    let bytes = 0;
    while (queue.length && bytes < MAX_RECORD_BYTES) {
      const record = queue.shift(); queuedBytes -= record.bytes; bytes += record.bytes;
      text += record.text + '\n'; remember(record.text);
    }
    if (pinned) text = text.replace(/(?<!\r)\n/g, '\r\n');
    if (!send(text)) return;
    if (queue.length || redraw || dropped) schedule();
    else { waiter?.(); waiter = null; }
  }

  const onDrain = () => { blocked = false; schedule(); };
  const onResize = () => { if (address) { redraw = true; schedule(); } };
  stdout.on?.('error', stopOnError);
  stdout.on?.('drain', onDrain);
  if (capable) stdout.on?.('resize', onResize);

  function write(value) {
    if (closed || closing || failed) return;
    let text = plain(value);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) text = Buffer.from(text).subarray(0, MAX_RECORD_BYTES).toString('utf8').replace(/\uFFFD$/, '') + '…[终端长日志已截断]';
    const bytes = Buffer.byteLength(text);
    while (queue.length && queuedBytes + bytes > MAX_QUEUE_BYTES) { queuedBytes -= queue.shift().bytes; dropped++; }
    queue.push({ text, bytes }); queuedBytes += bytes;
    schedule();
  }

  function restore() {
    if (closed) return;
    if (scheduled !== null) clearImmediate(scheduled);
    scheduled = null;
    stdout.off?.('resize', onResize); stdout.off?.('drain', onDrain);
    if (pinned) send(ESC + 'r' + ESC + String(dimensions().rows || 1) + ';1H\r\n');
    pinned = false; closed = true;
  }

  return {
    log(entry) { write(formatConsoleLog(entry)); },
    write,
    start(url) {
      if (address || closed) return;
      address = plain(url).replace(/\n/g, '');
      if (layout()) { redraw = true; schedule(); }
      else write(CONSOLE_GUIDANCE);
    },
    restore,
    async close() {
      if (closed) return;
      closing = true;
      let timer;
      try {
        await Promise.race([
          new Promise(resolve => { if (!queue.length && !blocked && !redraw && !dropped) resolve(); else { waiter = resolve; schedule(); } }),
          new Promise(resolve => { timer = setTimeout(resolve, 500); }),
        ]);
      } finally { clearTimeout(timer); waiter = null; restore(); }
      // A successful write() can still be queued in the OS. Let the final reset
      // reach the terminal before the CLI's explicit signal-exit, with a bound
      // for a disconnected/blocked destination.
      if (!failed) {
        try {
          await Promise.race([
            new Promise(resolve => { try { stdout.write('', resolve); } catch { resolve(); } }),
            new Promise(resolve => { timer = setTimeout(resolve, 250); }),
          ]);
        } finally { clearTimeout(timer); }
      }
    },
    get pinned() { return pinned; },
  };
}
