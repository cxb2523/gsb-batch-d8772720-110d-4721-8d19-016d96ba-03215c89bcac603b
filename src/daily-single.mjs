// 手动单项日常：报价只在本账号会话内有效，客户端不能提交协议名称或动作体。
import { createHash, randomUUID } from 'node:crypto';
import { surveyDailies } from './dailies.mjs';

export const dailySingleState = () => ({ quotes: new Map(), attempted: new Set() });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeBody(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return !value || typeof value !== 'object' || Object.values(value).every(safeBody);
}

function plan(survey, entry) {
  const task = entry.task;
  if (task.rewardClaimed) return null;
  let actions;
  if (task.progress >= task.targetProgress) {
    actions = [{ request: 'DrawDailyTaskRewardRequest', response: 'DrawDailyTaskRewardResponse', body: { id: task.id }, cost: '免费', note: '领取任务奖励' }];
  } else {
    if (!['ready', 'paid', 'partial'].includes(entry.status) || !entry.actions?.length) return null;
    actions = entry.actions.map(action => ({ ...action, ...(action.request === 'RecruitStartRequest' && action.body.way === 2
      ? { costs: [{ id: '抽卡券', num: 1 }] } : {}) }));
  }
  if (!actions.every(action => safeBody(action.body))) return { reason: '目标标识无法精确确认，请在游戏中操作' };
  const ruby = actions.reduce((total, action) => total + (action.costs ?? []).filter(item => item.id === 'RUBY').reduce((sum, item) => sum + item.num, 0), 0);
  if (!Number.isSafeInteger(ruby) || ruby < 0) return { reason: '无法确认钻石消耗，请刷新重试' };
  const claim = task.progress >= task.targetProgress;
  return { id: task.id, title: task.title, actions, claim, ruby, reset: survey.daily.dailyResetTime,
    fingerprint: digest([survey.daily.dailyResetTime, task.id, task.progress, task.targetProgress, task.rewardClaimed, actions]) };
}

export function addDailyOptions(survey, state) {
  for (const [key, quote] of state.quotes) if (quote.expires < Date.now()) state.quotes.delete(key);
  const tasks = survey.tasks.map(entry => {
    const candidate = plan(survey, entry);
    if (!candidate) return { ...entry, manual: { reason: entry.task.rewardClaimed ? '已领取' : entry.reason || '暂无可执行动作' } };
    if (candidate.reason) return { ...entry, manual: candidate };
    if (state.attempted.has(candidate.fingerprint)) return { ...entry, manual: { reason: '上次操作结果待确认，请稍后刷新' } };
    const token = randomUUID();
    state.quotes.set(token, { ...candidate, expires: Date.now() + 120_000, used: false });
    return { ...entry, manual: { token, ruby: candidate.ruby,
      label: candidate.claim ? '领取奖励' : candidate.ruby ? '完成 · ' + candidate.ruby + ' 钻石' : '完成此项' } };
  });
  // 连续刷新不无限保留旧报价；已经在执行的对象由执行函数持有。
  while (state.quotes.size > 200) state.quotes.delete(state.quotes.keys().next().value);
  return { tasks, chests: survey.chests, gift: survey.gift, ruby: survey.ruby };
}

export async function runDailySingle(client, protocol, { state, token, paid = false, config, player, settings, guard, enabled = () => true, wait = delay } = {}) {
  const quote = state.quotes.get(token);
  if (!quote || quote.expires < Date.now()) throw new Error('此项操作已过期，请刷新日常后再试');
  if (quote.used) throw new Error('此项操作已经提交，请刷新查看结果');
  const read = () => surveyDailies(client, protocol, { config, player, settings, includeTask: id => id === quote.id, probeGift: false });
  let survey = await read();
  let entry = survey.tasks.find(row => row.task.id === quote.id);
  let current = entry && plan(survey, entry);
  if (!current || current.fingerprint !== quote.fingerprint) throw new Error('任务进度、目标或费用已变化，请刷新后重新选择');
  if (state.attempted.has(current.fingerprint)) throw new Error('上次操作结果仍待确认，暂不重复执行');
  if (quote.ruby > 0 && !paid) throw new Error('此项需要 ' + quote.ruby + ' 钻石，请先勾选本页“允许花钻石”');
  if (!enabled()) throw new Error('操作已暂停');
  const allowed = quote.actions.map(action => digest(action));
  let sent = 0;
  let claimed = false;
  for (let index = 0; index <= quote.actions.length; index++) {
    if (entry.task.rewardClaimed) { claimed = true; break; }
    current = plan(survey, entry);
    if (!current || current.reason) break;
    if (current.reset !== quote.reset) throw new Error('日常已重置，请刷新后再操作');
    const action = current.actions[0];
    if (!current.claim) {
      const approved = allowed.indexOf(digest(action));
      if (approved < 0) break; // 新出现的付费方式或新目标不沿用旧报价。
      allowed.splice(approved, 1);
    }
    if (state.attempted.has(current.fingerprint)) break;
    if (!enabled()) throw new Error('操作已暂停，已发送动作请刷新核对');
    const ticket = await guard.before({ kind: 'manualDaily', ...action });
    if (!enabled()) { await guard.cancel(action, ticket, { notSent: true }); throw new Error('操作已暂停'); }
    quote.used = true;
    state.attempted.add(current.fingerprint);
    const before = entry.task.progress;
    try {
      if (action.response && protocol[action.response]) await client.request(action.request, action.body, action.response, 15000);
      else await client.sendWatch(action.request, action.body, { window: 400 });
      sent++;
    } catch (error) {
      if (error.notSent === true || error.prompt && error.request === action.request) {
        await guard.cancel(action, ticket, { notSent: error.notSent === true, error });
        state.attempted.delete(current.fingerprint);
      }
      throw error;
    }
    let confirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!enabled()) break;
      await wait(350);
      survey = await read();
      entry = survey.tasks.find(row => row.task.id === quote.id);
      if (survey.daily.dailyResetTime !== quote.reset || !entry) break;
      confirmed = current.claim ? entry.task.rewardClaimed === true : entry.task.progress > before;
      if (confirmed) break;
    }
    if (!confirmed) return { ok: false, sent, claimed: false, label: quote.title + '：请求已发送，结果待确认，请稍后刷新' };
    await guard.after(action, ticket, { ok: true });
    state.attempted.delete(current.fingerprint);
    if (current.claim) { claimed = true; break; }
  }
  return { ok: claimed, sent, claimed, label: quote.title + (claimed ? '：已完成并领取奖励' : '：已执行当前可做部分，请刷新查看剩余条件') };
}
