/**
 * tools/damai-events.js —— 搜大麦场次，并把该场次的海报图 URL 也取出来
 *
 * 为什么这么做（2026-10-13）：
 *   老板要上架 北京/上海 宋雨琦音乐会、北京/深圳 王一珩音乐会，让我们**去大麦拿海报**。
 *   但大麦的搜索页是 JS 渲染的空壳（抓 HTML 只有 12KB、零结果），搜索接口又是**签名接口**。
 *   逆了一圈（页面 bundle 里挖 appKey、猜 mtop 参数）都没成。
 *   后来在 playwright-service 里发现 **`collectDamai()` 早就解决了**：
 *     自己开一个无头 Chromium（iPhone UA / 390×844）访问 m.damai.cn 的搜索页，
 *     然后**截获页面自己发出的 `mtop.damai.wireless.search.search` 响应**——
 *     签名由页面自己做，我们只管读。**这就是"用真浏览器渲染、不猜接口"的标准解法。**
 *   本工具照它的手法做，区别是：**把海报图 URL 也一起取出来**（原来那个只取场次信息）。
 *
 * 用法:
 *   node tools/damai-events.js 宋雨琦 王一珩        # 搜索并列出候选场次（含海报 URL）
 *   node tools/damai-events.js 宋雨琦 --raw        # 额外 dump 一条完整 item（找字段用）
 *   node tools/damai-events.js 宋雨琦 --save=out   # 把海报图下载到 out/<id>.jpg
 *   node tools/damai-events.js 谢霆锋 --onsale     # 【2026-11-09 新增】只加打印：每场的 onSaleTime 原样输出
 *   node tools/damai-events.js 谢霆锋 --onsale --id=1085797685281   # 按 id 过滤输出（只影响打印，不影响抓取）
 *
 * ⚠️ 它**开的是一台独立无头浏览器**，不碰 8093 那台店铺浏览器（老板的闲鱼会话不受影响）。
 */
const fs = require('fs');
const path = require('path');
const { svcRequire } = require('../lib/env');

const argv = process.argv.slice(2);
const RAW = argv.includes('--raw');
// 【2026-11-09 加】--onsale：只增加打印，不动抓取/请求/筛选
const ONSALE = argv.includes('--onsale');
// 【2026-11-09 加】--id=a,b：只过滤"要打印哪些行"，抓取照旧
const IDS = (argv.find((a) => a.startsWith('--id=')) || '').slice(5).split(',').map((s) => s.trim()).filter(Boolean);
const saveArg = (argv.find((a) => a.startsWith('--save=')) || '').slice(7);
const KWS = argv.filter((a) => !a.startsWith('--'));
if (!KWS.length) { console.log('用法: node tools/damai-events.js <关键词...> [--raw] [--save=<目录>] [--onsale] [--id=<id,id>]'); process.exit(2); }

// 海报常见字段名（大麦 projectInfo 里那几个候选，按优先级）
const PIC_KEYS = ['verticalPic', 'pic', 'poster', 'posterUrl', 'coverUrl', 'itemPic', 'imgUrl', 'vPic', 'squarePic'];

/** 按【魔数】判断真实图片格式 —— 别信 URL 后缀（阿里 CDN 会协商成 WebP） */
function sniff(b) {
  if (b.length > 12 && b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (b.length > 4 && b.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return 'bin';
}

let sharp = null;
try { sharp = svcRequire('node_modules/sharp'); } catch (e) { /* 没有也能跑，只是不转格式 */ }

(async () => {
  let chromium;
  try { ({ chromium } = svcRequire('node_modules/playwright')); }
  catch (e) { console.log('❌ 加载 playwright 失败：' + e.message); process.exit(1); }

  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }, isMobile: true,
  });
  const p = await ctx.newPage();

  const found = new Map();
  for (const kw of KWS) {
    let items = [];
    const h = async (r) => {
      if (!/mtop\.damai\.wireless\.search\.search/.test(r.url())) return;
      try { const j = JSON.parse(await r.text()); if (j.data && j.data.projectInfo) items = j.data.projectInfo; } catch (e) { /* 不是 JSON 就跳过 */ }
    };
    p.on('response', h);
    try {
      await p.goto('https://m.damai.cn/damai/search/index.html?keyword=' + encodeURIComponent(kw),
        { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(2500);
    } catch (e) { /* 超时也继续看有没有截到 */ }
    p.off('response', h);
    console.log('  「' + kw + '」截到场次 ' + items.length + ' 条');
    items.forEach((it) => { if (it && it.id && !found.has(String(it.id))) found.set(String(it.id), it); });
  }
  await b.close();

  const list = Array.from(found.values());
  if (!list.length) { console.log('\n❌ 一条都没截到。可能大麦改了接口名，或本机到 m.damai.cn 不通。'); process.exit(1); }

  if (RAW) {
    // 只挑【图片类】字段打印 —— 整条 dump 会被 4000 字截断，而图片字段往往在后面。
    console.log('\n──── 一条 item 里的【图片类】字段（找海报用）────');
    const it0 = list[0];
    const imgKeys = Object.keys(it0).filter((k) => /pic|img|poster|cover|photo|vpic|banner/i.test(k));
    if (!imgKeys.length) console.log('   （没有名字像图片的键。全部键：' + Object.keys(it0).join(', ') + '）');
    imgKeys.forEach((k) => {
      const v = it0[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      console.log('   ' + k + ' = ' + String(s).slice(0, 160));
    });
    console.log('\n──── 全部顶层键 ────');
    console.log('   ' + Object.keys(it0).join(', '));
  }

  console.log('\n════ 候选场次 ════');
  const saveDir = saveArg ? path.resolve(saveArg) : '';
  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

  for (const it of list) {
    if (IDS.length && !IDS.includes(String(it.id))) continue;
    const pic = PIC_KEYS.map((k) => it[k]).find((v) => typeof v === 'string' && v);
    // --full：不截断（查场次全名/时间/场馆时用；默认仍截断以保持一屏可读）
    const W = argv.includes('--full') ? { t: 40, v: 40, n: 200 } : { t: 12, v: 14, n: 40 };
    console.log('  ' + String(it.id).padEnd(14) +
      String(it.cityName || '').padEnd(5) +
      String(it.showTime || '').slice(0, W.t).padEnd(W.t + 2) +
      String(it.venueName || '').slice(0, W.v).padEnd(W.v + 2) +
      String(it.name || '').slice(0, W.n));
    // 【2026-11-09 加】--onsale：原样打印 onSaleTime，不做任何格式换算/推测
    if (ONSALE) {
      if (!Object.prototype.hasOwnProperty.call(it, 'onSaleTime')) {
        console.log('       开票: <该 item 没有 onSaleTime 键>');
      } else {
        const v = it.onSaleTime;
        const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
        console.log('       开票: ' + (typeof v === 'string' ? v : JSON.stringify(v)) + '   [type=' + t + ']');
      }
      // 同族字段一起列出来，方便判断是"字段不存在"还是"字段名变了"
      const rel = Object.keys(it).filter((k) => /sale|time|Time|Sale/i.test(k) && k !== 'onSaleTime');
      if (rel.length) console.log('       同族键: ' + rel.join(', '));
    }
    if (pic) {
      console.log('       海报: ' + pic);
      if (saveDir) {
        try {
          const r = await fetch(pic, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.damai.cn/' } });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          let buf = Buffer.from(await r.arrayBuffer());
          // 【2026-10-13 修·文件名骗人】阿里 CDN 会按请求头协商格式：
          //   我按 URL 后缀存成 .jpg，实测拿到的是 **WebP**（RIFF....WEBP，1020×1360）。
          //   文件名与内容不符，后面链路按扩展名处理就会踩坑（和"256px 头像"同一类静默降级）。
          //   现在：① 按魔数判断真实格式再定扩展名；② 有 sharp 就顺手转成 JPEG（管道里最通用）。
          let ext = sniff(buf);
          if (ext === 'webp' && sharp) { buf = await sharp(buf).jpeg({ quality: 92 }).toBuffer(); ext = 'jpg'; }
          const f = path.join(saveDir, it.id + '.' + ext);
          fs.writeFileSync(f, buf);
          console.log('       ✅ 已存 ' + f + '  ' + Math.round(buf.length / 1024) + 'KB  (' + ext + ')');
        } catch (e) { console.log('       ❌ 下载失败: ' + e.message); }
      }
    } else {
      console.log('       ⚠️ 这条没有常见海报字段（用 --raw 看它到底有哪些图字段）');
    }
  }
  console.log('\n合计 ' + list.length + ' 条候选。');
})();
