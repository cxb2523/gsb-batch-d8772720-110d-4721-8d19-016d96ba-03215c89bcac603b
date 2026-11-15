/**
 * tools/utf8-check.js — 全仓库 UTF-8 审计
 *
 * 背景：项目里出过两类真实事故
 *   1) .ps1 被写成不带 BOM 的 UTF-8，PowerShell 5.1 按 GBK 读 → 中文正则失效、引号断裂
 *   2) 某个 _*-run.js 的店铺名烂成 '濂芥槗缇庝唬鎷?'（GBK 字节被当 UTF-8 解码）却一直没发现
 *
 * 规则（老板定的）：UTF-8 是万国码，全项目统一。
 *   - .js/.json/.md/.html/.yml/.csv/.txt   → UTF-8，不带 BOM
 *   - .ps1/.bat                             → UTF-8 **带 BOM**（PowerShell 5.1 才不按 GBK 读）
 *
 * 用法: node tools/utf8-check.js [--fix]
 *   --fix 会给 .ps1/.bat 补 BOM，并把纯 ASCII 文件保持原样
 *
 * 退出码：0 全好，1 有问题
 */
const fs = require('fs');
const path = require('path');
const out = require('../lib/out');
const { ROOT } = require('../lib/env');

const FIX = process.argv.includes('--fix');
// 【第 248 轮】NEED_BOM 原来有 '.cmd'，但本文件 L10 的说明只写了 .ps1/.bat —— 自相矛盾。
//   更要命的是：--fix 会【真的给 GBK 的 .cmd 加 UTF-8 BOM】，
//   实测把 启动.cmd / 体检.cmd / run-node.cmd 三个入口全改坏了
//   （BOM 在 GBK 里解成「锘?」，@echo off 不再生效 → 每行命令都被回显）。
//   而 .cmd 是【故意用 GBK】的（第 153/176 轮：chcp 936 + GBK 存，UTF-8 的 chcp 之后再写中文会乱码）。
//   所以：.cmd 不要求 BOM，也【不】当「坏 UTF-8」报 —— 见下面 GBK 分支。
const NEED_BOM = ['.ps1', '.bat'];
const TEXT = ['.js', '.mjs', '.json', '.md', '.txt', '.html', '.yml', '.yaml', '.csv', '.xml', '.ps1', '.bat', '.cmd', '.ndjson'];
const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', 'desktop-profile-backup', 'blobs', 'Cache', 'Code Cache']);

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function walk(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT.includes(ext)) acc.push(full);
    }
  }
  return acc;
}

const files = walk(ROOT, []);
const report = { total: files.length, noBomPs1: [], badUtf8: [], bomOnJs: [], crlfMixed: [], cmdNonAscii: [], fixed: [], stripped: [] };
let checked = 0;

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { continue; }
  if (buf.length > 8 * 1024 * 1024) continue;          // 超大文件跳过（baseline 备份等）
  if (buf.includes(0)) continue;                        // 含 NUL 视为二进制
  checked++;

  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const body = hasBom ? buf.subarray(3) : buf;

  // 1) 能不能当 UTF-8 读
  const text = body.toString('utf8');
  if (text.includes('\uFFFD')) {
    // 【第 248 轮】.cmd 是【故意用 GBK 存】的（chcp 936 + GBK），当 UTF-8 读必然出替换字符。
    //   这不是坏文件，报出来只会让人去 --fix 它 —— 而 --fix 一修就把它改成 UTF-8+BOM，
    //   GBK 下 @echo off 前面多出「锘?」，入口脚本当场坏掉（第248 轮实测：启动.cmd/体检.cmd/run-node.cmd 三个全中）。
    //   所以 .cmd/.bat 只要【能当 GBK 干净解出中文】就放行；GBK 也解不干净才是真坏。
    if (ext === '.cmd' || ext === '.bat') {
      try {
        const gbk = new TextDecoder('gbk').decode(body);
        if (gbk.includes('\uFFFD')) report.badUtf8.push(rel);
      } catch (e) { report.badUtf8.push(rel); }
    } else {
      report.badUtf8.push(rel);
    }
  }

  // 2) BOM 要求
  const needBom = NEED_BOM.includes(ext);
  const isAscii = !/[^\x00-\x7F]/.test(text);
  if (needBom && !hasBom && !isAscii) {
    report.noBomPs1.push(rel);
    if (FIX) {
      try {
        fs.writeFileSync(f, Buffer.concat([BOM, body]));
        report.fixed.push(rel);
      } catch (e) { /* ignore */ }
    }
  }
  if (!needBom && hasBom) {
    report.bomOnJs.push(rel);
    // BOM 对 JSON 是致命的（JSON.parse(fs.readFileSync(...)) 会抛 Unexpected token），
    // 对 .js/.md 无害但没必要。统一剥掉。
    // 安全性前提：所有 PowerShell 读取端都显式写了 -Encoding UTF8（已逐个核对过）。
    if (FIX) {
      try { fs.writeFileSync(f, body); report.stripped.push(rel); } catch (e) { /* ignore */ }
    }
  }

  // 2b) 【2026-10-08 加】.cmd 含非 ASCII 且没开 chcp 65001 → cmd.exe 按 OEM 936 解码，
  //     UTF-8 的三字节汉字重解码后可能落在 ASCII 元字符上，注释行被拆碎当命令执行，
  //     最后 exit /b %ERRORLEVEL% 把垃圾错误码带出去。
  //     实锤：2026-10-07 23:00 的 XianyuAdWindow11PM 就是这样返回 0xFF，
  //     日志一行没写，推广窗口整晚没关。修法二选一：
  //       ① 把中文搬进 .js（推荐，.cmd 只留 ASCII 引导代码）
  //       ② 第 2 行加 chcp 65001（此时文件字节真按 UTF-8 解码，才是安全的）
  if (ext === '.cmd' && !isAscii) {
  // 【第 248 轮】两种 chcp 都算「有意为之」：65001=UTF-8 存、936=GBK 存（第176 轮的入口设计）。
  if (!/^\s*chcp\s+(65001|936)/m.test(text)) report.cmdNonAscii.push(rel);
  }

  // 3) 行尾混用
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && lf > 0) report.crlfMixed.push(rel + ' (CRLF ' + crlf + ' / LF ' + lf + ')');
}

out.head('UTF-8 审计');
out.kv('扫描目录', ROOT);
out.kv('文本文件', report.total + '（实际解码 ' + checked + '）');
out.kv('规则', '.ps1/.bat 需带 BOM；其余 UTF-8 不带 BOM；.cmd 含中文必须 chcp 65001');

const problems = report.badUtf8.length + report.noBomPs1.length + report.cmdNonAscii.length;
if (report.badUtf8.length) {
  out.warn('非法 UTF-8（含替换字符 U+FFFD）共 ' + report.badUtf8.length + ' 个：');
  report.badUtf8.slice(0, 15).forEach((f) => out.plain('    ' + f));
}
if (report.noBomPs1.length) {
  out.warn('需要 BOM 但没有的脚本共 ' + report.noBomPs1.length + ' 个' + (FIX ? '（已补）' : '（加 --fix 自动补）') + '：');
  report.noBomPs1.slice(0, 15).forEach((f) => out.plain('    ' + f));
}
if (report.cmdNonAscii.length) {
  out.warn('.cmd 含非 ASCII 但没 chcp 65001 共 ' + report.cmdNonAscii.length + ' 个' +
    '（cmd.exe 按 OEM 936 解码会把中文拆成命令执行，退出码可能是垃圾值）：');
  report.cmdNonAscii.slice(0, 15).forEach((f) => out.plain('    ' + f + '   → 把中文搬进 .js，或第 2 行加 chcp 65001'));
}
if (report.bomOnJs.length) {
  out.kv('多余 BOM（' + (FIX ? '已剥离 ' + report.stripped.length + ' 个' : '加 --fix 剥离') + '）', report.bomOnJs.length + ' 个');
}
if (report.crlfMixed.length) {
  out.kv('行尾混用 CRLF/LF', report.crlfMixed.length + ' 个');
}
if (report.fixed.length) out.ok('已补 BOM（.ps1/.bat）' + report.fixed.length + ' 个');
if (report.stripped.length) out.ok('已剥离 BOM（.json/.js/.md）' + report.stripped.length + ' 个');
if (!problems) out.ok('全部合规');
out.full(report, 'utf8-check');
out.done(problems ? 1 : 0);
