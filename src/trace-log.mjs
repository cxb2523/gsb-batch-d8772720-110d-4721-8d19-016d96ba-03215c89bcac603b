import fs from 'node:fs';
import path from 'node:path';

// Two files alternate so a long-running console never has to rename an open
// stream on Windows. Each file is capped independently.
export function createTraceLog(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
  const files = [file, file + '.1'];
  let index = 0, fd = null, bytes = 0, initialized = false;

  function trim(target) {
    try { if (fs.statSync(target).size > limit) fs.truncateSync(target, 0); } catch { /* 文件不存在 */ }
  }
  function open(truncate = false) {
    const target = files[index];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (truncate) { try { fs.truncateSync(target, 0); } catch { /* 文件不存在 */ } }
    fd = fs.openSync(target, 'a');
    bytes = (() => { try { return fs.statSync(target).size; } catch { return 0; } })();
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    for (const target of files) trim(target);
  }
  function rotate() {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略关闭错误 */ } fd = null; }
    index = 1 - index;
    try { fs.rmSync(files[index], { force: true }); } catch { /* 下一次打开会截断 */ }
    try { open(true); } catch { fd = null; bytes = 0; }
  }

  return {
    write(text) {
      initialize();
      const size = Buffer.byteLength(text);
      if (fd === null) {
        try { open(); } catch { return; }
      }
      if (bytes > 0 && bytes + size > limit) rotate();
      if (fd === null) return;
      try { fs.writeSync(fd, text); bytes += size; } catch { /* 协议日志不是功能 */ }
    },
    close() {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略关闭错误 */ } }
      fd = null;
      return Promise.resolve();
    },
    get files() { return [...files]; },
    get current() { return files[index]; },
  };
}
