/**
 * lib/user-id.js —— 统一解析「当前店铺的闲鱼 userId」
 *
 * 为什么需要它（2026-11-12）：
 *   仓库里有 **11 个文件**把 userId 写死成好易美代拍的 '2507674944'：
 *     tools/cat-audit.js · check-listings.js · check-items-live.js · item-traffic.js
 *     tools/list-offshelf.js · probe-event-dup.js · verify-published.js
 *     diag-4items.js · find-new-group.js · find-group2.js · xy-snapshot.js
 *   后果是灾难性的、而且【不报错】：
 *     给超能水手代拍发完链接，verify-published 复核时说「全店 4 条、列表里找不到」——
 *     它查的是好易美的店。十八轮测试里我一直以为超能水手是空店，根因就是这个。
 *
 * 数据来源优先级：显式参数 > 店铺档案的「闲鱼userId」 > 环境变量 XY_USER_ID
 * 都拿不到就【抛错】，绝不静默回落到某家的 id —— 静默回落正是这个 bug 的可恶之处。
 */
const profile = require('./store-profile');

/** 当前店铺名（不 require lib/env 以免循环依赖，env 里也 require 了 profile） */
function currentStore(explicit) {
  if (explicit) return explicit;
  if (process.env.XY_STORE) return process.env.XY_STORE;
  try { return require('./env').STORE; } catch (e) { return ''; }
}

/** 拿 userId；拿不到就抛错并说清楚怎么补 */
function userIdOf(storeName) {
  const name = currentStore(storeName);
  try {
    const p = profile.load(name);
    if (p && p.闲鱼userId) return String(p.闲鱼userId);
  } catch (e) { /* 档案读不到，继续往下试 */ }
  if (process.env.XY_USER_ID) return String(process.env.XY_USER_ID);
  throw new Error(
    '店铺「' + (name || '(未指定)') + '」的档案里没有「闲鱼userId」，也没设 XY_USER_ID。\n' +
    '  它是闲鱼账号的数字 id（好易美代拍=2507674944，超能水手代拍=2219185703330）。\n' +
    '  补法：在 stores/' + name + '.json 里加 "闲鱼userId": "<那串数字>"\n' +
    '  或者临时：$env:XY_USER_ID="<数字>"\n' +
    '  （故意抛错而不是回落到某家的 id —— 静默回落会让人以为查的是这个店，其实查的是别人。）'
  );
}

module.exports = { userIdOf, currentStore };
