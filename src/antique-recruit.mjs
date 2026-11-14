import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

const drawKey = 'freeAntiqueRecruit';
const rewardKey = 'antiqueRecruitRewards';
const rewardRecheckSeconds = 180;
const names = { [drawKey]: '藏品免费招募', [rewardKey]: '藏品累计招募奖励' };
const skip = (key, reason) => ({ key, label: names[key], skipped: true, reason });
const serverTime = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);

function assets(config, reward) {
  return (normalize(reward)?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
}

async function readRecruit(client) {
  const reply = await client.request('RecruitInfoRequest', {}, 'RecruitInfoResponse');
  return reply?.antique;
}

// As in RecruitUtil.seasonTasks, reuse the latest configured season at or below the player's.
function rewardTiers(config, player) {
  const world = normalize(player?.worldId);
  if (!Number.isSafeInteger(world) || world <= 0) return [];
  const season = Math.floor(world / 1e6) % 1000;
  const rows = config.tables.AntiqueRecruitTaskCfg?.data ?? [];
  const eligible = rows.filter(row => row.season > 0 && row.season <= season);
  const applicable = Math.max(0, ...eligible.map(row => row.season));
  return eligible.filter(row => row.season === applicable).sort((a, b) => a.id - b.id);
}

async function freeDraw(client, state, config, enabled, report, scheduler) {
  const until = state?.freeEndTimeSeconds;
  if (!Number.isSafeInteger(until) || until < 0) { report(skip(drawKey, '无法确认免费招募时间')); return state; }
  if (until > serverTime(client)) {
    scheduler?.defer(drawKey, until);
    const ready = new Date(until * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    report(skip(drawKey, '下次免费招募：' + ready + '（北京时间）'));
    return state;
  }
  if (!enabled(drawKey)) return state;
  // RECRUIT_ANTIQUE=1, RECRUIT_FREE=1. No fallback to single-ticket or ad draws.
  scheduler?.clear(rewardKey); // This draw may reach the next tier, even if we lose its reply.
  const reply = await client.request('AntiqueRecruitRequest', { type: 1, way: 1 }, 'AntiqueRecruitResponse');
  const after = reply?.recruitData;
  if (!(after?.freeEndTimeSeconds > serverTime(client) || after?.recruitTimes > state.recruitTimes || after?.task?.times > state.task?.times)) {
    throw new Error('未确认藏品免费招募次数或冷却时间已更新');
  }
  if (Number.isSafeInteger(after.freeEndTimeSeconds)) scheduler?.defer(drawKey, after.freeEndTimeSeconds);
  const prizes = (reply.reward ?? []).map(item => {
    if (item.reward) return assets(config, item.reward);
    const name = config.tables.AntiqueBaseCfg?.data?.find(row => row.antiqueId === item.antiqueId)?.showName;
    return (name || '藏品') + (item.trans ? '（已转为碎片）' : '');
  }).filter(Boolean);
  report({ key: drawKey, label: '已免费招募藏品一次' + (prizes.length ? '，获得' + prizes.join('、') : ''), ok: true });
  return after;
}

async function claimRewards(client, state, config, player, enabled, report, scheduler) {
  const tiers = rewardTiers(config, player);
  if (!tiers.length) { report(skip(rewardKey, '未找到当前赛季的招募奖励配置')); return; }
  let task = state?.task;
  let claimed = false;
  while (enabled(rewardKey)) {
    if (!Number.isSafeInteger(task?.times) || task.times < 0 || !Number.isSafeInteger(task.gotId) || task.gotId < 0) {
      report(skip(rewardKey, '无法确认累计招募次数或已领档位')); return;
    }
    if (task.gotId > 0 && !tiers.some(row => row.id === task.gotId)) {
      report(skip(rewardKey, '已领档位与本赛季配置不符')); return;
    }
    const tier = tiers.find(row => row.id > task.gotId);
    if (!tier) {
      scheduler?.defer(rewardKey, scheduler.now() + rewardRecheckSeconds);
      if (!claimed) report(skip(rewardKey, '本赛季奖励已领完'));
      return;
    }
    if (tier.id !== task.gotId + 1 || !Number.isSafeInteger(tier.times) || tier.times < 1) {
      report(skip(rewardKey, '下一档招募奖励配置不完整')); return;
    }
    if (task.times < tier.times) {
      scheduler?.defer(rewardKey, scheduler.now() + rewardRecheckSeconds);
      if (!claimed) report(skip(rewardKey, '累计招募 ' + task.times + '/' + tier.times + ' 次'));
      return;
    }
    const reply = await client.request('GotAntiqueRecruitTaskRequest', {}, 'GotRecruitTaskResponse');
    if (reply?.gotId !== tier.id) throw new Error('服务端未确认领取第 ' + tier.id + ' 档藏品招募奖励');
    task = (await readRecruit(client))?.task;
    if (task?.gotId !== tier.id) throw new Error('重新读取时未确认第 ' + tier.id + ' 档藏品招募奖励已领取');
    claimed = true;
    const prize = assets(config, reply.reward);
    report({ key: rewardKey, label: '已领藏品招募第 ' + tier.id + ' 档奖励' + (prize ? '：' + prize : ''), ok: true });
  }
}

export async function serviceAntiqueRecruit(client, config, { player, enabled, report, scheduler }) {
  const due = key => enabled(key) && (!scheduler || scheduler.due(key));
  if (!due(drawKey) && !due(rewardKey)) return;
  const skipBoth = reason => {
    for (const key of [drawKey, rewardKey]) if (due(key)) report(skip(key, reason));
  };
  const required = config?.tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '藏品')?.playerLevel;
  if (!(required > 0 && player?.level > 0)) return skipBoth('无法确认藏品开放等级');
  if (player.level < required) return skipBoth('角色 ' + required + ' 级开放，当前 ' + player.level + ' 级');
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  if (!Array.isArray(water?.building)) return skipBoth('无法确认广播站状态');
  const station = water.building.find(row => row.buildingId === '1广播站');
  if (!(station?.level > 0)) return skipBoth(station?.buildFinishTime > 0 || station?.buildStartTime > 0 ? '广播站正在建造' : '广播站尚未建成');
  let state = await readRecruit(client);
  if (!state) return skipBoth('暂无藏品招募数据');
  if (due(drawKey)) {
    try { state = await freeDraw(client, state, config, due, report, scheduler); }
    catch (error) {
      state = null; // The server may have processed the draw before we lost its reply.
      report({ key: drawKey, label: names[drawKey], ok: false, error: error.message });
    }
  }
  if (due(rewardKey)) {
    try {
      // A draw can advance the current reward tier, even if its response was lost.
      await claimRewards(client, state ?? await readRecruit(client), config, player, due, report, scheduler);
    } catch (error) { report({ key: rewardKey, label: names[rewardKey], ok: false, error: error.message }); }
  }
}
