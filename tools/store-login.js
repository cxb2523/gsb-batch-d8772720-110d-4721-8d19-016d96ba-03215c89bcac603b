/**
 * tools/store-login.js — 给某个店铺走一次登录（首登 / 掉线重登）
 *
 * ⚠️⚠️ 为什么**不用**服务端的 POST /api/agent/login（2026-10-07 实测踩过，重要）
 *
 *   agent.js:639 的 checkLoginState() 只看 this.page 的正文里有没有「消息 / 发布 / 我的」：
 *       return text.includes('消息') || text.includes('发布') || text.includes('我的');
 *   而 this.page 是 **dayu 广告页**。没登录时 dayu 会重定向到 https://www.goofish.com/ 首页，
 *   首页导航栏本来就有「发布」「消息」→ checkLoginState() **恒为 true**。
 *   于是 login() 一进来就判「已登录」，立刻 saveState() 存下一份**没登录的** state.json
 *   （475 KB，对比真登录的好易美代拍 981 KB），并且 14 秒就返回 {"ok":true,"state":"ready"}。
 *   —— 一次尝试就"成功"，其实什么都没登。**这个返回值不可信。**
 *
 *   所以本脚本走【人工登录 + 服务端自动存档】这条路，全程不调 /api/agent/login。
 *   真正可信的判据只有一个：**广告接口能不能调通**（SUCCESS），这个装不出来。
 *
 * 流程：
 *   1. switch 到目标店铺 → 弹出该店铺专属的可见 Chrome 窗口（并 bringToFront）
 *   2. 你在窗口里手动登录（账号密码/扫码 + 短信/滑块）
 *   3. 脚本每 15 秒用一次 mtop 广告接口复核，通了就算登上了
 *   4. 复核通过后 switch 回默认店铺 —— agent.js 的 _switchTo() 第 1 步会自动 saveState() 存档
 *   5. 再切回目标店铺复核一次，证明**存下来的登录态真的能恢复**（不是内存里的假象）
 *
 * 用法:
 *   node tools/store-login.js "好易美票务Hope"
 *   node tools/store-login.js "好易美票务Hope" --wait=15     # 最多等 15 分钟
 */
const fs = require('fs');
const path = require('path');
const agent = require('../lib/agent');
const { post } = require('../lib/http');
const { STORE, PATHS } = require('../lib/env');

/**
 * ⚠️ 这里**故意不用** lib/agent 的 evalOnStore —— 它第一次调用会触发 ready()，
 *    而 ready() 默认启动 config.store.active（= 好易美代拍），会把刚切过去的店铺又切走。
 *    另外 /api/agent/start-one 用的是**启动时缓存的账号表**（findAccountByName 不刷新），
 *    新加的店铺会回「账号不存在」；而 /api/agent/switch 命中不到时会 refreshAccounts()，
 *    所以「切店铺」找得到、「start-one」找不到。两个坑叠在一起，只能直连 HTTP。
 */
async function evalOnStore(code, timeoutMs) {
  const r = await post('/api/agent/eval-on-store', { store: NAME, code }, { timeout: timeoutMs || 60000 });
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'eval 失败');
  return r.result;
}

const NAME = process.argv[2];
if (!NAME || NAME.startsWith('--')) { console.log('用法: node tools/store-login.js "<店铺名>" [--wait=10]   # 10 = 分钟（默认 10）'); process.exit(2); }
const argOf = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? Number(a.split('=')[1]) : d; };
const WAIT_MIN = argOf('wait', 10) || 10;

const PROFILES = path.join(PATHS.playwrightService, 'browser-profiles');
const AD = 'https://dayu.goofish.com/?site=FISHAD#/ad/polish/campaign-manage';
const log = (m) => console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真·登录判据：在店铺页调广告接口。
 * 返回 { ok, ret, href, stage }。ok=true 只有一种情况：ret 以 SUCCESS 开头。
 */
const PROBE = `(async function(){
  try{
    if (!(window.lib && window.lib.mtop)) return JSON.stringify({stage:'no-mtop', href:location.href});
    var r = await window.lib.mtop.request({api:'mtop.taobao.idle.ad.campaign.search',v:'1.0',type:'GET',
      data:{requestJson:JSON.stringify({pageNum:1,pageSize:5,campaignStatus:[],statusGroup:[]})}});
    var ret = String((r && r.ret && r.ret[0]) || '');
    return JSON.stringify({stage:'mtop', href:location.href, ret:ret, ok:ret.indexOf('SUCCESS')===0});
  }catch(e){ return JSON.stringify({stage:'throw', href:location.href, err:String((e&&e.message)||e)}); }
})()`;

async function probe() {
  try {
    const raw = await evalOnStore(PROBE, 60000);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return { stage: 'eval-error', err: e.message }; }
}

(async () => {
  const list = await agent.accounts();
  const acc = (list || []).find((a) => a.name === NAME);
  if (!acc) {
    log('❌ 账号列表里没有「' + NAME + '」。现有：' + (list || []).map((a) => a.name).join('、'));
    log('   （账号列表来自中台后台，不在里面就得先去后台加）');
    process.exit(2);
  }
  const stateFile = path.join(PROFILES, acc.id, 'state.json');
  log('目标「' + acc.name + '」 id=' + acc.id + '  手机=' + (acc.username || '').trim() + '  已有登录态=' + fs.existsSync(stateFile));

  const sw = await post('/api/agent/switch', { storeName: NAME, accountId: acc.id }, { timeout: 180000 });
  // 【2026-11-14 第 159 轮】这里原来【每次都】把整个返回值甩出来：
  //     切换店铺：{"ok":true,"state":"ready","tabId":...}
  //   学员扫码头一步就看到一坨内部字段；失败时（原来 L91）只说「切换失败，中止」，不给原因。
  //   改成：成功给一句中文，失败把服务端的中文原因带出来 + 给下一步。
  if (sw && sw.ok === true) {
    log('✅ 已切到「' + NAME + '」');
  } else {
    const why = String((sw && (sw.error || sw.msg)) || '').trim();
    log('❌ 切换到「' + NAME + '」失败' + (why ? '：' + why : '（服务端没给原因）'));
    if (/账号未找到|账号不存在/.test(why)) {
      log('   → 店名和 8093 账号表对不上。跑 node tools\\store-ready.js "店名" 能列出现有店铺。');
    }
    log('   → 先确认 8093 服务开着（黑窗口里有「闲鱼上架助手已启动」）。');
    process.exit(1);
  }

  // 导航到广告后台：① 登录判据在这里最靠谱 ② 没登录时它会自己弹登录入口
  await evalOnStore('location.href=' + JSON.stringify(AD) + ';"nav"', 60000).catch(() => {});
  await sleep(16000);
  await post('/api/agent/show-store', { name: NAME }, { timeout: 30000 }).catch(() => {});

  log('👉 请看弹出的 Chrome 窗口，在那个窗口里完成登录（密码/扫码 + 短信/滑块）');
  log('   本脚本不调 /api/agent/login（它是坏的，见文件头），我只负责检测 + 存档');

  const p0 = await probe();
  // 【第 159 轮】原来这里是 JSON.stringify(p0) —— 学员看到 {"ok":false,"href":...} 一坨。
  //   他只关心一件事：登录了没有。
  log('  当前状态：' + (p0 && p0.ok ? '✅ 已登录' : '未登录（在弹出的窗口里完成扫码/短信）'));
  if (p0 && p0.ok) { log('（已经是登录态，直接进存档流程）'); }

  const deadline = Date.now() + WAIT_MIN * 60000;
  let ok = !!(p0 && p0.ok);
  let last = '';
  while (!ok && Date.now() < deadline) {
    await sleep(15000);
    const p = await probe();
    const brief = JSON.stringify(p).slice(0, 220);
    if (brief !== last) { log('  ' + brief); last = brief; }
    ok = !!(p && p.ok);
  }
  if (!ok) {
    log('❌ 等了 ' + WAIT_MIN + ' 分钟还是没登上。浏览器窗口还开着 —— 你自己登完后重跑本脚本，或告诉我。');
    process.exit(1);
  }

  log('✅ 广告接口已通 = 真登录上了。现在切走以触发自动存档…');
  await post('/api/agent/switch', { storeName: STORE }, { timeout: 180000 });
  await sleep(3000);
  const kb = fs.existsSync(stateFile) ? Math.round(fs.statSync(stateFile).size / 1024) : 0;
  log('  存档：' + stateFile + '  ' + (kb ? kb + ' KB' : '❌ 没生成'));
  log('  （参考：真登录态约 980 KB，空态约 470 KB；体积只是旁证，下面还有硬验证）');

  log('再切回「' + NAME + '」复核一次 —— 这一步证明存下来的登录态能恢复');
  await post('/api/agent/switch', { storeName: NAME, accountId: acc.id }, { timeout: 180000 });
  await sleep(3000);
  const pv = await probe();
  log('  复核：' + (pv && pv.ok ? '✅ 登录态能恢复' : '❌ 恢复不了（下面会说怎么办）'));
  if (pv && pv.ok) { log('🎉「' + NAME + '」登录完成且登录态可恢复'); process.exit(0); }
  log('⚠ 存档后复核没通 —— 可能页面被回收了，重跑一次本脚本再看。');
  process.exit(1);
})().catch((e) => {
  // 【第 159 轮】原来直接打 e.stack —— 一坨英文行号，学员只会以为装坏了。
  //   改成：先用中文说「脚本出错了」，再把细节放后面并标明「发给管理员、看不懂可以忽略」。
  log('❌ 脚本出错了：' + String((e && e.message) || e));
  log('   把这几行发给管理员就行；下面是细节，看不懂可以忽略：');
  String((e && e.stack) || '').split('\n').slice(0, 4).forEach((l) => log('   ' + l));
  process.exit(1);
});
