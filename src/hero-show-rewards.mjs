import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

export async function claimHeroShowRewards(client, config, report) {
  const catalog = config?.tables?.HeroAbilityShowCfg?.data;
  if (!catalog) throw new Error('缺少英雄技能展示奖励配置');

  const readRoster = () => client.request('AllHeroRequest', {}, 'AllHeroResponse');
  const roster = await readRoster();
  let claimed = new Set(roster.showSkillHeroes ?? []);
  const eligible = new Set(catalog.filter(row => row.reward?.length).map(row => row.id));
  const names = new Map((config.tables.HeroCfg?.data ?? []).map(row => [row.id, row.name]));
  const owned = new Map((roster.heroes ?? []).map(hero => [hero.heroId, hero.showName || names.get(hero.heroId) || hero.heroId]));
  for (const [id, name] of owned) {
    if (!eligible.has(id) || claimed.has(id)) continue;
    const label = name + ' · 技能展示奖励';
    let reply, failure;
    try {
      reply = normalize(await client.request('GotHeroShowSkillRequest', { heroId: id }, 'GotRewardResponse'));
    } catch (error) {
      failure = error.message;
    }
    // The reward response is shared with other actions. Confirm this particular
    // hero and also recover the case where the claim succeeded but its reply was lost.
    try {
      claimed = new Set((await readRoster()).showSkillHeroes ?? []);
    } catch (error) {
      report(label, false, '未能核对已领名单：' + error.message);
      break;
    }
    if (!claimed.has(id)) {
      report(label, false, failure || '服务端尚未把该英雄列入已领名单');
      continue;
    }
    const rewards = (reply?.reward?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num);
    report(label + (rewards.length ? '，获得' + rewards.join('、') : '已领取，奖励明细未返回'), true);
  }
}
