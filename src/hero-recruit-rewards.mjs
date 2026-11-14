import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

const rewardKey = 'heroRecruitRewards';
const rewardRecheckSeconds = 180;
const names = { [rewardKey]: '英雄累计招募奖励' };
const skip = (key, reason) => ({ key, label: names[key], skipped: true, reason });

function assets(config, reward) {
  return (normalize(reward)?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
}

async function readRecruit(client) {
  const reply = await client.request('RecruitInfoRequest', {}, 'RecruitInfoResponse');
  return reply?.hero;
}

// 按游戏客户端规则，使用不高于角色赛季的最新招募奖励配置。
function rewardTiers(config, player) {
  const world = normalize(player?.worldId);
  if (!Number.isSafeInteger(world) || world <= 0) return [];
  const season = Math.floor(world / 1e6) % 1000;
  const rows = config.tables.HeroRecruitTaskCfg?.data ?? [];
  const eligible = rows.filter(row => row.season > 0 && row.season <= season);
  const applicable = Math.max(0, ...eligible.map(row => row.season));
  return eligible.filter(row => row.season === applicable).sort((a, b) => a.id - b.id);
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
    const reply = await client.request('GotHeroRecruitTaskRequest', {}, 'GotRecruitTaskResponse');
    if (reply?.gotId !== tier.id) throw new Error('服务端未确认领取第 ' + tier.id + ' 档英雄招募奖励');
    task = (await readRecruit(client))?.task;
    if (task?.gotId !== tier.id) throw new Error('重新读取时未确认第 ' + tier.id + ' 档英雄招募奖励已领取');
    claimed = true;
    const prize = assets(config, reply.reward);
    report({ key: rewardKey, label: '已领英雄招募第 ' + tier.id + ' 档奖励' + (prize ? '：' + prize : ''), ok: true });
  }
}

export async function serviceHeroRecruitRewards(client, config, { player, enabled, report, scheduler }) {
  const due = key => enabled(key) && (!scheduler || scheduler.due(key));
  if (!due(rewardKey)) return;
  try {
    const state = await readRecruit(client);
    if (!state) { report(skip(rewardKey, '暂无英雄招募数据')); return; }
    await claimRewards(client, state, config, player, due, report, scheduler);
  } catch (error) { report({ key: rewardKey, label: names[rewardKey], ok: false, error: error.message }); }
}
