/**
 * lib/museav.js —— 找到 museav CLI 的入口，不写死任何人的机器路径
 *
 * 为什么需要它（2026-11-12）：
 *   store-wizard.js 和 make-base-img.js 里原来都把入口写死成
 *     C:\Users\43462\scoop\apps\nodejs\current\bin\node_modules\museav-cli\dist\index.js
 *   那是【我这台机器】的 scoop 路径。学员的电脑上 npm 全局装在哪、是 scoop 还是
 *   nvm 还是官方安装包，都不一样 —— 写死就等于"只有我的机器能出图"。
 *
 * 解析顺序（前一个找不到就往下试）：
 *   ① 环境变量 MUSEAV_BIN（指向 museav 可执行文件，或直接指向 dist/index.js）
 *   ② 环境变量 MUSEAV_CLI（同义，历史叫法）
 *   ③ `npm root -g` 下的 museav-cli/dist/index.js（最通用：跟着 Node 走）
 *   ④ PATH 里的 museav / museav.cmd / museav.ps1 所在目录推 node_modules
 *   ⑤ 常见安装位置（scoop / AppData\npm / Program Files\nodejs）
 *
 * 找到返回 dist/index.js 的绝对路径（用 node 直接跑，绕开 shell 引号问题）；
 * 找不到返回 ''，调用方自己决定怎么报错。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 在某个 node_modules 根下找 museav-cli/dist/index.js */
function fromNodeModules(nmRoot) {
  if (!nmRoot) return '';
  const p = path.join(nmRoot, 'museav-cli', 'dist', 'index.js');
  return fs.existsSync(p) ? p : '';
}

function resolveMuseavCli() {
  // ①② 环境变量
  for (const key of ['MUSEAV_BIN', 'MUSEAV_CLI']) {
    const v = process.env[key];
    if (!v) continue;
    if (fs.existsSync(v) && /\.js$/i.test(v)) return v;              // 直接给了 index.js
    // 给了可执行文件：同目录下找 node_modules
    const guess = fromNodeModules(path.join(path.dirname(v), 'node_modules'));
    if (guess) return guess;
  }

  // ③ npm root -g（最通用）
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const root = String(execFileSync(npmCmd, ['root', '-g'], { encoding: 'utf8', timeout: 20000 })).trim();
    const hit = fromNodeModules(root);
    if (hit) return hit;
  } catch (e) { /* npm 不在 PATH，继续 */ }

  // ④ 从 PATH 里找 museav 的可执行文件，推同目录 node_modules
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = String(execFileSync(which, ['museav'], { encoding: 'utf8', timeout: 10000 })).trim();
    for (const line of out.split(/\r?\n/)) {
      const dir = path.dirname(line.trim());
      for (const sub of ['node_modules', path.join('..', 'node_modules')]) {
        const hit = fromNodeModules(path.resolve(dir, sub));
        if (hit) return hit;
      }
    }
  } catch (e) { /* PATH 里没有 museav */ }

  // ⑤ 常见位置兜底
  const cands = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    cands.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'));
    cands.push(path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'node_modules'));
    cands.push(path.join(home, 'scoop', 'apps', 'nodejs', 'current', 'bin', 'node_modules'));
  }
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
  for (const c of cands) {
    const hit = fromNodeModules(c);
    if (hit) return hit;
  }
  return '';
}

/** 给调用方用：拿不到就抛一句人话 */
function requireMuseavCli() {
  const p = resolveMuseavCli();
  if (p) return p;
  throw new Error(
    '找不到 museav CLI。先把中台客户端装上：npm i -g museav-cli@latest\n' +
    '  装完确认：museav -V 能打印版本\n' +
    '  如果装在非标准位置，设一个环境变量指过去：set MUSEAV_BIN=<你的>\museav-cli\dist\index.js'
  );
}

module.exports = { resolveMuseavCli, requireMuseavCli };
