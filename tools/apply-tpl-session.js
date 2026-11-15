/**
 * tools/apply-tpl-session.js — 给 4 条标题模板加 {场次类型}，并缩短模板 4
 *
 * 为什么要有这个脚本：
 *   标题模板有【两个真源】，必须同时改，缺一个就会出现
 *   「发布台看得到轮次、但 API 发出去没有」或反过来的错位：
 *     ① 磁盘  ~/.xianyu-templates.json   ← publish-one.js / publish-batch.js 读这个
 *     ② 页面  localStorage['kun_tpl_好易美代拍']        ← 桌面 publish.js / 发布台读这个
 *
 * 变更：
 *   模板1/2/3：在 {活动类型} 之后插入 {场次类型}
 *   模板4    ：把写死的「首开」换成 {场次类型}，并去掉重复段（原 36~39 字，加轮次后会超 40 被硬切）
 *
 * 用法: node tools/apply-tpl-session.js          # 预演
 *       node tools/apply-tpl-session.js --apply  # 真写
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { SVC, STORE } = require('../lib/env');

const KEY = SVC.apiKey;
const APPLY = process.argv.includes('--apply');
const TPLF = path.join(os.homedir(), '.xianyu-templates.json');

const NEW = {
  1: '【稳中代拍】{城市}{明星}{活动类型}{场次类型}代拍 （可看评价）',
  2: '【必中代拍】{明星}{城市}{活动类型}{场次类型}代拍 （可看评价）',
  3: '【高命中代拍】{明星}{城市}站{活动类型}{场次类型}门票代拍帮抢',
  4: '【代拍必中】{明星}{城市}站{活动类型}{场次类型}接代拍{场次类型}代抢{明星}{活动类型}代抢',
};

// ── 与 publish-one.js 同源的 fitTitle（照抄真实文件，不手打）──
const P1 = fs.readFileSync(path.join(__dirname, '..', 'publish-one.js'), 'utf8');
const padM = P1.match(/const TITLE_PAD = (\[[^\]]*\]);/);
const TITLE_PAD = eval(padM[1]);
const TITLE_MAX = 40, TITLE_MIN = 30;
function fitTitle(t) {
  t = String(t == null ? '' : t);
  if (t.length > TITLE_MAX) return t.slice(0, TITLE_MAX);
  if (t.length < TITLE_MIN) {
    const gap = TITLE_MIN - t.length;
    let best = '';
    for (const f of TITLE_PAD) if (f.length <= gap && f.length > best.length) best = f;
    t += best;
    while (t.length < TITLE_MIN) t += '！';
  }
  return t;
}

const GROUPS = [
  { city: '广州', star: '徐良', session: '首开' },
  { city: '泉州', star: '徐良', session: '二开' },
  { city: '杭州', star: '孙燕姿', session: '三开' },
  { city: '杭州', star: '孙燕姿', session: '回流捡漏' },
];

function render(p, g) {
  return fitTitle(String(p).replace(/\{明星\}/g, g.star).replace(/\{城市\}/g, g.city)
    .replace(/\{活动类型\}/g, '演唱会').replace(/\{场次类型\}/g, g.session));
}

function post(p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: 8093, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-api-key': KEY } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(b.slice(0, 300))); } }); });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('超时')));
    req.write(payload); req.end();
  });
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(TPLF, 'utf8'));
  const tpls = raw.templates;

  console.log('模板源: ' + TPLF + '   (' + tpls.length + ' 条)');
  console.log('fitTitle 的 TITLE_PAD 取自 publish-one.js 真实文件（不手打）\n');

  let over = 0;
  for (const t of tpls) {
    const nw = NEW[t.id];
    if (!nw) { console.log('模板' + t.id + ' 无变更'); continue; }
    console.log('── 模板' + t.id + '  ' + t.name);
    console.log('   旧: ' + t.titlePattern);
    console.log('   新: ' + nw);
    for (const g of GROUPS) {
      const s = render(nw, g);
      if (s.length > 40 || s.length < 30) over++;
      console.log('      ' + g.city + g.star + '·' + g.session + ' (' + String(s.length).padStart(2) + '字): ' + s);
    }
    t.titlePattern = nw;
  }
  console.log('\n字数越界条数: ' + over + (over === 0 ? '  ✅ 全部在 30~40' : '  ❌ 有越界'));

  if (!APPLY) { console.log('\n[预演] 未写任何东西。加 --apply 真写（磁盘 + localStorage 两处）。'); return; }

  // ① 写磁盘
  fs.writeFileSync(TPLF, JSON.stringify(raw, null, 2), 'utf8');
  console.log('\n✅ 磁盘已写: ' + TPLF);

  // ② 写 localStorage（走官方接口，同时会 Native Host 落盘）
  const code = `(function(){try{
    window.kunPublish.setStore(${JSON.stringify(STORE)});
    var tpls = ${JSON.stringify(tpls)};
    window.kunPublish.saveCustomTemplates(tpls);
    window.kunPublish.reloadStoreTemplates();
    var back = window.kunPublish.CONCERT_TEMPLATES || [];
    return JSON.stringify({ n: back.length, patterns: back.map(function(x){return x.id + ': ' + x.titlePattern;}) });
  }catch(e){return JSON.stringify({error:e.message});}})()`;
  const r = await post('/api/agent/eval-on-store', { store: STORE, code });
  let d = r.result;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
  if (d && d.error) { console.log('❌ localStorage 写入失败: ' + d.error); process.exit(1); }
  console.log('✅ localStorage 已写并回读 (' + d.n + ' 条):');
  (d.patterns || []).forEach((s) => console.log('    ' + s));
})().catch((e) => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
