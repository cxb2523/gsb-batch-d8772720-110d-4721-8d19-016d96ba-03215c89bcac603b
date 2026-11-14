import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

// V74 domestic mini-game builds: use the SDK's app/channel pair as well as the
// live AdvChannelCfg switch. Unknown or overseas packages must not use this path.
const apps = new Map([['1400', '14021170'], ['1422', '14021167']]);
const task = 'adShop';
const title = '广告商店免广告领奖';
const inProgress = new WeakSet();
export const AD_PACED_REASON = '等待式广告每轮只处理 1 次，被拒的入口冷却 5 分钟，稍后继续';
export const AD_NOT_FINISHED_REASON = '服务器判定广告未完成，本次跳过；等待秒数过短时可在广告奖励设置中调长';
export const AD_PAUSED_REASON = '广告等待期间任务已暂停或目标已变化，未发送领取';
const REJECT_COOLDOWN_MS = 300_000;
const adStates = new WeakMap();

function versionAtLeast(version, minimum) {
  if (!minimum) return true;
  if (![version, minimum].every(v => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v))) return false;
  const actual = version.split('.').map(Number), required = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(actual.length, required.length); i++) {
    const diff = (actual[i] ?? 0) - (required[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function channelUnavailable(tables, player, clientInfo, language) {
  const channel = String(clientInfo?.channelId ?? '');
  if (!apps.has(channel) || String(clientInfo?.appId) !== apps.get(channel) || language !== 'zh_CN'
    || (player?.channelId && String(player.channelId) !== channel)
    || (player?.appId && String(player.appId) !== apps.get(channel))) return '暂未确认此客户端支持国内免广告领奖';
  const settings = tables?.AdvChannelCfg?.data?.find(r => String(r.key) === channel);
  if (settings?.isOpen !== true || !versionAtLeast(clientInfo.originVersion, settings.minAppVersion)) return '当前渠道或客户端版本未开放广告商店';
  const level = tables?.ModuleOpenCfg?.data?.find(r => r.moduleId === '广告')?.playerLevel;
  if (!Number.isSafeInteger(level) || !Number.isSafeInteger(player?.level)) return '未能确认广告商店开放等级';
  if (player.level < level) return '角色达到 ' + level + ' 级开放';
  return null;
}

export async function hasSkipPrivilege(client, tables, player) {
  const vip = tables?.VipLevelCfg?.data?.find(row => row.level === player?.vip?.vipLevel);
  if (vip?.effects?.some(([name, value]) => name === '免广告' && Number(value) > 0)) return true;
  const state = await client.request('FirstChargeRequest', {}, 'FirstChargeResponse');
  return Array.isArray(state?.firstCharge?.record) && state.firstCharge.record.length > 0;
}

// 已开启的广告任务，无权益时统一申请并等待；旧 noPrivilege 值不再门控。
// reason 非空表示不可领取；waitMs 为 0 表示账号有权益，与客户端一样立即领取。
export function adWaitMs(settings) {
  const seconds = settings?.ads?.waitSeconds ?? 15;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('广告等待时间必须大于 0');
  return seconds * 1000;
}

export async function adAccess(client, tables, { player, clientInfo, language, settings }) {
  const reason = channelUnavailable(tables, player, clientInfo, language);
  if (reason) return { reason };
  if (await hasSkipPrivilege(client, tables, player)) return { waitMs: 0 };
  return { waitMs: adWaitMs(settings) };
}

function adState(client) {
  if (!adStates.has(client)) adStates.set(client, { paced: false, used: false, cooling: new Map() });
  return adStates.get(client);
}

export function beginAdRound(client) {
  Object.assign(adState(client), { paced: true, used: false });
}

// 整轮挂机占用账号写队列，等待式广告限速，避免长时间阻塞舰队调度和手动操作。
export function takeAdSlot(client, access, { manual = false, target = null } = {}) {
  if (!access.waitMs || manual) return true;
  const state = adState(client);
  if (target !== null && state.cooling.get(target) > Date.now()) return false;
  if (state.paced && state.used) return false;
  state.used = true;
  return true;
}

export function coolAd(client, target) {
  adState(client).cooling.set(target, Date.now() + REJECT_COOLDOWN_MS);
}

export const isAdNotFinished = error => !!error?.prompt?.args?.includes?.('adv not finished');

// 返回 false 表示等待被取消，调用方不能再发送领奖请求。
export async function prepareAd(client, access, { type, id }, allowed) {
  await client.request('WatchAdvRequest', { type, id }, 'OkResponse');
  const deadline = Date.now() + access.waitMs;
  while (Date.now() < deadline) {
    if (client.connected === false || !allowed()) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())));
  }
  return client.connected !== false && allowed();
}

async function readShop(client) {
  const state = normalize(await client.request('AdvShopInfoRequest', {}, 'AdvShopInfoResponse'));
  const products = new Map();
  for (const item of state.product ?? []) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || products.has(item.id)
      || ![item.max, item.gotTimes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('广告商店商品或领取次数异常，稍后复查');
    products.set(item.id, item);
  }
  return products;
}

export async function claimAdShop(client, config, { player, clientInfo, language, enabled, schedule, report, getSettings }) {
  if (!enabled() || !schedule.due(task) || inProgress.has(client)) return;
  inProgress.add(client);
  const todayEnds = schedule.nextDay();
  const allowed = () => enabled() && schedule.now() < todayEnds;
  const retryIn = seconds => schedule.defer(task, Math.min(todayEnds, schedule.now() + seconds));
  try {
    const access = await adAccess(client, config?.tables, { player, clientInfo, language, settings: getSettings?.() });
    if (access.reason) {
      report({ label: title, skipped: true, reason: access.reason });
      retryIn(1800);
      return;
    }
    if (!allowed()) return;
    let shop = await readShop(client);
    const ids = [...shop.keys()];
    let failed = false;
    let received = false;
    let paced = false;
    for (const id of ids) {
      const initial = shop.get(id);
      if (!initial || initial.gotTimes >= initial.max) continue;
      try {
        for (let count = initial.gotTimes; count < initial.max; count++) {
          if (!allowed()) return;
          const item = shop.get(id);
          if (!item || item.gotTimes >= item.max) break;
          if (!takeAdSlot(client, access)) { paced = true; break; }
          // AdvUtils.playAdv sends WatchAdv first even when the legitimate skip
          // privilege applies. The domestic skip branch needs a server reply.
          if (!await prepareAd(client, access, { type: 2, id }, allowed)) return;
          await client.sendWatch('GotAdvRewardRequest', { id });
          shop = await readShop(client);
          const after = shop.get(id);
          if (!after || after.gotTimes !== item.gotTimes + 1) throw new Error('服务端未确认领取次数增加');
          received = true;
          const reward = item.asset?.id ? displayMaterial(config, item.asset.id) + ' ×' + item.asset.num : '商品奖励';
          report({ label: title + ' · ' + reward + '（今日已领 ' + after.gotTimes + '/' + after.max + ' 次）', ok: true });
        }
      } catch (error) {
        failed = true;
        const label = title + ' · ' + (initial.asset?.id ? displayMaterial(config, initial.asset.id) : '商品');
        if (isAdNotFinished(error)) report({ label, skipped: true, reason: AD_NOT_FINISHED_REASON });
        else report({ label, ok: false, error: error.message });
        if (client.connected === false) break;
      }
    }
    if (!allowed()) return;
    if (paced && !failed) report({ label: title, skipped: true, reason: AD_PACED_REASON });
    else if (failed || [...shop.values()].some(item => item.gotTimes < item.max)) retryIn(300);
    else {
      if (!received) report({ label: title, skipped: true, reason: '今天没有可领取的商品' });
      schedule.defer(task, todayEnds);
    }
  } catch (error) {
    report({ label: title, ok: false, error: error.message });
    retryIn(300);
  } finally {
    inProgress.delete(client);
  }
}
