#!/usr/bin/env node
/**
 * tools/check-refs.js —— 包内引用完整性：代码要读的文件，在包里吗
 *
 * 为什么有它（2026-11-13 第 149 轮）：
 *   手册第二节 ⑦ 写了「排掉任何文件之后，必须再搜一遍谁在引用它」，
 *   但那条只能靠人记得 —— 一天里漏了两次：
 *     107 轮 排掉「闲鱼自动化-操作手册.md」，install.ps1 结尾还印着它
 *     121 轮 排掉三份内部文档，给学员的一页说明里还列着它们
 *   第 140 轮手工扫过一次「包内提到但包里没有的文件名」，181 条里挑出
 *   真正的 1 个（staff-ui/server.js 要跑的 ensure-agent.js）。这次把它自动化。
 *
 * 只报【会真的导致运行失败】的三类：
 *   ① require('./x') / require('../x')  → 解析不到文件
 *   ② runScript(t, 'tools/x.js')        → 文件不存在
 *   ③ readFileSync/readFile(常量路径)   → 少见，跳过（路径多半是运行时拼的）
 *
 * 不报的（都是合理的）：
 *   · 运行时生成的文件（config.local.json / stores/*.json / 台账 / 日志）
 *   · 维护者工具（make-release.js 等，文档里提到是对的）
 *   · 产品名/示例（Node.js / xxx.md）
 *
 * 用法: node tools/check-refs.js [--zip=<路径>]
 * 退出码: 0 = 没问题；1 = 有会崩的
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = process.env.XY_RELEASE_DIR || path.join(ROOT, '..', '..', 'xianyu-release');

// 运行时才有的文件（不在包里是正常的）
const RUNTIME = new Set([
  'config.local.json', 'service.local.json', '上架台账.json', 'publish-schedule.json',
  'AD-EXCLUDE.json', 'ad-cost-breaker-state.json', 'ad-cost-breaker-msg.md',
  'ad-cost-breaker.log', 'healthcheck.json', 'startup.log', 'startup.old.log',
  'publish-schedule.lock', 'ad-window-alert.md', 'xy-scan-result.json',
  // files.json 是【更新包里带的元数据】（tools/update.js 从下载的新包里读），不在本包里
  'files.json',
]);
const isRuntime = (name) => RUNTIME.has(name) || /^(pause-result|cz-diag|campaigns-now|ad-pending|xy-scan-result)/.test(name);

/** 把注释行抹掉（保留行号），避免把注释里的用法示例当成真 require */
function stripComments(src) {
  return src.split(/\r?\n/).map((line) => {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return '';
    return line;
  }).join('\n');
}

function main() {
  console.log('');
  console.log('  ════ 包内引用完整性 ════');

  const zipArg = (process.argv.find((a) => a.startsWith('--zip=')) || '').split('=')[1];
  let zip = zipArg;
  if (!zip) {
    if (!fs.existsSync(RELEASE)) {
      console.log('  · 发布目录不存在: ' + RELEASE);
      process.exit(2);
    }
    const zips = fs.readdirSync(RELEASE)
      .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!zips.length) { console.log('  · 没有 zip'); process.exit(2); }
    zip = path.join(RELEASE, zips[0].f);
  }
  console.log('  ' + path.basename(zip));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
  try {
    execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'pipe' });
    const root = path.join(tmp, fs.readdirSync(tmp)[0]);
    const A = path.join(root, 'xianyu-achun');

    // 包里所有文件的相对路径（相对 achun）
    const have = new Set();
    (function walk(d, dep) {
      if (dep > 8) return;
      for (const f of fs.readdirSync(d)) {
        if (f === 'node_modules' || f === '.git') continue;
        const p = path.join(d, f);
        let st; try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) { walk(p, dep + 1); continue; }
        have.add(path.relative(A, p).replace(/\\/g, '/'));
      }
    })(A, 0);

    const jsFiles = [...have].filter((f) => /\.(js|mjs|cjs)$/.test(f));
    // 【第 161 轮加】.ps1 / .cmd / .bat 里也会引用 tools\xxx.js ——
    //   原来只扫 .js，于是 install.ps1 调 make-templates-from-example.js 这种
    //   「安装器要跑的脚本被白名单排掉了」完全扫不到，直到学员机上装完才发现。
    const shellFiles = [...have].filter((f) => /\.(ps1|cmd|bat)$/i.test(f));
    console.log('  包内 js: ' + jsFiles.length + ' 个，shell: ' + shellFiles.length + ' 个\n');

    const problems = [];

    for (const rel of jsFiles) {
      const abs = path.join(A, rel);
      let t;
      try { t = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
      // 抹掉注释 —— 第 149 轮第一版没做，lib/*.js 头部的用法示例
      //   `*   const agent = require('./lib/agent');` 被当成真的 require，报了 8 个假问题。
      t = stripComments(t);
      const dir = path.dirname(rel);

      // ① require 相对路径
      for (const m of t.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
        const spec = m[1];
        const base = path.posix.normalize(path.posix.join(dir, spec)).replace(/\\/g, '/');
        const cands = [base, base + '.js', base + '.json', base + '.mjs', base + '/index.js'];
        if (!cands.some((c) => have.has(c))) {
          problems.push({ file: rel, what: "require('" + spec + "')", why: '解析不到 ' + base });
        }
      }

      // ② runScript(t, 'tools/xxx.js')  /  execFileSync(..., [path.join(ROOT,'tools','xxx.js')])
      for (const m of t.matchAll(/runScript\([^,]+,\s*['"](tools\/[\w.\-]+\.js)['"]/g)) {
        if (!have.has(m[1])) {
          problems.push({ file: rel, what: "runScript('" + m[1] + "')", why: '包内没有这个文件' });
        }
      }
      for (const m of t.matchAll(/['"]tools\/([\w.\-]+\.js)['"]/g)) {
        const name = 'tools/' + m[1];
        if (have.has(name)) continue;
        // 只有出现在可执行位置（runScript / execFileSync 附近）才算
        const idx = t.indexOf(m[0]);
        const near = t.slice(Math.max(0, idx - 120), idx + 120);
        if (/runScript|execFileSync|execFile\(|spawn/.test(near)) {
          if (!problems.some((p) => p.file === rel && p.what.includes(m[1]))) {
            problems.push({ file: rel, what: "'" + name + "'", why: '包内没有这个文件（在可执行位置被调用）' });
          }
        }
      }

      // ③ 明确写死的 readFileSync('xxx.md') 这类（跳过运行时文件）
      for (const m of t.matchAll(/readFileSync\(\s*(?:path\.join\([^)]*,\s*)?['"]([\w\u4e00-\u9fa5.\-]+\.(?:md|html|json|txt))['"]/g)) {
        const name = m[1];
        if (isRuntime(name)) continue;
        if (have.has(name)) continue;
        if (problems.some((p) => p.file === rel && p.what.includes(name))) continue;
        // 只有 basename 匹配不到的才算
        const baseHit = [...have].some((f) => f.split('/').pop() === name);
        if (!baseHit) problems.push({ file: rel, what: "readFileSync('" + name + "')", why: '包内找不到同名文件' });
      }

      // ④ path.join(ROOT, 'tools', 'xxx.js') —— 子进程调用
      //   【第 164 轮加】first-publish.js 用
      //       run(NODE, [path.join(ROOT, 'tools', 'agent-reset.js'), '--help'])
      //   当环境探针，而那个脚本被白名单排掉了 —— 于是每次发链接第一步打
      //   「Error: Cannot find module '...agent-reset.js'」。
      //   这种写法字符串里【没有 tools/ 前缀】（是拼出来的），所以上面几条都扫不到。
      //
      //   OPTIONAL = 调用方明确 try/catch 掉的「可选依赖」，缺了会走降级路径，
      //   不算会崩。目前只有 feishu-alert.js：ad-window.js L100-105把它包在
      //   try 里，缺了就退企微、再退桌面文件（飞书凭据本来就是运行时才有的）。
      const OPTIONAL = new Set(['tools/feishu-alert.js',
        // 【第 212 轮】ad-window.js L111 调 wecom-send.ps1 —— 整段包在 try/catch 里，
        //   缺了只会在日志里记「告警异常（企微 exit -1）」，不崩。而且企微 webhook
        //   本来就是管理员的，学员机器上配了也发不出去。
        'wecom-send.ps1',
        // 【第 212 轮】install-tasks 的7 个监控目标 —— 第165 轮专门处理过：
        //   它们是【管理员那边】的计划任务，包里本来就不带；install-tasks 会
        //   逐个 resolvable() 检查、缺的跳过并打中文说明「这不是你装错了」。
        //   healthcheck 的 start.bat 是【拼给人看的修复提示字符串】，不是真去调。
        'ad-window-8am.cmd', 'ad-window-11pm.cmd', 'ad-window-guard.cmd',
        'ad-balance-duty.ps1', 'ad-retry-order.ps1', 'ad-watch-stuck.ps1',
        'wake-publish-sleep.bat', 'start.bat']);
      for (const m of t.matchAll(/path\.join\([^,]+,\s*['"]tools['"]\s*,\s*['"]([\w.\-]+\.js)['"]/g)) {
        const target = 'tools/' + m[1];
        if (have.has(target)) continue;
        if (OPTIONAL.has(target)) continue;
        if (problems.some((p) => p.file === rel && p.what.includes(target))) continue;
        problems.push({ file: rel, what: target, why: 'path.join 调的子脚本不在包里（拼接写法，上面几条扫不到）' });
      }

      // ⑤ path.join(ROOT, 'xxx.ps1'/'xxx.cmd'/'xxx.mjs') —— 两参、直接指文件
      //   【第 212 轮加】第 211 轮复查孤儿时发现：
      //     wecom-sheet.js → ss-call.ps1    （.ps1 被 ⑭ 排了，.js 却在包里）
      //   只扫【脚本类扩展名】—— .json/.md/.csv 大多是运行时生成或已知保留，
      //   全扫会出 35 个误报（第 212 轮第一版就撞了）。
      for (const m of t.matchAll(/path\.join\([^,]+,\s*['"]([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*\.(?:ps1|cmd|bat|mjs))['"]/g)) {
        const target = m[1];
        if (have.has(target)) continue;
        if (OPTIONAL.has(target)) continue;
        if (problems.some((p) => p.file === rel && p.what.includes(target))) continue;
        problems.push({ file: rel, what: target, why: 'path.join 指向的脚本不在包里' });
      }
    }

    // ④ .ps1 / .cmd / .bat 里引用的 tools\xxx.js
    //   【第 161 轮加】install.ps1 会调 make-templates-from-example.js 生成文案模板库，
    //   而那个脚本被 tools 白名单排掉了 —— 于是学员机上：
    //     install.ps1 报「缺 ... 不影响发布」，然后 first-publish 因为没模板库直接炸。
    //   这类「安装器要跑的脚本不在包里」原来完全扫不到（只扫 .js）。
    for (const rel of shellFiles) {
      const abs = path.join(A, rel);
      let t;
      try { t = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
      const found = new Set();
      // 'tools\xxx.js' / 'tools/xxx.js' 字符串字面量
      for (const m of t.matchAll(/['"](?:\.\\)?tools[\\/]([\w.\-]+\.js)['"]/g)) found.add('tools/' + m[1]);
      // Join-Path $x 'tools\xxx.js'
      for (const m of t.matchAll(/Join-Path\s+\$\w+\s+'tools[\\/]([\w.\-]+\.js)'/gi)) found.add('tools/' + m[1]);
      for (const target of found) {
        if (have.has(target)) continue;
        if (problems.some((p) => p.file === rel && p.what.includes(target))) continue;
        problems.push({ file: rel, what: target, why: 'shell 脚本引用的文件不在包里（.ps1/.cmd 原来扫不到）' });
      }
    }

    if (!problems.length) {
      console.log('  ✅ 包内代码引用的文件都在（require / runScript / readFile / .ps1 四类都查了）');
      console.log('');
      return 0;
    }
    console.log('  ❌ 有 ' + problems.length + ' 处会运行时报错:\n');
    problems.slice(0, 15).forEach((p) => {
      console.log('    ' + p.file);
      console.log('        ' + p.what + '   —— ' + p.why);
    });
    if (problems.length > 15) console.log('    …还有 ' + (problems.length - 15) + ' 处');
    console.log('');
    return 1;
  } finally {
    // 同上：清理失败 ≠ 检查失败
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('  · 临时目录没清掉（句柄还占着），不影响结果: ' + e.message); }
  }
}

process.exit(main());
