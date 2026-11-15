#!/usr/bin/env node
/**
 * tools/store-onboard.js —— 登录之后的一键收尾（把"人做不了"的部分压到只剩扫码）
 *
 * 为什么需要它（2026-11-12）：
 *   新店流程里，能自动的都自动了，只剩「扫码登录」必须人做。
 *   但扫完码之后还有三件琐事：补 闲鱼userId、发第一条、开推广 ——
 *   以前要一条条敲命令，现在一条命令跑完。
 *
 * 它能做什么（按顺序，能跳过的跳过）：
 *   ① 检查目标店铺【真的】登录了没有（不看 store-ready 的"就绪"，那个判据会骗人）
 *   ② 尽力自动抓 闲鱼userId 写进档案（抓不到就告诉你去哪抄）
 *   ③ --publish=城市:主体[:场次]  发第一条链接
 *   ④ --promote                给刚发的链接开推广
 *
 * 用法:
 *   node tools/store-onboard.js --store="超能水手代拍"
 *   node tools/store-onboard.js --store="超能水手代拍" --publish=广州:王嘉尔
 *   node tools/store-onboard.js --store="超能水手代拍" --publish=广州:王嘉尔 --promote
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

const STORE = A.store;
if (!STORE) { console.log('用法: node tools/store-onboard.js --store="店铺名" [--publish=城市:主体[:场次]] [--promote]'); process.exit(2); }

const profPath = path.join(ROOT, 'stores', STORE + '.json');
if (!fs.existsSync(profPath)) { console.log('❌ 没有档案：stores/' + STORE + '.json\n   先跑 node tools/store-wizard.js'); process.exit(2); }

const agent = require('../lib/agent');

function run(script, args, env) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 900000, env: Object.assign({}, process.env, env || {}) }) };
  } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}

(async () => {
  console.log('\n════ 登录后一键收尾：' + STORE + ' ════\n');

  // ① 真的登录了吗
  let active = '';
  try {
    const s = await agent.status();
    active = (s.data || s).active && (s.data || s).active.name || '';
  } catch (e) { console.log('❌ 读不到 8093 状态：' + e.message); process.exit(1); }
  console.log('① 当前活跃店铺：' + active);
  if (active !== STORE) {
    console.log('\n⛔ 还没切到「' + STORE + '」。先扫码：');
    console.log('   node tools/store-login.js "' + STORE + '"');
    console.log('\n   （⚠️ store-ready 说"就绪"不代表登录了，那个判据不查 goofish 页）');
    process.exit(2);
  }
  console.log('   ✅ 已登录「' + STORE + '」');

  // ② 抓 闲鱼userId
  const prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
  if (prof.闲鱼userId) {
    console.log('\n② 闲鱼userId：已有 ' + prof.闲鱼userId);
  } else {
    console.log('\n② 闲鱼userId：档案里没有，尝试自动抓…');
    let uid = '';
    try {
      // 个人页 URL 里常带 userId；先跳过去看看
      await agent.evalOnStore('location.href="https://www.goofish.com/personal"; "go"', { timeout: 60000 });
      await agent.sleep(6000);
      const href = String(await agent.evalOnStore('location.href', { timeout: 30000 }) || '');
      const m = href.match(/userId=(\d{8,12})/);
      if (m) uid = m[1];
      if (!uid) {
        const h = String(await agent.evalOnStore('document.documentElement.innerHTML', { timeout: 60000 }) || '');
        const m2 = h.match(/"userId"\s*:\s*"?(\d{8,12})"?/);
        if (m2) uid = m2[1];
      }
      if (uid) console.log('   抓到：' + uid + '（来源：' + (href.indexOf('userId=') >= 0 ? '个人页 URL' : '页面数据') + '）');
    } catch (e) { console.log('   自动抓失败：' + e.message); }

    if (uid) {
      prof.闲鱼userId = uid;
      prof._闲鱼userId说明 = 'store-onboard 于 ' + new Date().toISOString().slice(0, 10) + ' 自动抓取';
      fs.writeFileSync(profPath, JSON.stringify(prof, null, 2), 'utf8');
      console.log('   ✅ 已写进档案');
    } else {
      console.log('   ⚠️ 抓不到。手动补：在 stores/' + STORE + '.json 里加一行');
      console.log('        "闲鱼userId": "<那串数字>",');
      console.log('      哪抄：闲鱼 App → 我的 → 头像点开 → 个人主页链接里 ?userId= 后面那串；');
      console.log('      或者临时跑 node tools/list-onsale.js --user-id=<数字> 试出来的那个。');
      console.log('      （不补的话 list-onsale 会拒绝运行 —— 这是故意的，免得查错店）');
    }
  }

  // ③ 发第一条
  let newItemId = '';
  if (A.publish) {
    const [city, star, session] = String(A.publish).split(':');
    if (!city || !star) { console.log('\n❌ --publish 格式应为 城市:主体[:场次]'); process.exit(2); }
    console.log('\n③ 发一条链接：' + city + ' · ' + star + ' · ' + (session || '首开'));
    const r = run('tools/first-publish.js', [city, star, session || '首开', '--yes'], { XY_STORE: STORE });
    console.log(r.out.split('\n').slice(-18).join('\n'));
    const m = String(r.out).match(/itemId[=:]\s*"?(\d{10,})"?/);
    if (m) newItemId = m[1];
    if (r.ok && newItemId) console.log('   ✅ 已发布 itemId=' + newItemId);
    else console.log('   ⚠️ 发布没成功或没拿到 itemId，看上面输出。发布成功 ≠ 在售，-9 是审核中，先等。');
  } else {
    console.log('\n③ 跳过发链接（要发加 --publish=城市:主体）');
  }

  // ④ 开推广
  if (A.promote) {
    if (!newItemId) { console.log('\n④ 跳过开推广（没有刚发的 itemId；也可以手动：node tools/ad-plan-create.js --store="' + STORE + '" --items=<id> --city=<城> --star=<人> --apply）'); }
    else {
      const [city, star] = String(A.publish).split(':');
      console.log('\n④ 开推广：' + newItemId);
      const r1 = run('tools/ad-plan-create.js', ['--store=' + STORE, '--items=' + newItemId, '--city=' + city, '--star=' + star, '--apply']);
      const pm = String(r1.out).match(/\bid=(\d+)\s/);
      console.log(r1.out.split('\n').slice(-10).join('\n'));
      if (!pm) { console.log('   ❌ 没建成，看上面输出'); }
      else {
        const r2 = run('tools/ad-power.js', ['on', pm[1]]);
        const okPart = String(r2.out).split('动作后校验')[1] || '';
        if (/✅/.test(okPart)) console.log('   ✅ 推广已开启，计划 id=' + pm[1]);
        else {
          console.log('   ⚠️ 计划建好了 id=' + pm[1] + '，但拨不上：商品刚发/刚改，广告侧还没同步。');
          console.log('      → 等 30-60 分钟再跑 node tools/ad-power.js on ' + pm[1]);
        }
      }
    }
  }

  console.log('\n════ 收尾完成 ════');
  if (!A.publish) console.log('发链接：node tools/store-onboard.js --store="' + STORE + '" --publish=广州:某明星');
  console.log('');
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
