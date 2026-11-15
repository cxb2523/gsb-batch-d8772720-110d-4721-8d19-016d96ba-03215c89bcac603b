#!/usr/bin/env node
/**
 * tools/feishu-alert.js —— 飞书群机器人告警（替代已失效的企微 850003 通道）
 *
 * 背景（2026-11-10）：企微机器人返回 `errcode 850003 authorization expired`，告警只能落桌面文件；
 * 飞书通道测试通过（`code:0 success`）。本工具作为**首选通道**，企微降为备用。
 *
 * 纪律：
 *   - 凭据只从 `data/feishu-webhook.txt` 读一行 URL；**不打印全文、不写进任何 md、不 commit**。
 *   - 消息 `text` **必须含「告警」二字**（机器人选了关键字校验，不带会被拒）——本工具会强制补前缀。
 *
 * 用法：
 *   node tools/feishu-alert.js --text "余额 0 元，擦亮中断"
 *   node tools/feishu-alert.js --file ad-window-alert.md
 *   node tools/feishu-alert.js --text "..." --dry        # 只校验不发送
 *
 * 退出码：0 已送达 / 2 凭据缺失 / 3 发送失败（已落桌面兜底）/ 4 参数错
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const HOOK_FILE = path.join(ROOT, 'data', 'feishu-webhook.txt');
const DESKTOP_MARK = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Desktop', '!XIANYU-ALERT-ACTION-NEEDED.txt');
const LOCAL_MARK = path.join(ROOT, '!飞书告警失败.txt');
const KEYWORD = '告警';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => {
  const eq = argv.find((x) => x.startsWith('--' + k + '='));
  if (eq) return eq.slice(k.length + 3);
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

function buildText() {
  let t = val('text');
  const f = val('file');
  if (!t && f) {
    try { t = fs.readFileSync(f, 'utf8'); } catch (e) { console.error('读不到 --file: ' + f); process.exit(4); }
  }
  if (!t) { console.error('用法: --text "<内容>" 或 --file <路径>'); process.exit(4); }
  t = String(t).trim();
  if (t.length > 1800) t = t.slice(0, 1800) + '\n…（截断）';
  // 关键字校验：机器人按「告警」匹配，缺了会被拒 → 强制补前缀
  if (!t.includes(KEYWORD)) t = '【' + KEYWORD + '】' + t;
  return t;
}

function post(url, payload) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'webhook URL 不合法' }); }
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (e) {}
        const codeOk = j && (j.code === 0 || j.StatusCode === 0 || j.status_code === 0);
        resolve({ ok: codeOk && res.statusCode === 200, status: res.statusCode, raw: b.slice(0, 300) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

function fallback(text, reason) {
  const stamp = new Date().toLocaleString('zh-CN');
  const block = '\n===== ' + stamp + ' 飞书告警未送达 (' + reason + ') =====\n' + text + '\n';
  for (const p of [LOCAL_MARK, DESKTOP_MARK]) {
    try { fs.appendFileSync(p, block, 'utf8'); } catch (e) { /* 桌面不可写也不能崩 */ }
  }
}

(async () => {
  const text = buildText();
  if (!fs.existsSync(HOOK_FILE)) {
    console.error('凭据缺失: data/feishu-webhook.txt 不存在');
    fallback(text, 'no-credential');
    process.exit(2);
  }
  const hook = fs.readFileSync(HOOK_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!/^https:\/\//.test(hook)) {
    console.error('凭据异常: webhook 不是 https URL');
    fallback(text, 'bad-credential');
    process.exit(2);
  }
  if (has('--dry')) {
    console.log('DRY: 将发送 ' + text.length + ' 字符，含关键字: ' + text.includes(KEYWORD) + '，webhook 长度 ' + hook.length);
    console.log('预览: ' + text.slice(0, 120).replace(/\n/g, ' / '));
    process.exit(0);
  }
  const r = await post(hook, { msg_type: 'text', content: { text } });
  if (r.ok) { console.log('✅ 飞书告警已送达（' + text.length + ' 字符）'); process.exit(0); }
  console.error('❌ 飞书发送失败: ' + (r.error || ('HTTP ' + r.status + ' ' + (r.raw || ''))));
  fallback(text, r.error || ('HTTP ' + r.status));
  console.error('已落桌面兜底: ' + DESKTOP_MARK);
  process.exit(3);
})();
