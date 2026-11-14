// 海商王推送仅使快照失效并唤醒现有串行调度，不在监听器中发送任何协议。
import { merchantTiming } from './merchant-planner.mjs';

const watchers = new WeakMap();
const valid = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => valid(value) && value > 0;
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const eventKey = event => [event?.period ?? 0, event?.startTime ?? 0, event?.endTime ?? 0].join(':');
export function merchantMonitorSeconds(settings) {
  const seconds = settings?.merchant?.monitorSeconds ?? settings?.monitorSeconds;
  return positive(seconds) ? Math.max(10, Math.min(300, seconds)) : 60;
}

export function watchMerchant(client) {
  if (watchers.has(client)) return watchers.get(client);
  const listeners = new Set();
  let nextAt = 0, event = null, cityId = null, market = null, ports = new Set(), dirty = false, revision = 0;
  let attached = false;
  const notify = reason => {
    for (const listener of listeners) { try { listener({ reason, revision, nextCheckAt: nextAt }); } catch {} }
  };
  const invalidate = (reason = '商情已变化') => {
    nextAt = Math.min(nextAt, nowOf(client));
    revision++;
    if (!dirty) { dirty = true; notify(reason); }
  };
  const onMessage = ({ name, body } = {}) => {
    if (name === 'SCTradeCityGoods') {
      if (positive(cityId) && body?.cityId === cityId) invalidate('本港价格或联盟库存已变化');
    } else if (name === 'SCTradeCityReport') {
      if (positive(body?.cityId) && (body.cityId === cityId || ports.has(body.cityId))) invalidate('已知港口商情已变化');
    } else if (name === 'SCAllActivity' && eventKey(body?.trade) !== eventKey(event)) {
      event = body?.trade ? { period: body.trade.period, startTime: body.trade.startTime, endTime: body.trade.endTime } : null;
      cityId = null; market = null; ports.clear();
      invalidate('海商王活动期次或时间已变化');
    }
  };
  const onClose = () => { event = null; cityId = null; market = null; ports.clear(); invalidate('连接已关闭'); };
  const attach = () => {
    if (attached) return;
    client.on?.('message', onMessage); client.on?.('close', onClose); attached = true;
  };
  const detach = () => {
    if (!attached) return;
    const off = client.off?.bind(client) ?? client.removeListener?.bind(client);
    off?.('message', onMessage); off?.('close', onClose); attached = false;
  };
  const monitor = {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('海商王监控回调必须是函数');
      listeners.add(listener); attach();
      return () => { listeners.delete(listener); if (!listeners.size) detach(); };
    },
    get nextCheckAt() { return nextAt; },
    due(time = nowOf(client)) { return nextAt <= time; },
    defer(until) {
      if (Number.isFinite(until)) nextAt = Math.max(nowOf(client) + 1, Math.ceil(until));
      dirty = false;
    },
    invalidate,
    observe(input = {}) {
      const time = valid(input.time) ? input.time : nowOf(client);
      if (eventKey(event) !== eventKey(input.event)) { market = null; ports.clear(); }
      event = input.event ? { period: input.event.period, startTime: input.event.startTime, endTime: input.event.endTime } : null;
      const cargo = input.state?.cargo;
      if (positive(cargo?.cityId)) {
        if (cityId !== cargo.cityId) market = null;
        cityId = cargo.cityId;
      }
      if (Array.isArray(input.radar?.radar)) ports = new Set(input.radar.radar.map(port => port?.cityId).filter(positive));
      if (Array.isArray(input.market?.goods) && positive(cityId)
        && (!positive(input.market.cityId) || input.market.cityId === cityId)
        && !(cargo?.moveEndTime > time)) {
        market = { cityId, observedAt: time, goods: input.market.goods.filter(good => positive(good?.goodsId)
          && positive(good.price) && valid(good.stock)).map(good => ({ goodsId: good.goodsId, price: good.price, stock: good.stock })) };
      }
      const deadlines = [time + merchantMonitorSeconds(input.settings)];
      if (positive(cargo?.moveEndTime) && cargo.moveEndTime > time) deadlines.push(cargo.moveEndTime);
      if (positive(event?.startTime) && event.startTime > time) deadlines.push(event.startTime);
      if (positive(event?.endTime) && event.endTime > time) deadlines.push(event.endTime);
      if (input.config) {
        const timing = merchantTiming(input.config, event, time);
        if (positive(timing.nextRefreshAt) && timing.nextRefreshAt > time) deadlines.push(timing.nextRefreshAt);
        if (positive(timing.tradeStartTime) && timing.tradeStartTime > time) deadlines.push(timing.tradeStartTime);
      }
      if (positive(input.plan?.nextCheckAt) && input.plan.nextCheckAt > time) deadlines.push(input.plan.nextCheckAt);
      nextAt = Math.max(time + 1, Math.min(...deadlines)); dirty = false;
      return nextAt;
    },
    snapshot() { return { event: event && { ...event }, cityId, market: market && structuredClone(market),
      ports: [...ports], invalidated: dirty, nextCheckAt: nextAt, revision }; }
  };
  watchers.set(client, monitor);
  return monitor;
}
