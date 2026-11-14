import { runAction } from './actions.mjs';
import { claimDailies } from './dailies.mjs';
import { claimHeroShowRewards } from './hero-show-rewards.mjs';
import { surveyTasks, runTasks } from './tasks.mjs';
import { claimMail } from './mail.mjs';

export async function claimRewards(client, protocol, config, onResult, enabled = () => true, onAfkDeadline, scheduler, player, { settings = null } = {}) {
  const results = [];
  const ready = key => enabled(key) && (!scheduler || scheduler.due(key));
  const report = (label, ok, error, taskKey) => {
    const entry = { label, ok, error, ...(taskKey?{taskKey}:{}) };
    results.push(entry);
    onResult?.(entry);
  };
  async function group(label, work) {
    try { await work(); }
    catch (error) { const keys=({'任务与成就':['tasks'],'日常与赠礼':['dailyRewards','chests','gift'],'邮件':['mail'],'挂机收益':['afk']})[label]??[];for(const key of keys)if(enabled(key))scheduler?.observe?.(key,error.message,'error');report(label, false, error.message,keys[0]); }
  }
  async function draw(key, label, action, params = {}) {
    if (!ready(key)) return;
    await group(label, async () => {
      const reply = await runAction(client, protocol, action, params, { allowMutate: true });
      report(label, true, undefined, key);
      if (action === 'afkDraw') setDeadline(reply.body?.afkFinishTime);
    });
  }
  function setDeadline(finishTime) {
    const deadline = finishTime * 1000 - (client.serverClockOffsetMs || 0);
    if (finishTime > 0) onAfkDeadline?.(deadline > Date.now() ? deadline : Date.now() + 60_000);
  }

  if (ready('tasks')) await group('任务与成就', async () => {
    const survey = await surveyTasks(client, protocol, { config, scheduler, player });
    if (survey.orderError) report('每日订单', false, survey.orderError);
    await runTasks(client, protocol, survey, { allowMutate: true, enabled: () => enabled('tasks'), settings,
      onStep: (entry) => report(entry.step.label, entry.ok, entry.error) });
  });
  if (['dailyRewards', 'chests', 'gift'].some(ready)) await group('日常与赠礼', () => claimDailies(client, protocol, { config, enabled, scheduler, settings,
    onStep: (entry) => report(entry.note || entry.title, entry.ok, entry.error) }));
  if (ready('mail')) await group('邮件', async () => {
    const entry = await claimMail(client, { enabled: () => enabled('mail') });
    if (entry.status === 'empty') {
      scheduler?.observe?.('mail', entry.reason);
      if (scheduler) scheduler.defer('mail', scheduler.now() + 180);
    } else { results.push(entry); onResult?.(entry); }
  });
  if (ready('afk')) await group('挂机收益', async () => {
    const { afkInfo } = await client.request('AfkInfoRequest', {}, 'AfkInfoResponse');
    if (!afkInfo) throw Error('挂机收益状态未同步');
    setDeadline(afkInfo.afkFinishTime);
    scheduler?.observe?.('afk','当前闯关等级 '+afkInfo.level+' · 收益'+(afkInfo.afkFinishTime*1000>Date.now()+(client.serverClockOffsetMs||0)?'积累中':'等待领取'));
    if (afkInfo.afkFinishTime > 0 && afkInfo.afkFinishTime * 1000 <= Date.now() + (client.serverClockOffsetMs || 0)) {
      await draw('afk', '闯关挂机收益已满，领取本段收益', 'afkDraw');
    }
    const level = config?.nextAfkRewardLevel(afkInfo.rewardedLevel ?? 0);
    if (level != null && level <= afkInfo.level) await draw('afk', `挂机等级 ${level} 奖励`, 'afkLevelDraw', { level });
  });
  if (ready('heroShowRewards')) await group('英雄技能展示奖励', () => claimHeroShowRewards(client, config, report));
  return results;
}
