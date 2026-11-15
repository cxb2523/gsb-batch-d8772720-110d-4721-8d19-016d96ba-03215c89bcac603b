/**
 * lib/log.js — 带轮转的日志
 *
 * 为什么存在：ad-balance-duty.log 只增不减已经 58 KB，playwright-service/startup.log
 * 更是 94 MB。日志是给我排障看的，超过阈值就只留尾巴。
 */
const fs = require('fs');
const path = require('path');
const { ROOT, OUT, now } = require('./env');

const MAX_BYTES = (OUT.logMaxKB || 1024) * 1024;
const KEEP_LINES = OUT.logKeepLines || 2000;

function abs(file) {
  return path.isAbsolute(file) ? file : path.join(ROOT, file).replace(/\\/g, '/');
}

/** 超大就截尾：保留最后 KEEP_LINES 行 */
function rotate(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept = lines.slice(-KEEP_LINES).join('\n');
    fs.writeFileSync(file, '[日志轮转 ' + now() + '：原 ' + Math.round(st.size / 1024) + ' KB，保留最后 ' + KEEP_LINES + ' 行]\n' + kept, 'utf8');
    return true;
  } catch (e) { return false; }
}

/** 追加一行（自动带时间戳），必要时轮转。console 也打一份 */
function log(file, msg) {
  const f = abs(file);
  const s = now() + '  ' + msg;
  process.stdout.write(s + '\n');
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    rotate(f);
    fs.appendFileSync(f, s + '\n', 'utf8');
  } catch (e) { /* 写日志失败不能影响主流程 */ }
  return s;
}

/** 只写文件不打屏 */
function silent(file, msg) {
  const f = abs(file);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    rotate(f);
    fs.appendFileSync(f, now() + '  ' + msg + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

/** 读尾部 n 行，排障用 */
function tail(file, n) {
  try {
    const lines = fs.readFileSync(abs(file), 'utf8').split('\n');
    return lines.slice(-(n || 40)).join('\n');
  } catch (e) { return ''; }
}

module.exports = { log, silent, tail, rotate, abs };
