/**
 * tools/scrub-secrets.js — 把【进版本库的文本文件】里的真实密钥换成占位符
 *
 * 为什么需要它：
 *   这个仓库要 push 到 gitlab、学员要 clone。而仓库里散着一批"配置盘点"文档，
 *   它们当初的用途就是【把值抄下来】，于是 8093 密钥 / 中台 key / 企微 chatId /
 *   闲鱼账号密码 全都被明文写在 .md 里。
 *
 *   人工一个个找必然会漏 —— 所以做成工具，而且【密钥清单不是写死在工具里的】：
 *   从本机配置（config.local.json + 服务侧 service.local.json）和本机 8093 接口读。
 *   这样工具本身不含任何密钥，可以安全入库。
 *
 * 用法:
 *   node tools/scrub-secrets.js              # 预览：只列出"哪个文件含哪个敏感值"
 *   node tools/scrub-secrets.js --apply      # 就地替换成占位符
 *   node tools/scrub-secrets.js --show-values  # 连值一起打（默认脱敏显示）
 *
 * 退出码：0 = 干净或已清理；1 = 预览时发现残留（可以挂进 pre-push）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const { ROOT, PATHS, readJSON } = require('../lib/env');
const https = require('https');
const http = require('http');

const APPLY = process.argv.includes('--apply');
const SHOW = process.argv.includes('--show-values');

// ── 1. 收集敏感值（值 → 占位符）────────────────────────────────
const SECRETS = new Map();
function add(value, label, placeholder) {
  const v = (value === undefined || value === null) ? '' : String(value).trim();
  // 太短的值不替换：会把正常词也换掉（比如 "50"、"hope"）
  if (v.length < 6) return;
  if (/^[<(\[]/.test(v)) return;                       // 已经是占位符
  if (/^(true|false|null|undefined)$/i.test(v)) return;
  SECRETS.set(v, placeholder || ('<见 config.local.json: ' + label + '>'));
}

const localCfg = readJSON(path.join(ROOT, 'config.local.json'), {}) || {};
add(localCfg.service && localCfg.service.apiKey, 'service.apiKey');
add(localCfg.middle && localCfg.middle.key, 'middle.key');
add(localCfg.wecom && localCfg.wecom.chatId, 'wecom.chatId');
add(localCfg.middle && localCfg.middle.tenant, 'middle.tenant', '<见 config.local.json: middle.tenant>');

const svcLocal = readJSON(path.join(PATHS.playwrightService || '', 'service.local.json'), {}) || {};
add(svcLocal.apiKey, 'service.local.json apiKey', '<见 playwright-service/service.local.json: apiKey>');
add(svcLocal.hymUser, 'hymUser', '<见 playwright-service/service.local.json: hymUser>');
add(svcLocal.hymPass, 'hymPass', '<见 playwright-service/service.local.json: hymPass>');
add(svcLocal.hymKey, 'hymKey', '<见 playwright-service/service.local.json: hymKey>');
add(svcLocal.supaKey, 'supaKey', '<见 playwright-service/service.local.json: supaKey>');

// 闲鱼账号密码：从本机 8093 拉（服务没起就跳过，不报错）
function fetchJson(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 8000 },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── 2. 遍历 git 跟踪的文本文件 ──────────────────────────────────
function trackedFiles() {
  try {
    // stdio 必须显式给：不给的话 git 的 stderr（"fatal: not a git repository..."）
    //   会直接漏到学员屏幕上，那正是这个 catch 要避免的英文报错。
    const out = execFileSync('git', ['ls-files', '-z'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\0').filter(Boolean);
  } catch (e) {
    // 【2026-11-13 第 152 轮】学员包【不带 .git】（打包规则第 ③ 条 —— 带了等于把
    //   git 历史和内部密钥发出去），所以 `git ls-files` 在学员机上必然失败。
    //   原来这里直接 process.exit(1)，学员照《学员配置手册》速查表敲
    //   `node tools/scrub-secrets.js` 就卡在一句英文上：
    //       ❌ 读不到 git 跟踪文件列表（不是 git 仓库？）：Command failed: git ls-files
    //   而这个脚本本来就有一个 walkTracked() 在遍历目录 —— 没有 git 概念时，
    //   「包里的文件」就等于「会被发出去的文件」，扫全部反而更保险。
    return null;
  }
}

function walkTracked(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', '_archive', 'browser-profiles'].includes(e.name)) continue;
      walkTracked(full, acc);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (['.js', '.json', '.md', '.txt', '.ps1', '.bat', '.cmd', '.html', '.yml', '.yaml', '.csv'].includes(ext)) acc.push(full);
    }
  }
  return acc;
}

async function main() {
  const acc = await fetchJson('http://127.0.0.1:8093/api/agent/accounts');
  if (acc && Array.isArray(acc.data)) {
    for (const a of acc.data) add(a.password, '闲鱼账号密码', '<见 8093 的 GET /api/agent/accounts>');
  } else {
    console.log('（8093 没在跑，跳过"闲鱼账号密码"这一类；只清本机配置里的值）');
  }

  console.log('── 敏感值清单（' + SECRETS.size + ' 条）──');
  for (const [v, ph] of SECRETS) {
    console.log('  ' + (SHOW ? v : v.slice(0, 5) + '****' + v.slice(-3)).padEnd(20) + ' -> ' + ph);
  }
  if (!SECRETS.size) { console.log('  没有可清理的值'); return; }

  const files = walkTracked(ROOT, []);
  const trackedList = trackedFiles();
  // tracked === null → 这台机器没有 git（学员包就是这样），
  //   此时「包里的文件」就等于「会被发出去的文件」，扫全部。
  const tracked = trackedList === null
    ? null
    : new Set(trackedList.map((f) => path.resolve(ROOT, f)));
  if (tracked === null) {
    console.log('· 这台机器不是 git 仓库（学员包不带 .git），改为扫目录下全部文件');
  }
  let dirty = 0, changed = 0;
  const report = [];
  const skipped = [];      // 非 UTF-8 / 读不了 —— 必须报出来，静默跳过等于漏网

  for (const f of files) {
    if (tracked && !tracked.has(path.resolve(f))) continue;   // 有 git 只看跟踪的（未跟踪的不会进仓库）
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { skipped.push(path.relative(ROOT, f) + '（读不了: ' + e.message + '）'); continue; }
    if (buf.length > 4 * 1024 * 1024) { skipped.push(path.relative(ROOT, f) + '（>4MB）'); continue; }
    if (buf.includes(0)) { skipped.push(path.relative(ROOT, f) + '（二进制）'); continue; }
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) { skipped.push(path.relative(ROOT, f) + '（不是 UTF-8，可能是 GBK —— 里面的密钥本工具清不了，要人工看）'); continue; }
    const hits = [];
    let out = text;
    for (const [v, ph] of SECRETS) {
      if (!out.includes(v)) continue;
      const n = out.split(v).length - 1;
      hits.push(n + '× ' + (SHOW ? v : v.slice(0, 5) + '****'));
      out = out.split(v).join(ph);
    }
    if (!hits.length) continue;
    dirty++;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    report.push(rel + '   [' + hits.join(', ') + ']');
    if (APPLY) {
      fs.writeFileSync(f, out, 'utf8');
      changed++;
    }
  }

  console.log('\n── 命中 ──');
  if (!report.length) console.log('  ✅ 跟踪文件里没有真实密钥');
  else report.forEach((r) => console.log('  ' + (APPLY ? '已清 ' : '⛔ ') + r));

  if (skipped.length) {
    console.log('\n── 跳过的（本工具处理不了，必须人工看）──');
    skipped.forEach((s) => console.log('  ⚠️ ' + s));
  }

  if (APPLY) console.log('\n✅ 已清理 ' + changed + ' / ' + dirty + ' 个文件（预览时是 ' + dirty + ' 个）');
  else if (dirty) { console.log('\n📋 预览模式，没改任何文件。清理：node tools/scrub-secrets.js --apply'); process.exit(1); }
}
main().catch((e) => { console.log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
