/** 回归检查用：扫包里代码（非注释）的 --from/--store/--preset 是否指向包内存在的东西 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

function scan() {
  const R = process.env.XY_RELEASE_DIR || 'D:/xianyu-release';
  if (!fs.existsSync(R)) return { skip: '发布目录不存在' };
  const z = fs.readdirSync(R)
    .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(R, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!z.length) return { skip: '没有 zip' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hint-'));
  try {
    execFileSync('tar', ['-xf', path.join(R, z[0].f), '-C', tmp], { stdio: 'pipe' });
    const root = path.join(tmp, fs.readdirSync(tmp)[0]);
    const A = path.join(root, 'xianyu-achun');
    const stores = fs.readdirSync(path.join(A, 'stores'))
      .filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    const presets = fs.readdirSync(path.join(A, 'presets'))
      .filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

    const PLACEHOLDER = /^(XX|X|店铺名|\.\.\.|我的测试店)$/;
    const bad = [];
    (function walk(d, dep) {
      if (dep > 5) return;
      for (const f of fs.readdirSync(d)) {
        if (['node_modules', '.git', 'publish-out'].includes(f)) continue;
        const p = path.join(d, f);
        let st; try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) { walk(p, dep + 1); continue; }
        if (!/\.(js|ps1|cmd)$/.test(f)) continue;
        let t;
        try { t = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
        const rel = path.relative(A, p).replace(/\\/g, '/');
        t.split(/\r?\n/).forEach((line, i) => {
          const s = line.trim();
          if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('#')) return;
          for (const m of line.matchAll(/--(from|store|preset)=["']?([^"'\s|)\]]+)["']?/g)) {
            const k = m[1], v = m[2];
            if (v.startsWith('<') || v.includes('$') || PLACEHOLDER.test(v)) continue;
            const ok = k === 'preset' ? presets.includes(v) : stores.includes(v);
            if (!ok) bad.push('--' + k + '=' + v + ' ← ' + rel + ':' + (i + 1));
          }
        });
      }
    })(A, 0);
    return { bad, stores, presets };
  } finally {
    // 清临时目录失败（EPERM，句柄还没放）不该让检查本身判失败 —— make-release 一直是这么包的
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log('  · 临时目录没清掉（句柄还占着），不影响结果: ' + e.message); }
  }
}

module.exports = { scan };

if (require.main === module) {
  const r = scan();
  if (r.skip) { console.log('  · ' + r.skip); process.exit(2); }
  console.log('  包内店档案: ' + (r.stores.join(', ') || '（无）'));
  console.log('  包内样板:   ' + (r.presets.join(', ') || '（无）'));
  if (!r.bad.length) { console.log('  ✅ 全部指向包里存在的'); process.exit(0); }
  console.log('  ❌ ' + r.bad.length + ' 处:');
  [...new Set(r.bad)].slice(0, 10).forEach((b) => console.log('    ' + b));
  process.exit(1);
}
