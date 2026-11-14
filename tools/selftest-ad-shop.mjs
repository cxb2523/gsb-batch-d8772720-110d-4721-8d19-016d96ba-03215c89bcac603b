import assert from 'node:assert/strict';
import { adAccess, claimAdShop } from '../src/ad-shop.mjs';

const NOW = 100, TOMORROW = 10000;
function fixture({ vip = 3, firstCharge = false, max = [2, 1] } = {}) {
  const calls = [], log = [], products = max.map((limit, i) => ({
    id: i + 1, max: limit, gotTimes: 0, asset: { id: '木材', num: 5 },
  }));
  const config = { materialName: id => id, tables: {
    VipLevelCfg: { data: [{ level: 3, effects: [['免广告', 1]] }] },
    AdvChannelCfg: { data: [{ key: '1400', isOpen: true, minAppVersion: '' }, { key: '1422', isOpen: true, minAppVersion: '' }] },
    ModuleOpenCfg: { data: [{ moduleId: '广告', playerLevel: 9 }] },
  } };
  const client = {
    async request(name, body, response) {
      calls.push([name, body, response]);
      if (name === 'FirstChargeRequest') return { firstCharge: { record: firstCharge ? [{ chargedId: '首充' }] : [] } };
      if (name === 'AdvShopInfoRequest') return { product: structuredClone(products) };
      assert.equal(name, 'WatchAdvRequest');
      assert.equal(response, 'OkResponse');
      assert.equal(body.type, 2);
      return {};
    },
    async sendWatch(name, { id }) {
      calls.push([name, { id }]);
      assert.equal(name, 'GotAdvRewardRequest');
      products.find(product => product.id === id).gotTimes++;
    },
  };
  let now = NOW, until = 0, enabled = true;
  const options = {
    clientInfo: { channelId: '1400', appId: '14021170', originVersion: '' }, language: 'zh_CN',
    player: { level: 10, vip: { vipLevel: vip } }, enabled: () => enabled, report: e => log.push(e),
    getSettings: () => ({ ads: { noPrivilege: false, waitSeconds: 0.01 } }),
    schedule: {
      due: key => { assert.equal(key, 'adShop'); return now >= until; },
      now: () => now, nextDay: () => TOMORROW, defer: (key, time) => { assert.equal(key, 'adShop'); until = time; },
    },
  };
  return { client, config, options, log, calls, products, until: () => until, stop() { enabled = false; }, nextDay() { now = TOMORROW; },
    run: () => claimAdShop(client, config, options),
  };
}

const names = f => f.calls.map(call => call[0]);
for (const via of ['VIP', '首充']) {
  const f = fixture({ vip: via === 'VIP' ? 3 : 0, firstCharge: via === '首充' });
  if (via === '首充') f.options.clientInfo = { channelId: '1422', appId: '14021167', originVersion: '' };
  await Promise.all([f.run(), f.run()]);
  assert.deepEqual(f.products.map(p => p.gotTimes), [2, 1]);
  assert.equal(f.log.filter(row => row.ok).length, 3);
  assert.equal(names(f).includes('FirstChargeRequest'), via === '首充');
  assert.deepEqual(names(f).filter(name => ['WatchAdvRequest', 'GotAdvRewardRequest'].includes(name)),
    Array.from({ length: 3 }, () => ['WatchAdvRequest', 'GotAdvRewardRequest']).flat());
  assert.equal(f.until(), TOMORROW);
  const total = f.calls.length;
  await f.run();
  assert.equal(f.calls.length, total);
}
{
  const f = fixture({ vip: 2 });
  assert.equal((await adAccess(f.client, f.config.tables, f.options)).waitMs, 15000, '旧账号没有ads配置时默认等待15秒');
  f.calls.length = 0;
  await f.run();
  assert.deepEqual(f.products.map(p => p.gotTimes), [2, 1]);
  assert(names(f).includes('FirstChargeRequest'));
  assert(f.until() > NOW);
}
for (const change of [
  f => { f.options.player.level = 8; },
  f => { f.options.language = 'en'; },
  f => { f.options.clientInfo.channelId = 'unknown'; },
  f => { f.options.clientInfo.appId = 'other'; },
  f => { f.options.player.channelId = '1422'; },
  f => { f.config.tables.AdvChannelCfg.data[0].isOpen = false; },
  f => { f.config.tables.AdvChannelCfg.data[0].minAppVersion = '1.2.0'; },
  f => { f.config.tables.AdvChannelCfg.data[0].minAppVersion = '1.2.0'; f.options.clientInfo.originVersion = '1.1.99'; },
]) {
  const f = fixture();
  change(f);
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.log[0].skipped, true);
}
{
  const f = fixture();
  f.stop();
  await f.run();
  assert.equal(f.calls.length, 0);
}
{
  const f = fixture({ max: [1] });
  f.config.tables.AdvChannelCfg.data[0].minAppVersion = '1.2';
  f.options.clientInfo.originVersion = '1.10';
  f.products[0].gotTimes = 1;
  await f.run();
  assert.deepEqual(names(f), ['AdvShopInfoRequest']);
  assert.equal(f.until(), TOMORROW);
}
{
  const f = fixture({ firstCharge: false, vip: 1 });
  f.products[0].reward = true;
  const access = await adAccess(f.client, f.config.tables, f.options);
  assert.equal(access.waitMs, 15000, '商品奖励标记不能当作免广告权益，仍须等待');
  await f.run();
  assert(names(f).includes('GotAdvRewardRequest'));
}
{
  const f = fixture({ max: [4, 1] });
  const grant = f.client.sendWatch;
  f.client.sendWatch = async (name, body) => { if (body.id === 1) return; await grant(name, body); };
  await f.run();
  assert.deepEqual(f.products.map(p => p.gotTimes), [0, 1], '单个商品未确认时不重发，继续其他商品');
  assert.equal(f.calls.filter(([n, b]) => n === 'WatchAdvRequest' && b.id === 1).length, 1);
  assert.equal(f.log[0].ok, false);
  assert(f.until() > NOW && f.until() < TOMORROW);
}
for (const interrupt of ['取消', '跨日', '服务端拒绝']) {
  const f = fixture({ max: [1] });
  const request = f.client.request;
  f.client.request = async (...args) => {
    const response = await request(...args);
    if (args[0] === 'WatchAdvRequest') {
      if (interrupt === '取消') f.stop();
      if (interrupt === '跨日') f.nextDay();
      if (interrupt === '服务端拒绝') throw Error('server prompt: feature locked');
    }
    return response;
  };
  await f.run();
  assert(!names(f).includes('GotAdvRewardRequest'));
}
console.log('ad shop ok: channel and privilege checks, daily limits, per-item confirmation, cancellation and retry');
