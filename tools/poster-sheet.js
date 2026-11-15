/**
 * tools/poster-sheet.js — 把「好易美代拍」出图工坊里所有版式各出一张样图，拼成一张对比图
 *
 * 用途：老板要「都分别发我看看，我来选择哪款保留」。
 * 做法：逐个 templateId 调 /api/poster/make（同一城市/明星/底图来源，保证唯一变量是版式），
 *       再用 sharp 拼成 3x3 对比图，每格下面标 序号 + templateId（纯 ASCII，避免中文字体缺失）。
 *
 * 用法: node tools/poster-sheet.js            # 全部 9 款
 *       node tools/poster-sheet.js --only=xuliang-v1,tpl_redtext
 */
const http = require('http');
const { SVC: SVC_ENV, PATHS, svcRequire } = require('../lib/env');
const fs = require('fs');
const path = require('path');

const SVC = PATHS.playwrightService;
const sharp = svcRequire('node_modules/sharp');
const KEY = SVC_ENV.apiKey;

const OUT_DIR = path.join(__dirname, '..', 'out');
const RAW_DIR = path.join(OUT_DIR, 'posters');

// 顺序 = 对比图里从左到右、从上到下
const TPLS = [
  { id: '__shoukai',    label: '1  __shoukai' },
  { id: 'xuliang-v1',   label: '2  xuliang-v1' },
  { id: 'shoukai-v1',   label: '3  shoukai-v1' },
  { id: 'tpl_mt7fdi08', label: '4  tpl_mt7fdi08' },
  { id: 'tpl_mt8rix1n', label: '5  tpl_mt8rix1n' },
  { id: 'tpl_hb_banner',label: '6  tpl_hb_banner' },
  { id: 'tpl_redtext',  label: '7  tpl_redtext' },
  { id: 'tpl_suibian2', label: '8  tpl_suibian2' },
  { id: 'tpl_suibian3', label: '9  tpl_suibian3' },
];

const CITY = '广州', STAR = '孙燕姿', SOURCE = 'damai_official';

function make(templateId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ city: CITY, star: STAR, source: SOURCE, templateId, ratio: '3:4' });
    const req = http.request({
      host: '127.0.0.1', port: 8093, path: '/api/poster/make', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': KEY },
      timeout: 240000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.ok && j.imageB64) resolve({ ok: true, buf: Buffer.from(j.imageB64, 'base64'), origin: j.baseOrigin });
          else resolve({ ok: false, err: j.error || JSON.stringify(j).slice(0, 200) });
        } catch (e) { resolve({ ok: false, err: b.slice(0, 200) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.write(body); req.end();
  });
}

(async () => {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').replace('--only=', '');
  const list = only ? TPLS.filter((t) => only.split(',').indexOf(t.id) >= 0) : TPLS;

  const results = [];
  for (const t of list) {
    const t0 = Date.now();
    const r = await make(t.id);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.ok) {
      const f = path.join(RAW_DIR, t.id.replace(/[^\w.-]/g, '_') + '.jpg');
      fs.writeFileSync(f, r.buf);
      console.log(`✅ ${t.id.padEnd(16)} ${secs}s  ${(r.buf.length / 1024).toFixed(0)}KB  底图来源=${r.origin}`);
      results.push({ ...t, ok: true, buf: r.buf, origin: r.origin });
    } else {
      console.log(`❌ ${t.id.padEnd(16)} ${secs}s  ${r.err}`);
      results.push({ ...t, ok: false, err: r.err });
    }
  }

  const okList = results.filter((r) => r.ok);
  if (!okList.length) { console.log('\n没有一张成功，无法拼图'); return; }

  // ---- 拼 3x3 对比图 ----
  const CW = 320, CH = 427;          // 每格海报尺寸（3:4）
  const LABEL_H = 34, PAD = 12;
  const COLS = 3;
  const ROWS = Math.ceil(results.length / COLS);
  const W = COLS * (CW + PAD) + PAD;
  const H = ROWS * (CH + LABEL_H + PAD) + PAD;

  const composites = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = PAD + col * (CW + PAD);
    const y = PAD + row * (CH + LABEL_H + PAD);
    if (r.ok) {
      const small = await sharp(r.buf).resize({ width: CW, height: CH, fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
      composites.push({ input: small, top: y, left: x });
    } else {
      const ph = await sharp({ create: { width: CW, height: CH, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer();
      composites.push({ input: ph, top: y, left: x });
    }
  }

  // 标签层（放在海报下方）
  let labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = PAD + col * (CW + PAD);
    const y = PAD + row * (CH + LABEL_H + PAD) + CH + 22;
    const txt = (r.ok ? r.label : r.label + '  (FAILED)');
    labelSvg += `<text x="${x + 4}" y="${y}" font-family="monospace" font-size="17" fill="#111">${txt}</text>`;
  }
  labelSvg += '</svg>';

  const sheet = path.join(OUT_DIR, 'poster-sheet.jpg');
  await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite([...composites, { input: Buffer.from(labelSvg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(sheet);

  console.log('\n对比图: ' + sheet + '   ' + W + 'x' + H);
  console.log('单张在: ' + RAW_DIR);
  console.log('\n===== 顺序（从左到右、从上到下）=====');
  results.forEach((r, i) => console.log(`  ${i + 1}. ${r.id}${r.ok ? '' : '  ← 生成失败'}`));
})();
