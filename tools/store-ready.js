/**
 * tools/store-ready.js — 确保某个店铺页面已启动就绪（发布 / 巡检的前置）
 *
 * 为什么需要它：
 *   `ensure-agent.js` 只启动 `config.store.active` 里的店铺（现在只有好易美代拍）。
 *   要操作【不在 active 里】的店铺（比如新接进来的「好易美票务Hope」），
 *   得先把它的页面拉起来 —— 否则 `eval-on-store` 直接回「店铺未就绪」。
 *
 *   顺便兜住服务端那个坑：`POST /api/agent/start-one` 用的是**启动时缓存的账号表**
 *   （findAccountByName 命中不到不刷新），新加的店铺会回「账号不存在」；
 *   而 `POST /api/agent/switch` 命中不到时会 refreshAccounts()。
 *   所以这里：先试 start-one，报「账号不存在」就先 switch 一次刷新，再 start-one。
 *
 * 用法:
 *   node tools/store-ready.js "好易美票务Hope"
 *   node tools/store-ready.js "好易美票务Hope" "好易美代拍"     # 可以给多个
 */
const { post, get } = require('../lib/http');

const NAMES = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
if (!NAMES.length) { console.log('用法: node tools/store-ready.js "<店铺名>" ["<店铺名>" ...]'); process.exit(2); }

const log = (m) => console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + m);

(async () => {
  let bad = 0;
  for (const name of NAMES) {
    let r = await post('/api/agent/start-one', { name }, { timeout: 180000 }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || r.ok !== true) {
      const err = String((r && r.error) || '');
      if (/账号不存在/.test(err)) {
        log('「' + name + '」start-one 说账号不存在 → 先 switch 一次刷新账号表');
        const sw = await post('/api/agent/switch', { storeName: name }, { timeout: 180000 }).catch((e) => ({ ok: false, error: e.message }));
        if (!sw || sw.ok !== true) {
          const swErr = String((sw && sw.error) || '');
          // 【2026-11-14 第 158 轮】学员最容易撞到的就是这条：店名打错了，
          //   或者还没配这个店就跑 store-ready。原来这里直接 JSON.stringify(sw)，
          //   屏幕上是一句 API 原文 ——
          //       ❌ switch 也失败：{"ok":false,"error":"账号未找到: 测试店"}
          //   既看不懂，也不知道下一步干嘛（和 144/151/152/153 轮那几类同一个毛病）。
          //   改成：说清是哪种情况 + 把 8093 里现有的店列出来，省得他再开网页找。
          if (/账号未找到|账号不存在|not found/i.test(swErr) || /账号不存在/.test(err)) {
            log('  ❌ 8093 里没有叫「' + name + '」的店铺。');
            log('    两个可能：');
            log('       ① 名字打错了 —— 要和网页右上角「店铺：xxx ▾」显示的一模一样');
            log('       ② 还没配这个店 —— 打开网页点「⑤ 配置一家新店」，五步填完再来');
            try {
              const acc = await get('/api/agent/accounts', { timeout: 15000 });
              const list = (acc && (acc.data || acc.accounts)) || [];
              const names = list.map((a) => a.name).filter(Boolean);
              log('     8093 里现有的店：' + (names.length ? names.join(' / ') : '（一个都还没有）'));
            } catch (e) { /* 列不出来就算了 —— 别让这一步反而报错 */ }
            bad++;
            continue;
          }
          log('  ❌ switch 也失败：' + JSON.stringify(sw).slice(0, 140));
          bad++;
          continue;
        }
        r = { ok: true, state: sw.state };
      } else if (/请先调用 start-all|no agent|浏览器.*没.*启动/i.test(err)) {
        // 2026-11-13 加：agent 被 stop 掉之后（或服务刚重启还没 start-all），
        //   start-one 会返回「请先调用 start-all」—— 学员完全不知道那是什么。
        //   这里自动补一次 start-all 再重试，别让人去看这句话。
        log('「' + name + '」浏览器还没启动 → 自动启动一次（约 2 分钟，要起 Chromium 再加载闲鱼主站，别关窗口）');
        const sa = await post('/api/agent/start-all', {}, { timeout: 180000 }).catch((e) => ({ ok: false, error: e.message }));
        if (!sa || sa.ok !== true) {
          log('  ❌ 自动启动失败：' + JSON.stringify(sa).slice(0, 140));
          log('     处理：关掉那个黑窗口，重新双击 启动.cmd 之外的 8093 服务（xianyu-playwright-service\\start.bat），再试。');
          bad++; continue;
        }
        r = await post('/api/agent/start-one', { name }, { timeout: 180000 }).catch((e) => ({ ok: false, error: e.message }));
        if (!r || r.ok !== true) { log('  ❌ 自动启动后仍然失败：' + ((r && r.error) || '')); bad++; continue; }
      } else {
        log('❌「' + name + '」启动失败：' + err);
        bad++;
        continue;
      }
    }

    // 真去页面里看一眼，别只看返回值
    try {
      const v = await post('/api/agent/eval-on-store', { store: name, code: 'JSON.stringify({href:location.href,t:document.title})' }, { timeout: 60000 });
      const d = typeof v.result === 'string' ? JSON.parse(v.result) : v.result;
      log('✅「' + name + '」就绪  页面=' + d.href);
    } catch (e) {
      log('⚠「' + name + '」启动了但 eval 失败：' + e.message);
      bad++;
    }
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { log('❌ ' + ((e && e.stack) || e)); process.exit(1); });
