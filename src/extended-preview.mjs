import { readGuildOrderView } from './guild-orders.mjs';
import { readGuildShips } from './guild-ships.mjs';
import { readGuildForts } from './guild-forts.mjs';
import { readSiliconMining, planSiliconMining } from './silicon-mining.mjs';
import { watchHeroRaidPushes } from './hero-raid-automation.mjs';

// 全部为读取或纯计划；不调用 service / run，不使用预览草稿修改运行设置。
export async function previewExtended(category, client, protocol, config, player, settings, ledger) {
  const result = { checkedAt: new Date().toISOString(), usage: ledger.snapshot(), actions: [], counts: {}, viewOnly: true, notes: [] };
  const options = { player, getSettings: () => settings, enabled: () => client.connected !== false, ledger };
  if (category === 'alliance') {
    const view = await readGuildOrderView(client, protocol, config, options);
    result.scopeLabel = '联盟募兵与互助'; result.notes.push(view.reason || '已读取联盟募兵状态，实际执行前再次检查城市、次数和库存');
    result.notes.push('用户每日募兵上限：' + (settings.alliance.recruitDailyLimit || '不额外限制') + '；互助模式：' + (settings.alliance.mutualMode === 'exchange' ? '刷贡献' : '自定义'));
  } else if (category === 'guildShip') {
    const view = await readGuildShips(client, protocol, config, options);
    result.scopeLabel = '联盟商船'; result.counts = { ships: view.ships.length, candidates: view.candidates.length };
    result.notes.push(view.reason || '符合策略的上船候选：' + view.candidates.length + '；本人商船：' + view.own.length);
    result.notes.push('出航由游戏服务器控制，自定义时间只限制申请船长。');
  } else if (category === 'guildFort') {
    const view = await readGuildForts(client, protocol, config, options);
    result.scopeLabel = '联盟工事'; result.counts = { forts: view.forts?.length ?? 0, candidates: view.candidates?.length ?? 0 };
    result.notes.push(view.reason || '允许材料的捐赠候选：' + (view.candidates?.length ?? 0) + '；今日已捐：' + (view.dailyDonateNum ?? 0));
  } else if (category === 'silicon') {
    const state = await readSiliconMining(client, protocol, config, player, { settings, ledger });
    const plan = planSiliconMining(state, settings, ledger, client);
    result.scopeLabel = '硅矿'; result.counts = { mines: state.mines.length, fleets: state.fleets.length };
    result.notes.push(state.reason || plan.reason || '已读取矿区与舰队状态', ...plan.notes, ...plan.rows.map(row => row.id + '：' + (row.reason || '符合派遣条件')));
    if (state.dailyRewards !== null) result.notes.push('今日保守计入奖励结算：' + state.dailyRewards + ' 次');
    result.actions = plan.actions.map(step => ({ kind: step.kind, label: step.label, costs: (step.costs ?? []).map(item => ({ name: config.materialName(item.id), num: item.num })) }));
    result.viewOnly = false;
  } else if (category === 'heroRaid') {
    const state = watchHeroRaidPushes(client);
    result.scopeLabel = '超凡英雄活动';
    if (!state.observed || state.invalid) result.notes.push('尚未收到可核验的当前连接活动推送，不生成订单或领奖动作。');
    else {
      const now = (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
      const current = [...state.raids.values()].filter(row => row.startTime <= now && row.finishTime > now);
      result.counts = { activities: current.length }; result.notes.push('当前开放活动：' + current.length);
      for (const row of current) result.notes.push('活动 ' + row.raidId + '：订单 ' + (row.order?.orderId ?? '未同步') + '，累计抽取 ' + (row.drawTimesInfo?.times ?? '未同步') + ' 次');
    }
  }
  if (['guildShip','guildFort'].includes(category) && !settings.alliance.enabled) result.notes.push('联盟自动化总开关未开启');
  if (!settings[category]?.enabled) result.notes.push('本模块自动化开关未开启');
  return result;
}
