/**
 * tools/probe-ad-balance.js — 只读：读任意店铺的「超级擦亮」账户余额
 *
 * 为什么需要它：`ad-balance-duty.ps1` 只读**默认店铺**（好易美代拍），而且带空闲门槛
 * （人在电脑前就跳过）。新接进来的票务店余额没人看 —— 2026-10-07 就是这样发现
 * 「好易美票务Hope 可用余额 ¥0，17 个擦亮计划全停」的。
 *
 * 读法抄自 `ad-balance-duty.ps1`：导航到 seller.goofish.com 的擦亮工作台，
 * 从正文里抓「可用余额 / 今日花费 / 擦亮中计划」。注意页面把余额渲染成「386 .97」（数字中间有空格）。
 *
 * 用法:
 *   node tools/probe-ad-balance.js "好易美票务Hope"
 *   node tools/probe-ad-balance.js "好易美票务Hope" "好易美代拍"
 */
const { post } = require('../lib/http');

const NAMES = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
if (!NAMES.length) { console.log('用法: node tools/probe-ad-balance.js "<店铺名>" ...'); process.exit(2); }

const HOME = 'https://seller.goofish.com/?site=COMMONPRO#/seller-ad/home';
const READ = `(function(){
  var b = document.body ? document.body.innerText : '';
  function grab(k){
    var re = new RegExp(k + '[^0-9]{0,12}([0-9][0-9, ]*\\.?[0-9]*)');
    var m = b.match(re);
    return m ? m[1].replace(/[ ,]/g, '') : null;
  }
  return JSON.stringify({
    url: location.href,
    bodyLen: b.length,
    bal: grab('可用余额'),
    spend: grab('今日花费'),
    liveCnt: (b.match(/擦亮中计划\\s*(\\d+)/) || [])[1] || null,
    pausedCnt: (b.match(/已暂停擦亮计划\\s*(\\d+)/) || [])[1] || null,
    warn: (b.match(/[^\\n]{0,30}(余额不足|尽快充值|即将中断)[^\\n]{0,40}/g) || []).slice(0, 3)
  });
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const name of NAMES) {
    console.log('\n════ ' + name + ' ════');
    try {
      await post('/api/agent/switch', { storeName: name }, { timeout: 180000 });
      let j = null;
      for (let i = 1; i <= 4 && !(j && j.bal); i++) {
        // ⚠️ 必须强制重载：这个 SPA 已经在 seller.goofish.com 时，再赋同一个 location.href
        //    **不会重新加载**，读到的是上一次的旧快照。
        //    2026-10-07 实测：17:00 全店暂停后，这里仍报「擦亮中 13」，和接口的「14 条全暂停」对不上，
        //    就是读了暂停前的缓存页面。
        await post('/api/agent/eval-on-store', {
          store: name,
          code: `(function(){var onSeller=location.href.indexOf('seller.goofish.com')>=0;` +
                `var n=(document.body?document.body.innerText:'').length;` +
                `if(!onSeller||n<200){location.href=${JSON.stringify(HOME)};return 'nav';}` +
                `location.reload();return 'reload';})()`,
        }, { timeout: 60000 }).catch(() => {});
        await sleep(12000);
        const r = await post('/api/agent/eval-on-store', { store: name, code: READ }, { timeout: 60000 });
        const d = r && r.result;
        j = typeof d === 'string' ? JSON.parse(d) : d;
        if (j && !j.bal) console.log('  第 ' + i + ' 次没读到（bodyLen=' + j.bodyLen + ' url=' + j.url + '）');
      }
      if (!j || !j.bal) { console.log('  ❌ 读取失败: ' + JSON.stringify(j).slice(0, 200)); continue; }
      console.log('  可用余额: ¥' + j.bal);
      console.log('  今日花费: ¥' + (j.spend || '?' ));
      console.log('  擦亮中计划: ' + (j.liveCnt == null ? '?' : j.liveCnt) + '   已暂停擦亮计划: ' + (j.pausedCnt == null ? '?' : j.pausedCnt));
      if (j.warn && j.warn.length) j.warn.forEach((w) => console.log('  ⚠️ ' + w));
      console.log('  页面: ' + j.url);
    } catch (e) { console.log('  ❌ ' + e.message); }
  }
})().catch((e) => { console.log('FAIL ' + ((e && e.stack) || e)); process.exit(1); });
