/**
 * tools/verify-release.js — 校验刚打出来的学员包：无真手机号 / 内部文档已排除 / 必需文件在
 *
 * 为什么要有一个【独立】校验器，而不是信任 make-release 自己的扫描 —— 它已经抓到过
 * 两个我自己写出来的错：
 *   ① 我的排除正则里带了 `给学员`，把【给学员的一页说明.md】从包里剔掉了：
 *      学员最需要的安装说明没了，而 make-release 自己一声不吭地"成功"了
 *   ② 验证时目录里躺着新旧两个包，我按文件名排序选中了旧包，
 *      差点据此得出"包里还有真手机号"的错结论
 *   独立校验 + 干净的输出目录，才让这两条暴露出来。
 *
 * 用法: node tools/verify-release.js [输出目录]     （默认 D:\xianyu-release）
 * 退出码: 0 全过 / 1 有问题
 *
 * 写法说明：别把这个逻辑塞进 `node -e`（上一版在 path.relative(process.argv[1]) 上崩了，
 * 而崩溃发生在打印之前 → 于是"没输出"被我误读成"没命中"）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const OUT = process.argv[2] || 'D:\\xianyu-release';
const zip = fs.readdirSync(OUT).find((f) => /^xianyu-achun-.*\.zip$/.test(f));
if (!zip) { console.log('❌ 找不到包'); process.exit(1); }
console.log('校验对象: ' + zip);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgv-'));
execFileSync('tar', ['-xf', path.join(OUT, zip), '-C', tmp]);
const pkg = path.join(tmp, 'xianyu-achun');

// ── 1. 真手机号 ──
const RE = /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g;
const FAKE = new Set(['13800000001', '13800000002', '13800000003', '13800138000']);
let n = 0;
(function walk(d) {
  for (const x of fs.readdirSync(d)) {
    const p = path.join(d, x);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (fs.statSync(p).size > 4 * 1024 * 1024) continue;
    const m = fs.readFileSync(p, 'utf8').match(RE);
    if (!m) continue;
    [...new Set(m)].filter((y) => !FAKE.has(y)).forEach((y) => {
      n++;
      console.log('  ⚠️ ' + path.relative(pkg, p).replace(/\\/g, '/') + '  ' + y.slice(0, 3) + '****' + y.slice(7));
    });
  }
})(pkg);
console.log(n ? '  ❌ 真手机号 ' + n + ' 处' : '  ✅ 无真手机号');

// ── 2. 内部文档应被排除 ──
const shouldBeGone = ['index', '发给吴伟龙的agent.md', '学员配置体系-协同小美.md',
  'tools/_stub-install-config.js', '给王恩博-合并消息.md', 'stores/好易美代拍.json', 'config.local.json', '.git'];
let bad = 0;
shouldBeGone.forEach((f) => {
  const p = path.join(pkg, f);
  if (fs.existsSync(p)) { bad++; console.log('  ❌ 不该在包里: ' + f); }
});
console.log(bad ? '  ❌ 有 ' + bad + ' 项不该在' : '  ✅ 内部文档/密钥/素材都已排除');

// ── 3. 学员流程必需文件 ──
const must = ['install.ps1', 'install.cmd', 'run-node.cmd', '体检.cmd', '给学员的一页说明.md',
  '学员配置手册.md', '工程纪律.md', 'tools/healthcheck.js', 'tools/install-tasks.js',
  'tools/store-claim.js', 'tools/preset-export.js', 'tools/store-audit.js', 'tools/update.js',
  'tools/selftest-update.js', 'lib/store-profile.js', 'lib/mtop.js', 'lib/agent.js',
  'stores/_template.json', 'presets/代拍-标准.json'];
let miss = 0;
must.forEach((f) => { if (!fs.existsSync(path.join(pkg, f))) { miss++; console.log('  ❌ 缺: ' + f); } });
console.log(miss ? '  ❌ 缺 ' + miss + ' 个必需文件' : '  ✅ ' + must.length + ' 个必需文件都在');

// ── 4. 更新侧的包也看一眼 ──
const szip = fs.readdirSync(OUT).find((f) => /^xianyu-playwright-service-.*\.zip$/.test(f));
if (szip) {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgv2-'));
  execFileSync('tar', ['-xf', path.join(OUT, szip), '-C', t2]);
  const s = path.join(t2, 'xianyu-playwright-service');
  ['server.js', 'package.json', 'start.bat', 'wake-publish-sleep.bat', 'assets/poster-templates.json'].forEach((f) => {
    console.log('  ' + (fs.existsSync(path.join(s, f)) ? '✅' : '❌') + ' service/' + f);
  });
  console.log('  ' + (fs.existsSync(path.join(s, 'service.local.json')) ? '❌ service.local.json 不该在包里' : '✅ service.local.json 不在包里'));
  try { fs.rmSync(t2, { recursive: true, force: true }); } catch (e) {}
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(n || bad || miss ? 1 : 0);
