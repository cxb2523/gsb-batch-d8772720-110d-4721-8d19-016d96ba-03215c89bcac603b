#!/usr/bin/env node
/**
 * tools/shot-one-pager.js —— 把「学员五步上手.html」截成整页 PNG（贴群用）
 *
 * 为什么有它（2026-11-13 第 133 轮）：
 *   交付清单里写着「截图 publish-out/学员五步上手-整页.png」，但那是【手工截的】。
 *   实测：html 改过之后没人重截，图比 html 老 17.5 小时 —— 贴到群里的图和
 *   学员实际看到的说明不一致（图里还是旧的步骤）。
 *   这个脚本把截图自动化，改完 html 跑一次就行。
 *
 * 用法:
 *   node tools/shot-one-pager.js
 *   node tools/shot-one-pager.js --width=480     # 手机宽度（默认 480）
 *
 * 输出: publish-out/学员五步上手-整页.png
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '学员五步上手.html');
const OUTDIR = path.join(ROOT, 'publish-out');
const OUT = path.join(OUTDIR, '学员五步上手-整页.png');

const widthArg = (process.argv.find((a) => a.startsWith('--width=')) || '').split('=')[1];
const WIDTH = Number(widthArg) || 480;

(async () => {
  if (!fs.existsSync(SRC)) { console.log('❌ 找不到 ' + SRC); process.exit(1); }
  fs.mkdirSync(OUTDIR, { recursive: true });

  let chromium;
  try {
    // 优先用服务端那套 playwright（已装好，浏览器也下过了）
    ({ chromium } = require(path.join(
      process.env.USERPROFILE || 'C:/Users/43462',
      '.kun', 'default_workspace', 'playwright-service', 'node_modules', 'playwright')));
  } catch (e) {
    try {
      ({ chromium } = require('playwright'));
    } catch (e2) {
      console.log('❌ 找不到 playwright。在 playwright-service 目录里 npm install 一下。');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file:///' + SRC.replace(/\\/g, '/'));
  await page.waitForTimeout(400);   // 等字体
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log('✅ ' + OUT);
  console.log('   ' + kb + ' KB   宽 ' + WIDTH + '  整页');
})();
