/**
 * tools/selftest-lib.js — 公共库自检
 *
 * 不连网也能跑（测配置与纯函数）；服务在跑时顺带验证真实链路。
 * 用法: node tools/selftest-lib.js [--live]
 */
const out = require('../lib/out');
const env = require('../lib/env');
const http = require('../lib/http');
const agent = require('../lib/agent');
const mtop = require('../lib/mtop');
const args = require('../lib/args');
const logmod = require('../lib/log');

(async () => {
  out.head('公共库自检');

  // ── 配置 ──
  out.kv('项目根', env.ROOT);
  out.kv('服务', env.serviceBase);
  out.kv('默认店铺', env.STORE);
  out.kv('运营店铺', env.ACTIVE.join('、') + '（名册共 ' + env.STORES.length + ' 个账号）');
  out.kv('店铺数', env.STORES.length);
  out.kv('Key 长度', String(env.SVC.apiKey || '').length);
  out.kv('阈值', JSON.stringify(env.TH));
  out.kv('永久规则', '咨询≤' + env.RULES.chatCap + ' 订单≤' + env.RULES.orderCap + ' 集合前缀=' + env.RULES.collectionPrefix);

  let bad = 0;
  const assert = (cond, msg) => { if (cond) out.ok(msg); else { out.bad(msg); bad++; } };

  assert(env.SVC.apiKey && env.SVC.apiKey.length > 20, 'Key 已加载');
  // ⚠️ 【2026-10-09 修·真实缺陷】原来这里断言 `env.STORE === '好易美代拍'`。
  //   而 tools/update.js 把这个自检当成【更新后的门禁】—— 于是任何默认店不是
  //   「好易美代拍」的学员机，每次更新都会自检失败 → 回滚 → 退出码 2，
  //   整套「自动更新」等于不存在（而需求书 9.2 说「没有这个就不要分发」）。
  //   这个断言本来要防的是【店铺名被编码搞坏】（BOM/GBK 那类），不是防"店名不是老板的店"。
  //   所以改成查那件事本身：非空、无替换字符、且在名册里。
  assert(!!env.STORE && env.STORE.indexOf('\uFFFD') < 0, '店铺名非空且不含乱码字符（' + env.STORE + '）');
  assert(env.STORES.indexOf(env.STORE) >= 0, '默认店铺在名册里：' + env.STORE);
  assert(env.ACTIVE.length >= 1 && env.ACTIVE.every((n) => env.STORES.indexOf(n) >= 0),
    'active 店铺是名册的子集：' + env.ACTIVE.join('、'));
  assert(env.ACTIVE.indexOf(env.STORE) >= 0, '默认店铺在 active 里');
  assert(env.p('lib', 'config.json').endsWith('lib/config.json'), 'p() 路径拼接正确');

  // ── 纯函数 ──
  assert(mtop.planVerdict({ statusGroup: 'online', statusDescTitle: '' }) === 'online', '状态判定 online');
  assert(mtop.planVerdict({ statusGroup: 'paused', statusDescTitle: '手动暂停' }) === 'manual_paused', '状态判定 手动暂停');
  assert(mtop.planVerdict({ statusGroup: 'paused', statusDescTitle: '账户余额不足，系统暂停' }) === 'balance_paused', '状态判定 余额不足');
  assert(mtop.planVerdict({ statusGroup: 'paused', statusDescTitle: '超过日预算上限，系统暂停' }) === 'budget_paused', '状态判定 超预算');
  assert(mtop.isCollection('擦亮宝贝20260927113406') === true, '集合计划识别');
  assert(mtop.isCollection('孙燕姿广州-订单120') === false, '单链接识别');
  assert(mtop.yuan(2750) === 27.5, '分转元');

  const np = mtop.normalizePlan({ campaignId: 1, title: '擦亮宝贝X', statusGroup: 'online', bidTarget: 'chat',
    cpm: 500, maxDayBudget: 15000, adDataDetailVO: { cost: 6000, chatPv: 3 }, infoTab: { todayCost: 1200 }, todayAdDataDetail: { chatPv: 2 }, entityList: [{ entityId: 9 }] });
  assert(np.budgetYuan === 150 && np.isCollection === true && Math.abs(np.costPerChat - 20) < 0.01, 'normalizePlan 计算正确');

  const a = args.parse(['广州', '宋雨琦', '--n=3', '--dry', '--store', '好易美代拍']);
  assert(a._.length === 2 && a.n === '3' && a.dry === true && a.store === '好易美代拍', 'args 解析（含中文）');

  // ── 标题规则（lib/title.js）──
  //   为什么加（2026-11-13）：这是「城市明星 → 商品标题」的唯一实现，
  //   规则错了发出去就是标题被平台静默砍掉（尾部看不见地丢字）。
  //   原来只有手工验过，没有断言，改代码时没人拦得住。
  const title = require('../lib/title');
  const FIT = title.makeFitTitle({ pad: ['（可看评价）', '高命中率'], max: 30, min: 28 });

  // ① 平台硬上限就是 30，任何时候都不能超
  assert(title.PLATFORM_TITLE_MAX === 30, '平台标题上限 = 30 字');
  assert(FIT.max === 30, 'makeFitTitle 把 max 压到 30（档案配更大也不认）');

  // ② 超长必收进 30，且括号不残缺
  const longTitle = '【代拍必中高命中率】广州王嘉尔演唱会首开代抢全价位都能接秒付前排';
  const fitLong = FIT(longTitle);
  assert(fitLong.length <= 30, '超长标题被收到 ≤30 字（实际 ' + fitLong.length + '）');
  assert(title.closeBrackets(fitLong) === fitLong, '截断后括号是闭合的');

  // ③ 【回归】空/空白标题不补成一屏感叹号
  //   2026-11-13 发现：空串会走补足逻辑，产出「（可看评价）！！！！…」共 28 字。
  //   空标题是上游没生成出来，应该空着暴露问题，不该用感叹号糊过去。
  const fitEmpty = FIT('');
  const fitBlank = FIT('   ');
  assert(fitEmpty === '' && fitBlank === '', '空/空白标题不补感叹号（实际: ' + JSON.stringify(fitEmpty) + '）');

  // ④ 【回归】squeezeTitle 漏传 max 时不产出 undefined
  //   2026-11-13 发现：how 会变成「硬截断到 undefined 字」。
  const noMax = title.squeezeTitle(longTitle);
  assert(noMax.how.indexOf('undefined') < 0, 'squeezeTitle 漏传 max 时不说 undefined');
  assert(noMax.text.length <= 30, 'squeezeTitle 漏传 max 时仍收到 ≤30 字');

  // ⑤ 短标题会补到 min（这是老行为，故意的：卡片标题不满 30 会让正文渗进来）
  const fitShort = FIT('广州王嘉尔');
  assert(fitShort.length === 28, '短标题补到 min=28（实际 ' + fitShort.length + '）');

  // ⑥ 正常长度的标题【原样保留】，不该被改
  const ok30 = '【代拍必中】王嘉尔广州站演唱会首开接代拍首开代抢王嘉尔演唱会';
  assert(FIT(ok30) === ok30, '刚好 30 字的标题原样保留');

  // ── 店铺档案的严格性（lib/store-profile.js）──
  //   为什么加（2026-11-13）：注释里承诺「档案写了但值非法 → 报错退出，绝不静默回落」，
  //   实测 7 种非法值只有 1 种（所在地模式）做到了。最坑的是版式 id 写错：
  //   原来只往 stderr 喷一行，然后按「不存在的版式」继续出图 —— 图是错的，但没人知道。
  const sp = require('../lib/store-profile');
  const fakeProfile = { name: '断言用假档案', 主图: { templates: ['xuliang-v1', '这个版式不存在'] } };
  let strictOk = false;
  try {
    sp.resolveTemplates(fakeProfile);
  } catch (e) {
    strictOk = /没登记的版式 id/.test(String(e.message));
  }
  assert(strictOk, '版式 id 写错会抛错（不静默出图）');

  // 现有档案必须都能解析（别把自己的店误伤了）
  let allProfilesOk = true;
  let badProfile = '';
  const storeNames = sp.list();
  for (const nm of storeNames) {
    try {
      sp.resolveTemplates(sp.load(nm));
    } catch (e) {
      allProfilesOk = false;
      badProfile = nm;
      break;
    }
  }
  assert(allProfilesOk,
    '现有 ' + storeNames.length + ' 个店的档案都能解析' + (badProfile ? '（坏的是 ' + badProfile + '）' : ''));

  // 价格 / 库存：非法值必须抛错（2026-11-13 加）。
  //   原来这两个字段完全不校验，档案里写 -100 或 "abc" 会一路传到 mtop 的 payload，
  //   等到平台拒绝才知道，而且报错信息看不出是档案写错了。
  {
    const fsx = require('fs');
    const px = require('path');
    const TMPNAME = '__断言用临时档案__';
    const tmpFile = px.join(sp.DIR, TMPNAME + '.json');
    const mk = (extra) => Object.assign({
      $schema: 'store-profile/1', name: TMPNAME, accountId: '', enabled: true, status: 'live',
    }, extra);
    const mustThrow = (label, extra) => {
      let threw = false;
      try {
        fsx.writeFileSync(tmpFile, JSON.stringify(mk(extra), null, 2), 'utf8');
        sp.load(TMPNAME);
      } catch (e) {
        threw = /不是合法的非负数字/.test(String(e.message));
      }
      return { label, threw };
    };
    const mustPass = (label, extra) => {
      let ok = true;
      try {
        fsx.writeFileSync(tmpFile, JSON.stringify(mk(extra), null, 2), 'utf8');
        sp.load(TMPNAME);
      } catch (e) {
        ok = false;
      }
      return { label, threw: ok };   // 这里 threw 复用"是否符合预期"
    };

    const r1 = mustThrow('价格负数', { 价格: -100 });
    const r2 = mustThrow('价格非数字', { 价格: 'abc' });
    const r3 = mustThrow('库存负数', { 库存: -5 });
    const r4 = mustPass('价格 0 合法', { 价格: 0 });
    const r5 = mustPass('价格 50 合法', { 价格: 50 });

    try { fsx.unlinkSync(tmpFile); } catch (e) {}

    assert(r1.threw && r2.threw && r3.threw, '价格/库存非法值会抛错');
    assert(r4.threw && r5.threw, '价格合法值（含 0）不误报');
  }

  // ── 服务 ──
  const up = await http.alive();
  out.kv('服务存活', up ? '是' : '否');
  if (!up) {
    out.warn('服务没在跑，跳过联机检查（--live 也需要它）');
  } else if (process.argv.includes('--live')) {
    try {
      const st = await agent.status();
      out.kv('agent 状态', JSON.stringify(st).slice(0, 120));
      await agent.ready();
      out.ok('店铺页面已打开');
      const plans = await mtop.adPlans({ days: 7 });
      out.ok('拉到计划 ' + plans.length + ' 条');
      out.table(mtop.PLAN_HEADERS, plans.slice(0, 14).map(mtop.planRow), { maxCol: [12, 24, 6, 12, 10, 10, 8, 6, 5] });
      out.full(plans, 'selftest-plans');
    } catch (e) {
      out.bad('联机检查失败：' + e.message);
      bad++;
    }
  }

  out.head('结果');
  if (bad) out.bad(bad + ' 项未通过');
  else out.ok('全部通过');
  out.done(bad ? 1 : 0);
})().catch((e) => out.fail(e));
