/**
 * tools/fetch-sub-images.js — 只读+下载：把某个已有链接的【主图 + 副图】全量拉下来
 *
 * 为什么需要它（2026-10-07 hope 店）：
 *   店里的老链接是「1 主图 + 8 副图」，而我们的发布链路原来只发 1 张主图。
 *   副图长什么样、是不是全店通用，看代码看不出来 —— 直接从店里拉下来看最快。
 *
 * 数据来源：**卖家编辑页** `/publish?itemId=<id>`。
 *   不能用买家页：买家页有「猜你喜欢」推荐位，别人家的商品图会混进来
 *   （实测买家页数出 50~65 张，全是别人的）。
 *   编辑页是卖家表单，只有这条商品自己的图。
 *
 * 只读，唯一副作用是把图片下载到本地。
 *
 * 用法:
 *   node tools/fetch-sub-images.js "好易美票务Hope" <itemId> [<itemId>...] [--out=publish-assets/hope-副图]
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { post } = require('../lib/http');
const { ROOT, svcRequire } = require('../lib/env');

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const OUT = path.resolve(ROOT, opt('out', 'publish-assets/hope-副图'));
const rest = argv.filter((a) => a && !a.startsWith('--'));
const STORE = rest[0];
const IDS = rest.slice(1).filter((a) => /^\d+$/.test(a));
if (!STORE || !IDS.length) { console.log('用法: node tools/fetch-sub-images.js "<店铺名>" <itemId> [<itemId>...] [--out=目录]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读编辑页上所有「真·商品图」的完整 URL，按 DOM 顺序
const READ = `(async function(){
  for (var i=0;i<30;i++){ if ((document.body.innerText||'').length > 600) break; await new Promise(function(r){setTimeout(r,900);}); }
  await new Promise(function(r){setTimeout(r,2500);});
  var seen = {}, out = [];
  [].slice.call(document.querySelectorAll('img')).forEach(function(e){
    var s = String(e.currentSrc || e.src || '');
    // 闲鱼图床的商品图 URL 一定带 -0-fleamarket 或 -0-xy_item；UI 图标不带
    if (!/(-0-fleamarket|-0-xy_item)/.test(s)) return;
    // ⚠️ 页面上的 <img> 是缩略图（URL 尾部带 _170x10000Q90.jpg_.webp 这种缩放后缀）——
    //    不去掉后缀，拉下来就是 170px 的小图（2026-10-07 实测，9 张全是 7~24 KB）。
    // ⚠️⚠️ 这是**模板字符串**：正则里的 \d 必须写成 \\d，否则 \d 会被当成"未识别转义"吃成字母 d，
    //    正则变成 /_d+xd+Qd+.*$/ 永远不匹配（第一版就是这么失效的，图还是 170px 缩略图）。
    var full = s.split('?')[0].replace(/_\\d+x\\d+Q\\d+.*$/, '');
    var m = full.match(/O1CN[^_.]+/); if (!m || seen[m[0]]) return;
    seen[m[0]] = 1; out.push(full);
  });
  return JSON.stringify({ href: location.href, title: document.title, imgs: out });
})()`;

function download(url, file) {
  return new Promise((resolve) => {
    const u = url.replace(/^http:/, 'https:');
    const mod = u.startsWith('https:') ? require('https') : require('http');
    mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 40000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, file).then(resolve);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve('HTTP ' + res.statusCode); }
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { fs.writeFileSync(file, Buffer.concat(chunks)); resolve(null); } catch (e) { resolve(e.message); } });
    }).on('error', (e) => resolve(e.message)).on('timeout', function () { this.destroy(); resolve('超时'); });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await post('/api/agent/switch', { storeName: STORE }, { timeout: 180000 });

  for (const id of IDS) {
    console.log('\n════ ' + id + ' ════');
    await post('/api/agent/eval-on-store', {
      store: STORE, code: `location.href='https://www.goofish.com/publish?itemId=${id}';'nav'`,
    }, { timeout: 60000, parse: false }).catch(() => {});
    await sleep(6000);

    let d = null;
    for (let i = 1; i <= 4 && !(d && d.imgs && d.imgs.length); i++) {
      const r = await post('/api/agent/eval-on-store', { store: STORE, code: READ }, { timeout: 120000 }).catch(() => null);
      let raw = r && r.result;
      try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { d = null; }
      if (!d || !d.imgs || !d.imgs.length) { console.log('  第 ' + i + ' 次没读到图，重试…'); await sleep(4000); }
    }
    if (!d || !d.imgs || !d.imgs.length) { console.log('  ❌ 读不到商品图'); continue; }

    console.log('  标题: ' + String(d.title || '').slice(0, 50));
    // ⚠️ 读到的 N 张 = **1 张主图 + (N-1) 张副图**。
    //    所以主图和副图**分开放**：主图放 <id>/主图.jpg，副图放 <id>/副图/1..8.jpg。
    //    为什么必须分开：publish-one.js 的 KUN_SUB_DIR 是"把目录里的图全发一遍"，
    //    主图混在里面会被**再发一次**，详情页出现两张一样的主图。
    console.log('  = 1 张主图 + ' + (d.imgs.length - 1) + ' 张副图');
    const dir = path.join(OUT, id);
    const subDir = path.join(dir, '副图');
    fs.mkdirSync(subDir, { recursive: true });
    for (let i = 0; i < d.imgs.length; i++) {
      const isMain = i === 0;
      const name = isMain ? '主图.jpg' : String(i).padStart(2, '0') + '.jpg';
      const fp = path.join(isMain ? dir : subDir, name);
      const err = await download(d.imgs[i], fp);
      let kb = 0;
      if (!err) {
        // ⚠️ 闲鱼图床会按 Accept 头回 WebP/PNG，虽然 URL 写着 .jpg ——
        //    不转的话下游 sharp/read_image 会报"扩展名与实际格式不符"（2026-10-07 实测）。
        // ⚠️ 必须**先读进内存再写回同一路径**：直接 sharp(fp) 会让 sharp 持有文件句柄，
        //    紧接着 fs.writeFileSync(fp) 在 Windows 上会 EPERM/UNKNOWN（实测每个文件都失败）。
        try {
          const sharp = svcRequire('node_modules/sharp');
          const src = fs.readFileSync(fp);
          const buf = await sharp(src).jpeg({ quality: 92 }).toBuffer();
          fs.writeFileSync(fp, buf);
          const m = await sharp(buf).metadata();
          kb = Math.round(buf.length / 1024);
          console.log('   ✅ ' + kb + ' KB  ' + name + '  ' + m.width + 'x' + m.height + '  ' + d.imgs[i].slice(-60));
          continue;
        } catch (e) { console.log('   ⚠️ 转 JPEG 失败(' + e.message + ')，原样保留'); }
        kb = Math.round(fs.statSync(fp).size / 1024);
      }
      console.log('   ' + (err ? '❌ ' + err : '✅ ' + kb + ' KB') + '  ' + name + '  ' + d.imgs[i].slice(-70));
    }
    fs.writeFileSync(path.join(dir, '_urls.json'), JSON.stringify(d.imgs, null, 1), 'utf8');
  }
  console.log('\n输出目录: ' + OUT);
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
