import { normalize } from './worlds.mjs';

const skip = reason => ({ label: '钓具养成', skipped: true, reason });

export async function upgradeFishingOnce(client, config, { playerLevel, reserveGold, enabled, targetLevel = Infinity, beforeAction, afterAction, cancelAction, dryRun = false }) {
  if (!enabled()) return skip('已暂停');
  const tables = config?.tables;
  const unlock = tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '小玩法升级')?.playerLevel;
  if (!Number.isSafeInteger(unlock) || unlock < 1) return skip('缺少钓具养成的开放等级配置');
  if (!Number.isSafeInteger(playerLevel) || playerLevel < 1) return skip('无法确认角色等级');
  if (playerLevel < unlock) return skip('角色 ' + unlock + ' 级开放，当前 ' + playerLevel + ' 级');
  if (!Number.isSafeInteger(reserveGold) || reserveGold < 0) return skip('无法确认预留金币数量');

  // Keep protobuf defaults here: an omitted zero progress decodes as enhance=0.
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  if (!Array.isArray(water?.building)) return skip('无法确认已建成的钓鱼椅数量');
  const chairs = new Set(water.building.filter(row => row.level > 0 && /^\d+钓鱼椅$/.test(row.buildingId)).map(row => row.buildingId));
  if (!chairs.size) return skip('尚未建成钓鱼椅');
  const level = water.fishingLevel?.level;
  if (Number.isSafeInteger(level) && level >= targetLevel) return skip('已达到设置的目标等级 ' + targetLevel);
  const progress = water.fishingLevel?.enhance;
  if (!Number.isSafeInteger(level) || level < 1 || !Number.isSafeInteger(progress) || progress < 0) return skip('无法确认当前钓具等级和强化进度');
  const levels = tables?.FishLevelCfg?.data ?? [];
  const current = levels.find(row => row.level === level);
  if (!Number.isSafeInteger(current?.enhance) || current.enhance < 1) return skip('缺少当前钓具等级的强化配置');
  const next = levels.find(row => row.level === level + 1);
  if (!next) return skip(levels.some(row => row.level > level) ? '缺少下一级钓具配置' : '钓具已达配置最高等级 ' + level + ' 级');

  const promote = progress >= current.enhance;
  if (promote) {
    const [type, required] = next.condition ?? [];
    if (type !== '钓鱼椅' || !Number.isSafeInteger(required) || required < 1) return skip('无法确认钓具升级所需建筑');
    if (chairs.size < required) return skip('升至 ' + next.level + ' 级需要 ' + required + ' 把钓鱼椅，已建成 ' + chairs.size + ' 把');
  } else {
    const [currency, cost] = current.cost ?? [];
    if (currency !== 'GOLD' || !Number.isSafeInteger(cost) || cost < 1) return skip('无法确认钓具强化所需金币');
    const assets = normalize(await client.request('AllResourceRequest', {}, 'AllResourceResponse'));
    const gold = assets?.list?.find(row => row.res === 3)?.amount;
    if (!Number.isSafeInteger(gold) || gold < 0) return skip('无法确认当前金币余额');
    if (gold - cost < reserveGold) return skip('本次强化需 ' + cost + ' 金币，现有 ' + gold + '，需保留 ' + reserveGold);
  }

  if (!enabled()) return skip('已暂停');
  const action = { kind: 'fishEnhance', scope: 'base', setting: 'gather.upgradeFishing',
    request: 'FishingLevelUpRequest', response: 'SCFishingLevelUpdate', body: {},
    costs: promote ? [] : [{ id: 'GOLD', num: current.cost[1] }], label: '钓具强化与升级' };
  if (dryRun) return { planned: true, action: { ...action, label: promote ? '钓具升至 ' + next.level + ' 级' : '钓具强化一次' } };
  const ticket = await beforeAction?.(action);
  if (!enabled()) { await cancelAction?.(action, ticket, { notSent: true }); return skip('已暂停'); }
  let reply;
  try { reply = await client.request(action.request, action.body, action.response); }
  catch (error) {
    if (error.notSent === true || error.prompt && error.request === action.request) {
      await cancelAction?.(action, ticket, { notSent: error.notSent === true, error });
    }
    throw error;
  }
  const after = reply?.levelInfo;
  if (promote && after?.level === next.level) { await afterAction?.(action, ticket, { ok: true, body: reply }); return { label: '钓具已从 ' + level + ' 级升至 ' + after.level + ' 级', ok: true }; }
  if (!promote && after?.level === level && Number.isSafeInteger(after.enhance) && after.enhance > progress) {
    await afterAction?.(action, ticket, { ok: true, body: reply });
    return { label: '钓具 ' + level + ' 级强化进度 ' + progress + ' → ' + after.enhance + '/' + current.enhance + '（消耗 ' + current.cost[1] + ' 金币）', ok: true };
  }
  throw new Error('服务端未确认钓具' + (promote ? '升级' : '强化进度增加'));
}
