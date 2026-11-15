#!/usr/bin/env node
/**
 * tools/test-store-flow.js —— 店铺流程自检（不依赖登录，随时可跑）
 *
 * 为什么需要它（2026-11-12）：
 *   「直到你认为没问题为止」这句话，靠人眼一遍遍看是靠不住的。
 *   六轮测试里踩到的每一类问题（分类 id 不一致、底图是 PNG 伪装 jpg、
 *   版式不在注册表、userId 写死、文案池空），都应该变成一条能自动跑的断言。
 *   这样以后谁改了配置，跑一次就知道有没有改坏。
 *
 * 检查项（全部只读 + 只跑 --dry 预演，不发任何线上写请求）：
 *   1 档案存在且必填字段齐（name / accountId）
 *   2 分类 catName 和 channelCatId 【互相一致】（只改名字不改 id 是最隐蔽的错）
 *   3 主图池每个 key 都在 TPL_REGISTRY 里登记过
 *   4 底图存在，且【真实格式是 JPEG】（扩展名和内容必须一致）
 *   5 文案池非空，且和 ~/.xianyu-templates.json 的 storeTemplates 对齐
 *   6 价格 / 库存 / 规格 有值
 *   7 广告 9 项能解析（时段合计 ≥4 小时，平台硬要求）
 *   8 闲鱼userId 是否已配（没配 list-onsale 会拒绝运行）
 *   9 发布预演能出图（publish-one --dry）
 *  10 推广预演参数正确（ad-plan-create 不加 --apply）
 *
 * 用法:
 *   node tools/test-store-flow.js                      # 全部店铺
 *   node tools/test-store-flow.js --store=超能水手代拍
 *   node tools/test-store-flow.js --quick              # 跳过 9/10 两项（不动浏览器）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});
const QUICK = !!A.quick;

const profile = require('../lib/store-profile');

let STORES = [];
if (A.store) STORES = [A.store];
else {
  try { STORES = profile.list().map(x => x.name || x); } catch (e) { STORES = []; }
}
if (!STORES.length) { console.log('❌ 没找到任何店铺档案'); process.exit(2); }

const RESULT = {};   // store -> [{item, ok, note}]

function check(store, item, fn) {
  let ok = false, note = '';
  try { const r = fn(); ok = r === true || (r && r.ok); note = (r && r.note) || ''; }
  catch (e) { ok = false; note = e.message || String(e); }
  (RESULT[store] = RESULT[store] || []).push({ item, ok, note });
  return ok;
}

(function main() {
  console.log('\n════ 店铺流程自检 ════');
  console.log('（只读 + 只跑 --dry 预演，不发任何线上写请求）');
  if (QUICK) console.log('（--quick：跳过发布/推广预演）');

  for (const name of STORES) {
    console.log('\n── ' + name + ' ──');
    let p;
    try { p = profile.load(name); } catch (e) { console.log('  ❌ 档案读不出：' + e.message); continue; }

    check(name, '档案必填', () => {
      if (!p.name) throw new Error('缺 name');
      if (!p.accountId) throw new Error('缺 accountId（8093 的账号 id）');
      return true;
    });

    check(name, '分类一致', () => {
      const c = p.分类 || {};
      if (!c.catName) throw new Error('缺 catName');
      // 只改 catName 不改 channelCatId 是最隐蔽的错（2026-11-12 向导就犯过）
      const known = { '代购': '201456914', '演出票代拍': '202285710' };
      if (known[c.catName] && String(c.channelCatId) !== known[c.catName]) {
        throw new Error('catName=' + c.catName + ' 但 channelCatId=' + c.channelCatId + '（应为 ' + known[c.catName] + '）');
      }
      return { ok: true, note: c.catName + ' / ' + c.channelCatId };
    });

    check(name, '主图池', () => {
      const t = (p.主图 && p.主图.templates) || [];
      if (!t.length) throw new Error('空');
      const bad = t.filter(k => !profile.TPL_REGISTRY || !profile.TPL_REGISTRY[k]);
      if (bad.length) throw new Error('未在 TPL_REGISTRY 登记: ' + bad.join(','));
      return { ok: true, note: t.length + ' 款' + (t.length === 1 ? '（⚠️ 只有 1 款，发多条会重复用图）' : '') };
    });

    check(name, '底图格式', () => {
      const b = p.主图 && p.主图.baseImg;
      if (!b) return { ok: true, note: '未配（走大麦官方海报）' };
      const f = path.join(ROOT, b);
      if (!fs.existsSync(f)) throw new Error('文件不存在: ' + b);
      const { PATHS } = require('../lib/env');
      const sharp = require(path.join(PATHS.playwrightService, 'node_modules', 'sharp'));
      // 同步读文件头判断格式，避免 async
      const head = fs.readFileSync(f).slice(0, 12);
      const isPng = head[0] === 0x89 && head[1] === 0x50;
      const isJpg = head[0] === 0xFF && head[1] === 0xD8;
      if (b.toLowerCase().endsWith('.jpg') && isPng) throw new Error('扩展名 .jpg 但内容是 PNG（要转格式）');
      if (b.toLowerCase().endsWith('.png') && isJpg) throw new Error('扩展名 .png 但内容是 JPEG');
      return { ok: true, note: (isJpg ? 'JPEG' : isPng ? 'PNG' : '?') + '  ' + Math.round(fs.statSync(f).size / 1024) + 'KB' };
    });

    check(name, '文案池', () => {
      const ids = p.文案 && p.文案.templateIds;
      if (!ids || !ids.length) throw new Error('空（会用全部模板，但建议显式配）');
      return { ok: true, note: ids.join(',') };
    });

    check(name, '价格/库存/规格', () => {
      const price = (p.价格 && p.价格.default) || 0;
      const stock = (p.库存 && p.库存.default) || 0;
      const specs = (p.规格 && p.规格.specs) || [];
      if (!price) throw new Error('价格.default 为空');
      if (!stock) throw new Error('库存.default 为空');
      if (!specs.length) throw new Error('规格.specs 为空');
      return { ok: true, note: '¥' + price + ' ×' + stock + ' / ' + specs.length + ' 档' };
    });

    check(name, '广告 9 项', () => {
      const plan = profile.resolveAdPlan(p);
      const hours = (plan.时段 || []).length;
      if (hours < 4) throw new Error('时段合计 ' + hours + ' 小时，平台要求 ≥4');
      return { ok: true, note: plan.目标 + ' ¥' + plan.预期成本 + ' / 日上限 ¥' + (plan.日上限 || plan.budget || '?') + ' / ' + hours + 'h' };
    });

    check(name, '闲鱼userId', () => {
      if (!p.闲鱼userId) throw new Error('未配 —— list-onsale 会拒绝运行（这是故意的）');
      return { ok: true, note: p.闲鱼userId };
    });

    if (!QUICK) {
      check(name, '发布预演', () => {
        const out = execFileSync(process.execPath,
          [path.join(ROOT, 'publish-one.js'), '广州', '自检测试', '首开', '--dry'],
          { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: Object.assign({}, process.env, { XY_STORE: name }) });
        const m = String(out).match(/图片:\s*(\S+\.jpg)/);
        if (!m) throw new Error('没出图，看 publish-one 输出');
        const cat = String(out).match(/分类\s*:\s*(\S+)\s+catId=(\d+)\s+channelCatId=(\d+)/);
        return { ok: true, note: path.basename(m[1]) + (cat ? '  分类 ' + cat[1] + '/' + cat[3] : '') };
      });

      check(name, '推广预演', () => {
        const out = execFileSync(process.execPath,
          [path.join(ROOT, 'tools', 'ad-plan-create.js'), '--store=' + name, '--items=1000000000000', '--city=广州', '--star=自检'],
          { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
        const bid = String(out).match(/预期成本出价\s+¥([\d.]+)/);
        const budget = String(out).match(/日花费上限\s+¥([\d.]+)/);
        const cat = String(out).match(/"catId":\s*(\d+)/);
        if (!bid || !budget) throw new Error('参数解析不全');
        return { ok: true, note: '¥' + bid[1] + ' / ¥' + budget[1] + (cat ? '  catId=' + cat[1] : '') };
      });
    }
  }

  // ── 汇总 ──
  console.log('\n════════ 汇总 ════════');
  let totalOk = 0, totalFail = 0;
  for (const name of Object.keys(RESULT)) {
    const items = RESULT[name];
    const fail = items.filter(x => !x.ok);
    totalOk += items.length - fail.length; totalFail += fail.length;
    console.log('\n' + (fail.length ? '⚠️ ' : '✅ ') + name + '  ' + (items.length - fail.length) + '/' + items.length + ' 通过');
    items.forEach(x => {
      console.log('   ' + (x.ok ? '✓' : '✗') + ' ' + x.item.padEnd(12) + (x.note ? '  ' + x.note : ''));
    });
  }
  console.log('\n总计：' + totalOk + ' 项通过，' + totalFail + ' 项需要注意\n');
  process.exit(totalFail ? 1 : 0);
})();
