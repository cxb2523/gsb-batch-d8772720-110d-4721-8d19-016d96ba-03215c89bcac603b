/**
 * tools/学员回报.js —— 一条命令把真机验证要贴的东西尽量自动收集好
 *
 * 为什么有这个（第 242 轮）：
 *   真机清单步骤10 让学员贴五段输出（校验/预演/正式装/体检/发布预演），
 *   但那些是【跑的时候打在屏幕上】的，学员十有八九没存 —— 让他回头再跑一遍
 *   又可能把状态改了（比如重装、重发）。所以做一个只读的收集器：
 *   能自动查的自动查，查不到的明确告诉他「这几段要手动贴」。
 *
 * 用法（在 xianyu-achun 目录里）：
 *   node tools\学员回报.js
 *   node tools\学员回报.js --zip="D:\下载\xianyu-install-xxx.zip"   （指定安装包位置）
 *   ⚠️ 路径里有空格时【一定要加引号】，否则 --zip= 后面只传进去一半（第246 轮实测）。
 *   --no-save 时不写桌面文件（冒烟测试用）。
 *
 * 原则：【只读】—— 不改任何配置、不跑安装、不发链接。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');            // xianyu-achun
const PKG = path.join(ROOT, '..');                  // 包根（三个目录并排）
const argOf = (k, d) => {
  const m = process.argv.slice(2).find((a) => a.startsWith('--' + k + '='));
  return m ? m.slice(k.length + 3) : d;
};

const out = [];
const P = (s) => { out.push(s); console.log(s); };

P('════ 学员机回报（自动生成，只读不改任何东西）════');
P('时间：' + new Date().toLocaleString('zh-CN'));
P('包根：' + PKG);
P('');

// ── 1. 安装包校验（对应清单步骤1）──────────────────────────────
P('【1】安装包校验');
try {
  let zip = argOf('zip', '');
  if (!zip) {
    // 在几个常见位置找
    const cands = [];
    for (const d of [PKG, os.homedir() + '\\Downloads', 'D:\\', 'C:\\Users\\' + os.userInfo().username + '\\Desktop']) {
      try {
        for (const f of fs.readdirSync(d)) if (/^xianyu-install-.*\.zip$/.test(f)) cands.push(path.join(d, f));
      } catch (e) { /* 目录不存在就跳过 */ }
    }
    cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    zip = cands[0] || '';
  }
  if (!zip || !fs.existsSync(zip)) {
    P('  ⚠️ 没找到安装包（用 --zip=路径 指一下，或把它和 .sha256 放一起）');
  } else {
    const h = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const shaFile = zip + '.sha256';
    P('  包：' + path.basename(zip));
    P('  实算：' + h);
    if (fs.existsSync(shaFile)) {
      const want = (fs.readFileSync(shaFile, 'utf8').match(/[0-9a-f]{64}/i) || [''])[0].toLowerCase();
      P('  文件：' + want);
      P('  ' + (want === h ? '✅ 一致' : '❌ 不一致 —— 没下全，重下'));
    } else {
      P('  ⚠️ 旁边没有 .sha256 文件，没法比（把 .sha256 放到 zip 同目录再跑一次）');
    }
  }
} catch (e) { P('  ❌ 校验出错：读不到安装包（路径不对或没下全）'); }
P('');

// ── 2. 目录结构（对应清单步骤2）────────────────────────────────
P('【2】解压结构');
const needDirs = ['xianyu-achun', 'xianyu-playwright-service', 'xianyu-monitor'];
const needFiles = ['install.cmd', 'install-guide.html', '先看这个-五步上手.html'];
let structOk = true;
for (const d of needDirs) {
  const ok = fs.existsSync(path.join(PKG, d));
  if (!ok) structOk = false;
  P('  ' + (ok ? '✅' : '❌') + ' ' + d + '\\');
}
for (const f of needFiles) {
  const ok = fs.existsSync(path.join(PKG, f));
  if (!ok) structOk = false;
  P('  ' + (ok ? '✅' : '❌') + ' ' + f);
}
if (!structOk) {
  // 【第244 轮】在开发机上跑会全是 ❌（那边 xianyu-achun 的父目录不是包根），
  //   不解释一句管理员会以为包坏了。
  const bareCheckout = fs.existsSync(path.join(PKG, '.git')) || fs.existsSync(path.join(ROOT, '.git'));
  if (bareCheckout && !fs.existsSync(path.join(PKG, 'xianyu-playwright-service'))) {
    P('');
    P('  ⚠️ 这看着像【开发机上的代码目录】，不是解压出来的学员包。');
    P('     学员包的判断：和 xianyu-achun 并排还有 xianyu-playwright-service / xianyu-monitor，');
    P('     以及包根的 install.cmd。要是你在开发机上跑，这节的 ❌ 是正常的。');
  } else {
    P('');
    P('  ⚠️ 结构不全 —— 解压没解对，或者只拷了一部分。对照清单步骤2 重新解压。');
  }
}
P('');
P('');

// ── 3. 配置状态 ────────────────────────────────────────────────
P('【3】配置状态');
const checks3 = [
  ['config.local.json（本机配置）', path.join(ROOT, 'config.local.json')],
  ['service.local.json（账号配置）', path.join(PKG, 'xianyu-playwright-service', 'service.local.json')],
  ['文案模板库', path.join(os.homedir(), '.xianyu-templates.json')],
  ['stores\\（店铺档案）', path.join(ROOT, 'stores')],
  ['browser-profiles\\（登录态）', path.join(PKG, 'xianyu-playwright-service', 'browser-profiles')],
];
for (const [name, p] of checks3) {
  let ok = false, extra = '';
  try {
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      ok = true;
      if (st.isDirectory()) extra = '（' + fs.readdirSync(p).filter((f) => !f.startsWith('_')).length + ' 项）';
    }
  } catch (e) { /* 忽略 */ }
  P('  ' + (ok ? '✅' : '⚠️') + ' ' + name + (ok ? extra : ' —— 还没有'));
}
// 店铺名
try {
  const sv = JSON.parse(fs.readFileSync(path.join(PKG, 'xianyu-playwright-service', 'service.local.json'), 'utf8'));
  const a = (sv.localAccounts || [])[0] || {};
  P('  店铺名：' + (a.name || '（没填）') + '   id：' + (a.id ? a.id.slice(0, 8) + '…' : '（没填）'));
  if (a.id && !/^[0-9a-f-]{36}$/i.test(a.id)) P('    ⚠️ id 看着不像 UUID（应该是36 位带横杠）');
} catch (e) {
  // 别把 e.message 原样甩出来 —— 里面常带 ENOENT / Cannot find module 这种英文，
  // 学员看不懂（第243 轮冒烟就是被这个 ENOENT 拦下的）。中文说清就够了。
  P('  ⚠️ 读不到 service.local.json（文件不存在或格式不对）');
}
P('');

// ── 4. 跑一遍预演安装（只读，等价于清单步骤4）─────────────────
P('【4】预演安装（重跑一遍，等于清单步骤4）');
try {
  const r = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'install.ps1'), '-DryRun'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const lines = String(r).split(/\r?\n/).filter((l) => l.trim());
  const want = lines.filter((l) => /\[ok\]\s+node:|\[FAIL\]|已就位|没有缺失项|剩下的|人工做/.test(l));
  (want.length ? want : lines.slice(-6)).slice(0, 10).forEach((l) => P('    ' + l.trim().slice(0, 120)));
  P('  ' + (/没有缺失项/.test(String(r)) ? '✅ 没有缺失项' : '⚠️ 上面有 [FAIL] 或缺项'));
} catch (e) {
  const s = String((e.stdout || '') + (e.stderr || ''));
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  lines.slice(0, 10).forEach((l) => P('    ' + l.trim().slice(0, 120)));
  P('  ⚠️ 预演退出码 ' + e.status + '（把上面整段贴回来）');
}
P('');

// ── 5. 一键体检（等于清单步骤6）───────────────────────────────
P('【5】一键体检');
try {
  const s = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'healthcheck.js')],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const lines = String(s).split(/\r?\n/);
  const sum = lines.filter((l) => /项通过|项待办|项有问题/.test(l));
  sum.forEach((l) => P('  ' + l.trim()));
  const bads = lines.filter((l) => l.trim().startsWith('❌'));
  bads.slice(0, 8).forEach((l) => P('    ' + l.trim().slice(0, 120)));
  P('  ' + (bads.length ? '（❌ 明细在上面）' : '✅ 没有 ❌'));
} catch (e) {
  const s = String((e.stdout || '') + (e.stderr || ''));
  s.split(/\r?\n/).filter((l) => /项通过|❌/.test(l)).slice(0, 8).forEach((l) => P('  ' + l.trim().slice(0, 120)));
  P('  ⚠️ 体检退出码 ' + e.status);
}
P('');

// ── 6. 最近的发布痕迹 ─────────────────────────────────────────
P('【6】最近的发布痕迹');
try {
  const po = path.join(ROOT, 'publish-out');
  if (!fs.existsSync(po)) { P('  （还没有 publish-out —— 一次都没发过/预演过）'); }
  else {
    const fs2 = fs.readdirSync(po).filter((f) => /\.(jpg|png|json|log)$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(po, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(0, 5);
    if (!fs2.length) P('  （目录是空的）');
    fs2.forEach((x) => P('    ' + new Date(x.t).toLocaleString('zh-CN') + '  ' + x.f));
  }
} catch (e) { P('  ⚠️ 读不到 publish-out（目录不存在或没权限）'); }
P('');

// ── 收尾：这几段脚本拿不到 ────────────────────────────────────
P('════ 还需要你手动贴的 ════');
P('下面几段是【当时屏幕上】的输出，脚本没法回头拿，');
P('如果你当时截了图或复制了就贴过来，没有就写「当时没存」：');
P('  · 正式安装那次（步骤5）的输出 —— 特别是文案模板那行、museav 那行、有没有 [FAIL]');
P('  · 发布预演（步骤9）的状态 —— 「预演完成」还是报错，报错原文');
P('  · 扫码登录（步骤8）有没有成功');
P('');
P('把【上面整段】+【这几条】一起发给管理员就行。');

// 存一份到桌面，方便直接拖进聊天
//   --no-save / XY_REPORT_NO_SAVE=1 时不写（冒烟测试用，别覆盖学员桌面上已有的那份）
if (!process.argv.includes('--no-save') && process.env.XY_REPORT_NO_SAVE !== '1') {
  try {
    const desktop = path.join(os.homedir(), 'Desktop', '学员机回报.txt');
    fs.writeFileSync(desktop, out.join('\r\n'), 'utf8');
    console.log('');
    console.log('  已存一份到桌面：' + desktop);
  } catch (e) { /* 桌面不可写就算了 */ }
} else {
  console.log('');
  console.log('  （--no-save：这次不写桌面文件）');
}
