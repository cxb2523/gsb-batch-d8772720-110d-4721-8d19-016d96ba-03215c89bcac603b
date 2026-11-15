/**
 * tools/browser-direct.js —— 让自动化浏览器【不走系统代理】（改的是另一个仓库里的 1 行）
 *
 * 为什么需要它（2026-10-12 实测，详见 index/06-运维与故障.md）：
 *   闲鱼弹滑块 / 报「您的IP位址与网路机器人相同」，根因是**浏览器出口是机房 IP**：
 *     · 走系统代理（FlClash 127.0.0.1:7890）→ 50.7.253.42（新加坡 FDC，机房）
 *     · 绕过系统代理直连            → 124.156.176.51（腾讯云香港，机房）
 *     · IPv6                        → 2409:8a55:...（中国移动，干净）
 *   而 Chromium 有个**反直觉的坑**（本脚本用临时浏览器实测过 A/B）：
 *     --no-proxy-server        ❌ 完全无效，出口还是 50.7.253.42
 *     --proxy-server=direct:// ✅ 有效，出口落到中国移动 IPv6
 *
 * 于是要在 playwright-service/agent.js 的 chromium.launch({args}) 里加这一行。
 * ⚠️ 那是**另一个 git 仓库**（gitlab.com/hym-company/xianyu-playwright-service），
 *    而且是两个 agent 会话**共用**的浏览器服务 —— 所以本脚本：
 *      · 默认只读，什么都不改；
 *      · 改之前先备份，改完回读校验；
 *      · 找不到锚点就拒绝改（宁可不动，也不要把别人文件写坏）；
 *      · --off 能一键退回，备份也留着。
 *
 * 用法:
 *   node tools/browser-direct.js --status    # 看现在有没有这个参数（只读）
 *   node tools/browser-direct.js --probe     # 实测：临时起两个浏览器，比出口 IP（只读，约 30 秒）
 *   node tools/browser-direct.js --on        # 加上 --proxy-server=direct://（备份 + 回读）
 *   node tools/browser-direct.js --off       # 去掉它
 *
 * 生效时机：浏览器空闲 20 分钟会整体回收；或手动关掉那个可见的 Chrome 窗口，
 *           下一次巡检/发布重新拉起时就用新参数了。不用重启 8093 服务。
 */
const fs = require('fs');
const path = require('path');
const { PATHS, ROOT } = require('../lib/env');

const FLAG = '--proxy-server=direct://';
const SVC = PATHS.playwrightService;
const AGENT = SVC ? path.join(SVC, 'agent.js') : '';
const ANCHOR = "'--disable-blink-features=AutomationControlled',";

const has = (s) => s.indexOf(FLAG) >= 0;
const read = (f) => fs.readFileSync(f, 'utf8');

function banner() {
  console.log('playwright-service = ' + (SVC || '(未找到)'));
  console.log('agent.js           = ' + (AGENT || '(未找到)'));
}

(async () => {
  const mode = ['--status', '--probe', '--on', '--off'].find((f) => process.argv.includes(f)) || '--status';

  if (!AGENT || !fs.existsSync(AGENT)) {
    console.log('❌ 找不到 agent.js。先确认 playwright-service 克隆在哪（lib/env.js 的 PATHS.playwrightService，');
    console.log('   或用环境变量 XY_PLAYWRIGHTSERVICE 指定）。');
    process.exit(2);
  }

  banner();
  const src = read(AGENT);
  const on = has(src);
  console.log('当前状态           = ' + (on ? '✅ 已加 ' + FLAG : '⬜ 没有加（走系统代理）'));
  console.log('');

  if (mode === '--probe') {
    // 只读实测：起两个临时 headless 浏览器，比出口 IP
    const { chromium } = require(path.join(SVC, 'node_modules', 'playwright'));
    const ping = async (p, u) => { try { await p.goto(u, { timeout: 25000, waitUntil: 'domcontentloaded' }); return (await p.textContent('body') || '').trim(); } catch (e) { return '失败'; } };
    for (const [label, args] of [['A) 走系统代理（现状）', []], ['B) ' + FLAG, [FLAG]]]) {
      let b;
      try { b = await chromium.launch({ headless: true, args }); } catch (e) { console.log('  ' + label + ' 起不来: ' + e.message); continue; }
      const p = await b.newPage();
      const v4 = await ping(p, 'https://api.ipify.org');
      const v6 = await ping(p, 'https://api64.ipify.org');
      await b.close();
      console.log('  ' + label);
      console.log('      v4=' + v4 + '   v6=' + v6 + (/^2409:/.test(v6) ? '   ← 中国移动 IPv6 ✅' : (/^(50\.7|124\.156)/.test(v4 + v6) ? '   ← 机房 IP ❌' : '')));
    }
    console.log('\n判据：v6 是 2409: 开头 = 落到干净线路；还是 50.7/124.156 = 仍在机房。');
    return;
  }

  if (mode === '--status') {
    const at = src.split('\n').findIndex((l) => l.indexOf(ANCHOR) >= 0);
    if (at >= 0) { console.log('args 那一段现在长这样：'); src.split('\n').slice(at - 3, at + 4).forEach((l, i) => console.log('  L' + (at - 2 + i) + ': ' + l)); }
    console.log('\n要看它到底管不管用：node tools/browser-direct.js --probe');
    return;
  }

  if (mode === '--on') {
    if (on) { console.log('已经是加上的状态，幂等跳过。'); return; }
    if (src.indexOf(ANCHOR) < 0) {
      console.log('❌ 在 agent.js 里找不到锚点：' + ANCHOR);
      console.log('   说明那个文件的启动参数被改过。**拒绝修改**（宁可不动，也不要把别人的文件写坏）。');
      console.log('   请人工确认后手工加。');
      process.exit(1);
    }
    const bak = AGENT + '.bak-browser-direct-' + Date.now();
    fs.copyFileSync(AGENT, bak);
    const next = src.replace(ANCHOR, ANCHOR + '\n        ' + "'" + FLAG + "',");
    fs.writeFileSync(AGENT, next, 'utf8');
    const back = read(AGENT);
    console.log('备份      = ' + bak);
    console.log('回读校验  = ' + (has(back) ? '✅ 参数已写入' : '❌ 没写进去'));
    if (!has(back)) { fs.copyFileSync(bak, AGENT); console.log('已自动回滚。'); process.exit(1); }
    console.log('\n生效时机：关掉那个可见的 Chrome 窗口（或等它空闲 20 分钟自己回收），下一次重新拉起就用新参数。');
    console.log('验证      ：node tools/browser-direct.js --probe');
    return;
  }

  if (mode === '--off') {
    if (!on) { console.log('本来就没有这个参数，无需处理。'); return; }
    const bak = AGENT + '.bak-browser-direct-off-' + Date.now();
    fs.copyFileSync(AGENT, bak);
    const next = src.replace(new RegExp('\\s*' + "'" + FLAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "',"), '');
    fs.writeFileSync(AGENT, next, 'utf8');
    const back = read(AGENT);
    console.log('备份      = ' + bak);
    console.log('回读校验  = ' + (has(back) ? '❌ 还在，没摘掉' : '✅ 已摘掉'));
    if (has(back)) { fs.copyFileSync(bak, AGENT); console.log('已自动回滚。'); process.exit(1); }
    return;
  }
})().catch((e) => { console.error('FAIL ' + (e && e.stack || e)); process.exit(1); });
