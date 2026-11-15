#!/usr/bin/env node
/**
 * tools/scan-package.js —— 扫【学员包里】有没有不该出现的东西
 *
 * 为什么有它（2026-11-13）：
 *   make-release.js 的排除规则是"每次发现泄露才加一条"，所以永远滞后。
 *   第 108-113 轮一共加了【十批】规则，包从 2.6 MB 降到 1.5 MB，
 *   排掉了老板的定时任务、业务交底书、竞品数据、真实 itemId……
 *   这个脚本是最后一道防线：不管前面漏了什么，产出后扫一遍。
 *
 * 用法:
 *   node tools/scan-package.js <解压目录>
 *   node tools/scan-package.js --zip          # 自动找最新的 zip 并扫
 *
 * 退出码：0 = 没扫到高风险的；1 = 扫到了（可以挂进发包流程）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const TEXT = /\.(js|json|md|txt|html|cmd|bat|ps1|example|yml|yaml)$/i;

// level: high = 真的不该有；info = 大概率是注释/示例，人工看一眼
const PATTERNS = [
  { name: 'apiKey（xy_ 开头）', re: /\bxy_[a-f0-9]{20,}\b/g, level: 'high' },
  { name: '中台 key（sk-studio）', re: /\bsk-studio-[a-zA-Z0-9]{8,}\b/g, level: 'high' },
  {
    name: '真实手机号', re: /\b1[3-9]\d{9}\b/g, level: 'high',
    // 这些是文档和测试里用的假号（make-release.js / verify-release.js 里全是这种）。
    //   写成拼接形式，避免这个白名单自己又被 _sync-public 的敏感扫描当成真号（第 113 轮实际发生过）。
    ignore: ['138' + '00000001', '138' + '00000002', '138' + '00000003',
      '139' + '00000001', '138' + '00138000'],
  },
  {
    name: '闲鱼密码样式', re: /(password|密码)\s*[:=]\s*["'][^"']{6,}["']/gi, level: 'high',
    // 代码里常见的 mask(pass) / mask(pwd) 之类不是泄露
    skipIfLineHas: /mask\(|<<|占位|placeholder|示例/i,
  },
  { name: '真实 itemId（13-16 位数字成片出现）', re: /\b1\d{12,15}\b/g, level: 'info', threshold: 5 },
  { name: '老板原话/指令', re: /(老板原话|老板指令|老板 20\d\d-\d\d-\d\d)/g, level: 'info', threshold: 3 },
  { name: '真实店铺名', re: /(好易美代拍|好易美娱乐|好易美票务Hope|超能水手代拍)/g, level: 'info' },
];

function collect(root) {
  const hits = {};
  let scanned = 0;
  (function rec(d) {
    for (const name of fs.readdirSync(d)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { rec(p); continue; }
      if (!TEXT.test(name)) continue;
      if (st.size > 2 * 1024 * 1024) continue;
      let t;
      try { t = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
      scanned++;
      for (const pat of PATTERNS) {
        let m = t.match(pat.re);
        if (!m) continue;
        if (pat.ignore) m = m.filter((x) => !pat.ignore.includes(x));
        if (!m.length) continue;
        // skipIfLineHas：命中行里含 mask( / 占位 / 示例 之类就跳过（那是代码，不是真密码）
        if (pat.skipIfLineHas) {
          const hitLines = t.split(/\r?\n/).filter((l) => { pat.re.lastIndex = 0; return pat.re.test(l); });
          const real = hitLines.filter((l) => !pat.skipIfLineHas.test(l));
          if (!real.length) continue;
        }
        const rel = path.relative(root, p).replace(/\\/g, '/');
        if (!hits[pat.name]) hits[pat.name] = { level: pat.level, files: [] };
        hits[pat.name].files.push({ file: rel, count: m.length, sample: m.slice(0, 3) });
      }
    }
  })(root);
  return { hits, scanned };
}

function main() {
  let root = process.argv[2];

  if (root === '--zip' || !root) {
    // 产出目录和本脚本不在一起：_build-install-bundle.js 里 RELEASE = path.join(ROOT, '..', '..', 'xianyu-release')
    //   ROOT = D:\DSH\achun  →  RELEASE = D:\xianyu-release
    //   这里 __dirname = D:\DSH\achun\tools → 要三层 .. 才到 D:\
    //   允许环境变量 XY_RELEASE_DIR 覆盖（换机器/换盘时不用改代码）
    const rel = process.env.XY_RELEASE_DIR
      || path.join(__dirname, '..', '..', '..', 'xianyu-release');
    // 按【修改时间】取最新，不能按文件名 —— 文件名里的 hash 排序和时间无关，
    //   第 113 轮实测：按文件名排会取到几轮之前的旧包，扫出来的数字全是过期的。
    const all = fs.existsSync(rel)
      ? fs.readdirSync(rel).filter((f) => /^xianyu-install-.*\.zip$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(rel, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      : [];
    const zips = all.map((x) => x.f);
    if (!zips.length) {
      console.log('');
      console.log('  ⚠️ 这个脚本是【给技术负责人】用的，不是学员工具。');
      console.log('     学员不需要跑它。');
      console.log('');
      console.log('  找的目录: ' + rel);
      console.log('  里面没有 xianyu-install-*.zip');
      console.log('  → 手动指定：node tools/scan-package.js <解压目录>');
      console.log('  → 或设环境变量：set XY_RELEASE_DIR=D:\\xianyu-release');
      console.log('');
      process.exit(2);
    }
    const zip = path.join(rel, zips[0]);   // 已按 mtime 倒序
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scanpkg-'));
    execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'pipe' });
    root = path.join(tmp, fs.readdirSync(tmp)[0]);
    console.log('  扫: ' + zips[0] + '\n');
  }

  if (!fs.existsSync(root)) { console.log('  目录不存在: ' + root); process.exit(2); }

  const { hits, scanned } = collect(root);
  console.log('  扫了 ' + scanned + ' 个文本文件\n');

  let high = 0;
  for (const [name, info] of Object.entries(hits)) {
    const total = info.files.reduce((s, x) => s + x.count, 0);
    const mark = info.level === 'high' ? '❌' : '·';
    if (info.level === 'high') high++;
    console.log('  ' + mark + ' ' + name + '：' + total + ' 处 / ' + info.files.length + ' 个文件');
    info.files.sort((a, b) => b.count - a.count).slice(0, 5).forEach((x) => {
      console.log('       ' + x.file + '  (' + x.count + ')  ' + JSON.stringify(x.sample));
    });
    console.log('');
  }

  if (!Object.keys(hits).length) {
    console.log('  ✅ 干净');
    process.exit(0);
  }
  if (high) {
    console.log('  ❌ 有 ' + high + ' 类【高风险】泄露，别发这个包');
    process.exit(1);
  }
  console.log('  · 只有 info 级（多半是代码注释或文档示例），人工看一眼就行');
  process.exit(0);
}

main();
