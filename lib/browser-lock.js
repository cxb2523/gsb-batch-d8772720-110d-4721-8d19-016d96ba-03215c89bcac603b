/**
 * lib/browser-lock.js —— 浏览器互斥锁（多会话共用同一个 8093 浏览器时用）
 *
 * 为什么需要实体锁而不是只写一份约定：2026-10-11 实测撞车 ——
 *   会话【工程】的 preset-export.js 反复把店页导航到 /publish?itemId=，
 *   会话【运营】的 ad-editor-run.js 同时用 location.href 跳广告后台，
 *   结果两次都报 "Execution context was destroyed"，看着像代码 bug，实际是抢页面。
 *   约定写在 md 里没人执行等于没有，所以这里给一个必须显式拿放的锁文件。
 *
 * 设计：
 *   · 锁文件 browser.lock（仓库根目录），内容是 JSON：谁、何时、在跑什么。
 *   · 超过 TTL_MINUTES（默认 15 分钟）视为死锁，可以抢占；抢占时把原内容追加进 协作-待办.md。
 *   · 【只读且不导航】的操作不需要锁（mtop 接口、本地文件）。
 *
 * 命令行用法（跑任何会导航页面的脚本前）：
 *   node lib/browser-lock.js acquire 运营 "ad-editor-run 给计划加宝贝"
 *   node lib/browser-lock.js release
 *   node lib/browser-lock.js status
 *
 * 模块用法：
 *   const lock = require('./lib/browser-lock');
 *   const ok = lock.acquire('运营', '跑 xxx');   // false = 别人正拿着，别抢
 *   try { ...跑浏览器... } finally { lock.release(); }
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCK = path.join(ROOT, 'browser.lock');
const TODO = path.join(ROOT, '协作-待办.md');
const TTL_MINUTES = 15;

function read() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) { return null; }
}
function ageMinutes(info) {
  if (!info || !info.at) return Infinity;
  const t = Date.parse(info.at);
  return isFinite(t) ? (Date.now() - t) / 60000 : Infinity;
}
function status() {
  const info = read();
  if (!info) return { held: false };
  const age = ageMinutes(info);
  return { held: age < TTL_MINUTES, info, ageMinutes: +age.toFixed(1), stale: age >= TTL_MINUTES };
}

function acquire(by, what) {
  const s = status();
  if (s.held) {
    console.error('⛔ 浏览器锁被占：' + s.info.by + ' 于 ' + s.info.at + '（' + s.ageMinutes + ' 分钟前）正在 ' + s.info.what);
    console.error('   要么等，要么改做免导航的活（mtop 接口 / 本地文件）。超 15 分钟才算死锁。');
    return false;
  }
  if (s.stale) {
    // 死锁抢占：留痕，不静默吞掉
    try {
      fs.appendFileSync(TODO, '\n| ' + new Date().toLocaleString('zh-CN') + ' | ' + by
        + ' | 抢占超时浏览器锁 | 原持有者 ' + s.info.by + '（' + s.ageMinutes + ' 分钟前，在跑 '
        + s.info.what + '）| 若那位还在跑，请老板裁决 |\n', 'utf8');
    } catch (e) {}
    console.log('⚠️ 原锁已超时 ' + s.ageMinutes + ' 分钟，按死锁抢占，已记入 协作-待办.md');
  }
  fs.writeFileSync(LOCK, JSON.stringify({ by, at: new Date().toISOString(), what }, null, 1), 'utf8');
  console.log('🔒 已拿浏览器锁：' + by + ' — ' + what);
  return true;
}

function release() {
  try { fs.unlinkSync(LOCK); console.log('🔓 已释放浏览器锁'); return true; }
  catch (e) { console.log('（没有锁文件，无需释放）'); return false; }
}

module.exports = { acquire, release, status, LOCK };

if (require.main === module) {
  const [cmd, by, ...rest] = process.argv.slice(2);
  const what = rest.join(' ');
  if (cmd === 'acquire') {
    if (!by) { console.log('用法: node lib/browser-lock.js acquire <会话标识> "<在跑什么>"'); process.exit(2); }
    process.exit(acquire(by, what || '(未说明)') ? 0 : 1);
  } else if (cmd === 'release') {
    release();
  } else if (cmd === 'status') {
    const s = status();
    console.log(s.held
      ? '🔒 被占：' + s.info.by + ' 于 ' + s.info.at + '（' + s.ageMinutes + ' 分钟前）— ' + s.info.what
      : (s.stale ? '⚠️ 有锁但已超时 ' + s.ageMinutes + ' 分钟（视作死锁，可抢占）' : '🔓 空闲'));
  } else {
    console.log('用法: node lib/browser-lock.js acquire|release|status [会话标识] ["在跑什么"]');
    process.exit(2);
  }
}
