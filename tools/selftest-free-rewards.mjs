// Free reward claims must follow the game's rules and never reach a diamond-priced path.
import assert from 'node:assert/strict';
import { loadProtocol } from '../src/proto.mjs';
import { claimFestivalRewards, claimWeeklyRewards, claimVipDaily, syncFestivalDay, applyActiveScore } from '../src/free-rewards.mjs';
import { activityEntries, runActivity, readWeekOrder } from '../src/activities.mjs';

const protocol = loadProtocol();
const startOfDay = Math.floor((Date.now() / 1000 + 8 * 3600) / 86400) * 86400 - 8 * 3600;
const config = { tables: {
  LinkageLSRSignCfg: { data: [1, 2, 3].map(day => ({ rewardId: day, signDay: day, rewards: [['RUBY', 100]] })) },
  LinkageLSRActiveRewardCfg: { data: [{ rewardId: 1, score: 80, reward: ['RUBY', 1] }, { rewardId: 2, score: 160, reward: ['RUBY', 1] }, { rewardId: 3, score: 240, reward: ['RUBY', 1] }] },
  LinkageLSRDailyDealCfg: { data: [
    { packId: 1000, season: 1, price: 0, name: '每日赠礼', rewards: [['RUBY', 50]] },
    { packId: 1001, season: 1, price: 6, name: '每日礼包1', rewards: [] },
    { packId: 1000, season: 2, price: 0, name: '每日赠礼', rewards: [['RUBY', 50]] },
  ] },
  LinkageLSRLimitPackCfg: { data: [
    { packId: 1000, price: 0, name: '免费礼包', fixedRewards: [['RUBY', 100]] },
    { packId: 1001, price: -1, name: '免费礼包', fixedRewards: [['RUBY', 100]] },
    { packId: 1002, price: 30, name: '付费礼包', fixedRewards: [] },
  ] },
  SnowBallGiftCfg: { data: [{ packId: 1000, price: 0, limitCount: 1, name: '免费踏浪', fixedRewards: [['RUBY', 1]] }, { packId: 1002, price: 30, limitCount: 1, name: '付费', fixedRewards: [] }] },
  SnowBallBattlePassCfg: { data: [{ rwdId: 1, reqScore: 100 }, { rwdId: 2, reqScore: 200 }, { rwdId: 3, reqScore: 900 }] },
  WeekChargeRewardCfg: { data: [{ periodId: 7, rwdId: 1, rechargeAmount: 50, reward: [] }, { periodId: 7, rwdId: 2, rechargeAmount: 120, reward: [] }] },
  WeekHeroStarPeriodCfg: { data: [{ periodId: 8, showHero1: '甲', showHero2: '乙' }] },
  WeekHeroStarRwdCfg: { data: [{ periodId: 8, rwdId: 1, hero1Star: 0, hero2Star: 0 }, { periodId: 8, rwdId: 2, hero1Star: 5, hero2Star: 5 }] },
  WeekChipPackCfg: { data: [{ packId: 1000, price: 0, giftName: '免费礼包', reward: [['RUBY', 1]] }, { packId: 1001, price: 30 }] },
  WeekUniquePackCfg: { data: [{ packId: 1000, price: 0, name: '免费礼包', reward: [['RUBY', 1]] }] },
  WeekOrderRwdCfg: { data: [{ periodId: 9, rwdId: 1 }, { periodId: 9, rwdId: 2 }] },
  VipFreeCfg: { data: [{ level: 1, reward: [['RUBY', 10]] }, { level: 2, reward: [['RUBY', 15]] }, { level: 3, reward: [['RUBY', 20]] }] },
} };

function game(handlers = {}, base = {}) {
  const calls = [];
  const check = name => {
    assert(protocol[name], name + ' 应存在于真实协议');
    calls.push(name);
  };
  return Object.assign({
    calls,
    serverClockOffsetMs: 0,
    async request(name, body, response) {
      check(name);
      assert(protocol[response], response + ' 应存在于真实协议');
      if (handlers[name]) return handlers[name](body);
      throw new Error('未预期的请求 ' + name);
    },
    async sendWatch(name, body) {
      check(name);
      (this.sent ??= []).push([name, body]);
      if (handlers[name]) return handlers[name](body);
      return { sent: 1, name };
    },
  }, base);
}

function festival(day, details = {}) {
  const openTime = startOfDay - (day - 1) * 86400;
  const sub = (subActivityType, extra = {}) => ({ subActivityType, openTime, closeTime: startOfDay + 9 * 86400, ...extra });
  return { activityId: 101, type: '捞尸人联动活动', startTime: openTime, endTime: startOfDay + 10 * 86400, openTime, closeTime: startOfDay + 9 * 86400,
    subActivity: [sub(11, { dailyActive: details.active ?? {} }), sub(6, { dailyCombGift: details.comb }), sub(10, { dailySelectGift: details.select }), sub(27), sub(28), sub(12), sub(13)] };
}
const onlyKeys = (...keys) => key => keys.includes(key);
const record = () => { const rows = []; const report = entry => rows.push(entry); report.rows = rows; return report; };

// Sign only today's row, never an earlier day that the server charges diamonds for.
{
  const signed = [];
  const client = game({ ClaimActivityDailyCheckInRewardRequest: body => { signed.push(body.checkId); return { checkId: [1, body.checkId] }; } },
    { festivals: [festival(3, { active: { checkInId: [1], activeScore: 0 } })] });
  const report = record();
  await claimFestivalRewards(client, config, onlyKeys('festivalSign'), report);
  assert.deepEqual(signed, [3], '只签当天，第 2 天漏签不能被自动补上');
  assert.equal(report.rows[0].ok, true);
  await claimFestivalRewards(client, config, onlyKeys('festivalSign'), report);
  assert.deepEqual(signed, [3], '已签到不能重复发送');
}
{
  const row = festival(3);
  row.subActivity[0].openTime = row.openTime + 86400;
  const client = game({}, { festivals: [row] });
  const report = record();
  await claimFestivalRewards(client, config, onlyKeys('festivalSign'), report);
  assert.equal(client.calls.length, 0, '开放时间不一致时不能猜签到日');
  assert.equal(report.rows[0].skipped, true);
}
{
  const row = festival(2);
  row.subActivity[0].dailyActive = { checkInId: [], activeScore: 0 };
  row.subActivity[0].closeTime = startOfDay - 1;
  const client = game({}, { festivals: [row] });
  await claimFestivalRewards(client, config, onlyKeys('festivalSign', 'festivalActive'), record());
  assert.equal(client.calls.length, 0, '子活动已关闭时不发送');
}

// Claim every reached active tier and stop on an unconfirmed reply.
{
  let claimed = 0;
  const client = game({ ClaimActivityDailyActiveRewardRequest: () => ({ claimedId: ++claimed }) }, { festivals: [festival(1, { active: { activeScore: 170 } })] });
  await claimFestivalRewards(client, config, onlyKeys('festivalActive'), record());
  assert.equal(claimed, 2, '170 分只够前两档');
  applyActiveScore(client, { activityId: { low: 101, high: 0, unsigned: false }, activeScore: 300 });
  await claimFestivalRewards(client, config, onlyKeys('festivalActive'), record());
  assert.equal(claimed, 3, '活跃推送后继续领下一档');

  const stuck = game({ ClaimActivityDailyActiveRewardRequest: () => ({ claimedId: 0 }) }, { festivals: [festival(1, { active: { activeScore: 170 } })] });
  const report = record();
  await claimFestivalRewards(stuck, config, onlyKeys('festivalActive'), report);
  assert.equal(stuck.calls.length, 1, '未确认档位时不能循环重发');
  assert.equal(report.rows[0].ok, false);
}

// Only price 0 packs are claimed, once per day, and the day rollover reopens them.
{
  const client = game({}, { festivals: [festival(1)] });
  syncFestivalDay(client);
  await claimFestivalRewards(client, config, onlyKeys('festivalGifts'), record());
  assert.deepEqual(client.sent, [
    ['ClaimDailyCombGiftRequest', { activityId: 101, giftId: 1000 }],
    ['ClaimFreeSelectGiftRequest', { activityId: 101, giftId: 1000 }],
  ], '只领价格为 0 的礼包，同一礼包的多赛季配置只发一次');
  await claimFestivalRewards(client, config, onlyKeys('festivalGifts'), record());
  assert.equal(client.sent.length, 2, '当天不能重复领取');
  client.festivalDay -= 1;
  await claimFestivalRewards(client, config, onlyKeys('festivalGifts'), record());
  assert.equal(client.sent.length, 4, '跨天后重新可领');

  const rejected = game({ ClaimDailyCombGiftRequest: () => { throw new Error('已领取'); } }, { festivals: [festival(1)] });
  const report = record();
  await claimFestivalRewards(rejected, config, onlyKeys('festivalGifts'), report);
  assert.equal(report.rows[0].ok, false, '被拒绝要如实上报');
  assert.equal(report.rows[1].ok, true, '一个礼包失败不影响另一个');
}

// Snowball: free pack and reached free tiers only.
{
  let tier = 0;
  const client = game({
    SnowballDetailRequest: () => ({ totalScore: 250, claimedTier: tier, giftBuy: [] }),
    SnowballClaimRewardRequest: () => ({ claimedTier: ++tier }),
  }, { festivals: [festival(1)] });
  await claimFestivalRewards(client, config, onlyKeys('snowballFree'), record());
  assert.deepEqual(client.sent, [['SnowballClaimGiftRequest', { packId: 1000 }]]);
  assert.equal(tier, 2, '250 分只够前两档');
  assert(!client.calls.includes('SnowballBuyStaminaRequest') && !client.calls.includes('SnowballStartRequest'), '不买体力，也不玩小游戏');
}

// Spins spend the dedicated ticket only, capped per run.
{
  let score = 10;
  const client = game({
    CompassWheelInfoRequest: () => ({ score, cost: { id: '活动26捞尸人_抽奖券', num: 1 } }),
    AllItemRequest: () => ({ items: [{ itemId: '活动26捞尸人_抽奖券', num: 14 }] }),
    SpinCompassWheelRequest: body => { assert.equal(body.num, 1); return { score: ++score }; },
  }, { festivals: [festival(1)] });
  await claimFestivalRewards(client, config, onlyKeys('compassSpin'), record());
  assert.equal(client.calls.filter(name => name === 'SpinCompassWheelRequest').length, 10, '没有设置时默认 10 张');
  const countSpins = () => client.calls.filter(name => name === 'SpinCompassWheelRequest').length;
  await claimFestivalRewards(client, config, onlyKeys('compassSpin'), record(), null, undefined, { spinCount: 3 });
  assert.equal(countSpins(), 13, '按设置的张数抽奖');
  await claimFestivalRewards(client, config, onlyKeys('compassSpin'), record(), null, undefined, { spinCount: 500 });
  assert.equal(countSpins(), 27, '抽奖券不足时有多少用多少');
}
{
  const client = game({ CompassWheelInfoRequest: () => ({ score: 0, cost: { id: 'RUBY', num: 100 } }) }, { festivals: [festival(1)] });
  const report = record();
  await claimFestivalRewards(client, config, onlyKeys('compassSpin'), report);
  assert(!client.calls.includes('SpinCompassWheelRequest'), '消耗钻石时绝不抽奖');
  assert.equal(report.rows[0].skipped, true);
}
{
  const client = game({
    CompassWheelInfoRequest: () => ({ score: 0, cost: { id: '活动26捞尸人_抽奖券', num: 1 } }),
    AllItemRequest: () => ({ items: [] }),
  }, { festivals: [festival(1)] });
  await claimFestivalRewards(client, config, onlyKeys('compassSpin'), record());
  assert(!client.calls.includes('SpinCompassWheelRequest'), '没有抽奖券时不抽奖');
}

const now = Date.now() / 1000;
const week = (type, period) => ({ type, period, startTime: now - 100, endTime: now + 1000 });

// Weekly rewards.
{
  let times = 3;
  const client = game({
    AllItemRequest: () => ({ items: [{ itemId: '周转盘币', num: 2 }] }),
    WeekLotteryInfoRequest: () => ({ gotInfo: { times } }),
    WeekLotteryPrizeRequest: body => { assert.equal(body.times, 1); return { gotInfo: { times: ++times } }; },
  });
  await claimWeeklyRewards(client, config, [week(4, 1)], onlyKeys('weekLotterySpin'), record(), {});
  assert.equal(times, 5, '周转盘币有几个抽几次');
}
{
  const client = game({ WeekChargeInfoRequest: () => ({ rechargeAmount: 60, stage: [] }) });
  await claimWeeklyRewards(client, config, [week(2, 7)], onlyKeys('weekCharge'), record(), {});
  assert.deepEqual(client.sent, [['WeekChargeGotRewardRequest', { stage: 1 }]], '只领累充已达标档位');
}
{
  let got = 0;
  const client = game({
    WeekHeroStarInfoRequest: () => ({ gotStage: got }),
    AllHeroRequest: () => ({ heroes: [{ heroId: '甲', star: 5 }, { heroId: '乙', star: 4 }] }),
    WeekHeroStarGotRewardRequest: () => ({ gotStage: ++got }),
  });
  await claimWeeklyRewards(client, config, [week(3, 8)], onlyKeys('weekHeroStar'), record(), {});
  assert.equal(got, 1, '两位英雄都达标才领下一档');
}
{
  const free = game({ WeekChipInfoRequest: () => ({ gifts: [] }), WeekUniqueLotteryRequest: () => ({ gotFree: false }) });
  await claimWeeklyRewards(free, config, [week(6, 1), week(7, 1)], onlyKeys('weekChipFree', 'weekUniqueFree'), record(), {});
  assert.deepEqual(free.sent.map(row => row[0]), ['WeekChipGotFreeRequest', 'GotUniqueLotteryFreeRequest']);
  const done = game({ WeekChipInfoRequest: () => ({ gifts: [{ giftId: 1000, paidTimes: 1 }] }), WeekUniqueLotteryRequest: () => ({ gotFree: true }) });
  await claimWeeklyRewards(done, config, [week(6, 1), week(7, 1)], onlyKeys('weekChipFree', 'weekUniqueFree'), record(), {});
  assert.equal(done.sent, undefined, '已领的免费礼包不再发送');
}
{
  const ready = game({ WeekOrderInfoRequest: () => ({ gotRwdId: [1, 2], isGotFinal: false }) });
  await claimWeeklyRewards(ready, config, [week(5, 9)], onlyKeys('weekOrderFinal'), record(), { readOrder: async () => assert.fail('全部完成后不应再读材料') });
  assert.deepEqual(ready.sent, [['WeekOrderGotFinalRequest', {}]]);
  const early = game({ WeekOrderInfoRequest: () => ({ gotRwdId: [1], isGotFinal: false }) });
  await claimWeeklyRewards(early, config, [week(5, 9)], onlyKeys('weekOrderFinal'), record(), { readOrder: async () => ({ needed: new Map(), finished: false }) });
  assert.equal(early.sent, undefined, '未完成全部档位时不领最终奖励');
}
const player = { playerId: 77, worldId: 1, guildId: 0 };
{
  const client = game({
    WeekOrderInfoRequest: () => ({ gotRwdId: [1], isGotFinal: false }),
    AllItemRequest: () => ({ items: [{ itemId: '木板', num: 5 }] }),
  });
  const report = record();
  await claimWeeklyRewards(client, config, [week(5, 9)], onlyKeys('weekOrderSubmit'), report, { player, readOrder: async () => ({ needed: new Map([['木板', 50]]), finished: false }) });
  assert(!client.calls.includes('FinishWeekOrderRequest'), '材料不足不能提交');
  assert.equal(report.rows[0].skipped, true);
}
{
  const client = game({
    WeekOrderInfoRequest: () => ({ gotRwdId: [1], isGotFinal: false }),
    AllItemRequest: () => ({ items: [{ itemId: '木板', num: 60 }] }),
    FinishWeekOrderRequest: () => ({ randomRwdId: 2, newOrder: [] }),
  });
  await claimWeeklyRewards(client, config, [week(5, 9)], onlyKeys('weekOrderSubmit'), record(), { player, readOrder: async () => ({ needed: new Map([['木板', 50]]), finished: false }) });
  assert.equal(client.calls.filter(name => name === 'FinishWeekOrderRequest').length, 1, '每次只提交一单');
}

for(const mode of ['production','lost','incomplete','notSent']){
  const actor={playerId:mode==='production'?7801:mode==='lost'?7802:mode==='incomplete'?7803:7804,worldId:1,guildId:0};
  let stock=10,writes=0,bad=false;const got=[];
  const client=game({
    WeekInfoRequest:()=>({activityTime:[week(5,9)]}),
    WeekOrderInfoRequest:()=>({gotRwdId:[...got],isGotFinal:false,order:[{id:'木板',num:3}]}),
    AllItemRequest:()=>bad?{}:{items:[{itemId:'木板',num:stock}]},
    FinishWeekOrderRequest:()=>{writes++;if(mode==='notSent'&&writes===1)throw Object.assign(Error('not sent'),{notSent:true});stock+=2;got.push(writes);if(mode==='lost'&&writes===1)throw Error('accepted response lost');if(mode==='incomplete'&&writes===1)bad=true;return {randomRwdId:writes};},
  });
  const call=()=>claimWeeklyRewards(client,config,[week(5,9)],onlyKeys('weekOrderSubmit'),record(),{player:actor,readOrder:readWeekOrder});
  await call();assert.equal(writes,1);
  if(mode==='incomplete'){await call();assert.equal(writes,1,'完整库存缺失时旧周单也不能继续提交');bad=false;}
  await call();assert.equal(writes,2,'旧周单在业务确认及完整库存后继续，兼容净增长、丢回包恢复和明确未发送释放');assert.equal(stock,mode==='notSent'?12:14);
}

// VIP daily: levels up to the current one, once a day.
{
  const vipPlayer = { vip: { vipLevel: 2, dailyReward: [{ vipLevel: 1, isGot: true }] } };
  const client = game();
  await claimVipDaily(client, config, vipPlayer, onlyKeys('vipDaily'), record());
  assert.deepEqual(client.sent, [['GotVipDailyRewardRequest', { vipLevel: 2 }]], '不领已领和未达到的等级');
  await claimVipDaily(client, config, vipPlayer, onlyKeys('vipDaily'), record());
  assert.equal(client.sent.length, 1, '当天不重复');
  vipPlayer.vip.dailyDay -= 1;
  await claimVipDaily(client, config, vipPlayer, onlyKeys('vipDaily'), record());
  assert.equal(client.sent.length, 3, '跨天后重新可领');
  const none = game();
  await claimVipDaily(none, config, { vip: { vipLevel: 0 } }, onlyKeys('vipDaily'), record());
  assert.equal(none.calls.length, 0, 'VIP 0 没有每日奖励');
}

// Manual runs go through the selected tab only.
{
  const client = game({ ClaimActivityDailyCheckInRewardRequest: () => ({ checkId: [1] }), WeekInfoRequest: () => ({ activityTime: [] }) }, { festivals: [festival(1)] });
  const entries = activityEntries(client, []);
  assert.deepEqual(entries.map(row => row.name).sort(), ['每日免费礼包', '每日签到与活跃', '走江踏浪', '龙王罗盘'].sort(), '兑换商店和每日累充不显示');
  assert.equal(entries.find(row => row.name === '龙王罗盘').taskKeys.includes('compassSpin'), true);
  assert.equal(entries.filter(row => row.name === '每日免费礼包').length, 1, '两个礼包子活动合并成一个标签');
  const result = await runActivity(client, config, { activityId: 'linkage:101:11', taskKey: 'festivalSign' });
  assert.equal(result.results[0].ok, true);
  await assert.rejects(runActivity(client, config, { activityId: 'linkage:101:11', taskKey: 'compassSpin' }), /不支持/);
}

console.log('free rewards ok: today-only sign-in, active tiers, price 0 packs, daily rollover, snowball, ticket-only spins, weekly claims, week order guards, vip daily, manual scope');
