// 活动样本使用本地真实配置和协议编解码，不登录游戏。
import { EventEmitter } from 'node:events';
import { getConfig } from '../../src/config.mjs';
import { loadProtocol } from '../../src/proto.mjs';
import { automationWireId } from '../../src/automation-policy.mjs';
import { defaultSettings } from '../../src/automation-settings.mjs';

export function seasonalFixture() {
  const protocol = loadProtocol(),
    config = getConfig(),
    settings = defaultSettings();
  const now = Math.floor(Date.UTC(2026, 10, 5, 4) / 1000);
  const client = new EventEmitter();
  client.connected = true;
  client.serverClockOffsetMs = now * 1000 - Date.now();
  const player = {
    playerId: '9007199254740993',
    guildId: '9007199254741001',
    worldId: '2002001001',
    level: 37,
    vip: { vipLevel: 3 }
  };
  const window = { startTime: now - 86400, endTime: now + 3 * 86400, period: 1001 };
  const festival = {
    type: '捞尸人联动活动',
    activityId: automationWireId('9007199254741011'),
    ...window,
    subActivity: [27, 28, 10].map((subActivityType) => ({
      ...window,
      subActivityType,
      ...(subActivityType === 10 ? { dailySelectGift: { boughtTimes: {} } } : {})
    }))
  };
  client.festivals = [festival];
  client.tradeWindow = { ...window };
  client.beautyWindow = { ...window, showEndTime: window.endTime + 86400 };
  const city = (price, goodsId = 1001) => ({
    goods: [{ goodsId, stock: 100, price }],
    specGoodsId: goodsId,
    rareGoodsId: 1002,
    isReport: true
  });
  const state = {
    writes: [],
    reads: [],
    mode: '',
    onRead: null,
    onWrite: null,
    stock: { 活动26捞尸人_抽奖券: 12, 代颜人投票券: 9 },
    shop: { shopItem: [], resetTime: now + 86400 },
    cross: {
      roomLevel: 1,
      subjectId: 1,
      settleTime: now + 43200,
      grouping: false,
      gotDailyRewardIdx: 0,
      rankList: [
        {
          playerId: automationWireId(player.playerId),
          rank: 9,
          score: 4500,
          nickname: '验证',
          level: 37,
          avatar: { image: 1, frame: 0 },
          worldId: 2002001001,
          title: 0
        }
      ]
    },
    snow: { totalScore: 220, claimedTier: 0, giftBuy: [] },
    wheel: { score: 240, claimedId: 0, times: 4, cost: { id: '活动26捞尸人_抽奖券', num: 1 } },
    passes: {
      3: { score: 5000, activePay: false, got: [], endTime: window.endTime },
      10: { score: 220, activePay: false, got: [], endTime: window.endTime }
    },
    beauty: {
      todayVote: 1,
      gotVote: false,
      player: [
        { no: 143, playerId: 100, rank: 1, vote: 4 },
        { no: 620, playerId: 101, rank: 2, vote: 15 },
        { no: 2658, playerId: 102, rank: 3, vote: 15 }
      ],
      ownVote: []
    },
    trade: {
      period: 1001,
      cargo: { cityId: 10, cargoLv: 1, moveEndTime: 0, moveToCityId: 0 },
      player: { coins: 10000, profit: 6000, goods: [] },
      gotAchieveRwdId: 0,
      gotReportRwdId: 0,
      guildReportNum: 6
    },
    nextTradePid: 100,
    markets: { 10: city(40), 20: city(65) },
    radar: {
      radar: [
        { cityId: 10, specGoodsId: 1001, rareGoodsId: 1002 },
        { cityId: 20, rareGoodsId: 1001, specGoodsId: 1002 }
      ]
    },
    tasks: { profit: 100000, tradeTimes: 20, gotTaskId: [] }
  };
  const reward = { reward: { asset: [{ id: '木材', num: 2 }] } };
  const reads = {
    AllItem: () => ({ items: Object.entries(state.stock).map(([itemId, num]) => ({ itemId, num })) }),
    SnowballDetail: () => state.snow,
    CompassWheelInfo: () => state.wheel,
    BeautyInfo: () => state.beauty,
    CrossRankInfo: () => state.cross,
    LimitedShop: () => state.shop,
    BattlePass: (b) => state.passes[b.type],
    TradeInfo: () => state.trade,
    TradeTask: () => ({ guildTask: state.tasks }),
    TradeCity: (b) => state.markets[b.cityId],
    TradeGuildRadar: () => state.radar,
    FirstCharge: () => ({ firstCharge: { record: [] } })
  };
  const actions = {
    GetDailyReward: () => {
      state.cross.gotDailyRewardIdx = 2;
      return reward;
    },
    LimitedShopGotFree: (b) => {
      state.shop.shopItem.push({ id: b.id, gotTimes: 1 });
      return reward;
    },
    SnowballClaimReward: () => {
      state.snow.claimedTier = 2;
      return { ...reward, claimedTier: 2 };
    },
    SnowballClaimGift: (b) => {
      state.snow.giftBuy.push({ packId: b.packId, bought: 1 });
      return reward;
    },
    WatchAdv: () => ({}),
    GotAdvReward: (b) => {
      state.snow.giftBuy.push({ packId: b.id, bought: 1 });
      return reward;
    },
    ClaimFreeSelectGift: () => reward,
    BattlePassGotReward: (b) => {
      const pass = state.passes[b.type];
      const tiers =
        b.type === 3
          ? config.tables.TradePassCfg.data.filter((t) => t.period === 1001)
          : config.tables.SnowBallBattlePassCfg.data;
      pass.got = tiers
        .filter((t) => t.reqScore <= pass.score)
        .map((t) => ({ id: t.rwdId, freeGot: true, payGot: pass.activePay }));
      return { ...reward, got: pass.got };
    },
    ClaimCompassWheelReward: () => {
      state.wheel.claimedId = 2;
      return { ...reward, claimedId: 2 };
    },
    SpinCompassWheel: (b) => {
      state.wheel.times += b.num;
      state.stock['活动26捞尸人_抽奖券'] -= b.num;
      return {
        ...reward,
        score: state.wheel.score,
        spin: Array.from({ length: b.num }, () => ({ innerId: 1, outerId: 2, score: 1 }))
      };
    },
    BeautyVote: (b) => {
      const target = state.beauty.player.find((r) => r.no === b.no);
      target.vote += b.count;
      state.beauty.todayVote += b.count;
      state.stock['代颜人投票券'] -= b.count;
      const own = state.beauty.ownVote.find((r) => r.no === b.no) || { no: b.no, vote: 0 };
      own.vote += b.count;
      state.beauty.ownVote = [own];
      return { player: target, ownVote: own };
    },
    GotBeautyVote: () => {
      state.beauty.gotVote = true;
      return reward;
    },
    TradeBuy: (b) => {
      const t = state.trade,
        quote = state.markets[b.cityId].goods.find((r) => r.goodsId === b.goodsId);
      t.player.coins -= b.buyNum * quote.price;
      quote.stock += b.buyNum;
      state.nextTradePid = Math.max(state.nextTradePid, ...t.player.goods.map(g => g.pid + 1));
      t.player.goods.push({
        pid: state.nextTradePid++,
        goodsId: b.goodsId,
        cityId: b.cityId,
        buyPrice: quote.price,
        num: b.buyNum
      });
      return { player: t.player };
    },
    TradeMove: (b) => {
      const c = state.trade.cargo;
      c.moveToCityId = b.mvToCityId;
      c.moveStartTime = Math.floor((Date.now() + client.serverClockOffsetMs) / 1000);
      c.moveEndTime = c.moveStartTime + 7200;
      return { cargo: c };
    },
    TradeSell: (b) => {
      const t = state.trade.player,
        item = t.goods.find((g) => g.pid === b.pid),
        price = state.markets[b.cityId].goods.find((g) => g.goodsId === item.goodsId).price;
      const difference = (price - item.buyPrice) * b.sellNum;
      const margin = config.tables.TradeShipCfg.data.find(row => row.lv === state.trade.cargo.cargoLv).profitMargin;
      const gain = difference > 0 ? Math.ceil(difference * (1 + margin / 10000)) : difference;
      t.coins += gain + item.buyPrice * b.sellNum;
      t.profit += Math.max(0, gain);
      item.num -= b.sellNum;
      t.goods = t.goods.filter((g) => g.num > 0);
      return { player: t };
    },
    GotTradeAchievement: () => {
      state.trade.gotAchieveRwdId = 1;
      return { ...reward, gotAchieveRwdId: 1 };
    },
    TradeGotTask: (b) => {
      state.tasks.gotTaskId = config.tables.TradeGuildTaskCfg.data
        .filter(
          (t) =>
            t.day === b.day &&
            t.tragetCount <= (t.taskType === 0 ? state.tasks.profit : state.tasks.tradeTimes)
        )
        .map((t) => t.id);
      return { ...reward, gotTaskId: state.tasks.gotTaskId };
    },
    GotTradeReport: () => {
      state.trade.gotReportRwdId = 1;
      return { ...reward, gotReportRwdId: 1 };
    }
  };
  function dispatch(name, b, response, watch = false) {
    protocol[name].decode(protocol[name].encode(b).finish());
    const stem = name.replace(/Request$/, '');
    let value;
    if (reads[stem]) {
      state.reads.push(name);
      state.onRead?.(stem, b);
      value = reads[stem](b);
    } else {
      if (!actions[stem]) throw Error('夹具未声明请求 ' + name);
      state.writes.push({ name, body: structuredClone(b) });
      state.onWrite?.(stem, b);
      if (state.mode === 'reject')
        throw Object.assign(Error('明确拒绝'), { prompt: { prompt: 5 }, request: name });
      if (state.mode === 'unknown') throw Error('结果未知');
      value = actions[stem](b);
      if (state.mode === 'lostAfterApply') throw Error('回包丢失');
    }
    return watch ? {} : protocol[response].decode(protocol[response].encode(value).finish());
  }
  client.request = async (name, b = {}, response = name.replace(/Request$/, 'Response')) =>
    dispatch(name, b, response);
  client.sendWatch = async (name, b) => dispatch(name, b, null, true);
  return { config, protocol, client, player, settings, state, now, window };
}
